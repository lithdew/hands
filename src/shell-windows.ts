/**
 * The orchestrator's body on Windows: what `live.ts` needs from this PC that is not a hand. The same `Shell` as
 * shell.ts gives on a Mac, out of user32, winmm and a Chromium window: the talk key polled, the microphone and the
 * speaker on winmm's wave API with their headers polled for WHDR_DONE, and the panel a Chromium `--app` window in
 * the corner, clipped of its title strip. Everything is bun:ffi from this thread, on one 8 ms pump, and nothing
 * here blocks for long: winmm plays and records on its own threads, and hands the buffers back for the pump to find.
 * The one thing that goes through the helper is a thumbnail, which is a capture like any other.
 */

import { dlopen, JSCallback, type Pointer, ptr } from "bun:ffi";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { cushion, type Shell, type Talk } from "./shell.ts";
import { allWindows, native } from "./windows.ts";

const PUMP_MS = 8;
const TAP_MS = 250; // let go sooner than this and it was a slip, not a sentence
const SAMPLE_RATE = 24000; // what gpt-live-1 hears and speaks: mono, 16-bit
const CHUNK_BYTES = (SAMPLE_RATE * 2 * 40) / 1000; // 40 ms
const PREROLL_CHUNKS = 8; // what a warm microphone remembers: a third of a second
const IN_FLIGHT = 16;
const QUIET = 100 / 32768; // a chunk that never gets louder than this is a pause
const THUMB_PX = 720;
const MARGIN_PX = 12;
const FRAME_DIP: [side: number, top: number] = [7, 37]; // what Chromium paints around an --app page, in DIP (measured)
const FIND_MS = 15000; // how long a browser gets to put its window up: a cold Edge with a fresh profile takes seconds
const WAVE_MAPPER = 0xffffffff;
const WHDR_DONE = 1;
const WHDR_PREPARED = 2;
type Ref = Pointer | bigint; // a handle as bun:ffi returns it
const HDR_BYTES = 48; // a WAVEHDR on x64: lpData@0 dwBufferLength@8 dwBytesRecorded@12 dwUser@16 dwFlags@24 dwLoops@28 lpNext@32 reserved@40

const user32 = dlopen("user32.dll", {
  GetAsyncKeyState: { args: ["i32"], returns: "i16" },
  SetProcessDpiAwarenessContext: { args: ["i64"], returns: "bool" },
  GetForegroundWindow: { args: [], returns: "ptr" },
  GetWindowThreadProcessId: { args: ["ptr", "ptr"], returns: "u32" },
  AttachThreadInput: { args: ["u32", "u32", "bool"], returns: "bool" },
  SetForegroundWindow: { args: ["ptr"], returns: "bool" },
  GetTopWindow: { args: ["ptr"], returns: "ptr" },
  GetWindow: { args: ["ptr", "u32"], returns: "ptr" },
  IsWindow: { args: ["ptr"], returns: "bool" },
  IsWindowVisible: { args: ["ptr"], returns: "bool" },
  GetClassNameW: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  SetWindowPos: { args: ["ptr", "ptr", "i32", "i32", "i32", "i32", "u32"], returns: "bool" },
  ShowWindow: { args: ["ptr", "i32"], returns: "bool" },
  GetWindowLongPtrW: { args: ["ptr", "i32"], returns: "i64" },
  SetWindowLongPtrW: { args: ["ptr", "i32", "i64"], returns: "i64" },
  SetWindowRgn: { args: ["ptr", "ptr", "bool"], returns: "i32" },
  GetWindowRgn: { args: ["ptr", "ptr"], returns: "i32" },
  GetWindowRect: { args: ["ptr", "ptr"], returns: "bool" },
  FindWindowW: { args: ["ptr", "ptr"], returns: "ptr" },
  GetDpiForWindow: { args: ["ptr"], returns: "u32" },
  GetDpiForSystem: { args: [], returns: "u32" },
  EnumDisplayMonitors: { args: ["ptr", "ptr", "ptr", "i64"], returns: "bool" },
  GetMonitorInfoW: { args: ["ptr", "ptr"], returns: "bool" },
}).symbols;
const gdi32 = dlopen("gdi32.dll", {
  CreateRectRgn: { args: ["i32", "i32", "i32", "i32"], returns: "ptr" },
  GetRgnBox: { args: ["ptr", "ptr"], returns: "i32" },
  DeleteObject: { args: ["ptr"], returns: "bool" },
}).symbols;
const kernel32 = dlopen("kernel32.dll", { GetCurrentThreadId: { args: [], returns: "u32" } }).symbols;
const winmm = dlopen("winmm.dll", {
  waveInOpen: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u32"], returns: "i32" },
  waveInPrepareHeader: { args: ["ptr", "ptr", "u32"], returns: "i32" },
  waveInUnprepareHeader: { args: ["ptr", "ptr", "u32"], returns: "i32" },
  waveInAddBuffer: { args: ["ptr", "ptr", "u32"], returns: "i32" },
  waveInStart: { args: ["ptr"], returns: "i32" },
  waveInStop: { args: ["ptr"], returns: "i32" },
  waveInReset: { args: ["ptr"], returns: "i32" },
  waveOutOpen: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u32"], returns: "i32" },
  waveOutPrepareHeader: { args: ["ptr", "ptr", "u32"], returns: "i32" },
  waveOutUnprepareHeader: { args: ["ptr", "ptr", "u32"], returns: "i32" },
  waveOutWrite: { args: ["ptr", "ptr", "u32"], returns: "i32" },
  waveOutReset: { args: ["ptr"], returns: "i32" },
}).symbols;

const SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20; // prettier-ignore
const HWND_TOPMOST = -1;
const SW_HIDE = 0, SW_SHOWNA = 8; // prettier-ignore
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000; // prettier-ignore

// ------------------------------------------------------------------ the key

const TALK_KEYS: Record<string, number> = { "left-ctrl": 0xa2, "right-ctrl": 0xa3, "right-alt": 0xa5, f8: 0x77 };
const MODIFIERS = new Set([0x10, 0x11, 0x12, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5]); // Shift, Ctrl, Alt and their sides: held with the talk key without meaning to type

/** The push-to-talk key: left Ctrl (a laptop keyboard may have no right one), or what HANDS_KEY names (`right-ctrl`, `right-alt`, `f8`, or a virtual key code). */
export const talkKey = (setting = process.env.HANDS_KEY): number => (setting ? (TALK_KEYS[setting.toLowerCase()] ?? Number(setting)) || 0xa2 : 0xa2);

/**
 * The push-to-talk key, polled from the async key table, which sees every key whoever has the keyboard: no hook, so
 * no thread that must pump messages. A key pressed while it is held means the user is typing, not talking: that
 * cancels. `fake` holds the key down from inside, for a run that speaks from a file. `isDown` and `now` are
 * parameters so that the machine can be tested without a keyboard.
 */
export function watchKey(onTalk: (talk: Talk) => void, isDown: (vk: number) => boolean, key = talkKey(), now = () => performance.now()): { poll(): void; fake(down: boolean): void } {
  let [held, faked, cancelled, since] = [false, false, false, 0];
  const was = new Uint8Array(256); // what was already down when the talk key went down: not typing
  const scan = (): boolean => {
    let typed = false;
    for (let vk = 0x08; vk <= 0xfe; vk++) {
      if (vk === key || MODIFIERS.has(vk)) continue;
      const down = isDown(vk) ? 1 : 0;
      if (down && !was[vk]) typed = true;
      was[vk] = down;
    }
    return typed;
  };
  return {
    fake: (down) => void (faked = down),
    poll() {
      const down = faked || isDown(key);
      if (down && !held) {
        [since, cancelled] = [now(), false];
        scan();
        onTalk("down");
      } else if (!down && held) {
        if (!cancelled) onTalk(now() - since < TAP_MS ? "cancel" : "up");
      } else if (down && !cancelled && !faked && scan()) {
        cancelled = true;
        onTalk("cancel");
      }
      held = down;
    },
  };
}

// ------------------------------------------------------------------ sound

