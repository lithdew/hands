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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ABORT_CORNER_PX } from "./config.ts";
import {
  AX_PRESS, type AxAttrs, type Display as MacDisplay, MIN_WINDOW_SIDE_PT, type OcrLine, type PinnedWindow, type PointerTarget,
  type Tab, type TabCommand, type WalkOptions, type WindowSelector, walkActionable,
} from "./macos.ts"; // prettier-ignore
import { Abort, type AxNode, type Box, type Capture, type Field, type Frame, type Point } from "./models.ts";

export {
  AX_ACTIONABLE_ROLES, AX_FANOUT, AX_LABEL_DESCENDANT_ROLES, AX_LABEL_PARENT_ROLES, AX_MESSAGE_TIMEOUT, AX_MIN_SIDE_PT, AX_NODE_CAP, AX_OFFSCREEN_CAP,
  AX_PRESS, AX_SKIP_SUBTREE_ROLES, AX_TIME_CAP, AX_VALUE_CHARS, type AxAttrs, clickable, descendantLabel, MIN_WINDOW_SIDE_PT, type OcrLine,
  offDisplay, type PinnedWindow, type PointerTarget, subtreeKey, type Tab, type TabCommand, type WalkOptions, walkActionable, type WindowSelector,
} from "./macos.ts"; // prettier-ignore
export type Display = MacDisplay;

const EVENT_DELAY_MS = 40;
const DRAG_STEP_PT = 6; // distance between the drag events along a stroke
const DRAG_DELAY_MS = 8;

// Virtual-key codes. Chords go by key code, so they follow the US layout; typed text does not.
export const KEYCODES: Record<string, number> = {
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48, i: 0x49, j: 0x4a, k: 0x4b, l: 0x4c, m: 0x4d, n: 0x4e, o: 0x4f, p: 0x50,
  q: 0x51, r: 0x52, s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58, y: 0x59, z: 0x5a,
  "0": 0x30, "1": 0x31, "2": 0x32, "3": 0x33, "4": 0x34, "5": 0x35, "6": 0x36, "7": 0x37, "8": 0x38, "9": 0x39,
  return: 0x0d, enter: 0x0d, tab: 0x09, space: 0x20, delete: 0x08, backspace: 0x08, forwarddelete: 0x2e, escape: 0x1b, esc: 0x1b,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  ";": 0xba, "=": 0xbb, ",": 0xbc, "-": 0xbd, ".": 0xbe, "/": 0xbf, "`": 0xc0, "[": 0xdb, "\\": 0xdc, "]": 0xdd, "'": 0xde,
}; // prettier-ignore
/** Modifier virtual keys. "cmd" is Ctrl here: what the shared code means by a shortcut. */
export const MODIFIERS: Record<string, number> = {
  cmd: 0x11, command: 0x11, ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, option: 0x12, opt: 0x12, win: 0x5b,
}; // prettier-ignore

// ------------------------------------------------------------------ the helper

const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const FRAMEWORK = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319";
const SOURCES = [join(import.meta.dir, "windows.cs"), join(import.meta.dir, "overlay.cs"), join(import.meta.dir, "panel.cs"), join(import.meta.dir, "vendor", "VirtualDesktop11-24H2.cs")];

