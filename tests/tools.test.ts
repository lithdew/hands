import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import sharp from "sharp";
import { APIConnectionError, TypeSafeClient } from "@typesafe-ai/sdk";
import { hand } from "../src/hand.ts";
import { macSeat } from "../src/macos-seat.ts";
import * as macos from "../src/macos.ts";
import { Abort, type AxNode, type Frame } from "../src/models.ts";
import type { Line } from "../src/perception.ts";
import { seat } from "../src/platform.ts";
import { type KeyTarget, SeatBusy, type SeatOptions, SeatTaken, type WorkingWindow } from "../src/seat.ts";
import { chords, computerTools, filePath, lastCapture, settling, shellChord } from "../src/tools.ts";
import * as windows from "../src/windows.ts";
import { guardMachine } from "./helpers.ts";

// The hand's window: TextEdit's pid 500, window 55, 400x300 points at 100,50, captured at two pixels a point.
const PID = 500;
const WINDOW = 55;
const FRAME: Frame = [100, 50, 400, 300];

let dir: string;
let picture: string; // the window, blank
let changed: string; // the same window once something has come up in it
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hands-tools-"));
  [picture, changed] = [join(dir, "window.png"), join(dir, "changed.png")];
  await sharp({ create: { width: 800, height: 600, channels: 3, background: "#ffffff" } }).png().toFile(picture);
  await sharp({ create: { width: 800, height: 600, channels: 3, background: "#203040" } }).png().toFile(changed);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const SETTLING = settling.unchangedMs;
const REFLEXES = process.env.HANDS_REFLEXES;
beforeEach(() => {
  guardMachine();
  settling.unchangedMs = 0; // a picture that never changes would keep every look waiting for a late reaction
  process.env.HANDS_REFLEXES = "off"; // Jev's reflexes (src/reflex.ts) only where a test turns them on: whatever key .env holds, no look asks Jev
});
afterEach(() => {
  mock.restore();
  settling.unchangedMs = SETTLING;
  if (REFLEXES === undefined) delete process.env.HANDS_REFLEXES;
  else process.env.HANDS_REFLEXES = REFLEXES;
});

const field = (label: string, x: number, y: number, extra: Partial<AxNode> = {}): AxNode => ({ role: "AXTextField", label, x, y, w: 100, h: 20, pressable: true, ref: { label }, ...extra });
const button = (label: string, x: number, y: number): AxNode => ({ role: "AXButton", label, x, y, w: 60, h: 20, pressable: true, ref: { label } });

interface Desk {
  nodes?: AxNode[];
  lines?: Line[];
  working?: WorkingWindow | null;
  web?: boolean;
  app?: string;
}

/** The machine as the tools see it: one window of the hand's own, its picture, its controls, and nothing that reaches the real one. */
function desk({ nodes = [], lines = [], working, web = false, app = "TextEdit" }: Desk = {}) {
  spyOn(macos, "checkAbort").mockImplementation(() => {});
  spyOn(macos, "sleepWatching").mockImplementation(async () => {});
  spyOn(macos, "runInBackground").mockImplementation(async () => PID);
  spyOn(macos, "appWindows").mockImplementation(() => [{ id: WINDOW, frame: FRAME }]);
  spyOn(macos, "appName").mockImplementation(() => app);
  spyOn(macos, "releaseElements").mockImplementation(() => {});
  spyOn(macos, "screenshotWindow").mockImplementation(async () => ({ path: picture, width: 800, height: 600 }));
  spyOn(macos, "recognizeText").mockImplementation(() => lines);
  spyOn(macos, "actionableElements").mockImplementation(() => [nodes, [], false]);
  spyOn(macos, "isWebContentApp").mockImplementation(() => web);
  spyOn(seat, "workingWindow").mockImplementation((_pid, preferred) => (working === undefined ? { windowId: preferred ?? WINDOW, dialog: null, theirs: false } : working));
}

/** One hand's tools, and a way to call one by name that answers with its text. */
function hands() {
  const tools = computerTools({ runDir: dir, cwd: dir, onAbort: () => {} });
  const find = (name: string): AgentTool<any> => tools.find((tool) => tool.name === name)!;
  const call = async (name: string, params: object = {}) => {
    const result = await find(name).execute("call", params);
    return result.content.flatMap((block: { type: string; text?: string }) => (block.type === "text" ? [block.text!] : [])).join("\n");
  };
  return { call, find };
}

/** A borrow that is granted at once: the wait and the hold are announced, and the work is done. */
const granted = () =>
  spyOn(seat, "withSeat").mockImplementation(async <T>(_target: KeyTarget, work: () => Promise<T>, options: SeatOptions) => {
    options.onWaiting?.();
    options.onHolding?.();
    return work();
  });

/** Windows, for the length of one test: posted keys carry no modifiers there, and reach a browser window of the hand's own. */
async function asOnWindows<T>(work: () => Promise<T>): Promise<T> {
  const was = [process.env.HANDS_PLATFORM, seat.chordsFromBehind, seat.browserKeysFromBehind] as const;
  const keys = seat as { chordsFromBehind: boolean; browserKeysFromBehind: boolean };
  process.env.HANDS_PLATFORM = "windows";
  [keys.chordsFromBehind, keys.browserKeysFromBehind] = [false, true];
  try {
    return await work();
  } finally {
    if (was[0] === undefined) delete process.env.HANDS_PLATFORM;
    else process.env.HANDS_PLATFORM = was[0];
    [keys.chordsFromBehind, keys.browserKeysFromBehind] = [was[1], was[2]];
  }
}

test("a dialog the window has open is what is looked at, and the listing says so", async () => {
  desk({ working: { windowId: 56, dialog: "Save As", theirs: false } });
  spyOn(macos, "appWindows").mockImplementation(() => [{ id: 56, frame: [200, 150, 300, 200] }, { id: WINDOW, frame: FRAME }]);
  const shot = spyOn(macos, "screenshotWindow").mockImplementation(async () => ({ path: picture, width: 600, height: 400 }));
  const { call } = hands();
  const listing = await call("open_app", { name: "TextEdit" });
  expect(listing).toContain("a dialog is open: 'Save As'");
  expect(listing).not.toContain("the user's own");
  expect(seat.workingWindow).toHaveBeenCalledWith(PID, undefined);
  expect(new Set(shot.mock.calls.map(([id]) => id))).toEqual(new Set([56]));
});

test("a window that is the user's own says so, and that the hand acts there only as far as the task asks", async () => {
  desk({ working: { windowId: WINDOW, dialog: null, theirs: true } });
  const listing = await hands().call("open_app", { name: "TextEdit" });
  expect(listing).toContain("this TextEdit window is the user's own, not one of yours");
  expect(listing).toContain("only as far as the task asks");
});

test("an app with no window left says to open it again", async () => {
  desk({ working: null });
  await expect(hands().call("open_app", { name: "TextEdit" })).rejects.toThrow("TextEdit has no window open");
});

test("a picture the platform says may be old is said to be, and so are a Notepad window's tabs from earlier sessions", async () => {
  const tab = (label: string, x: number): AxNode => ({ role: "AXTab", label, x, y: 60, w: 100, h: 20, pressable: true, ref: { label } });
  desk({ app: "Notepad", nodes: [tab("Untitled", 110), tab("notes from Tuesday.txt", 220)] });
  spyOn(macos, "screenshotWindow").mockImplementation(async () => ({ path: picture, width: 800, height: 600, stale: true }));
  const listing = await hands().call("open_app", { name: "Notepad" });
  expect(listing).toContain("the screenshot may be out of date");
  expect(listing).toContain("The listing is read from the page itself where the page allows it");
  expect(listing).toContain("this window has 2 tabs: Notepad reopens the tabs of earlier sessions");
});

test("a Notepad on Windows that reopens a tab of an earlier session gets a new tab for the hand, once, and the model is told why", async () => {
  const tab = (label: string, x: number): AxNode => ({ role: "AXTab", label, x, y: 60, w: 100, h: 20, pressable: true, ref: { label } });
  desk({ app: "Notepad", nodes: [tab("hello from hands.. Modified.", 110), button("Add New Tab", 300, 60)] });
  const press = spyOn(macos, "axPress").mockImplementation(() => true);
  await asOnWindows(async () => {
    const { call } = hands();
    expect(await call("open_app", { name: "Notepad" })).toContain("a new tab was made for you: work only in it");
    expect(press.mock.calls.map(([ref]) => (ref as { label: string }).label)).toEqual(["Add New Tab"]);
    await call("open_app", { name: "Notepad" }); // the same window again: its tabs now include the hand's own
    expect(press).toHaveBeenCalledTimes(1);
  });
});

