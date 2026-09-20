import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Abort, type Frame } from "../src/models.ts";
import * as windows from "../src/windows.ts";

const DISPLAY: Frame = [0, 0, 2560, 1600];

/** The helper's window list, front to back: the terminal, a Paint window behind it, and a UWP Calculator behind both. */
const desk = () => [
  { hwnd: 11, pid: 100, cls: "CASCADIA_HOSTING_WINDOW_CLASS", title: "bun hands", frame: [0, 0, 900, 600], core: 0 },
  { hwnd: 22, pid: 200, cls: "MSPaintApp", title: "Untitled - Paint", frame: [100, 100, 1000, 700], core: 0 },
  { hwnd: 33, pid: 300, cls: "ApplicationFrameWindow", title: "Calculator", frame: [600, 300, 400, 500], core: 34 },
];

const node = (id: number, parent: number, role: string, label: string, extra: Partial<{ frame: Frame | null; actions: string[] }> = {}) => ({
  id, parent, role, label, frame: [120, 140, 80, 24] as Frame | null, actions: [] as string[], ...extra,
}); // prettier-ignore

type Args = Record<string, unknown>;
type Reply = ((args: Args) => unknown) | object | null;
let calls: [string, Args][];
/** A window put behind the user's, or on the hand's own desktop: asked after many things, never the point of most tests. */
const HOUSEKEEPING: Record<string, Reply> = { sink: { ok: true }, desktop: { index: 1, created: true }, send: { ok: true }, removeDesktop: { removed: true }, reg: { value: null } };

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

beforeEach(() => {
  calls = [];
  windows.interrupt(false);
});
afterEach(() => mock.restore());

test("the pure walk and its constants are the Mac's, re-exported rather than copied", () => {
  expect(windows.walkActionable).toBeDefined();
  expect(windows.AX_PRESS).toBe("AXPress");
  expect(windows.offDisplay([3000, 0, 10, 10], DISPLAY)).toBe(true);
  expect(windows.subtreeKey("AXButton", "OK", [1, 2, 3, 4])).toBe(JSON.stringify(["AXButton", "OK", 1, 2, 3, 4]));
});