/** The helper's exe, built from windows.cs, overlay.cs, panel.cs and the vendored virtual-desktop library into %LOCALAPPDATA%\hands when that build is not there yet. */
export function helperPath(): string {
  const dir = join(process.env.LOCALAPPDATA ?? tmpdir(), "hands");
  const sources = SOURCES.map((path) => readFileSync(path, "utf8"));
  const hash = createHash("sha1").update(sources.join("\n")).digest("hex").slice(0, 12);
  const exe = join(dir, `hands-${hash}.exe`);
  if (existsSync(exe)) return exe;
  mkdirSync(dir, { recursive: true });
  const refs = ["UIAutomationClient.dll", "UIAutomationTypes.dll", "WindowsBase.dll", "System.Drawing.dll", "System.Windows.Forms.dll", `${FRAMEWORK}\\System.Runtime.dll`, `${FRAMEWORK}\\System.Runtime.WindowsRuntime.dll`];
  const winmds = ["Foundation", "Globalization", "Graphics", "Media", "Storage"].map((name) => `C:\\Windows\\System32\\WinMetadata\\Windows.${name}.winmd`);
  // /main: the vendored library carries a command-line tool's entry point of its own.
  const built = Bun.spawnSync([CSC, "/nologo", "/optimize+", "/target:winexe", "/platform:x64", "/main:Program", `/out:${exe}`, `/lib:${FRAMEWORK}\\WPF`, ...[...refs, ...winmds].map((r) => `/r:${r}`), ...SOURCES], { stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0 || !existsSync(exe)) throw new Error(`cannot build the Windows helper: ${built.stdout.toString().trim() || built.stderr.toString().trim()}`);
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
      if (code !== null) throw new Error(`the Windows helper ${exe} exited with code ${code} right after starting${code === 1 || code === -1073741819 ? "" : " (Smart App Control may have blocked it: check the notification, or allow the file)"}`);
      if (Date.now() > end) throw new Error(`cannot connect to the Windows helper (error ${error})`);
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
      if (!this.k32.WriteFile(this.handle, ptr(buffer, off), buffer.length - off, ptr(this.count), null)) throw new Error(`the Windows helper went away (write error ${this.k32.GetLastError()})`);
    }
  }

  private readExact(buffer: Buffer, length: number): void {
    for (let off = 0; off < length; off += this.count[0]!) {
      if (!this.k32.ReadFile(this.handle, ptr(buffer, off), length - off, ptr(this.count), null) || this.count[0] === 0) throw new Error(`the Windows helper went away (read error ${this.k32.GetLastError()})`);
    }
  }

  call(request: string): string {
    const body = Buffer.from(request, "utf8");
    const message = Buffer.allocUnsafe(4 + body.length);
    message.writeUInt32LE(body.length, 0);
    body.copy(message, 4);
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

let kernel: Kernel | undefined;
let helper: Helper | undefined;
let helperFailure: Error | undefined;

/** One synchronous round trip to the helper. Tests replace `call`; nothing else here reaches the machine. */
export const native = {
  call(command: string, args: object = {}): any {
    if (!helper) {
      try {
        helper = new Helper((kernel ??= bindKernel()), helperPath());
      } catch (error) {
        helperFailure = error as Error;
        throw error;
      }
    }
    let reply: string;
    try {
      reply = helper.call(JSON.stringify({ cmd: command, ...args }));
    } catch (error) {
      helper.close();
      helper = undefined;
      throw error;
    }
    const parsed = JSON.parse(reply);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) throw new Error(`${command}: ${parsed.error}`);
    return parsed;
  },
};

const sleep = (ms: number) => Bun.sleep(ms);

// ------------------------------------------------------------------ escape hatch

let interrupted = false;
/** Ctrl-C lands here so a run unwinds through the same path as the mouse corner, and still writes its summary. */
export function interrupt(on = true): void {
  interrupted = on;
}

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

