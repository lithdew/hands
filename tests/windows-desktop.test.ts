import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame } from "../src/models.ts";
import * as windows from "../src/windows.ts";

// Where a hand's windows are kept: behind the user's, or on a virtual desktop of its own when asked for; and what
// happens to them when the hand goes. The helper is a script of replies, as in tests/windows.test.ts.

type Args = Record<string, unknown>;
type Reply = ((args: Args) => unknown) | object | null;
let calls: [string, Args][];
const HOUSEKEEPING: Record<string, Reply> = { displays: [{ index: 0, frame: [0, 0, 2560, 1600] }], foreground: { hwnd: 11, pid: 100 }, sink: { ok: true }, processes: [], capture: { width: 400, height: 500 } }; // prettier-ignore

function helper(replies: Record<string, Reply>): void {
  spyOn(windows.native, "call").mockImplementation((command: string, args: Args = {}) => {
    calls.push([command, args]);
    const reply = replies[command] ?? HOUSEKEEPING[command];
    if (reply === undefined) throw new Error(`the test did not expect the helper to be asked for ${JSON.stringify(command)}`);
    return typeof reply === "function" ? (reply as (args: Args) => unknown)(args) : reply;
  });
}
const asked = (command: string) => calls.filter(([c]) => c === command).map(([, args]) => args);

const terminal = { hwnd: 11, pid: 100, cls: "CASCADIA_HOSTING_WINDOW_CLASS", title: "bun hands", frame: [0, 0, 900, 600] as Frame, core: 0, exe: "WindowsTerminal.exe", caption: true };
const notepad = { hwnd: 55, pid: 500, cls: "Notepad", title: "Untitled - Notepad", frame: [0, 0, 400, 500] as Frame, core: 0, exe: "Notepad.exe", caption: true };
const LABELLED = { nodes: ["Untitled", "File", "Edit", "Text editor"].map((label, i) => ({ id: i + 1, parent: i ? 1 : -1, role: "AXButton", label, frame: [0, 0, 50, 20], actions: [] })), capped: false };

let lockRoot: string;
let desktop: string | undefined;
beforeEach(() => {
  calls = [];
  windows.interrupt(false);
  windows.pace.persistMs = 0;
  windows.pace.seatWatchMs = 0;
  windows.pace.browserWatchMs = 0;
  lockRoot = mkdtempSync(join(tmpdir(), "hands-test-locks-"));
  windows.locks.root = lockRoot;
  desktop = process.env.HANDS_DESKTOP;
  spyOn(process, "kill").mockImplementation(() => {
    throw new Error("no such process");
  });
});
afterEach(() => {
  windows.releaseDesktop();
  mock.restore();
  rmSync(lockRoot, { recursive: true, force: true });
  if (desktop === undefined) delete process.env.HANDS_DESKTOP;
  else process.env.HANDS_DESKTOP = desktop;
});

test("desktops of the hands' own are asked for with HANDS_DESKTOP=1, and are off otherwise", () => {
  delete process.env.HANDS_DESKTOP;
  expect(windows.desktopsEnabled()).toBe(false);
  process.env.HANDS_DESKTOP = "0";
  expect(windows.desktopsEnabled()).toBe(false);
  process.env.HANDS_DESKTOP = "1";
  expect(windows.desktopsEnabled()).toBe(true);
});

test("when the shell's desktop interfaces fail (another Windows build), the app still opens, behind the user's windows, and desktops are off for the run", async () => {
  process.env.HANDS_DESKTOP = "1";
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  let launched = 0;
  helper({
    windows: () => [terminal, ...(launched ? [notepad] : []), ...(launched > 1 ? [{ ...notepad, hwnd: 56, pid: 501 }] : [])],
    launch: () => (launched++, { pid: 0 }),
    tree: LABELLED,
    desktop: () => {
      throw new Error("desktop: TypeInitializationException: The type initializer for 'VirtualDesktop.DesktopManager' threw an exception.");
    },
  });
  windows.releaseDesktop();
  expect(await windows.runInBackground("Notepad")).toBe(500);
  expect(asked("sink")).toEqual([{ hwnd: 55 }]);
  expect(windows.desktopsEnabled()).toBe(false);
  expect(windows.desktopNote()).toBeNull(); // not the app's fault: the model is not told it cannot work there
  expect(quiet).toHaveBeenCalledTimes(1);
  calls = [];
  expect(await windows.runInBackground("notepad.exe")).toBe(500); // the same window, worked in again
  expect(asked("desktop")).toEqual([]);
});