test("an app's windows come front to back, a UWP frame is its app's, and the frontmost app is named by its exe", async () => {
  helper({ windows: desk(), exe: ({ pid }) => ({ name: { 100: "WindowsTerminal", 200: "mspaint", 300: "CalculatorApp", 400: "chrome", 500: "msedge" }[pid as number], path: "" }), foreground: { hwnd: 11, pid: 100 } });
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

test("a covered Chromium window is lifted, without activation, for the first read only", () => {
  const list = [{ hwnd: 44, pid: 400, cls: "Chrome_WidgetWin_1", title: "Example - Google Chrome", frame: [0, 0, 900, 600], core: 0 }, ...desk()];
  helper({ windows: () => [list[1], list[0]], exe: { name: "chrome" }, topmost: { ok: true }, tree: { nodes: [node(1, -1, "AXGroup", "x", { frame: [0, 0, 900, 600] }), node(2, 1, "AXLink", "Go", { actions: ["AXPress"] })], capped: false } });
  windows.actionableElements(400, DISPLAY, { windowId: 44 });
  expect(asked("topmost")).toEqual([{ hwnd: 44, on: true }, { hwnd: 44, on: false }]);
  windows.actionableElements(400, DISPLAY, { windowId: 44 });
  expect(asked("topmost")).toHaveLength(2);
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

test("key tables: letters, digits and punctuation are virtual keys, delete is Backspace, and cmd means Ctrl", () => {
  expect(windows.KEYCODES.a).toBe(0x41);
  expect(windows.KEYCODES["7"]).toBe(0x37);
  expect(windows.KEYCODES.delete).toBe(0x08);
  expect(windows.KEYCODES.forwarddelete).toBe(0x2e);
  expect(windows.KEYCODES["."]).toBe(0xbe);
  expect(windows.KEYCODES.f12).toBe(0x7b);
  expect(windows.MODIFIERS.cmd).toBe(windows.MODIFIERS.ctrl);
  expect(windows.MODIFIERS.option).toBe(0x12);
});

test("a key for a process is posted to its window; a key for nobody goes to the seat with its modifiers", async () => {
  helper({ windows: desk(), vkey: { ok: true }, input: { ok: true }, chars: { ok: true }, clipboard: { ok: true } });
  await windows.press("return", [], 300);
  await windows.press("l", ["cmd", "shift"]);
  await windows.typeText("hi\n", 200);
  await windows.typeText("seat");
  await windows.pasteText("long text");
  expect(asked("vkey")).toEqual([{ hwnd: 33, vk: 0x0d }]);
  expect(asked("chars")).toEqual([{ hwnd: 22, text: "hi\n" }]);
  expect(asked("input")).toEqual([{ kind: "key", vk: 0x4c, modifiers: [0x11, 0x10] }, { kind: "text", text: "seat" }, { kind: "key", vk: 0x56, modifiers: [0x11] }]);
  expect(asked("clipboard")).toEqual([{ text: "long text" }]);
  await expect(windows.press("hyper")).rejects.toThrow("unknown key");
  await expect(windows.press("a", ["hyper"])).rejects.toThrow("unknown modifier");
  await expect(windows.press("a", [], 999)).rejects.toThrow("no window");
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
  const target = { pid: 200, windowId: 22, frame: [100, 100, 1000, 700] as Frame, web: true };
  await windows.windowPointer(target, [[150, 150]], { count: 2 });
  expect(asked("post").map((a) => a.kind)).toEqual(["move", "down", "up", "down", "up"]);
  expect(asked("post")[1]).toEqual({ hwnd: 22, kind: "down", x: 150, y: 150 });
  calls = [];
  const seen: number[][] = [];
  await windows.windowPointer(target, [[150, 150], [150, 168]], { onMove: (at) => seen.push(at) });
  expect(asked("post").map((a) => a.kind)).toEqual(["move", "down", "drag", "drag", "drag", "up"]);
  expect(seen).toEqual([[150, 156], [150, 162], [150, 168]]);
  expect(windows.pointerAvailable()).toBe(true);
  expect(windows.focusWithoutRaise(22)).toBe(true);
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

test("captures name the window or the display, and a thumbnail is what the other agents ask the helper for", async () => {
  helper({ capture: ({ hwnd, display }) => ({ width: hwnd ? 886 : 2560, height: hwnd ? 593 : 1600 }) });
  expect(await windows.screenshotWindow(22, "w.png")).toEqual({ path: "w.png", width: 886, height: 593 });
  expect(await windows.screenshot({ index: 0, frame: DISPLAY }, "d.png")).toEqual({ path: "d.png", width: 2560, height: 1600 });
  expect(asked("capture")).toEqual([{ hwnd: 22, path: "w.png", format: "png" }, { display: 0, path: "d.png", format: "png" }]);
});

test("a covered window is slid to the nearest free strip at a screen's edge, without activation, until some of it shows", async () => {
  // The Paint window (22) lies entirely under the terminal (11), which covers the left of the screen; the right side is free.
  const cover = { hwnd: 11, pid: 100, cls: "X", title: "", frame: [0, 0, 1400, 1600], core: 0 };
  let paint = { hwnd: 22, pid: 200, cls: "MSPaintApp", title: "", frame: [100, 100, 1000, 700], core: 0 };
  helper({
    windows: () => [cover, paint],
    displays: [{ index: 0, frame: DISPLAY }],
    move: ({ x, y }) => ((paint = { ...paint, frame: [x as number, y as number, 1000, 700] }), { ok: true }),
  });
  expect(await windows.revealWindow(200, 22)).toBe(true);
  const moved = asked("move");
  expect(moved.length).toBeGreaterThan(0);
  expect(moved[0]).toMatchObject({ hwnd: 22 });
  expect((moved[0]!.x as number) + 1000).toBeGreaterThan(1400); // it now reaches past the cover's right edge
  expect(await windows.revealWindow(200, 22)).toBe(true); // already showing: nothing moves
  expect(asked("move")).toHaveLength(moved.length);
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
  const calculator = { hwnd: 55, pid: 500, cls: "ApplicationFrameWindow", title: "Calculator", frame: [0, 0, 400, 500], core: 56 };
  const frameOnly = { ...calculator, pid: 2716, core: 0 }; // the frame host's, until the app's own window is inside it
  helper({ processes: [], windows: () => (asks++ < 2 ? desk() : asks < 4 ? [...desk(), frameOnly] : [...desk(), calculator]), launch: { pid: 0 } });
  expect(await windows.runInBackground("Calculator")).toBe(500);
  expect(asked("launch")).toEqual([{ file: "calc.exe", args: "", show: 4 }]);
  expect(asked("processes")).toEqual([{ exe: "CalculatorApp.exe" }]);
  expect(asked("activate")).toEqual([]);
});

test("a UWP app stays on the desktop on screen, sunk: its tree and its frame's picture go blank on any other (measured on Calculator)", async () => {
  let asks = 0;
  const calculator = { hwnd: 55, pid: 500, cls: "ApplicationFrameWindow", title: "Calculator", frame: [0, 0, 400, 500], core: 56 };
  helper({ processes: [], windows: () => (asks++ < 2 ? desk() : [...desk(), calculator]), launch: { pid: 0 } });
  expect(await windows.runInBackground("Calculator")).toBe(500);
  expect(asked("send")).toEqual([]);
  expect(asked("sink")).toEqual([{ hwnd: 55 }]);
});

test("an app's window is moved to the hand's own desktop as it appears; a window there is the app's, but not on screen", async () => {
  const saved = process.env.HANDS_NAME;
  process.env.HANDS_NAME = "Lefty";
  const notepad = { hwnd: 55, pid: 500, cls: "Notepad", title: "Untitled - Notepad", frame: [0, 0, 400, 500], core: 0, cloaked: false };
  let launched = false;
  let sent = false;
  helper({ processes: [], windows: () => (launched ? [...desk(), { ...notepad, cloaked: sent }] : desk()), launch: () => ((launched = true), { pid: 0 }), send: () => ((sent = true), { ok: true }) });
  try {
    windows.releaseDesktop(); // an earlier test may have made one
    calls = [];
    expect(windows.desktopName()).toBe("Hands: Lefty");
    expect(await windows.runInBackground("Notepad")).toBe(500);
    expect(asked("desktop")).toEqual([{ name: "Hands: Lefty" }]);
    expect(asked("send")).toEqual([{ hwnd: 55, name: "Hands: Lefty" }]);
    expect(asked("sink")).toEqual([]); // on its own desktop there is nothing of the user's to go behind
    expect(windows.appWindows(500)).toEqual([{ id: 55, frame: [0, 0, 400, 500] }]); // the hand still finds and captures it
    expect(windows.mainWindowId(500)).toBe(55);
    expect(windows.allWindows().map((w) => w.id)).toEqual([11, 22, 33]); // covers, the reveal and the overlay see only the desktop on screen
    expect(await windows.revealWindow(500, 55)).toBe(true); // nothing to slide from under: no window of the user's lies over it
    expect(asked("move")).toEqual([]);
    windows.releaseDesktop();
    expect(asked("removeDesktop")).toEqual([{ name: "Hands: Lefty" }]);
    expect(asked("close")).toEqual([]); // no browser window of its own to close
  } finally {
    if (saved === undefined) delete process.env.HANDS_NAME;
    else process.env.HANDS_NAME = saved;
  }
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

test("the browser's tabs, URL and loading state are read off its windows; the page's own tab items are not tabs", async () => {
  const view = (hwnd: number) => ({
    tabs: [{ title: "Inbox", active: false, frame: [200, 150, 200, 40], close: [380, 160, 20, 20] }, { title: "Flights", active: true, frame: [400, 150, 200, 40], close: [580, 160, 20, 20] }],
    url: hwnd === 44 ? "https://flights.example.com/" : null, omnibox: [438, 227, 545, 37], omniboxValue: "flights.example.com", buttons: { Back: [170, 219, 52, 51], Reload: [278, 219, 52, 51], "New Tab": [578, 150, 43, 62] }, loading: hwnd === 45,
  }); // prettier-ignore
  const list = [{ hwnd: 44, pid: 400, cls: "Chrome_WidgetWin_1", title: "Flights - Google Chrome", frame: [0, 0, 1200, 800], core: 0 }, { hwnd: 45, pid: 400, cls: "Chrome_WidgetWin_1", title: "Inbox - Google Chrome", frame: [50, 50, 1200, 800], core: 0 }];
  spyOn(process, "kill").mockImplementation(() => true);
  helper({ processes: [{ pid: 400, cmd: '"C:\\chrome.exe"' }], windows: list, browser: ({ hwnd }) => view(hwnd as number), post: { ok: true }, chars: { ok: true }, vkey: { ok: true }, foreground: { hwnd: 11, pid: 100 } });
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
  // Behind: a tab is navigated by a click on the omnibox, the URL as characters, and Enter; nothing is activated.
  expect(await windows.openUrl("Google Chrome", "https://example.com/", { background: true, window: "45", newTab: false })).toBe(true);
  expect(asked("post").map((a) => [a.hwnd, a.kind, a.x, a.y])).toEqual([[45, "move", 711, 246], [45, "down", 711, 246], [45, "up", 711, 246]]);
  expect(asked("chars")).toEqual([{ hwnd: 45, text: "https://example.com/" }]);
  expect(asked("vkey")).toEqual([{ hwnd: 45, vk: 0x0d }]);
  expect(await windows.tabCommand("Google Chrome", "back", "44", undefined, true)).toBe("Flights | https://flights.example.com/");
  expect(asked("post").at(-1)).toEqual({ hwnd: 44, kind: "up", x: 196, y: 245 });
  expect(await windows.tabCommand("Google Chrome", "close_tab", "44", 1, true)).toBe("Inbox | ");
  expect(asked("post").at(-1)).toEqual({ hwnd: 44, kind: "up", x: 390, y: 170 });
  expect(asked("activate")).toEqual([]);
});

test("with no browser running there are no tabs and no URL, and nothing is launched to ask", async () => {
  helper({ processes: [] });
  expect(await windows.browserTabs("Google Chrome")).toEqual([]);
  expect(await windows.browserUrl("Google Chrome")).toBeNull();
  expect(await windows.browserLoading("Google Chrome")).toBe(false);
  expect(await windows.tabCommand("Google Chrome", "reload")).toBeNull();
  expect(asked("launch")).toEqual([]);
});

test("a background window is the browser window that was not there before, and the seat goes back to whoever had it", async () => {
  const saved = process.env.HANDS_BROWSER_PROFILE;
  process.env.HANDS_BROWSER_PROFILE = "C:\\hands\\browser";
  spyOn(process, "kill").mockImplementation(() => true);
  let launched = false;
  let front = { hwnd: 11, pid: 100 };
  const fresh = { hwnd: 46, pid: 400, cls: "Chrome_WidgetWin_1", title: "Example Domain - Google Chrome", frame: [50, 50, 1200, 800], core: 0 };
  const own = { hwnd: 44, pid: 400, cls: "Chrome_WidgetWin_1", title: "Flights - Google Chrome", frame: [0, 0, 1200, 800], core: 0 };
  helper({
    // The user's own Chrome carries no flags; with a profile of the hands' own named, only that instance counts as ours.
    processes: [{ pid: 300, cmd: '"C:\\chrome.exe"' }, { pid: 400, cmd: '"C:\\chrome.exe" --user-data-dir=C:\\hands\\browser' }],
    windows: () => (launched ? [fresh, own, ...desk()] : [own, ...desk()]),
    foreground: () => front,
    launch: () => ((launched = true), (front = { hwnd: 46, pid: 400 }), { pid: 400 }),
    activate: ({ hwnd }) => ((front = { hwnd: hwnd as number, pid: 100 }), { ok: true }),
  });
  try {
    expect(await windows.openBackgroundWindow("Google Chrome", "https://example.com/")).toEqual({ pid: 400, windowId: 46, scripted: "46" });
    const launch = asked("launch")[0]!;
    expect(launch.args).toContain('--user-data-dir="C:\\hands\\browser"');
    expect(launch.args).toContain('--new-window "https://example.com/"');
    expect(launch.show).toBe(4);
    expect(asked("activate")).toEqual([{ hwnd: 11 }]); // the terminal had the seat, and has it back
    expect(front).toEqual({ hwnd: 11, pid: 100 });
  } finally {
    if (saved === undefined) delete process.env.HANDS_BROWSER_PROFILE;
    else process.env.HANDS_BROWSER_PROFILE = saved;
  }
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
