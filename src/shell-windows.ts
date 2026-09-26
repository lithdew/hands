/**
 * The orchestrator's body on Windows: what `live.ts` needs from this PC that is not a hand. The same `Shell` as
 * shell.ts gives on a Mac, out of user32, winmm and a Chromium window: the talk key polled, the microphone and the
 * speaker on winmm's wave API with their headers polled for WHDR_DONE, and the panel the helper's own window in the
 * corner (src/panel.cs), told where to be. Everything is bun:ffi from this thread, on one 8 ms pump, and nothing here
 * blocks for long: winmm plays and records on its own threads, and hands the buffers back for the pump to find.
 * What goes through the helper is a thumbnail, which is a capture like any other, and the panel.
 *
 * The system's libraries are bound on first use, not on import: platform.ts imports this module on a Mac too.
 */

import { dlopen, JSCallback, type Pointer, ptr } from "bun:ffi";
import { cushion, type Panel, type Shell, type Shot, type Talk } from "./shell.ts";
import { helperPath, thumbnail } from "./windows.ts";

const PUMP_MS = 8;
const ARM_MS = 200; // the talk key must be held alone this long before it is a press: a Ctrl for a shortcut never is
const SAMPLE_RATE = 24000; // what gpt-live-1 hears and speaks: mono, 16-bit
const CHUNK_BYTES = (SAMPLE_RATE * 2 * 40) / 1000; // 40 ms
const PREROLL_CHUNKS = 12; // what a warm microphone remembers, half a second: the words said while the key was being armed, and a little before
const IN_FLIGHT = 16;
const QUIET = 100 / 32768; // a chunk that never gets louder than this is a pause
const PAD_STEP_MS = 10; // silence goes in these steps, so the speaker's headers come in a few sizes and are used again
const THUMB_PX = 720;
const MARGIN_PX = 12;
const PANEL_W = 600; // CSS px: the widest the page lays itself out, and the panel's fixed width
const AREA_MS = 1000; // how long a reading of the work area is trusted: it is asked for every time state goes to the page
const REFIT_MS = 2000; // how often the panel looks to see whether the work area under it has changed
const RESTART_MS = [1000, 2000, 5000, 10_000, 30_000]; // the panel, started again after it has gone, a little later each time
const STEADY_MS = 60_000; // a panel that ran this long before it went is started again at once
const WAVE_MAPPER = 0xffffffff;
const WHDR_DONE = 1;
const WHDR_PREPARED = 2;
const MONITORINFOF_PRIMARY = 1;
const ABM_GETSTATE = 4;
const ABM_GETTASKBARPOS = 5;
const ABS_AUTOHIDE = 1;
const ABE_RIGHT = 2;
const ABE_BOTTOM = 3;
const TASKBAR_PX = 48; // a Windows 11 taskbar at 100%: what an auto-hidden one is taken to be when it reports less
type Ref = Pointer | bigint; // a handle as bun:ffi returns it
const HDR_BYTES = 48; // a WAVEHDR on x64: lpData@0 dwBufferLength@8 dwBytesRecorded@12 dwUser@16 dwFlags@24 dwLoops@28 lpNext@32 reserved@40

function bind() {
  const user32 = dlopen("user32.dll", {
    GetAsyncKeyState: { args: ["i32"], returns: "i16" },
    SetProcessDpiAwarenessContext: { args: ["i64"], returns: "bool" },
    GetForegroundWindow: { args: [], returns: "ptr" },
    GetDpiForSystem: { args: [], returns: "u32" },
    EnumDisplayMonitors: { args: ["ptr", "ptr", "ptr", "i64"], returns: "bool" },
    GetMonitorInfoW: { args: ["ptr", "ptr"], returns: "bool" },
  }).symbols;
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
  const shell32 = dlopen("shell32.dll", { SHAppBarMessage: { args: ["u32", "ptr"], returns: "u64" } }).symbols;
  return { user32, winmm, shell32 };
}
let bound: ReturnType<typeof bind> | undefined;
const system = () => (bound ??= bind());