test("every 'Hands: ...' desktop a run left behind is swept, and a shell that does not answer sweeps none", () => {
  helper({ removeDesktops: ({ prefix }) => ({ removed: prefix === "Hands: " ? 3 : 0 }) });
  expect(windows.sweepDesktops()).toBe(3);
  mock.restore();
  helper({ removeDesktops: () => { throw new Error("removeDesktops: COMException"); } }); // prettier-ignore
  expect(windows.sweepDesktops()).toBe(0);
});

test("a hand released closes the browser windows it opened, unless they are to be kept, and leaves its other windows where they are", async () => {
  let front = { hwnd: 11, pid: 100 };
  let launched = 0;
  const chrome = { hwnd: 46, pid: 400, cls: "Chrome_WidgetWin_1", title: "Example - Google Chrome", frame: [50, 50, 1200, 800] as Frame, core: 0, exe: "chrome.exe", caption: true };
  helper({
    processes: ({ exe }) => (exe === "chrome.exe" ? [{ pid: 400, cmd: '"C:\\chrome.exe"' }] : []),
    windows: () => [terminal, ...(launched > 0 ? [chrome] : []), ...(launched > 1 ? [notepad] : [])],
    foreground: () => front,
    launch: () => (launched++, { pid: 0 }),
    activate: ({ hwnd }) => ((front = { hwnd: hwnd as number, pid: 100 }), { ok: true }),
    close: { ok: true },
    reg: { value: null },
  });
  spyOn(process, "kill").mockImplementation(() => true);
  windows.releaseDesktop();
  await windows.openBackgroundWindow("Google Chrome", "https://example.com/");
  await windows.runInBackground("Notepad");
  windows.release(true);
  expect(asked("close")).toEqual([]);
  launched = 0;
  await windows.openBackgroundWindow("Google Chrome", "https://example.com/");
  await windows.runInBackground("Notepad");
  windows.release(false);
  expect(asked("close")).toEqual([{ hwnd: 46 }]); // Notepad stays, with whatever the hand wrote in it
});

/**
 * The helper's parking of a window (Parking in windows.cs), as a fake: park puts the window past the right edge of
 * every screen and keeps where it was; unpark puts it back, forgetting it unless kept; a window it never parked that
 * lies on no screen is brought onto the primary one.
 */
function parking(window: () => { frame: Frame }, moveTo: (frame: Frame) => void) {
  let kept: Frame | null = null;
  return {
    park: () => ((kept ??= window().frame), moveTo([2560 + 64, kept[1], kept[2], kept[3]]), { ok: true }),
    unpark: ({ keep }: Args) => {
      if (kept) moveTo(kept);
      else if (window().frame[0] >= 2560) moveTo([680, 400, window().frame[2], window().frame[3]]);
      if (!keep) kept = null;
      return { ok: true };
    },
  };
}

test("a browser that paints unseen has the hand's window parked off every screen, never sent to a desktop; the seat and the user get it back on screen", async () => {
  process.env.HANDS_DESKTOP = "1";
  let front = { hwnd: 11, pid: 100 };
  let launched = 0;
  let chrome = { hwnd: 46, pid: 400, cls: "Chrome_WidgetWin_1", title: "Example - Google Chrome", frame: [50, 60, 1200, 800] as Frame, core: 0, exe: "chrome.exe", caption: true };
  const helperParks = parking(() => chrome, (frame) => (chrome = { ...chrome, frame }));
  helper({
    processes: ({ exe }) => (exe === "chrome.exe" ? [{ pid: 400, cmd: '"C:\\chrome.exe" --disable-features=CalculateNativeWinOcclusion' }] : []),
    windows: () => [terminal, ...(launched > 0 ? [chrome] : [])],
    foreground: () => front,
    launch: () => (launched++, { pid: 0 }),
    activate: ({ hwnd }) => ((front = { hwnd: hwnd as number, pid: 100 }), { ok: true, foreground: hwnd }),
    ...helperParks,
    reg: { value: null },
    input: { ok: true },
    setCursor: { ok: true },
    seat: { ok: true },
    cursor: [5, 5],
  });
  spyOn(process, "kill").mockImplementation(() => true);
  windows.releaseDesktop();
  await windows.openBackgroundWindow("Google Chrome", "https://example.com/");
  expect(asked("desktop")).toEqual([]);
  expect(asked("send")).toEqual([]);
  expect(asked("park")).toEqual([{ hwnd: 46 }]); // the helper keeps where it was, and puts it back if the hand is killed
  expect(chrome.frame.slice(0, 2)).toEqual([2560 + 64, 60]); // just past the right edge of the only screen
  calls = [];
  await windows.borrow({ pid: 400, windowId: 46 }, 0, async () => {
    expect(chrome.frame.slice(0, 2)).toEqual([50, 60]); // on screen for the seat's pointer
  });
  expect(asked("unpark")).toEqual([{ hwnd: 46, keep: true }]);
  expect(chrome.frame.slice(0, 2)).toEqual([2560 + 64, 60]); // and parked again after
  windows.release(true);
  expect(chrome.frame.slice(0, 2)).toEqual([50, 60]); // kept, it comes back where the user can find it
  expect(asked("close")).toEqual([]);
});