test("a Notepad that opens on one fresh tab is left as it is", async () => {
  const tab = (label: string, x: number): AxNode => ({ role: "AXTab", label, x, y: 60, w: 100, h: 20, pressable: true, ref: { label } });
  desk({ app: "Notepad", nodes: [tab("Untitled. Unmodified.", 110), button("Add New Tab", 300, 60)] });
  const press = spyOn(macos, "axPress").mockImplementation(() => true);
  await asOnWindows(async () => {
    expect(await hands().call("open_app", { name: "Notepad" })).not.toContain("new tab was made");
  });
  expect(press).not.toHaveBeenCalled();
});

test("a field's current value is listed with it", async () => {
  desk({ nodes: [field("Search", 150, 80, { value: "flights to Tokyo" })] });
  const listing = await hands().call("open_app", { name: "TextEdit" });
  expect(listing).toContain("field 'Search' = 'flights to Tokyo' @");
});

test("with nothing of the hand's open, `screen` reads the user's screen, and nothing on it can be acted on", async () => {
  desk();
  spyOn(macos, "frontmostAppAndPid").mockImplementation(async () => ["Mail", 700]);
  spyOn(macos, "frontmostWindowBounds").mockImplementation(async () => [0, 0, 400, 300]);
  spyOn(macos, "displayFor").mockImplementation(() => ({ index: 0, frame: [0, 0, 400, 300] }));
  spyOn(macos, "screenshot").mockImplementation(async () => ({ path: picture, width: 800, height: 600 }));
  spyOn(macos, "focusedField").mockImplementation(() => ({ role: "AXTextField", label: "Password", placeholder: "", value: "hunter2", x: 0, y: 0, w: 10, h: 10 }));
  spyOn(macos, "browserUrl").mockImplementation(async () => null);
  const { call } = hands();
  const listing = await call("screen");
  expect(listing).toContain("the user's own screen, only to read: Mail is in front");
  expect(listing).not.toContain("hunter2");
  await expect(call("click", { x: 10, y: 10 })).rejects.toThrow("only to be read");
  await expect(call("key", { keys: "return" })).rejects.toThrow("nothing of yours is open yet");
});

test("keys go to the window of the latest capture, from behind", async () => {
  desk();
  const pressed = spyOn(seat, "pressIn").mockImplementation(async () => {});
  const borrowed = spyOn(seat, "withSeat");
  const { call } = hands();
  await call("open_app", { name: "TextEdit" });
  expect(await call("key", { keys: "cmd+s return" })).toBe("pressed cmd+s return in TextEdit"); // the Mac posts a chord's modifiers too
  expect(pressed.mock.calls).toEqual([
    [{ pid: PID, windowId: WINDOW }, "s", ["cmd"]],
    [{ pid: PID, windowId: WINDOW }, "return", []],
  ]);
  expect(borrowed).not.toHaveBeenCalled();
});

test("where a posted key carries no modifier, a chord is pressed with the user's keyboard, and the hand shows the borrow", async () => {
  desk();
  const posted = spyOn(seat, "pressIn").mockImplementation(async () => {});
  const typed = spyOn(macos, "press").mockImplementation(async () => {});
  const borrowed = granted();
  const shown = spyOn(hand, "seat");
  const { call } = hands();
  await call("open_app", { name: "TextEdit" });
  const said = await asOnWindows(() => call("key", { keys: "ctrl+s" }));
  expect(said).toBe("pressed ctrl+s in TextEdit (borrowed the user's mouse and keyboard for a moment, and gave them back)");
  expect(borrowed.mock.calls[0]?.[0]).toEqual({ pid: PID, windowId: WINDOW });
  expect(borrowed.mock.calls[0]?.[2]).toMatchObject({ why: "pressing ctrl+s" });
  expect(typed.mock.calls).toEqual([["s", ["ctrl"]]]); // the seat's own keyboard: no window, no pid
  expect(posted).not.toHaveBeenCalled();
  expect(shown.mock.calls).toEqual([["waiting", "pressing ctrl+s"], ["holding", "pressing ctrl+s"], ["free"]]);
  // A plain key still goes from behind.
  expect(await asOnWindows(() => call("key", { keys: "tab" }))).toBe("pressed tab in TextEdit");
  expect(posted.mock.calls).toEqual([[{ pid: PID, windowId: WINDOW }, "tab", []]]);
});

test("keys that act on the whole desktop are never pressed", async () => {
  desk();
  const pressed = spyOn(seat, "pressIn").mockImplementation(async () => {});
  const { call } = hands();
  await call("open_app", { name: "TextEdit" });
  for (const keys of ["win", "win+r", "ctrl+escape", "alt+tab", "alt+f4", "return alt+tab"]) {
    await expect(call("key", { keys })).rejects.toThrow("is never pressed");
  }
  expect(pressed).not.toHaveBeenCalled();
  expect(shellChord("tab", ["ctrl"])).toBeNull(); // the next tab, in the window alone
  expect(shellChord("f4", ["ctrl"])).toBeNull();
  expect(chords("ctrl+shift+t + space")).toEqual([
    { key: "t", modifiers: ["ctrl", "shift"] },
    { key: "+", modifiers: [] },
    { key: "space", modifiers: [] },
  ]);
});

test("a borrow the seat never granted says why, with advice for that reason; one the user took back says so; the seat is marked free", async () => {
  desk();
  spyOn(macos, "press").mockImplementation(async () => {});
  const shown = spyOn(hand, "seat");
  const { call } = hands();
  await call("open_app", { name: "TextEdit" });
  const refused = (reason: string) =>
    spyOn(seat, "withSeat").mockImplementation(async () => {
      throw new SeatBusy(reason);
    });
  refused("the user kept using the mouse or keyboard, so pressing ctrl+s did not happen");
  await expect(asOnWindows(() => call("key", { keys: "ctrl+s" }))).rejects.toThrow(
    "nothing was done (pressing ctrl+s): the user kept using the mouse or keyboard, so pressing ctrl+s did not happen. Try again in a while, or finish with needs_you",
  );
  refused("the window is gone");
  await expect(asOnWindows(() => call("key", { keys: "ctrl+s" }))).rejects.toThrow("nothing was done (pressing ctrl+s): the window is gone. Look again with `screen`.");
  refused("another hand had the mouse and keyboard all this time, so pressing ctrl+s did not happen");
  await expect(asOnWindows(() => call("key", { keys: "ctrl+s" }))).rejects.toThrow("Try again shortly.");
  refused("Untitled - Notepad would not come to the front");
  await expect(asOnWindows(() => call("key", { keys: "ctrl+s" }))).rejects.toThrow("do it from behind if you can, or finish with needs_you");
  spyOn(seat, "withSeat").mockImplementation(async () => {
    throw new SeatTaken("the mouse moved");
  });
  await expect(asOnWindows(() => call("key", { keys: "ctrl+s" }))).rejects.toThrow("the user took the mouse back");
  expect(shown.mock.calls.filter(([state]) => state === "free")).toHaveLength(5);
});

test("a stop while the hand waits for the seat ends the tool as the stop it was, sends nothing, and marks the seat free", async () => {
  desk();
  const typed = spyOn(macos, "press").mockImplementation(async () => {});
  const shown = spyOn(hand, "seat");
  const aborted: string[] = [];
  const tools = computerTools({ runDir: dir, cwd: dir, onAbort: (why) => void aborted.push(why) });
  const call = (name: string, params: object) => tools.find((tool) => tool.name === name)!.execute("call", params);
  await call("open_app", { name: "TextEdit" });
  // The platform's wait for a pause reads the interrupt a stop sets (src/windows.ts), and throws.
  spyOn(seat, "withSeat").mockImplementation(async (_target, _work, options) => {
    options.onWaiting?.();
    throw new Abort("stopped");
  });
  await expect(asOnWindows(() => call("key", { keys: "ctrl+s" }))).rejects.toBeInstanceOf(Abort);
  expect(aborted).toEqual(["stopped"]);
  // A stop that comes as the seat is granted is caught before the work sends anything.
  spyOn(seat, "withSeat").mockImplementation(async (_target, work) => work());
  spyOn(macos, "checkAbort").mockImplementationOnce(() => {}).mockImplementation(() => {
    throw new Abort("stopped");
  });
  await expect(asOnWindows(() => call("key", { keys: "ctrl+s" }))).rejects.toBeInstanceOf(Abort);
  expect(typed).not.toHaveBeenCalled();
  expect(shown.mock.calls.filter(([state]) => state === "free")).toHaveLength(2);
});

test("seat=true on a click clicks the user's mouse at the point on screen now", async () => {
  desk({ nodes: [button("Send", 300, 200)] });
  const clicked = spyOn(macos, "clickAt").mockImplementation(async () => {});
  granted();
  const { call } = hands();
  const listing = await call("open_app", { name: "TextEdit" });
  const index = Number(/(\d+) button 'Send'/.exec(listing)![1]);
  expect(await asOnWindows(() => call("click", { item: index, seat: true }))).toBe("clicked 'Send' (borrowed the user's mouse and keyboard for a moment, and gave them back)");
  expect(clicked.mock.calls).toEqual([[[330, 210], { count: 1 }]]); // the button's centre, where the window is
});