/** Input for the seat goes through SendInput: it lands wherever the focus is, exactly as the user's would. */
const input = async (args: object, delay = EVENT_DELAY_MS) => {
  native.call("input", args);
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

/** The window keys for a process go to: its front window, whose thread says which control has the focus. */
function keyWindow(pid: number): number {
  const id = appWindows(pid)[0]?.id;
  if (id === undefined) throw new Error(`process ${pid} has no window to type into`);
  return id;
}

/** A key, with modifiers, to the seat; or, with a pid, posted to that process's window, which need not be in front. Posted keys carry no modifiers. */
export async function press(key: string, modifiers: string[] = [], pid?: number): Promise<void> {
  const code = KEYCODES[key.toLowerCase()];
  if (code === undefined) throw new Error(`unknown key ${JSON.stringify(key)}`);
  const mods = modifiers.map((name) => {
    const vk = MODIFIERS[name.toLowerCase()];
    if (vk === undefined) throw new Error(`unknown modifier ${JSON.stringify(name)}`);
    return vk;
  });
  if (pid === undefined) await input({ kind: "key", vk: code, modifiers: mods });
  else {
    native.call("vkey", { hwnd: keyWindow(pid), vk: code });
    await sleep(EVENT_DELAY_MS);
  }
}

/** Text to the seat as Unicode key events; or, with a pid, as characters posted to that process's window. */
export async function typeText(text: string, pid?: number): Promise<void> {
  if (!text) return;
  if (pid === undefined) await input({ kind: "text", text });
  else native.call("chars", { hwnd: keyWindow(pid), text });
}

/** Long text goes through the clipboard: one paste instead of two events per character. */
export async function pasteText(text: string): Promise<void> {
  native.call("clipboard", { text });
  await press("v", ["ctrl"]);
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
  frame: Frame;
  core: number; // a UWP app's own window inside its frame, where its keys go; 0 otherwise
  cloaked?: boolean; // on another virtual desktop (a hand's own), so not on screen
}

/** The helper's window list, front to back, the ones on other virtual desktops included. */
const windowList = (): WindowEntry[] => native.call("windows") as WindowEntry[];

/** Whether a window lies on a virtual desktop other than the one on screen. */
const cloaked = (windowId: number): boolean => windowList().some((w) => w.hwnd === windowId && w.cloaked === true);

// ------------------------------------------------------------------ the hand's own desktop

// Each hand works on a virtual desktop of its own, so nothing it opens lands among the user's windows: the app it
// starts always, its browser window when the browser can work unseen (see browserUnoccluded). The desktop is made
// on first use and removed as this process ends; HANDS_DESKTOP=0 keeps everything on the current desktop.

/** The name the desktop goes by: "Hands: Lefty". */
export const desktopName = (): string => `Hands: ${process.env.HANDS_NAME || "Hands"}`;

export const desktopsEnabled = (): boolean => process.env.HANDS_DESKTOP !== "0";

let desktopMade = false;
let ownBrowserWindow: number | null = null; // the browser window this hand opened and moved to its desktop
const sent = new Set<number>(); // the windows this hand moved to its desktop

/** Move a window this hand opened to its desktop, making the desktop first, and see that it got there. False when desktops are off, or the shell kept the window here. */
async function sendToDesktop(windowId: number): Promise<boolean> {
  if (!desktopsEnabled()) return false;
  const name = desktopName();
  if (!desktopMade) {
    native.call("desktop", { name });
    desktopMade = true;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    native.call("send", { hwnd: windowId, name });
    await sleep(attempt === 0 ? 50 : 300); // the shell cloaks the window a beat after the move; a window still opening can take a second try
    if (cloaked(windowId)) break;
  }
  sent.add(windowId); // moved by the shell's account, whether or not the cloak has landed yet: from here on it is kept there
  return true;
}

/**
 * Put back any window of the hand's that the shell has brought onto the desktop on screen: an app that activates
 * itself on an accessibility action (Notepad on "Add New Tab", measured) is moved there by Windows. Asked after each
 * such action and before each capture; one window list when nothing has moved.
 */
function keepOnDesktop(): void {
  if (sent.size === 0) return;
  const list = windowList();
  for (const windowId of sent) {
    const entry = list.find((w) => w.hwnd === windowId);
    if (!entry) sent.delete(windowId);
    else if (!entry.cloaked) native.call("send", { hwnd: windowId, name: desktopName() });
  }
}

/** The names of every virtual desktop, in order. */
export const desktops = (): string[] => native.call("desktops") as string[];

/** Switch the screen to a desktop by name. */
export function switchDesktop(name: string): void {
  native.call("switch", { name });
}

/** Remove a desktop by name; Windows moves what is left on it to the current desktop. A desktop that is not there is nothing to do. */
export function removeDesktop(name: string = desktopName()): void {
  try {
    native.call("removeDesktop", { name });
  } catch {
    // the desktop is already gone, or the shell would not part with it: nothing more to do at exit
  }
}

/** Leave the hand's desktop: its browser window, if it still has one there, is closed, and the desktop removed. Windows moves whatever else is left on it to the desktop on screen. */
export function releaseDesktop(): void {
  if (!desktopMade) return;
  desktopMade = false;
  sent.clear();
  if (ownBrowserWindow !== null) {
    try {
      if (windowList().some((w) => w.hwnd === ownBrowserWindow)) native.call("close", { hwnd: ownBrowserWindow });
    } catch {
      // the window is already gone
    }
    ownBrowserWindow = null;
  }
  removeDesktop();
}
process.on("exit", () => {
  if (helper) releaseDesktop(); // with no helper up there is nothing to take down, and this is no time to start one
});

/** The names an app goes by and the executable behind each. */
const EXES: Record<string, string> = {
  "google chrome": "chrome.exe", chrome: "chrome.exe", "microsoft edge": "msedge.exe", edge: "msedge.exe", calculator: "CalculatorApp.exe",
  notepad: "Notepad.exe", paint: "mspaint.exe", "windows terminal": "WindowsTerminal.exe", explorer: "explorer.exe", "file explorer": "explorer.exe",
}; // prettier-ignore
/** What ShellExecute is handed to start an app, where it differs from the process that then runs. */
const LAUNCHERS: Record<string, string> = { "CalculatorApp.exe": "calc.exe", "Notepad.exe": "notepad.exe" };
const NAMES: Record<string, string> = { chrome: "Google Chrome", msedge: "Microsoft Edge" };

const exeOf = (app: string): string => EXES[app.toLowerCase()] ?? (app.toLowerCase().endsWith(".exe") ? app : `${app}.exe`);

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
  return (native.call("processes", { exe: exeOf(app) }) as { pid: number; cmd: string }[])
    .filter(({ cmd }) => !/\s--type=/.test(cmd))
    .map(({ pid, cmd }) => ({ pid, cmd, automated: own === undefined ? AUTOMATION_FLAGS.test(cmd) : !cmd.includes(own) }));
}