test("Show, in the hand's own process, brings a parked window back where it was for good, and no action's handback takes it away", async () => {
  let front = { hwnd: 11, pid: 100 };
  let launched = 0;
  let chrome = { hwnd: 46, pid: 400, cls: "Chrome_WidgetWin_1", title: "Example - Google Chrome", frame: [50, 60, 1200, 800] as Frame, core: 0, exe: "chrome.exe", caption: true };
  helper({
    processes: ({ exe }) => (exe === "chrome.exe" ? [{ pid: 400, cmd: '"C:\\chrome.exe" --disable-features=CalculateNativeWinOcclusion' }] : []),
    windows: () => [terminal, ...(launched > 0 ? [chrome] : [])],
    foreground: () => front,
    launch: () => (launched++, { pid: 0 }),
    activate: ({ hwnd }) => ((front = { hwnd: hwnd as number, pid: 400 }), { ok: true }),
    ...parking(() => chrome, (frame) => (chrome = { ...chrome, frame })),
    reg: { value: null },
    vkey: { ok: true },
    idle: { idleMs: 60_000, held: [], quiet: true, tick: 1 },
    input: { ok: true },
    seat: { ok: true },
    setCursor: { ok: true },
    cursor: [5, 5],
  });
  spyOn(process, "kill").mockImplementation(() => true);
  windows.releaseDesktop();
  await windows.openBackgroundWindow("Google Chrome", "https://example.com/");
  await windows.pressIn({ pid: 400, windowId: 46 }, "return"); // an action from behind: its handback holds for a while after
  calls = [];
  expect(windows.present(46)).toBe(true);
  expect(chrome.frame.slice(0, 2)).toEqual([50, 60]); // on screen where it was, before it takes the keyboard
  expect(asked("unpark")).toEqual([{ hwnd: 46 }]);
  expect(front.hwnd).toBe(46);
  await windows.screenshotWindow(46, "w.png"); // the next look: the window is the user's now, not one that came up by itself
  expect(asked("activate")).toEqual([{ hwnd: 46 }]);
  expect(asked("sink")).toEqual([]);
  await windows.borrow({ pid: 400, windowId: 46 }, 0, async () => {}); // nor parked again after a borrow
  expect(asked("park")).toEqual([]);
  expect(chrome.frame.slice(0, 2)).toEqual([50, 60]);
});

test("Show from a process that never parked the window (its hand is gone) still brings it onto a screen before it takes the keyboard", () => {
  let chrome = { hwnd: 46, pid: 400, cls: "Chrome_WidgetWin_1", title: "Example - Google Chrome", frame: [2560 + 64, 60, 1200, 800] as Frame, core: 0, exe: "chrome.exe", caption: true };
  const order: string[] = [];
  helper({
    windows: () => [terminal, chrome],
    ...parking(() => chrome, (frame) => (order.push("moved"), (chrome = { ...chrome, frame }))),
    activate: () => (order.push("activated"), { ok: true }),
  });
  windows.releaseDesktop();
  expect(windows.present(46)).toBe(true);
  expect(order).toEqual(["moved", "activated"]);
  expect(chrome.frame.slice(0, 2)).toEqual([680, 400]); // onto the primary screen
});

const view = (url: string | null, omnibox = true) => ({ tabs: [], url, omnibox: omnibox ? [0, 0, 500, 30] : null, omniboxValue: url ?? "", buttons: {}, loading: false });

