/**
 * Everything that touches Windows: window capture, UI Automation, posted input, the browser's DevTools port.
 *
 * The counterpart of macos.ts, export for export, so nothing else knows the platform (platform.ts picks one).
 * The native half is windows.cs, built on first use with the C# compiler that ships in Windows and run once per
 * call: a run costs a process start, and in return every function here that macos.ts keeps synchronous stays
 * synchronous, so no caller changes. What differs from the Mac, and why:
 *
 *   - There is no Vision. `recognizeText` reads nothing, and a screen is its accessibility tree alone. UI
 *     Automation labels what OCR was there to find (Chromium's page included, once it is asked to publish it),
 *     and a control with no label reaches neither source, as on the Mac.
 *   - A point is a pixel: the helper is DPI aware, so a capture's scale is 1 and frames are screen pixels.
 *   - The browser is the agent's own profile with a DevTools port. Chrome 136 and later ignores
 *     `--remote-debugging-port` for the default profile, and nothing else reaches the user's tabs without the seat.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { attachPage, type Cdp, connectCdp, DEVTOOLS_PORT, type PageTarget, pageTargets } from "./devtools.ts";
import { type AxAttrs, walkActionable, type WalkOptions } from "./macos.ts";
import { Abort, type AxNode, type Box, type Capture, type Field, type Frame, type Point } from "./models.ts";

export type { PinnedWindow, PointerTarget, Tab, TabCommand, WindowSelector, AppWindow, Display, NativeSession, NativeStream } from "./macos.ts";
import type { AppWindow, Display, NativeSession, NativeStream, PinnedWindow, PointerTarget, Tab, TabCommand, WindowSelector } from "./macos.ts";

const ABORT_CORNER_PX = 4;
const WSL = process.platform === "linux"; // Windows programs start from WSL too; only their paths need translating
const SOURCE = join(import.meta.dir, "windows.cs");
const FEED_SOURCE = join(import.meta.dir, "feed.cs"); // the windows of feed.ts, one more mode of the same program
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319";

// ------------------------------------------------------------------ the helper

const toWindows = (path: string): string => (WSL ? spawnSync("wslpath", ["-w", path], { encoding: "utf8" }).stdout.trim() : path);
const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

let built: string | undefined;

/**
 * Where the built helper is kept: the user's LOCALAPPDATA, from Windows and from WSL alike. WSL does not carry
 * that variable, so Windows is asked for it. A Linux-side folder is the last resort only: csc writes a file there
 * with no execute bit, which WSL refuses to start (EACCES), and a program loaded over \\wsl$ starts slowly.
 */
function helperHome(): string {
  if (!WSL) return join(process.env.LOCALAPPDATA ?? tmpdir(), "hands");
  const asked = spawnSync("/mnt/c/Windows/System32/cmd.exe", ["/d", "/c", "echo %LOCALAPPDATA%"], { encoding: "utf8", cwd: "/mnt/c" }); // cwd: cmd complains about a \\wsl$ one
  const local = (asked.stdout ?? "").trim();
  const mounted = /^[A-Za-z]:\\/.test(local) ? spawnSync("wslpath", ["-u", local], { encoding: "utf8" }).stdout.trim() : "";
  return join(mounted || join(homedir(), ".cache"), "hands");
}

/** windows.cs as a program, named after its source: a running .exe is locked, so a changed source gets a new name. */
export function helperPath(): string {
  if (built) return built;
  const home = helperHome();
  const exe = join(home, `hands-${Bun.hash(readFileSync(SOURCE, "utf8") + readFileSync(FEED_SOURCE, "utf8")).toString(16).slice(0, 10)}.exe`);
  if (!existsSync(exe)) {
    mkdirSync(home, { recursive: true });
    for (const old of readdirSync(home).filter((name) => /^hands-.*\.exe$/.test(name))) {
      try {
        rmSync(join(home, old), { force: true });
      } catch {
        // Still running (a feed, a held key): Windows keeps it locked, and the next build clears it away.
      }
    }
    const csc = WSL ? "/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe" : `${CSC}\\csc.exe`;
    const references = ["UIAutomationClient.dll", "UIAutomationTypes.dll", "WindowsBase.dll", "System.Drawing.dll", "System.Windows.Forms.dll"].map((dll) => `/r:${dll}`);
    const build = spawnSync(csc, ["/nologo", "/optimize", "/platform:x64", `/out:${toWindows(exe)}`, `/lib:${CSC}\\WPF`, ...references, toWindows(SOURCE), toWindows(FEED_SOURCE)], { encoding: "utf8" });
    if (build.status !== 0) throw new Error(`windows.cs did not build: ${(build.stdout || build.stderr || String(build.error)).slice(0, 400)}`);
    if (WSL) chmodSync(exe, 0o755); // a no-op on the Windows drive; on the Linux side it is what lets WSL start it
  }
  return (built = exe);
}