test("there is no right click: it is refused with what to use instead, and the seat is not borrowed", async () => {
  desk();
  const clicked = spyOn(macos, "clickAt").mockImplementation(async () => {});
  const borrowed = granted();
  const { call, find } = hands();
  await call("open_app", { name: "TextEdit" });
  for (const borrow of [false, true]) {
    await expect(asOnWindows(() => call("click", { x: 20, y: 30, button: "right", seat: borrow }))).rejects.toThrow("there is no right click: a context menu cannot be used from behind");
  }
  expect(borrowed).not.toHaveBeenCalled();
  expect(clicked).not.toHaveBeenCalled();
  expect(find("click").parameters.properties.button).toBeUndefined();
  expect(find("click").description).toContain("There is no right click");
});

test("the Mac borrows nothing: seat=true is not offered there, and a borrow that is asked for says to do it from behind", async () => {
  desk();
  const typed = spyOn(macos, "press").mockImplementation(async () => {});
  const shown = spyOn(hand, "seat");
  const { call, find } = hands();
  for (const name of ["click", "drag", "type", "key", "scroll"]) expect(find(name).parameters.properties.seat).toBeUndefined();
  expect(find("open_app").parameters.properties.file).toBeUndefined(); // nor a document by its file, which the Mac cannot open as a window of the hand's
  await call("open_app", { name: "TextEdit" });
  const said = await call("key", { keys: "cmd+s", seat: true }); // a model that passes it all the same
  expect(said).toStartWith("nothing was done (pressing cmd+s): borrowing the user's mouse and keyboard is not available on the Mac yet");
  expect(said).toContain("finish with needs_you");
  expect(typed).not.toHaveBeenCalled();
  expect(shown.mock.calls.at(-1)).toEqual(["free"]);
  const onWindows = await asOnWindows(async () => hands().find);
  for (const name of ["click", "drag", "type", "key", "scroll"]) expect(onWindows(name).parameters.properties.seat).toBeDefined();
  expect(onWindows("open_app").parameters.properties.file).toBeDefined();
});

test("the Mac's browser window takes no keys from behind, and the error does not send the model to the seat", async () => {
  desk({ app: "Google Chrome" });
  spyOn(macos, "openBackgroundWindow").mockImplementation(async () => ({ pid: PID, windowId: WINDOW, scripted: String(WINDOW) }));
  spyOn(macos, "stageWindow").mockImplementation(async () => {});
  spyOn(macos, "browserLoading").mockImplementation(async () => false);
  spyOn(macos, "browserUrl").mockImplementation(async () => "https://example.com/");
  spyOn(macos, "browserTabs").mockImplementation(async () => []);
  const { call } = hands();
  await call("browser", { action: "open", url: "https://example.com" });
  const refused = await call("key", { keys: "return" }).then(
    () => null,
    (error: Error) => error.message,
  );
  expect(refused).toContain("Press the page's own controls instead");
  expect(refused).not.toContain("seat=true");
});

test("in the hand's browser window on Windows, Tab is never pressed, from behind or with the seat", async () => {
  desk({ app: "Google Chrome" });
  spyOn(macos, "openBackgroundWindow").mockImplementation(async () => ({ pid: PID, windowId: WINDOW, scripted: String(WINDOW) }));
  spyOn(macos, "stageWindow").mockImplementation(async () => {});
  spyOn(macos, "browserLoading").mockImplementation(async () => false);
  spyOn(macos, "browserUrl").mockImplementation(async () => "https://example.com/");
  spyOn(macos, "browserTabs").mockImplementation(async () => []);
  const posted = spyOn(seat, "pressIn").mockImplementation(async () => {});
  const typed = spyOn(seat, "typeIn").mockImplementation(async () => {});
  const borrowed = granted();
  const { call } = hands();
  await call("browser", { action: "open", url: "https://example.com" });
  await asOnWindows(async () => {
    for (const keys of ["tab", "shift+tab", "a tab return"]) await expect(call("key", { keys })).rejects.toThrow("is not pressed in your browser window");
    await expect(call("key", { keys: "tab", seat: true })).rejects.toThrow("Click the field you want instead");
    await expect(call("type", { text: "a\tb" })).rejects.toThrow("is not pressed in your browser window");
    expect(await call("key", { keys: "return" })).toBe("pressed return in Google Chrome");
  });
  expect(posted.mock.calls).toEqual([[{ pid: PID, windowId: WINDOW }, "return", []]]);
  expect(typed).not.toHaveBeenCalled();
  expect(borrowed).not.toHaveBeenCalled();
});

test("a click the guard could not make for a busy user says so, and does not send the model to the seat", async () => {
  desk({ nodes: [button("Send", 300, 200)] });
  spyOn(macos, "axPress").mockImplementation(() => {
    throw new SeatBusy("the user did not pause long enough for a click");
  });
  const { call } = hands();
  const listing = await call("open_app", { name: "TextEdit" });
  const index = Number(/(\d+) button 'Send'/.exec(listing)![1]);
  const clicked = call("click", { item: index });
  await expect(clicked).rejects.toThrow("nothing was done (clicking 'Send'): the user did not pause long enough for a click. The user was busy, or another hand had the mouse and keyboard; try again shortly.");
});

test("a line break a page refuses from behind is sent back as advice, and seat=true types it with shift+Enter between the lines", async () => {
  desk({ web: true, app: "Slack" });
  spyOn(seat, "typeIn").mockImplementation(async () => {
    throw new Error("line break: a page takes Enter as send");
  });
  const keys: string[] = [];
  spyOn(macos, "typeText").mockImplementation(async (text) => void keys.push(text));
  spyOn(macos, "press").mockImplementation(async (key, modifiers = []) => void keys.push([...modifiers, key].join("+")));
  granted();
  const { call } = hands();
  await call("open_app", { name: "Slack" });
  await expect(call("type", { text: "hello\nworld" })).rejects.toThrow("write it on one line, or pass seat=true");
  expect(await call("type", { text: "hello\nworld", seat: true })).toStartWith("typed 'hello\\nworld' into Slack");
  expect(keys).toEqual(["hello", "shift+return", "world"]);
});

test("typing into Office on Windows goes through the seat, since Excel takes posted characters badly", async () => {
  desk({ app: "EXCEL" });
  const posted = spyOn(seat, "typeIn").mockImplementation(async () => {});
  const typed = spyOn(macos, "typeText").mockImplementation(async () => {});
  granted();
  const { call } = hands();
  await call("open_app", { name: "Excel" });
  expect(await asOnWindows(() => call("type", { text: "=A1*2\n" }))).toContain("borrowed the user's mouse and keyboard");
  expect(typed.mock.calls).toEqual([["=A1*2\n"]]); // Enter moves to the next cell there, as it should
  expect(posted).not.toHaveBeenCalled();
});

test("on Windows a drag in an app that is not a web page is the user's mouse; in a page it stays a pointer of the hand's own", async () => {
  desk();
  const dragged = spyOn(macos, "drag").mockImplementation(async () => {});
  const pointer = spyOn(macos, "windowPointer").mockImplementation(async () => {});
  spyOn(macos, "revealWindow").mockImplementation(async () => true);
  granted();
  const { call } = hands();
  await call("open_app", { name: "Paint" });
  const stroke = [[[10, 10], [50, 60]]];
  expect(await asOnWindows(() => call("drag", { strokes: stroke }))).toContain("borrowed");
  expect(dragged.mock.calls[0]?.[0]).toEqual([[110, 60], [150, 110]]);
  spyOn(macos, "isWebContentApp").mockImplementation(() => true);
  expect(await asOnWindows(() => call("drag", { strokes: stroke }))).toBe("dragged 1 stroke with a pointer of your own");
  expect(pointer).toHaveBeenCalledTimes(1);
});

test("a field typed into from behind that reads back otherwise is said as it is, not refused", async () => {
  desk({ nodes: [field("Message", 150, 80)] });
  spyOn(macos, "axSetValue").mockImplementation(() => true);
  spyOn(macos, "axValue").mockImplementation(() => "Hi Taro — here are");
  const { call } = hands();
  const listing = await call("open_app", { name: "TextEdit" });
  const index = Number(/(\d+) field 'Message'/.exec(listing)![1]);
  expect(await call("type", { item: index, text: "Hi  Taro — here are five" })).toContain("which now holds 'Hi Taro — here are' (18 characters; 24 were typed)");
  spyOn(macos, "axValue").mockImplementation(() => "Hi Taro — here are five");
  expect(await call("type", { item: index, text: "Hi  Taro — here are five" })).toBe("set 'Message' to 'Hi  Taro — here are five'");
});