/** WAVEFORMATEX for what the Live API speaks: PCM, mono, 16-bit, 24 kHz, packed as Windows lays it out (18 bytes). */
const pcmFormat = (): Uint8Array => {
  const format = new DataView(new ArrayBuffer(18));
  for (const [offset, value] of [[0, 1], [2, 1], [12, 2], [14, 16], [16, 0]] as const) format.setUint16(offset, value, true); // tag, channels, block align, bits, extra
  format.setUint32(4, SAMPLE_RATE, true);
  format.setUint32(8, SAMPLE_RATE * 2, true);
  return new Uint8Array(format.buffer);
};

/** A WAVEHDR over a buffer of its own. Both stay referenced here for as long as the driver may write to them. */
export interface Header {
  hdr: Uint8Array;
  data: Uint8Array;
  view: DataView;
}
const header = (bytes: number): Header => {
  const [data, hdr] = [new Uint8Array(bytes), new Uint8Array(HDR_BYTES)];
  const view = new DataView(hdr.buffer);
  view.setBigUint64(0, BigInt(ptr(data)), true);
  view.setUint32(8, bytes, true);
  return { hdr, data, view };
};
const flags = (h: Header) => h.view.getUint32(24, true);
export const isDone = (h: Header): boolean => (flags(h) & WHDR_DONE) !== 0;

/** The headers the device has finished with, taken out of `queued` and put in `free` for the next chunk. */
export function recycle(queued: Header[], free: Header[], done: (h: Header) => boolean = isDone): void {
  for (let i = queued.length - 1; i >= 0; i--) if (done(queued[i]!)) free.push(...queued.splice(i, 1));
}

const out = new BigUint64Array(1);
const made = (status: number, what: string): bigint => {
  if (status !== 0) throw new Error(`${what} failed (MMSYSERR ${status})`);
  return out[0]!;
};