/** One command of windows.cs. A test replaces this, the way tests/helpers.ts replaces the Mac's native calls. */
export const native = {
  run(...args: (string | number)[]): any {
    const done = spawnSync(helperPath(), args.map(String), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (done.error) throw done.error;
    const reply = JSON.parse(done.stdout || '{"error":"the helper said nothing"}');
    if (reply.error) throw new Error(reply.error);
    return reply;
  },
  /** One of the two modes that stay running, `mic` and `hotkey`. Closing its stdin ends it: a signal does not cross WSL interop. */
  stream(...args: (string | number)[]): NativeStream {
    const helper = Bun.spawn([helperPath(), ...args.map(String)], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    return { stdout: helper.stdout, stderr: helper.stderr, exited: helper.exited, end: () => void helper.stdin.end(), kill: () => helper.kill() };
  },
  /** The modes that are also told things while they run, `feed` and `devtools`: a line at a time down their stdin. */
  session(...args: (string | number)[]): NativeSession {
    const helper = Bun.spawn([helperPath(), ...args.map(String)], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    // The browser's socket is kept for the life of the process, so it must not be what keeps the process alive: a call
    // that waits has its own timer. Measured: Bun honours `unref` only before the pipes are touched.
    if (args[0] === "devtools") helper.unref();
    const write = (text: string) => (helper.stdin.write(text), void helper.stdin.flush());
    return { stdout: helper.stdout, stderr: new ReadableStream(), exited: helper.exited, write, end: () => void helper.stdin.end(), kill: () => helper.kill() };
  },
};

interface RawWindow extends AppWindow {
  pid: number;
  app: string;
  title: string;
  minimized: boolean;
}
interface Desk {
  foreground: number;
  cursor: Point;
  displays: Frame[];
  windows: RawWindow[];
}

let desk: { at: number; value: Desk } | undefined;

/** The windows, the displays and the cursor in one run. Kept for a moment: a step asks for all three, and the abort check asks ten times a second. */
function look(maxAgeMs = 150): Desk {
  if (!desk || performance.now() - desk.at > maxAgeMs) desk = { at: performance.now(), value: native.run("windows") };
  return desk.value;
}
/** What was seen is forgotten after anything that may have moved a window. */
export const stale = (): void => void (desk = undefined);

// ------------------------------------------------------------------ abort and displays

let interrupted = false;
export function interrupt(on = true): void {
  interrupted = on;
}

export const mouseLocation = (): Point => look(1000).cursor;

/** The corner of whichever display the mouse is on, as on the Mac. The cursor is read at most once a second: reading it is a process. */
export function checkAbort(): void {
  if (interrupted) throw new Abort("Ctrl-C");
  const [x, y] = mouseLocation();
  if (displays().some(({ frame: [dx, dy] }) => x >= dx && y >= dy && x - dx <= ABORT_CORNER_PX && y - dy <= ABORT_CORNER_PX)) throw new Abort("mouse in top-left corner");
}

export async function sleepWatching(seconds: number): Promise<void> {
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    checkAbort();
    await sleep(100);
  }
}

/** Windows asks for no permission to read or drive another window of the same user. */
export const accessibilityTrusted = (): boolean => true;

export const displays = (): Display[] => look(1000).displays.map((frame, index) => ({ index, frame }));

export function displayFor(frame: Frame | null): Display {
  const all = displays();
  const main = all[0] ?? { index: 0, frame: [0, 0, 0, 0] as Frame };
  if (!frame) return main;
  const [cx, cy] = [frame[0] + frame[2] / 2, frame[1] + frame[3] / 2];
  return all.find(({ frame: [x, y, w, h] }) => cx >= x && cx < x + w && cy >= y && cy < y + h) ?? main;
}

// ------------------------------------------------------------------ the seat: the real pointer and keyboard

/** Virtual-key codes for the names macos.ts KEYCODES takes. */
export const KEYCODES: Record<string, number> = {
  return: 0x0d, enter: 0x0d, tab: 0x09, space: 0x20, delete: 0x08, backspace: 0x08, escape: 0x1b, esc: 0x1b, forwarddelete: 0x2e,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, 0x70 + i])),
}; // prettier-ignore

