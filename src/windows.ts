/**
 * Windows adapter: the same exports as macos.ts, over one native helper.
 *
 * Everything that touches the desktop goes through `hands-<hash>.exe serve`, a C# process (src/windows.cs, built
 * here on first use with the compiler that ships in Windows) answering JSON over a named pipe. Bun calls it
 * synchronously through bun:ffi (kernel32), so the sync exports of macos.ts stay sync here.
 *
 * Coordinates are physical pixels everywhere: the helper is per-monitor DPI aware, and so is this process. A
 * window id is its HWND, a pid a Windows pid, and Screen.scale is 1.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { ABORT_CORNER_PX } from "./config.ts";
import {
  AX_PRESS, type AxAttrs, type Display as MacDisplay, MIN_WINDOW_SIDE_PT, type OcrLine, type PinnedWindow, type PointerTarget,
  type Tab, type TabCommand, type WalkOptions, type WindowSelector, walkActionable,
} from "./macos.ts"; // prettier-ignore
import { Abort, type AxNode, type Box, type Capture, type Field, type Frame, type Point } from "./models.ts";
import { type KeyTarget, SeatBusy, SeatTaken, type WorkingWindow } from "./seat.ts";

export {
  AX_ACTIONABLE_ROLES, AX_FANOUT, AX_LABEL_DESCENDANT_ROLES, AX_LABEL_PARENT_ROLES, AX_MESSAGE_TIMEOUT, AX_MIN_SIDE_PT, AX_NODE_CAP, AX_OFFSCREEN_CAP,
  AX_PRESS, AX_SKIP_SUBTREE_ROLES, AX_TIME_CAP, AX_VALUE_CHARS, type AxAttrs, clickable, descendantLabel, MIN_WINDOW_SIDE_PT, type OcrLine,
  offDisplay, type PinnedWindow, type PointerTarget, subtreeKey, type Tab, type TabCommand, type WalkOptions, walkActionable, type WindowSelector,
} from "./macos.ts"; // prettier-ignore
export type Display = MacDisplay;

const EVENT_DELAY_MS = 40;
const DRAG_STEP_PT = 6; // distance between the drag events along a stroke
const DRAG_DELAY_MS = 8;

// Virtual-key codes. Chords go by key code, so they follow the US layout; typed text does not. Delete is the key
// that deletes forward, as a Windows keyboard labels it (it clears a cell in Excel); Backspace is its own.
export const KEYCODES: Record<string, number> = {
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48, i: 0x49, j: 0x4a, k: 0x4b, l: 0x4c, m: 0x4d, n: 0x4e, o: 0x4f, p: 0x50,
  q: 0x51, r: 0x52, s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58, y: 0x59, z: 0x5a,
  "0": 0x30, "1": 0x31, "2": 0x32, "3": 0x33, "4": 0x34, "5": 0x35, "6": 0x36, "7": 0x37, "8": 0x38, "9": 0x39,
  return: 0x0d, enter: 0x0d, tab: 0x09, space: 0x20, delete: 0x2e, del: 0x2e, forwarddelete: 0x2e, backspace: 0x08, escape: 0x1b, esc: 0x1b,
  insert: 0x2d, ins: 0x2d, apps: 0x5d, contextmenu: 0x5d, capslock: 0x14, printscreen: 0x2c,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  numpad0: 0x60, numpad1: 0x61, numpad2: 0x62, numpad3: 0x63, numpad4: 0x64, numpad5: 0x65, numpad6: 0x66, numpad7: 0x67, numpad8: 0x68, numpad9: 0x69,
  multiply: 0x6a, add: 0x6b, subtract: 0x6d, decimal: 0x6e, divide: 0x6f,
  ";": 0xba, "=": 0xbb, ",": 0xbc, "-": 0xbd, ".": 0xbe, "/": 0xbf, "`": 0xc0, "[": 0xdb, "\\": 0xdc, "]": 0xdd, "'": 0xde,
}; // prettier-ignore
/** Modifier virtual keys. "cmd" is Ctrl here: what the shared code means by a shortcut. */
export const MODIFIERS: Record<string, number> = {
  cmd: 0x11, command: 0x11, ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, option: 0x12, opt: 0x12, win: 0x5b, lwin: 0x5b, windows: 0x5b, rwin: 0x5c,
}; // prettier-ignore
/** Names for a character that a chord cannot spell: "ctrl+plus" is ctrl and '+'. */
const CHARACTER_KEYS: Record<string, string> = { plus: "+", asterisk: "*", star: "*", minus: "-", equals: "=", comma: ",", period: ".", slash: "/", backslash: "\\" };
/** What shift makes of a key on the US layout: shift+1 is '!', shift+a is 'A'. */
const SHIFTED: Record<string, string> = {
  "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
  "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": '"', ",": "<", ".": ">", "/": "?", "`": "~",
}; // prettier-ignore
const UNSHIFTED: Record<string, string> = Object.fromEntries(Object.entries(SHIFTED).map(([key, char]) => [char, key]));

/**
 * A key and its modifiers as what is sent: a virtual key with the modifiers' keys, or text for a character that is
 * typed rather than pressed (a shifted symbol, '+' or '*', shift with a letter). A modifier alone is a key too.
 */
export function keystroke(key: string, modifiers: string[] = []): { vk: number; mods: number[] } | { text: string } {
  const mods = modifiers.map((name) => {
    const vk = MODIFIERS[name.toLowerCase()];
    if (vk === undefined) throw new Error(`unknown modifier ${JSON.stringify(name)}`);
    return vk;
  });
  const name = CHARACTER_KEYS[key.toLowerCase()] ?? key;
  const shift = mods.includes(MODIFIERS.shift!);
  const others = mods.filter((vk) => vk !== MODIFIERS.shift);
  // A character on its own, or with shift alone, is text: '*', 'A', shift+1.
  if (others.length === 0 && [...name].length === 1) {
    if (UNSHIFTED[name] !== undefined || /^[A-Z]$/.test(name)) return { text: name };
    if (shift && SHIFTED[name] !== undefined) return { text: SHIFTED[name]! };
    if (shift && /^[a-z]$/.test(name)) return { text: name.toUpperCase() };
  }
  // With ctrl, alt or win, a shifted symbol is its key and shift: ctrl+plus is ctrl+shift+'='. A capital letter is its
  // letter: "ctrl+A" is how a shortcut is written, not a request for shift.
  const base = (UNSHIFTED[name] ?? name).toLowerCase();
  const vk = KEYCODES[base] ?? MODIFIERS[base];
  if (vk === undefined) throw new Error(`unknown key ${JSON.stringify(key)}`);
  return { vk, mods: UNSHIFTED[name] !== undefined && !shift ? [...mods, MODIFIERS.shift!] : mods };
}

// ------------------------------------------------------------------ the helper

const SYSTEM_ROOT = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
const FRAMEWORK = join(SYSTEM_ROOT, "Microsoft.NET", "Framework64", "v4.0.30319");
const CSC = join(FRAMEWORK, "csc.exe");
const SOURCES = [join(import.meta.dir, "windows.cs"), join(import.meta.dir, "overlay.cs"), join(import.meta.dir, "panel.cs"), join(import.meta.dir, "vendor", "VirtualDesktop11-24H2.cs")];

/**
 * The helper's exe, built from windows.cs, overlay.cs, panel.cs and the vendored virtual-desktop library into
 * %LOCALAPPDATA%\hands when that build is not there yet. It is built under a name of this process's own and renamed
 * into place, so that hands starting together never run a half-written exe or fight over one output file.
 */