/** Main processes of an app, by executable name. */
export async function appInstances(app: string): Promise<{ pid: number; automated: boolean }[]> {
  return (await instances(app)).map(({ pid, automated }) => ({ pid, automated }));
}

/** Whether a browser's command line, or the Chrome policy, has its native window occlusion tracking off. */
export function unoccludedBy(cmd: string, policy: string | null): boolean {
  const features = cmd.match(/--disable-features=("[^"]*"|\S+)/g) ?? [];
  if (features.some((flag) => /\bCalculateNativeWinOcclusion\b/.test(flag))) return true;
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

/** Start an executable without the foreground moving, and wait for the window it opens. The pid is the window's owner, since the launcher's can be a stub. */
async function launch(file: string, args: string, timeout: number): Promise<{ pid: number; windowId: number } | null> {
  const before = new Set(windowList().map((w) => w.hwnd));
  native.call("launch", { file, args, show: 4 }); // SW_SHOWNOACTIVATE
  for (const end = performance.now() + timeout * 1000; performance.now() < end; await sleep(150)) {
    // A UWP frame appears before the app's own window inside it, and until then carries the frame host's pid.
    const fresh = windowList().find((w) => !before.has(w.hwnd) && w.pid !== process.pid && (w.cls !== "ApplicationFrameWindow" || w.core !== 0));
    if (fresh) return { pid: fresh.pid, windowId: fresh.hwnd };
  }
  return null;
}

const launcherFor = (app: string): { file: string; args: string } => {
  const exe = exeOf(app);
  const profile = process.env.HANDS_BROWSER_PROFILE;
  const args = NAMES[basename(exe, ".exe").toLowerCase()] && profile ? `--user-data-dir="${profile}" --no-first-run --no-default-browser-check` : "";
  return { file: NAMES[basename(exe, ".exe").toLowerCase()] ? browserPath(exe) : (LAUNCHERS[exe] ?? exe), args };
};

/** The app's pid, started if it was not running, without it coming forward or taking the keyboard. */
export async function runInBackground(app: string, timeout = 8.0): Promise<number | null> {
  const pid = await userInstance(app);
  if (pid !== null) return pid;
  const { file, args } = launcherFor(app);
  const opened = await launch(file, args, timeout);
  if (!opened) throw new Error(`${app} opened no window`);
  userPids.set(app, opened.pid);
  const window = appWindows(opened.pid).some((w) => w.id === opened.windowId) ? opened.windowId : mainWindowId(opened.pid);
  // A UWP app (Calculator: an ApplicationFrameWindow) stays here: on a desktop that is not shown its accessibility tree
  // empties and its frame paints black (measured). Any other app's window goes to the hand's desktop.
  const uwp = windowList().some((w) => w.hwnd === window && w.cls === "ApplicationFrameWindow");
  if (window !== null && (uwp || !(await sendToDesktop(window)))) native.call("sink", { hwnd: window }); // shown without activation, but that can still be on top of the user's windows
  return opened.pid;
}

/** Bring an app to the front and confirm it got there. */
export async function activate(app: string, timeout = 3.0): Promise<boolean> {
  let pid = await userInstance(app);
  if (pid === null) {
    const { file, args } = launcherFor(app);
    pid = (await launch(file, args, timeout))?.pid ?? null;
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

/** The browser's windows, front to back, and its view of one: `window` by place (1 is the front one) or by String(hwnd), which outlives reordering. */
async function browserWindow(browser: string, window?: WindowSelector): Promise<{ hwnd: number; index: number; view: BrowserView } | null> {
  const pid = await userInstance(browser);
  if (pid === null) return null;
  const all = appWindows(pid);
  const index = typeof window === "string" ? all.findIndex((w) => String(w.id) === window) : (window ?? 1) - 1;
  const hwnd = all[index]?.id;
  if (hwnd === undefined) return null;
  return { hwnd, index, view: native.call("browser", { hwnd }) as BrowserView };
}

const fullUrl = (view: BrowserView): string | null => view.url ?? (view.omniboxValue ? (/^[a-z]+:/i.test(view.omniboxValue) ? view.omniboxValue : `https://${view.omniboxValue}`) : null);

export async function browserTabs(browser: string): Promise<Tab[]> {
  const pid = await userInstance(browser);
  if (pid === null) return [];
  return appWindows(pid).flatMap(({ id }, w) => {
    const view = native.call("browser", { hwnd: id }) as BrowserView;
    return view.tabs.map((tab, t) => ({ scripted: String(id), window: w + 1, tab: t + 1, active: tab.active, title: tab.title, url: tab.active ? (fullUrl(view) ?? "") : "" }));
  });
}

/** The front window's active tab URL in the user's browser. A browser that is not running answers null rather than being launched. */
export async function browserUrl(browser: string, window?: WindowSelector): Promise<string | null> {
  const at = await browserWindow(browser, window).catch(() => null);
  return at ? fullUrl(at.view) : null;
}

/** A posted click at the center of a frame in a window: it lands there whether or not the window is in front. */
async function postClick(hwnd: number, frame: Frame, count = 1): Promise<void> {
  const [x, y] = [Math.round(frame[0] + frame[2] / 2), Math.round(frame[1] + frame[3] / 2)];
  native.call("post", { hwnd, kind: "move", x, y });
  for (let click = 0; click < count; click++) {
    native.call("post", { hwnd, kind: "down", x, y });
    native.call("post", { hwnd, kind: "up", x, y });
  }
  await sleep(EVENT_DELAY_MS);
}

/** Navigate one window from behind: a click selects the omnibox's whole text, the URL replaces it, Enter goes. */
async function navigateBehind(hwnd: number, url: string): Promise<boolean> {
  for (const end = performance.now() + 3000; performance.now() < end; await sleep(150)) {
    const view = native.call("browser", { hwnd }) as BrowserView;
    if (!view.omnibox) continue;
    await postClick(hwnd, view.omnibox);
    native.call("chars", { hwnd, text: url });
    native.call("vkey", { hwnd, vk: 0x0d });
    return true;
  }
  return false;
}

/** The exe and the arguments that open `url` in the user's browser: its single instance takes them over and opens the window. */
const browserCommand = (browser: string, url: string, newWindow: boolean) => {
  const { file, args } = launcherFor(browser);
  return { file, args: `${args} ${newWindow ? "--new-window " : ""}"${url}"`.trim() };
};

/**
 * Show a URL in the user's browser: a new tab of a window by default, or the tab named, and bring the browser forward.
 * In the background, a new window comes from the browser's own command line (Chrome activates it, and the seat is
 * handed straight back); a tab of an existing window is navigated by keys posted to its omnibox, which takes nothing.
 */
export async function openUrl(
  browser: string,
  url: string,
  options: { newTab?: boolean; newWindow?: boolean; window?: WindowSelector; tab?: number; background?: boolean } = {},
): Promise<boolean> {
  const fresh = options.newTab ?? true;
  if (!options.background) {
    const { file, args } = browserCommand(browser, url, options.newWindow ?? false);
    native.call("launch", { file, args, show: 1 });
    return activate(browser);
  }
  const seat = (native.call("foreground") as { hwnd: number }).hwnd;
  let pid = await userInstance(browser);
  const at = options.newWindow || pid === null ? null : await browserWindow(browser, options.window);
  if (!at) {
    const { file, args } = browserCommand(browser, url, true);
    const opened = await launch(file, args, 8);
    if (!opened) throw new Error(`${browser} opened no window`);
    if (pid === null) userPids.set(browser, (pid = opened.pid));
    await returnSeat(seat, pid);
    return true;
  }
  if (options.tab !== undefined) {
    const tab = at.view.tabs[options.tab - 1];
    if (tab?.frame) await postClick(at.hwnd, tab.frame);
  } else if (fresh && at.view.buttons["New Tab"]) {
    await postClick(at.hwnd, at.view.buttons["New Tab"]);
    await sleep(300);
  }
  return navigateBehind(at.hwnd, url);
}

/**
 * Give the seat back to the window that had it, each time the browser takes it: the one visible moment of opening a
 * window from behind. Chrome activates a beat after the window exists, and once more when it shows a bubble over it,
 * so this watches for a while after the first handback.
 */
async function returnSeat(seat: number, taker: number, window?: number): Promise<void> {
  let returned = 0;
  for (const end = performance.now() + 2500; performance.now() < end && (returned === 0 || performance.now() < returned + 800); await sleep(50)) {
    const front = native.call("foreground") as { hwnd: number; pid: number };
    if (front.pid !== taker) continue;
    native.call("activate", { hwnd: seat });
    if (window !== undefined) native.call("sink", { hwnd: window }); // and the window itself goes behind the user's, not only behind the one in front
    returned = performance.now();
  }
  if (window !== undefined) native.call("sink", { hwnd: window });
}

/** Whether the front window's active tab is still loading: the toolbar shows Stop instead of Reload. A browser that is not running is not. */
export async function browserLoading(browser: string, window?: WindowSelector): Promise<boolean> {
  const at = await browserWindow(browser, window).catch(() => null);
  return at?.view.loading ?? false;
}

/** Act on a tab of the user's browser. Returns the tab it acted on as `title | url`, or null when there is no such tab. */
export async function tabCommand(browser: string, command: TabCommand, window?: WindowSelector, tab?: number, background = false): Promise<string | null> {
  const at = await browserWindow(browser, window);
  if (!at) return null;
  const { hwnd, view } = at;
  const target = tab === undefined ? view.tabs.find((t) => t.active) : view.tabs[tab - 1];
  if (!target) return null;
  const description = `${target.title} | ${target.active ? (fullUrl(view) ?? "") : ""}`;
  if (command === "switch_tab") {
    if (tab !== undefined && target.frame) await postClick(hwnd, target.frame);
    if (!background) await activate(browser);
  } else if (command === "close_tab") {
    if (!target.active && target.frame) await postClick(hwnd, target.frame); // the close button only shows on a tab that is wide enough: bring it up first
    const now = tab === undefined ? target : ((native.call("browser", { hwnd }) as BrowserView).tabs[tab - 1] ?? target);
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
  const lock = join(tmpdir(), "hands-open-window.lock");
  for (const end = Date.now() + 20_000; Date.now() < end; await sleep(100)) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0) > 15_000) rmSync(lock, { recursive: true, force: true });
    }
  }
  try {
    return await openWindowAlone(browser, url);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

async function openWindowAlone(browser: string, url: string): Promise<PinnedWindow> {
  const seat = (native.call("foreground") as { hwnd: number }).hwnd;
  let pid = await userInstance(browser);
  const before = new Set(pid === null ? [] : appWindows(pid).map((w) => w.id));
  const { file, args } = browserCommand(browser, url, true);
  native.call("launch", { file, args, show: 4 });
  let opened: PinnedWindow | null = null;
  for (const end = performance.now() + 8000; !opened && performance.now() < end; await sleep(100)) {
    if (pid === null) pid = await userInstance(browser);
    const windowId = pid === null ? undefined : appWindows(pid).find((w) => !before.has(w.id))?.id;
    if (pid !== null && windowId !== undefined) opened = { pid, windowId, scripted: String(windowId) };
  }
  if (!opened) throw new Error(`${browser} opened no new window`);
  await returnSeat(seat, opened.pid, opened.windowId);
  // Once the seat is back: a browser that works unseen takes its window to the hand's desktop; any other keeps it here, sunk behind the user's.
  if ((await browserUnoccluded(browser)) && (await sendToDesktop(opened.windowId))) ownBrowserWindow = opened.windowId;
  return opened;
}

/** The frontmost app's topmost on-screen window as x, y, w, h in pixels. Pass the pid when the caller already has it. */
export async function frontmostWindowBounds(pid?: number | null): Promise<Frame | null> {
  return appWindows(pid ?? (await frontmostPid()))[0]?.frame ?? null;
}

export interface AppWindow {
  id: number; // the HWND
  frame: Frame;
}

/** An app's ordinary windows, front to back, those on the hand's own desktop included. One that is covered by another still counts; a minimized one does not. */
export function appWindows(pid: number): AppWindow[] {
  return windowList()
    .filter((w) => w.pid === pid && w.frame[2] > MIN_WINDOW_SIDE_PT && w.frame[3] > MIN_WINDOW_SIDE_PT)
    .map(({ hwnd, frame }) => ({ id: hwnd, frame }));
}

/** Every ordinary window on the desktop on screen, front to back. All are solid: the hand's overlay is a tool window, which the list leaves out. */
export function allWindows(): (AppWindow & { pid: number; alpha: number })[] {
  return windowList()
    .filter((w) => !w.cloaked)
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

/** One window as a PNG, cropped to its visible frame. DWM renders it whole even when other windows cover it; a minimized one is restored first, without activation. */
export async function screenshotWindow(windowId: number, path: string): Promise<Capture> {
  keepOnDesktop();
  const { width, height } = native.call("capture", { hwnd: windowId, path, format: "png" }) as { width: number; height: number };
  return { path, width, height };
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
  const [x1, y1] = rect ? rect.map(Math.round) : [0, 0];
  const lines = native.call("ocr", { path, rect: rect?.map(Math.round) }) as [string, number, Box][];
  return lines.map(([text, confidence, [bx1, by1, bx2, by2]]) => [text, confidence, [x1! + bx1, y1! + by1, x1! + bx2, y1! + by2]]);
}

// ------------------------------------------------------------------ accessibility elements

// Element handles given out to a Screen stay in the helper's table until the next capture replaces them. Pressing
// one from an older capture is refused rather than sent to a control that is gone.
let live = new Set<number>();

/** Drop every handle the previous capture gave out. Perception calls this as a new capture starts. */
export function releaseElements(): void {
  live = new Set();
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
  try {
    return Boolean((native.call("act", { id: ref, action }) as { ok: boolean }).ok);
  } catch {
    return false;
  } finally {
    keepOnDesktop();
  }
};

/** Press an element: Invoke, Toggle, Select or Expand as it offers; on Chromium a posted click at its center, since every UIA action there takes the seat. */
export const axPress = (ref: unknown): boolean => act(ref, AX_PRESS);

/** AXConfirm is Enter posted to the element's window; AXScrollToVisible the scroll-item pattern. */
export const axPerform = (ref: unknown, action: string): boolean => act(ref, action);

/** Never: giving a control the focus through UIA activates its window, which is the seat. */
export const axFocus = (_ref: unknown): boolean => false;

/** Write an element's value. A classic edit control takes it as messages, a Chromium field as posted keys after a click, anything else through ValuePattern. */
export function axSetValue(ref: unknown, value: string): boolean {
  if (!alive(ref)) return false;
  try {
    return Boolean((native.call("setValue", { id: ref, text: value }) as { ok: boolean }).ok);
  } catch {
    return false;
  } finally {
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

/** Whether a process draws its windows with Chromium: a browser of that family, or anything whose windows are Chrome_WidgetWin. */
export function isWebContentApp(pid: number): boolean {
  let name = "";
  try {
    name = (native.call("exe", { pid }) as { name: string }).name.toLowerCase();
  } catch {
    // a process that is gone, or one this user may not open
  }
  return WEB_EXES.has(name) || windowList().some((w) => w.pid === pid && w.cls.startsWith("Chrome_WidgetWin"));
}

/** The window an app holds as key: its front-most window, whether or not the app is in front. */
export const keyWindowId = (pid: number): number | null => appWindows(pid)[0]?.id ?? null;

/** Nothing to do: a posted message reaches a window without the focus moving anywhere. */
export const focusWithoutRaise = (_windowId: number): boolean => true;

/**
 * A press, a run of drags through every point, a release: posted to one window as mouse messages, which it takes
 * whether or not anything covers it (measured on Chrome, covered and behind), and which never enter the input queue
 * of whatever the user is in. A path of one point is a click.
 */
export async function windowPointer(target: PointerTarget, path: Point[], options: { count?: number; onMove?: (at: Point) => void } = {}): Promise<void> {
  const [start, end] = [path[0], path[path.length - 1]];
  if (!start || !end) return;
  const post = async ([x, y]: Point, kind: string, delay: number) => {
    native.call("post", { hwnd: target.windowId, kind, x: Math.round(x), y: Math.round(y) });
    await sleep(delay);
  };
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
    await post(end, "up", 80);
  }
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
 * Make sure some of a window shows, moving it if it has to. A browser stops delivering input to a page it considers
 * hidden, and it considers a page hidden when its window is covered on every side, by anything. A strip at a screen's
 * edge is enough, so the window is slid until a corner of it lies over a spot that no window in front of it covers,
 * the rest of it staying behind them or off the screen. Nothing is raised, and nothing of the user's is moved. False
 * when every screen is covered edge to edge. A window on the hand's own desktop is left where it is: only a browser
 * that works unseen is taken there, and nothing of the user's lies over it.
 */
export async function revealWindow(_pid: number, windowId: number): Promise<boolean> {
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

/** The window an app itself considers current: its front-most one. That holds whether or not the app is in front. */
export const mainWindowId = (pid: number): number | null => appWindows(pid)[0]?.id ?? null;

/**
 * A menu command, by the path a person would read off the menu bar: ["File", "New"]. A path that ends on a menu lists
 * what is in it instead. Pressing a menu bar item opens its menu on screen (Windows has no way around that), and the
 * items are pressed where they are, so the app need not be in front.
 */
export function menu(pid: number, path: string[]): { pressed: string } | { items: string[] } {
  const hwnd = mainWindowId(pid);
  if (hwnd === null) throw new Error("this app has no window with a menu bar");
  try {
    return native.call("menu", { hwnd, path }) as { pressed: string } | { items: string[] };
  } finally {
    keepOnDesktop();
  }
}

/** Page a window's largest scroll area, or, when nothing in it takes that, a wheel posted at its center. */
export function scrollPage(_pid: number, windowId: number, direction: "up" | "down" | "left" | "right"): boolean {
  try {
    return Boolean((native.call("scrollPage", { hwnd: windowId, direction }) as { ok: boolean }).ok);
  } catch {
    return false;
  } finally {
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
}

const ROOT = -1;
const primed = new Set<number>(); // Chromium windows whose page tree has been switched on

/**
 * Labelled controls of one process: the on-screen ones in pixels, the pressable off-screen ones, and whether a cap
 * cut the walk short. `display` is the captured display's frame. The window named by id is walked alone, wherever it
 * sits in the stack; without one, the app's front-most window. Chrome builds its page tree on the first query it gets
 * while some of the window shows, so a covered Chromium window is lifted (without activation) for that first look;
 * one on the hand's own desktop is not (a lift shows nothing there, and a browser is only taken there when it needs none).
 */
export function actionableElements(pid: number, display: Frame, options: WalkOptions<number> & { windowId?: number } = {}): [AxNode[], AxNode[], boolean] {
  const { windowId, ...walk } = options;
  const hwnd = windowId ?? mainWindowId(pid);
  if (hwnd === null) return [[], [], false];
  const lift = isWebContentApp(pid) && !primed.has(hwnd) && !showing(hwnd) && !cloaked(hwnd);
  if (lift) native.call("topmost", { hwnd, on: true });
  let reply: { nodes: TreeNode[]; capped: boolean };
  try {
    reply = native.call("tree", { hwnd, cap: walk.nodeCap, ms: walk.timeCap === undefined ? undefined : Math.round(walk.timeCap * 1000) }) as { nodes: TreeNode[]; capped: boolean };
  } finally {
    if (lift) {
      native.call("topmost", { hwnd, on: false });
      native.call("sink", { hwnd }); // NOTOPMOST would leave it over the user's windows: back behind them
    }
  }
  if (reply.nodes.some((n) => n.role !== "AXGroup" || n.label)) primed.add(hwnd);
  const byId = new Map<number, TreeNode>();
  const kids = new Map<number, number[]>();
  for (const node of reply.nodes) {
    byId.set(node.id, node);
    const list = kids.get(node.parent) ?? (kids.set(node.parent, []), kids.get(node.parent)!);
    list.push(node.id);
  }
  const children = (id: number) => kids.get(id) ?? [];
  const attrs = (id: number): AxAttrs => {
    const node = byId.get(id);
    return node ? { role: node.role, label: node.label, frame: node.frame } : { role: "AXApplication", label: "", frame: null };
  };
  const actions = (id: number) => byId.get(id)?.actions ?? [];
  const result = walkActionable(ROOT, children, attrs, actions, display, walk);
  for (const node of [...result[0], ...result[1]]) live.add(node.ref as number);
  return [result[0], result[1], result[2] || reply.capped];
}