test("a browser the hands start themselves is started painting what it cannot show", async () => {
  let launched = 0;
  const chrome = { hwnd: 46, pid: 400, cls: "Chrome_WidgetWin_1", title: "Example - Google Chrome", frame: [50, 60, 1200, 800] as Frame, core: 0, exe: "chrome.exe", caption: true };
  helper({
    processes: ({ exe }) => (exe === "chrome.exe" && launched ? [{ pid: 400, cmd: '"C:\\chrome.exe"' }] : []),
    windows: () => [terminal, ...(launched > 0 ? [chrome] : [])],
    launch: () => (launched++, { pid: 0 }),
    browser: view("https://example.com/"),
    reg: { value: null },
  });
  windows.releaseDesktop();
  await windows.openBackgroundWindow("Google Chrome", "https://example.com/");
  expect(String(asked("launch")[0]?.args)).toContain("--disable-features=CalculateNativeWinOcclusion");
});

test("a browser the hands start themselves may restore the user's session or ask for a profile: the hand's window is the one showing its page", async () => {
  let launched = 0;
  const window = (hwnd: number, title: string) => ({ hwnd, pid: 400, cls: "Chrome_WidgetWin_1", title, frame: [50, 60, 1200, 800] as Frame, core: 0, exe: "chrome.exe", caption: true });
  const [restored, picker, mine] = [window(47, "Inbox - Google Chrome"), window(48, "Google Chrome"), window(49, "Example - Google Chrome")];
  helper({
    processes: ({ exe }) => (exe === "chrome.exe" && launched ? [{ pid: 400, cmd: '"C:\\chrome.exe"' }] : []),
    windows: () => [terminal, ...(launched > 0 ? [restored, picker, mine] : [])],
    launch: () => (launched++, { pid: 0 }),
    browser: ({ hwnd }) => ({ 47: view("https://mail.example.org/inbox"), 48: view(null, false), 49: view("https://www.example.com/") })[hwnd as number],
    close: { ok: true },
    reg: { value: null },
  });
  windows.releaseDesktop();
  expect((await windows.openBackgroundWindow("Google Chrome", "https://example.com/")).windowId).toBe(49);
  windows.release(false);
  expect(asked("close")).toEqual([{ hwnd: 49 }]); // the user's restored window, and the picker, are left alone
});

test("a window of the hand's that climbed over the user's is put behind them again, but not one the user has in front, nor for a while after", async () => {
  let front = { hwnd: 11, pid: 100 };
  let list: object[] = [terminal];
  helper({ windows: () => list, foreground: () => front, launch: () => ((list = [terminal, notepad]), { pid: 0 }) });
  windows.releaseDesktop();
  await windows.runInBackground("Notepad");
  calls = [];
  list = [notepad, terminal]; // it climbed
  await windows.screenshotWindow(55, "w.png");
  expect(asked("sink")).toEqual([{ hwnd: 55 }]);
  front = { hwnd: 55, pid: 500 }; // the user brought it forward
  await windows.screenshotWindow(55, "w.png");
  front = { hwnd: 11, pid: 100 }; // and went back to the terminal: the hand's window is left where they had it
  await windows.screenshotWindow(55, "w.png");
  expect(asked("sink")).toEqual([{ hwnd: 55 }]);
  list = [terminal, { ...notepad, iconic: true }]; // or minimized it
  await windows.screenshotWindow(66, "w.png");
  expect(asked("sink")).toEqual([{ hwnd: 55 }]);
});

test("a window presented to the user comes onto their desktop, restored and in front, and is not sent back to the hand's", async () => {
  process.env.HANDS_DESKTOP = "1";
  let cloaked = false;
  let launched = false;
  let front = { hwnd: 11, pid: 100 };
  helper({
    windows: () => (launched ? [terminal, { ...notepad, cloaked }] : [terminal]),
    launch: () => ((launched = true), { pid: 0 }),
    desktop: { index: 1, created: true },
    send: () => ((cloaked = true), { ok: true }),
    onDesktop: () => ({ on: cloaked }),
    recall: () => ((cloaked = false), { ok: true }),
    removeDesktop: { removed: true },
    colours: { colours: 32, blank: false },
    tree: LABELLED,
    foreground: () => front,
    activate: ({ hwnd }) => ((front = { hwnd: hwnd as number, pid: 500 }), { ok: true }),
  });
  windows.releaseDesktop();
  await windows.runInBackground("Notepad");
  expect(asked("send")).toHaveLength(1);
  expect(windows.present(55)).toBe(true);
  expect(asked("recall")).toEqual([{ hwnd: 55 }]);
  expect(asked("activate")).toEqual([{ hwnd: 55 }]);
  front = { hwnd: 11, pid: 100 };
  await windows.screenshotWindow(55, "w.png");
  expect(asked("send")).toHaveLength(1); // left on the user's desktop
  expect(asked("sink")).toEqual([]);
  expect(windows.present(12345)).toBe(false);
});