export function helperPath(): string {
  const dir = join(process.env.LOCALAPPDATA ?? tmpdir(), "hands");
  const sources = SOURCES.map((path) => readFileSync(path, "utf8"));
  const hash = createHash("sha1").update(sources.join("\n")).digest("hex").slice(0, 12);
  const exe = join(dir, `hands-${hash}.exe`);
  if (existsSync(exe)) return exe;
  mkdirSync(dir, { recursive: true });
  const building = join(dir, `hands-${hash}.${process.pid}.building.exe`);
  const refs = ["UIAutomationClient.dll", "UIAutomationTypes.dll", "WindowsBase.dll", "System.Drawing.dll", "System.Windows.Forms.dll", `${FRAMEWORK}\\System.Runtime.dll`, `${FRAMEWORK}\\System.Runtime.WindowsRuntime.dll`];
  const winmds = ["Foundation", "Globalization", "Graphics", "Media", "Storage"].map((name) => join(SYSTEM_ROOT, "System32", "WinMetadata", `Windows.${name}.winmd`));
  // /main: the vendored library carries a command-line tool's entry point of its own.
  const built = Bun.spawnSync([CSC, "/nologo", "/optimize+", "/target:winexe", "/platform:x64", "/main:Program", `/out:${building}`, `/lib:${FRAMEWORK}\\WPF`, ...[...refs, ...winmds].map((r) => `/r:${r}`), ...SOURCES], { stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0 || !existsSync(building)) {
    rmSync(building, { force: true });
    throw new Error(`cannot build the Windows helper: ${built.stdout.toString().trim() || built.stderr.toString().trim()}`);
  }
  try {
    renameSync(building, exe);
  } catch {
    rmSync(building, { force: true }); // another process got there first, with the same sources
  }
  if (!existsSync(exe)) throw new Error(`cannot put the Windows helper at ${exe}`);
  for (const old of readdirSync(dir)) {
    if (!/^hands-[0-9a-f]+\.exe$/.test(old) || join(dir, old) === exe) continue;
    try {
      rmSync(join(dir, old), { force: true });
    } catch {
      // best effort: a running hand keeps its own
    }
  }
  return exe;
}

/** The process that draws the hand on screen: the same exe in its "hand" mode (src/overlay.cs). */
export const rendererCommand = (): string[] => [helperPath(), "hand"];

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const INVALID_HANDLE = -1n;
const STILL_ACTIVE = 259;
const ACCESS_VIOLATION = 0xc0000005; // as GetExitCodeProcess reports it, unsigned
const PIPE_GONE = new Set([109, 232]); // ERROR_BROKEN_PIPE, ERROR_NO_DATA: the helper went away between calls

function bindKernel() {
  const k32 = dlopen("kernel32.dll", {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
    WriteFile: { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    ReadFile: { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
    WaitNamedPipeW: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.i64 },
    GetExitCodeProcess: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  const user32 = dlopen("user32.dll", { SetProcessDpiAwarenessContext: { args: [FFIType.i64], returns: FFIType.i32 } }).symbols;
  user32.SetProcessDpiAwarenessContext(-4n); // physical pixels here too, so the hand's window lands where the helper says
  return k32;
}

type Kernel = ReturnType<typeof bindKernel>;

/** The helper process and the pipe to it. The first call starts it; a broken pipe ends it, and the next call starts another. */
class Helper {
  private handle = INVALID_HANDLE;
  private readBuffer = Buffer.alloc(1 << 16);
  private readonly header = Buffer.alloc(4);
  private readonly count = new Uint32Array(1);
  private readonly decoder = new TextDecoder();
  private readonly proc: ReturnType<typeof Bun.spawn>;

  constructor(private readonly k32: Kernel, exe: string) {
    this.proc = Bun.spawn([exe, "serve"], { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
    this.proc.unref(); // the helper follows this process out (its stdin closes, the pipe breaks), not the other way round
    const name = Buffer.from(`\\\\.\\pipe\\hands-${this.proc.pid}\0`, "utf16le");
    for (const end = Date.now() + 8000; ; ) {
      this.handle = k32.CreateFileW(ptr(name), GENERIC_READ | GENERIC_WRITE, 0, null, OPEN_EXISTING, 0, null) as bigint;
      if (this.handle !== INVALID_HANDLE) break;
      const error = k32.GetLastError();
      const code = this.exitCode();
      if (code !== null) throw new Error(`the Windows helper ${exe} exited with code ${code} right after starting${code === 1 || code === ACCESS_VIOLATION ? "" : " (Smart App Control may have blocked it: check the notification, or allow the file)"}`);
      if (Date.now() > end) {
        this.proc.kill(); // not left running with nobody to talk to
        throw new Error(`cannot connect to the Windows helper (error ${error})`);
      }
      if (error === 231) k32.WaitNamedPipeW(ptr(name), 500); // ERROR_PIPE_BUSY
      else Bun.sleepSync(10); // not listening yet
    }
  }

  private exitCode(): number | null {
    const process = this.k32.OpenProcess(0x1000, 0, this.proc.pid) as bigint; // PROCESS_QUERY_LIMITED_INFORMATION
    if (!process) return null;
    const code = new Uint32Array(1);
    const known = this.k32.GetExitCodeProcess(process, ptr(code)) && code[0] !== STILL_ACTIVE;
    this.k32.CloseHandle(process);
    return known ? code[0]! : null;
  }

  private writeAll(buffer: Buffer): void {
    for (let off = 0; off < buffer.length; off += this.count[0]!) {
      if (!this.k32.WriteFile(this.handle, ptr(buffer, off), buffer.length - off, ptr(this.count), null)) throw new PipeError("write", this.k32.GetLastError(), off === 0);
    }
  }

  private readExact(buffer: Buffer, length: number): void {
    for (let off = 0; off < length; off += this.count[0]!) {
      if (!this.k32.ReadFile(this.handle, ptr(buffer, off), length - off, ptr(this.count), null) || this.count[0] === 0) throw new PipeError("read", this.k32.GetLastError(), false);
    }
  }

  call(request: string): string {
    const body = Buffer.from(request, "utf8");
    const message = Buffer.allocUnsafe(4 + body.length);
    message.writeUInt32LE(body.length, 0);
    body.copy(message, 4);
    this.count[0] = 0;
    this.writeAll(message);
    this.readExact(this.header, 4);
    const length = this.header.readUInt32LE(0);
    if (this.readBuffer.length < length) this.readBuffer = Buffer.alloc(length);
    this.readExact(this.readBuffer, length);
    return this.decoder.decode(this.readBuffer.subarray(0, length));
  }

  close(): void {
    if (this.handle !== INVALID_HANDLE) this.k32.CloseHandle(this.handle);
    this.handle = INVALID_HANDLE;
    this.proc.kill();
  }
}

/** The pipe to the helper failed, with the Windows error; `unsent` when not a byte of the request had gone, so that another helper can be sent it without doing it twice. */
class PipeError extends Error {
  constructor(
    way: "read" | "write",
    readonly code: number,
    readonly unsent: boolean,
  ) {
    super(`the Windows helper went away (${way} error ${code})`);
  }
}

let kernel: Kernel | undefined;
let helper: Helper | undefined;
let helperFailure: Error | undefined;
let lastCall = 0; // when this process last asked the helper for anything on its own account: the watcher's rounds do not count

/**
 * One synchronous round trip to the helper. A helper that has gone away between calls (the pipe broken, error 109 or
 * 232) is replaced and the request it never got is sent to the new one, once: element ids and a loaded capture do not
 * survive that, but most requests do not need them. Tests replace `call`; nothing else here reaches the machine.
 */
export const native = {
  call(command: string, args: object = {}): any {
    if (!watching) lastCall = performance.now();
    let reply: string | undefined;
    for (let attempt = 0; reply === undefined; attempt++) {
      if (!helper) {
        try {
          helper = new Helper((kernel ??= bindKernel()), helperPath());
          helperFailure = undefined;
        } catch (error) {
          helperFailure = error as Error;
          throw error;
        }
      }
      try {
        reply = helper.call(JSON.stringify({ cmd: command, ...args }));
      } catch (error) {
        helper.close();
        helper = undefined;
        if (attempt > 0 || !(error instanceof PipeError) || !PIPE_GONE.has(error.code) || !error.unsent) throw error;
      }
    }
    const parsed = JSON.parse(reply);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) throw new Error(`${command}: ${parsed.error}`);
    return parsed;
  },
};

const sleep = (ms: number) => Bun.sleep(ms);

// ------------------------------------------------------------------ escape hatch

let interrupted = false;
/**
 * Ctrl-C lands here so a run unwinds through the same path as the mouse corner, and still writes its summary; so do a
 * stop, a pause and a click on the hand (src/agent.ts halt), which every wait for the seat then ends on (checkStopped).
 */
export function interrupt(on = true): void {
  interrupted = on;
}

/**
 * Abort, once the hand has been stopped, paused or clicked (interrupt). Every wait for the seat asks this, before it
 * waits, on every round, and once more just before it acts: a hand told "not now" never takes the mouse and keyboard,
 * or makes a guarded click, afterwards.
 */
export function checkStopped(): void {
  if (interrupted) throw new Abort("stopped");
}

/** What the tools hear of the machine's side of the seat (src/tools.ts sets them). */
export const hooks = {
  /**
   * A click into a page has waited long enough for the user to pause that the wait is worth showing ("waiting"), and
   * that wait is over ("free"), with what it is for: the hand and its card show it as they show a borrow's wait.
   */
  onSeatWait: null as ((state: "waiting" | "free", why: string) => void) | null,
};

/** The mouse in physical pixels of the virtual screen, y down from the top of the primary display. */
export function mouseLocation(): Point {
  const [x, y] = native.call("cursor") as [number, number];
  return [x, y];
}

/** The corner of whichever display the mouse is on: with one display stacked on another, a slam never reaches the main one's. */
export function checkAbort(): void {
  if (interrupted) throw new Abort("Ctrl-C");
  const [x, y] = mouseLocation();
  const cornered = displays().some(({ frame: [dx, dy] }) => x >= dx && y >= dy && x - dx <= ABORT_CORNER_PX && y - dy <= ABORT_CORNER_PX);
  if (cornered) throw new Abort("mouse in top-left corner");
}

export async function sleepWatching(seconds: number): Promise<void> {
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    checkAbort();
    await sleep(100);
  }
}

/** Windows asks no permission for any of this; false only when the helper cannot be built or started. */
export function accessibilityTrusted(): boolean {
  if (helperFailure) return false;
  try {
    native.call("ping");
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ displays

let displayCache: { at: number; all: Display[] } | undefined;

/** Every display, the primary one first, in physical pixels of the virtual screen. */
/** Forget the displays: for a test whose displays differ from the last test's. */
export const forgetDisplays = (): void => void (displayCache = undefined);

export function displays(): Display[] {
  if (displayCache && performance.now() - displayCache.at < 2000) return displayCache.all;
  const all = (native.call("displays") as { index: number; frame: Frame }[]).map(({ index, frame }) => ({ index, frame }));
  displayCache = { at: performance.now(), all };
  return all;
}

/** The display holding the center of a frame, or the primary one when there is no frame or no such display. */
export function displayFor(frame: Frame | null): Display {
  const all = displays();
  const main = all[0] ?? { index: 0, frame: [0, 0, 0, 0] as Frame };
  if (!frame) return main;
  const [cx, cy] = [frame[0] + frame[2] / 2, frame[1] + frame[3] / 2];
  return all.find(({ frame: [x, y, w, h] }) => cx >= x && cx < x + w && cy >= y && cy < y + h) ?? main;
}

// ------------------------------------------------------------------ input

let borrowed: number | null = null; // the helper's tick when the seat was borrowed (see borrow): its input then stops at the user's first touch
let borrowedRoot = 0; // the window borrowed, which its input goes to and nothing else

/**
 * Input for the seat goes through SendInput: it lands wherever the focus is, exactly as the user's would. The helper
 * sends none while the user holds a modifier or a mouse button, and during a borrow none once the user has touched the
 * mouse or keyboard, once another window has come in front of the borrowed one, or when something lies over the point
 * a click is for: the borrow ends there, with SeatTaken. A hand stopped mid-borrow sends nothing more either (Abort).
 */
const input = async (args: object, delay = EVENT_DELAY_MS) => {
  if (borrowed !== null) checkStopped();
  const reply = native.call("input", borrowed === null ? args : { ...args, since: borrowed, root: borrowedRoot }) as { ok?: boolean; taken?: string };
  if (reply.ok === false) {
    const taken = reply.taken ?? "the user took the mouse or keyboard back";
    if (borrowed !== null) throw new SeatTaken(`${taken}: ${taken.startsWith("the user") ? "the seat is theirs again" : "nothing more was sent"}`);
    throw new Error(`${reply.taken ?? "the user is busy"}: nothing was sent`);
  }
  if (borrowed !== null) holdLock(SEAT_LOCK);
  await sleep(delay);
};

export async function moveTo([x, y]: Point): Promise<void> {
  await input({ kind: "move", x: Math.round(x), y: Math.round(y) });
}

export async function clickAt(point: Point, options: { button?: "left" | "right"; count?: number } = {}): Promise<void> {
  await input({ kind: "click", x: Math.round(point[0]), y: Math.round(point[1]), button: options.button ?? "left", count: options.count ?? 1 });
}

/** Press, drag through every point, release. The points between are filled in, since a canvas draws what it is sent; `onMove` hears each one. */
export async function drag(path: Point[], onMove?: (at: Point) => void): Promise<void> {
  const [start, end] = [path[0], path[path.length - 1]];
  if (!start || !end) return;
  await moveTo(start);
  await input({ kind: "down" });
  let [px, py] = start;
  for (const [x, y] of path.slice(1)) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / DRAG_STEP_PT));
    for (let i = 1; i <= steps; i++) {
      checkAbort();
      const at: Point = [px + ((x - px) * i) / steps, py + ((y - py) * i) / steps];
      onMove?.(at);
      await input({ kind: "move", x: Math.round(at[0]), y: Math.round(at[1]) }, DRAG_DELAY_MS);
    }
    [px, py] = [x, y];
  }
  await sleep(EVENT_DELAY_MS);
  await moveTo(end);
  await input({ kind: "up" });
}

/** The window keys for a process go to: the one the hand works in there (a dialog it has open, if any), never another of the app's. */
function keyWindow(pid: number): number {
  const id = workingWindow(pid)?.windowId;
  if (id === undefined) throw new Error(`process ${pid} has no window to type into`);
  return id;
}

/** A key, with modifiers, to the seat; or, with a pid, posted to the window the hand works in there (see pressIn). */
export async function press(key: string, modifiers: string[] = [], pid?: number): Promise<void> {
  if (pid !== undefined) return pressIn({ pid, windowId: keyWindow(pid) }, key, modifiers);
  const stroke = keystroke(key, modifiers);
  await input("text" in stroke ? { kind: "text", text: stroke.text } : { kind: "key", vk: stroke.vk, modifiers: stroke.mods });
}

/** Text to the seat as Unicode key events; or, with a pid, posted to the window the hand works in there (see typeIn). */
export async function typeText(text: string, pid?: number): Promise<void> {
  if (!text) return;
  if (pid !== undefined) return typeIn({ pid, windowId: keyWindow(pid) }, text);
  await input({ kind: "text", text });
}

/**
 * The window keys for a target go to, once it is known to be one they may go to: a window the hand opened, a dialog
 * one of those opened, or, in an app the hand has no window of its own in, the window it was pointed at.
 */
function keysFor(target: KeyTarget): WindowEntry {
  refuseTheirs(target.windowId);
  const list = windowList();
  const entry = list.find((w) => w.hwnd === target.windowId);
  if (!entry) throw new Error("the window is gone; look again");
  if (!isOwn(entry, list) && opened.has(entry.pid)) throw new Error(`that window is not one this hand opened: in ${entry.exe || "that app"}, keys go only to the hand's own windows`);
  return entry;
}

/** Why a key cannot be posted: a posted key carries no modifier state, so a chord (or a modifier alone) needs the real keyboard. */
const chordFromBehind = (key: string, modifiers: string[]) =>
  new Error(`${[...modifiers, key].join("+")} cannot be sent to a window from behind: a posted key carries no ctrl, alt, shift or win. It needs the real keyboard for a moment (borrow the seat), or the command's own button or menu item.`);

/** Said when a tab is refused in a browser window; the helper refuses it too, in the same words (Input.TabKey in windows.cs). */
export const TAB_KEY =
  "tab: in a page, Tab can walk out of the page into the browser's own toolbar, where the next key presses the browser's buttons (a posted Enter there once bookmarked the page in the user's profile, measured). Click the field you want instead";

/** Whether a window is a browser's own, where a Tab past the page's last control walks into the browser's toolbar (an Electron app's page has none). */
const isBrowserWindow = (w: WindowEntry): boolean => w.cls.startsWith("Chrome_WidgetWin") && WEB_EXES.has(basename((w.exe ?? "").toLowerCase(), ".exe"));

/**
 * A key posted to one window, which need not be in front: to the control its thread has the focus on when that is
 * inside this window, else to its text control (a thread that is not in front has no focus to say), else to the window
 * itself (Chrome runs all its windows on one thread, so its focus is often in the user's; a Chromium window is told it
 * is active first, without which it drops posted keys). Shift with a character is that character; any other modifier,
 * or a modifier alone, throws: a posted key carries none, and would arrive as the bare key. Tab in a browser's window
 * throws an error starting "tab:" (see TAB_KEY).
 */
export async function pressIn(target: KeyTarget, key: string, modifiers: string[] = []): Promise<void> {
  const stroke = keystroke(key, modifiers);
  const lone = !("text" in stroke) && Object.values(MODIFIERS).includes(stroke.vk);
  if (lone || ("mods" in stroke && stroke.mods.length > 0)) throw chordFromBehind(key, modifiers);
  const entry = keysFor(target);
  if (!("text" in stroke) && stroke.vk === KEYCODES.tab && isBrowserWindow(entry)) throw new Error(TAB_KEY);
  const hwnd = entry.hwnd;
  const front = frontWindow();
  try {
    if ("text" in stroke) native.call("chars", { hwnd, text: stroke.text });
    else native.call("vkey", { hwnd, vk: stroke.vk });
  } catch (error) {
    throw refusal(error);
  }
  await sleep(EVENT_DELAY_MS);
  giveBack(front); // Enter on a button that opens a dialog: the dialog comes up in front
}

/**
 * Text posted to one window, into wherever its own cursor is (see pressIn for which control that is). A line break is
 * text in a classic or rich edit control, Enter elsewhere, and refused in a window that shows a page, where Enter sends
 * a chat message: that throws an error starting "line break:". A tab in a browser's window throws one starting "tab:".
 */
export async function typeIn(target: KeyTarget, text: string): Promise<void> {
  if (!text) return;
  const entry = keysFor(target);
  if (text.includes("\t") && isBrowserWindow(entry)) throw new Error(TAB_KEY);
  const front = frontWindow();
  try {
    native.call("chars", { hwnd: entry.hwnd, text });
  } catch (error) {
    throw refusal(error);
  }
  giveBack(front);
}

/** The helper's refusal of a line break or a tab as the tools know it, "line break: …" or "tab: …"; any other error as it was. */
function refusal(error: unknown): Error {
  const message = String((error as Error)?.message ?? error);
  const at = /\b(line break|tab): /.exec(message)?.index;
  return at === undefined ? (error as Error) : new Error(message.slice(at));
}

export async function clearField(): Promise<void> {
  await press("a", ["ctrl"]);
  await press("delete");
}

/** Wheel events go to the window under the cursor, so it is parked over the frontmost window, or the given point, first. 120 units a line. */
export async function scroll(lines: number, at?: Point, horizontal = 0): Promise<void> {
  const target = at ?? (await frontmostWindowCenter());
  const [x, y] = target ?? mouseLocation();
  await input({ kind: "wheel", x: Math.round(x), y: Math.round(y), delta: Math.round(lines * 120), horizontal: Math.round(horizontal * 120) });
}

// ------------------------------------------------------------------ apps and windows

interface WindowEntry {
  hwnd: number;
  pid: number;
  cls: string;
  title: string;
  frame: Frame; // a minimized window's is the one it goes back to
  core: number; // a UWP app's own window inside its frame, where its keys go; 0 otherwise
  cloaked?: boolean; // on another virtual desktop (a hand's own), so not on screen
  owner?: number; // the window that owns it (a dialog's, its window's); 0 for none
  enabled?: boolean; // false under a modal dialog
  iconic?: boolean; // minimized
  zoomed?: boolean; // maximized
  caption?: boolean; // has a title bar
  popup?: boolean; // a bare popup (WS_POPUP): with no title bar, a splash screen or a flyout
  exe?: string; // its process's executable, "EXCEL.EXE"
  package?: string; // its process's package family, for a packaged app
}

/** The helper's window list, front to back, the minimized ones and the ones on other virtual desktops included. */
const windowList = (): WindowEntry[] => native.call("windows") as WindowEntry[];

/** Whether a window lies on a virtual desktop other than the one on screen. */
const cloaked = (windowId: number): boolean => windowList().some((w) => w.hwnd === windowId && w.cloaked === true);

/** A window that has an owner is someone's dialog, flyout or tip; its owner is its root, as far up as that goes. */
function rootOf(entry: WindowEntry, list: WindowEntry[]): WindowEntry {
  let at = entry;
  for (let depth = 0; depth < 6 && at.owner; depth++) {
    const owner = list.find((w) => w.hwnd === at.owner);
    if (!owner) break;
    at = owner;
  }
  return at;
}

/** Whether a window is the hand's own: one it opened (the same process still behind the handle), or a dialog one of those opened. */
function isOwn(entry: WindowEntry, list: WindowEntry[]): boolean {
  const root = rootOf(entry, list);
  return own.get(root.hwnd) === root.pid || own.get(entry.hwnd) === entry.pid;
}

/**
 * The dialog a window has open, if any: when the window is disabled (a modal dialog, a message box, a file picker), the
 * enabled window it owns; when not, an owned window that is a dialog in its own right (a #32770, or one with a title
 * bar: Find, Replace), not a flyout or a tip. A dialog's own dialog is followed too.
 */
function dialogOf(entry: WindowEntry, list: WindowEntry[]): WindowEntry | null {
  let found: WindowEntry | null = null;
  for (let at = entry, depth = 0; depth < 4; depth++) {
    const owned = list.filter((w) => w.owner === at.hwnd && !w.iconic && w.enabled !== false && !POPUP_CLASSES.has(w.cls));
    const next = at.enabled === false ? owned[0] : owned.find((w) => w.cls === "#32770" || w.caption === true);
    if (!next) break;
    found = at = next;
  }
  return found;
}

// ------------------------------------------------------------------ the hand's windows, and its own desktop

// A hand's windows lie behind the user's, on the desktop on screen: sunk as they open, and sunk again whenever one
// climbs (a Chrome window after its first read, Notepad on a press: measured), for as long as the hand is at work.
//
// With HANDS_DESKTOP=1 each hand works on a virtual desktop of its own instead, so nothing it opens lands among the
// user's windows. That goes through interfaces Windows does not document, which differ from build to build; the
// first time they fail, desktops are off for the rest of the run. The desktop is made on first use and removed as
// the hand is released. Not every window works there. A UWP app (Calculator, hosted by ApplicationFrameHost) is
// frozen by Windows on a desktop that is not shown: its tree keeps 13 of its 58 labelled nodes, the frame's, and its
// picture stops changing (measured); Chrome without --disable-features=CalculateNativeWinOcclusion stops drawing. So a
// window is tried on the desktop and probed once, and one the desktop does not work for is grounded: brought back,
// sunk behind the user's windows, and neither it nor any other window of that app (by exe) is sent again for the rest
// of the run. The user hears of it once.

/** The name the desktop goes by: "Hands: Lefty". */
export const desktopName = (): string => `Hands: ${process.env.HANDS_NAME || "Hands"}`;
const DESKTOP_PREFIX = "Hands: ";

let desktopsBroken = false; // the shell's desktop interfaces failed once: this build's are not the ones vendored, or Explorer is gone

/** Whether hands work on desktops of their own: asked for with HANDS_DESKTOP=1, and working on this PC. */
export const desktopsEnabled = (): boolean => process.env.HANDS_DESKTOP === "1" && !desktopsBroken;

const RESEND_LIMIT = 3; // re-sends of one window by keepOnDesktop before the desktop is taken to be fighting us
const FEW_LABELS = 3; // labelled nodes a tree needs before it can tell the probe anything
const FEW_COLOURS = 4; // distinct colours a black frame stays under, for a helper that does not judge blankness itself
const PROBE_MS = 400; // how long the shell takes to freeze a window it will freeze, after the move
const WATCH_MS = 1000;
const AWAKE_MS = 20_000; // the watcher keeps a hand's windows down only this long after the hand last did anything
const FRONT_MS = 10_000; // and leaves one alone this long after the user last had it in front

let desktopMade = false;
const sent = new Map<number, { app: string; pid: number; resent: number }>(); // the windows this hand moved to its desktop (the pid tells a reused handle from the window), and how often each was put back
const grounded = new Set<string>(); // apps, by exe, whose windows stay on the desktop on screen from here on
const own = new Map<number, number>(); // the windows this hand opened, each with its pid (the shell reuses handles), on its desktop or behind the user's: what it works in when its app has windows of the user's too
const opened = new Set<number>(); // the processes this hand has opened a window in: there, it works in its own windows or none, never the user's
const browserWindows = new Map<number, number>(); // the browser windows this hand opened, with their pid: closed when it is released
const inFront = new Map<number, number>(); // when each of the hand's windows was last seen in front, which is the user's doing
let groundedNote: string | null = null; // for the model, once, the first time an app it opens is grounded
let watcher: ReturnType<typeof setInterval> | null = null; // keeps the hand's windows where they belong while it thinks, once it has any
let watching = false; // the watcher is making its round: its calls are not the hand's doing

/**
 * Whether a window lies on the hand's desktop, by the shell's account, which a send changes at once (measured). Not
 * the cloak: a window on the hand's desktop is uncloaked while the user has switched there to watch. A window that is
 * gone is on no desktop (the shell has no view for it and says so), and neither is any window when the desktop is gone.
 */
function onDesktop(windowId: number): boolean {
  try {
    return (native.call("onDesktop", { hwnd: windowId, name: desktopName() }) as { on: boolean }).on;
  } catch {
    return false;
  }
}

/** What the model is told the first time an app it opens is grounded in this run, or null. Reading it clears it. */
export function desktopNote(): string | null {
  const note = groundedNote;
  groundedNote = null;
  return note;
}

/** Labelled nodes in a window's tree, from a short walk: what a window that works has more than a few of, and a frozen one loses most of. */
function labelled(windowId: number): number {
  const reply = native.call("tree", { hwnd: windowId, cap: 200, ms: 300 }) as { nodes: { label: string }[] };
  return reply.nodes.filter((n) => n.label).length;
}

/**
 * Whether a window works on the hand's desktop: it is there, its picture shows something, and its tree kept at
 * least half the labels it had before the move (a frozen Calculator keeps its frame's 13 of 58, and its last
 * picture: measured). An error from the helper (the window went away under it) is a no.
 */
function working(windowId: number, labelsBefore: number): boolean {
  try {
    if (!onDesktop(windowId)) return false;
    const picture = native.call("colours", { hwnd: windowId, cap: FEW_COLOURS + 1 }) as { colours: number; blank?: boolean };
    if (picture.blank ?? picture.colours <= FEW_COLOURS) return false;
    return labelsBefore < FEW_LABELS || labelled(windowId) >= Math.max(FEW_LABELS, labelsBefore / 2);
  } catch {
    return false;
  }
}

/**
 * Keep an app on the desktop on screen for the rest of the run: its window, when it is still there (the same window:
 * the shell reuses handles), comes back from the hand's desktop and goes behind the user's windows, and no window of
 * the app is sent or kept there again. True the first time, with a line for the log; after that, quietly. Nothing
 * here throws: the callers sit in finally blocks.
 */
function ground(app: string, windowId: number, pid: number, why: string): boolean {
  sent.delete(windowId);
  const entry = windowList().find((w) => w.hwnd === windowId && w.pid === pid);
  try {
    if (entry?.cloaked) native.call("recall", { hwnd: windowId }); // uncloaked, it is already on the desktop on screen
    if (entry) native.call("sink", { hwnd: windowId });
  } catch {
    // the window closed as it was being put back: nothing left to place
  }
  const key = appKey(app);
  if (grounded.has(key)) return false;
  grounded.add(key);
  console.error(`${app} stays on the desktop on screen: ${why}`);
  return true;
}

/**
 * Move a window to the hand's desktop, making the desktop first, and see that it works there: null, or why it does
 * not. When the desktop cannot be made, the shell's interfaces do not work on this PC, and desktops are off from here.
 */
async function probe(windowId: number): Promise<string | null> {
  const before = labelled(windowId);
  const name = desktopName();
  if (!desktopMade) {
    try {
      native.call("desktop", { name });
    } catch (error) {
      desktopsBroken = true;
      console.error(`virtual desktops are off for this run: ${(error as Error).message}`);
      return "the shell's desktops do not work on this PC";
    }
    desktopMade = true;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      native.call("send", { hwnd: windowId, name });
    } catch (error) {
      return `the shell would not take it: ${(error as Error).message}`; // the window closed, or the desktop is gone
    }
    await sleep(attempt === 0 ? 50 : 300); // a window still opening can take a second try
    if (onDesktop(windowId)) break;
  }
  await sleep(PROBE_MS);
  return working(windowId, before) ? null : "its window went blank or lost its tree on the hand's desktop, or closed as it was moved";
}

/**
 * Move a window this hand opened to its desktop and see that it works there. False when desktops are off, the app is
 * grounded, or the probe grounds it now: the window then lies behind the user's windows, and the model hears of it.
 */
async function sendToDesktop(windowId: number, pid: number, app: string): Promise<boolean> {
  if (!desktopsEnabled() || grounded.has(appKey(app))) {
    native.call("sink", { hwnd: windowId }); // shown without activation, but that can still be on top of the user's windows
    return false;
  }
  // The fast path for what is known not to work; the probe catches the rest.
  const uwp = windowList().some((w) => w.hwnd === windowId && w.cls === "ApplicationFrameWindow");
  const why = uwp ? "a UWP app freezes on a desktop that is not shown" : await probe(windowId);
  if (why === null) {
    sent.set(windowId, { app, pid, resent: 0 }); // from here on it is kept there
    return true;
  }
  if (desktopsBroken) {
    native.call("sink", { hwnd: windowId }); // never sent: the desktops are off, which is no fault of the app's
    return false;
  }
  // Only here does the model hear of it, on the result of the open that grounded the app: a grounding later in the run (keepOnDesktop) goes to the log alone.
  if (ground(app, windowId, pid, why)) groundedNote = `${app} cannot work on a desktop of its own, so it stays behind your windows.`;
  return false;
}

/**
 * Put back any window of the hand's that the shell has brought onto the desktop on screen: an app that activates
 * itself on an accessibility action (Notepad on "Add New Tab", measured) is moved there by Windows. Asked after each
 * such action and before each capture; one window list when nothing has moved. A window that keeps coming back is
 * grounded instead of sent a fourth time: the desktop is fighting us. So is one the shell will not take back.
 *
 * A window the user has in front is theirs to look at, and so for a while after: one they brought forward, or one
 * the panel presented to them, is neither sunk nor sent back until they have left it alone for FRONT_MS, and one
 * that left the hand's desktop that way stays on theirs. A minimized window stays where the user put it. But one that
 * came in front with no input from the user since it was last seen behind (an app that brings itself forward late:
 * Excel as its add-ins load, a dialog after a slow operation) did not come by their doing: the window they had in
 * front gets the keyboard back, and the hand's goes behind theirs.
 */
function keepOnDesktop(): void {
  if (sent.size === 0 && own.size === 0) return;
  const list = windowList();
  const now = performance.now();
  let front = (native.call("foreground") as { hwnd: number }).hwnd;
  if (takeBack(front, list)) front = 0; // it came up by itself after an action, and is behind the user's windows again
  const frontEntry = list.find((w) => w.hwnd === front);
  const frontRoot = frontEntry && rootOf(frontEntry, list);
  let sunk = 0;
  if (frontRoot && isOwn(frontRoot, list) && cameByItself(frontRoot.hwnd, now)) {
    if (userFront && list.some((w) => w.hwnd === userFront)) native.call("activate", { hwnd: userFront });
    native.call("sink", { hwnd: (sunk = frontRoot.hwnd) });
    front = 0;
  } else if (frontRoot) {
    inFront.set(frontRoot.hwnd, now);
    if (!isOwn(frontRoot, list)) userFront = frontRoot.hwnd;
  }
  const shown = front ? frontRoot?.hwnd : undefined;
  for (const windowId of own.keys()) if (windowId !== shown) seenBehind.set(windowId, now);
  const theirs = (windowId: number) => windowId === front || now - (inFront.get(windowId) ?? -Infinity) < FRONT_MS;
  for (const [windowId, entry] of sent) {
    const window = list.find((w) => w.hwnd === windowId);
    if (!window || window.pid !== entry.pid) sent.delete(windowId); // gone, or its handle is another window's now
    else if (onDesktop(windowId)) continue;
    else if (theirs(windowId)) sent.delete(windowId); // the user has it on their desktop now, and it stays there
    else if (++entry.resent > RESEND_LIMIT) ground(entry.app, windowId, entry.pid, `the shell brought its window back ${entry.resent} times`);
    else {
      try {
        native.call("send", { hwnd: windowId, name: desktopName() });
      } catch (error) {
        ground(entry.app, windowId, entry.pid, `the shell would not take it back: ${(error as Error).message}`);
      }
    }
  }
  // A window of the hand's on the desktop on screen (grounded, or desktops off) is put behind the user's windows again
  // each time: a Chrome window climbs to the top after its first read, and Notepad on a press (both measured).
  for (const [windowId, pid] of own) {
    const at = list.findIndex((w) => w.hwnd === windowId);
    if (at < 0 || list[at]!.pid !== pid) own.delete(windowId); // gone, or its handle is another window's now
    else if (sent.has(windowId) || list[at]!.cloaked || list[at]!.iconic || theirs(windowId) || windowId === sunk) continue;
    // A window that is not the hand's lies behind it: it has climbed. Judged by the window, not the process: the
    // user's own Chrome windows are the same process as the hand's.
    else if (list.slice(at + 1).some((w) => !w.cloaked && !w.iconic && own.get(w.hwnd) !== w.pid)) native.call("sink", { hwnd: windowId });
  }
}

const SEEN_MS = 3 * WATCH_MS; // a window last seen behind longer ago than this may have been brought forward by anyone since
const seenBehind = new Map<number, number>(); // when each window of the hand's was last seen not in front
let userFront = 0; // the window of the user's last seen in front, which gets the keyboard back from a window that took it by itself

/**
 * Whether a window of the hand's in front came there by itself: it was seen behind a moment ago, the user has not had
 * it in front lately, and they have touched neither the mouse nor the keyboard since (a click on it, on its taskbar
 * button, or alt+tab would have been input). When the helper cannot say, it was the user's doing.
 */
function cameByItself(windowId: number, now: number): boolean {
  const behind = seenBehind.get(windowId);
  if (behind === undefined || now - behind > SEEN_MS || now - (inFront.get(windowId) ?? -Infinity) < FRONT_MS) return false;
  try {
    return idle().idleMs >= now - behind;
  } catch {
    return false;
  }
}

/**
 * From the first window of its own, the hand looks once a second, between actions too: a Chrome window climbed four
 * seconds after it was sunk, with the hand idle (measured). Only while the hand is at work, though: AWAKE_MS after it
 * last did anything, the watcher leaves the windows be, and a finished hand's windows are the user's to arrange. It still
 * looks for a link of the user's landing in a browser window of the hand's (watchLinks), which can happen at any time. Not
 * under test, where the helper is a script.
 */
function watchOwn(): void {
  if (watcher || process.env.NODE_ENV === "test") return;
  watcher = setInterval(() => {
    if (borrowed !== null || guarding) return; // in the middle of a borrow or a guarded click, which put their window back themselves
    watching = true;
    try {
      watchLinks(); // asleep or not: a link of the user's can land in a browser window of the hand's at any time
      if (performance.now() - lastCall > AWAKE_MS) return; // asleep: the rest is left be
      keepOnDesktop();
    } catch {
      // the helper is busy or gone: the next action looks again
    } finally {
      watching = false;
    }
  }, WATCH_MS);
  watcher.unref();
}

/** A window the hand opened, from now on its own to work in and keep behind the user's windows. */
function adopt(windowId: number, pid: number): void {
  own.set(windowId, pid);
  opened.add(pid);
  watchOwn();
}

/** The names of every virtual desktop, in order. */
export const desktops = (): string[] => native.call("desktops") as string[];

/** Remove a desktop by name; Windows moves what is left on it to the current desktop. A desktop that is not there is nothing to do. */
export function removeDesktop(name: string = desktopName()): void {
  try {
    native.call("removeDesktop", { name });
  } catch {
    // the desktop is already gone, or the shell would not part with it: nothing more to do at exit
  }
}

/**
 * Leave the hand's desktop, and forget what the run learnt. The windows still on the desktop are brought to the one on
 * screen and put behind the user's windows first (removing the desktop alone would drop them over the user's), and
 * then the desktop goes. Nothing here throws.
 */
export function releaseDesktop(): void {
  if (watcher) clearInterval(watcher);
  watcher = null;
  if (desktopMade) {
    desktopMade = false;
    try {
      const list = windowList();
      for (const [windowId, entry] of sent) {
        if (!list.some((w) => w.hwnd === windowId && w.pid === entry.pid)) continue;
        native.call("recall", { hwnd: windowId });
        native.call("sink", { hwnd: windowId });
      }
    } catch {
      // the shell or a window went away: the removal below brings back whatever is left
    }
    removeDesktop();
  }
  sent.clear();
  grounded.clear();
  own.clear();
  opened.clear();
  browserWindows.clear();
  inFront.clear();
  primed.clear();
  unlifted.clear();
  stale.clear();
  parked.clear();
  tabsSeen.clear();
  touchedAt.clear();
  unsettled.clear();
  frontBefore = 0;
  givenUp.clear();
  seenBehind.clear();
  popups.length = 0;
  userFront = 0;
  occlusion.clear(); // asked again next run: a browser restarted since may run another way
  groundedNote = null;
  desktopsBroken = false;
}

/** The names an app goes by and the executable behind each. */
const EXES: Record<string, string> = {
  "google chrome": "chrome.exe", chrome: "chrome.exe", "microsoft edge": "msedge.exe", edge: "msedge.exe", calculator: "CalculatorApp.exe",
  notepad: "Notepad.exe", paint: "mspaint.exe", "windows terminal": "WindowsTerminal.exe", explorer: "explorer.exe", "file explorer": "explorer.exe",
  word: "WINWORD.EXE", "microsoft word": "WINWORD.EXE", excel: "EXCEL.EXE", "microsoft excel": "EXCEL.EXE", powerpoint: "POWERPNT.EXE",
  "microsoft powerpoint": "POWERPNT.EXE", settings: "SystemSettings.exe", "windows settings": "SystemSettings.exe",
}; // prettier-ignore
/** What ShellExecute is handed to start an app, where it differs from the process that then runs. */
const LAUNCHERS: Record<string, string> = { "CalculatorApp.exe": "calc.exe", "Notepad.exe": "notepad.exe", "SystemSettings.exe": "ms-settings:" };
const NAMES: Record<string, string> = { chrome: "Google Chrome", msedge: "Microsoft Edge" };
const isBrowserApp = (app: string): boolean => Boolean(NAMES[basename(exeOf(app), ".exe").toLowerCase()]);

interface AppSpec {
  file: string; // what ShellExecute is handed
  exe: string | null; // the executable its window belongs to, when that is known ahead
  package: string | null; // a packaged app's package family, from its AppID
  dialogs?: boolean; // its main window may be a dialog (a control panel item)
}

/**
 * What starting an app by the name the model gave means. A name the port knows is its executable; a URI
 * ("ms-settings:display") and a packaged app's AppID ("Claude_pzs8sxrjxfjjc!Claude", started through the shell's apps
 * folder) go to the shell as they are; a shortcut, control panel item or console is opened as the file it is; a path
 * to an executable, or a bare name, is that executable. A drive letter is not a URI scheme.
 */
export function appSpec(app: string): AppSpec {
  const known = EXES[app.toLowerCase()];
  if (known) return { file: LAUNCHERS[known] ?? known, exe: known, package: null };
  if (/^[^\\/:!\s]+![^\\/!]+$/.test(app)) return { file: `shell:AppsFolder\\${app}`, exe: null, package: app.split("!")[0]! };
  if (/^[a-z][a-z0-9+.-]+:/i.test(app)) {
    const id = /^shell:appsfolder\\(.+)$/i.exec(app)?.[1];
    return { file: app, exe: /^ms-settings:/i.test(app) ? "SystemSettings.exe" : null, package: id?.includes("!") ? id.split("!")[0]! : null };
  }
  const ext = extname(app).toLowerCase();
  if (ext === ".lnk") return { file: app, exe: null, package: null };
  if (ext === ".msc") return { file: app, exe: "mmc.exe", package: null };
  if (ext === ".cpl") return { file: app, exe: "rundll32.exe", package: null, dialogs: true };
  return { file: ext === ".exe" ? app : `${app}.exe`, exe: basename(ext === ".exe" ? app : `${app}.exe`), package: null };
}

/** The executable an app runs as, by file name, or "" when that is not known ahead (a URI, an AppID, a shortcut). */
const exeOf = (app: string): string => appSpec(app).exe ?? "";

/** What an app is remembered by (grounded, reused): its executable, or what starts it. */
const appKey = (app: string): string => {
  const spec = appSpec(app);
  return (spec.exe ?? spec.package ?? spec.file).toLowerCase();
};

/** Whether a window is of an app: its process runs that executable, or is of that package. */
const ofApp = (w: WindowEntry, spec: AppSpec): boolean =>
  (spec.exe !== null && w.exe?.toLowerCase() === spec.exe.toLowerCase()) || (spec.package !== null && w.package === spec.package);

/** The browser's executable: HANDS_BROWSER_PATH, or the usual install locations. */
function browserPath(exe: string): string {
  if (process.env.HANDS_BROWSER_PATH) return process.env.HANDS_BROWSER_PATH;
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const inside = { "chrome.exe": "Google\\Chrome\\Application\\chrome.exe", "msedge.exe": "Microsoft\\Edge\\Application\\msedge.exe" }[exe];
  const found = inside && roots.map((root) => join(root, inside)).find((path) => existsSync(path));
  return found ?? exe;
}

/** The name the workspace knows a process by: its executable's, but "Google Chrome" and "Microsoft Edge" as config.browser() spells them. */
const names = new Map<number, string>();
export function appName(pid: number): string {
  const known = names.get(pid);
  if (known !== undefined) return known;
  const { name } = native.call("exe", { pid }) as { name: string };
  const app = NAMES[name.toLowerCase()] ?? name;
  if (app) names.set(pid, app);
  return app;
}

export async function frontmostAppAndPid(): Promise<[string, number]> {
  const { pid } = native.call("foreground") as { pid: number };
  return [pid ? appName(pid) : "", pid];
}

export const frontmostApp = async (): Promise<string> => (await frontmostAppAndPid())[0];
export const frontmostPid = async (): Promise<number> => (await frontmostAppAndPid())[1];

// An app can run twice: the user's own, and one that automation started with a profile of its own. The user's instance
// is found by its command line and then only ever addressed by pid. HANDS_BROWSER_PROFILE names a profile of the hands'
// own that counts as the user's: how a test drives a browser of its own without touching theirs.
const AUTOMATION_FLAGS = /--(user-data-dir|headless|remote-debugging-(port|pipe))\b/;
const userPids = new Map<string, number>();

/** The pid of the app as the user runs it, or null when only automation's instances, or none, are up. */
export async function userInstance(app: string): Promise<number | null> {
  const known = userPids.get(app);
  if (known !== undefined) {
    try {
      process.kill(known, 0); // still running
      return known;
    } catch {
      userPids.delete(app);
    }
  }
  const mine = (await appInstances(app)).find((instance) => !instance.automated);
  if (mine) userPids.set(app, mine.pid);
  return mine?.pid ?? null;
}

/** Main processes of an app, by executable name, with their command lines. A browser's renderers carry --type=, and are not instances. */
async function instances(app: string): Promise<{ pid: number; cmd: string; automated: boolean }[]> {
  const own = process.env.HANDS_BROWSER_PROFILE;
  const exe = exeOf(app);
  if (!exe) return []; // started by a URI or an AppID: which process it becomes is not known ahead
  return (native.call("processes", { exe }) as { pid: number; cmd: string }[])
    .filter(({ cmd }) => !/\s--type=/.test(cmd))
    .map(({ pid, cmd }) => ({ pid, cmd, automated: own === undefined ? AUTOMATION_FLAGS.test(cmd) : !cmd.includes(own) }));
}

/** Main processes of an app, by executable name. */
export async function appInstances(app: string): Promise<{ pid: number; automated: boolean }[]> {
  return (await instances(app)).map(({ pid, automated }) => ({ pid, automated }));
}

/** The Chromium feature that stops a browser painting a window it thinks nobody can see. */
export const OCCLUSION_FEATURE = "CalculateNativeWinOcclusion";

/** Whether a browser's command line, or the Chrome policy, has its native window occlusion tracking off. */
export function unoccludedBy(cmd: string, policy: string | null): boolean {
  const features = cmd.match(/--disable-features=("[^"]*"|\S+)/g) ?? [];
  if (features.some((flag) => new RegExp(`\\b${OCCLUSION_FEATURE}\\b`).test(flag))) return true;
  return policy !== null && Number(policy) === 0;
}

const occlusion = new Map<number, boolean>(); // by the user's instance's pid: a command line does not change while it runs

/**
 * Whether the user's browser keeps working out of sight. Chrome treats a window on another virtual desktop as
 * occluded: it stops painting it and never builds its page's accessibility tree until the window has shown once.
 * Started with --disable-features=CalculateNativeWinOcclusion (or the NativeWindowOcclusionEnabled policy set to 0)
 * it does neither, and a hand's window can live on the hand's desktop. False when the browser is not running.
 */
export async function browserUnoccluded(browser: string): Promise<boolean> {
  const pid = await userInstance(browser);
  if (pid === null) return false;
  const known = occlusion.get(pid);
  if (known !== undefined) return known;
  const mine = (await instances(browser)).find((instance) => instance.pid === pid);
  if (!mine) return false;
  const vendor = exeOf(browser) === "msedge.exe" ? "Microsoft\\Edge" : "Google\\Chrome";
  const policy = (native.call("reg", { key: `Software\\Policies\\${vendor}`, name: "NativeWindowOcclusionEnabled" }) as { value: string | null }).value;
  const answer = unoccludedBy(mine.cmd, policy);
  occlusion.set(pid, answer);
  return answer;
}

// ------------------------------------------------------------------ locks every hand on the machine shares

/** Where the machine-wide locks live: %TEMP%. A test points it at a folder of its own. */
export const locks = { root: tmpdir() };
const OPEN_LOCK = "hands-open-window.lock"; // held while a window is opened and told from the rest by not having been there before
export const SEAT_LOCK = "hands-seat.lock"; // held while a hand borrows the mouse and keyboard (src/windows-seat.ts)
const LOCK_STALE_MS = 30_000;

/** Whether a lock's holder is gone: its process has ended, or it has shown no sign of life for `staleMs`. */
function staleLock(path: string, staleMs: number): boolean {
  const owner = join(path, "owner");
  const stat = statSync(owner, { throwIfNoEntry: false }) ?? statSync(path, { throwIfNoEntry: false });
  if (!stat) return false; // released meanwhile: the next try takes it
  const quiet = Date.now() - stat.mtimeMs;
  if (quiet > staleMs) return true;
  let pid: number;
  try {
    pid = Number(readFileSync(owner, "utf8"));
  } catch {
    return quiet > 2000; // its owner is still writing its pid, unless it died doing so
  }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0); // still running
    return false;
  } catch {
    return true;
  }
}

/** One try at a lock: the function that releases it, or null when another holds it. A stale one is cleared and tried again. */
function tryLock(name: string, staleMs: number): (() => void) | null {
  const path = join(locks.root, name);
  for (let tries = 0; tries < 3; tries++) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, "owner"), String(process.pid));
      return () => {
        try {
          if (readFileSync(join(path, "owner"), "utf8") === String(process.pid)) rmSync(path, { recursive: true, force: true });
        } catch {
          // taken over as stale, or already gone: not ours to remove
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") mkdirSync(locks.root, { recursive: true });
      else if (!staleLock(path, staleMs)) return null;
      else {
        const aside = `${path}.${process.pid}.stale`;
        try {
          renameSync(path, aside); // only one of several waiters gets to move it
          rmSync(aside, { recursive: true, force: true });
        } catch {
          // another waiter took it first
        }
      }
    }
  }
  return null;
}