function keycode(key: string): number {
  const code = KEYCODES[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined);
  if (code === undefined) throw new Error(`unknown key ${JSON.stringify(key)}`);
  return code;
}

export async function moveTo([x, y]: Point): Promise<void> {
  native.run("input", "move", x, y);
}

export async function clickAt([x, y]: Point, options: { button?: "left" | "right"; count?: number } = {}): Promise<void> {
  native.run("input", "click", x, y, options.button ?? "left", options.count ?? 1);
  stale();
}

export async function drag(path: Point[]): Promise<void> {
  native.run("input", "drag", ...path.flat());
  stale();
}

/** A key for the seat, or for one window when its process is named: posted there, it goes there whatever has the focus. */
export async function press(key: string, modifiers: string[] = [], pid?: number): Promise<void> {
  const window = pid === undefined ? undefined : mainWindowId(pid);
  if (window !== undefined && window !== null) native.run("key", window, keycode(key), modifiers.join("+"));
  else native.run("input", "key", keycode(key), modifiers.join("+"));
  stale();
}

/** Text for the seat. There is no posting text to a process the way CGEventPostToPid does: a window behind the user's takes text through `axSetValue`. */
export async function typeText(text: string, pid?: number): Promise<void> {
  if (pid !== undefined && look().windows.find((w) => w.id === look().foreground)?.pid !== pid) throw new Error("text cannot be typed into a window that is not in front on Windows; set the field's value instead");
  native.run("input", "type", base64(text));
}

export const pasteText = (text: string): Promise<void> => typeText(text);

export async function clearField(): Promise<void> {
  await press("a", ["control"]);
  await press("delete");
}

export async function scroll(lines: number, at?: Point, horizontal = 0): Promise<void> {
  const [x, y] = at ?? mouseLocation();
  native.run("input", "scroll", x, y, lines, horizontal);
}

// ------------------------------------------------------------------ apps and windows

const ordinary = (w: RawWindow): boolean => !w.minimized && Math.min(w.frame[2], w.frame[3]) >= 50; // macos.ts MIN_WINDOW_SIDE_PT

export async function frontmostAppAndPid(): Promise<[string, number]> {
  stale();
  const front = look().windows.find((w) => w.id === look().foreground) ?? look().windows[0];
  return front ? [front.app, front.pid] : ["", 0];
}
export const frontmostApp = async (): Promise<string> => (await frontmostAppAndPid())[0];
export const frontmostPid = async (): Promise<number> => (await frontmostAppAndPid())[1];

export const appName = (pid: number): string => look(1000).windows.find((w) => w.pid === pid)?.app ?? "";

/** An app's ordinary windows, front to back. One that is covered still counts; a minimized one does not. */
export const appWindows = (pid: number): AppWindow[] => look().windows.filter((w) => w.pid === pid && ordinary(w)).map(({ id, frame }) => ({ id, frame }));
export const allWindows = (): (AppWindow & { pid: number })[] => look().windows.filter(ordinary).map(({ id, frame, pid }) => ({ id, frame, pid }));
export const mainWindowId = (pid: number): number | null => appWindows(pid)[0]?.id ?? null;
export const keyWindowId = mainWindowId;

export async function frontmostWindowBounds(pid?: number | null): Promise<Frame | null> {
  const owner = pid ?? (await frontmostPid());
  return appWindows(owner)[0]?.frame ?? null;
}