test("the browser: the verified url is reported, a page that did not open is an error naming the one showing, and a closed window is replaced", async () => {
  desk({ app: "Google Chrome" });
  const pinned = { pid: PID, windowId: WINDOW, scripted: String(WINDOW) };
  const made = spyOn(macos, "openBackgroundWindow").mockImplementation(async () => pinned);
  spyOn(macos, "stageWindow").mockImplementation(async () => {});
  spyOn(macos, "browserLoading").mockImplementation(async () => false);
  let showing = "https://example.com/landing";
  spyOn(macos, "browserUrl").mockImplementation(async () => showing);
  spyOn(macos, "browserTabs").mockImplementation(async () => [
    { scripted: String(WINDOW), window: 2, tab: 1, active: false, title: "Old", url: "" },
    { scripted: String(WINDOW), window: 2, tab: 2, active: true, title: "Landing", url: showing },
    { scripted: "999", window: 1, tab: 1, active: true, title: "The user's", url: "" },
  ]);
  const { call } = hands();
  const opened = await call("browser", { action: "open", url: "https://example.com" });
  expect(opened).toStartWith("opened https://example.com/landing in your own window");
  expect(opened).toContain("tabs: 2 (active: Landing)");
  spyOn(macos, "openUrl").mockImplementation(async () => false);
  showing = "https://example.com/stale";
  await expect(call("browser", { action: "open", url: "https://example.com/next" })).rejects.toThrow("https://example.com/next did not open: your window still shows https://example.com/stale");
  spyOn(macos, "appWindows").mockImplementation((pid) => (pid === PID ? [{ id: 77, frame: FRAME }] : []));
  made.mockImplementation(async () => ({ pid: PID, windowId: 77, scripted: "77" }));
  expect(await call("browser", { action: "open", url: "https://example.com" })).toContain("your earlier window had been closed, so this is a new one");
  expect(made).toHaveBeenCalledTimes(2);
});

test("on Windows, a browser window that a link of the user's landed in is theirs: the hand forgets it, is told why, and opens one of its own", async () => {
  desk({ app: "Google Chrome" });
  const made = spyOn(macos, "openBackgroundWindow").mockImplementation(async () => ({ pid: PID, windowId: WINDOW, scripted: String(WINDOW) }));
  spyOn(macos, "stageWindow").mockImplementation(async () => {});
  spyOn(macos, "browserLoading").mockImplementation(async () => false);
  spyOn(macos, "browserUrl").mockImplementation(async () => "https://example.com/");
  spyOn(macos, "browserTabs").mockImplementation(async () => []);
  await asOnWindows(async () => {
    const { call } = hands();
    await call("browser", { action: "open", url: "https://example.com" });
    const givenUp = new Set([WINDOW]);
    spyOn(windows, "isGivenUp").mockImplementation((id) => givenUp.has(id));
    made.mockImplementation(async () => ({ pid: PID, windowId: 77, scripted: "77" }));
    spyOn(macos, "appWindows").mockImplementation((pid) => (pid === PID ? [{ id: 77, frame: FRAME }] : []));
    // Straight to the next open, as after an action that was refused: the window is let go, and the new one says why.
    expect(await call("browser", { action: "open", url: "https://example.com/next" })).toContain(
      "(a link the user opened from another app had landed in your earlier window, which is theirs now, so this is a new one)",
    );
    expect(made).toHaveBeenCalledTimes(2);
    givenUp.add(77);
    await expect(call("screen", {})).rejects.toThrow(windows.LINK_LANDED); // or at the next look, which forgets it
    await expect(call("browser", { action: "back" })).rejects.toThrow("no page is open yet: `browser` open a url first");
    // Found in the middle of a look (its read of the window's tabs): no listing or picture of the user's tab comes back.
    made.mockImplementation(async () => ({ pid: PID, windowId: 78, scripted: "78" }));
    spyOn(macos, "appWindows").mockImplementation((pid) => (pid === PID ? [{ id: 78, frame: FRAME }] : []));
    await call("browser", { action: "open", url: "https://example.com" });
    spyOn(macos, "browserUrl").mockImplementation(async () => {
      givenUp.add(78);
      return "https://example.com/";
    });
    await expect(call("screen", {})).rejects.toThrow(windows.LINK_LANDED);
  });
});

// ------------------------------------------------------------------ the clicker

type JevState = { elements: string[]; text_to_type?: string; already_tried_on_this_screen?: string[] };
type JevQuestions = Record<string, { type: string; criteria?: Record<string, unknown> }>;
const jevAnswer = (choice: string, confidence = 0.97, probabilities: Record<string, number> = { [choice]: confidence }) => ({ type: "choice", choice, confidence, probabilities });
/** The id of the item whose line in Jev's state carries this text. */
const idOf = (state: JevState, text: string): string => state.elements.find((line) => line.includes(`'${text}'`))!.split(":")[0]!;
const finished = { kind: jevAnswer("done"), goal_met: { type: "noul", noul: 0.93 } };

/**
 * Jev as a script, one reply a step (the last one again past the end), each reply built from the state and questions
 * it was sent. Every request is kept, with its options. The network is out of reach: the warm-up's model list fails.
 */
function jev(...steps: ((state: JevState, questions: JevQuestions) => Record<string, unknown>)[]) {
  spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new Error("no network in tests");
  }) as never);
  const sent: { state: JevState; questions: JevQuestions; signal?: AbortSignal }[] = [];
  spyOn(TypeSafeClient.prototype, "systemOne").mockImplementation((async ({ state, questions }: { state: JevState; questions: JevQuestions }, options?: { signal?: AbortSignal }) => {
    sent.push({ state, questions, signal: options?.signal });
    const reply = steps[Math.min(sent.length, steps.length) - 1]!;
    return { model: "jev-1.13.0", usage: { input_tokens: 812, output_tokens: 0 }, answers: reply(state, questions) };
  }) as never);
  return sent;
}