/**
 * A lock every hand on this machine shares: a directory in %TEMP% holding its owner's pid. One whose owner has ended,
 * or that has shown no sign of life for `staleMs` (see holdLock), is taken over. Waits until `until` (performance.now()),
 * telling `onWait` at each round; the function that releases it, or null when the time ran out.
 */
export async function takeLock(name: string, until: number, onWait?: () => void, staleMs = LOCK_STALE_MS): Promise<(() => void) | null> {
  for (;;) {
    const release = tryLock(name, staleMs);
    if (release) return release;
    if (performance.now() >= until) return null;
    onWait?.();
    await sleep(100);
  }
}

/** A sign of life from a lock's holder, so that a long hold is not taken for a dead one. */
function holdLock(name: string): void {
  const owner = join(locks.root, name, "owner");
  try {
    utimesSync(owner, new Date(), new Date());
  } catch {
    // not held: nothing to keep fresh
  }
}

/** `work` under a lock; after `waitMs` without it, anyway: a hand that holds it that long has hung, and the lock goes stale soon. */
async function withLock<T>(name: string, work: () => Promise<T>, waitMs = 20_000): Promise<T> {
  const release = await takeLock(name, performance.now() + waitMs);
  try {
    return await work();
  } finally {
    release?.();
  }
}

// ------------------------------------------------------------------ the seat: the user's mouse and keyboard

/** What the helper says of the seat (Seat.Idle in windows.cs). */
export interface Idle {
  idleMs: number; // since the user last touched the mouse or keyboard, input the helper sent itself aside
  held: string[]; // the modifiers and mouse buttons they are holding
  quiet: boolean; // not away, and not in a full-screen app, a game or a presentation
  tick: number; // the helper's clock when it was asked, which is what a borrow is timed from
}

export const idle = (): Idle => native.call("idle") as Idle;

/** Whether the user has left the seat alone for `quietMs`, holds nothing, and is not in something full screen. */
export const paused = (seat: Idle, quietMs: number): boolean => seat.idleMs >= quietMs && seat.held.length === 0 && seat.quiet;

