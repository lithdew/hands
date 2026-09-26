import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Abort, type Frame } from "../src/models.ts";
import * as windows from "../src/windows.ts";

const DISPLAY: Frame = [0, 0, 2560, 1600];

/** The helper's window list, front to back: the terminal, a Paint window behind it, and a UWP Calculator behind both. */
const desk = () => [
  { hwnd: 11, pid: 100, cls: "CASCADIA_HOSTING_WINDOW_CLASS", title: "bun hands", frame: [0, 0, 900, 600], core: 0, exe: "WindowsTerminal.exe" },
  { hwnd: 22, pid: 200, cls: "MSPaintApp", title: "Untitled - Paint", frame: [100, 100, 1000, 700], core: 0, exe: "mspaint.exe" },
  { hwnd: 33, pid: 300, cls: "ApplicationFrameWindow", title: "Calculator", frame: [600, 300, 400, 500], core: 34, exe: "CalculatorApp.exe" },
];

const node = (id: number, parent: number, role: string, label: string, extra: Partial<{ frame: Frame | null; actions: string[] }> = {}) => ({
  id, parent, role, label, frame: [120, 140, 80, 24] as Frame | null, actions: [] as string[], ...extra,
}); // prettier-ignore

type Args = Record<string, unknown>;
type Reply = ((args: Args) => unknown) | object | null;
let calls: [string, Args][];
/**
 * A window put behind the user's, or on the hand's own desktop (where a send leaves it) and probed there (a picture
 * with something in it), and a user who has been away a while: asked after many things, never the point of most tests.
 */
const HOUSEKEEPING: Record<string, Reply> = {
  displays: [{ index: 0, frame: DISPLAY }], foreground: { hwnd: 11, pid: 100 }, sink: { ok: true }, desktop: { index: 1, created: true }, send: { ok: true },
  onDesktop: { on: true }, recall: { ok: true }, colours: { colours: 32, blank: false }, removeDesktop: { removed: true }, reg: { value: null },
  idle: { idleMs: 60_000, held: [], quiet: true, tick: 1000 }, guard: { taken: false, back: true },
}; // prettier-ignore
/** A tree with labels enough for the probe to count the window as working. */
const LABELLED = { nodes: [node(1, -1, "AXGroup", "Untitled - Notepad"), node(2, 1, "AXMenuItem", "File"), node(3, 1, "AXMenuItem", "Edit"), node(4, 1, "AXTextArea", "Text editor")], capped: false };

/** windows.cs replaced by a script of replies, the way tests/helpers.ts replaces the Mac: nothing here may start a process. */
function helper(replies: Record<string, Reply>): void {
  spyOn(windows.native, "call").mockImplementation((command: string, args: Args = {}) => {
    calls.push([command, args]);
    const reply = replies[command] ?? HOUSEKEEPING[command];
    if (reply === undefined) throw new Error(`the test did not expect the helper to be asked for ${JSON.stringify(command)}`);
    return typeof reply === "function" ? (reply as (args: Args) => unknown)(args) : reply;
  });
}

const asked = (command: string) => calls.filter(([c]) => c === command).map(([, args]) => args);