/** TYPESAFE_API_KEY set for the length of one test. */
async function withKey<T>(work: () => Promise<T>): Promise<T> {
  const was = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-key";
  try {
    return await work();
  } finally {
    if (was === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = was;
  }
}

test("the clicker hands a step to Jev and acts from behind: a press through accessibility, never the user's pointer or keyboard; it returns a line and the window's listing", async () => {
  desk({ nodes: [button("Pricing", 100, 50), field("Search", 300, 50)] });
  const sent = jev((state) => ({ kind: jevAnswer("click_item"), item_0: jevAnswer(idOf(state, "Pricing")), goal_met: { type: "noul", noul: 0.02 } }), () => finished);
  const pressed = spyOn(macos, "axPress").mockImplementation(() => true);
  const seated = [spyOn(macos, "clickAt"), spyOn(macos, "typeText"), spyOn(macos, "press"), spyOn(macos, "scroll")];
  await withKey(async () => {
    const { call } = hands();
    await call("open_app", { name: "TextEdit" });
    const told = await call("clicker", { goal: "open the Pricing page" });
    const [line, ...listing] = told.split("\n");
    expect(line).toMatch(/^Jev done \(goal_met 0\.93\), after 1 action in [\d.]+s: 1\. pressed 'Pricing' via accessibility -> no visible change\.$/);
    expect(listing[0]).toStartWith("TextEdit, the window you are working in");
    expect(pressed).toHaveBeenCalledTimes(1);
    for (const spy of seated) expect(spy).not.toHaveBeenCalled();
    // A hand opens its pages with `browser`: Jev is offered neither the browser nor its site catalog, and every request can be stopped.
    expect(Object.keys(sent[0]!.questions.kind!.criteria!)).not.toContain("use_browser");
    expect(sent[0]!.questions).not.toHaveProperty("site");
    expect(sent[0]!.signal).toBeInstanceOf(AbortSignal);
  });
});

const safe = () => Object.fromEntries(["irreversible", "spends_money", "destroys_data", "handles_secret", "off_goal"].map((flag) => [flag, { type: "noul", noul: 0.03 }]));

test("the clicker types from behind: into the field Jev chose, the hand's own text, then Return when Jev says the field submits and the gate lets it", async () => {
  desk({ nodes: [field("Search", 300, 50, { value: "" }), button("Go", 420, 50)] });
  const values = new Map<unknown, string>();
  spyOn(macos, "axSetValue").mockImplementation((ref, text) => (values.set(ref, text), true));
  spyOn(macos, "axValue").mockImplementation((ref) => values.get(ref) ?? "");
  const confirm = spyOn(macos, "axPerform").mockImplementation(() => false); // no confirm action: Return is posted to the window
  const keys = spyOn(seat, "pressIn").mockImplementation(async () => {});
  const typed = spyOn(seat, "typeIn").mockImplementation(async () => {});
  const sent = jev(
    (state) => ({ kind: jevAnswer("type_text"), field: jevAnswer(idOf(state, "Search"), 0.62), submit: { type: "noul", noul: 0.91 }, goal_met: { type: "noul", noul: 0.01 } }),
    safe,
    () => finished,
  );
  await withKey(async () => {
    const { call } = hands();
    await call("open_app", { name: "TextEdit" });
    const told = await call("clicker", { goal: "search the site for noise-cancelling headphones", text: "noise-cancelling headphones" });
    expect(told).toContain("1. typed 'noise-cancelling headphones' into 'Search' via accessibility, and pressed Return");
    expect([...values.values()]).toEqual(["noise-cancelling headphones"]);
    expect(confirm.mock.calls).toEqual([[{ label: "Search" }, "AXConfirm"]]);
    expect(keys.mock.calls).toEqual([[{ pid: PID, windowId: WINDOW }, "return"]]);
    expect(typed).not.toHaveBeenCalled();
    expect(sent[0]!.state.text_to_type).toBe("noise-cancelling headphones");
    expect(Object.keys(sent[0]!.questions.field!.criteria!)).toEqual([idOf(sent[0]!.state, "Search"), "none_of_these"]);
    expect(sent[1]!.state as unknown).toMatchObject({ action: "type 'noise-cancelling headphones' into text field 'Search', then press Enter" });
  });
});

test("a field that took the text but reads back otherwise is a failure the next step sees: nothing is typed again, and nothing is submitted", async () => {
  desk({ nodes: [field("Phone", 300, 50, { value: "" })] });
  spyOn(macos, "axSetValue").mockImplementation(() => true);
  spyOn(macos, "axValue").mockImplementation(() => "(555) 123-4567"); // a field that formats what it is given
  const keys = spyOn(seat, "pressIn").mockImplementation(async () => {});
  const typed = spyOn(seat, "typeIn").mockImplementation(async () => {});
  const sent = jev((state) => ({ kind: jevAnswer("type_text"), field: jevAnswer(idOf(state, "Phone")), submit: { type: "noul", noul: 0.9 }, goal_met: { type: "noul", noul: 0 } }), safe, () => finished);
  await withKey(async () => {
    const { call } = hands();
    await call("open_app", { name: "TextEdit" });
    await call("clicker", { goal: "enter the phone number", text: "5551234567" });
    expect(sent[2]!.state).toMatchObject({ already_tried_on_this_screen: ["type_text failed: typed '5551234567' into 'Phone' via accessibility, but it holds '(555) 123-4567' -> no visible change"] });
    expect(typed).not.toHaveBeenCalled(); // keys now would add the number to what the field holds
    expect(keys).not.toHaveBeenCalled();
  });
});

test("in the Mac's browser window the clicker submits through the field's own confirm action, and a Return it cannot send is said, not thrown", async () => {
  desk({ app: "Google Chrome", nodes: [field("Search", 300, 50, { value: "" })] });
  spyOn(macos, "openBackgroundWindow").mockImplementation(async () => ({ pid: PID, windowId: WINDOW, scripted: String(WINDOW) }));
  spyOn(macos, "stageWindow").mockImplementation(async () => {});
  spyOn(macos, "browserLoading").mockImplementation(async () => false);
  spyOn(macos, "browserUrl").mockImplementation(async () => "https://example.com/");
  spyOn(macos, "browserTabs").mockImplementation(async () => []);
  const values = new Map<unknown, string>();
  spyOn(macos, "axSetValue").mockImplementation((ref, text) => (values.set(ref, text), true));
  spyOn(macos, "axValue").mockImplementation((ref) => values.get(ref) ?? "");
  const confirm = spyOn(macos, "axPerform").mockImplementation(() => true);
  const keys = spyOn(seat, "pressIn").mockImplementation(async () => {});
  const typing = (state: JevState) => ({ kind: jevAnswer("type_text"), field: jevAnswer(idOf(state, "Search")), submit: { type: "noul", noul: 0.9 }, goal_met: { type: "noul", noul: 0 } });
  jev(typing, safe, () => finished);
  await withKey(async () => {
    const { call } = hands();
    await call("browser", { action: "open", url: "https://example.com" });
    expect(await call("clicker", { goal: "search for headphones", text: "headphones" })).toContain("1. typed 'headphones' into 'Search' via accessibility, and pressed Return");
    expect(confirm.mock.calls).toEqual([[{ label: "Search" }, "AXConfirm"]]);
    // A field with no confirm action: Return would be posted, and the Mac's browser takes no keys from behind.
    confirm.mockImplementation(() => false);
    values.clear();
    jev(typing, safe, () => finished);
    expect(await call("clicker", { goal: "search for headphones", text: "headphones" })).toContain(
      "1. typed 'headphones' into 'Search' via accessibility, but pressing Return failed: keys cannot be sent to Google Chrome from behind here",
    );
    expect(keys).not.toHaveBeenCalled();
  });
});

test("a field that ignored the value it was given is typed into with keys posted to the window", async () => {
  desk({ nodes: [field("Search", 300, 50, { value: "" })] });
  spyOn(macos, "axSetValue").mockImplementation(() => true);
  let holds = "";
  spyOn(macos, "axValue").mockImplementation(() => holds);
  const typed = spyOn(seat, "typeIn").mockImplementation(async (_to, text) => void (holds = text));
  jev((state) => ({ kind: jevAnswer("type_text"), field: jevAnswer(idOf(state, "Search")), submit: { type: "noul", noul: 0.1 }, goal_met: { type: "noul", noul: 0 } }), () => finished);
  await withKey(async () => {
    const { call } = hands();
    await call("open_app", { name: "TextEdit" });
    expect(await call("clicker", { goal: "search for headphones", text: "headphones" })).toContain("1. typed 'headphones' into 'Search' via keys posted to the window");
    expect(typed).toHaveBeenCalledTimes(1);
  });
});

test("the clicker starts from the model's own capture when nothing acted since, and hands back its last one: the model can click at once", async () => {
  desk({ nodes: [button("Pricing", 100, 50)] });
  const shots = spyOn(macos, "screenshotWindow").mockImplementation(async () => ({ path: picture, width: 800, height: 600 }));
  const captures = () => shots.mock.calls.filter(([, path]) => !path.includes("hands-glance")).length; // not the glances that watch the window settle
  const slept = spyOn(macos, "sleepWatching").mockImplementation(async () => {});
  jev(() => finished);
  const pressed = spyOn(macos, "axPress").mockImplementation(() => true);
  await withKey(async () => {
    const { call } = hands();
    await call("open_app", { name: "TextEdit" });
    expect(captures()).toBe(1);
    expect(await call("clicker", { goal: "open the Pricing page" })).toStartWith("Jev done");
    expect(captures()).toBe(1); // no capture of its own: the model's, then the same one handed back
    expect(slept).not.toHaveBeenCalled(); // a hand's look settles the window itself: no fixed delay after an action
    expect(await call("click", { item: 0 })).toBe("pressed 'Pricing' via accessibility");
    expect(pressed).toHaveBeenCalledTimes(1);
  });
});

test("while Jev drives, every label the hand shows says so, and afterwards none does", async () => {
  desk({ nodes: [button("Pricing", 100, 50)] });
  jev((state) => ({ kind: jevAnswer("click_item"), item_0: jevAnswer(idOf(state, "Pricing")), goal_met: { type: "noul", noul: 0 } }), () => finished);
  spyOn(macos, "axPress").mockImplementation(() => true);
  const labels: string[] = [];
  hand.onCue = (cue) => void (cue.label && labels.push(cue.label));
  try {
    await withKey(async () => {
      const { call } = hands();
      await call("open_app", { name: "TextEdit" });
      const before = labels.length;
      await call("clicker", { goal: "open the Pricing page" });
      const during = labels.slice(before);
      expect(during).toContain("Jev › “open the Pricing page”");
      expect(during).toContain("Jev › click “Pricing”");
      expect(during.every((label) => label.startsWith("Jev › "))).toBe(true);
      await call("screen");
      expect(labels.at(-1)).toBe("looking");
    });
  } finally {
    hand.onCue = null;
  }
});

test("when Jev stops unsure, the hand hears where it leaned, by the listing's indexes", async () => {
  desk({ nodes: [button("Pricing", 100, 50), button("Plans", 200, 50)] });
  jev((state) => ({
    kind: jevAnswer("click_item", 0.9, { click_item: 0.9, scroll_down: 0.06 }),
    item_0: jevAnswer(idOf(state, "Pricing"), 0.41, { [idOf(state, "Pricing")]: 0.41, [idOf(state, "Plans")]: 0.37, none_of_these: 0.22 }),
    goal_met: { type: "noul", noul: 0.03 },
  }));
  await withKey(async () => {
    const { call } = hands();
    await call("open_app", { name: "TextEdit" });
    const [line, leaned] = (await call("clicker", { goal: "open the pricing page" })).split("\n");
    expect(line).toMatch(/^Jev low confidence \(item '0' at 0\.41, below 0\.5\), after 0 actions in [\d.]+s\.$/);
    expect(leaned).toBe("Jev leaned toward click_item 0.90, scroll_down 0.06; items 0 'Pricing' 0.41, 1 'Plans' 0.37; goal_met 0.03.");
  });
});

test("a page that reads as blank is shown to its browser once, with the seat and nothing sent, and a page still blank ends the run saying why", async () => {
  desk({ lines: [["an old picture", 1, [10, 10, 200, 30]]] });
  spyOn(macos, "screenshotWindow").mockImplementation(async () => ({ path: picture, width: 800, height: 600, stale: true }));
  const borrowed = granted();
  const sent = jev(() => finished);
  await withKey(async () => {
    const { call } = hands();
    await call("open_app", { name: "TextEdit" });
    const told = await call("clicker", { goal: "open the Pricing page" });
    expect(told).toStartWith("Jev blank (the browser has not drawn this covered page");
    expect(told).toContain("NativeWindowOcclusionEnabled");
    expect(borrowed).toHaveBeenCalledTimes(1);
    expect(borrowed.mock.calls[0]![0]).toEqual({ pid: PID, windowId: WINDOW });
    expect(borrowed.mock.calls[0]![2]).toMatchObject({ why: "showing the page to the browser", waitMs: 5000 });
    expect(sent).toEqual([]); // nothing to ask Jev about
  });
});

test("a page the seat's moment brought up is looked at again within the same step, and the run goes on", async () => {
  desk({ nodes: [button("Pricing", 100, 50)] });
  let drawn = false;
  spyOn(macos, "screenshotWindow").mockImplementation(async () => ({ path: picture, width: 800, height: 600, ...(drawn ? {} : { stale: true }) }));
  spyOn(macos, "actionableElements").mockImplementation(() => [drawn ? [button("Pricing", 100, 50)] : [], [], false]);
  spyOn(seat, "withSeat").mockImplementation(async <T>(_target: KeyTarget, work: () => Promise<T>) => ((drawn = true), work()));
  jev(() => finished);
  await withKey(async () => {
    const { call } = hands();
    await call("open_app", { name: "TextEdit" });
    expect(await call("clicker", { goal: "open the Pricing page" })).toStartWith("Jev done");
  });
});

test("a request Jev fails on ends the run with the failure said, not an error", async () => {
  desk({ nodes: [button("Pricing", 100, 50)] });
  spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new Error("no network in tests");
  }) as never);
  spyOn(TypeSafeClient.prototype, "systemOne").mockImplementation((async () => {
    throw new APIConnectionError("socket closed");
  }) as never);
  await withKey(async () => {
    const { call } = hands();
    await call("open_app", { name: "TextEdit" });
    const [line, next] = (await call("clicker", { goal: "open the Pricing page" })).split("\n");
    expect(line).toMatch(/^Jev classifier failed: no connection \(socket closed\), after 0 actions in [\d.]+s\.$/);
    expect(next).toStartWith("TextEdit, the window you are working in");
  });
});