const SEAT_POLL_MS = 50;
const FLASH_QUIET_MS = 400; // the pause a guarded click waits for: short, since nothing is sent into the seat
const FLASH_WAIT_MS = 20_000;
const FLASH_TELL_MS = 1500; // a guarded click's wait this long is worth showing on the hand and its card (hooks.onSeatWait)
// A press or a value cannot wait asynchronously, and the hand reads nothing (a stop, a close) while it waits: it gives
// up soon, well inside the time a close is given before the hand is killed (src/live.ts), and the tools fall back.
const FLASH_WAIT_SYNC_MS = 1500;
const MENU_QUIET_MS = 1500; // an open menu holds its app's keyboard as a borrow does: it waits for the pause a borrow does (src/windows-seat.ts)
const LIFT_WAIT_MS = 300; // a page's first read waits this little for a pause to lift its window in, and is read without the lift otherwise

/** Why the user was not paused, as a SeatBusy says it: another hand held the seat's lock, or what the helper said of the seat. */
export const busyReason = (seat: Idle, locked: boolean): string =>
  locked
    ? "another hand had the mouse and keyboard all this time"
    : seat.held.length > 0
      ? `the user was holding ${seat.held[0]}`
      : !seat.quiet
        ? "a full-screen app or a presentation was up"
        : "the user kept using the mouse or keyboard";

/**
 * Wait until the user has left the seat alone for `quietMs` with nothing held, and no other hand holds the seat's lock,
 * then take the lock: the function that releases it, and what the helper said of the seat then (a borrow is timed from
 * its tick). The lock is taken only once the user has paused, so that it stands for the moment the seat is used and no
 * longer: the panel lets every click through while it is held (src/panel.cs), which must not happen while the user is
 * still at work on it. `onWait` hears each round of waiting. Abort as soon as the hand is stopped (checkStopped); when
 * `until` (performance.now()) comes first, SeatBusy saying why and that `what` did not happen.
 */
export async function whenPaused(quietMs: number, until: number, what: string, onWait?: () => void): Promise<{ release: () => void; seat: Idle }> {
  for (;;) {
    const taken = pausedNow(quietMs);
    if (taken.release) return { release: taken.release, seat: taken.seat };
    if (performance.now() >= until) throw new SeatBusy(`${busyReason(taken.seat, taken.locked)}, so ${what} did not happen`);
    onWait?.();
    await sleep(SEAT_POLL_MS);
  }
}

/** whenPaused for a caller that cannot wait asynchronously: the process sleeps between rounds, and reads nothing meanwhile. */
function whenPausedSync(quietMs: number, until: number, what: string): () => void {
  for (;;) {
    const taken = pausedNow(quietMs);
    if (taken.release) return taken.release;
    if (performance.now() >= until) throw new SeatBusy(`${busyReason(taken.seat, taken.locked)}, so ${what} did not happen`);
    Bun.sleepSync(SEAT_POLL_MS);
  }
}

/** One round of whenPaused: the seat's lock when the user has paused and it is free, and what stood in the way when not. */
function pausedNow(quietMs: number): { release: (() => void) | null; seat: Idle; locked: boolean } {
  checkStopped();
  const seat = idle();
  if (!paused(seat, quietMs)) return { release: null, seat, locked: false };
  const release = ownLinger() ?? tryLock(SEAT_LOCK, LOCK_STALE_MS);
  if (release && interrupted) {
    release();
    checkStopped();
  }
  return { release, seat, locked: release === null };
}

/**
 * A click into a Chromium window of the hand's brings that window forward for about 70 ms (see Flash in windows.cs).
 * So such clicks go one at a time across the hands (the seat's lock), and only once the user has paused a moment with
 * nothing held, so that the moment the window is in front cannot catch their typing or their click. A wait long enough
 * to notice is shown on the hand and its card (hooks.onSeatWait). SeatBusy when they never pause; Abort when the hand
 * is stopped meanwhile. During a borrow the window is in front already, and the click is simply made.
 */
async function flashing<T>(work: () => Promise<T>, why = "clicking in the page"): Promise<T> {
  if (borrowed !== null) return work();
  const started = performance.now();
  let told = false;
  const waiting = () => {
    if (told || performance.now() - started < FLASH_TELL_MS) return;
    told = true;
    hooks.onSeatWait?.("waiting", why);
  };
  let release: () => void;
  try {
    ({ release } = await whenPaused(FLASH_QUIET_MS, started + FLASH_WAIT_MS, "the click", waiting));
  } finally {
    if (told) hooks.onSeatWait?.("free", why);
  }
  try {
    return await work();
  } finally {
    linger(release);
  }
}

/**
 * flashing, for what the platform makes synchronous (a press, a value, a menu, a first read): the user's pause for
 * `quietMs` under the seat's lock, waited for `waitMs` at most, then SeatBusy. Abort when the hand was stopped. A
 * guarded click (`guarded`) keeps the lock a moment past its answer, as flashing does.
 */
function pausedSync<T>(work: () => T, what: string, quietMs = FLASH_QUIET_MS, waitMs = FLASH_WAIT_SYNC_MS, guarded = false): T {
  if (borrowed !== null) return work();
  const release = whenPausedSync(quietMs, performance.now() + waitMs, what);
  try {
    return work();
  } finally {
    if (guarded) linger(release);
    else release();
  }
}

// The helper answers a guarded click as soon as nothing has taken the foreground from it for a moment, and watches the
// rest of the moment behind its answer (Flash in windows.cs): the seat's lock is kept that much longer, so that no other
// hand's click or borrow begins while that watch may still give the foreground back. This hand's own next use of the
// seat takes the lock over (ownLinger) rather than waiting for itself.
const LINGER_MS = 600;
let lingering: { path: string; release: () => void; timer: ReturnType<typeof setTimeout> } | null = null;

/** Let the seat's lock go LINGER_MS from now, unless this hand uses the seat again first. */
function linger(release: () => void): void {
  endLinger();
  const timer = setTimeout(() => {
    if (lingering?.timer !== timer) return;
    lingering = null;
    release();
  }, LINGER_MS);
  timer.unref?.();
  lingering = { path: join(locks.root, SEAT_LOCK), release, timer };
}

/** The seat's lock this hand still holds from its last guarded click, taken over for its next use of the seat; null when there is none. */
function ownLinger(): (() => void) | null {
  if (!lingering || lingering.path !== join(locks.root, SEAT_LOCK)) return null;
  const { release, timer } = lingering;
  clearTimeout(timer);
  lingering = null;
  return release;
}

/** The lingering lock let go now: the hand is ending, or another click keeps its own. */
function endLinger(): void {
  const release = lingering ? (clearTimeout(lingering.timer), lingering.release) : null;
  lingering = null;
  release?.();
}

let guarding = false; // a guarded click is under way: the window it brings forward for a moment is not the user's doing
const popups: number[] = []; // windows the hand's guarded clicks opened, since the tools last asked (popupsOpened)

/**
 * The windows a click in a window of the hand's opened since the last ask (a page's pop-up, a sign-in), which are the
 * hand's from then on: kept behind the user's windows (or off the screens with the window that opened them), and
 * closed with its browser windows. Reading them clears them.
 */
export function popupsOpened(): number[] {
  return popups.splice(0);
}

/**
 * A posted click or drag into a window: guarded (see flashing) when the window is Chromium's, the helper watching the
 * moment after it and handing the foreground back; a window of the hand's own also goes back behind the user's, and a
 * window its click opened becomes the hand's. When the helper could not hand the foreground back, it is asked once
 * more from here, and the window is left where the user can see it rather than behind everything with their keys.
 */
async function guarded<T>(hwnd: number, web: boolean, work: () => Promise<T>): Promise<T> {
  if (!web) return work();
  refuseTheirs(hwnd);
  const list = windowList();
  const entry = list.find((w) => w.hwnd === hwnd);
  const sink = entry !== undefined && isOwn(entry, list);
  return flashing(async () => {
    const front = frontWindow();
    native.call("guard", { begin: true, hwnd, sink });
    guarding = true;
    try {
      return await work();
    } finally {
      try {
        const ended = native.call("guard", { hwnd, sink }) as { back?: boolean; popups?: number[] };
        if (ended.back === false && front && (native.call("activate", { hwnd: front }) as { ok?: boolean }).ok && sink) native.call("sink", { hwnd });
        if (sink) adoptPopups(ended.popups ?? [], parked.has(hwnd)); // a window the user's own page opens is theirs
      } finally {
        guarding = false;
        touch(hwnd); // a tab the click opens is the hand's, however long the wait for the user to pause was
      }
    }
  });
}

/**
 * Windows a click in a page of the hand's opened: the hand's from now on, kept where its browser windows are kept (off
 * the screens with them, or behind the user's), and closed with them. The tools hear of them (popupsOpened).
 */
function adoptPopups(opened: number[], offScreen: boolean): void {
  if (opened.length === 0) return;
  const list = windowList();
  for (const popup of opened) {
    const entry = list.find((w) => w.hwnd === popup);
    if (!entry) continue; // closed again already
    adopt(popup, entry.pid);
    browserWindows.set(popup, entry.pid);
    if (offScreen) park(popup);
    else native.call("sink", { hwnd: popup });
    popups.push(popup);
  }
}

const HANDBACK_MS = 2000; // how long after an action a window of the hand's that comes up in front is taken to have done so by itself
let handBack: { to: number; until: number } | null = null; // the window the user had in front before the last action, while that holds

/**
 * After an action from behind: when it brings a window of the hand's to the front (a dialog it opened comes up in
 * front, and takes its owner with it; Notepad on a press: both measured), the window the user had goes back in front
 * and the hand's behind theirs, now or, for a dialog that is slower to come, at the next look or watch within
 * HANDBACK_MS. A window of the user's they brought forward meanwhile is left alone.
 */
function giveBack(front: number): void {
  if (borrowed !== null || !front) return;
  handBack = { to: front, until: performance.now() + HANDBACK_MS };
  takeBack(frontWindow());
}

/**
 * The seat handed back from a window of the hand's that `now` (the window in front) is, while an action's handback
 * holds: true when it was. While another hand borrows the seat, the foreground is that borrow's to move: the window is
 * only put behind the user's, and the borrow, which stops at a window that comes in front of its own, gives the user
 * theirs back as it ends.
 */
function takeBack(now: number, list?: WindowEntry[]): boolean {
  if (!handBack || borrowed !== null || performance.now() > handBack.until || !now || now === handBack.to) return false;
  const all = list ?? windowList();
  const entry = all.find((w) => w.hwnd === now);
  if (!entry || !isOwn(entry, all)) return false;
  const root = rootOf(entry, all);
  if (all.some((w) => w.hwnd === handBack!.to) && !seatElsewhere()) native.call("activate", { hwnd: handBack.to });
  native.call("sink", { hwnd: root.hwnd });
  inFront.delete(root.hwnd);
  return true;
}

/** Whether another hand holds the seat's lock at this moment: it is borrowing the seat, or making a guarded click. */
function seatElsewhere(): boolean {
  const owner = join(locks.root, SEAT_LOCK, "owner");
  try {
    const pid = Number(readFileSync(owner, "utf8"));
    return pid !== process.pid && !staleLock(join(locks.root, SEAT_LOCK), LOCK_STALE_MS);
  } catch {
    return false;
  }
}

/** The window in front, for giveBack; 0 when the helper cannot say. */
function frontWindow(): number {
  try {
    return (native.call("foreground") as { hwnd: number }).hwnd;
  } catch {
    return 0;
  }
}

let seatOut: object | null = null; // the borrow under way, which abandonSeat can end from outside it
let seatAbandoned: object | null = null; // a borrow abandonSeat has ended already: its own ending puts nothing back again

/**
 * The seat itself, for one piece of work in a window. src/windows-seat.ts has taken the seat's lock and waited for the
 * user to pause, until the helper's tick `since`. The window comes onto the desktop on screen, restored and in front,
 * or the borrow is off (SeatBusy, nothing done; a window that is gone is an error of its own). The work's seat input
 * then runs until the user touches anything, another window comes in front, or the hand is stopped (see input). However
 * it ends, any mouse button the work held is let go, the window the user had comes back to the front (unless they took
 * the seat back and went to another), the cursor goes back where it was (unless they have moved it), and the hand's
 * window goes behind theirs, back off the screens, or back to its desktop. The helper knows all this too, for a hand
 * that ends before the borrow does (abandonSeat, and the helper's own end).
 */
export async function borrow<T>(target: KeyTarget, since: number, work: () => Promise<T>, onHolding?: () => void): Promise<T> {
  checkStopped(); // told "not now" as the seat was taken: nothing has moved yet
  refuseTheirs(target.windowId);
  const before = frontWindow();
  const cursor = mouseLocation();
  const list = windowList();
  const entry = list.find((w) => w.hwnd === target.windowId);
  if (!entry) throw new Error("the window is gone: look again with `screen`");
  const root = rootOf(entry, list);
  const mine = isOwn(entry, list);
  const away = root.cloaked === true; // on the hand's desktop, where the seat cannot reach it
  const watched = before === target.windowId || before === root.hwnd; // the user had it in front: it stays there
  handBack = null; // the borrow brings the window forward itself, and puts everything back as it ends
  const offScreen = parked.has(root.hwnd); // the seat's pointer reaches only what lies on a screen
  const out = {};
  let taken = false;
  try {
    if (away) native.call("recall", { hwnd: root.hwnd });
    if (offScreen) unpark(root.hwnd, true);
    native.call("activate", { hwnd: target.windowId });
    const front = frontWindow();
    const shown = windowList();
    const frontEntry = shown.find((w) => w.hwnd === front);
    if (front !== target.windowId && (!frontEntry || rootOf(frontEntry, shown).hwnd !== root.hwnd)) throw new SeatBusy(`${entry.title || "the window"} would not come to the front, so nothing was done`);
    seatOut = out;
    borrowed = since;
    borrowedRoot = root.hwnd;
    try {
      native.call("seat", { state: "holding", before, x: cursor[0], y: cursor[1], root: root.hwnd, sink: mine && !watched });
    } catch {
      // the helper's copy is for a hand that ends mid-way: the borrow goes on without it
    }
    onHolding?.();
    return await work();
  } catch (error) {
    taken = error instanceof SeatTaken;
    throw error;
  } finally {
    borrowed = null;
    borrowedRoot = 0;
    touch(target.windowId); // a tab the borrowed keys opened (ctrl+t, a link's Enter) is the hand's
    if (seatAbandoned === out) seatAbandoned = null; // put back already
    else {
      if (seatOut === out) seatOut = null;
      try {
        native.call("input", { kind: "letgo" });
        // The user who took the seat back and went to a window of their own keeps it.
        let stayed = true;
        if (taken) {
          const [now, front] = [windowList(), frontWindow()];
          const frontEntry = now.find((w) => w.hwnd === front);
          stayed = frontEntry !== undefined && rootOf(frontEntry, now).hwnd === root.hwnd;
        }
        if (before && !watched && stayed && windowList().some((w) => w.hwnd === before)) native.call("activate", { hwnd: before });
        native.call("setCursor", { x: cursor[0], y: cursor[1], unlessMoved: true });
        if (mine && !watched) {
          if (away && sent.has(root.hwnd) && desktopsEnabled()) native.call("send", { hwnd: root.hwnd, name: desktopName() });
          else native.call("sink", { hwnd: root.hwnd });
          if (offScreen) park(root.hwnd);
        } else if (offScreen) unpark(root.hwnd); // the user has it in front: it stays where they can see it
        native.call("seat", { state: "free" });
      } catch {
        // the window or the shell went away mid-way: there is nothing more to put back
      }
    }
  }
}

/**
 * The hand is ending in the middle of a borrow or a guarded click (a close, an error that ends the process), whose own
 * ending will not run: what was out goes back now. The helper knows what (Hold in windows.cs): any mouse button the
 * work holds is let go, the window the user had comes back in front unless they have gone to another, their cursor
 * back unless they have moved it, and the hand's window behind theirs; the seat's lock is let go. Nothing here throws,
 * and nothing is done when nothing is out.
 */
export function abandonSeat(): void {
  endLinger();
  if (seatOut === null && !guarding) return;
  seatAbandoned = seatOut;
  seatOut = null;
  borrowed = null;
  borrowedRoot = 0;
  guarding = false;
  try {
    native.call("seat", { state: "abandon" });
  } catch {
    // the helper is gone: its own end has put everything back
  }
  const lock = join(locks.root, SEAT_LOCK);
  try {
    if (readFileSync(join(lock, "owner"), "utf8") === String(process.pid)) rmSync(lock, { recursive: true, force: true });
  } catch {
    // not held, or not ours
  }
}

// ------------------------------------------------------------------ opening a window of the hand's own

/**
 * How long an opening waits on the app: a fresh window must stay `persistMs` to be taken for its main window, not a
 * splash; the seat is watched `seatWatchMs` after a launch, since an app can take the foreground late (Excel at 1.7 s:
 * measured), and `browserWatchMs` after a browser window opens (Chrome takes it a beat after the window exists, and
 * again for a bubble). A test shortens them.
 */
export const pace = { persistMs: 300, seatWatchMs: 1500, browserWatchMs: 2500 };

/** What a launch looks for: what it started, and what the window that opens will be of. */
interface Launching {
  before: Set<number>; // every window there was before, minimized ones included
  pid: number; // the process ShellExecute started, 0 when it started none (an app already running took the request)
  exes: Set<string>; // executables, lower case, the window's process may run
  package: string | null; // the package the window's process may be of
  title: string | null; // a document's name, lower case, which its window's title carries
  dialogs?: boolean; // the app's window may be a dialog
}

/**
 * Whether a window is an app's main window: no owner, not a dialog (unless the app is one), not a popup or a tip, not a
 * UWP frame still empty nor its CoreWindow before the frame adopts it (seen on Calculator: a CoreWindow moved to a
 * desktop before its frame takes it in is never taken in, and the app freezes), and with a title bar unless it is an
 * ordinary overlapped window (a splash screen is a bare popup).
 */
const mainWindow = (w: WindowEntry, dialogs = false): boolean =>
  !w.owner && (dialogs || w.cls !== "#32770") && !POPUP_CLASSES.has(w.cls) && w.cls !== "Windows.UI.Core.CoreWindow" && (w.cls !== "ApplicationFrameWindow" || w.core !== 0) && (w.caption !== false || w.popup !== true);

/**
 * Whether a window is of what was started: by its executable, the process started or one of its children, or its
 * package. A document's name in a title says nothing alone: a window the user opens meanwhile in another app can carry
 * it ("notes", "report"), and one of the app's own already matches by its executable.
 */
function ofLaunch(w: WindowEntry, launching: Launching, children: () => Set<number>): boolean {
  if (w.exe && launching.exes.has(w.exe.toLowerCase())) return true;
  if (launching.package && w.package === launching.package) return true;
  return launching.pid > 0 && (w.pid === launching.pid || children().has(w.pid));
}

/**
 * Wait for the main window of what was started: one that was not there before, is of it (see ofLaunch: a window of
 * another app the user or another hand opens meanwhile is not), and is still there a moment later. The pid is the
 * window's, since the launcher's can be a stub. A new window of the same app that the user opens in that moment
 * cannot be told from it.
 */