/** An environment variable set for one test. */
async function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T> | T): Promise<T> {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

let lockRoot: string;
beforeEach(() => {
  calls = [];
  windows.interrupt(false);
  windows.forgetDisplays();
  windows.pace.persistMs = 0; // a launch's waits, shortened: the fake's windows do not come and go on their own
  windows.pace.seatWatchMs = 0;
  windows.pace.browserWatchMs = 0;
  lockRoot = mkdtempSync(join(tmpdir(), "hands-test-locks-"));
  windows.locks.root = lockRoot; // never a real hand's locks
});
afterEach(() => {
  mock.restore();
  rmSync(lockRoot, { recursive: true, force: true });
});

test("the pure walk and its constants are the Mac's, re-exported rather than copied", () => {
  expect(windows.walkActionable).toBeDefined();
  expect(windows.AX_PRESS).toBe("AXPress");
  expect(windows.offDisplay([3000, 0, 10, 10], DISPLAY)).toBe(true);
  expect(windows.subtreeKey("AXButton", "OK", [1, 2, 3, 4])).toBe(JSON.stringify(["AXButton", "OK", 1, 2, 3, 4]));
});

test("an app's windows come front to back, a UWP frame is its app's, a minimized one is not listed, and the frontmost app is named by its exe", async () => {
  const minimized = { hwnd: 23, pid: 200, cls: "MSPaintApp", title: "Other - Paint", frame: [100, 100, 1000, 700], core: 0, iconic: true };
  helper({ windows: [...desk(), minimized], exe: ({ pid }) => ({ name: { 100: "WindowsTerminal", 200: "mspaint", 300: "CalculatorApp", 400: "chrome", 500: "msedge" }[pid as number], path: "" }), foreground: { hwnd: 11, pid: 100 } });
  expect(windows.appWindows(200)).toEqual([{ id: 22, frame: [100, 100, 1000, 700] }]);
  expect(windows.appWindows(300)).toEqual([{ id: 33, frame: [600, 300, 400, 500] }]); // the frame window, under the app's own pid
  expect(windows.mainWindowId(300)).toBe(33);
  expect(windows.keyWindowId(999)).toBeNull();
  expect(windows.allWindows().map((w) => [w.id, w.pid, w.alpha])).toEqual([[11, 100, 1], [22, 200, 1], [33, 300, 1]]);
  expect(await windows.frontmostAppAndPid()).toEqual(["WindowsTerminal", 100]);
  expect(await windows.frontmostWindowBounds(200)).toEqual([100, 100, 1000, 700]);
  expect(windows.appName(400)).toBe("Google Chrome"); // as config.browser() spells it
  expect(windows.appName(500)).toBe("Microsoft Edge");
  expect(windows.appName(200)).toBe("mspaint");
  expect(windows.isWebContentApp(400)).toBe(true);
  expect(windows.isWebContentApp(200)).toBe(false);
});

test("displays are the helper's, the primary one first, and a frame off every display falls back to it", () => {
  helper({ displays: [{ index: 0, frame: DISPLAY }, { index: 1, frame: [2560, 0, 1920, 1080] }] });
  expect(windows.displays().map((d) => d.index)).toEqual([0, 1]);
  expect(windows.displayFor([2600, 50, 100, 100]).index).toBe(1);
  expect(windows.displayFor([-5000, 50, 100, 100]).index).toBe(0);
  expect(windows.displayFor(null).index).toBe(0);
});

test("the helper's roles go through the Mac's walk: labels, off-screen controls, and the helper's ids as refs", () => {
  const nodes = [
    node(1, -1, "AXGroup", "Untitled - Paint", { frame: [100, 100, 1000, 700] }),
    node(2, 1, "AXButton", "Red", { actions: ["AXPress"] }),
    node(3, 1, "AXTextField", "Search", { frame: [300, 140, 200, 24] }),
    node(4, 1, "AXGroup", "", { frame: [100, 200, 900, 500] }), // a nameless layout box
    node(5, 4, "AXLink", "Privacy", { actions: ["AXPress"], frame: [120, 4000, 80, 24] }),
    node(6, 4, "AXStaticText", "Some words", { frame: [120, 300, 300, 24] }),
    node(7, 4, "AXRow", "", { frame: [120, 330, 300, 24] }),
    node(8, 7, "AXStaticText", "Row label", { frame: [120, 330, 300, 24] }),
  ];
  helper({ windows: desk(), exe: { name: "mspaint" }, tree: { nodes, capped: false } });
  const [found, offscreen, capped] = windows.actionableElements(200, DISPLAY, { windowId: 22 });
  expect(found.map((n) => [n.role, n.label, n.pressable, n.ref])).toEqual([
    ["AXButton", "Red", true, 2],
    ["AXTextField", "Search", false, 3],
    ["AXRow", "Row label", false, 7],
  ]);
  expect(offscreen.map((n) => [n.label, n.ref])).toEqual([["Privacy", 5]]);
  expect(capped).toBe(false);
  expect(asked("tree")[0]).toMatchObject({ hwnd: 22 });
  expect(asked("topmost")).toEqual([]); // not a Chromium window: nothing is lifted
});

test("a listing drops one control listed twice, Excel's empty cells and the title bar's buttons", () => {
  const excel = { hwnd: 60, pid: 600, cls: "XLMAIN", title: "Book1 - Excel", frame: [0, 0, 1200, 800], core: 0, exe: "EXCEL.EXE" };
  const nodes = [
    node(1, -1, "AXGroup", "Book1 - Excel", { frame: [0, 0, 1200, 800] }),
    node(2, 1, "AXButton", "Minimize", { actions: ["AXPress"], frame: [1020, 8, 40, 30] }),
    node(3, 1, "AXButton", "Close", { actions: ["AXPress"], frame: [1150, 8, 40, 30] }),
    node(4, 1, "AXButton", "Close", { actions: ["AXPress"], frame: [500, 700, 80, 30] }), // a dialog's own Close, far below the title bar
    node(5, 1, "AXRow", "Videos", { actions: ["AXPress"], frame: [100, 200, 200, 30] }), // a list item...
    node(6, 5, "AXLink", "Videos", { actions: ["AXPress"], frame: [102, 201, 196, 28] }), // ...and its link: one control
    node(7, 1, "AXRow", "B12", { frame: [300, 300, 60, 20] }), // an empty cell
    node(8, 1, "AXRow", "B13 Total 42", { frame: [300, 320, 60, 20] }), // a cell with something in it
  ];
  helper({ windows: [excel], exe: { name: "EXCEL" }, tree: { nodes, capped: false } });
  const [found] = windows.actionableElements(600, DISPLAY, { windowId: 60 });
  expect(found.map((n) => [n.role, n.label, n.ref])).toEqual([
    ["AXButton", "Close", 4],
    ["AXRow", "B13 Total 42", 8],
    ["AXLink", "Videos", 6], // the link stays, its list item goes
  ]);
});

test("a covered Chromium window of the hand's own is lifted, without activation, for its first read only; the user's never is", async () => {
  const mine = { hwnd: 44, pid: 400, cls: "Chrome_WidgetWin_1", title: "Claude", frame: [0, 0, 900, 600], core: 0, exe: "claude.exe", caption: true };
  const theirs = { hwnd: 45, pid: 401, cls: "Chrome_WidgetWin_1", title: "WhatsApp", frame: [0, 0, 900, 600], core: 0, exe: "WhatsApp.exe", caption: true };
  let launched = false;
  const cover = { hwnd: 11, pid: 100, cls: "X", title: "", frame: [0, 0, 2560, 1600], core: 0, exe: "WindowsTerminal.exe" };
  helper({
    processes: [],
    windows: () => (launched ? [cover, mine, theirs] : [cover, theirs]),
    launch: () => ((launched = true), { pid: 0 }),
    exe: { name: "claude" },
    topmost: { ok: true },
    tree: { nodes: [node(1, -1, "AXGroup", "x", { frame: [0, 0, 900, 600] }), node(2, 1, "AXLink", "Go", { actions: ["AXPress"] })], capped: false },
  });
  windows.releaseDesktop();
  expect(await windows.runInBackground("claude.exe")).toBe(400);
  windows.actionableElements(400, DISPLAY, { windowId: 44 });
  expect(asked("topmost")).toEqual([{ hwnd: 44, on: true }, { hwnd: 44, on: false }]);
  windows.actionableElements(400, DISPLAY, { windowId: 44 });
  expect(asked("topmost")).toHaveLength(2);
  windows.actionableElements(401, DISPLAY, { windowId: 45 });
  expect(asked("topmost")).toHaveLength(2);
  windows.releaseDesktop();
});

test("a press, a value and a read each name the control by the helper's id; a stale or foreign ref is refused without a call", () => {
  helper({ windows: desk(), exe: { name: "mspaint" }, tree: { nodes: [node(1, -1, "AXGroup", "w", { frame: [0, 0, 500, 500] }), node(7, 1, "AXTextField", "Name")], capped: false }, act: { ok: true }, setValue: { ok: true }, value: { value: "hello" }, release: { ok: true } });
  const [[field]] = windows.actionableElements(200, DISPLAY, { windowId: 22 });
  expect(windows.axPress(field!.ref)).toBe(true);
  expect(windows.axPerform(field!.ref, "AXScrollToVisible")).toBe(true);
  expect(windows.axPerform(field!.ref, "AXConfirm")).toBe(true);
  expect(windows.axSetValue(field!.ref, 'say "hi"')).toBe(true);
  expect(windows.axValue(field!.ref)).toBe("hello");
  expect(asked("act")).toEqual([{ id: 7, action: "AXPress" }, { id: 7, action: "AXScrollToVisible" }, { id: 7, action: "AXConfirm" }]);
  expect(asked("setValue")).toEqual([{ id: 7, text: 'say "hi"' }]);
  expect(windows.axFocus(field!.ref)).toBe(false); // focus through UIA activates the window
  const before = calls.length;
  expect(windows.axPress(99)).toBe(false);
  expect(windows.axValue("7")).toBeNull();
  windows.releaseElements();
  expect(windows.axPress(field!.ref)).toBe(false);
  expect(calls.slice(before).map(([c]) => c)).toEqual(["release"]);
});

test("a control that the helper cannot act on is a refusal, not a crash", () => {
  helper({ focused: { id: 5, role: "AXTextField", label: "To", placeholder: "Recipients", value: "", frame: [10, 20, 300, 30] }, act: () => { throw new Error("act: the element is gone"); }, value: () => { throw new Error("gone"); } }); // prettier-ignore
  const field = windows.focusedField()!;
  expect(field).toMatchObject({ role: "AXTextField", label: "To", placeholder: "Recipients", x: 10, y: 20, w: 300, h: 30, ref: 5 });
  expect(windows.axPress(field.ref)).toBe(false);
  expect(windows.axValue(field.ref)).toBeNull();
});

test("key tables: letters, digits and punctuation are virtual keys, delete deletes forward, and cmd means Ctrl", () => {
  expect(windows.KEYCODES.a).toBe(0x41);
  expect(windows.KEYCODES["7"]).toBe(0x37);
  expect(windows.KEYCODES.delete).toBe(0x2e);
  expect(windows.KEYCODES.backspace).toBe(0x08);
  expect(windows.KEYCODES.forwarddelete).toBe(0x2e);
  expect(windows.KEYCODES["."]).toBe(0xbe);
  expect(windows.KEYCODES.f12).toBe(0x7b);
  expect(windows.KEYCODES.insert).toBe(0x2d);
  expect(windows.KEYCODES.apps).toBe(0x5d);
  expect(windows.KEYCODES.numpad7).toBe(0x67);
  expect(windows.KEYCODES.multiply).toBe(0x6a);
  expect(windows.MODIFIERS.cmd).toBe(windows.MODIFIERS.ctrl);
  expect(windows.MODIFIERS.option).toBe(0x12);
  expect(windows.MODIFIERS.win).toBe(0x5b);
});

test("a key for nobody goes to the seat with its modifiers; a character a key code cannot spell goes as text", async () => {
  helper({ windows: desk(), input: { ok: true }, clipboard: { ok: true } });
  await windows.press("l", ["cmd", "shift"]);
  await windows.typeText("seat");
  await windows.pasteText("long text");
  await windows.press("*");
  await windows.press("plus", ["ctrl"]);
  await windows.press("win");
  expect(asked("input")).toEqual([
    { kind: "key", vk: 0x4c, modifiers: [0x11, 0x10] },
    { kind: "text", text: "seat" },
    { kind: "key", vk: 0x56, modifiers: [0x11] },
    { kind: "text", text: "*" },
    { kind: "key", vk: 0xbb, modifiers: [0x11, 0x10] }, // ctrl and '+', which is shift and '='
    { kind: "key", vk: 0x5b, modifiers: [] }, // a modifier alone is a key
  ]);
  expect(asked("clipboard")).toEqual([{ text: "long text" }]);
  await expect(windows.press("hyper")).rejects.toThrow("unknown key");
  await expect(windows.press("a", ["hyper"])).rejects.toThrow("unknown modifier");
  await expect(windows.press("a", [], 999)).rejects.toThrow("no window");
});

test("the seat's input is refused while the user holds a modifier, and nothing is sent", async () => {
  helper({ input: { ok: false, taken: "the user is holding ctrl" } });
  await expect(windows.clickAt([10, 20])).rejects.toThrow("the user is holding ctrl: nothing was sent");
});

test("the seat's pointer goes through SendInput: a click at a point, a drag filled in, a wheel of 120 a line", async () => {
  helper({ input: { ok: true }, windows: desk(), foreground: { hwnd: 11, pid: 100 }, cursor: [400, 300], displays: [{ index: 0, frame: DISPLAY }] });
  await windows.clickAt([10, 20], { button: "right", count: 2 });
  const moves: number[][] = [];
  await windows.drag([[0, 0], [12, 0]], (at) => moves.push(at));
  await windows.scroll(-3, [50, 60]);
  await windows.scroll(2);
  expect(asked("input")[0]).toEqual({ kind: "click", x: 10, y: 20, button: "right", count: 2 });
  expect(moves).toEqual([[6, 0], [12, 0]]);
  expect(asked("input").filter((a) => a.kind === "down" || a.kind === "up")).toEqual([{ kind: "down" }, { kind: "up" }]);
  expect(asked("input").filter((a) => a.kind === "wheel")).toEqual([{ kind: "wheel", x: 50, y: 60, delta: -360, horizontal: 0 }, { kind: "wheel", x: 450, y: 300, delta: 240, horizontal: 0 }]);
});

test("a window's pointer is posted messages: move, press, drags every few pixels with the hand told, release; clicks are counted", async () => {
  helper({ post: { ok: true }, cursor: [400, 300], displays: [{ index: 0, frame: DISPLAY }] });
  const target = { pid: 200, windowId: 22, frame: [100, 100, 1000, 700] as Frame, web: false };
  await windows.windowPointer(target, [[150, 150]], { count: 2 });
  expect(asked("post").map((a) => a.kind)).toEqual(["move", "down", "up", "down", "up"]);
  expect(asked("post")[1]).toEqual({ hwnd: 22, kind: "down", x: 150, y: 150 });
  calls = [];
  const seen: number[][] = [];
  await windows.windowPointer(target, [[150, 150], [150, 168]], { onMove: (at) => seen.push(at) });
  expect(asked("post").map((a) => a.kind)).toEqual(["move", "down", "drag", "drag", "drag", "up"]);
  expect(seen).toEqual([[150, 156], [150, 162], [150, 168]]);
  expect(asked("guard")).toEqual([]); // not a Chromium window: it does not come forward on a click
  expect(windows.pointerAvailable()).toBe(true);
  expect(windows.focusWithoutRaise(22)).toBe(true);
});

test("a click into a Chromium window waits for the user to pause, under the seat's lock, and is watched so the window goes back at once", async () => {
  let idleMs = 100; // the user is typing
  helper({ post: { ok: true }, idle: () => ({ idleMs: (idleMs += 150), held: [], quiet: true, tick: 5 }) });
  const target = { pid: 400, windowId: 44, frame: [0, 0, 900, 600] as Frame, web: true };
  await windows.windowPointer(target, [[150, 150]]);
  const order = calls.map(([c, a]) => (c === "guard" ? (a.begin ? "begin" : "end") : c)).filter((c) => c !== "foreground");
  expect(order).toEqual(["idle", "idle", "begin", "post", "post", "post", "end"]); // it waited for 400 ms of quiet
  expect(asked("guard").at(-1)).toEqual({ hwnd: 44 });
});

test("a click into a Chromium window is refused when the user never pauses, and another hand's lock is waited for", async () => {
  helper({ post: { ok: true }, idle: { idleMs: 50, held: ["the left mouse button"], quiet: true, tick: 5 } });
  const target = { pid: 400, windowId: 44, frame: [0, 0, 900, 600] as Frame, web: true };
  const clock = spyOn(performance, "now");
  let now = 0;
  clock.mockImplementation(() => (now += 1000)); // twenty seconds go by in a few rounds
  await expect(windows.windowPointer(target, [[150, 150]])).rejects.toThrow("did not pause");
  clock.mockRestore();
  expect(asked("post")).toEqual([]);
});

test("an abort: Ctrl-C, or the mouse in the corner of the display it is on", () => {
  helper({ cursor: [400, 300], displays: [{ index: 0, frame: DISPLAY }] });
  windows.checkAbort();
  mock.restore();
  helper({ cursor: [3, 2], displays: [{ index: 0, frame: DISPLAY }] });
  expect(() => windows.checkAbort()).toThrow(Abort);
  windows.interrupt();
  expect(() => windows.checkAbort()).toThrow("Ctrl-C");
});

test("OCR boxes come back in full-capture pixels whatever the crop, and a capture's size is the helper's", () => {
  helper({ ocr: ({ rect }) => (rect ? [["cropped", 1, [5, 6, 50, 20]]] : [["whole", 1, [5, 6, 50, 20]]]), image: { width: 1280, height: 800 } });
  expect(windows.recognizeText("shot.png")).toEqual([["whole", 1, [5, 6, 50, 20]]]);
  expect(windows.recognizeText("shot.png", [100.4, 200.6, 600, 700])).toEqual([["cropped", 1, [105, 207, 150, 221]]]);
  expect(asked("ocr")[1]).toEqual({ path: "shot.png", rect: [100, 201, 600, 700] });
  expect(windows.captureAt("shot.png")).toEqual({ path: "shot.png", width: 1280, height: 800 });
});

test("captures name the window or the display, and a window that is gone says so", async () => {
  helper({ capture: ({ hwnd }) => (hwnd === 99 ? { gone: true } : { width: hwnd ? 886 : 2560, height: hwnd ? 593 : 1600 }) });
  expect(await windows.screenshotWindow(22, "w.png")).toEqual({ path: "w.png", width: 886, height: 593 });
  expect(await windows.screenshot({ index: 0, frame: DISPLAY }, "d.png")).toEqual({ path: "d.png", width: 2560, height: 1600 });
  expect(asked("capture")).toEqual([{ hwnd: 22, path: "w.png", format: "png" }, { display: 0, path: "d.png", format: "png" }]);
  await expect(windows.screenshotWindow(99, "w.png")).rejects.toThrow("the window is gone");
});

test("a thumbnail is the helper's JPEG, never restores a minimized window, and says blank or gone rather than sending a black box", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  helper({ capture: ({ hwnd }) => ({ 1: { width: 480, height: 300, blank: false, bytes: jpeg.toString("base64") }, 2: { minimized: true }, 3: { width: 480, height: 300, blank: true, bytes: "AA==" }, 4: { gone: true } })[hwnd as number] ?? {} }); // prettier-ignore
  expect(windows.thumbnail(1, 480)).toEqual({ jpeg: new Uint8Array(jpeg) });
  expect(windows.thumbnail(2, 480)).toEqual({ minimized: true });
  expect(windows.thumbnail(3, 480)).toEqual({ blank: true });
  expect(windows.thumbnail(4, 480)).toBeNull();
  expect(asked("capture")[0]).toEqual({ hwnd: 1, format: "jpeg", max: 480, restore: false, inline: true });
});

