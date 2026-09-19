import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Abort, type Frame } from "../src/models.ts";
import { onWindows } from "../src/platform.ts";
import * as windows from "../src/windows.ts";
import type { NativeSession, UiaNode } from "../src/windows.ts";

const DISPLAY: Frame = [0, 0, 1920, 1080];

const desk = (extra: Record<string, unknown> = {}) => ({
  foreground: 11,
  cursor: [400, 300],
  displays: [DISPLAY],
  windows: [
    { id: 11, pid: 100, app: "WindowsTerminal", title: "bun hands", minimized: false, frame: [0, 0, 900, 600] },
    { id: 22, pid: 200, app: "mspaint", title: "Untitled - Paint", minimized: false, frame: [100, 100, 1000, 700] },
    { id: 23, pid: 200, app: "mspaint", title: "Resize", minimized: true, frame: [0, 0, 300, 200] },
  ],
  ...extra,
});

const uia = (type: string, name: string, extra: Partial<UiaNode> = {}): UiaNode => ({
  ref: `22:42.${name.length}`, parent: 0, type, name, help: "", value: "", frame: [120, 140, 80, 24], offscreen: false, enabled: true, focused: false, password: false, actions: [], ...extra,
}); // prettier-ignore

let calls: (string | number)[][];

/** windows.cs replaced by a script of replies, the way tests/helpers.ts replaces the Mac: nothing here may start a process. */
function helper(replies: Record<string, unknown | ((args: (string | number)[]) => unknown)>): void {
  spyOn(windows.native, "run").mockImplementation((...args: (string | number)[]) => {
    calls.push(args);
    const reply = replies[String(args[0])];
    if (reply === undefined) throw new Error(`the test did not expect the helper to be asked for ${JSON.stringify(args[0])}`);
    return typeof reply === "function" ? reply(args) : reply;
  });
}

const text = (base64: string | number) => Buffer.from(String(base64), "base64").toString("utf8");

beforeEach(() => {
  calls = [];
  windows.stale();
  windows.interrupt(false);
});
afterEach(() => mock.restore());

