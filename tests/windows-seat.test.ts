import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame } from "../src/models.ts";
import { SeatBusy, SeatTaken } from "../src/seat.ts";
import * as windows from "../src/windows.ts";
import { windowsSeat } from "../src/windows-seat.ts";

// Borrowing the seat, and the window a hand works in. The helper is a script of replies, as in tests/windows.test.ts.

type Args = Record<string, unknown>;
type Reply = ((args: Args) => unknown) | object | null;
let calls: [string, Args][];
const HOUSEKEEPING: Record<string, Reply> = { displays: [{ index: 0, frame: [0, 0, 2560, 1600] }], sink: { ok: true }, recall: { ok: true }, send: { ok: true }, cursor: [700, 400], setCursor: { ok: true }, exe: { name: "Notepad", path: "" } }; // prettier-ignore

function helper(replies: Record<string, Reply>): void {
  spyOn(windows.native, "call").mockImplementation((command: string, args: Args = {}) => {
    calls.push([command, args]);
    const reply = replies[command] ?? HOUSEKEEPING[command];
    if (reply === undefined) throw new Error(`the test did not expect the helper to be asked for ${JSON.stringify(command)}`);
    return typeof reply === "function" ? (reply as (args: Args) => unknown)(args) : reply;
  });
}
const asked = (command: string) => calls.filter(([c]) => c === command).map(([, args]) => args);

const terminal = { hwnd: 11, pid: 100, cls: "CASCADIA_HOSTING_WINDOW_CLASS", title: "bun hands", frame: [0, 0, 900, 600] as Frame, core: 0, exe: "WindowsTerminal.exe" };
const theirs = { hwnd: 66, pid: 500, cls: "Notepad", title: ".env - Notepad", frame: [0, 0, 400, 500] as Frame, core: 0, exe: "Notepad.exe", caption: true };
const mine = { hwnd: 55, pid: 500, cls: "Notepad", title: "Untitled - Notepad", frame: [0, 0, 400, 500] as Frame, core: 0, exe: "Notepad.exe", caption: true };
const QUIET = { idleMs: 60_000, held: [], quiet: true, tick: 777 };

/**
 * The machine for a borrow: the terminal in front, the hand's Notepad window behind the user's; activation moves the
 * foreground, and the seat's input is answered by `input`.
 */
function machine(options: { idle?: () => object; input?: (args: Args) => object; activate?: (hwnd: number) => boolean; list?: () => object[] } = {}) {
  let front = 11;
  let launched = false;
  const state = { get front() { return front; } }; // prettier-ignore
  helper({
    processes: [{ pid: 500, cmd: "notepad.exe" }],
    windows: () => options.list?.() ?? (launched ? [terminal, theirs, mine] : [terminal, theirs]),
    launch: () => ((launched = true), { pid: 0 }),
    foreground: () => ({ hwnd: front, pid: 1 }),
    activate: ({ hwnd }) => {
      if (options.activate && !options.activate(hwnd as number)) return { ok: false };
      front = hwnd as number;
      return { ok: true };
    },
    idle: () => options.idle?.() ?? QUIET,
    input: (args) => options.input?.(args) ?? { ok: true },
  });
  return state;
}

let lockRoot: string;
beforeEach(() => {
  calls = [];
  windows.pace.persistMs = 0;
  windows.pace.seatWatchMs = 0;
  windows.pace.browserWatchMs = 0;
  lockRoot = mkdtempSync(join(tmpdir(), "hands-test-locks-"));
  windows.locks.root = lockRoot;
});
afterEach(() => {
  windows.releaseDesktop();
  mock.restore();
  rmSync(lockRoot, { recursive: true, force: true });
});

test("a borrow brings the hand's window forward, runs the work's input as timed from the user's pause, and puts back the user's window, cursor and the hand's window", async () => {
  const seat = machine();
  windows.releaseDesktop();
  await windows.runInBackground("Notepad");
  calls = [];
  const holding: string[] = [];
  const result = await windowsSeat.withSeat(
    { pid: 500, windowId: 55 },
    async () => {
      expect(seat.front).toBe(55);
      expect(existsSync(join(lockRoot, windows.SEAT_LOCK))).toBe(true); // one hand at a time
      await windows.press("s", ["ctrl"]);
      return "saved";
    },
    { why: "pressing ctrl+s", onHolding: () => holding.push("holding"), onWaiting: () => holding.push("waiting") },
  );
  expect(result).toBe("saved");
  expect(holding).toEqual(["holding"]); // the user was away: no wait worth showing
  expect(asked("input")).toEqual([{ kind: "key", vk: 0x53, modifiers: [0x11], since: 777 }, { kind: "letgo" }]);
  expect(asked("activate")).toEqual([{ hwnd: 55 }, { hwnd: 11 }]);
  expect(seat.front).toBe(11);
  expect(asked("setCursor")).toEqual([{ x: 700, y: 400 }]);
  expect(asked("sink")).toEqual([{ hwnd: 55 }]);
  expect(existsSync(join(lockRoot, windows.SEAT_LOCK))).toBe(false);
});