test("revealWindow moves nothing on Windows: a covered page takes posted clicks", async () => {
  helper({ windows: desk(), move: { ok: true } });
  expect(await windows.revealWindow(200, 22)).toBe(true);
  expect(asked("move")).toEqual([]);
});

test("before a capture, a covered Chromium window of the hand's own is slid until a strip of it shows, since a covered page paints no more", async () => {
  // The hand's Chrome window (46) lies entirely under the terminal (11), which covers the left of the screen; the right side is free.
  const cover = { hwnd: 11, pid: 100, cls: "X", title: "", frame: [0, 0, 1400, 1600], core: 0, exe: "WindowsTerminal.exe" };
  let chrome = { hwnd: 46, pid: 400, cls: "Chrome_WidgetWin_1", title: "Example", frame: [100, 100, 1000, 700], core: 0, exe: "chrome.exe", caption: true };
  let launched = false;
  let front = { hwnd: 11, pid: 100 };
  spyOn(process, "kill").mockImplementation(() => true);
  helper({
    processes: [{ pid: 400, cmd: '"C:\\chrome.exe"' }],
    windows: () => (launched ? [cover, chrome] : [cover]),
    foreground: () => front,
    launch: () => ((launched = true), (front = { hwnd: 46, pid: 400 }), { pid: 400 }),
    activate: ({ hwnd }) => ((front = { hwnd: hwnd as number, pid: 100 }), { ok: true }),
    move: ({ x, y }) => ((chrome = { ...chrome, frame: [x as number, y as number, 1000, 700] }), { ok: true }),
    capture: { width: 1000, height: 700 },
  });
  windows.releaseDesktop();
  await windows.openBackgroundWindow("Google Chrome", "https://example.com/");
  await windows.screenshotWindow(46, "w.png");
  const moved = asked("move");
  expect(moved.length).toBeGreaterThan(0);
  expect(moved[0]).toMatchObject({ hwnd: 46 });
  expect((moved.at(-1)!.x as number) + 1000).toBeGreaterThan(1400); // it now reaches past the cover's right edge
  expect(windows.captureMayBeStale(46)).toBe(false);
  await windows.screenshotWindow(46, "w.png"); // already showing: nothing moves
  expect(asked("move")).toHaveLength(moved.length);
  windows.releaseDesktop();
});