test("a hand's desktop is taken down with the windows still on it brought behind the user's first", async () => {
  process.env.HANDS_DESKTOP = "1";
  let cloaked = false;
  let launched = false;
  helper({
    windows: () => (launched ? [terminal, { ...notepad, cloaked }] : [terminal]),
    launch: () => ((launched = true), { pid: 0 }),
    desktop: { index: 1, created: true },
    send: () => ((cloaked = true), { ok: true }),
    onDesktop: () => ({ on: cloaked }),
    recall: () => ((cloaked = false), { ok: true }),
    removeDesktop: { removed: true },
    colours: { colours: 32, blank: false },
    tree: LABELLED,
  });
  windows.releaseDesktop();
  await windows.runInBackground("Notepad");
  calls = [];
  windows.release(false);
  expect(calls.map(([c]) => c).filter((c) => c !== "windows")).toEqual(["recall", "sink", "removeDesktop"]);
});

test("a hand's Chrome window that climbed over the user's own Chrome windows is put behind them again: the same process is not the same owner", async () => {
  const userChrome = { hwnd: 44, pid: 400, cls: "Chrome_WidgetWin_1", title: "Inbox - Google Chrome", frame: [0, 0, 1200, 800] as Frame, core: 0, exe: "chrome.exe", caption: true };
  const handChrome = { ...userChrome, hwnd: 46, title: "Example - Google Chrome" };
  let launched = false;
  let list: object[] = [userChrome];
  helper({
    processes: ({ exe }) => (exe === "chrome.exe" ? [{ pid: 400, cmd: '"C:\\chrome.exe"' }] : []),
    windows: () => list,
    launch: () => ((launched = true), (list = [userChrome, handChrome]), { pid: 0 }),
    foreground: { hwnd: 44, pid: 400 },
    reg: { value: null },
  });
  spyOn(process, "kill").mockImplementation(() => true);
  windows.releaseDesktop();
  await windows.openBackgroundWindow("Google Chrome", "https://example.com/");
  expect(launched).toBe(true);
  calls = [];
  list = [handChrome, userChrome]; // it climbed, with nothing of another process behind it
  await windows.screenshotWindow(46, "w.png");
  expect(asked("sink")).toEqual([{ hwnd: 46 }]);
});

test("a window of the hand's that comes in front by itself, with no input from the user since it was behind, gives them back the window they had", async () => {
  let front = { hwnd: 11, pid: 100 };
  let list: object[] = [terminal];
  let idleMs = 60_000;
  helper({
    windows: () => list,
    foreground: () => front,
    launch: () => ((list = [terminal, notepad]), { pid: 0 }),
    activate: ({ hwnd }) => ((front = { hwnd: hwnd as number, pid: 100 }), { ok: true }),
    idle: () => ({ idleMs, held: [], quiet: true, tick: 1 }),
  });
  windows.releaseDesktop();
  await windows.runInBackground("Notepad");
  let now = 100_000;
  spyOn(performance, "now").mockImplementation(() => now);
  await windows.screenshotWindow(55, "w.png"); // seen behind the user's window
  calls = [];
  now += 1000;
  front = { hwnd: 55, pid: 500 }; // Notepad came forward by itself (an app that activates late)
  list = [notepad, terminal];
  await windows.screenshotWindow(55, "w.png");
  expect(asked("activate")).toEqual([{ hwnd: 11 }]);
  expect(asked("sink")).toEqual([{ hwnd: 55 }]);
  expect(front.hwnd).toBe(11);
  calls = [];
  now += 1000;
  front = { hwnd: 55, pid: 500 }; // this time the user brought it forward: they touched the mouse since the last look
  idleMs = 300;
  await windows.screenshotWindow(55, "w.png");
  expect(asked("activate")).toEqual([]);
  expect(asked("sink")).toEqual([]);
});

