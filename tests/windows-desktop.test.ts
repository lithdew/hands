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