test("staging moves a window into the cascade on HANDS_SCREEN, and does nothing without it", async () => {
  helper({ displays: [{ index: 0, frame: DISPLAY }, { index: 1, frame: [2560, 0, 1920, 1080] }], move: { ok: true } });
  const saved = { screen: process.env.HANDS_SCREEN, slot: process.env.HANDS_SLOT };
  try {
    delete process.env.HANDS_SCREEN;
    await windows.stageWindow(200, 22);
    expect(asked("move")).toEqual([]);
    Object.assign(process.env, { HANDS_SCREEN: "1", HANDS_SLOT: "2" });
    await windows.stageWindow(200, 22);
    expect(asked("move")[0]).toEqual({ hwnd: 22, x: 2560 + 16 + 260, y: 36 + 128, w: 1920 - 440 - 390, h: 1080 - 60 - 192 });
  } finally {
    for (const [key, value] of [["HANDS_SCREEN", saved.screen], ["HANDS_SLOT", saved.slot]] as const) value === undefined ? delete process.env[key] : (process.env[key] = value); // prettier-ignore
  }
});

test("an app is started without activation and known by the window that appears, whose pid may not be the launcher's", async () => {
  let asks = 0;
  const calculator = { hwnd: 55, pid: 500, cls: "ApplicationFrameWindow", title: "Calculator", frame: [0, 0, 400, 500], core: 56, exe: "CalculatorApp.exe", caption: true };
  const frameOnly = { ...calculator, pid: 2716, core: 0, exe: "ApplicationFrameHost.exe" }; // the frame host's, until the app's own window is inside it
  const bare = { hwnd: 56, pid: 500, cls: "Windows.UI.Core.CoreWindow", title: "Calculator", frame: [0, 0, 400, 500], core: 0, exe: "CalculatorApp.exe" }; // the app's own window, top level until the frame adopts it
  helper({ processes: [], windows: () => (asks++ < 2 ? desk() : asks < 4 ? [...desk(), bare, frameOnly] : [...desk(), calculator]), launch: { pid: 0 } });
  windows.releaseDesktop();
  expect(await windows.runInBackground("Calculator")).toBe(500);
  expect(asked("send")).toEqual([]); // desktops are asked for, not the default
  expect(asked("sink")).toEqual([{ hwnd: 55 }]);
  windows.releaseDesktop();
  expect(asked("launch")).toEqual([{ file: "calc.exe", args: "", show: 4 }]);
  expect(asked("processes")).toEqual([{ exe: "CalculatorApp.exe" }]);
  expect(asked("activate")).toEqual([]);
});

test("a UWP app stays on the desktop on screen, sunk, without a probe: its tree and its frame's picture go blank on any other (measured on Calculator)", async () => {
  let asks = 0;
  const calculator = { hwnd: 55, pid: 500, cls: "ApplicationFrameWindow", title: "Calculator", frame: [0, 0, 400, 500], core: 56, exe: "CalculatorApp.exe", caption: true };
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  helper({ processes: [], windows: () => (asks++ < 2 ? desk() : [...desk(), calculator]), launch: { pid: 0 } });
  await withEnv("HANDS_DESKTOP", "1", async () => {
    windows.releaseDesktop();
    expect(await windows.runInBackground("Calculator")).toBe(500);
    expect(asked("send")).toEqual([]);
    expect(asked("tree")).toEqual([]);
    expect(asked("sink")).toEqual([{ hwnd: 55 }]);
    expect(windows.desktopNote()).toBe("Calculator cannot work on a desktop of its own, so it stays behind your windows.");
    expect(windows.desktopNote()).toBeNull(); // said once
    expect(quiet).toHaveBeenCalledTimes(1);
    windows.releaseDesktop();
  });
});