test("the clicker needs a window of the hand's own, and TypeSafe's key", async () => {
  desk();
  const was = process.env.TYPESAFE_API_KEY;
  try {
    delete process.env.TYPESAFE_API_KEY;
    await expect(hands().call("clicker", { goal: "open the Pricing page" })).rejects.toThrow("TYPESAFE_API_KEY is not set");
    process.env.TYPESAFE_API_KEY = "test-key";
    await expect(hands().call("clicker", { goal: "open the Pricing page" })).rejects.toThrow("open a window of your own first");
  } finally {
    if (was === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = was;
  }
});

test("a browser window's own tab strip, toolbar and bookmarks give way to one line about its tabs", async () => {
  const chrome = [
    { ...button("Tab search", 110, 55), role: "AXButton" },
    { role: "AXTab", label: "Landing", x: 200, y: 55, w: 120, h: 20, pressable: true, ref: {} },
    field("Address and search bar", 200, 80, { h: 20 }),
    button("All Bookmarks", 420, 105),
    button("Unnamed bookmark for https://github.com", 140, 105),
  ];
  desk({ nodes: [...chrome, button("Sign in", 300, 200), button("Scrolled away", 300, -40)], app: "Google Chrome" });
  spyOn(macos, "openBackgroundWindow").mockImplementation(async () => ({ pid: PID, windowId: WINDOW, scripted: String(WINDOW) }));
  spyOn(macos, "stageWindow").mockImplementation(async () => {});
  spyOn(macos, "browserLoading").mockImplementation(async () => false);
  spyOn(macos, "browserUrl").mockImplementation(async () => "https://example.com/");
  spyOn(macos, "browserTabs").mockImplementation(async () => [{ scripted: String(WINDOW), window: 1, tab: 1, active: true, title: "Landing", url: "https://example.com/" }]);
  const listing = await hands().call("browser", { action: "open", url: "https://example.com" });
  expect(listing).toContain("tabs: 1 (active: Landing)");
  expect(listing).toContain("button 'Sign in'");
  for (const gone of ["Tab search", "tab 'Landing'", "Address and search bar", "All Bookmarks", "Unnamed bookmark", "Scrolled away"]) expect(listing).not.toContain(gone);
});

test("tabs count from 1", async () => {
  desk();
  const { find } = hands();
  expect(find("browser").parameters.properties.tab.minimum).toBe(1);
});

test("`wait` returns the new listing, and with `until` stops once the text shows", async () => {
  let lines: Line[] = [];
  desk();
  spyOn(macos, "recognizeText").mockImplementation(() => lines);
  const { call } = hands();
  await call("open_app", { name: "TextEdit" });
  expect(await call("wait", { seconds: 1 })).toStartWith("waited 1s\nTextEdit, the window you are working in");
  lines = [["Your answer is ready", 1, [100, 100, 400, 130]]];
  spyOn(macos, "screenshotWindow").mockImplementation(async () => ({ path: changed, width: 800, height: 600 }));
  expect(await call("wait", { seconds: 20, until: "answer is ready" })).toStartWith("'answer is ready' shows, after 0s");
  lines = [];
  expect(await call("wait", { seconds: 0, until: "never" })).toStartWith("waited 0s, and 'never' has not shown");
});

test("finish records the outcome for the run to report, and whether the hand left pages open for the user", async () => {
  const { find } = hands();
  const result = await find("finish").execute("call", { outcome: "needs_you", summary: "Sign in to WhatsApp on the phone.", keep_open: true });
  expect(result.details).toEqual({ finish: { outcome: "needs_you", summary: "Sign in to WhatsApp on the phone.", keep_open: true } });
  expect((await find("finish").execute("call", { outcome: "done", summary: "Did it." })).details).toEqual({ finish: { outcome: "done", summary: "Did it.", keep_open: false } });
  expect(find("finish").parameters.required).toContain("keep_open");
  const ended = await find("finish").execute("call", { outcome: "done", summary: "Found it.", answer: " Babbage was born in 1791. ", keep_open: false });
  expect(ended.details).toEqual({ finish: { outcome: "done", summary: "Found it.", answer: "Babbage was born in 1791.", keep_open: false } });
  expect(ended.terminate).toBe(true); // the answer rides in the finish: no turn after it
  expect(find("finish").parameters.required).toContain("answer");
});

test("a window the user minimized is looked at all the same on Windows: the capture brings it back, and it is not taken for closed", async () => {
  desk();
  spyOn(windows, "thumbnail").mockImplementation(() => null); // a glance, to tell whether the window has settled: nothing to watch
  let minimized = true;
  spyOn(macos, "appWindows").mockImplementation(() => (minimized ? [] : [{ id: WINDOW, frame: FRAME }])); // an app's windows leave a minimized one out
  spyOn(macos, "screenshotWindow").mockImplementation(async (_id, path) => {
    if (!path.includes("hands-glance")) minimized = false; // the capture restores it without activation, behind the user's windows
    return { path: picture, width: 800, height: 600 };
  });
  const listing = await asOnWindows(() => hands().call("open_app", { name: "TextEdit" }));
  expect(listing).toContain("TextEdit, the window you are working in");
  minimized = true;
  await expect(hands().call("open_app", { name: "TextEdit" })).rejects.toThrow("the window is gone"); // the Mac, where a capture restores nothing
  // The browser window the hand opened, minimized, is still its window.
  minimized = true;
  spyOn(macos, "openBackgroundWindow").mockImplementation(async () => ({ pid: PID, windowId: WINDOW, scripted: String(WINDOW) }));
  spyOn(macos, "stageWindow").mockImplementation(async () => {});
  spyOn(macos, "browserLoading").mockImplementation(async () => false);
  spyOn(macos, "browserUrl").mockImplementation(async () => "https://example.com/");
  spyOn(macos, "browserTabs").mockImplementation(async () => []);
  const opened = spyOn(macos, "openUrl").mockImplementation(async () => true);
  await asOnWindows(async () => {
    const { call } = hands();
    minimized = false;
    await call("browser", { action: "open", url: "https://example.com" });
    minimized = true;
    expect(await call("browser", { action: "open", url: "https://example.com/next" })).not.toContain("your earlier window had been closed");
  });
  expect(opened).toHaveBeenCalledTimes(1);
});

test("with nothing of its own open, a look at the user's screen does not leave the hand on it", async () => {
  desk();
  spyOn(macos, "frontmostAppAndPid").mockImplementation(async () => ["Mail", 700]);
  spyOn(macos, "frontmostWindowBounds").mockImplementation(async () => [0, 0, 400, 300]);
  spyOn(macos, "displayFor").mockImplementation(() => ({ index: 0, frame: [0, 0, 400, 300] }));
  spyOn(macos, "screenshot").mockImplementation(async () => ({ path: picture, width: 800, height: 600 }));
  spyOn(macos, "focusedField").mockImplementation(() => null);
  spyOn(macos, "browserUrl").mockImplementation(async () => null);
  const rode = spyOn(hand, "look");
  const posed = spyOn(hand, "cue");
  await hands().call("screen");
  expect(rode).not.toHaveBeenCalled();
  expect(posed.mock.calls[0]?.slice(0, 2)).toEqual(["look", "looking"]);
});

test("the listing claims a field's value only when there is one to give", async () => {
  desk({ nodes: [field("Search", 150, 80)] });
  const bare = await hands().call("open_app", { name: "TextEdit" });
  expect(bare).toContain("items (index role 'text' @x,y)");
  expect(bare).not.toContain("= value");
  expect(hands().find("screen").description).not.toContain("what a field holds");
});

test("open_app with the browser's name says it is the user's own window, and where a window of the hand's own comes from", async () => {
  desk({ app: "Google Chrome", working: { windowId: WINDOW, dialog: null, theirs: true } });
  const listing = await hands().call("open_app", { name: "Google Chrome" });
  expect(listing).toStartWith("opened Google Chrome: this is the user's own Google Chrome window, to act in only as far as the task asks. For a page of your own, `browser` open url=...");
  expect(listing).toContain("(`browser` open gives you a Google Chrome window of your own)");
  expect(listing).not.toContain("opened no second window");
});

test("on the Mac an app's window that was there before the hand is the user's, one it made later is its own, and its browser window is its own", () => {
  spyOn(macos, "mainWindowId").mockImplementation(() => 71);
  spyOn(macos, "appWindows").mockImplementation(() => [{ id: 71, frame: FRAME }, { id: 72, frame: FRAME }]);
  expect(macSeat.workingWindow(9001)).toEqual({ windowId: 71, dialog: null, theirs: true });
  spyOn(macos, "mainWindowId").mockImplementation(() => 73); // File > New, from the hand's `menu`
  expect(macSeat.workingWindow(9001)).toEqual({ windowId: 73, dialog: null, theirs: false });
  spyOn(macos, "mainWindowId").mockImplementation(() => 72);
  expect(macSeat.workingWindow(9001)?.theirs).toBe(true);
  expect(macSeat.workingWindow(9001, 555)).toEqual({ windowId: 555, dialog: null, theirs: false });
  spyOn(macos, "mainWindowId").mockImplementation(() => null);
  expect(macSeat.workingWindow(9002)).toBeNull();
});

test("the Mac's user's own window says how to make one of the hand's, and an app with no window points to its menu, not open_app again", async () => {
  desk({ working: { windowId: WINDOW, dialog: null, theirs: true } });
  expect(await hands().call("open_app", { name: "TextEdit" })).toContain("make one of your own with the app's `menu` (File > New...)");
  desk({ working: null });
  await expect(hands().call("open_app", { name: "TextEdit" })).rejects.toThrow("TextEdit has no window open. Its `menu` can make one (File > New...).");
  await expect(asOnWindows(() => hands().call("open_app", { name: "TextEdit" }))).rejects.toThrow("`open_app` it again for a window of your own");
});

test("a file for open_app is found where Git Bash, ~ and file:// name it", () => {
  const [cwd, home] = ["D:\\work", "C:\\Users\\u"];
  const at = (file: string) => filePath(file, cwd, home, true).replaceAll("\\", "/");
  expect(at("/c/Users/u/report.xlsx")).toBe("C:/Users/u/report.xlsx");
  expect(at("/mnt/d/data/a.csv")).toBe("D:/data/a.csv");
  expect(at("/cygdrive/e/x.docx")).toBe("E:/x.docx");
  expect(at("~/Documents/a.docx")).toBe("C:/Users/u/Documents/a.docx");
  expect(at("file:///C:/Users/u/My%20Report.xlsx")).toBe("C:/Users/u/My Report.xlsx");
  expect(at("C:\\Users\\u\\b.xlsx")).toBe("C:/Users/u/b.xlsx");
  expect(at("notes.txt")).toBe("D:/work/notes.txt");
});

test("after an action that changed nothing yet, the next look waits a while for a reaction that starts late", async () => {
  desk();
  spyOn(seat, "pressIn").mockImplementation(async () => {});
  const { call } = hands();
  await call("open_app", { name: "TextEdit" });
  settling.unchangedMs = 800;
  await call("key", { keys: "return" });
  const started = performance.now();
  await call("screen");
  expect(performance.now() - started).toBeGreaterThanOrEqual(700); // two glances alike at 300 ms are not enough: the old code waited 800 ms
});

test("`browser` tabs, back from another app, drops that app's capture: the next action looks first", async () => {
  desk({ app: "Google Chrome" });
  spyOn(macos, "openBackgroundWindow").mockImplementation(async () => ({ pid: PID, windowId: WINDOW, scripted: String(WINDOW) }));
  spyOn(macos, "stageWindow").mockImplementation(async () => {});
  spyOn(macos, "browserLoading").mockImplementation(async () => false);
  spyOn(macos, "browserUrl").mockImplementation(async () => "https://example.com/");
  spyOn(macos, "browserTabs").mockImplementation(async () => [{ scripted: String(WINDOW), window: 1, tab: 1, active: true, title: "Landing", url: "https://example.com/" }]);
  spyOn(macos, "runInBackground").mockImplementation(async () => 600);
  const typed = spyOn(seat, "typeIn").mockImplementation(async () => {});
  const { call } = hands();
  await call("browser", { action: "open", url: "https://example.com" });
  await call("open_app", { name: "Notepad" });
  expect(await call("browser", { action: "tabs" })).toContain("tab 1 (active): Landing");
  await expect(asOnWindows(() => call("type", { text: "hello" }))).rejects.toThrow("no current screen: call `screen` first");
  expect(typed).not.toHaveBeenCalled();
});

test("the screenshots of a run folder carry on from the last one there", () => {
  const folder = mkdtempSync(join(tmpdir(), "hands-captures-"));
  try {
    expect(lastCapture(folder)).toBe(0);
    for (const name of ["screen-007.png", "screen-012.png", "screen-x.png", "agent.log"]) writeFileSync(join(folder, name), "");
    expect(lastCapture(folder)).toBe(12);
    expect(lastCapture(join(folder, "missing"))).toBe(0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ Jev's reflexes

const noul = (value: number) => ({ type: "noul", noul: value });
const calm = { cookie_banner: noul(0.02), sign_in_wall: noul(0.02), captcha: noul(0.01), code_needed: noul(0.01), payment_form: noul(0.01) };

/** A browser window of the hand's own, showing `url`. */
function ownBrowser(url: string) {
  spyOn(macos, "openBackgroundWindow").mockImplementation(async () => ({ pid: PID, windowId: WINDOW, scripted: String(WINDOW) }));
  spyOn(macos, "stageWindow").mockImplementation(async () => {});
  spyOn(macos, "browserLoading").mockImplementation(async () => false);
  spyOn(macos, "browserUrl").mockImplementation(async () => url);
  spyOn(macos, "browserTabs").mockImplementation(async () => [{ scripted: String(WINDOW), window: 1, tab: 1, active: true, title: "News", url }]);
}

/** TYPESAFE_API_KEY set, and the reflexes on, for the length of one test. */
const reflexesOn = <T>(work: () => Promise<T>): Promise<T> =>
  withKey(async () => {
    delete process.env.HANDS_REFLEXES;
    return work();
  });

test("Jev turns a cookie banner down in the hand's own browser window: 'Reject all' is pressed from behind, never 'Accept all', the page is looked at again, and the listing says so", async () => {
  const story = button("Top story", 300, 100);
  const choices = [button("Accept all", 300, 250), button("Reject all", 380, 250)];
  let gone = false; // the banner, once turned down
  desk({ app: "Google Chrome" });
  spyOn(macos, "actionableElements").mockImplementation(() => [gone ? [story] : [story, ...choices], [], false]);
  spyOn(macos, "recognizeText").mockImplementation(() => (gone ? [] : [["We use cookies to improve your experience", 1, [100, 400, 700, 440]]]));
  spyOn(macos, "screenshotWindow").mockImplementation(async () => ({ path: gone ? changed : picture, width: 800, height: 600 }));
  ownBrowser("https://news.example.com/");
  const pressed = spyOn(macos, "axPress").mockImplementation((ref) => ((gone = (ref as { label: string }).label === "Reject all"), true));
  const sent = jev((state) => ({ ...calm, cookie_banner: noul(0.97), decline: jevAnswer(idOf(state, "Reject all"), 0.92) }));
  await reflexesOn(async () => {
    const { call } = hands();
    const listing = await call("browser", { action: "open", url: "https://news.example.com" });
    expect(listing).toStartWith("opened https://news.example.com/ in your own window\nJev turned down the cookie banner (pressed 'Reject all').\nGoogle Chrome, the window you are working in");
    expect(listing).toContain("button 'Top story'");
    expect(listing).not.toContain("Accept all"); // the listing is the new look, without the banner
    expect(pressed.mock.calls.map(([ref]) => (ref as { label: string }).label)).toEqual(["Reject all"]);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.questions.decline!.criteria!)).toEqual([idOf(sent[0]!.state, "Reject all"), "none_of_these"]);
    // The banner back on the same URL: Jev is asked about the page, which changed, and nothing is pressed again.
    gone = false;
    spyOn(macos, "screenshotWindow").mockImplementation(async () => ({ path: picture, width: 800, height: 600 }));
    const again = await call("screen");
    expect(again).not.toContain("Jev turned down");
    expect(pressed).toHaveBeenCalledTimes(1);
  });
});

test("a press the page did not take is said, with the listing as it was", async () => {
  desk({ app: "Google Chrome", nodes: [button("Accept all", 300, 250), button("Reject all", 380, 250)], lines: [["This site uses cookies", 1, [100, 400, 700, 440]]] });
  ownBrowser("https://news.example.com/");
  spyOn(macos, "axPress").mockImplementation(() => false);
  spyOn(macos, "revealWindow").mockImplementation(async () => true);
  spyOn(macos, "windowPointer").mockImplementation(async () => {
    throw new SeatBusy("the user did not pause long enough for a click");
  });
  jev((state) => ({ ...calm, cookie_banner: noul(0.97), decline: jevAnswer(idOf(state, "Reject all"), 0.92) }));
  await reflexesOn(async () => {
    const listing = await hands().call("browser", { action: "open", url: "https://news.example.com" });
    expect(listing).toContain("\nJev picked 'Reject all' to turn down the cookie banner, but the press failed: the user did not pause long enough for a click.");
    expect(listing).toContain("button 'Accept all'");
  });
});

test("a page of the hand's own that wants a sign-in leads its listing with Jev's line, asked once for the page", async () => {
  desk({ app: "Google Chrome", nodes: [field("Email or phone", 300, 200), button("Next", 300, 260)], lines: [["Sign in to continue to Mail", 1, [100, 100, 700, 140]]] });
  ownBrowser("https://accounts.example.com/signin");
  const sent = jev(() => ({ ...calm, sign_in_wall: noul(0.93) }));
  await reflexesOn(async () => {
    const { call } = hands();
    const listing = await call("browser", { action: "open", url: "https://accounts.example.com/signin" });
    const wall = "Jev: this page wants a sign-in (0.93). If the task did not give you the credentials, finish with needs_you and say what the user must do.";
    expect(listing).toStartWith(`opened https://accounts.example.com/signin in your own window\n${wall}\nGoogle Chrome, the window you are working in`);
    expect(await call("screen")).toStartWith(`${wall}\nGoogle Chrome`);
    expect(sent).toHaveLength(1);
  });
});

test("the page reflex never asks about, or presses in, the user's own window or screen", async () => {
  const banner = [button("Accept all", 300, 250), button("Reject all", 380, 250)];
  desk({ app: "Google Chrome", nodes: banner, lines: [["We use cookies", 1, [100, 400, 700, 440]]], working: { windowId: WINDOW, dialog: null, theirs: true } });
  spyOn(macos, "browserUrl").mockImplementation(async () => "https://news.example.com/");
  const pressed = spyOn(macos, "axPress").mockImplementation(() => true);
  const sent = jev((state) => ({ ...calm, cookie_banner: noul(0.99), decline: jevAnswer(idOf(state, "Reject all"), 0.99) }));
  await reflexesOn(async () => {
    expect(await hands().call("open_app", { name: "Google Chrome" })).not.toContain("Jev turned down");
    spyOn(macos, "frontmostAppAndPid").mockImplementation(async () => ["Google Chrome", 700]);
    spyOn(macos, "frontmostWindowBounds").mockImplementation(async () => [0, 0, 400, 300]);
    spyOn(macos, "displayFor").mockImplementation(() => ({ index: 0, frame: [0, 0, 400, 300] }));
    spyOn(macos, "screenshot").mockImplementation(async () => ({ path: picture, width: 800, height: 600 }));
    spyOn(macos, "focusedField").mockImplementation(() => null);
    expect(await hands().call("screen")).toContain("the user's own screen, only to read");
  });
  expect(sent).toEqual([]);
  expect(pressed).not.toHaveBeenCalled();
});

test("finish done checks the answer against the hand's current look; needs_you, a stale look and the user's screen are not checked", async () => {
  desk({ lines: [["Born 26 December 1791, London", 1, [100, 100, 400, 130]]] });
  spyOn(seat, "pressIn").mockImplementation(async () => {});
  const sent = jev(() => ({ shows: noul(0.94) }));
  await reflexesOn(async () => {
    const { call, find } = hands();
    await call("open_app", { name: "TextEdit" });
    const finish = (outcome: string) => find("finish").execute("call", { outcome, summary: "Found it.", answer: "Babbage was born in 1791.", keep_open: false });
    const done = await finish("done");
    expect(done.details).toEqual({ finish: { outcome: "done", summary: "Found it.", answer: "Babbage was born in 1791.", keep_open: false, checked: 0.94 } });
    expect(done.content).toEqual([{ type: "text", text: "recorded: done. Jev read the last screen as showing it at 0.94." }]);
    expect((sent[0]!.state as unknown as { claim: string }).claim).toBe("Babbage was born in 1791.");
    expect(sent[0]!.state.elements.some((line) => line.includes("'Born 26 December 1791, London'"))).toBe(true);
    expect((await finish("needs_you")).details.finish.checked).toBeUndefined();
    await call("key", { keys: "return" }); // an action, and no look since
    expect((await finish("done")).details.finish).not.toHaveProperty("checked");
    expect(sent).toHaveLength(1);
  });
  // The user's own screen, only read: nothing of the hand's to check.
  spyOn(macos, "frontmostAppAndPid").mockImplementation(async () => ["Mail", 700]);
  spyOn(macos, "frontmostWindowBounds").mockImplementation(async () => [0, 0, 400, 300]);
  spyOn(macos, "displayFor").mockImplementation(() => ({ index: 0, frame: [0, 0, 400, 300] }));
  spyOn(macos, "screenshot").mockImplementation(async () => ({ path: picture, width: 800, height: 600 }));
  spyOn(macos, "focusedField").mockImplementation(() => null);
  spyOn(macos, "browserUrl").mockImplementation(async () => null);
  await reflexesOn(async () => {
    const { call, find } = hands();
    await call("screen");
    expect((await find("finish").execute("call", { outcome: "done", summary: "Read it.", keep_open: false })).details.finish).not.toHaveProperty("checked");
  });
  expect(sent).toHaveLength(1);
});

test("a done check Jev fails on leaves the finish as it was, at once", async () => {
  desk({ lines: [["Born 26 December 1791", 1, [100, 100, 400, 130]]] });
  spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new Error("no network in tests");
  }) as never);
  spyOn(TypeSafeClient.prototype, "systemOne").mockImplementation((async () => {
    throw new APIConnectionError("socket closed");
  }) as never);
  await reflexesOn(async () => {
    const { call, find } = hands();
    await call("open_app", { name: "TextEdit" });
    const done = await find("finish").execute("call", { outcome: "done", summary: "Found it.", keep_open: false });
    expect(done.details).toEqual({ finish: { outcome: "done", summary: "Found it.", keep_open: false } });
    expect(done.content).toEqual([{ type: "text", text: "recorded: done." }]);
  });
});