test("a window of the hand's that the user minimized is still the hand's to look at: restored behind their windows when it does, never taken for closed", async () => {
  let list: object[] = [terminal];
  helper({ windows: () => list, launch: () => ((list = [terminal, notepad]), { pid: 0 }), show: ({ hwnd }) => ((list = [terminal, notepad]), { ok: true, hwnd }) });
  windows.releaseDesktop();
  await windows.runInBackground("Notepad");
  list = [terminal, { ...notepad, iconic: true }]; // the user minimized it
  expect(windows.appWindows(500)).toEqual([{ id: 55, frame: [0, 0, 400, 500] }]); // still there: not closed
  calls = [];
  expect(windows.workingWindow(500)).toEqual({ windowId: 55, dialog: null, theirs: false });
  expect(asked("show")).toEqual([{ hwnd: 55 }]); // restored without activation...
  expect(asked("sink")).toEqual([{ hwnd: 55 }]); // ...behind the user's windows
  const theirs = { ...notepad, hwnd: 66, title: "notes.txt - Notepad", iconic: true };
  list = [terminal, theirs];
  expect(windows.appWindows(500)).toEqual([]); // a minimized window of the user's is theirs, where they put it
});

test("a browser window holding tabs the hand never saw is not closed with it: a link the user opened may have landed there", async () => {
  let launched = 0;
  let tabs = 1;
  const chrome = { hwnd: 46, pid: 400, cls: "Chrome_WidgetWin_1", title: "Example - Google Chrome", frame: [50, 50, 1200, 800] as Frame, core: 0, exe: "chrome.exe", caption: true };
  helper({
    processes: ({ exe }) => (exe === "chrome.exe" ? [{ pid: 400, cmd: '"C:\\chrome.exe"' }] : []),
    windows: () => [terminal, ...(launched > 0 ? [chrome] : [])],
    launch: () => (launched++, { pid: 0 }),
    browser: () => ({ tabs: Array.from({ length: tabs }, (_, i) => ({ title: `Tab ${i}`, active: i === 0, frame: null, close: null })), url: "https://example.com/", omnibox: [0, 0, 500, 30], omniboxValue: "example.com", buttons: {}, loading: false }),
    close: { ok: true },
    reg: { value: null },
  });
  spyOn(process, "kill").mockImplementation(() => true);
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  windows.releaseDesktop();
  await windows.openBackgroundWindow("Google Chrome", "https://example.com/");
  expect(await windows.browserTabs("Google Chrome")).toHaveLength(1); // the hand looks: one tab
  tabs = 2; // a tab it never saw
  windows.release(false);
  expect(asked("close")).toEqual([]);
  expect(quiet).toHaveBeenCalledTimes(1);
  launched = 0;
  tabs = 1;
  await windows.openBackgroundWindow("Google Chrome", "https://example.com/");
  await windows.browserTabs("Google Chrome");
  windows.release(false);
  expect(asked("close")).toEqual([{ hwnd: 46 }]); // what it saw is what it closes
});

test("a hand whose process ends without a close still puts back what it had out: its parked windows come back on screen, kept", async () => {
  let launched = 0;
  let chrome = { hwnd: 46, pid: 400, cls: "Chrome_WidgetWin_1", title: "Example - Google Chrome", frame: [50, 60, 1200, 800] as Frame, core: 0, exe: "chrome.exe", caption: true };
  helper({
    processes: ({ exe }) => (exe === "chrome.exe" ? [{ pid: 400, cmd: '"C:\\chrome.exe" --disable-features=CalculateNativeWinOcclusion' }] : []),
    windows: () => [terminal, ...(launched > 0 ? [chrome] : [])],
    launch: () => (launched++, { pid: 0 }),
    ...parking(() => chrome, (frame) => (chrome = { ...chrome, frame })),
    reg: { value: null },
    close: { ok: true },
  });
  spyOn(process, "kill").mockImplementation(() => true);
  windows.releaseDesktop();
  await windows.openBackgroundWindow("Google Chrome", "https://example.com/");
  expect(chrome.frame[0]).toBe(2560 + 64);
  windows.onExit(); // what process.on("exit") runs: a run from the command line that is done, or an error
  expect(chrome.frame.slice(0, 2)).toEqual([50, 60]);
  expect(asked("close")).toEqual([]); // its pages may be what the user was told to look at
  calls = [];
  windows.onExit(); // released already: nothing more to do
  expect(calls.filter(([c]) => c !== "windows")).toEqual([]);
});