test("with HANDS_DESKTOP=1 an app's window is moved to the hand's own desktop as it appears; a window there is the app's, but not on screen", async () => {
  const notepad = { hwnd: 55, pid: 500, cls: "Notepad", title: "Untitled - Notepad", frame: [0, 0, 400, 500], core: 0, cloaked: false, exe: "Notepad.exe", caption: true };
  let launched = false;
  let sent = false;
  helper({ processes: [], windows: () => (launched ? [...desk(), { ...notepad, cloaked: sent }] : desk()), launch: () => ((launched = true), { pid: 0 }), send: () => ((sent = true), { ok: true }), tree: LABELLED });
  await withEnv("HANDS_NAME", "Lefty", () =>
    withEnv("HANDS_DESKTOP", "1", async () => {
      windows.releaseDesktop(); // an earlier test may have made one
      calls = [];
      expect(windows.desktopName()).toBe("Hands: Lefty");
      expect(await windows.runInBackground("Notepad")).toBe(500);
      expect(asked("desktop")).toEqual([{ name: "Hands: Lefty" }]);
      expect(asked("send")).toEqual([{ hwnd: 55, name: "Hands: Lefty" }]);
      expect(asked("tree").map((a) => a.hwnd)).toEqual([55, 55]); // the probe: its tree before the move and after, and its picture
      expect(asked("colours")).toEqual([{ hwnd: 55, cap: 5 }]);
      expect(asked("recall")).toEqual([]);
      expect(asked("sink")).toEqual([]); // on its own desktop there is nothing of the user's to go behind
      expect(windows.desktopNote()).toBeNull();
      expect(windows.appWindows(500)).toEqual([{ id: 55, frame: [0, 0, 400, 500] }]); // the hand still finds and captures it
      expect(windows.mainWindowId(500)).toBe(55);
      expect(windows.allWindows().map((w) => w.id)).toEqual([11, 22, 33]); // covers and the overlay see only the desktop on screen
      windows.releaseDesktop();
      expect(asked("recall")).toEqual([{ hwnd: 55 }]); // brought back behind the user's windows before the desktop goes
      expect(asked("removeDesktop")).toEqual([{ name: "Hands: Lefty" }]);
      expect(asked("close")).toEqual([]); // no browser window of its own to close
    }),
  );
});

test("a window the probe finds blank or treeless on the hand's desktop is recalled, sunk and grounded, and its app is never sent again", async () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  const fresh = [
    { hwnd: 55, pid: 500, cls: "MSPaintApp", title: "Untitled - Paint", frame: [0, 0, 400, 500], core: 0, exe: "mspaint.exe" },
    { hwnd: 66, pid: 600, cls: "MSPaintApp", title: "Untitled - Paint", frame: [0, 0, 400, 500], core: 0, exe: "mspaint.exe" },
    { hwnd: 77, pid: 700, cls: "CASCADIA_HOSTING_WINDOW_CLASS", title: "Terminal", frame: [0, 0, 400, 500], core: 0, exe: "WindowsTerminal.exe" },
  ];
  let opened = 0; // how many of `fresh` have appeared
  const closed = new Set<number>();
  const cloaked = new Set<number>();
  spyOn(process, "kill").mockImplementation(() => { throw new Error("no such process"); }); // an app is looked for afresh each time // prettier-ignore
  helper({
    processes: [],
    windows: () => [...desk(), ...fresh.slice(0, opened).filter((w) => !closed.has(w.hwnd)).map((w) => ({ ...w, cloaked: cloaked.has(w.hwnd) }))],
    launch: () => (opened++, { pid: 0 }),
    send: ({ hwnd }) => (cloaked.add(hwnd as number), { ok: true }),
    recall: ({ hwnd }) => (cloaked.delete(hwnd as number), { ok: true }),
    colours: ({ hwnd }) => ({ colours: 32, blank: hwnd === 55 }), // Paint's first window paints nothing there
    // The terminal's tree keeps its picture but loses more than half its labels there: eight before, three after.
    tree: ({ hwnd }) => (hwnd === 77 ? { nodes: Array.from({ length: cloaked.has(77) ? 3 : 8 }, (_, i) => node(i + 1, i ? 1 : -1, "AXButton", `Tab ${i}`)), capped: false } : LABELLED),
  });
  await withEnv("HANDS_DESKTOP", "1", async () => {
    windows.releaseDesktop();
    expect(await windows.runInBackground("Paint")).toBe(500);
    expect(asked("send")).toEqual([{ hwnd: 55, name: windows.desktopName() }]);
    expect(asked("recall")).toEqual([{ hwnd: 55 }]);
    expect(asked("sink")).toEqual([{ hwnd: 55 }]);
    expect(cloaked.size).toBe(0);
    expect(windows.desktopNote()).toBe("Paint cannot work on a desktop of its own, so it stays behind your windows.");
    expect(quiet).toHaveBeenCalledTimes(1);
    expect(await windows.runInBackground("Paint")).toBe(500); // its window is still open: worked in again, not opened twice
    expect(asked("launch")).toHaveLength(1);
    closed.add(55);
    // Paint again once that window is closed (another instance, as the fake sees it): straight behind the user's windows, no probe, no second note.
    expect(await windows.runInBackground("Paint")).toBe(600);
    expect(asked("send")).toHaveLength(1);
    expect(asked("tree").map((a) => a.hwnd)).toEqual([55]); // the baseline only: a blank picture settles it before the tree is read again
    expect(asked("sink")).toEqual([{ hwnd: 55 }, { hwnd: 66 }]);
    expect(windows.desktopNote()).toBeNull();
    // A window whose picture is fine but whose tree lost its labels is grounded by the tree.
    expect(await windows.runInBackground("Windows Terminal")).toBe(700);
    expect(asked("send").at(-1)).toEqual({ hwnd: 77, name: windows.desktopName() });
    expect(asked("recall").at(-1)).toEqual({ hwnd: 77 });
    expect(asked("sink").at(-1)).toEqual({ hwnd: 77 });
    expect(windows.desktopNote()).toBe("Windows Terminal cannot work on a desktop of its own, so it stays behind your windows.");
    expect(quiet).toHaveBeenCalledTimes(2);
    windows.releaseDesktop();
  });
});

test("a window that vanishes as it is moved grounds its app without an error; the app opening no window at all is still the error it was", async () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  const notepad = { hwnd: 55, pid: 500, cls: "Notepad", title: "Untitled - Notepad", frame: [0, 0, 400, 500], core: 0, exe: "Notepad.exe" };
  let launches = 0;
  let gone = false;
  spyOn(process, "kill").mockImplementation(() => { throw new Error("no such process"); }); // prettier-ignore
  helper({
    processes: [],
    windows: () => (launches === 1 && !gone ? [...desk(), notepad] : desk()),
    launch: () => (launches++, { pid: 0 }),
    send: () => {
      if (gone) throw new Error("send: COMException: Element not found."); // as the shell answers for a window that is gone
      gone = true; // the app crashed as it was moved
      return { ok: true };
    },
    onDesktop: () => {
      if (gone) throw new Error("onDesktop: COMException: Element not found.");
      return { on: true };
    },
    tree: LABELLED,
  });
  await withEnv("HANDS_DESKTOP", "1", async () => {
    windows.releaseDesktop();
    expect(await windows.runInBackground("Notepad")).toBe(500);
    expect(asked("send")).toHaveLength(2); // the second try was the one refused, and settled it without a probe
    expect(asked("colours")).toEqual([]);
    expect(asked("recall")).toEqual([]);
    expect(asked("sink")).toEqual([]); // nothing left to put anywhere
    expect(windows.desktopNote()).toBe("Notepad cannot work on a desktop of its own, so it stays behind your windows.");
    expect(quiet).toHaveBeenCalledTimes(1);
    await expect(windows.runInBackground("Notepad", 0.3)).rejects.toThrow("Notepad opened no window");
    expect(asked("send")).toHaveLength(2);
    windows.releaseDesktop();
  });
});