export async function frontmostWindowCenter(pid?: number | null): Promise<Point | null> {
  const frame = await frontmostWindowBounds(pid);
  return frame ? [frame[0] + frame[2] / 2, frame[1] + frame[3] / 2] : null;
}

const named = (app: string) => (w: RawWindow): boolean => [w.app, w.title].some((text) => text.toLowerCase().includes(app.toLowerCase().replace(/^google /, "")));

async function appeared(app: string, before: Set<number>, timeout: number): Promise<RawWindow | null> {
  const end = performance.now() + timeout * 1000;
  while (performance.now() < end) {
    stale();
    const fresh = look().windows.find((w) => !before.has(w.id) && named(app)(w));
    if (fresh) return fresh;
    await sleep(150);
  }
  return null;
}

/**
 * Start an app without it taking the screen, and say which process it is.
 *
 * It starts minimized, since a new window otherwise opens in front with the keyboard. The launch is not waited
 * for, because an app reports ready seconds after its window exists: the window is taken as it appears, shown
 * without being activated and put under every other window, where PrintWindow and UI Automation still reach it.
 */
export async function runInBackground(app: string, timeout = 8.0): Promise<number | null> {
  const running = look().windows.find(named(app));
  if (running) return running.pid;
  const before = new Set(look().windows.map((w) => w.id));
  const user = look().foreground;
  native.run("launch", base64(app), base64(""), "background");
  const window = await appeared(app, before, timeout);
  if (window) native.run("behind", window.id, user);
  stale();
  return window?.pid ?? null;
}

export async function activate(app: string, timeout = 3.0): Promise<boolean> {
  let window = look().windows.find(named(app)) ?? null;
  if (!window) {
    const before = new Set(look().windows.map((w) => w.id));
    native.run("launch", base64(app), base64(""));
    window = await appeared(app, before, Math.max(timeout, 8.0));
  }
  if (!window) return false;
  const ok = Boolean(native.run("front", window.id).ok);
  stale();
  return ok;
}

// ------------------------------------------------------------------ capture