test("the Mac stays the platform under test, whatever machine runs the tests", () => {
  expect(onWindows({ NODE_ENV: "test" }, "win32")).toBe(false);
  expect(onWindows({}, "win32")).toBe(true);
  expect(onWindows({ WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toBe(true);
  expect(onWindows({}, "linux")).toBe(false);
  expect(onWindows({}, "darwin")).toBe(false);
  expect(onWindows({ HANDS_PLATFORM: "windows", NODE_ENV: "test" }, "darwin")).toBe(true);
  expect(onWindows({ HANDS_PLATFORM: "macos" }, "win32")).toBe(false);
});

test("an app's windows come front to back, and a minimized one is not one of them", async () => {
  helper({ windows: desk() });
  expect(windows.appWindows(200)).toEqual([{ id: 22, frame: [100, 100, 1000, 700] }]);
  expect(windows.mainWindowId(200)).toBe(22);
  expect(windows.mainWindowId(999)).toBeNull();
  expect(windows.appName(200)).toBe("mspaint");
  expect(await windows.frontmostAppAndPid()).toEqual(["WindowsTerminal", 100]);
  expect(windows.displayFor([2000, 50, 100, 100]).frame).toEqual(DISPLAY); // off every display: the main one
});

test("the tree goes through the Mac's walk: its roles, its labels, its off-screen list", () => {
  const nodes = [
    uia("Pane", "", { ref: "22:1", parent: -1, frame: [100, 100, 1000, 700] }),
    uia("Button", "Red", { ref: "22:2", actions: ["invoke"] }),
    uia("Edit", "", { ref: "22:3", help: "Search", actions: ["value"], frame: [300, 140, 200, 24] }),
    uia("Button", "Greyed out", { ref: "22:4", actions: ["invoke"], enabled: false }),
    uia("Hyperlink", "Privacy", { ref: "22:5", actions: ["invoke"], frame: [120, 4000, 80, 24], offscreen: true }),
  ];
  helper({ windows: desk(), tree: { nodes } });
  const [found, offscreen, capped] = windows.actionableElements(200, DISPLAY, { windowId: 22 });
  expect(found.map((n) => [n.role, n.label, n.pressable, n.ref])).toEqual([
    ["AXButton", "Red", true, "22:2"],
    ["AXTextField", "Search", false, "22:3"],
    ["AXButton", "Greyed out", false, "22:4"],
  ]);
  expect(offscreen.map((n) => [n.label, n.ref])).toEqual([["Privacy", "22:5"]]);
  expect(capped).toBe(false);
  expect(calls.find((c) => c[0] === "tree")).toEqual(["tree", 22]);
});

test("a press, a value and a read each name the control by its reference, and text travels as base64", () => {
  helper({ act: (args: (string | number)[]) => ({ ok: true, tookFocus: false, value: args[3] === "value" ? "hello" : null }) });
  expect(windows.axPress("22:42.7")).toBe(true);
  expect(windows.axSetValue("22:42.7", 'say "hi"')).toBe(true);
  expect(windows.axValue("22:42.7")).toBe("hello");
  expect(windows.axPerform("22:42.7", "AXScrollToVisible")).toBe(true);
  expect(calls.map((c) => c.slice(0, 4))).toEqual([["act", "22", "22:42.7", "press"], ["act", "22", "22:42.7", "set"], ["act", "22", "22:42.7", "value"], ["act", "22", "22:42.7", "show"]]);
  expect(text(calls[1]![4]!)).toBe('say "hi"');
});

test("focus is never asked for: on Windows it activates the window", () => {
  helper({});
  expect(windows.axFocus("22:42.7")).toBe(false);
  expect(windows.axPerform("22:42.7", "AXConfirm")).toBe(false);
  expect(calls).toEqual([]);
});

test("a control that is gone is a refusal, not a crash", () => {
  helper({ act: () => { throw new Error("the control is gone"); } }); // prettier-ignore
  expect(windows.axPress("22:42.7")).toBe(false);
  expect(windows.axValue("22:42.7")).toBeNull();
  expect(windows.axPress(undefined)).toBe(false);
});

test("a key for a process is posted to its window; a key for nobody goes to the seat", async () => {
  helper({ windows: desk(), key: { ok: true }, input: { ok: true } });
  await windows.press("return", [], 200);
  await windows.press("l", ["control"]);
  expect(calls.filter((c) => c[0] !== "windows")).toEqual([["key", 22, 0x0d, ""], ["input", "key", 0x4c, "control"]]);
  await expect(windows.press("hyper")).rejects.toThrow("unknown key");
});

test("text is not typed at a window behind the user's, since it would land in theirs", async () => {
  helper({ windows: desk(), input: { ok: true } });
  await expect(windows.typeText("hello", 200)).rejects.toThrow("set the field's value");
  await windows.typeText("hello", 100);
  expect(text(calls.at(-1)![2]!)).toBe("hello");
});

test("an app started in the background starts minimized, is not waited for, and is put under every window", async () => {
  let asked = 0;
  const calculator = { id: 33, pid: 300, app: "CalculatorApp", title: "Calculator", minimized: true, frame: [0, 0, 320, 500] };
  helper({ windows: () => (asked++ < 2 ? desk() : desk({ windows: [...desk().windows, calculator] })), launch: { pid: 0, foreground: 11 }, behind: { ok: true, tookFocus: false } });
  expect(await windows.runInBackground("Calculator")).toBe(300);
  const launch = calls.find((c) => c[0] === "launch")!;
  expect([text(launch[1]!), launch[3]]).toEqual(["Calculator", "background"]);
  expect(calls.find((c) => c[0] === "behind")).toEqual(["behind", 33, 11]); // and the window the user was in is put back
  expect(calls.some((c) => c[0] === "front")).toBe(false);
});

test("an app that is already running is not started again", async () => {
  helper({ windows: desk() });
  expect(await windows.runInBackground("Paint")).toBe(200);
  expect(calls.some((c) => c[0] === "launch")).toBe(false);
});

test("the abort corner, read at most once a second", () => {
  helper({ windows: desk() });
  for (let i = 0; i < 10; i++) windows.checkAbort();
  expect(calls).toHaveLength(1);
  windows.stale();
  helper({ windows: desk({ cursor: [2, 3] }) });
  expect(() => windows.checkAbort()).toThrow(Abort);
  windows.interrupt();
  expect(() => windows.checkAbort()).toThrow("Ctrl-C");
});

test("the browser starts with a DevTools port, its accessibility tree on, and the three switches a covered page needs to keep running", () => {
  const args = windows.browserArguments("C:\\Users\\me\\AppData\\Local\\hands\\browser", "https://example.com/");
  for (const flag of ["--force-renderer-accessibility", "--disable-gpu-vsync", "--disable-frame-rate-limit", "--disable-background-timer-throttling"]) expect(args).toContain(flag);
  expect(args.some((a) => a.startsWith("--remote-debugging-port="))).toBe(true);
  expect(args.at(-1)).toBe("https://example.com/");
});

// ------------------------------------------------------------------ the browser, over devtools.ts

interface FakeTab {
  targetId: string;
  title: string;
  url: string;
  shows?: boolean;
  ready?: string;
}

/**
 * The helper's `devtools` mode replaced by a Chrome that answers: its tabs, a session per attach, what a page says of
 * itself. `listens` is asked each time a connection is opened; `sent` is every message any connection was given.
 */
function chrome(tabs: FakeTab[], options: { listens?: () => boolean; pid?: number } = {}) {
  const sent: any[] = [];
  let hangUp = () => {};
  const open = spyOn(windows.native, "session").mockImplementation((): NativeSession => {
    let say!: (reply: object) => void;
    const exited = Promise.withResolvers<number>();
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        say = (reply) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify(reply)}\n`));
        hangUp = () => {
          try {
            controller.close();
          } catch {
            // closed already
          }
          exited.resolve(0);
        };
      },
    });
    say((options.listens?.() ?? true) ? { Browser: "Chrome/153.0.0.0" } : { error: "nothing listens on DevTools port 9333" });
    const answer = (m: any): object => {
      const tab = tabs.find((t) => `S-${t.targetId}` === m.sessionId);
      if (m.method === "Target.getTargets") return { targetInfos: [{ targetId: "W", type: "service_worker", title: "", url: "" }, ...tabs.map(({ targetId, title, url }) => ({ targetId, type: "page", title, url }))] };
      if (m.method === "Target.attachToTarget") return { sessionId: `S-${m.params.targetId}` };
      if (m.method === "SystemInfo.getProcessInfo") return { processInfo: [{ type: "renderer", id: 999 }, { type: "browser", id: options.pid ?? 300 }] };
      if (m.method === "Runtime.evaluate") return { result: { value: { "document.visibilityState": tab?.shows ? "visible" : "hidden", "document.readyState": tab?.ready ?? "complete", "location.href": "https://asked.example/" }[m.params.expression as string] } }; // prettier-ignore
      return {};
    };
    const write = (line: string) => {
      const m = JSON.parse(line);
      sent.push(m);
      say({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), result: answer(m) });
    };
    return { stdout, stderr: new ReadableStream(), exited: exited.promise, write, end: () => hangUp(), kill: () => hangUp() };
  });
  return { sent, open, methods: () => sent.map((m) => m.method), hangUp: () => hangUp() };
}

/** The connection is the process's own, so a test gives it back. */
const hangUpBrowser = async () => {
  const cdp = await windows.browserCdp().catch(() => null);
  cdp?.close();
  await cdp?.closed;
  await Bun.sleep(0);
};

const TABS: FakeTab[] = [
  { targetId: "T1", title: "Inbox", url: "https://mail.example.com/" },
  { targetId: "T2", title: "Flights", url: "https://flights.example.com/", shows: true, ready: "loading" },
];

test("the browser's tabs come over one kept connection, and the one that shows is the one that says it is visible", async () => {
  const fake = chrome(TABS);
  expect(await windows.browserTabs("Google Chrome")).toEqual([
    { scripted: "T1", window: 1, tab: 1, active: false, title: "Inbox", url: "https://mail.example.com/" },
    { scripted: "T2", window: 1, tab: 2, active: true, title: "Flights", url: "https://flights.example.com/" },
  ]);
  expect(await windows.browserUrl("Google Chrome")).toBe("https://flights.example.com/");
  expect(await windows.browserUrl("Google Chrome", "T1")).toBe("https://mail.example.com/");
  expect(await windows.browserLoading("Google Chrome")).toBe(true);
  expect(await windows.browserLoading("Google Chrome", "T1")).toBe(false);
  expect(fake.open).toHaveBeenCalledTimes(1);
  expect(fake.open.mock.calls[0]!.slice(0, 1)).toEqual(["devtools"]);
  // Every session that was attached for a question was let go again.
  expect(fake.methods().filter((m) => m === "Target.attachToTarget").length).toBe(fake.methods().filter((m) => m === "Target.detachFromTarget").length);
  await hangUpBrowser();
});

test("a tab Chrome lists with no address yet is asked for it", async () => {
  chrome([{ targetId: "T1", title: "", url: "" }]);
  expect(await windows.browserUrl("Google Chrome")).toBe("https://asked.example/");
  await hangUpBrowser();
});

test("with no browser listening there are no tabs, and the next question tries again; a connection that went is opened once more", async () => {
  let up = false;
  const fake = chrome(TABS, { listens: () => up });
  expect(await windows.browserTabs("Google Chrome")).toEqual([]);
  expect(await windows.browserUrl("Google Chrome")).toBeNull();
  expect(await windows.browserLoading("Google Chrome")).toBe(false);
  expect(await windows.tabCommand("Google Chrome", "reload")).toBeNull();
  up = true;
  const opened = fake.open.mock.calls.length;
  expect(await windows.browserTabs("Google Chrome")).toHaveLength(2);
  expect(await windows.browserTabs("Google Chrome")).toHaveLength(2);
  expect(fake.open).toHaveBeenCalledTimes(opened + 1);
  fake.hangUp(); // Chrome was closed
  await Bun.sleep(80);
  expect(await windows.browserTabs("Google Chrome")).toHaveLength(2);
  expect(fake.open).toHaveBeenCalledTimes(opened + 2);
  await hangUpBrowser();
});

test("in the background a url opens in the tab that shows, a new tab is made behind it, and nothing is activated or brought forward", async () => {
  const fake = chrome(TABS);
  helper({});
  expect(await windows.openUrl("Google Chrome", "https://example.com/", { background: true })).toBe(true);
  expect(fake.sent.find((m) => m.method === "Page.navigate")).toMatchObject({ sessionId: "S-T2", params: { url: "https://example.com/" } });
  expect(await windows.openUrl("Google Chrome", "https://example.com/a", { background: true, window: "T1" })).toBe(true);
  expect(fake.sent.filter((m) => m.method === "Page.navigate").at(-1)).toMatchObject({ sessionId: "S-T1" });
  expect(await windows.openUrl("Google Chrome", "https://example.com/b", { background: true, newTab: true })).toBe(true);
  expect(fake.sent.find((m) => m.method === "Target.createTarget").params).toEqual({ url: "https://example.com/b", newWindow: false, background: true });
  await expect(windows.tabCommand("Google Chrome", "switch_tab", undefined, 1, true)).rejects.toThrow("cannot be brought up behind the user's windows");
  expect(await windows.tabCommand("Google Chrome", "close_tab", undefined, 1, true)).toBe("Inbox | https://mail.example.com/");
  expect(fake.sent.find((m) => m.method === "Target.closeTarget").params).toEqual({ targetId: "T1" });
  expect(await windows.tabCommand("Google Chrome", "back", "T2", undefined, true)).toBe("Flights | https://flights.example.com/");
  expect(fake.sent.at(-2)).toMatchObject({ method: "Runtime.evaluate", sessionId: "S-T2", params: { expression: "history.back()" } });
  expect(fake.methods()).not.toContain("Target.activateTarget");
  expect(fake.methods()).not.toContain("Page.bringToFront");
  expect(calls).toEqual([]); // the helper was asked for nothing: no window was touched
  await hangUpBrowser();
});

test("with the seat, a tab is switched to and the agent's browser comes forward: its own window, never the user's Chrome", async () => {
  const fake = chrome(TABS, { pid: 300 });
  helper({
    windows: desk({ windows: [{ id: 44, pid: 900, app: "chrome", title: "Flights - Google Chrome", minimized: false, frame: [0, 0, 1200, 800] }, { id: 33, pid: 300, app: "chrome", title: "Flights - Google Chrome", minimized: false, frame: [50, 50, 1200, 800] }] }), // prettier-ignore
    front: { ok: true },
  });
  expect(await windows.tabCommand("Google Chrome", "switch_tab", undefined, 1)).toBe("Inbox | https://mail.example.com/");
  expect(fake.sent.find((m) => m.method === "Target.activateTarget").params).toEqual({ targetId: "T1" });
  expect(await windows.openUrl("Google Chrome", "https://example.com/")).toBe(true);
  expect(calls.filter((c) => c[0] === "front")).toEqual([["front", 33]]);
  expect(await windows.browserWindow("T2")).toEqual({ id: 33, pid: 300, frame: [50, 50, 1200, 800] });
  await hangUpBrowser();
});

test("a browser that is not running is started minimized with the agent's profile, put under every window, and then listened to", async () => {
  const saved = { path: process.env.HANDS_BROWSER_PATH, profile: process.env.HANDS_BROWSER_PROFILE };
  Object.assign(process.env, { HANDS_BROWSER_PATH: "C:\\Chrome\\chrome.exe", HANDS_BROWSER_PROFILE: "C:\\hands\\browser" });
  let launched = false;
  const fake = chrome([{ targetId: "T9", title: "Example Domain", url: "https://example.com/", shows: true }], { listens: () => launched, pid: 300 });
  const started = { id: 33, pid: 300, app: "chrome", title: "Example Domain - Google Chrome", minimized: false, frame: [50, 50, 1200, 800] };
  helper({ windows: () => desk(launched ? { windows: [...desk().windows, started] } : {}), launch: () => ((launched = true), { pid: 300, foreground: 11 }), behind: { ok: true } });
  try {
    expect(await windows.openBackgroundWindow("Google Chrome", "https://example.com/")).toEqual({ pid: 300, windowId: 33, scripted: "T9" });
    const launch = calls.find((c) => c[0] === "launch")!;
    expect(text(launch[1]!)).toBe("C:\\Chrome\\chrome.exe");
    expect(text(launch[2]!)).toContain('"--user-data-dir=C:\\hands\\browser"');
    expect(text(launch[2]!)).toContain('"https://example.com/"');
    expect(launch[3]).toBe("background");
    expect(calls.find((c) => c[0] === "behind")).toEqual(["behind", 33, 11]);
    expect(calls.some((c) => c[0] === "front")).toBe(false);
    expect(fake.methods()).not.toContain("Page.navigate"); // it started on the page
  } finally {
    for (const [key, value] of [["HANDS_BROWSER_PATH", saved.path], ["HANDS_BROWSER_PROFILE", saved.profile]] as const) value === undefined ? delete process.env[key] : (process.env[key] = value); // prettier-ignore
    await hangUpBrowser();
  }
});

test("nothing is read off the pixels, and a capture's size comes off its header", () => {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(1280, 16);
  header.writeUInt32BE(800, 20);
  const path = join(mkdtempSync(join(tmpdir(), "hands-")), "shot.png");
  writeFileSync(path, header);
  expect(windows.captureAt(path)).toEqual({ path, width: 1280, height: 800 });
  expect(windows.recognizeText(path)).toEqual([]);
});

test("menus say what to do instead", () => {
  expect(() => windows.menu(200, ["File", "New"])).toThrow("press the menu bar item");
});