test("a window the shell keeps bringing back is sent again three times, then grounded without a note; one the user is watching on the hand's desktop is left alone", async () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  const notepad = { hwnd: 55, pid: 500, cls: "Notepad", title: "Untitled - Notepad", frame: [0, 0, 400, 500], core: 0, exe: "Notepad.exe" };
  let launched = false;
  let on = false; // on the hand's desktop, by the shell's account
  let cloaked = false; // and not on screen
  helper({
    processes: [],
    windows: () => (launched ? [...desk(), { ...notepad, cloaked }] : desk()),
    launch: () => ((launched = true), { pid: 0 }),
    send: () => ((on = cloaked = true), { ok: true }),
    onDesktop: () => ({ on }),
    tree: LABELLED,
    capture: { width: 400, height: 500 },
  });
  await withEnv("HANDS_DESKTOP", "1", async () => {
    windows.releaseDesktop();
    expect(await windows.runInBackground("Notepad")).toBe(500);
    expect(asked("send")).toHaveLength(1);
    cloaked = false; // the user switched to the hand's desktop to watch: the window is on screen there, and stays put
    await windows.screenshotWindow(55, "w.png");
    expect(asked("send")).toHaveLength(1);
    for (let back = 1; back <= 3; back++) {
      on = false; // an action activated the app, and Windows moved its window to the desktop on screen
      await windows.screenshotWindow(55, "w.png");
      expect(asked("send")).toHaveLength(1 + back);
      await windows.screenshotWindow(55, "w.png"); // the capture that follows the action sees it back there
      expect(asked("send")).toHaveLength(1 + back);
    }
    on = cloaked = false;
    await windows.screenshotWindow(55, "w.png"); // a fourth time: the desktop is fighting us
    expect(asked("send")).toHaveLength(4);
    expect(asked("sink")).toEqual([{ hwnd: 55 }]);
    expect(asked("recall")).toEqual([]); // it is already on the desktop on screen
    expect(windows.desktopNote()).toBeNull(); // mid-run, the log alone hears of it: the model's next open would be of some other app
    expect(quiet).toHaveBeenCalledTimes(1);
    await windows.screenshotWindow(55, "w.png");
    expect(asked("send")).toHaveLength(4); // no longer kept there
    windows.releaseDesktop();
  });
});

test("a window the shell refuses is grounded at once, whether at the move or when it is being kept, and nothing escapes an action", async () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  const notepad = { hwnd: 55, pid: 500, cls: "Notepad", title: "Untitled - Notepad", frame: [0, 0, 400, 500], core: 0, cloaked: false, exe: "Notepad.exe" };
  const paint = { hwnd: 66, pid: 600, cls: "MSPaintApp", title: "Untitled - Paint", frame: [0, 0, 400, 500], core: 0, cloaked: false, exe: "mspaint.exe" };
  let launched = 0;
  let refuse = false; // the user closed the hand's desktop in Task View
  spyOn(process, "kill").mockImplementation(() => { throw new Error("no such process"); }); // prettier-ignore
  helper({
    processes: [],
    windows: () => [...desk(), ...[notepad, paint].slice(0, launched)],
    launch: () => (launched++, { pid: 0 }),
    send: () => {
      if (refuse) throw new Error("send: no virtual desktop named Hands: Lefty");
      return { ok: true };
    },
    onDesktop: () => ({ on: !refuse }),
    tree: LABELLED,
    capture: { width: 400, height: 500 },
  });
  await withEnv("HANDS_DESKTOP", "1", async () => {
    windows.releaseDesktop();
    expect(await windows.runInBackground("Notepad")).toBe(500);
    expect(asked("send")).toHaveLength(1);
    refuse = true;
    await windows.screenshotWindow(55, "w.png"); // kept: the send fails, and the window is grounded rather than the capture failing
    expect(asked("send")).toHaveLength(2);
    expect(asked("sink")).toEqual([{ hwnd: 55 }]);
    expect(asked("capture")).toHaveLength(1);
    expect(windows.desktopNote()).toBeNull();
    expect(quiet).toHaveBeenCalledTimes(1);
    expect(await windows.runInBackground("Paint")).toBe(600); // opened now: the first send fails, so no probe, and the model hears
    expect(asked("send")).toHaveLength(3);
    expect(asked("colours").map((a) => a.hwnd)).toEqual([55]);
    expect(asked("sink")).toEqual([{ hwnd: 55 }, { hwnd: 66 }]);
    expect(windows.desktopNote()).toBe("Paint cannot work on a desktop of its own, so it stays behind your windows.");
    expect(quiet).toHaveBeenCalledTimes(2);
    windows.releaseDesktop();
  });
});

test("a handle the shell has given to another window is forgotten, never sent, sunk or recalled as the hand's", async () => {
  const notepad = { hwnd: 55, pid: 500, cls: "Notepad", title: "Untitled - Notepad", frame: [0, 0, 400, 500], core: 0, exe: "Notepad.exe" };
  let launched = false;
  let stranger = false; // Notepad closed, and the user's own new window got its handle
  helper({
    processes: [],
    windows: () => (launched ? [...desk(), stranger ? { ...notepad, pid: 900, cls: "Chrome_WidgetWin_1", title: "Mail", cloaked: false, exe: "chrome.exe" } : { ...notepad, cloaked: true }] : desk()),
    launch: () => ((launched = true), { pid: 0 }),
    onDesktop: () => ({ on: !stranger }),
    tree: LABELLED,
    capture: { width: 400, height: 500 },
  });
  await withEnv("HANDS_DESKTOP", "1", async () => {
    windows.releaseDesktop();
    expect(await windows.runInBackground("Notepad")).toBe(500);
    stranger = true;
    for (let i = 0; i < 5; i++) await windows.screenshotWindow(55, "w.png");
    expect(asked("send")).toEqual([{ hwnd: 55, name: windows.desktopName() }]); // the one at the open
    expect(asked("sink")).toEqual([]);
    expect(asked("recall")).toEqual([]);
    expect(windows.desktopNote()).toBeNull();
    windows.releaseDesktop();
  });
});