// ------------------------------------------------------------------ the key

const TALK_KEYS: Record<string, number> = { "left-ctrl": 0xa2, "right-ctrl": 0xa3, "right-alt": 0xa5, f8: 0x77 };
const NAMES: Record<number, string> = { 0xa2: "left Ctrl", 0xa3: "right Ctrl", 0xa4: "left Alt", 0xa5: "right Alt", 0xa0: "left Shift", 0xa1: "right Shift" };
const MODIFIERS = new Set([0x10, 0x11, 0x12, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c]); // Shift, Ctrl, Alt and their sides, and the Windows keys: held with the talk key without meaning to type
const MOUSE_BUTTONS = [0x01, 0x02, 0x04, 0x05, 0x06]; // left, right, middle and the two side buttons: a click while the key is held is not talking
const TWIN: Record<number, number> = { 0xa0: 0x10, 0xa1: 0x10, 0xa2: 0x11, 0xa3: 0x11, 0xa4: 0x12, 0xa5: 0x12 }; // the key for either side, which is down whenever this side is

/** The push-to-talk key: left Ctrl (a laptop keyboard may have no right one), or what HANDS_KEY names (`right-ctrl`, `right-alt`, `f8`, or a virtual key code). */
export const talkKey = (setting = process.env.HANDS_KEY): number => (setting ? (TALK_KEYS[setting.toLowerCase()] ?? Number(setting)) || 0xa2 : 0xa2);

/** The talk key as the user would name it: "left Ctrl", "F8". */
export function talkKeyName(key = talkKey()): string {
  if (NAMES[key]) return NAMES[key];
  if (key >= 0x70 && key <= 0x87) return `F${key - 0x6f}`;
  if ((key >= 0x30 && key <= 0x39) || (key >= 0x41 && key <= 0x5a)) return String.fromCharCode(key);
  return `the key with code ${key}`;
}

/**
 * The keys that go down with the talk key and are part of it: its side-less twin (Windows reports VK_CONTROL down with
 * either Ctrl), and for right Alt, the left Ctrl that a keyboard layout with AltGr sends along with it.
 */
const partOf = (key: number): Set<number> => new Set([key, ...(TWIN[key] ? [TWIN[key]] : []), ...(key === 0xa5 ? [0xa2, 0x11] : [])]);

/**
 * The push-to-talk key, polled from the async key table, which sees every key whoever has the keyboard: no hook, so
 * no thread that must pump messages. Nothing happens when it goes down: it is a press only once it has been held
 * alone for ARM_MS, and any other key or a mouse button before then (a Ctrl+C, a Ctrl+click, AltGr for a character)
 * drops it without a sign. So does a modifier that was down already when it went down: the talk key is then part of a
 * chord, whichever key came first (Shift then Ctrl, Win then Ctrl, and AltGr, whose left Ctrl and right Alt arrive in
 * the same instant). A key other than a modifier that was down already is not typing: it may be stuck, or resting
 * under something. Once it is a press, "down"; a key typed while it is held means the user is typing after
 * all, "cancel"; let go, "up". `fake` holds the key down from inside, for a run that speaks from a file, and is a press
 * at once. `isDown` and `now` are parameters so that the machine can be tested without a keyboard.
 */