function sound() {
  // The microphone. Kept warm, it runs all the time and remembers its last third of a second, so that a press of the
  // key loses nothing to the microphone starting up (60 ms, measured) or to a word begun before the key was down;
  // nothing it hears leaves this process until someone listens. Cold, it runs only while someone does.
  let hear: ((pcm: Uint8Array) => void) | null = null;
  let input: bigint | null = null;
  let running = false;
  let next = 0; // the buffer the device fills next: they come back in the order they went in
  const kept: Uint8Array[] = [];
  const buffers: Header[] = [];
  const add = (h: Header): void => {
    if (flags(h) & WHDR_PREPARED) winmm.waveInUnprepareHeader(input, ptr(h.hdr), HDR_BYTES);
    h.view.setUint32(12, 0, true);
    h.view.setUint32(24, 0, true);
    winmm.waveInPrepareHeader(input, ptr(h.hdr), HDR_BYTES);
    winmm.waveInAddBuffer(input, ptr(h.hdr), HDR_BYTES);
  };
  const open = (): void => {
    if (running) return;
    if (input === null) {
      input = made(winmm.waveInOpen(ptr(out), WAVE_MAPPER, ptr(pcmFormat()), null, null, 0), "opening the microphone");
      for (let i = 0; i < IN_FLIGHT; i++) buffers.push(header(CHUNK_BYTES));
    }
    for (const h of buffers) add(h);
    next = 0;
    running = true;
    made(winmm.waveInStart(input), "starting the microphone");
  };
  const mic = {
    warm: open,
    /** Hand over what is remembered, then everything as it comes. */
    listen(onChunk: (pcm: Uint8Array) => void): void {
      open();
      for (const pcm of kept.splice(0)) onChunk(pcm);
      hear = onChunk;
    },
    /** Stop handing over: a warm microphone goes back to remembering, a cold one is closed. */
    rest(keepWarm: boolean): void {
      hear = null;
      if (keepWarm || !running || input === null) return;
      running = false;
      winmm.waveInStop(input);
      winmm.waveInReset(input); // every buffer comes back at once, and is put back in by `open`
      kept.length = 0;
    },
    /** What the device has filled since the last pump, in order. */
    pump(): void {
      for (let h = buffers[next]; running && h && isDone(h); h = buffers[next]) {
        const bytes = h.view.getUint32(12, true);
        const pcm = bytes ? h.data.slice(0, bytes) : null;
        if (pcm && hear) hear(pcm);
        else if (pcm && kept.push(pcm) > PREROLL_CHUNKS) kept.shift();
        add(h);
        next = (next + 1) % buffers.length;
      }
    },
  };

  // The speaker: waveOut plays what it is written in order, on its own thread, and marks each header done when it
  // has. It is opened once and left open. `until` is when what is queued will have been played, by this process's
  // clock: the device's own position counts at its native rate, not ours (measured), so it is not asked.
  let output: bigint | null = null;
  let until = 0;
  const queued: Header[] = [];
  const free: Header[] = [];
  const write = (pcm: Uint8Array | number): void => {
    const bytes = typeof pcm === "number" ? pcm : pcm.length;
    if (bytes < 2) return;
    recycle(queued, free);
    let h = free.find((h) => h.data.length === bytes);
    if (h) free.splice(free.indexOf(h), 1);
    else {
      h = header(bytes);
      winmm.waveOutPrepareHeader(output, ptr(h.hdr), HDR_BYTES);
    }
    h.view.setUint32(24, flags(h) & ~WHDR_DONE, true);
    if (typeof pcm === "number") h.data.fill(0);
    else h.data.set(pcm);
    if (winmm.waveOutWrite(output, ptr(h.hdr), HDR_BYTES) !== 0) return void free.push(h);
    queued.push(h);
    until = Math.max(until, performance.now()) + bytes / 2 / (SAMPLE_RATE / 1000);
  };
  const speaker = {
    /**
     * Queue a chunk, kept a cushion ahead of the speaker with silence, as shell.ts explains: restored in the voice's
     * pauses, where more silence cannot be heard, and in the middle of a word only when the queue is all but empty.
     */
    play(pcm: Uint8Array): void {
      output ??= made(winmm.waveOutOpen(ptr(out), WAVE_MAPPER, ptr(pcmFormat()), null, null, 0), "opening the speaker");
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      let peak = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true) / 32768));
      const left = Math.max(0, until - performance.now());
      const pad = cushion(left, peak < QUIET);
      if (process.env.HANDS_DEBUG && pad !== 0 && (pad === null || peak >= QUIET)) console.error(`[speaker] ${Math.round(left)} ms queued: ${pad === null ? "a pause left out" : `${Math.round(pad)} ms of silence put into speech`}`);
      if (pad === null) return;
      write(Math.round((pad * SAMPLE_RATE) / 1000) * 2);
      write(pcm);
    },
    /** Drop what is queued: the user has started talking over it. Every header comes back done, for `write` to reuse. */
    hush(): void {
      if (output !== null) winmm.waveOutReset(output);
      until = 0;
    },
  };
  return { mic, speaker };
}

// ------------------------------------------------------------------ the panel

/** The monitors' work areas (the desktop less the taskbar), in physical pixels, in the order the system lists them. */
function workAreas(): [left: number, top: number, right: number, bottom: number][] {
  const areas: [number, number, number, number][] = [];
  const info = new Uint8Array(40); // MONITORINFO: cbSize, rcMonitor, rcWork, dwFlags
  const view = new DataView(info.buffer);
  const each = new JSCallback(
    (monitor: Ref) => {
      view.setUint32(0, 40, true);
      if (user32.GetMonitorInfoW(monitor, ptr(info))) areas.push([view.getInt32(20, true), view.getInt32(24, true), view.getInt32(28, true), view.getInt32(32, true)]);
      return true;
    },
    { args: ["ptr", "ptr", "ptr", "i64"], returns: "bool" },
  );
  user32.EnumDisplayMonitors(null, null, each.ptr, 0);
  each.close();
  return areas;
}

const className = (hwnd: Ref): string => {
  const name = new Uint8Array(128);
  const length = user32.GetClassNameW(hwnd, ptr(name), 64);
  return Buffer.from(name.buffer, 0, length * 2).toString("utf16le");
};