test("the browser works unseen when its own command line, or the Chrome policy, turns native occlusion tracking off", async () => {
  expect(windows.unoccludedBy('"C:\\chrome.exe" --disable-features=CalculateNativeWinOcclusion', null)).toBe(true);
  expect(windows.unoccludedBy('"C:\\chrome.exe" --disable-features=Foo,CalculateNativeWinOcclusion,Bar --new-window', null)).toBe(true);
  expect(windows.unoccludedBy('"C:\\chrome.exe" --disable-features="Foo,CalculateNativeWinOcclusion"', null)).toBe(true);
  expect(windows.unoccludedBy('"C:\\chrome.exe" --disable-features=CalculateNativeWinOcclusionExtra', null)).toBe(false);
  expect(windows.unoccludedBy('"C:\\chrome.exe" --enable-features=CalculateNativeWinOcclusion', null)).toBe(false);
  expect(windows.unoccludedBy('"C:\\chrome.exe"', "0")).toBe(true);
  expect(windows.unoccludedBy('"C:\\chrome.exe"', "1")).toBe(false);
  expect(windows.unoccludedBy('"C:\\chrome.exe"', null)).toBe(false);
  spyOn(process, "kill").mockImplementation(() => true);
  helper({ processes: [{ pid: 800, cmd: '"C:\\msedge.exe" --disable-features=CalculateNativeWinOcclusion' }], reg: { value: null } });
  expect(await windows.browserUnoccluded("Microsoft Edge")).toBe(true);
  expect(asked("reg")).toEqual([{ key: "Software\\Policies\\Microsoft\\Edge", name: "NativeWindowOcclusionEnabled" }]);
  expect(await windows.browserUnoccluded("Microsoft Edge")).toBe(true); // remembered by pid
  expect(asked("reg")).toHaveLength(1);
});

test("an app already running as the user's is not started again, and automation's instances do not count", async () => {
  helper({ processes: [{ pid: 700, cmd: '"C:\\chrome.exe" --user-data-dir=C:\\x' }, { pid: 701, cmd: '"C:\\chrome.exe" --type=renderer' }, { pid: 702, cmd: '"C:\\chrome.exe"' }] });
  expect(await windows.appInstances("Google Chrome")).toEqual([{ pid: 700, automated: true }, { pid: 702, automated: false }]);
  expect(asked("processes")).toEqual([{ exe: "chrome.exe" }]);
});

test("the browser's tabs, URL and loading state are read off its windows, and a tab is navigated from behind only once its omnibox holds the URL", async () => {
  let typed = ""; // what the omnibox of window 45 holds while it is being typed into
  let went = false;
  const view = (hwnd: number) => ({
    tabs: [{ title: "Inbox", active: false, frame: [200, 150, 200, 40], close: [380, 160, 20, 20] }, { title: "Flights", active: true, frame: [400, 150, 200, 40], close: [580, 160, 20, 20] }],
    url: hwnd === 44 ? "https://flights.example.com/" : went ? "https://example.com/" : null, omnibox: [438, 227, 545, 37], omniboxValue: hwnd === 45 && typed ? typed : "flights.example.com", buttons: { Back: [170, 219, 52, 51], Reload: [278, 219, 52, 51], "New Tab": [578, 150, 43, 62] }, loading: hwnd === 45 && !typed,
  }); // prettier-ignore
  const list = [{ hwnd: 44, pid: 400, cls: "Chrome_WidgetWin_1", title: "Flights - Google Chrome", frame: [0, 0, 1200, 800], core: 0, exe: "chrome.exe" }, { hwnd: 45, pid: 400, cls: "Chrome_WidgetWin_1", title: "Inbox - Google Chrome", frame: [50, 50, 1200, 800], core: 0, exe: "chrome.exe" }];
  spyOn(process, "kill").mockImplementation(() => true);
  helper({
    processes: [{ pid: 400, cmd: '"C:\\chrome.exe"' }],
    windows: list,
    browser: ({ hwnd }) => view(hwnd as number),
    post: { ok: true },
    chars: ({ text }) => ((typed = `${text}`), { ok: true }), // the click selected the old text: the new replaces it
    vkey: ({ vk }) => ((went ||= vk === 0x0d), { ok: true }),
  });
  expect(await windows.browserTabs("Google Chrome")).toEqual([
    { scripted: "44", window: 1, tab: 1, active: false, title: "Inbox", url: "" },
    { scripted: "44", window: 1, tab: 2, active: true, title: "Flights", url: "https://flights.example.com/" },
    { scripted: "45", window: 2, tab: 1, active: false, title: "Inbox", url: "" },
    { scripted: "45", window: 2, tab: 2, active: true, title: "Flights", url: "https://flights.example.com" }, // the omnibox's text, with its scheme put back
  ]);
  expect(await windows.browserUrl("Google Chrome")).toBe("https://flights.example.com/");
  expect(await windows.browserUrl("Google Chrome", "45")).toBe("https://flights.example.com");
  expect(await windows.browserLoading("Google Chrome")).toBe(false);
  expect(await windows.browserLoading("Google Chrome", 2)).toBe(true);
  // Behind: a tab is navigated by a click on the omnibox, the URL as characters to the window itself, and Enter; nothing is activated.
  expect(await windows.openUrl("Google Chrome", "https://example.com/", { background: true, window: "45", newTab: false })).toBe(true);
  expect(asked("post").map((a) => [a.hwnd, a.kind, a.x, a.y])).toEqual([[45, "move", 711, 246], [45, "down", 711, 246], [45, "up", 711, 246]]);
  expect(asked("chars")).toEqual([{ hwnd: 45, text: "https://example.com/", direct: true }]);
  expect(asked("vkey")).toEqual([{ hwnd: 45, vk: 0x0d, direct: true }]);
  expect(asked("guard")).toEqual([{ begin: true }, { hwnd: 45 }]); // the click brings Chrome forward for a moment, and it goes straight back
  expect(await windows.tabCommand("Google Chrome", "back", "44", undefined, true)).toBe("Flights | https://flights.example.com/");
  expect(asked("post").at(-1)).toEqual({ hwnd: 44, kind: "up", x: 196, y: 245 });
  expect(await windows.tabCommand("Google Chrome", "close_tab", "44", 1, true)).toBe("Inbox | ");
  expect(asked("post").at(-1)).toEqual({ hwnd: 44, kind: "up", x: 390, y: 170 });
  expect(asked("activate")).toEqual([]);
});

test("a navigation from behind that never goes is false, and a switch to a tab that never becomes active is an error", async () => {
  const view = { tabs: [{ title: "A", active: true, frame: [200, 150, 200, 40], close: null }, { title: "B", active: false, frame: [400, 150, 200, 40], close: null }], url: "https://a.example/", omnibox: [438, 227, 545, 37], omniboxValue: "a.example", buttons: {}, loading: false }; // prettier-ignore
  spyOn(process, "kill").mockImplementation(() => true);
  helper({ processes: [{ pid: 400, cmd: '"C:\\chrome.exe"' }], windows: [{ hwnd: 45, pid: 400, cls: "Chrome_WidgetWin_1", title: "A", frame: [0, 0, 1200, 800], core: 0, exe: "chrome.exe" }], browser: view, post: { ok: true }, chars: { ok: true }, vkey: { ok: true } });
  expect(await windows.openUrl("Google Chrome", "https://b.example/", { background: true, window: "45", newTab: false })).toBe(false); // the omnibox never held it: typed twice, and no Enter
  expect(asked("chars")).toHaveLength(2);
  expect(asked("vkey")).toEqual([]);
  await expect(windows.tabCommand("Google Chrome", "switch_tab", "45", 2, true)).rejects.toThrow("did not become the active tab");
  await expect(windows.openUrl("Google Chrome", "https://c.example/", { background: true, window: "99" })).rejects.toThrow("window is gone");
}, 15_000); // it waits out the omnibox twice and the tab twice, as the real thing would