export function watchKey(onTalk: (talk: Talk) => void, isDown: (vk: number) => boolean, key = talkKey(), now = () => performance.now()): { poll(): void; fake(down: boolean): void } {
  const own = partOf(key);
  let state: "up" | "arming" | "pressed" | "dropped" = "up";
  let [faked, since] = [false, 0];
  const was = new Uint8Array(256); // what was already down when the talk key went down: not typing
  /** Whether a key or button has gone down since the last look: any at all while arming, and not a modifier once pressed. */
  const scan = (strict: boolean): boolean => {
    let typed = false;
    const look = (vk: number) => {
      if (own.has(vk)) return;
      const down = isDown(vk) ? 1 : 0;
      if (down && !was[vk] && (strict || !MODIFIERS.has(vk))) typed = true;
      was[vk] = down;
    };
    for (const vk of MOUSE_BUTTONS) look(vk);
    for (let vk = 0x08; vk <= 0xfe; vk++) look(vk);
    return typed;
  };
  return {
    fake: (down) => void (faked = down),
    poll() {
      const down = faked || isDown(key);
      if (!down) {
        if (state === "pressed") onTalk("up");
        state = "up";
        return;
      }
      if (state === "up") {
        since = now();
        scan(true); // only to learn what was down already
        const chord = [...MODIFIERS].some((vk) => !own.has(vk) && was[vk]);
        state = faked ? "pressed" : chord ? "dropped" : "arming";
        if (faked) onTalk("down");
      } else if (state === "arming") {
        if (scan(true)) state = "dropped";
        else if (now() - since >= ARM_MS) {
          state = "pressed";
          onTalk("down");
        }
      } else if (state === "pressed" && !faked && scan(false)) {
        state = "dropped";
        onTalk("cancel");
      }
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

/** The bytes of silence for a pad of `ms`, in whole steps of PAD_STEP_MS: a pad of any other length would need a header of its own. */
export const padBytes = (ms: number): number => Math.round(ms / PAD_STEP_MS) * ((PAD_STEP_MS * SAMPLE_RATE) / 1000) * 2;

const out = new BigUint64Array(1);
const made = (status: number, what: string): bigint => {
  if (status !== 0) throw new Error(`${what} failed (MMSYSERR ${status})`);
  return out[0]!;
};

function sound() {
  const { winmm } = system();
  // The microphone. Kept warm, it runs all the time and remembers its last half second, so that a press of the key
  // loses nothing to the microphone starting up (60 ms, measured), to the key being armed, or to a word begun before
  // the key was down; nothing it hears leaves this process until someone listens. Cold, it runs only while someone does.
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
    /** Stop handing over, and forget: a warm microphone goes back to remembering from now, a cold one is closed. */
    rest(keepWarm: boolean): void {
      hear = null;
      kept.length = 0;
      if (keepWarm || !running || input === null) return;
      running = false;
      winmm.waveInStop(input);
      winmm.waveInReset(input); // every buffer comes back at once, and is put back in by `open`
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
      write(padBytes(pad));
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

/** A display: the whole of it and its work area (the desktop less a taskbar that does not hide), in physical pixels. */
type Box = [left: number, top: number, right: number, bottom: number];
export interface Monitor {
  bounds: Box;
  work: Box;
  primary: boolean;
}

/** The monitors, the primary one first and the rest as the system lists them: so display 0 is the one the hands and the helper call 0 too. */
export const primaryFirst = (monitors: Monitor[]): Monitor[] => [...monitors.filter((m) => m.primary), ...monitors.filter((m) => !m.primary)];

function monitors(): Monitor[] {
  const { user32 } = system();
  const found: Monitor[] = [];
  const info = new Uint8Array(40); // MONITORINFO: cbSize@0, rcMonitor@4, rcWork@20, dwFlags@36
  const view = new DataView(info.buffer);
  const box = (at: number): Box => [view.getInt32(at, true), view.getInt32(at + 4, true), view.getInt32(at + 8, true), view.getInt32(at + 12, true)];
  const each = new JSCallback(
    (monitor: Ref) => {
      view.setUint32(0, 40, true);
      if (user32.GetMonitorInfoW(monitor, ptr(info))) found.push({ bounds: box(4), work: box(20), primary: (view.getUint32(36, true) & MONITORINFOF_PRIMARY) !== 0 });
      return true;
    },
    { args: ["ptr", "ptr", "ptr", "i64"], returns: "bool" },
  );
  user32.EnumDisplayMonitors(null, null, each.ptr, 0);
  each.close();
  return primaryFirst(found);
}

/** The taskbar, when it hides itself: which edge it is on, and how far it reaches in when it slides out. Null when it does not hide. */
function hidingTaskbar(): { edge: number; rect: Box } | null {
  const { shell32 } = system();
  const data = new Uint8Array(48); // APPBARDATA on x64: cbSize@0, hWnd@8, uCallbackMessage@16, uEdge@20, rc@24, lParam@40
  const view = new DataView(data.buffer);
  view.setUint32(0, 48, true);
  if ((Number(shell32.SHAppBarMessage(ABM_GETSTATE, ptr(data))) & ABS_AUTOHIDE) === 0) return null;
  if (!shell32.SHAppBarMessage(ABM_GETTASKBARPOS, ptr(data))) return null;
  return { edge: view.getUint32(20, true), rect: [view.getInt32(24, true), view.getInt32(28, true), view.getInt32(32, true), view.getInt32(36, true)] };
}

/**
 * The part of a monitor the panel may use: its work area, less a taskbar that hides itself, which the work area does
 * not count and which slides out over the corner. That one is cleared by its full size, whatever it is doing now: a
 * hidden one says it is a sliver, and so is taken to be as big as a taskbar at this scale.
 */
export function usable(monitor: Monitor, taskbar: { edge: number; rect: Box } | null, scale: number): Box {
  const [left, top, right, bottom] = monitor.work;
  if (!taskbar) return [left, top, right, bottom];
  const [tl, tt, tr, tb] = taskbar.rect;
  const [ml, mt, mr, mb] = monitor.bounds;
  if (tr <= ml || tl >= mr || tb <= mt || tt >= mb) return [left, top, right, bottom]; // on another monitor
  const full = Math.round(TASKBAR_PX * scale);
  if (taskbar.edge === ABE_BOTTOM) return [left, top, right, Math.min(bottom, mb - Math.max(tb - tt, full))];
  if (taskbar.edge === ABE_RIGHT) return [left, top, Math.min(right, mr - Math.max(tr - tl, full)), bottom];
  return [left, top, right, bottom];
}

/** Where the panel goes: a box of the page's fixed width and the whole height it may have, in the bottom right corner of `area`, in physical pixels. */
export function placement([, top, right, bottom]: Box, dpr: number): { x: number; y: number; w: number; h: number } {
  const [w, h] = [Math.round(PANEL_W * dpr), Math.max(1, bottom - top - 2 * MARGIN_PX)];
  return { x: right - MARGIN_PX - w, y: bottom - MARGIN_PX - h, w, h };
}

/**
 * A borderless, never-activating window in the bottom right corner that shows one web page, above other windows:
 * the helper's "panel" mode (src/panel.cs), a WebView2 in a tool window whose clear pixels are not there, told
 * where to be over its stdin. The window has one size, PANEL_W by as tall as the corner allows, in the page's pixels
 * times its devicePixelRatio, and the page lays itself out in its bottom right: it is placed again only when the work
 * area, the ratio, or whether there is anything to show changes, never as the page's content grows and shrinks. If
 * the panel's process goes, another is started, a little later each time.
 */
function panel(url: string): Panel & { refit(): void } {
  const { user32 } = system();
  let proc: Bun.Subprocess<"pipe", "ignore", "inherit"> | null = null;
  let dpr = user32.GetDpiForSystem() / 96; // until the page says
  let shown = false;
  let placed = ""; // the last command that placed or hid the window
  let failures = 0;
  let cached: { at: number; box: Box } | null = null;

  const area = (): Box => {
    if (cached && performance.now() - cached.at < AREA_MS) return cached.box;
    const all = monitors();
    const monitor = all[Math.min(Number(process.env.HANDS_SCREEN) || 0, all.length - 1)];
    const box = monitor ? usable(monitor, hidingTaskbar(), dpr) : ([0, 0, 1920, 1080] as Box);
    cached = { at: performance.now(), box };
    return box;
  };
  const tell = (command: Record<string, unknown>): void => {
    if (!proc || proc.exitCode !== null) return; // gone: it said why on stderr, and another is on its way
    try {
      proc.stdin.write(`${JSON.stringify(command)}\n`);
      proc.stdin.flush();
    } catch {
      // it went as this was written: its exit starts another, which is placed from scratch
    }
  };
  const place = (): void => {
    const command = shown ? { cmd: "fit", ...placement(area(), dpr) } : { cmd: "hide" };
    const said = JSON.stringify(command);
    if (said === placed || (!shown && !placed)) return; // a window never shown needs no hiding
    tell(command);
    placed = said;
  };
  const start = (): void => {
    const began = performance.now();
    try {
      proc = Bun.spawn([helperPath(), "panel", url, `${process.env.LOCALAPPDATA}\\hands\\webview`], { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
    } catch (error) {
      console.error(`[panel] cannot start the panel: ${(error as Error).message}`);
      return again(began);
    }
    proc.unref();
    placed = "";
    place();
    void proc.exited.then((code) => {
      console.error(`[panel] the panel closed (exit code ${code})`);
      again(began);
    });
  };
  const again = (began: number): void => {
    if (performance.now() - began > STEADY_MS) failures = 0;
    const wait = RESTART_MS[Math.min(failures++, RESTART_MS.length - 1)]!;
    setTimeout(start, wait).unref();
  };
  start();
  return {
    /** The page's size and pixel ratio: nothing to show (0 by 0) hides the window, and anything else shows it at its one size. */
    fit(width: number, height: number, ratio?: number): void {
      shown = width >= 1 && height >= 1;
      if (ratio && ratio > 0 && ratio !== dpr) [dpr, cached] = [ratio, null];
      place();
    },
    /** How tall the panel is, in the page's own pixels: the page lays itself out in that. */
    room(): number {
      const [, top, , bottom] = area();
      return Math.floor((bottom - top - 2 * MARGIN_PX) / dpr);
    },
    /** Give the page the keyboard, or hand it back to whatever the user was in: the helper does both. */
    focus(on: boolean): void {
      tell({ cmd: "focus", on });
    },
    /** Place the window again if the work area has changed under it: a taskbar moved or set to hide, a display added. */
    refit: place,
  };
}

// ------------------------------------------------------------------ the camera

/** One window of another app, small, through the helper: never a minimized window restored for it, and never a frame that shows nothing. Null when it is gone. */
function camera(windowId: number): Shot {
  try {
    return thumbnail(windowId, THUMB_PX);
  } catch {
    return null; // the helper went away with it: the next frame starts another
  }
}

// ------------------------------------------------------------------ all of it

export function start(options: { url: string; onTalk: (talk: Talk) => void }): Shell {
  const { user32 } = system();
  user32.SetProcessDpiAwarenessContext(-4); // per-monitor aware v2, before any window or DPI is looked at: every coordinate here is a physical pixel
  const key = watchKey(options.onTalk, (vk) => (user32.GetAsyncKeyState(vk) & 0x8000) !== 0);
  const { mic, speaker } = sound();
  const corner = panel(options.url);
  setInterval(() => {
    key.poll();
    mic.pump();
  }, PUMP_MS);
  setInterval(() => {
    try {
      corner.refit();
    } catch (error) {
      console.error(`[panel] ${(error as Error).message}`);
    }
  }, REFIT_MS);
  return {
    mic,
    speaker,
    panel: { fit: corner.fit, room: corner.room, focus: corner.focus },
    thumbnail: camera,
    holdKey: key.fake,
    frontWindow: () => Number(user32.GetForegroundWindow() ?? 0) || null, // the window the user is in, straight from user32: no helper, so nothing to break
  };
}