test("a borrow waits for the user to pause, says so once it has waited a while, and gives up with SeatBusy when they never do", async () => {
  let now = 0;
  spyOn(performance, "now").mockImplementation(() => (now += 400));
  machine({ idle: () => ({ idleMs: 200, held: [], quiet: true, tick: 1 }) });
  const told: string[] = [];
  const work = mock(async () => "done");
  const borrowing = windowsSeat.withSeat({ pid: 500, windowId: 66 }, work, { why: "pressing ctrl+s", waitMs: 5000, onWaiting: () => told.push("waiting") });
  await expect(borrowing).rejects.toBeInstanceOf(SeatBusy);
  await expect(borrowing).rejects.toThrow("kept using the mouse or keyboard, so pressing ctrl+s did not happen");
  expect(told).toEqual(["waiting"]);
  expect(work).not.toHaveBeenCalled();
  expect(asked("activate")).toEqual([]);
});

test("nothing is borrowed while the user holds a key or a button, or a full-screen app is up", async () => {
  let now = 0;
  spyOn(performance, "now").mockImplementation(() => (now += 400));
  machine({ idle: () => ({ idleMs: 60_000, held: ["ctrl"], quiet: true, tick: 1 }) });
  await expect(windowsSeat.withSeat({ pid: 500, windowId: 66 }, async () => 1, { why: "a click", waitMs: 2000 })).rejects.toThrow("holding ctrl");
  mock.restore();
  spyOn(performance, "now").mockImplementation(() => (now += 400));
  machine({ idle: () => ({ idleMs: 60_000, held: [], quiet: false, tick: 1 }) });
  await expect(windowsSeat.withSeat({ pid: 500, windowId: 66 }, async () => 1, { why: "a click", waitMs: 2000 })).rejects.toThrow("full-screen");
  expect(asked("activate")).toEqual([]);
});

test("another hand's borrow is waited for; a lock whose owner has died is taken over", async () => {
  machine();
  const lock = join(lockRoot, windows.SEAT_LOCK);
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), String(process.pid)); // held, by a process that is alive
  await expect(windowsSeat.withSeat({ pid: 500, windowId: 66 }, async () => 1, { why: "a click", waitMs: 300 })).rejects.toThrow("another hand had the mouse and keyboard");
  writeFileSync(join(lock, "owner"), "999999"); // its owner is gone
  spyOn(process, "kill").mockImplementation(() => {
    throw new Error("no such process");
  });
  expect(await windowsSeat.withSeat({ pid: 500, windowId: 66 }, async () => "mine now", { why: "a click", waitMs: 300 })).toBe("mine now");
});

test("the user touching the mouse mid-borrow stops the work with SeatTaken, and the seat still goes back", async () => {
  const seat = machine({ input: (args) => (args.kind === "letgo" || args.kind === "down" ? { ok: true } : { ok: false, taken: "the user moved the mouse" }) });
  windows.releaseDesktop();
  await windows.runInBackground("Notepad");
  calls = [];
  const drawing = windowsSeat.withSeat(
    { pid: 500, windowId: 55 },
    async () => {
      await windows.drag([[10, 10], [40, 10]]);
      return "drawn";
    },
    { why: "drawing" },
  );
  await expect(drawing).rejects.toBeInstanceOf(SeatTaken);
  await expect(drawing).rejects.toThrow("the user moved the mouse");
  expect(asked("input").at(-1)).toEqual({ kind: "letgo" }); // a button the drag held is let go
  expect(seat.front).toBe(11);
  expect(asked("setCursor")).toEqual([{ x: 700, y: 400 }]);
  expect(existsSync(join(lockRoot, windows.SEAT_LOCK))).toBe(false);
});

test("a window that will not come forward is SeatBusy with nothing done", async () => {
  machine({ activate: (hwnd) => hwnd !== 55 });
  windows.releaseDesktop();
  await windows.runInBackground("Notepad");
  calls = [];
  const work = mock(async () => 1);
  await expect(windowsSeat.withSeat({ pid: 500, windowId: 55 }, work, { why: "a click" })).rejects.toThrow("would not come to the front");
  expect(work).not.toHaveBeenCalled();
  expect(asked("input")).toEqual([{ kind: "letgo" }]);
});