test("with no browser running there are no tabs and no URL, and nothing is launched to ask", async () => {
  helper({ processes: [] });
  expect(await windows.browserTabs("Google Chrome")).toEqual([]);
  expect(await windows.browserUrl("Google Chrome")).toBeNull();
  expect(await windows.browserLoading("Google Chrome")).toBe(false);
  expect(await windows.tabCommand("Google Chrome", "reload")).toBeNull();
  expect(asked("launch")).toEqual([]);
});

test("a URL goes to the browser only as the parser spells it, and never with a quote, a space or a control character in it", () => {
  expect(windows.safeUrl("https://Example.com")).toBe("https://example.com/");
  expect(windows.safeUrl("file:///C:/work/page.html")).toBe("file:///C:/work/page.html");
  expect(() => windows.safeUrl('https://x" --proxy-server=evil "')).toThrow("quotes");
  expect(() => windows.safeUrl("https://example.com/a b")).toThrow("spaces");
  expect(() => windows.safeUrl("https://example.com/\u0007")).toThrow("control characters");
  expect(() => windows.safeUrl("javascript:alert(1)")).toThrow("only http, https and file");
  expect(() => windows.safeUrl("example")).toThrow("not a URL");
});

test("a background window is the browser window that was not there before, and the seat goes back to whoever had it", async () => {
  spyOn(process, "kill").mockImplementation(() => true);
  let launched = false;
  let front = { hwnd: 11, pid: 100 };
  const fresh = { hwnd: 46, pid: 400, cls: "Chrome_WidgetWin_1", title: "Example Domain - Google Chrome", frame: [50, 50, 1200, 800], core: 0, exe: "chrome.exe", caption: true };
  const own = { hwnd: 44, pid: 400, cls: "Chrome_WidgetWin_1", title: "Flights - Google Chrome", frame: [0, 0, 1200, 800], core: 0, exe: "chrome.exe", caption: true };
  helper({
    // The user's own Chrome carries no flags; with a profile of the hands' own named, only that instance counts as ours.
    processes: [{ pid: 300, cmd: '"C:\\chrome.exe"' }, { pid: 400, cmd: '"C:\\chrome.exe" --user-data-dir=C:\\hands\\browser' }],
    windows: () => (launched ? [fresh, own, ...desk()] : [own, ...desk()]),
    foreground: () => front,
    launch: () => ((launched = true), (front = { hwnd: 46, pid: 400 }), { pid: 400 }),
    activate: ({ hwnd }) => ((front = { hwnd: hwnd as number, pid: 100 }), { ok: true }),
  });
  await withEnv("HANDS_BROWSER_PROFILE", "C:\\hands\\browser", async () => {
    windows.releaseDesktop();
    expect(await windows.openBackgroundWindow("Google Chrome", "https://example.com/")).toEqual({ pid: 400, windowId: 46, scripted: "46" });
    const launch = asked("launch")[0]!;
    expect(launch.args).toContain('--user-data-dir="C:\\hands\\browser"');
    expect(launch.args).toContain('--new-window -- "https://example.com/"');
    expect(launch.show).toBe(4);
    expect(asked("activate")).toEqual([{ hwnd: 11 }]); // the terminal had the seat, and has it back
    expect(front).toEqual({ hwnd: 11, pid: 100 });
    expect(windows.mainWindowId(400)).toBe(46); // the hand's own, though the user's window of that process is in front of it
    windows.release(false);
    expect(asked("close")).toEqual([{ hwnd: 46 }]); // the browser window it opened goes with it
  });
});

test("menus and paging go to the app's front window; an app without one has no menu", () => {
  helper({ windows: desk(), menu: ({ path }) => ((path as string[]).length ? { pressed: "File > New" } : { items: ["File", "Edit"] }), scrollPage: { ok: true } });
  expect(windows.menu(200, [])).toEqual({ items: ["File", "Edit"] });
  expect(windows.menu(200, ["File", "New"])).toEqual({ pressed: "File > New" });
  expect(asked("menu")).toEqual([{ hwnd: 22, path: [] }, { hwnd: 22, path: ["File", "New"] }]);
  expect(() => windows.menu(999, [])).toThrow("no window");
  expect(windows.scrollPage(200, 22, "down")).toBe(true);
  expect(asked("scrollPage")).toEqual([{ hwnd: 22, direction: "down" }]);
});

test("the renderer is the helper in its hand mode", () => {
  spyOn(windows, "helperPath").mockReturnValue("C:\\x\\hands-abc.exe");
  const command = windows.rendererCommand();
  expect(command[1]).toBe("hand");
  expect(command[0]).toMatch(/hands-[0-9a-f]+\.exe$/);
});

test("an app the user has running is started again for a window of the hand's own, which is what the hand works in; the user's window never is", async () => {
  const theirs = { hwnd: 66, pid: 500, cls: "Notepad", title: ".env - Notepad", frame: [0, 0, 400, 500], core: 0, cloaked: false, exe: "Notepad.exe", caption: true };
  const mine = { hwnd: 55, pid: 500, cls: "Notepad", title: "Untitled - Notepad", frame: [0, 0, 400, 500], core: 0, cloaked: false, exe: "Notepad.exe", caption: true };
  const tip = { hwnd: 56, pid: 500, cls: "Xaml_WindowedPopupClass", title: "PopupHost", frame: [90, 30, 183, 63], core: 0, cloaked: false, exe: "Notepad.exe", popup: true, caption: false };
  let launched = false;
  helper({ processes: [{ pid: 500, cmd: '"C:\\notepad.exe"' }], windows: () => (launched ? [tip, theirs, mine] : [theirs]), launch: () => ((launched = true), { pid: 0 }), tree: LABELLED });
  windows.releaseDesktop();
  calls = [];
  expect(await windows.runInBackground("Notepad")).toBe(500);
  expect(asked("launch")).toHaveLength(1);
  expect(asked("sink")).toEqual([{ hwnd: 55 }]); // the fresh window, not the user's, and not the tooltip
  expect(windows.appWindows(500).map((w) => w.id)).toEqual([66, 55]); // the tooltip is not a window of the app
  expect(windows.mainWindowId(500)).toBe(55); // the hand's own, though the user's is in front
  windows.releaseDesktop();
});

test("an app that opens no second window gives its pid, and its window is the user's", async () => {
  const theirs = { hwnd: 66, pid: 500, cls: "SpotifyMainWindow", title: "Spotify", frame: [0, 0, 400, 500], core: 0, cloaked: false, exe: "Spotify.exe", caption: true };
  helper({ processes: [{ pid: 500, cmd: '"C:\\spotify.exe"' }], windows: [theirs], launch: { pid: 0 } });
  windows.releaseDesktop();
  calls = [];
  expect(await windows.runInBackground("Spotify", 0.2)).toBe(500);
  expect(asked("launch")).toHaveLength(1);
  expect(asked("send")).toEqual([]);
  expect(asked("sink")).toEqual([]); // never a window of the user's
  expect(windows.mainWindowId(500)).toBe(66);
  expect(windows.workingWindow(500)).toEqual({ windowId: 66, dialog: null, theirs: true });
});