/** The top-level window of a process, once it has one: Chromium's own hidden helper windows do not count. */
const windowOf = (pid: number): Ref | null => {
  const owner = new Uint32Array(1);
  for (let hwnd = user32.GetTopWindow(null); hwnd; hwnd = user32.GetWindow(hwnd, 2)) {
    if (!user32.IsWindowVisible(hwnd)) continue;
    user32.GetWindowThreadProcessId(hwnd, ptr(owner));
    if (owner[0] === pid && className(hwnd) === "Chrome_WidgetWin_1") return hwnd;
  }
  return null;
};

/** The foreground back to whoever had it, as if nothing had happened: allowed from here once our input is attached to theirs. */
function handBack(previous: Ref | null): boolean {
  const front = user32.GetForegroundWindow();
  if (!front || !previous || front === previous) return true;
  const [ours, theirs] = [kernel32.GetCurrentThreadId(), user32.GetWindowThreadProcessId(front, null)];
  user32.AttachThreadInput(ours, theirs, true);
  const given = user32.SetForegroundWindow(previous);
  user32.AttachThreadInput(ours, theirs, false);
  return given;
}

/**
 * A Chromium window in the bottom right corner that shows one web page, above other windows: Edge, which every
 * Windows has, or Chrome, run as an app with a profile of its own so that the window belongs to the process
 * launched. Chromium paints a title strip and thin borders of its own around an app page; a window region clips
 * them off, and the page keeps its size. Launching a browser activates it once: the foreground is handed back at
 * once, and the window is marked NOACTIVATE and a tool window from then on.
 */