test("a window on the hand's own desktop is brought to the one on screen for a borrow, and sent back after", async () => {
  let cloaked = false;
  let front = 11;
  let launched = false;
  const labelled = { nodes: ["Untitled", "File", "Edit", "Text editor"].map((label, i) => ({ id: i + 1, parent: i ? 1 : -1, role: "AXButton", label, frame: [0, 0, 50, 20], actions: [] })), capped: false };
  helper({
    processes: [],
    windows: () => (launched ? [terminal, { ...mine, cloaked }] : [terminal]),
    launch: () => ((launched = true), { pid: 0 }),
    desktop: { index: 1, created: true },
    send: () => ((cloaked = true), { ok: true }),
    onDesktop: () => ({ on: cloaked }),
    recall: () => ((cloaked = false), { ok: true }),
    removeDesktop: { removed: true },
    tree: labelled,
    colours: { colours: 32, blank: false },
    foreground: () => ({ hwnd: front, pid: 1 }),
    activate: ({ hwnd }) => ((front = hwnd as number), { ok: true }),
    idle: QUIET,
    input: { ok: true },
  });
  process.env.HANDS_DESKTOP = "1";
  try {
    windows.releaseDesktop();
    await windows.runInBackground("Notepad");
    expect(cloaked).toBe(true);
    calls = [];
    await windowsSeat.withSeat({ pid: 500, windowId: 55 }, () => windows.clickAt([10, 10]), { why: "a click" });
    expect(asked("recall")).toEqual([{ hwnd: 55 }]);
    expect(asked("send")).toEqual([{ hwnd: 55, name: windows.desktopName() }]);
    expect(asked("sink")).toEqual([]);
    expect(front).toBe(11);
    windows.releaseDesktop();
  } finally {
    delete process.env.HANDS_DESKTOP;
  }
});

test("the window a hand works in follows a dialog its window has open, but not a flyout; a window of the user's says so", async () => {
  const open = { hwnd: 57, pid: 500, cls: "#32770", title: "Open", frame: [50, 50, 600, 400] as Frame, core: 0, exe: "Notepad.exe", owner: 55, caption: true, popup: true };
  const flyout = { hwnd: 58, pid: 500, cls: "Xaml_WindowedPopupClass", title: "", frame: [50, 50, 200, 100] as Frame, core: 0, exe: "Notepad.exe", owner: 55, popup: true, caption: false };
  let list: object[] = [terminal, theirs];
  let launched = false;
  helper({ processes: [{ pid: 500, cmd: "notepad.exe" }], windows: () => list, launch: () => ((launched = true), (list = [terminal, theirs, mine]), { pid: 0 }), foreground: { hwnd: 11, pid: 100 } });
  windows.releaseDesktop();
  await windows.runInBackground("Notepad");
  expect(launched).toBe(true);
  expect(windowsSeat.workingWindow(500)).toEqual({ windowId: 55, dialog: null, theirs: false });
  list = [open, terminal, theirs, { ...mine, enabled: false }]; // File > Open: a modal dialog, its owner disabled
  expect(windowsSeat.workingWindow(500)).toEqual({ windowId: 57, dialog: "Open", theirs: false });
  list = [flyout, terminal, theirs, mine]; // a menu's flyout is not a dialog to work in
  expect(windowsSeat.workingWindow(500)).toEqual({ windowId: 55, dialog: null, theirs: false });
  list = [{ ...open, title: "Replace", enabled: true }, terminal, theirs, mine]; // a modeless dialog with a title bar is
  expect(windowsSeat.workingWindow(500)).toEqual({ windowId: 57, dialog: "Replace", theirs: false });
  expect(windowsSeat.workingWindow(500, 66)).toEqual({ windowId: 66, dialog: null, theirs: true });
  expect(windowsSeat.workingWindow(500, 12345)).toBeNull(); // gone
});

test("once the hand's window is minimized its main window is still its own, and once it is closed there is none rather than the user's", async () => {
  let list: object[] = [terminal, theirs];
  helper({ processes: [{ pid: 500, cmd: "notepad.exe" }], windows: () => list, launch: () => ((list = [terminal, theirs, mine]), { pid: 0 }), foreground: { hwnd: 11, pid: 100 }, capture: { width: 400, height: 500 } });
  windows.releaseDesktop();
  await windows.runInBackground("Notepad");
  expect(windows.mainWindowId(500)).toBe(55);
  list = [terminal, theirs, { ...mine, iconic: true }]; // minimized
  await windows.screenshotWindow(66, "x.png"); // any capture runs the keeping of the hand's windows
  expect(windows.mainWindowId(500)).toBe(55);
  list = [terminal, theirs, mine]; // restored
  expect(windows.mainWindowId(500)).toBe(55);
  list = [terminal, theirs]; // closed
  await windows.screenshotWindow(66, "x.png");
  expect(windows.mainWindowId(500)).toBeNull();
  expect(windowsSeat.workingWindow(500)).toBeNull();
});

test("the user's idle time is the helper's, which leaves out input the helper sent itself", () => {
  helper({ idle: { idleMs: 4321, held: [], quiet: true, tick: 5 } });
  expect(windowsSeat.userIdleMs()).toBe(4321);
  mock.restore();
  helper({ idle: () => { throw new Error("idle: gone"); } }); // prettier-ignore
  expect(windowsSeat.userIdleMs()).toBe(0);
});