/** Width and height off a PNG's header. */
export function captureAt(path: string): Capture {
  const header = Buffer.alloc(24);
  const file = openSync(path, "r");
  try {
    readSync(file, header, 0, 24, 0);
  } finally {
    closeSync(file);
  }
  return { path, width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

export async function screenshot(display: Display, path: string): Promise<Capture> {
  const { width, height } = native.run("grab", 0, toWindows(path), ...display.frame);
  return { path, width, height };
}

/** One window, painted by itself wherever it sits in the stack, so one that is covered comes back whole. */
export async function screenshotWindow(windowId: number, path: string): Promise<Capture> {
  const { width, height } = native.run("grab", windowId, toWindows(path));
  return { path, width, height };
}

export type OcrLine = [text: string, confidence: number, box: Box];

/** Windows ships no Vision. Nothing is read off the pixels here: the accessibility tree is the only source of items. */
export const recognizeText = (_path: string, _rect?: Box): OcrLine[] => [];

// ------------------------------------------------------------------ accessibility

export interface UiaNode {
  ref: string; // "<root window>:<runtime id>", which is how windows.cs finds the control again
  parent: number;
  type: string;
  name: string;
  help: string;
  value: string;
  frame: Frame | null;
  offscreen: boolean;
  enabled: boolean;
  focused: boolean;
  password: boolean;
  actions: string[];
}

/** UI Automation's control types in the Mac's words, so the walk, its pruning and the role words downstream are the ones macos.ts has. */
export const AX_ROLE: Record<string, string> = {
  Button: "AXButton", SplitButton: "AXMenuButton", CheckBox: "AXCheckBox", RadioButton: "AXRadioButton", ComboBox: "AXComboBox", Hyperlink: "AXLink",
  Edit: "AXTextField", Document: "AXTextArea", TabItem: "AXTab", ListItem: "AXRow", TreeItem: "AXRow", DataItem: "AXRow", MenuItem: "AXMenuBarItem",
  Menu: "AXMenu", MenuBar: "AXMenuBar", Image: "AXImage", Slider: "AXSlider", Spinner: "AXIncrementor", Text: "AXStaticText", Group: "AXGroup",
  Pane: "AXGroup", Custom: "AXGroup", List: "AXList", Tree: "AXOutline", Table: "AXTable", Window: "AXWindow", ToolBar: "AXToolbar",
}; // prettier-ignore

const PRESSES = ["invoke", "toggle", "select", "expand"];
export const AX_PRESS = "AXPress";

export const uiaAttrs = (node: UiaNode): AxAttrs => ({ role: AX_ROLE[node.type] ?? "AXUnknown", label: node.name || node.help || (node.password ? "" : node.value.slice(0, 120)), frame: node.frame });
export const uiaActions = (node: UiaNode): string[] => [...(node.enabled && node.actions.some((a) => PRESSES.includes(a)) ? [AX_PRESS] : []), ...(node.actions.includes("show") ? ["AXScrollToVisible"] : [])];

function tree(windowId: number): UiaNode[] {
  return native.run("tree", windowId).nodes as UiaNode[];
}

/** The title of the window the user is in, which is never one a hand works in. */
export const userWindowTitle = (): string | null => look(1000).windows.find((w) => w.id === look(1000).foreground)?.title ?? null;
export const windowFrame = (windowId: number): Frame | null => look(2000).windows.find((w) => w.id === windowId)?.frame ?? null;

/**
 * The labelled controls of one window, through the walk macos.ts already has: only its three bindings change.
 * A window named by id is read wherever it sits in the stack, which is how a window behind the user's is worked.
 */
export function actionableElements(pid: number, display: Frame, options: Omit<WalkOptions<UiaNode>, "firstVisit"> & { windowId?: number } = {}): [AxNode[], AxNode[], boolean] {
  const { windowId, ...walk } = options;
  const id = windowId ?? mainWindowId(pid);
  if (id === null) return [[], [], false];
  const nodes = tree(id);
  const kids = new Map<number, UiaNode[]>();
  const index = new Map(nodes.map((node, i) => [node, i]));
  for (const node of nodes) kids.set(node.parent, [...(kids.get(node.parent) ?? []), node]);
  const root = { ref: "", parent: -2, type: "Window", name: "", help: "", value: "", frame: null, offscreen: false, enabled: true, focused: false, password: false, actions: [] } satisfies UiaNode;
  const children = (node: UiaNode) => kids.get(node === root ? -1 : index.get(node)!) ?? [];
  // Every node is fetched once and is its own object, so the walk's own identity check is the right one.
  const [found, hidden, capped] = walkActionable<UiaNode>(root, children, uiaAttrs, uiaActions, display, walk);
  // A reference outlives this run of the helper as words: the next run finds the control again by them.
  const byWords = (list: AxNode[]): AxNode[] => list.map((node) => ({ ...node, ref: (node.ref as UiaNode).ref }));
  return [byWords(found), byWords(hidden), capped];
}

/** Nothing is held between runs of the helper, so there is nothing to release. */
export const releaseElements = (): void => {};

export function focusedField(): Field | null {
  const front = look().windows.find((w) => w.id === look().foreground);
  const node = front && tree(front.id).find((n) => n.focused && (n.type === "Edit" || n.type === "Document" || n.type === "ComboBox"));
  if (!node?.frame) return null;
  const [x, y, w, h] = node.frame;
  return { role: AX_ROLE[node.type]!, label: node.name, placeholder: node.help, value: node.password ? "" : node.value, x, y, w, h, ref: node.ref };
}

const act = (ref: unknown, verb: string, text?: string): { ok: boolean; value: string | null } => {
  if (typeof ref !== "string" || !ref) return { ok: false, value: null };
  try {
    return native.run("act", ref.split(":")[0]!, ref, verb, ...(text === undefined ? [] : [base64(text)]));
  } catch {
    return { ok: false, value: null }; // the control is gone: a refusal, as a dead AX reference is on the Mac
  } finally {
    stale();
  }
};

/** A press is a UI Automation pattern, which needs neither the pointer nor the focus, so it lands in a window behind the user's. */
export const axPress = (ref: unknown): boolean => act(ref, "press").ok;
export const axPerform = (ref: unknown, action: string): boolean => (action === AX_PRESS ? axPress(ref) : action === "AXScrollToVisible" ? act(ref, "show").ok : false);
/** Focus is the one thing a background hand must not take: on Windows it activates the window. A field takes its value without it. */
export const axFocus = (_ref: unknown): boolean => false;
export const axSetValue = (ref: unknown, value: string): boolean => act(ref, "set", value).ok;
export const axValue = (ref: unknown): string | null => act(ref, "value").value;

// ------------------------------------------------------------------ one window, from behind

export const pointerAvailable = (): boolean => true;
export const isWebContentApp = (pid: number): boolean => /^(chrome|msedge|brave|vivaldi|opera|electron)/i.test(appName(pid));
/** Posted messages reach a covered window where it is, so there is nothing to slide into view. */
export const revealWindow = async (_pid: number, _windowId: number): Promise<boolean> => true;
export const focusWithoutRaise = (_windowId: number): boolean => false;

/** A press, a path and a release posted to one window. The user's cursor does not move. Classic controls take it; Chromium and XAML read only the real pointer. */
export async function windowPointer(target: PointerTarget, path: Point[], options: { count?: number } = {}): Promise<void> {
  native.run("pointer", target.windowId, options.count ?? 1, ...path.flat().map(Math.round));
  stale();
}

/** A Win32 menu is not in the tree until it is open, and opening one takes the focus. WinUI menu bars are ordinary buttons on the screen listing. */
export function menu(_pid: number, _path: string[]): { pressed: string } | { items: string[] } {
  throw new Error("menus cannot be pressed by path on Windows; press the menu bar item from the screen listing, then the command it shows");
}

/** Page a window's largest scroll area through its ScrollPattern. False when nothing in the window takes it. */
export function scrollPage(_pid: number, windowId: number, direction: "up" | "down" | "left" | "right"): boolean {
  const areas = tree(windowId).filter((n) => n.actions.includes("scroll") && n.frame).sort((a, b) => b.frame![2] * b.frame![3] - a.frame![2] * a.frame![3]);
  return areas.some((area) => act(area.ref, direction).ok);
}

// ------------------------------------------------------------------ the browser, over its DevTools port

let shared: Promise<Cdp> | undefined;

/**
 * This process's one connection to the agent's browser (devtools.ts), opened on first use and once more after it
 * has closed. It costs a process start, which is why it is kept. Rejects, without trying again, when no browser listens.
 */
export function browserCdp(): Promise<Cdp> {
  if (!shared) {
    const opening = (shared = connectCdp({ port: DEVTOOLS_PORT }));
    const forget = () => void (shared === opening && (shared = undefined));
    opening.then((cdp) => cdp.closed.then(forget), forget);
  }
  return shared;
}

const listening = (): Promise<boolean> => browserCdp().then(() => true, () => false); // prettier-ignore
const pages = async (): Promise<PageTarget[]> => pageTargets(await browserCdp());
/** A page that is navigating away may never answer, and none of what is asked here is worth the wait. */
const soon = <T>(answer: Promise<T>, ms = 5000): Promise<T | null> =>
  new Promise((resolve) => {
    const late = setTimeout(() => resolve(null), ms);
    void answer.then(resolve, () => resolve(null)).finally(() => clearTimeout(late));
  });

/** One DevTools command to one page: a session on the browser's socket for as long as the command takes. */
async function command(target: PageTarget, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const cdp = await browserCdp();
  const page = await attachPage(cdp, target.targetId);
  try {
    return await page.send(method, params);
  } finally {
    void cdp.send("Target.detachFromTarget", { sessionId: page.sessionId }).catch(() => {});
  }
}

/** Chrome lists its tabs in no order that says which one shows, so each is asked. With the occlusion switch a covered window's tab still says visible. */
async function showing(all: PageTarget[]): Promise<PageTarget | undefined> {
  if (all.length < 2) return all[0];
  const seen = await Promise.all(all.map((t) => soon(command(t, "Runtime.evaluate", { expression: "document.visibilityState" }), 2000)));
  return all[seen.findIndex((reply) => reply?.result?.value === "visible")] ?? all[0];
}

/** The tab a caller means: by number, else the page a window selector names (`scripted` is a page's id here), else the one that shows. */
const chosen = async (all: PageTarget[], window?: WindowSelector, tab?: number): Promise<PageTarget | undefined> =>
  tab ? all[tab - 1] : (all.find((t) => t.targetId === window) ?? (await showing(all)));

/** Where Chrome or Edge is installed. `HANDS_BROWSER_PATH` names any other Chromium. WSL has none of Windows' variables, so the usual places are tried. */
export function browserPath(browser: string): string {
  const roots = [process.env.PROGRAMFILES ?? "C:\\Program Files", process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", process.env.LOCALAPPDATA].filter((root): root is string => Boolean(root));
  const tail = /edge/i.test(browser) ? "Microsoft\\Edge\\Application\\msedge.exe" : "Google\\Chrome\\Application\\chrome.exe";
  const there = (path: string) => existsSync(WSL ? spawnSync("wslpath", ["-u", path], { encoding: "utf8" }).stdout.trim() : path);
  return process.env.HANDS_BROWSER_PATH ?? roots.map((root) => `${root}\\${tail}`).find(there) ?? (/edge/i.test(browser) ? "msedge.exe" : "chrome.exe");
}

/**
 * The switches the agent's browser starts with. A window that is covered gets no frames from Windows, and Chrome
 * paces a page by its frames: measured, a hidden page got 0 animation frames and 0 timer ticks a second until the
 * three pacing switches. The accessibility switch makes the page publish its tree, which is what the screen is read from.
 */
export const browserArguments = (profile: string, url: string): string[] => [
  `--remote-debugging-port=${DEVTOOLS_PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--force-renderer-accessibility",
  "--disable-gpu-vsync", "--disable-frame-rate-limit", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--new-window", url,
]; // prettier-ignore

const processName = (browser: string): string => (/edge/i.test(browser) ? "msedge" : "chrome");

async function startBrowser(browser: string, url: string, background: boolean): Promise<boolean> {
  const before = new Set(look().windows.map((w) => w.id));
  // The agent's own profile: Chrome 136 and later opens no port on the default one. WSL has no LOCALAPPDATA, so Windows is asked where it is.
  const profile = process.env.HANDS_BROWSER_PROFILE ?? toWindows(join(helperHome(), "browser"));
  const user = look().foreground;
  native.run("launch", base64(browserPath(browser)), base64(browserArguments(profile, url).map((a) => `"${a}"`).join(" ")), ...(background ? ["background"] : []));
  const window = await appeared(processName(browser), before, 10.0);
  if (window && background) native.run("behind", window.id, user);
  for (let i = 0; i < 20 && !(await listening()); i++) await sleep(150); // each no costs a run of the helper
  return window !== null;
}

/**
 * The window of the agent's browser that shows a page (any of its windows when none is named), or null. It is one
 * the DevTools browser's own process owns: the user's Chrome has the same name and the same kind of title.
 */
export async function browserWindow(targetId?: string): Promise<(AppWindow & { pid: number }) | null> {
  const cdp = await browserCdp();
  const { processInfo } = await cdp.send<{ processInfo: { type: string; id: number }[] }>("SystemInfo.getProcessInfo");
  const pid = processInfo.find((p) => p.type === "browser")?.id;
  const title = targetId ? (await pages()).find((t) => t.targetId === targetId)?.title : undefined;
  stale();
  const own = look().windows.filter((w) => w.pid === pid && ordinary(w));
  const window = (title ? own.find((w) => w.title.startsWith(title)) : undefined) ?? own[0];
  return window ? { id: window.id, pid: window.pid, frame: window.frame } : null;
}

export async function browserTabs(_browser: string): Promise<Tab[]> {
  const all = await pages().catch(() => []);
  const shown = await showing(all);
  return all.map((t, i) => ({ scripted: t.targetId, window: 1, tab: i + 1, active: t === shown, title: t.title, url: t.url }));
}

export async function browserUrl(_browser: string, window?: WindowSelector): Promise<string | null> {
  const page = await chosen(await pages().catch(() => []), window);
  if (!page) return null;
  // Measured: for some 15 ms after a navigation Chrome lists the tab with no address. The page itself knows it.
  return page.url || ((await soon(command(page, "Runtime.evaluate", { expression: "location.href" })))?.result?.value ?? null);
}

export async function browserLoading(_browser: string, window?: WindowSelector): Promise<boolean> {
  const page = await chosen(await pages().catch(() => []), window);
  if (!page) return false;
  const state = await soon(command(page, "Runtime.evaluate", { expression: "document.readyState" }));
  return state?.result?.value !== "complete";
}

/** Open a URL in the agent's browser: in the tab that shows, or a new one. In the background nothing is raised; otherwise the browser comes forward, as on the Mac. */
export async function openUrl(browser: string, url: string, options: { newTab?: boolean; newWindow?: boolean; window?: WindowSelector; tab?: number; background?: boolean } = {}): Promise<boolean> {
  if (await listening()) {
    const page = options.newTab || options.newWindow ? undefined : await chosen(await pages(), options.window, options.tab);
    // `Page.navigate` answers once the new document is the page's, so what is asked next is asked of it and not of the old one.
    if (page) await command(page, "Page.navigate", { url });
    // A tab made in front brings its window forward with it, so a background one is made behind the tab that shows.
    else await (await browserCdp()).send("Target.createTarget", { url, newWindow: Boolean(options.newWindow), background: Boolean(options.background) });
  } else if (!(await startBrowser(browser, url, Boolean(options.background)))) return false;
  if (options.background) return true;
  const window = await browserWindow().catch(() => null);
  stale();
  return window ? Boolean(native.run("front", window.id).ok) : false;
}

/** Act on a tab of the agent's browser. Returns the tab it acted on as `title | url`, or null when there is no such tab. */
export async function tabCommand(_browser: string, command_: TabCommand, window?: WindowSelector, tab?: number, background = false): Promise<string | null> {
  const page = await chosen(await pages().catch(() => []), window, tab);
  if (!page) return null;
  const cdp = await browserCdp();
  if (command_ === "switch_tab") {
    // Chrome activates a tab's window along with the tab (Browser::ActivateContents), which would take the user's screen.
    if (background) throw new Error("a tab cannot be brought up behind the user's windows on Windows; open the url in the tab that shows instead");
    await cdp.send("Target.activateTarget", { targetId: page.targetId });
  } else if (command_ === "close_tab") await cdp.send("Target.closeTarget", { targetId: page.targetId });
  else if (command_ === "reload") await command(page, "Page.reload");
  else await command(page, "Runtime.evaluate", { expression: `history.${command_}()` });
  return `${page.title} | ${page.url}`;
}

/** The agent's browser with this page in it, under every other window. `scripted` is the page's DevTools id. */
export async function openBackgroundWindow(browser: string, url: string): Promise<PinnedWindow> {
  // Not a new tab: one made in the background stays behind the tab that shows, and the window is read by what it shows.
  if (!(await openUrl(browser, url, { background: true }))) throw new Error(`${browser} did not start`);
  const all = await pages();
  const page = all.find((t) => t.url.startsWith(url.split("#")[0]!)) ?? (await showing(all));
  const window = await browserWindow(page?.targetId);
  if (!window) throw new Error(`${browser} has no window`);
  return { pid: window.pid, windowId: window.id, scripted: page?.targetId ?? "" };
}

// ------------------------------------------------------------------ voice

/** The default microphone as mono 24 kHz signed 16-bit PCM, for as long as the hold lasts. */
export const microphone = (): NativeStream => native.stream("mic");

/**
 * One key, watched while `hands --listen` runs: `down`, `up`, and `cancel` for Ctrl+Alt+Esc, a line each. The key is
 * read, not taken, so it still reaches the app in front: name one that app does not bind.
 */
export const heldKey = (key: string): NativeStream => native.stream("hotkey", keycode(key));

// ------------------------------------------------------------------ feed

/** The tiles, the pointers and the card: feed.cs, told what to show by feed.ts until its stdin closes. */
export const feed = (): NativeSession => native.session("feed");