function panel(url: string) {
  const browser = [
    `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ].find(existsSync);
  const profile = `${process.env.LOCALAPPDATA}\\hands\\panel`;
  const previous = user32.GetForegroundWindow();
  /** The work area of the chosen display, less the taskbar when it is showing there: an auto-hiding one is not counted out of the work area, and it slides up over the corner. */
  const area = (): [number, number, number, number] => {
    const areas = workAreas();
    const [left, top, right, bottom] = areas[Math.min(Number(process.env.HANDS_SCREEN) || 0, areas.length - 1)] ?? [0, 0, 1920, 1080];
    const tray = user32.FindWindowW(ptr(Buffer.from("Shell_TrayWnd\0", "utf16le")), null);
    const rect = new Int32Array(4);
    if (tray && user32.IsWindowVisible(tray) && user32.GetWindowRect(tray, ptr(rect)) && rect[0]! < right && rect[2]! > left && rect[1]! < bottom && rect[1]! > top + (bottom - top) / 2) return [left, top, right, rect[1]!];
    return [left, top, right, bottom];
  };
  let region: [number, number, number, number] | null = null; // the clip the window should have: Chromium puts its own back after a resize, so it is checked every pump
  const [left, top, right, bottom] = area();
  const dip = user32.GetDpiForSystem() / 96;
  const proc = browser
    ? Bun.spawn([browser, `--app=${url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=320,200", `--window-position=${Math.round((right - left) / dip) - 340},${Math.round((bottom - top) / dip) - 220}`], { stdio: ["ignore", "ignore", "ignore"] })
    : null;
  proc?.unref();
  const launched = performance.now();
  let hwnd: Ref | null = null;
  let wanted: [number, number] | null = null; // the last fit, for a window that is not up yet
  let shown = false;

  const scale = () => (hwnd ? user32.GetDpiForWindow(hwnd) : user32.GetDpiForSystem()) / 96;
  /** Size the window so the page's CSS size fits inside Chromium's frame, clip the frame off, and tuck the rest in the corner. */
  const place = (width: number, height: number): void => {
    if (!hwnd) return;
    const px = scale();
    const [side, strip] = [Math.round(FRAME_DIP[0] * px), Math.round(FRAME_DIP[1] * px)];
    const [w, h] = [Math.round(width * px) + 2 * side, Math.round(height * px) + strip];
    const [, , right, bottom] = area();
    user32.SetWindowPos(hwnd, HWND_TOPMOST, right - MARGIN_PX - w + side, bottom - MARGIN_PX - h, w, h, SWP_NOACTIVATE);
    region = [side, strip, w - side, h];
    clip();
    if (!shown) user32.ShowWindow(hwnd, SW_SHOWNA);
    shown = true;
  };
  const box = new Int32Array(4);
  /** Cut Chromium's frame off, unless the window already has that cut. The system owns a region once it is set, so a fresh one is made each time. */
  const clip = (): void => {
    if (!hwnd || !region) return;
    const current = gdi32.CreateRectRgn(0, 0, 0, 0);
    const kind = user32.GetWindowRgn(hwnd, current);
    gdi32.GetRgnBox(current, ptr(box));
    gdi32.DeleteObject(current);
    if (kind !== 0 && region.every((v, i) => v === box[i])) return;
    user32.SetWindowRgn(hwnd, gdi32.CreateRectRgn(...region), true);
  };
  return {
    fit(width: number, height: number): void {
      if (width < 1 || height < 1) {
        if (shown && hwnd) user32.ShowWindow(hwnd, SW_HIDE);
        return void ([shown, wanted] = [false, null]);
      }
      wanted = [width, height];
      place(width, height);
    },
    /** How tall the panel may grow: the work area less the margins and Chromium's title strip, in the page's own pixels. */
    room(): number {
      const [, top, , bottom] = area();
      const px = scale();
      return Math.floor((bottom - top - 2 * MARGIN_PX - Math.round(FRAME_DIP[1] * px)) / px);
    },
    /**
     * Give the page the keyboard, or hand it back. On: nothing, the browser activates itself when the user clicks into the
     * page. Off: hidden and shown again without activation, which makes the system pick the next window for the
     * foreground. (Not exercised live: a panel that has the focus needs a real click, which E10 could not give it.)
     */
    focus(on: boolean): void {
      if (on || !shown || !hwnd || user32.GetForegroundWindow() !== hwnd) return;
      user32.ShowWindow(hwnd, SW_HIDE);
      user32.ShowWindow(hwnd, SW_SHOWNA);
    },
    /** Once the browser has its window up: take it over, and give the foreground back. */
    pump(): void {
      if (hwnd) return void (shown && clip());
      if (!proc || performance.now() - launched > FIND_MS) return;
      const found = windowOf(proc.pid);
      if (!found) return;
      hwnd = found;
      user32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, Number(user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
      user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
      if (wanted) place(...wanted);
      else user32.ShowWindow(hwnd, SW_HIDE); // nothing to show yet: `fit` brings it up
      if (!handBack(previous) && process.env.HANDS_DEBUG) console.error("[panel] the foreground could not be handed back: one flicker at startup"); // refused to a process without a window of its own, in one measurement (E10)
    },
  };
}

// ------------------------------------------------------------------ the camera

/** One window of another app as a small JPEG, through the helper's capture, wherever it lies and whatever covers it. Null when it is gone. */
function camera(): (windowId: number) => Uint8Array | null {
  const dir = `${tmpdir()}\\hands-thumbs`;
  mkdirSync(dir, { recursive: true });
  return (windowId) => {
    const path = `${dir}\\${windowId}-${process.pid}.jpg`;
    try {
      native.call("capture", { hwnd: windowId, path, format: "jpeg", max: THUMB_PX });
      const jpeg = new Uint8Array(readFileSync(path));
      unlinkSync(path);
      return jpeg.length ? jpeg : null;
    } catch {
      return null;
    }
  };
}

// ------------------------------------------------------------------ all of it

export function start(options: { url: string; onTalk: (talk: Talk) => void }): Shell {
  user32.SetProcessDpiAwarenessContext(-4); // per-monitor aware v2, before any window or DPI is looked at: every coordinate here is a physical pixel
  const key = watchKey(options.onTalk, (vk) => (user32.GetAsyncKeyState(vk) & 0x8000) !== 0);
  const { mic, speaker } = sound();
  const corner = panel(options.url);
  setInterval(() => {
    key.poll();
    mic.pump();
    corner.pump();
  }, PUMP_MS);
  return { mic, speaker, panel: { fit: corner.fit, room: corner.room, focus: corner.focus }, thumbnail: camera(), holdKey: key.fake, frontWindow: () => allWindows()[0]?.id ?? null };
}