async function freshWindow(launching: Launching, timeout: number): Promise<{ pid: number; windowId: number } | null> {
  for (const end = performance.now() + timeout * 1000; performance.now() < end; await sleep(150)) {
    const list = windowList();
    let kids: Set<number> | null = null;
    const children = () => (kids ??= new Set(launching.pid > 0 ? (native.call("children", { pid: launching.pid }) as number[]) : []));
    const candidates = list.filter((w) => !launching.before.has(w.hwnd) && w.pid !== process.pid && mainWindow(w, launching.dialogs) && ofLaunch(w, launching, children));
    const fresh = candidates.find((w) => launching.title !== null && w.title.toLowerCase().includes(launching.title)) ?? candidates[0]; // the document's own window first
    if (!fresh) continue;
    await sleep(pace.persistMs);
    if (windowList().some((w) => w.hwnd === fresh.hwnd && w.pid === fresh.pid)) return { pid: fresh.pid, windowId: fresh.hwnd };
  }
  return null;
}

/**
 * Start something without the foreground moving, and wait for the main window it opens: one hand at a time across the
 * machine, since a window is known partly by not having been there before, and two hands starting apps at once could
 * take each other's. Whoever had the keyboard has it back on every way out: an app that takes the foreground as it
 * appears (Notepad, whatever the launcher asks: measured), or brings its existing window forward, gives it back. A
 * window of another app that the user opens in that moment is theirs, and keeps it.
 */
async function openWindow(start: () => Omit<Launching, "before">, timeout: number): Promise<{ pid: number; windowId: number } | null> {
  return withLock(OPEN_LOCK, async () => {
    const before = new Set(windowList().map((w) => w.hwnd));
    const seat = (native.call("foreground") as { hwnd: number }).hwnd;
    let launching: Launching | null = null;
    let found: { pid: number; windowId: number } | null = null;
    try {
      launching = { before, ...start() };
      found = await freshWindow(launching, timeout);
      return found;
    } finally {
      const started = launching;
      let kids: Set<number> | null = null;
      const children = () => (kids ??= childrenOf(started?.pid ?? 0));
      const taken = (w: WindowEntry) => started !== null && ofLaunch(w, started, children);
      if (seat) await returnSeat(seat, taken, undefined, pace.seatWatchMs); // where the window goes (behind, or to the hand's desktop) is the caller's to say
    }
  });
}

/** Every process a process started, and those started, as far down as it goes; none when the helper cannot say. */
function childrenOf(pid: number): Set<number> {
  if (pid <= 0) return new Set();
  try {
    return new Set(native.call("children", { pid }) as number[]);
  } catch {
    return new Set();
  }
}

/** ShellExecute an app (see appSpec), and when its name is not on the PATH, its Start Menu shortcut or packaged AppID: what its window will be of. */
function startApp(spec: AppSpec, args: string): Omit<Launching, "before"> {
  const exes = new Set(spec.exe ? [spec.exe.toLowerCase()] : []);
  let pkg = spec.package;
  let started: { pid?: number; exe?: string; target?: string };
  try {
    started = native.call("launch", { file: spec.file, args, show: 4 }); // SW_SHOWNOACTIVATE
  } catch (error) {
    // Not on the PATH: an installed app goes by its name, in the Start Menu or among the packaged apps (Claude, Spotify, WhatsApp).
    const found = /error 2\)/.test((error as Error).message) ? installedApp(basename(spec.file, ".exe")) : null;
    if (found === null) throw error;
    started = native.call("launch", { file: found, args: "", show: 4 });
    const id = /^shell:AppsFolder\\(.+)$/i.exec(found)?.[1];
    if (id?.includes("!")) pkg = id.split("!")[0]!;
    const named = id && /([^\\.]+\.exe)/i.exec(id)?.[1]; // "Microsoft.Office.EXCEL.EXE.15"
    if (named) exes.add(named.toLowerCase());
  }
  for (const exe of [started.exe, started.target]) if (exe) exes.add(exe.toLowerCase());
  return { pid: started.pid ?? 0, exes, package: pkg, title: null, dialogs: spec.dialogs };
}

/** The Start Menu's two folders of shortcuts, the machine's and the user's. */
const startMenus = (): string[] =>
  [process.env.ProgramData, process.env.APPDATA].filter((root): root is string => Boolean(root)).map((root) => join(root, "Microsoft", "Windows", "Start Menu", "Programs"));

/**
 * What starts an installed app that is not on the PATH, by name, case aside: its Start Menu shortcut (Excel, Chrome), or
 * else its packaged AppID through the shell's apps folder (Claude, Spotify, Calculator), as the Start menu itself starts
 * it. The packaged list is the shell's, asked once (a second, measured). Null when nothing goes by that name.
 */
export function installedApp(name: string, dirs: string[] = startMenus(), packaged: () => [name: string, appId: string][] = startAppList): string | null {
  const wanted = name.toLowerCase();
  let partial: string | null = null;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".lnk")) continue;
      const title = entry.name.slice(0, -4).toLowerCase();
      const path = join(entry.parentPath, entry.name);
      if (title === wanted) return path;
      if (title.startsWith(wanted) && partial === null) partial = path;
    }
  }
  if (partial !== null) return partial;
  const apps = packaged();
  const app = apps.find(([title]) => title.toLowerCase() === wanted) ?? apps.find(([title]) => title.toLowerCase().startsWith(wanted));
  return app ? "shell:AppsFolder\\" + app[1] : null;
}
let startApps: [name: string, appId: string][] | null = null;

/** The shell's list of apps by name and AppID, packaged ones included: Get-StartApps, asked once a run. */
function startAppList(): [name: string, appId: string][] {
  startApps ??= (() => {
    const listed = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress"], { stdout: "pipe", stderr: "ignore" });
    try {
      return (JSON.parse(listed.stdout.toString()) as { Name: string; AppID: string }[]).filter((app) => app.Name && app.AppID).map((app) => [app.Name, app.AppID]);
    } catch {
      return []; // no shell, or nothing listed: the app is not known by name
    }
  })();
  return startApps;
}

/** What starts an app: its spec (see appSpec), with the browser's own path and, for a profile of the hands' own, its flags. */
const launcherFor = (app: string): AppSpec & { args: string } => {
  const spec = appSpec(app);
  const browser = spec.exe !== null && NAMES[basename(spec.exe, ".exe").toLowerCase()];
  const profile = process.env.HANDS_BROWSER_PROFILE;
  const args = browser && profile ? `--user-data-dir="${profile}" --no-first-run --no-default-browser-check` : "";
  return { ...spec, file: browser ? browserPath(spec.exe!) : spec.file, args };
};

/**
 * The app's pid, with a window of the hand's own in it, started without it coming forward or taking the keyboard.
 *
 * The user's own windows are not worked in: they are theirs, with their documents open (a hand once read the user's
 * .env out of their Notepad). So a window the hand already has in the app is worked in again, and otherwise the app is
 * started again for a new one, which most apps open in the running instance. An app that opens none (Spotify, a
 * single-window app) answers with its pid and no window of the hand's: workingWindow then says the window is theirs.
 * A browser has its own way to a window of the hand's (openBackgroundWindow).
 */
export async function runInBackground(app: string, timeout = 8.0): Promise<number | null> {
  const spec = launcherFor(app);
  const again = windowList().find((w) => own.get(w.hwnd) === w.pid && ofApp(w, spec));
  if (again) return again.pid;
  const theirs = spec.exe === null ? null : await userInstance(app);
  if (theirs !== null && isBrowserApp(app)) return theirs;
  const opened = await openWindow(() => startApp(spec, spec.args), theirs === null ? timeout : Math.min(timeout, 3));
  if (!opened) {
    if (theirs !== null) return theirs;
    throw new Error(`${app} opened no window`);
  }
  if (theirs === null) userPids.set(app, opened.pid);
  adopt(opened.windowId, opened.pid);
  await sendToDesktop(opened.windowId, opened.pid, app); // to the hand's desktop, or behind the user's windows
  return opened.pid;
}

/**
 * A document opened in its app as a window of the hand's own, behind the user's windows: the app that opens its kind
 * of file, started on the file itself, and the window that opens with the file's name in it or of that app. Throws when
 * no window of the hand's own opens: the file is open in a window of the user's already, or nothing here opens it.
 */
export async function openFile(path: string): Promise<KeyTarget> {
  if (!existsSync(path)) throw new Error(`there is no file at ${path}`);
  const handler = (native.call("assoc", { ext: extname(path) }) as { exe: string }).exe;
  const opened = await openWindow(() => {
    const started = native.call("launch", { file: path, args: "", show: 4 }) as { pid?: number; exe?: string };
    const exes = new Set([handler, started.exe ?? ""].filter(Boolean).map((exe) => exe.toLowerCase()));
    return { pid: started.pid ?? 0, exes, package: null, title: basename(path, extname(path)).toLowerCase() };
  }, 15);
  if (!opened) throw new Error(`${basename(path)} opened no window of its own: it may already be open in a window of the user's, or nothing on this PC opens it`);
  adopt(opened.windowId, opened.pid);
  await sendToDesktop(opened.windowId, opened.pid, handler || appName(opened.pid));
  return { pid: opened.pid, windowId: opened.windowId };
}

/** Bring an app to the front and confirm it got there. */
export async function activate(app: string, timeout = 3.0): Promise<boolean> {
  let pid = await userInstance(app);
  if (pid === null) {
    const spec = launcherFor(app);
    pid = (await openWindow(() => startApp(spec, spec.args), timeout))?.pid ?? null;
    if (pid === null) return false;
    userPids.set(app, pid);
  }
  const target = pid;
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = appWindows(target)[0]?.id;
    if (id !== undefined) native.call("activate", { hwnd: id });
    for (const end = performance.now() + (timeout * 1000) / 2; performance.now() < end; await sleep(100)) if ((await frontmostPid()) === target) return true;
  }
  return (await frontmostPid()) === target;
}

// ------------------------------------------------------------------ the browser

interface BrowserView {
  tabs: { title: string; active: boolean; frame: Frame | null; close: Frame | null }[];
  url: string | null;
  omnibox: Frame | null;
  omniboxValue: string;
  buttons: Record<string, Frame>;
  loading: boolean;
}

/**
 * The browser's windows, front to back, and its view of one: `window` by place (1 is the front one) or by
 * String(hwnd), which outlives reordering. A window named by its handle is found minimized too, and brought back
 * without activation (behind the user's windows), since a minimized window shows nothing to click.
 */
async function browserWindow(browser: string, window?: WindowSelector): Promise<{ hwnd: number; index: number; view: BrowserView } | null> {
  const pid = await userInstance(browser);
  if (pid === null) return null;
  const all = typeof window === "string" ? windowList().filter((w) => w.pid === pid && !POPUP_CLASSES.has(w.cls)) : appWindows(pid).map((w) => ({ hwnd: w.id, iconic: false }));
  const index = typeof window === "string" ? all.findIndex((w) => String(w.hwnd) === window) : (window ?? 1) - 1;
  const found = all[index];
  if (!found) return null;
  if (found.iconic) {
    native.call("show", { hwnd: found.hwnd }); // SW_SHOWNOACTIVATE
    if (own.has(found.hwnd)) native.call("sink", { hwnd: found.hwnd });
    await sleep(300);
  }
  return { hwnd: found.hwnd, index, view: viewOf(found.hwnd) };
}

/** A view of one browser window as it is now. For a window of the hand's, how many tabs it had is remembered (see release). */
function viewOf(hwnd: number): BrowserView {
  let view: BrowserView;
  try {
    view = native.call("browser", { hwnd }) as BrowserView;
  } catch {
    view = native.call("browser", { hwnd }) as BrowserView; // UI Automation's cache races a tab that has just opened (IndexOutOfRangeException): asked once more
  }
  if (browserWindows.has(hwnd)) {
    // A tab more than the hand last saw is its own while the window is unsettled, and a link of the user's after (see
    // "a link of the user's in a window of the hand's"). A count SETTLE_MS after the hand's last input settles it.
    const seen = tabsSeen.get(hwnd);
    if (seen !== undefined && view.tabs.length > seen && !unsettled.has(hwnd)) giveUp(hwnd);
    else {
      tabsSeen.set(hwnd, view.tabs.length);
      if (performance.now() - (touchedAt.get(hwnd) ?? Number.NEGATIVE_INFINITY) >= SETTLE_MS) unsettled.delete(hwnd);
    }
  }
  return view;
}

/** Whether `test` comes true within `ms`, asked every 100 ms. */
async function until(test: () => boolean, ms: number): Promise<boolean> {
  for (const end = performance.now() + ms; ; await sleep(100)) {
    if (test()) return true;
    if (performance.now() >= end) return false;
  }
}

/**
 * A URL as it may go on a browser's command line or into its omnibox: http, https or file, with no quote, space or
 * control character in it (a quote would end the argument and let the rest be read as switches), as the URL parser
 * spells it. Throws otherwise.
 */
export function safeUrl(url: string): string {
  if (/["'\s\x00-\x1f\x7f]/.test(url)) throw new Error(`a URL cannot hold quotes, spaces or control characters: ${JSON.stringify(url)}`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a URL: ${JSON.stringify(url)}`);
  }
  if (!["http:", "https:", "file:"].includes(parsed.protocol)) throw new Error(`only http, https and file URLs are opened: ${JSON.stringify(url)}`);
  return parsed.href;
}

/** A URL as an omnibox holds it, for comparison: no trailing slash, case aside. */
const plainUrl = (url: string): string => url.trim().replace(/\/+$/, "").toLowerCase();

const SCHEMED = /^(https?|file|ftp|view-source|chrome|chrome-extension|edge|about|data|blob|javascript):/i; // "localhost:8080" is a host, not a scheme
const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})(:\d+)?([/?#]|$)/i;
/**
 * A window's URL: its page's own, or else the omnibox's, which leaves the scheme out for http and https alike. A site
 * is taken to be https; a server on this PC or the local network, http, which is what they nearly all are.
 */
const fullUrl = (view: BrowserView): string | null => {
  const shown = view.omniboxValue;
  if (view.url) return view.url;
  if (!shown) return null;
  return SCHEMED.test(shown) ? shown : `${LOCAL_HOST.test(shown) ? "http" : "https"}://${shown}`;
};

export async function browserTabs(browser: string): Promise<Tab[]> {
  const pid = await userInstance(browser);
  if (pid === null) return [];
  return appWindows(pid).flatMap(({ id }, w) => {
    const view = viewOf(id);
    return view.tabs.map((tab, t) => ({ scripted: String(id), window: w + 1, tab: t + 1, active: tab.active, title: tab.title, url: tab.active ? (fullUrl(view) ?? "") : "" }));
  });
}

/** The front window's active tab URL in the user's browser. A browser that is not running answers null rather than being launched. */
export async function browserUrl(browser: string, window?: WindowSelector): Promise<string | null> {
  const at = await browserWindow(browser, window).catch(() => null);
  return at ? fullUrl(at.view) : null;
}

/** A posted click at the center of a frame in a browser window: it lands there whether or not the window is in front, which it then is for a moment (see guarded). */
async function postClick(hwnd: number, frame: Frame, count = 1): Promise<void> {
  const [x, y] = [Math.round(frame[0] + frame[2] / 2), Math.round(frame[1] + frame[3] / 2)];
  const front = frontWindow();
  await guarded(hwnd, true, async () => {
    native.call("post", { hwnd, kind: "move", x, y });
    for (let click = 0; click < count; click++) {
      native.call("post", { hwnd, kind: "down", x, y });
      native.call("post", { hwnd, kind: "up", x, y });
    }
  });
  await sleep(EVENT_DELAY_MS);
  giveBack(front); // and a window it brings up later is sent back too, as after any action from behind
}

/**
 * Navigate one window from behind: a click selects the omnibox's whole text, and the URL replaces it, as characters
 * posted to the browser's window itself (whose own focus is then the omnibox; its thread's focus can be in the user's
 * window, or in the page). Enter goes only once the omnibox holds exactly the URL: the characters are typed once more
 * when it does not, and a suggestion the browser completed it with is deleted. True once the page has gone: its URL
 * changed, or it started loading, within two seconds.
 */
async function navigateBehind(hwnd: number, url: string): Promise<boolean> {
  let view: BrowserView | null = null;
  if (!(await until(() => Boolean((view = viewOf(hwnd)).omnibox), 3000))) return false;
  const was = fullUrl(view!);
  if (was !== null && plainUrl(was) === plainUrl(url)) return true; // already there: typing it again would only reload it, and the URL would not change to say so
  const holds = () => {
    const value = plainUrl(viewOf(hwnd).omniboxValue);
    if (value === plainUrl(url)) return true;
    if (value.startsWith(plainUrl(url))) native.call("vkey", { hwnd, vk: 0x2e, direct: true }); // the completed rest is selected: Delete drops it
    return false;
  };
  let typed = false;
  for (let attempt = 0; attempt < 2 && !typed; attempt++) {
    await postClick(hwnd, viewOf(hwnd).omnibox ?? view!.omnibox!);
    native.call("chars", { hwnd, text: url, direct: true });
    typed = await until(holds, 1500);
  }
  if (!typed) return false;
  native.call("vkey", { hwnd, vk: 0x0d, direct: true });
  // Measured on a covered window: after Enter the page's own URL stays the old one for over a second, then reads as
  // none while the next page loads, and the toolbar never shows it loading. So the page has gone when its document
  // lets go of the old URL, or shows another, or the omnibox shows neither the old URL nor the one typed (a redirect).
  let seenOld = false;
  return until(() => {
    const now = viewOf(hwnd);
    if (now.loading) return true;
    if (now.url !== null) {
      if (plainUrl(now.url) !== plainUrl(was ?? "")) return true;
      seenOld = true;
      return false;
    }
    if (seenOld) return true;
    const shown = plainUrl(fullUrl(now) ?? "");
    return shown !== "" && shown !== plainUrl(was ?? "") && shown !== plainUrl(url);
  }, NAVIGATE_MS);
}
const NAVIGATE_MS = 5000; // how long a page may take to show it has gone, after Enter

/** The exe and the arguments that open `url` in the user's browser: its single instance takes them over and opens the window. After `--`, nothing is read as a switch. */
const browserCommand = (browser: string, url: string, newWindow: boolean, starting = false) => {
  const { file, args } = launcherFor(browser);
  // A browser the hands start themselves is started painting what it cannot show (see browserUnoccluded), so that its
  // windows can be worked out of sight. One the user started is theirs to set: they are told how, once (src/live.ts).
  const unseen = starting ? `--disable-features=${OCCLUSION_FEATURE} ` : "";
  return { file, args: `${args} ${unseen}${newWindow ? "--new-window " : ""}-- "${safeUrl(url)}"`.trim() };
};

/**
 * Show a URL in the user's browser: a new tab of a window by default, or the tab named, and bring the browser forward.
 * In the background, the window named (the hand's own) is navigated by keys posted to its omnibox, which takes
 * nothing, in a new tab first if asked; false when the page did not go. A window of the hand's that is gone is an
 * error: a new one is opened with openBackgroundWindow, which makes it the hand's.
 */
export async function openUrl(
  browser: string,
  url: string,
  options: { newTab?: boolean; newWindow?: boolean; window?: WindowSelector; tab?: number; background?: boolean } = {},
): Promise<boolean> {
  const href = safeUrl(url);
  const fresh = options.newTab ?? true;
  if (!options.background) {
    const { file, args } = browserCommand(browser, href, options.newWindow ?? false);
    native.call("launch", { file, args, show: 1 });
    return activate(browser);
  }
  const at = options.newWindow ? null : await browserWindow(browser, options.window);
  if (!at) throw new Error(`that ${browser} window is gone: open a new one`);
  if (options.tab !== undefined) {
    const tab = at.view.tabs[options.tab - 1];
    if (tab?.frame) await postClick(at.hwnd, tab.frame);
  } else if (fresh && at.view.buttons["New Tab"]) {
    const tabs = at.view.tabs.length;
    await postClick(at.hwnd, at.view.buttons["New Tab"]);
    await until(() => viewOf(at.hwnd).tabs.length > tabs, 1500); // typed into the new tab's omnibox, not the old one's
  }
  return navigateBehind(at.hwnd, href);
}

/**
 * Give the seat back to the window that had it, each time something the hand opened takes it: the one visible moment
 * of opening a window from behind. `taken` says which windows are the opening's (by handle: the user's own Chrome
 * window shares the new one's process, and a click of theirs into it is theirs). Chrome activates a beat after the
 * window exists, and once more when it shows a bubble over it, so this watches for up to `watchMs`, and until a moment
 * after the first handback. While another hand borrows the seat the foreground is its borrow's to move (see takeBack):
 * the window only goes behind the user's.
 */
async function returnSeat(seat: number, taken: (w: WindowEntry, list: WindowEntry[]) => boolean, window?: number, watchMs = 2500): Promise<void> {
  let returned = 0;
  for (const end = performance.now() + watchMs; ; await sleep(50)) {
    const front = (native.call("foreground") as { hwnd: number }).hwnd;
    const list = front && front !== seat ? windowList() : [];
    const entry = list.find((w) => w.hwnd === front);
    if (entry && taken(entry, list)) {
      if (!seatElsewhere()) native.call("activate", { hwnd: seat });
      if (window !== undefined) native.call("sink", { hwnd: window }); // and the window itself goes behind the user's, not only behind the one in front
      returned ||= performance.now();
    }
    if (performance.now() >= end || (returned > 0 && performance.now() >= returned + 800)) break;
  }
  if (window !== undefined) native.call("sink", { hwnd: window });
}

/** Whether the front window's active tab is still loading: the toolbar shows Stop instead of Reload. A browser that is not running is not. */
export async function browserLoading(browser: string, window?: WindowSelector): Promise<boolean> {
  const at = await browserWindow(browser, window).catch(() => null);
  return at?.view.loading ?? false;
}

/**
 * Act on a tab of the user's browser. Returns the tab it acted on as `title | url`, or null when there is no such tab.
 * A switch is a posted click on the tab, read back until that tab is the active one (clicked once more if it is not),
 * and an error when it never is: a click that went nowhere is not reported as a switch.
 */
export async function tabCommand(browser: string, command: TabCommand, window?: WindowSelector, tab?: number, background = false): Promise<string | null> {
  const at = await browserWindow(browser, window);
  if (!at) return null;
  const { hwnd, view } = at;
  const target = tab === undefined ? view.tabs.find((t) => t.active) : view.tabs[tab - 1];
  if (!target) return null;
  if (command === "switch_tab") {
    const active = () => viewOf(hwnd).tabs[tab! - 1]?.active === true;
    for (let attempt = 0; tab !== undefined && target.frame && attempt < 2; attempt++) {
      await postClick(hwnd, target.frame);
      if (await until(active, 1000)) break;
    }
    if (tab !== undefined && !active()) throw new Error(`tab ${tab} did not become the active tab`);
    if (!background) await activate(browser);
    const now = viewOf(hwnd);
    return `${target.title} | ${fullUrl(now) ?? ""}`;
  }
  const description = `${target.title} | ${target.active ? (fullUrl(view) ?? "") : ""}`;
  if (command === "close_tab") {
    if (!target.active && target.frame) await postClick(hwnd, target.frame); // the close button only shows on a tab that is wide enough: bring it up first
    const now = tab === undefined ? target : (viewOf(hwnd).tabs[tab - 1] ?? target);
    if (!now.close) return null; // a tab too narrow for its close button; Ctrl-W would need a modifier, which a posted key cannot carry
    await postClick(hwnd, now.close);
  } else {
    if (tab !== undefined && !target.active && target.frame) await postClick(hwnd, target.frame);
    const button = view.buttons[{ back: "Back", forward: "Forward", reload: "Reload" }[command]] ?? (command === "reload" ? view.buttons["Stop"] : undefined);
    if (!button) return null;
    await postClick(hwnd, button);
  }
  return description;
}

/**
 * A new window in the user's browser and profile, opened without the browser keeping the seat.
 *
 * Chrome's single instance activates the window it opens; the window the user was in is put back in front the moment
 * that happens, and the new one is the browser window that was not there before. A covered window keeps rendering
 * and keeps its accessibility tree, so it can be read and worked from behind.
 */
export async function openBackgroundWindow(browser: string, url: string): Promise<PinnedWindow> {
  // One hand at a time, across processes: a new window is told from the rest by not having been there before, and two
  // hands opening at once would both claim the first to appear.
  return withLock(OPEN_LOCK, () => openWindowAlone(browser, url));
}

async function openWindowAlone(browser: string, url: string): Promise<PinnedWindow> {
  const seat = (native.call("foreground") as { hwnd: number }).hwnd;
  const before = new Set(windowList().map((w) => w.hwnd)); // minimized ones too: one the user restores meanwhile is not new
  const cold = (await userInstance(browser)) === null;
  const { file, args } = browserCommand(browser, url, true, cold);
  let opened: PinnedWindow | null = null;
  let pid: number | null = null;
  try {
    native.call("launch", { file, args, show: 4 });
    let pages: WindowEntry[] = [];
    for (const end = performance.now() + 8000; !opened && performance.now() < end; await sleep(100)) {
      pid = await userInstance(browser);
      const fresh = pid === null ? [] : windowList().filter((w) => w.pid === pid && !before.has(w.hwnd) && mainWindow(w));
      // A browser the hands start themselves starts in the user's profile, and may restore their last session in windows
      // of its own, or show its profile picker, as it starts: the hand's is the window showing the page it was opened for.
      // A running browser opens just the one window.
      const views = cold ? fresh.map((w) => ({ w, view: browsing(w.hwnd) })).filter(({ view }) => view !== null) : fresh.map((w) => ({ w, view: null }));
      pages = views.map(({ w }) => w);
      const found = cold ? views.find(({ view }) => showsPage(view, url))?.w : pages[0];
      if (found) opened = { pid: found.pid, windowId: found.hwnd, scripted: String(found.hwnd) };
    }
    const only = pages[0];
    if (!opened && cold && pages.length === 1 && only) opened = { pid: only.pid, windowId: only.hwnd, scripted: String(only.hwnd) }; // the page went elsewhere (a redirect), and it is the one new browser window
  } finally {
    // Only the new window, and what it brings up over itself, is handed back from: a window the user opens meanwhile is theirs.
    const taken = (w: WindowEntry, list: WindowEntry[]) =>
      opened !== null ? w.hwnd === opened.windowId || rootOf(w, list).hwnd === opened.windowId : w.pid === pid && !before.has(w.hwnd);
    if (seat) await returnSeat(seat, taken, opened?.windowId, pace.browserWatchMs);
  }
  if (!opened) throw new Error(`${browser} opened no new window${cold ? ` showing ${url} (it may be asking which profile to use, or restoring the user's last session)` : ""}`);
  // Once the seat is back: a browser that paints unseen has its window parked off the screens; any other keeps it here,
  // sunk behind the user's. Never on the hand's desktop: a click that brings a browser window forward there switches the
  // user's screen to that desktop and back (measured), and a browser window is brought forward by every posted click.
  adopt(opened.windowId, opened.pid);
  browserWindows.set(opened.windowId, opened.pid);
  unmaximize(opened.windowId);
  try {
    viewOf(opened.windowId); // its tabs counted from the start: a link of the user's can land in it before the hand first looks
  } catch {
    // still opening: the hand's first look counts them
  }
  if (!process.env.HANDS_SCREEN && (await browserUnoccluded(browser))) park(opened.windowId);
  return opened;
}

/**
 * A browser window of the hand's that opened maximized (the browser opens a new window as the last one was) is made an
 * ordinary one, most of its screen's size, where it is. Maximized, it covers the whole screen behind the user's
 * windows, where it can be neither given a strip of screen nor parked, and Chrome stops drawing its page (measured: a
 * blank page, which the clicker could do nothing with). Nothing here throws.
 */
function unmaximize(windowId: number): void {
  try {
    const entry = windowList().find((w) => w.hwnd === windowId);
    if (!entry?.zoomed) return;
    const [cx, cy] = [entry.frame[0] + entry.frame[2] / 2, entry.frame[1] + entry.frame[3] / 2];
    const screen = displays().find(({ frame: [x, y, w, h] }) => cx >= x && cy >= y && cx < x + w && cy < y + h) ?? displays()[0];
    if (!screen) return;
    const [x, y, w, h] = screen.frame;
    const [width, height] = [Math.round(w * 0.62), Math.round(h * 0.78)];
    native.call("unmaximize", { hwnd: windowId, x: x + Math.round((w - width) / 2), y: y + Math.round((h - height) / 3), w: width, h: height });
  } catch {
    // the window went away, or the helper would not: it is read as it is
  }
}

/** A browser window's view when it is one (it has an omnibox, which a profile picker has not), else null. */
function browsing(hwnd: number): BrowserView | null {
  try {
    const view = viewOf(hwnd);
    return view.omnibox ? view : null;
  } catch {
    return null; // the window is still opening, or went away
  }
}

/** Whether a browser window's view shows the page at `url`, or its way there: its host (or, for a file, its path) in the address. */
function showsPage(view: BrowserView | null, url: string): boolean {
  if (!view) return false;
  const plain = (text: string) => {
    try {
      return decodeURI(text).toLowerCase();
    } catch {
      return text.toLowerCase(); // a stray % in an address
    }
  };
  const wanted = new URL(safeUrl(url));
  const mark = wanted.host.replace(/^www\./, "").toLowerCase() || plain(wanted.pathname);
  return [view.url ?? "", view.omniboxValue].some((address) => plain(address).includes(mark));
}

// ------------------------------------------------------------------ a browser window parked off the screens

// The hand's browser windows kept past the right edge of every screen. Where each was is the helper's to keep (Parking
// in windows.cs), so that it goes back exactly, and goes back however the hand ends: the helper puts it back as it leaves.
const parked = new Set<number>();

/**
 * Keep a browser window of the hand's off every screen. A browser whose occlusion tracking is off paints a window there
 * and captures it current, and a posted click that brings it forward changes nothing the user can see: their window
 * keeps its place and only loses the keyboard for the moment the click guard takes to hand it back (all measured).
 */
function park(windowId: number): void {
  try {
    if ((native.call("park", { hwnd: windowId }) as { ok: boolean }).ok) parked.add(windowId);
  } catch {
    // the window closed as it was being parked: nothing to keep
  }
}

/** Back where it was before it was parked, for the user to see or the seat to reach; true when it had been parked. `keep` leaves it counted as parked, to go back after. */
function unpark(windowId: number, keep = false): boolean {
  if (!parked.has(windowId)) return false;
  if (!keep) parked.delete(windowId);
  native.call("unpark", { hwnd: windowId, keep });
  return true;
}

/** The frontmost app's topmost on-screen window as x, y, w, h in pixels. Pass the pid when the caller already has it. */
export async function frontmostWindowBounds(pid?: number | null): Promise<Frame | null> {
  return appWindows(pid ?? (await frontmostPid()))[0]?.frame ?? null;
}

export interface AppWindow {
  id: number; // the HWND
  frame: Frame;
}

const POPUP_CLASSES = new Set(["Xaml_WindowedPopupClass", "tooltips_class32", "#32768"]); // a WinUI popup or tooltip (Notepad's "New tab" tip was captured as the window, measured), a classic tooltip, a menu

/** A window that counts as one of an app's: covered or not, but not minimized, not a popup or a tip, not a sliver. */
const ordinary = (w: WindowEntry): boolean => !w.iconic && !POPUP_CLASSES.has(w.cls) && w.frame[2] > MIN_WINDOW_SIDE_PT && w.frame[3] > MIN_WINDOW_SIDE_PT;

/**
 * An app's ordinary windows, front to back, those on the hand's own desktop included. One that is covered by another
 * still counts; a minimized one does not, unless it is the hand's own: the user may minimize a window of the hand's,
 * which the hand still works in (see workingWindow). Those come last, with the frame they go back to.
 */
export function appWindows(pid: number): AppWindow[] {
  const list = windowList().filter((w) => w.pid === pid);
  const minimized = list.filter((w) => w.iconic && own.get(w.hwnd) === w.pid && ordinary({ ...w, iconic: false }));
  return [...list.filter(ordinary), ...minimized].map(({ hwnd, frame }) => ({ id: hwnd, frame }));
}

/** Every ordinary window on the desktop on screen, front to back, minimized ones aside. All are solid: the hand's overlay is a tool window, which the list leaves out. */
export function allWindows(): (AppWindow & { pid: number; alpha: number })[] {
  return windowList()
    .filter((w) => !w.cloaked && !w.iconic)
    .map(({ hwnd, pid, frame }) => ({ id: hwnd, pid, frame, alpha: 1 }));
}

/** Center of the frontmost app's topmost on-screen window. */
export async function frontmostWindowCenter(pid?: number | null): Promise<Point | null> {
  const bounds = await frontmostWindowBounds(pid);
  return bounds && [bounds[0] + bounds[2] / 2, bounds[1] + bounds[3] / 2];
}

// ------------------------------------------------------------------ capture and OCR

/** One display as a PNG at `path`. */
export async function screenshot(display: Display, path: string): Promise<Capture> {
  const { width, height } = native.call("capture", { display: display.index, path, format: "png" }) as { width: number; height: number };
  return { path, width, height };
}

const REPAINT_MS = 300; // how long a page given a strip of screen takes to paint again
const stale = new Set<number>(); // windows whose latest capture may be an old picture: a Chromium page covered on every side, which could not be given a strip of screen (its accessibility items are current all the same)
const staleShots = new Map<string, { windowId: number; origin: Point; size: Point }>(); // such a capture, by its path, and where its window lay: its text is read from the page (see pageText)
const PAGE_TEXT_NODES = 3000;
const PAGE_TEXT_MS = 1500;

/**
 * One window as a PNG, cropped to its visible frame. DWM renders it whole even when other windows cover it; a
 * minimized one is restored first, without activation, and one of the hand's own goes back behind the user's windows
 * after (restored, it comes up over them). A Chromium window of the hand's that is covered on every side paints no
 * more, so it is given a strip of screen first (see reveal); when none can be found, its picture may be old.
 */
export async function screenshotWindow(windowId: number, path: string): Promise<Capture> {
  keepOnDesktop();
  const list = own.size > 0 ? windowList() : [];
  const entry = list.find((w) => w.hwnd === windowId);
  stale.delete(windowId);
  if (entry && !entry.iconic && !entry.cloaked && !parked.has(windowId) && entry.cls.startsWith("Chrome_WidgetWin") && isOwn(entry, list) && !showing(windowId)) {
    if (await reveal(windowId)) await sleep(REPAINT_MS);
    else stale.add(windowId);
  }
  const reply = native.call("capture", { hwnd: windowId, path, format: "png" }) as { width: number; height: number; gone?: boolean };
  if (reply.gone) throw new Error("the window is gone; look again");
  if (entry?.iconic && isOwn(entry, list)) native.call("sink", { hwnd: rootOf(entry, list).hwnd });
  for (const [shot, of] of staleShots) if (of.windowId === windowId || shot === path) staleShots.delete(shot);
  if (stale.has(windowId) && entry) staleShots.set(path, { windowId, origin: [entry.frame[0], entry.frame[1]], size: [reply.width, reply.height] });
  return { path, width: reply.width, height: reply.height, ...(stale.has(windowId) ? { stale: true } : {}) };
}

/**
 * The text of a page whose picture may be old, read from its accessibility tree instead, which the browser keeps
 * current whether or not the window shows: each run of text with its rectangle in the capture's pixels, as OCR gives
 * it, for what lies in the capture (and in `rect`, when one is given). Null when the page has no tree to read: Chrome
 * builds a page's tree only while its window is in front, for a second or so (measured), so a page that loaded out of
 * sight has none, though a new page is painted there (measured) and its picture is read as usual.
 */
function pageText({ windowId, origin: [ox, oy], size: [width, height] }: { windowId: number; origin: Point; size: Point }, rect?: Box): OcrLine[] | null {
  let reply: { nodes: TreeNode[] };
  try {
    reply = native.call("tree", { hwnd: windowId, cap: PAGE_TEXT_NODES, ms: PAGE_TEXT_MS }) as { nodes: TreeNode[] };
  } catch {
    return null;
  }
  if (!reply.nodes.some((node) => node.role === "AXStaticText" && node.label)) return null;
  const [rx1, ry1, rx2, ry2] = rect ?? [0, 0, width, height];
  const lines: OcrLine[] = [];
  for (const node of reply.nodes) {
    if (node.role !== "AXStaticText" || !node.label || !node.frame) continue;
    const [x, y, w, h] = node.frame;
    const box: Box = [x - ox, y - oy, x - ox + w, y - oy + h];
    const [cx, cy] = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    if (cx >= rx1 && cy >= ry1 && cx < rx2 && cy < ry2) lines.push([node.label, 1, box]);
  }
  return lines;
}

/** A capture already on disk. The helper decodes it and keeps it, which the OCR that follows needs anyway. */
export function captureAt(path: string): Capture {
  const { width, height } = native.call("image", { path }) as { width: number; height: number };
  return { path, width, height };
}

/**
 * Windows OCR (en-US) over one rectangle of a capture. Boxes come back in full-capture pixels, so nothing downstream
 * knows a crop happened. The engine reports no confidence, so every line is 1.
 */
export function recognizeText(path: string, rect?: Box): OcrLine[] {
  const shot = staleShots.get(path);
  const fromPage = shot ? pageText(shot, rect) : null; // an old picture's text would be old too: the page says what it holds now, when it has a tree to say it with
  if (fromPage) return fromPage;
  const [x1, y1] = rect ? rect.map(Math.round) : [0, 0];
  const lines = native.call("ocr", { path, rect: rect?.map(Math.round) }) as [string, number, Box][];
  return lines.map(([text, confidence, [bx1, by1, bx2, by2]]) => [text, confidence, [x1! + bx1, y1! + by1, x1! + bx2, y1! + by2]]);
}

// ------------------------------------------------------------------ accessibility elements

// Element handles given out to a Screen stay in the helper's table until the next capture replaces them. Pressing
// one from an older capture is refused rather than sent to a control that is gone.
let live = new Set<number>();
const webRefs = new Map<number, boolean>(); // the handles of controls in a Chromium window, where a press brings the window forward (see flashing), and whether that window is the hand's own
const refWindows = new Map<number, number>(); // and the window each of those is in

/** Drop every handle the previous capture gave out. Perception calls this as a new capture starts. */
export function releaseElements(): void {
  live = new Set();
  webRefs.clear();
  refWindows.clear();
  native.call("release");
}

const alive = (ref: unknown): ref is number => typeof ref === "number" && live.has(ref);

interface FocusedReply {
  id: number;
  role: string;
  label: string;
  placeholder: string;
  value: string;
  frame: Frame | null;
}

export function focusedField(): Field | null {
  const reply = native.call("focused") as FocusedReply | null;
  if (!reply) return null;
  const [x, y, w, h] = reply.frame ?? [0, 0, 0, 0];
  live.add(reply.id);
  return { role: reply.role, label: reply.label, placeholder: reply.placeholder, value: reply.value, x, y, w, h, ref: reply.id };
}

// ------------------------------------------------------------------ acting on an element

// An element accepts these directly, so a press lands on the control the app declared rather than on whatever pixel
// happens to sit at its center. Every one of them is best effort: the element may be dead, the app may refuse.
// False means "use synthetic input".

const act = (ref: unknown, action: string): boolean => {
  if (!alive(ref)) return false;
  if (refWindows.has(ref)) refuseTheirs(refWindows.get(ref)!);
  const front = frontWindow();
  const web = webRefs.has(ref);
  const run = () => {
    try {
      const done = native.call("act", { id: ref, action, ...(web ? { sink: webRefs.get(ref) } : {}) }) as { ok: boolean; popups?: number[] };
      if (refWindows.has(ref)) touch(refWindows.get(ref)!); // after the wait for the user to pause: a tab the press opens is the hand's
      if (webRefs.get(ref)) adoptPopups(done.popups ?? [], parked.size > 0); // a press in the hand's page that opened a window: the hand's, as for a click
      return Boolean(done.ok);
    } catch {
      return false;
    }
  };
  try {
    return action === AX_PRESS && web ? pausedSync(run, "the click", FLASH_QUIET_MS, FLASH_WAIT_SYNC_MS, true) : run();
  } catch (error) {
    // The user did not pause in the moment a press can wait here: nothing was done, and the tools' pointer click
    // waits longer, where the wait is shown and a stop is heard (see flashing). A stop is the stop it is.
    if (error instanceof SeatBusy) return false;
    throw error;
  } finally {
    giveBack(front);
    keepOnDesktop();
  }
};

/**
 * Press an element: Invoke, Toggle, Select or Expand as it offers; on Chromium a posted click at its center (brought
 * into the page's view first when it lies outside it), guarded, since any press there brings the window forward.
 */
export const axPress = (ref: unknown): boolean => act(ref, AX_PRESS);

/** AXConfirm is Enter posted to the element's window; AXScrollToVisible the scroll-item pattern. */
export const axPerform = (ref: unknown, action: string): boolean => act(ref, action);

/** Never: giving a control the focus through UIA activates its window, which is the seat. */
export const axFocus = (_ref: unknown): boolean => false;

/**
 * A field's value as it may be compared with the text typed into it: runs of white space, non-breaking spaces
 * included, as one space; curly quotes and apostrophes as straight ones; no space at either end. A rich editor gives
 * back what it was sent in its own spelling.
 */
export const plainText = (text: string): string =>
  text
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[\s   ]+/g, " ")
    .trim();

/** Whether a field's value ends with the text typed into it, compared as plainText. */
export const holdsText = (value: string | null, text: string): boolean => plainText(value ?? "").endsWith(plainText(text));

/**
 * Write an element's value. A classic edit control takes it as messages, a Chromium field as posted keys after a
 * click, anything else through ValuePattern. Text with a line break that a Chromium field would take as Enter throws
 * an error starting "line break:", and one with a tab for a browser's page one starting "tab:". The clicks into a
 * Chromium field wait for the user to pause: SeatBusy, with nothing typed, when they did not (the field itself is
 * fine), and Abort when the hand was stopped. Any other failure is false.
 */
export function axSetValue(ref: unknown, value: string): boolean {
  if (!alive(ref)) return false;
  if (refWindows.has(ref)) refuseTheirs(refWindows.get(ref)!);
  const front = frontWindow();
  const web = webRefs.has(ref);
  const set = () => {
    const reply = native.call("setValue", { id: ref, text: value, ...(web ? { sink: webRefs.get(ref) } : {}) }) as { ok: boolean; posted?: boolean; why?: string };
    if (refWindows.has(ref)) touch(refWindows.get(ref)!); // after the wait for the user to pause: a tab a submit opens is the hand's
    return reply;
  };
  try {
    const { ok: taken, posted, why } = web ? pausedSync(set, "typing into the field", FLASH_QUIET_MS, FLASH_WAIT_SYNC_MS, true) : set();
    if (!taken && why?.startsWith("busy:")) throw new SeatBusy(why.slice("busy:".length).trim()); // the user went back to work between the clicks
    // A Chromium field takes the text as posted keystrokes, and its tree shows them a beat later: WhatsApp's composer
    // read back empty when asked at once and full 250 ms on (measured), and a long message takes longer to show. So the
    // value is waited for, a second and a half and more for a longer text, up to eight seconds.
    const wait = Math.min(8000, 1500 + 12 * value.length);
    if (taken && posted) for (const end = performance.now() + wait; performance.now() < end && !holdsText(axValue(ref), value); ) Bun.sleepSync(50);
    return taken;
  } catch (error) {
    if (error instanceof SeatBusy || error instanceof Abort) throw error;
    const refused = refusal(error);
    if (/^(line break|tab): /.test(refused.message)) throw refused;
    return false;
  } finally {
    giveBack(front);
    keepOnDesktop();
  }
}

/** An element's value, when it has a textual one. */
export function axValue(ref: unknown): string | null {
  if (!alive(ref)) return null;
  try {
    return (native.call("value", { id: ref }) as { value: string | null }).value ?? null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ a pointer that is not the user's

export const pointerAvailable = (): boolean => true;

const WEB_EXES = new Set(["chrome", "msedge", "brave", "vivaldi", "opera", "arc", "chromium"]);

/**
 * Whether a process shows its windows as web pages, where Enter in a box sends a chat message: a browser of Chromium's
 * family, anything whose windows are Chrome_WidgetWin (an Electron app), or an app whose window a WebView2 fills (new
 * Teams, new Outlook, WhatsApp), whose page is a child window of another process (see Web in windows.cs). An app with
 * a WebView2 for a pane of its own (Office's) is not one.
 */
export function isWebContentApp(pid: number): boolean {
  let name = "";
  try {
    name = (native.call("exe", { pid }) as { name: string }).name.toLowerCase();
  } catch {
    // a process that is gone, or one this user may not open
  }
  if (WEB_EXES.has(name) || windowList().some((w) => w.pid === pid && w.cls.startsWith("Chrome_WidgetWin"))) return true;
  try {
    return (native.call("web", { pid }) as { web: boolean }).web;
  } catch {
    return false;
  }
}

/** The window an app holds as key: its front-most window, whether or not the app is in front. */
export const keyWindowId = (pid: number): number | null => appWindows(pid)[0]?.id ?? null;

/** Nothing to do: a posted message reaches a window without the focus moving anywhere. */
export const focusWithoutRaise = (_windowId: number): boolean => true;

/**
 * A press, a run of drags through every point, a release: posted to one window as mouse messages, which it takes
 * whether or not anything covers it (measured on Chrome, covered and behind), and which never enter the input queue
 * of whatever the user is in. A path of one point is a click. A Chromium window brings itself forward on the press, so
 * there the whole of it is guarded (see flashing), and the window goes back behind the user's as soon as it is done.
 */
export async function windowPointer(target: PointerTarget, path: Point[], options: { count?: number; onMove?: (at: Point) => void } = {}): Promise<void> {
  const [start, end] = [path[0], path[path.length - 1]];
  if (!start || !end) return;
  const post = async ([x, y]: Point, kind: string, delay: number) => {
    native.call("post", { hwnd: target.windowId, kind, x: Math.round(x), y: Math.round(y) });
    await sleep(delay);
  };
  const front = frontWindow();
  await guarded(target.windowId, target.web, async () => {
    await post(start, "move", 15); // a window that was never moved over hit-tests the press against stale tracking
    for (let click = 1; click <= (options.count ?? 1); click++) {
      await post(start, "down", path.length > 1 ? 16 : 28);
      let [px, py] = start;
      for (const [x, y] of path.slice(1)) {
        const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / DRAG_STEP_PT));
        for (let i = 1; i <= steps; i++) {
          checkAbort();
          const at: Point = [px + ((x - px) * i) / steps, py + ((y - py) * i) / steps];
          options.onMove?.(at);
          await post(at, "drag", DRAG_DELAY_MS);
        }
        [px, py] = [x, y];
      }
      if (path.length > 1) await sleep(50); // the page handles the last drag before the release
      await post(end, "up", target.web && click === (options.count ?? 1) ? 0 : 80); // on Chromium the guard's watch follows at once: the window is in front until it does
    }
  });
  giveBack(front);
}

const SLIVER_PT = 24; // how much of a window has to show for the browser to call its page visible
const GRID_PT = 12;

/** What lies over a window: the frames in front of it. */
const coversOf = (windows: ReturnType<typeof allWindows>, at: number): Frame[] => windows.slice(0, at).filter((c) => c.alpha >= 1).map((c) => c.frame);

/** The patch of a window that nothing covers, if there is one: a grid point on a display, inside the window, under no window in front of it. */
function showing(windowId: number): Point | null {
  const windows = allWindows();
  const at = windows.findIndex((w) => w.id === windowId);
  if (at < 0) return null;
  const [x, y, w, h] = windows[at]!.frame;
  const covers = coversOf(windows, at);
  const inside = ([fx, fy, fw, fh]: Frame, px: number, py: number) => px >= fx && py >= fy && px < fx + fw && py < fy + fh;
  const screens = displays().map((d) => d.frame);
  for (let py = y + GRID_PT; py < y + h; py += GRID_PT) {
    for (let px = x + GRID_PT; px < x + w; px += GRID_PT) {
      const free = (qx: number, qy: number) => screens.some((d) => inside(d, qx, qy)) && !covers.some((c) => inside(c, qx, qy));
      if (free(px, py) && free(px + SLIVER_PT, py) && free(px, py + SLIVER_PT) && free(px + SLIVER_PT, py + SLIVER_PT)) return [px, py];
    }
  }
  return null;
}

const moveWindow = (hwnd: number, x: number, y: number, size?: [number, number]) => native.call("move", { hwnd, x: Math.round(x), y: Math.round(y), ...(size ? { w: Math.round(size[0]), h: Math.round(size[1]) } : {}) });

/**
 * `HANDS_SCREEN=1`: a stage. The window is put on that display, one of a cascade (`HANDS_SLOT` says which), clear of
 * the panel's corner, so that a recording of the display shows every hand at work. Without it, nothing moves.
 */
export async function stageWindow(_pid: number, windowId: number): Promise<void> {
  const display = displays()[Number(process.env.HANDS_SCREEN)];
  if (!process.env.HANDS_SCREEN || !display) return;
  const [[x, y, w, h], slot] = [display.frame, (Number(process.env.HANDS_SLOT) || 0) % 4];
  const at: [number, number] = [x + 16 + slot * 130, y + 36 + slot * 64];
  const size: [number, number] = [Math.min(1100, w - 440 - 3 * 130), h - 60 - 3 * 64];
  // Twice: a window that is still opening takes the move and then puts its own size back (seen on Chrome).
  for (let i = 0; i < 2; i++) {
    moveWindow(windowId, at[0], at[1], size);
    await sleep(250);
  }
}

/**
 * Whether a window can take pointer input where it lies: on Windows, always. A posted click lands on a Chromium page
 * that is covered on every side (measured), so nothing is moved for it; see reveal for what a covered page does not do.
 */
export async function revealWindow(_pid: number, _windowId: number): Promise<boolean> {
  return true;
}

/**
 * Make sure some of a window shows, moving it if it has to. Chrome stops painting a page it considers hidden, and it
 * considers a page hidden when its window is covered on every side, by anything: a capture of it is then its last
 * picture from when it showed (measured: the picture said 17 clicks while the page was at 20). A strip at a screen's
 * edge is enough, so the window is slid until a corner of it lies over a spot that no window in front of it covers,
 * the rest of it staying behind them or off the screen. Nothing is raised, and nothing of the user's is moved: only a
 * window of the hand's own. False when every screen is covered edge to edge. A window on the hand's own desktop is
 * left where it is: only a browser that works unseen is taken there, and nothing of the user's lies over it.
 */
async function reveal(windowId: number): Promise<boolean> {
  if (showing(windowId) || cloaked(windowId)) return true;
  const windows = allWindows();
  const at = windows.findIndex((w) => w.id === windowId);
  if (at < 0) return false;
  const [, , w, h] = windows[at]!.frame;
  const covers = coversOf(windows, at);
  const inside = ([fx, fy, fw, fh]: Frame, px: number, py: number) => px >= fx && py >= fy && px < fx + fw && py < fy + fh;
  // Free spots, below the top edge, nearest a side edge first: the window then hangs off the screen rather than lying under the user's.
  const spots: { point: Point; edge: number; left: boolean }[] = [];
  for (const { frame: d } of displays()) {
    for (let py = d[1] + 60; py < d[1] + d[3] - SLIVER_PT; py += GRID_PT) {
      for (let px = d[0]; px < d[0] + d[2] - SLIVER_PT; px += GRID_PT) {
        const free = [[0, 0], [SLIVER_PT, 0], [0, SLIVER_PT], [SLIVER_PT, SLIVER_PT]].every(([dx, dy]) => inside(d, px + dx!, py + dy!) && !covers.some((c) => inside(c, px + dx!, py + dy!)));
        if (free) spots.push({ point: [px, py], edge: Math.min(px - d[0], d[0] + d[2] - px), left: px - d[0] < d[0] + d[2] - px });
      }
    }
  }
  spots.sort((a, b) => a.edge - b.edge);
  for (const { point, left } of spots.filter((_, i) => i % 7 === 0).slice(0, 6)) {
    // The spot goes just inside the window's near side, a little below its top.
    moveWindow(windowId, left ? point[0] + SLIVER_PT * 2 - w : point[0] - SLIVER_PT, point[1] - Math.min(120, h / 3));
    await sleep(400);
    if (showing(windowId)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ an app that is not in front

/**
 * The window the hand works in, in an app: in an app it has opened a window in, its own window there (the front-most
 * of them, a minimized one if that is all it has), and never one of the user's, even when all of its own are gone
 * (null then: the hand opens another). In an app it only took up as it was, the app's front window.
 */
export const mainWindowId = (pid: number): number | null => mainIn(pid, windowList());

function mainIn(pid: number, list: WindowEntry[]): number | null {
  const mine = list.filter((w) => w.pid === pid && own.get(w.hwnd) === pid);
  if (mine.length > 0) return (mine.find((w) => !w.iconic) ?? mine[0]!).hwnd;
  if (opened.has(pid)) return null;
  return list.find((w) => w.pid === pid && ordinary(w))?.hwnd ?? null;
}

/**
 * The window to look at and act in, for a hand working in `pid`: `preferred` (its browser window, say) or its main
 * window, or the dialog that window has open (Open, Save As, a message box), which is what the user would be looking
 * at. `theirs` says the window is not one the hand opened: an app that opened no window of its own. Null when the
 * app has no window, or `preferred` is gone. A window of the hand's that the user minimized is restored first, without
 * activation, behind their windows: the hand is about to look at it, and a minimized window shows nothing (a window
 * of the user's stays where they put it).
 */
export function workingWindow(pid: number, preferred?: number): WorkingWindow | null {
  const list = windowList();
  const base = preferred ?? mainIn(pid, list);
  if (base === null) return null;
  const entry = list.find((w) => w.hwnd === base);
  if (!entry) return null;
  if (entry.iconic && isOwn(entry, list)) {
    native.call("show", { hwnd: base }); // SW_SHOWNOACTIVATE
    native.call("sink", { hwnd: rootOf(entry, list).hwnd });
    Bun.sleepSync(REPAINT_MS); // restored, it paints before it can be captured
  }
  const dialog = dialogOf(entry, list);
  return { windowId: dialog?.hwnd ?? base, dialog: dialog ? dialog.title || "a dialog" : null, theirs: !isOwn(entry, list) };
}

/**
 * A menu command, by the path a person would read off the menu bar: ["File", "New"]. A path that ends on a menu lists
 * what is in it instead. Pressing a menu bar item opens its menu on screen (Windows has no way around that), and the
 * items are pressed where they are, so the app need not be in front. An open menu brings its app forward and holds the
 * keyboard for as long as it is open, where a letter the user types picks an item (measured: it took the seat), so a
 * press waits, as a borrow does, for the user to pause, under the seat's lock: SeatBusy when they never do.
 */
export function menu(pid: number, path: string[]): { pressed: string } | { items: string[] } {
  const hwnd = mainWindowId(pid);
  if (hwnd === null) throw new Error("this app has no window with a menu bar");
  const front = frontWindow();
  const open = () => native.call("menu", { hwnd, path }) as { pressed: string } | { items: string[] };
  try {
    return path.length === 0 ? open() : pausedSync(open, "opening the menu", MENU_QUIET_MS); // the menu bar alone is read, not pressed
  } finally {
    giveBack(front);
    keepOnDesktop();
  }
}

/** Page a window's largest scroll area, or, when nothing in it takes that, a wheel posted at its center. */
export function scrollPage(_pid: number, windowId: number, direction: "up" | "down" | "left" | "right"): boolean {
  refuseTheirs(windowId);
  const front = frontWindow();
  try {
    return Boolean((native.call("scrollPage", { hwnd: windowId, direction }) as { ok: boolean }).ok);
  } catch {
    return false;
  } finally {
    giveBack(front);
    keepOnDesktop();
  }
}

// ------------------------------------------------------------------ actionable elements

/** One node of the helper's flat tree: the roles already spelled as the shared walk expects them. */
interface TreeNode {
  id: number;
  parent: number;
  role: string;
  label: string;
  frame: Frame | null;
  actions: string[];
  value?: string; // a field's text, its first 120 characters, never a password's
}

const ROOT = -1;
type TreeReply = { nodes: TreeNode[]; capped: boolean };
const primed = new Map<number, string>(); // Chromium windows of the hand's whose page came back after a lift, and the address it came back at
const unlifted = new Map<number, { address: string; lifts: number }>(); // lifts that brought no page back, for the address they were made at
const LIFTS_PER_PAGE = 2; // a page that stays blank through this many lifts (about:blank, a page with nothing on it) is not lifted again
const LIFT_POLL_MS = 100;
const LIFT_POLL_CAP_MS = 500; // how long a page a lift did not bring up is read again, behind the user's windows, for a tree Chrome began while it showed
const PRIME_NODES = 600; // enough of a tree to reach past the browser's toolbar into the page
const PAGE_ROLES = new Set(["AXStaticText", "AXLink", "AXTextField", "AXTextArea", "AXComboBox", "AXCheckBox", "AXRadioButton", "AXRow", "AXCell", "AXImage"]);
const OMNIBOX = /^address and search bar$/i;

/** The address a browser window's omnibox shows, from its tree; "" in a window with none (an app drawn as a page). */
const addressIn = (nodes: TreeNode[]): string => nodes.find((node) => OMNIBOX.test(node.label))?.value ?? "";

/**
 * Whether a tree holds the page and not only the browser around it: a labelled node of a kind a page has (text, a
 * link, a field, an image) below the omnibox, or anywhere in a window with no omnibox. The tab strip, the toolbar and
 * the bookmarks are there whether or not the page's tree is, so they say nothing.
 */
function pageShown(nodes: TreeNode[]): boolean {
  const bar = nodes.find((node) => OMNIBOX.test(node.label) && node.frame !== null)?.frame;
  const top = bar ? bar[1] + bar[3] : Number.NEGATIVE_INFINITY;
  return nodes.some((node) => node.label !== "" && PAGE_ROLES.has(node.role) && node.frame !== null && node.frame[1] >= top);
}

/**
 * One read of a window of the hand's held over the user's windows for a moment, topmost and without activation, which
 * is what makes Chrome build a page's tree (measured: 54 ms, the seat untouched), and put back behind their windows.
 * The lift lasts that one read and no longer: a click of the user's in that moment would land in the hand's page, and
 * the pause it waits for (FLASH_QUIET_MS) was sized for a moment this short, as a guarded click's is.
 */
function liftedRead(hwnd: number, read: () => TreeReply): TreeReply {
  native.call("topmost", { hwnd, on: true });
  try {
    return read();
  } finally {
    native.call("topmost", { hwnd, on: false });
    native.call("sink", { hwnd }); // NOTOPMOST would leave it over the user's windows: back behind them
  }
}

/**
 * A page its lift's one read did not bring up, read again as it lies every LIFT_POLL_MS until it comes up or
 * LIFT_POLL_CAP_MS pass: Chrome may have begun its tree while the window showed and send it on after. Nothing is over
 * the user's windows meanwhile, and the seat's lock is not held.
 */
function awaitPage(reply: TreeReply, read: () => TreeReply): TreeReply {
  for (const end = performance.now() + LIFT_POLL_CAP_MS; !pageShown(reply.nodes) && performance.now() < end; ) {
    Bun.sleepSync(LIFT_POLL_MS);
    reply = read();
  }
  return reply;
}

/** A lift's result kept: the address a page came back at, or one more lift that brought none. */
function lifted(hwnd: number, address: string, shown: boolean): void {
  if (shown) {
    primed.set(hwnd, address);
    unlifted.delete(hwnd);
    return;
  }
  const before = unlifted.get(hwnd);
  unlifted.set(hwnd, { address, lifts: before?.address === address ? before.lifts + 1 : 1 });
}

/** Whether a read that found no page should lift the window: not at an address a lift already brought a page back at, nor past LIFTS_PER_PAGE at one it never did. */
function liftFor(hwnd: number, address: string): boolean {
  const tried = unlifted.get(hwnd);
  return primed.get(hwnd) !== address && !(tried?.address === address && tried.lifts >= LIFTS_PER_PAGE);
}

/**
 * Show a page of the hand's that reads as blank to its browser (the clicker, src/runner.ts): its window is lifted over
 * the user's for one read, once they pause, whether or not it was lifted before, and its tree read again behind their
 * windows for a moment until the page comes up. True when the page's own nodes came back, and, having done nothing,
 * for a window that shows already (the user may be watching it): the browser draws that page, and neither a lift nor a
 * borrow would show it any more. False, having done nothing, for a window that is not a browser window of the hand's
 * own or is on the hand's own desktop, and when the user did not pause.
 */
export function primePage(windowId: number): boolean {
  const list = windowList();
  const window = list.find((w) => w.hwnd === windowId);
  if (!window || !window.cls.startsWith("Chrome_WidgetWin") || window.cloaked || !isOwn(window, list)) return false;
  if (showing(windowId)) return true;
  const read = () => native.call("tree", { hwnd: windowId, cap: PRIME_NODES }) as TreeReply;
  try {
    const reply = awaitPage(pausedSync(() => liftedRead(windowId, read), "showing the page to the browser"), read);
    const shown = pageShown(reply.nodes);
    lifted(windowId, addressIn(reply.nodes), shown);
    return shown;
  } catch (error) {
    if (error instanceof SeatBusy) return false;
    throw error;
  }
}

/** The roles one control can show up as twice in UIA (a list item and its link, a button and its image), best first: the one kept. */
const ROLE_RANK = ["AXLink", "AXButton", "AXTab", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea", "AXComboBox", "AXPopUpButton", "AXMenuButton", "AXRow", "AXCell", "AXImage"];
const rank = (role: string): number => (ROLE_RANK.includes(role) ? ROLE_RANK.indexOf(role) : ROLE_RANK.length);
const CAPTION_BUTTONS = new Set(["minimize", "maximize", "restore", "close"]);
const EMPTY_CELL = /^[A-Z]{1,3}[0-9]{1,7}$/; // an empty cell of Excel's grid is named by its address alone
const TITLE_BAR_PX = 64; // how far down a window its title bar's buttons lie

/** How much of the smaller of two frames the other covers, over the larger's area: 1 for the same frame. */
function overlap([ax, ay, aw, ah]: Frame, [bx, by, bw, bh]: Frame): number {
  const w = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
  const h = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  return w <= 0 || h <= 0 ? 0 : (w * h) / Math.max(aw * ah, bw * bh, 1);
}

/**
 * What the shared walk found, less what only clutters a listing on Windows: one control listed twice, as a parent and
 * a child with the same name over nearly the same frame (the one with the better role stays); Excel's empty cells,
 * hundreds of them named by their address; the title bar's own buttons.
 */
function tidy(found: AxNode[], tree: Map<number, TreeNode>, window: WindowEntry | undefined): AxNode[] {
  const byRef = new Map(found.map((node) => [node.ref as number, node]));
  const dropped = new Set<AxNode>();
  const plain = (label: string) => label.toLowerCase().replace(/\s+/g, " ").trim();
  for (const node of found) {
    for (let at = tree.get(node.ref as number)?.parent, depth = 0; at !== undefined && at !== ROOT && depth < 4; at = tree.get(at)?.parent, depth++) {
      const parent = byRef.get(at);
      if (!parent || dropped.has(parent) || plain(parent.label) !== plain(node.label)) continue;
      if (overlap([node.x, node.y, node.w, node.h], [parent.x, parent.y, parent.w, parent.h]) < 0.6) continue;
      dropped.add(rank(node.role) < rank(parent.role) ? parent : node);
      break;
    }
  }
  const excel = window?.cls === "XLMAIN";
  const [wx, wy, ww] = window?.frame ?? [0, 0, 0];
  return found.filter((node) => {
    if (dropped.has(node)) return false;
    if (excel && (node.role === "AXRow" || node.role === "AXCell") && EMPTY_CELL.test(node.label)) return false;
    const titleBar = window !== undefined && node.y - wy < TITLE_BAR_PX && wx + ww - (node.x + node.w) < 240;
    return !(node.role === "AXButton" && titleBar && CAPTION_BUTTONS.has(node.label.toLowerCase()));
  });
}

/**
 * Labelled controls of one process: the on-screen ones in pixels, the pressable off-screen ones, and whether a cap
 * cut the walk short. `display` is the captured display's frame. The window named by id is walked alone, wherever it
 * sits in the stack; without one, the app's front-most window. Chrome builds a page's tree only once the page has
 * shown, so a covered Chromium window of the hand's own whose page reads with no tree (it loaded unseen, or was
 * navigated to) is lifted (without activation) for one read (see liftedRead), and read again behind the user's windows
 * for a moment when that read came too early (awaitPage), once per address that a lift brings a page back at. Never a
 * window of the user's, and not one on the hand's own desktop (a lift shows nothing there, and a browser is only taken
 * there when it needs none). The lifted window lies over the user's for the walk, where their click would land in it:
 * so the lift waits, a moment, for the user to pause, under the seat's lock, and when they do not, the page is read
 * without it (and looked at again next time). A field's value comes with it, when the helper read one.
 */
export function actionableElements(pid: number, display: Frame, options: WalkOptions<number> & { windowId?: number } = {}): [AxNode[], AxNode[], boolean] {
  const { windowId, ...walk } = options;
  const hwnd = windowId ?? mainWindowId(pid);
  if (hwnd === null) return [[], [], false];
  const list = windowList();
  const window = list.find((w) => w.hwnd === hwnd);
  const web = window ? window.cls.startsWith("Chrome_WidgetWin") : isWebContentApp(pid);
  const read = () => native.call("tree", { hwnd, cap: walk.nodeCap, ms: walk.timeCap === undefined ? undefined : Math.round(walk.timeCap * 1000) }) as TreeReply;
  // Read as it lies first: a page whose tree is on needs no lift. One with none is lifted at an address no lift has
  // brought its page back at yet, so a page navigated to is lifted too; one that stays blank, only a couple of times.
  let reply = read();
  if (web && window !== undefined && !window.cloaked && isOwn(window, list) && !pageShown(reply.nodes) && liftFor(hwnd, addressIn(reply.nodes)) && !showing(hwnd)) {
    const address = addressIn(reply.nodes);
    try {
      reply = awaitPage(pausedSync(() => liftedRead(hwnd, read), "the first read of the page", FLASH_QUIET_MS, LIFT_WAIT_MS), read);
      lifted(hwnd, address, pageShown(reply.nodes));
    } catch (error) {
      if (!(error instanceof SeatBusy)) throw error; // the user is busy: read as it lies, and lifted another time
    }
  }
  const byId = new Map<number, TreeNode>();
  const kids = new Map<number, number[]>();
  for (const node of reply.nodes) {
    byId.set(node.id, node);
    const siblings = kids.get(node.parent) ?? (kids.set(node.parent, []), kids.get(node.parent)!);
    siblings.push(node.id);
  }
  const children = (id: number) => kids.get(id) ?? [];
  const attrs = (id: number): AxAttrs => {
    const node = byId.get(id);
    return node ? { role: node.role, label: node.label, frame: node.frame } : { role: "AXApplication", label: "", frame: null };
  };
  const actions = (id: number) => byId.get(id)?.actions ?? [];
  const [found, offscreen, capped] = walkActionable(ROOT, children, attrs, actions, display, walk);
  const mine = window !== undefined && isOwn(window, list);
  for (const node of [...found, ...offscreen]) {
    live.add(node.ref as number);
    if (web) {
      webRefs.set(node.ref as number, mine);
      refWindows.set(node.ref as number, hwnd);
    }
    else webRefs.delete(node.ref as number); // an id the helper gave out again, since an earlier look
    const value = byId.get(node.ref as number)?.value;
    if (value !== undefined) node.value = value; // what the field holds, which the listing shows after its label
  }
  return [tidy(found, byId, window), offscreen, capped || reply.capped];
}

// ------------------------------------------------------------------ for the orchestrator

/**
 * One picture of a window for the panel, a JPEG at most `maxPx` wide, handed over in the helper's reply rather than
 * through a file. A minimized window is never restored for it (the user put it there), and a window that draws
 * nothing (see Blank in windows.cs) is said to be blank rather than sent as a black box. Null when the window is gone.
 */
export type Thumbnail = { jpeg: Uint8Array } | { blank: true } | { minimized: true } | null;
export function thumbnail(windowId: number, maxPx: number): Thumbnail {
  let reply: { gone?: boolean; minimized?: boolean; blank?: boolean; bytes?: string };
  try {
    reply = native.call("capture", { hwnd: windowId, format: "jpeg", max: Math.round(maxPx), restore: false, inline: true });
  } catch {
    return null;
  }
  if (reply.gone) return null;
  if (reply.minimized) return { minimized: true };
  if (reply.blank || !reply.bytes) return { blank: true };
  return { jpeg: new Uint8Array(Buffer.from(reply.bytes, "base64")) };
}

/**
 * Bring a window to the user: onto the desktop on screen, on a screen, restored, and in front. Called in the process of
 * the hand whose window it is (src/agent.ts, "show"), which knows where it keeps it: a window it parked comes back
 * where it was and stays there, and its watcher then leaves it be while the user has it, and for a while after (see
 * keepOnDesktop), however recently the hand acted. Called anywhere else (the hand is gone), it still works: a window
 * that lies on no screen at all is brought onto the primary one before it is activated, so that nothing invisible ever
 * takes the user's keyboard.
 */
export function present(windowId: number): boolean {
  const list = windowList();
  const entry = list.find((w) => w.hwnd === windowId);
  if (!entry) return false;
  if (entry.cloaked) {
    try {
      native.call("recall", { hwnd: windowId });
    } catch {
      // the shell's desktops do not answer: activating it may still switch the user there
    }
  }
  sent.delete(windowId); // the user has it now: it is not sent back to the hand's desktop
  parked.delete(windowId); // nor parked again after a borrow
  handBack = null; // nor taken back from them as if it had come up by itself after the hand's last action
  try {
    native.call("unpark", { hwnd: windowId }); // back where it was; or, parked by a helper that is gone, onto a screen
  } catch {
    // the window went away: activating it says so
  }
  inFront.set(rootOf(entry, list).hwnd, performance.now());
  return Boolean((native.call("activate", { hwnd: windowId }) as { ok: boolean }).ok);
}

/**
 * Remove every "Hands: …" desktop a run left behind (a hand killed with no chance to take its own down, a crash), with
 * whatever is on them brought behind the user's windows on the desktop on screen; how many were removed. Nothing when
 * the shell's desktops do not answer.
 */
export function sweepDesktops(): number {
  try {
    return (native.call("removeDesktops", { prefix: DESKTOP_PREFIX }) as { removed: number }).removed;
  } catch {
    return 0;
  }
}

/**
 * A hand is being dismissed: a borrow or a guarded click it is in the middle of gives the seat back (abandonSeat), the
 * browser windows it opened are closed (unless `keepBrowser`), its other windows left behind the user's on the
 * desktop on screen, where they can find them, its desktop taken down, and its watcher stopped. Every browser window
 * of its comes back on a screen first, behind the user's windows: kept, where they can find it; closed, so that a page
 * that asks before it goes ("Leave site?") asks where it can be seen. A window that holds more tabs than the hand last
 * saw in it is not closed: a link the user opened from another app may have landed in it, the browser's last active
 * window. Nothing here throws: a window may be gone, or the helper.
 */
export function release(keepBrowser: boolean): void {
  abandonSeat();
  try {
    const list = windowList();
    for (const [windowId, pid] of browserWindows) {
      if (!list.some((w) => w.hwnd === windowId && w.pid === pid)) continue;
      const strangers = !keepBrowser && holdsUnseenTabs(windowId);
      if (unpark(windowId)) native.call("sink", { hwnd: windowId });
      if (strangers) console.error(`kept the browser window ${windowId}: it holds tabs this hand never saw, which may be the user's`);
      else if (!keepBrowser) native.call("close", { hwnd: windowId });
    }
  } catch {
    // the helper went away: its own end has put the windows back, and the user can close them
  }
  parked.clear();
  releaseDesktop();
}

const tabsSeen = new Map<number, number>(); // how many tabs each browser window of the hand's had when it last looked

/** Whether a browser window of the hand's holds more tabs now than when the hand last looked at it; false when it cannot be told. */
function holdsUnseenTabs(windowId: number): boolean {
  const seen = tabsSeen.get(windowId);
  if (seen === undefined) return false;
  try {
    return (native.call("browser", { hwnd: windowId }) as BrowserView).tabs.length > seen;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ a link of the user's in a window of the hand's

// A link the user opens from another app goes to the browser's last active window, and the browser brings that window
// forward. Measured: with the hand's window opened after the user's, and the user in another app, the link opened as a
// new tab in the hand's window, which took the foreground where it was parked, off every screen: the user saw nothing
// happen but their app losing the keyboard, and the hand's next action would have been in the user's tab. So that
// window is the user's from then on: it comes onto a screen, nothing more is sent into it, it is never closed with the
// hand's windows, and the hand is told, and opens another.
//
// Whose a new tab is, is told by when it came. Every input the hand sends into a browser window of its leaves that
// window unsettled, and a tab that comes in an unsettled window is the hand's (a link its click opened in a new tab,
// its own `browser` new_tab). The window settles when its tabs are counted SETTLE_MS after the hand's last input, which
// the watcher sees to within a second, awake or not: a tab that comes after that is not the hand's. A link of the
// user's that lands in those few seconds after the hand's own input there is taken for the hand's, the one case missed.

/** Said to the model when a window of its has been given up to the user; the tools say it too, as they forget the window. */
export const LINK_LANDED =
  "a link the user opened from another app landed in your browser window (the browser puts one in the window it had in front last), so that window is theirs now and nothing more is done in it: `browser` open a url for a new window of your own";

const givenUp = new Set<number>(); // browser windows of the hand's that a link of the user's landed in: theirs now

/** Whether a browser window of the hand's has been given up to the user, a link of theirs having landed in it. */
export function isGivenUp(windowId: number): boolean {
  return givenUp.has(windowId);
}

const SETTLE_MS = 3000; // how long after the hand's input into its window a tab of its own may still come
const touchedAt = new Map<number, number>(); // when the hand last sent input into each browser window of its
const unsettled = new Set<number>(); // browser windows the hand has sent input into whose tabs have not been counted since, SETTLE_MS on
let frontBefore = 0; // the window in front at the watcher's last look

/** The hand is sending input into a window, or has just sent it (after any wait for the user to pause): a tab that comes in it for SETTLE_MS is the hand's. */
function touch(hwnd: number): void {
  if (!browserWindows.has(hwnd)) return;
  touchedAt.set(hwnd, performance.now());
  unsettled.add(hwnd);
}

/**
 * Count a browser window's tabs (viewOf): what came while the window was unsettled becomes the hand's, and the window
 * settles once SETTLE_MS have gone since the hand's last input; a tab more than that is a link of the user's, and the
 * window is given up. Nothing here throws.
 */
function countTabs(hwnd: number): void {
  try {
    viewOf(hwnd);
  } catch {
    // busy, or gone: counted next time
  }
}

/**
 * Settle the windows the hand acted in, once their tabs have had SETTLE_MS to come. Then the window in front: when a
 * browser window of the hand's has come forward that nothing the hand is doing brought there, the browser brought it
 * for a link of the user's, or the user did (its taskbar button, Alt+Tab). One that holds a tab the hand did not open
 * is given up to the user. Any other is theirs to look at, as Show makes it: back on a screen from where it was parked,
 * and left in front (see keepOnDesktop); unless it came up by itself, the hand's last action's doing or no one's, which
 * takeBack and keepOnDesktop see to. Asked by the watcher every second, and before anything is sent into a browser
 * window of the hand's.
 */
function watchLinks(): void {
  if (browserWindows.size === 0 || borrowed !== null || guarding) return;
  const now = performance.now();
  for (const hwnd of [...unsettled]) if (now - (touchedAt.get(hwnd) ?? 0) >= SETTLE_MS) countTabs(hwnd);
  const front = frontWindow();
  const came = front !== frontBefore;
  frontBefore = front;
  if (!came || !browserWindows.has(front)) return;
  countTabs(front);
  if (givenUp.has(front)) return;
  if ((handBack && now <= handBack.until) || cameByItself(front, now)) return;
  if (unpark(front)) inFront.set(front, now);
}

/** The window is the user's from now on: on a screen where they can find it (in front, if the browser brought it there), and no longer the hand's to work in, sink or close. */
function giveUp(hwnd: number): void {
  givenUp.add(hwnd);
  own.delete(hwnd);
  browserWindows.delete(hwnd);
  tabsSeen.delete(hwnd);
  touchedAt.delete(hwnd);
  unsettled.delete(hwnd);
  seenBehind.delete(hwnd);
  inFront.set(hwnd, performance.now());
  try {
    if (unpark(hwnd) && frontWindow() !== hwnd) native.call("sink", { hwnd });
  } catch {
    // the window went away: nothing left to show
  }
  console.error(`a link the user opened landed in the browser window ${hwnd}, which is theirs now`);
}

/**
 * Before anything is sent into a window: LINK_LANDED, when it is a browser window of the hand's that a link of the
 * user's has landed in. A settled window's tabs are counted first, since a link that the browser could only flash on
 * the taskbar lands with nothing in front to say so. The window is then unsettled by the input (touch).
 */
function refuseTheirs(hwnd: number): void {
  if (browserWindows.has(hwnd)) {
    watchLinks();
    if (!givenUp.has(hwnd) && !unsettled.has(hwnd)) countTabs(hwnd);
  }
  if (givenUp.has(hwnd)) throw new Error(LINK_LANDED);
  touch(hwnd);
}

/**
 * As the process ends, however it ends (a run from the command line that is done, an error, process.exit): what the
 * hand has out is put back from here too. A borrow or a guarded click gives the seat back, and every browser window it
 * parked comes back on screen behind the user's windows, kept, since its pages may be what the user was told to look
 * at; its desktop goes. After a managed close there is nothing left to do. A hand that is killed runs none of this,
 * and its helper does the same as it sees Bun go (Program.Leave in windows.cs).
 */
export function onExit(): void {
  abandonSeat();
  if (parked.size > 0 || desktopMade) release(true);
}
process.on("exit", onExit);
