import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { Cdp, CdpEvent } from "../src/devtools.ts";
import type { PageDump, UiElement } from "../src/elements.ts";
import { openHand } from "../src/hand.ts";
import type { Action } from "../src/screen.ts";
import * as windows from "../src/windows.ts";
import type { UiaNode } from "../src/windows.ts";

// ------------------------------------------------------------------ a browser that is a script of replies

const DUMP: PageDump = {
  url: "https://mail.example.com/inbox", title: "Inbox", ready: "complete", view: [1200, 800], texts: ["Inbox"],
  elements: [
    { i: 0, role: "button", name: "Compose", value: "", editable: false, focused: false, within: "nav", secret: false, x: 20, y: 100, w: 100, h: 40 },
    { i: 1, role: "text field", name: "Search mail", value: "old words", editable: true, focused: false, within: "search", secret: false, x: 300, y: 10, w: 400, h: 30 },
    { i: 2, role: "password field", name: "Password", value: "", editable: true, focused: false, within: "form", secret: true, x: 300, y: 200, w: 400, h: 30 },
    { i: 3, role: "combo box", name: "Sort by", value: "Newest", editable: false, focused: false, within: "form", secret: false, options: ["Newest", "Oldest"], x: 300, y: 300, w: 200, h: 30 },
  ],
}; // prettier-ignore

interface Sent {
  method: string;
  params: any;
  sessionId?: string;
}

/** Which of the hand's page scripts an expression is, so a test reads as what the hand did and not as JavaScript. */
function scriptOf(expression: string): string {
  if (expression.includes("__hands = {")) return "look";
  if (expression.includes("scrollIntoView")) return "reveal";
  if (expression.includes("el.focus()")) return "focus";
  if (expression.includes("select.dispatchEvent")) return "select";
  if (expression.includes("document.readyState")) return "ready";
  return expression;
}

function fakeBrowser(answers: Record<string, unknown | ((sent: Sent) => unknown)> = {}) {
  const sent: Sent[] = [];
  const handlers = new Set<(event: CdpEvent) => void>();
  const closed = Promise.withResolvers<void>();
  const scripts: Record<string, unknown> = {
    look: JSON.stringify([JSON.stringify(DUMP), 1216, 895, 1.5]),
    reveal: JSON.stringify({ x: 20, y: 100, w: 100, h: 40 }),
    focus: "focused",
    select: "set",
    ready: JSON.stringify(["complete", 1200, 800, 1216, 895, 1.5]),
  };
  let sessions = 0;
  const cdp: Cdp = {
    async send(method: string, params: object = {}, sessionId?: string): Promise<any> {
      const call = { method, params, ...(sessionId ? { sessionId } : {}) };
      sent.push(call);
      const script = method === "Runtime.evaluate" ? scriptOf((params as { expression: string }).expression) : "";
      const answer = answers[script || method];
      if (answer !== undefined) {
        const value = typeof answer === "function" ? answer(call) : answer;
        return script ? { result: { value } } : value;
      }
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "T1", type: "page", title: "Inbox", url: DUMP.url }] };
      if (method === "Target.attachToTarget") return { sessionId: `S${++sessions}` };
      if (script) return { result: { value: script in scripts ? scripts[script] : null } };
      return {};
    },
    on: (handler) => (handlers.add(handler), () => void handlers.delete(handler)),
    close: () => closed.resolve(),
    closed: closed.promise,
  };
  /** What reached the page after it was attached and made ready, in words. */
  const trace = (): string[] =>
    sent
      .filter((s) => s.sessionId && !["Page.enable", "Emulation.setFocusEmulationEnabled"].includes(s.method))
      .map((s) => (s.method === "Runtime.evaluate" ? scriptOf(s.params.expression) : s.method === "Input.dispatchMouseEvent" || s.method === "Input.dispatchKeyEvent" ? `${s.params.type} ${s.params.key ?? s.params.button ?? ""}`.trim() : s.method));
  return { cdp, sent, trace, emit: (event: CdpEvent) => handlers.forEach((handler) => handler(event)), of: (method: string) => sent.filter((s) => s.method === method) };
}

const el = (index: number): UiElement => {
  const e = DUMP.elements[index]!;
  return { id: `e${index + 1}`, role: e.role, name: e.name, value: e.value, editable: e.editable, focused: false, within: e.within, ref: e.i, rect: { x: e.x, y: e.y, w: e.w, h: e.h }, ...(e.secret ? { secret: true } : {}) };
};

// ------------------------------------------------------------------ a helper that is a script of replies

let helper: (string | number)[][];

function fakeHelper(replies: Record<string, unknown | ((args: (string | number)[]) => unknown)> = {}): void {
  spyOn(windows.native, "run").mockImplementation((...args: (string | number)[]) => {
    helper.push(args);
    const reply = replies[String(args[0])];
    if (reply === undefined) throw new Error(`the test did not expect the helper to be asked for ${JSON.stringify(args[0])}`);
    return typeof reply === "function" ? reply(args) : reply;
  });
}

const text = (base64: string | number) => Buffer.from(String(base64), "base64").toString("utf8");
const quiet = { sleep: async () => {} };

beforeEach(() => {
  helper = [];
  windows.stale();
  fakeHelper(); // a page is worked without the helper: any run of it fails the test
});
afterEach(() => mock.restore());

/** A hand on the fake page, after its first look, with the calls so far forgotten. */
async function onPage(answers: Parameters<typeof fakeBrowser>[0] = {}, log: string[] = []) {
  const browser = fakeBrowser(answers);
  const hand = await openHand({ cdp: browser.cdp, log: (line) => log.push(line), ...quiet });
  const obs = await hand.observe();
  browser.sent.length = 0;
  return { hand, obs, ...browser };
}

// ------------------------------------------------------------------ a page

test("a look is one evaluation in the page, and no run of the helper", async () => {
  const browser = fakeBrowser();
  const hand = await openHand({ cdp: browser.cdp, ...quiet });
  const obs = await hand.observe();
  expect(obs.elements.map((e) => `${e.id} ${e.role} ${e.name}`)).toEqual(["e1 button Compose", "e2 text field Search mail", "e3 password field Password", "e4 combo box Sort by"]);
  expect(obs.size).toEqual([1200, 800]);
  expect(obs.texts.slice(0, 2)).toEqual(["page: Inbox", "address: https://mail.example.com/inbox"]);
  expect(browser.trace()).toEqual(["look"]);
  await hand.observe();
  expect(browser.of("Target.attachToTarget")).toHaveLength(1); // one session for the hand's life
  expect(browser.of("Emulation.setFocusEmulationEnabled")[0]!.params).toEqual({ enabled: true });
  expect(helper).toEqual([]);
});

test("a click reveals the node, then moves, presses and releases at its centre", async () => {
  const { hand, sent, trace } = await onPage();
  await hand.perform({ kind: "click", target: el(0), button: "left", count: 1 });
  expect(trace()).toEqual(["reveal", "mouseMoved", "mousePressed left", "mouseReleased left", "ready"]);
  expect(sent[0]!.params.expression).toContain('"h1-1"'); // the very node of the last look
  expect(sent[2]!.params).toEqual({ type: "mousePressed", x: 70, y: 120, button: "left", buttons: 1, clickCount: 1 });
  expect(sent[3]!.params).toEqual({ type: "mouseReleased", x: 70, y: 120, button: "left", clickCount: 1 });
  expect(helper).toEqual([]);
});

test("a double click counts itself, and a right click is the right button", async () => {
  const { hand, sent } = await onPage();
  await hand.perform({ kind: "click", target: el(0), button: "left", count: 2 });
  expect(sent.filter((s) => s.params.type === "mousePressed").map((s) => s.params.clickCount)).toEqual([1, 2]);
  sent.length = 0;
  await hand.perform({ kind: "click", target: el(0), button: "right", count: 1 });
  expect(sent.find((s) => s.params.type === "mousePressed")!.params).toMatchObject({ button: "right", buttons: 2 });
});

test("a node that is gone or covered is said in one sentence, and nothing is pressed", async () => {
  const { hand, trace } = await onPage({ reveal: () => null });
  expect(hand.perform({ kind: "click", target: el(0), button: "left", count: 1 })).rejects.toThrow('button "Compose" is no longer there, or something covers it');
  await Bun.sleep(0);
  expect(trace()).toEqual(["reveal"]);
});

test("typing focuses the field through the DOM, replaces what it held, and submits with Enter", async () => {
  const { hand, sent, trace } = await onPage();
  await hand.perform({ kind: "type", target: el(1), input: "query", text: "quarterly report", submit: true });
  expect(trace()).toEqual(["focus", "Input.insertText", "keyDown Enter", "keyUp Enter", "ready"]);
  expect(sent[0]!.params.expression).toContain("if (true)"); // it held "old words": selected, so the text replaces them
  expect(sent[1]!.params).toEqual({ text: "quarterly report" });
  expect(sent[2]!.params).toEqual({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r" });
  expect(helper).toEqual([]);
});

test("text alone is two trips, and with no field named it goes where the cursor is", async () => {
  const { hand, sent, trace } = await onPage();
  await hand.perform({ kind: "type", target: { ...el(1), value: "" }, input: "query", text: "hello", submit: false });
  expect(trace()).toEqual(["focus", "Input.insertText"]);
  expect(sent[0]!.params.expression).toContain("if (false)"); // an empty field has nothing to select
  sent.length = 0;
  await hand.perform({ kind: "type", target: null, input: "query", text: "more", submit: false });
  expect(trace()).toEqual(["Input.insertText"]);
});

test("a field that only a click wakes is clicked, then asked again", async () => {
  let asked = 0;
  const { hand, trace } = await onPage({ focus: () => (++asked === 1 ? "not focused" : "focused") });
  await hand.perform({ kind: "type", target: el(1), input: "query", text: "hello", submit: false });
  expect(trace()).toEqual(["focus", "reveal", "mouseMoved", "mousePressed left", "mouseReleased left", "focus", "Input.insertText"]);
});

test("a secret is typed and never logged, even when the page refuses it", async () => {
  const log: string[] = [];
  const { hand, sent } = await onPage({}, log);
  await hand.perform({ kind: "type", target: el(2), input: "password", text: "hunter2-very-secret", submit: false });
  expect(sent[0]!.params.expression).toContain("if (true)"); // a password's value is never read, so it is always replaced
  expect(sent[1]!.params).toEqual({ text: "hunter2-very-secret" });
  expect(log.join("\n")).toContain('type password field "Password" over DevTools');
  expect(log.join("\n")).not.toContain("hunter2");

  const refusing = await onPage({ "Input.insertText": () => Promise.reject(new Error("Input.insertText: Internal error\n    at somewhere")) }, log);
  const error = await refusing.hand.perform({ kind: "type", target: el(2), input: "password", text: "hunter2-very-secret", submit: false }).catch((e: Error) => e);
  expect((error as Error).message).toBe("Input.insertText: Internal error");
  expect(log.join("\n")).not.toContain("hunter2");
});

test("a dropdown is set in the page, and a missing option is one sentence", async () => {
  const { hand, sent, trace } = await onPage();
  await hand.perform({ kind: "select", target: el(3), option: "Oldest" });
  expect(trace()).toEqual(["select", "ready"]);
  expect(sent[0]!.params.expression).toContain('"Oldest"');
  const without = await onPage({ select: "no such option" });
  expect(without.hand.perform({ kind: "select", target: el(3), option: "Sideways" })).rejects.toThrow('"Sideways" could not be chosen in combo box "Sort by": no such option');
});

test("keys are DevTools key events, and the browser's own shortcuts are its own commands", async () => {
  const { hand, sent, trace } = await onPage({ "Page.getNavigationHistory": { currentIndex: 2, entries: [{ id: 7 }, { id: 8 }, { id: 9 }] } });
  await hand.perform({ kind: "key", combo: "Tab" });
  expect(trace()).toEqual(["rawKeyDown Tab", "keyUp Tab", "ready"]);
  sent.length = 0;
  await hand.perform({ kind: "key", combo: "shift+Tab" });
  expect(sent[0]!.params).toMatchObject({ type: "rawKeyDown", key: "Tab", modifiers: 8 });
  sent.length = 0;
  await hand.perform({ kind: "key", combo: "ctrl+a" });
  expect(sent[0]!.params).toMatchObject({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] });
  sent.length = 0;
  await hand.perform({ kind: "key", combo: "space" });
  expect(sent[0]!.params).toMatchObject({ type: "keyDown", text: " " });
  sent.length = 0;
  await hand.perform({ kind: "key", combo: "alt+Left" });
  expect(trace()).toEqual(["Page.getNavigationHistory", "Page.navigateToHistoryEntry", "ready"]);
  expect(sent[1]!.params).toEqual({ entryId: 8 });
  sent.length = 0;
  await hand.perform({ kind: "key", combo: "F5" });
  expect(trace()).toEqual(["Page.reload", "ready"]);
  expect(helper).toEqual([]);
});

test("a scroll is the wheel over the middle of the page, and the document itself when the wheel is dropped", async () => {
  const { hand, sent, trace } = await onPage();
  await hand.perform({ kind: "scroll", direction: "down" });
  expect(trace()).toEqual(["mouseWheel"]);
  expect(sent[0]!.params).toEqual({ type: "mouseWheel", x: 600, y: 400, deltaX: 0, deltaY: 640 });
  sent.length = 0;
  await hand.perform({ kind: "scroll", direction: "up" });
  expect(sent[0]!.params.deltaY).toBe(-640);

  const dropped = await onPage({ "Input.dispatchMouseEvent": () => Promise.reject(new Error("Input.dispatchMouseEvent: no frame took it")) });
  await dropped.hand.perform({ kind: "scroll", direction: "down" });
  expect(dropped.trace()).toEqual(["mouseWheel", "window.scrollBy(0, 640)"]);
});

test("a wait is a pause and nothing else", async () => {
  const slept: number[] = [];
  const browser = fakeBrowser();
  const hand = await openHand({ cdp: browser.cdp, sleep: async (ms) => void slept.push(ms) });
  await hand.perform({ kind: "wait" });
  expect(slept).toEqual([1000]);
  expect(browser.trace()).toEqual([]);
  expect(browser.of("Target.attachToTarget")).toEqual([]); // not even a session
});

test("a session that went away is attached again, once, and the command is asked again", async () => {
  const once = fakeBrowser({ look: (sent: Sent) => (sent.sessionId === "S1" ? Promise.reject(new Error("Runtime.evaluate: Session with given id not found.")) : JSON.stringify([JSON.stringify(DUMP), 1216, 895, 1])) });
  const hand = await openHand({ cdp: once.cdp, ...quiet });
  expect((await hand.observe()).title).toBe("Inbox");
  expect(once.of("Target.attachToTarget")).toHaveLength(2);
  expect(once.sent.filter((s) => s.method === "Runtime.evaluate").map((s) => s.sessionId)).toEqual(["S1", "S2"]);
  await hand.observe();
  expect(once.of("Target.attachToTarget")).toHaveLength(2); // and the new session is kept

  const always = fakeBrowser({ look: () => Promise.reject(new Error("Runtime.evaluate: Session with given id not found.")) });
  const lostHand = await openHand({ cdp: always.cdp, ...quiet });
  expect(lostHand.observe()).rejects.toThrow("Session with given id not found");
  await Bun.sleep(0);
  expect(always.of("Target.attachToTarget")).toHaveLength(2); // once more, and no more
});

test("a document swapped under a look is looked at again, but input is never sent twice", async () => {
  let swapped = 1;
  const browser = fakeBrowser({ look: () => (swapped-- > 0 ? Promise.reject(new Error("Runtime.evaluate: Execution context was destroyed.")) : JSON.stringify([JSON.stringify(DUMP), 1216, 895, 1])) });
  const hand = await openHand({ cdp: browser.cdp, ...quiet });
  await hand.observe();
  expect(browser.trace()).toEqual(["look", "look"]);
  expect(browser.of("Target.attachToTarget")).toHaveLength(1); // the same session: only the document was new

  const typing = await onPage({ "Input.insertText": () => Promise.reject(new Error("Input.insertText: Execution context was destroyed.")) });
  expect(typing.hand.perform({ kind: "type", target: null, input: "query", text: "once", submit: false })).rejects.toThrow("Execution context was destroyed");
  await Bun.sleep(0);
  expect(typing.trace()).toEqual(["Input.insertText"]);
});

test("a tab the page opens is followed, and when it closes the hand is back where it was", async () => {
  const { hand, emit, of } = await onPage();
  emit({ method: "Target.targetCreated", params: { targetInfo: { targetId: "T2", type: "page", openerId: "T1" } } });
  await hand.observe();
  expect(of("Target.attachToTarget").map((s) => s.params.targetId)).toEqual(["T2"]);
  emit({ method: "Target.targetCreated", params: { targetInfo: { targetId: "T3", type: "page", openerId: "T9" } } }); // somebody else's tab
  emit({ method: "Target.targetDestroyed", params: { targetId: "T2" } });
  await hand.observe();
  expect(of("Target.attachToTarget").map((s) => s.params.targetId)).toEqual(["T2", "T1"]);
});

test("a dialog is answered at once, only a notice with yes, and the next look says what it said", async () => {
  const { hand, emit, of } = await onPage();
  emit({ method: "Page.javascriptDialogOpening", sessionId: "S1", params: { type: "confirm", message: "Delete this conversation?" } });
  emit({ method: "Page.javascriptDialogOpening", sessionId: "S1", params: { type: "alert", message: "Saved" } });
  expect(of("Page.handleJavaScriptDialog").map((s) => s.params.accept)).toEqual([false, true]);
  const obs = await hand.observe();
  expect(obs.texts).toContain('the page said: "Delete this conversation?"');
  expect((await hand.observe()).texts.join("\n")).not.toContain("the page said");
});

test("the window says where the page sits in it, from what the looks brought along", async () => {
  spyOn(windows, "browserWindow").mockResolvedValue({ id: 900, pid: 9, frame: [50, 60, 1824, 1343] });
  const { hand, sent } = await onPage();
  expect(hand.window()).toBeNull(); // nothing asked Windows yet
  await hand.open("https://mail.example.com/");
  // 1200 x 800 CSS pixels at 1.5 are 1800 x 1200 of the window's 1824 x 1343: borders of 12 beside and below, 131 of toolbar above.
  expect(hand.window()).toEqual({ hwnd: 900, frame: [1824, 1343], page: { x: 12, y: 131, scale: 1.5 } });
  expect(hand.place(el(0))).toEqual([12 + 30, 131 + 150, 150, 60]);
  sent.length = 0;
  hand.window();
  expect(sent).toEqual([]);
  expect(helper).toEqual([]);
});

// ------------------------------------------------------------------ open

test("open starts the browser only when the hand has none, and navigates its one session after that", async () => {
  const browser = fakeBrowser();
  const started = spyOn(windows, "openBackgroundWindow").mockResolvedValue({ pid: 9, windowId: 900, scripted: "T1" });
  spyOn(windows, "browserCdp").mockResolvedValue(browser.cdp);
  spyOn(windows, "windowFrame").mockReturnValue([0, 0, 1824, 1343]);
  const hand = await openHand(quiet);
  expect(started).not.toHaveBeenCalled(); // a hand that has done nothing has started nothing
  await hand.open("https://mail.example.com/inbox");
  expect(started.mock.calls).toEqual([["Google Chrome", "https://mail.example.com/inbox"]]);
  expect(browser.of("Target.attachToTarget")[0]!.params).toEqual({ targetId: "T1", flatten: true });
  expect(browser.of("Page.navigate")).toEqual([]); // it started with the address
  expect(hand.window()).toEqual({ hwnd: 900, frame: [1824, 1343], page: { x: 12, y: 131, scale: 1.5 } }); // known before the first look: the wait for the page brought it

  await hand.open("https://calendar.example.com/");
  expect(started).toHaveBeenCalledTimes(1);
  expect(browser.of("Page.navigate").map((s) => [s.params.url, s.sessionId])).toEqual([["https://calendar.example.com/", "S1"]]);
  expect(browser.of("Target.attachToTarget")).toHaveLength(1);
  expect(await hand.here()).toBeNull(); // the fake page has no address of its own
  expect(helper).toEqual([]);
});

test("a page that does not load is one sentence", async () => {
  spyOn(windows, "browserWindow").mockResolvedValue(null);
  const { hand } = await onPage({ "Page.navigate": { errorText: "net::ERR_NAME_NOT_RESOLVED" } });
  expect(hand.open("https://nowhere.invalid/")).rejects.toThrow("https://nowhere.invalid/ did not load: net::ERR_NAME_NOT_RESOLVED");
});

test("here is the page's address and title, and nothing when there is no page or no browser", async () => {
  const { hand } = await onPage({ "JSON.stringify({ url: location.href, title: document.title })": JSON.stringify({ url: "https://mail.example.com/inbox", title: "Inbox" }) });
  expect(await hand.here()).toEqual({ url: "https://mail.example.com/inbox", title: "Inbox" });
  const blank = await onPage({ "JSON.stringify({ url: location.href, title: document.title })": JSON.stringify({ url: "about:blank", title: "" }) });
  expect(await blank.hand.here()).toBeNull();

  spyOn(windows, "helperPath").mockReturnValue("/nonexistent/hands/hands-0.exe");
  const reached = spyOn(windows, "browserCdp");
  const idle = await openHand(quiet);
  expect(await idle.here()).toBeNull();
  expect(idle.observe()).rejects.toThrow("the hand has no window open yet");
  await Bun.sleep(0);
  expect(reached).not.toHaveBeenCalled(); // no lock on the profile: no browser, and asking a dead port costs seconds
  expect(idle.window()).toBeNull();
});

// ------------------------------------------------------------------ any other window

const node = (type: string, name: string, extra: Partial<UiaNode> = {}): UiaNode => ({
  ref: `500:42.${name.length}.${type.length}`, parent: 0, type, name, help: "", value: "", frame: [140, 260, 80, 40], offscreen: false, enabled: true, focused: false, password: false, actions: [], ...extra,
}); // prettier-ignore

const TREE: UiaNode[] = [
  node("Window", "Calculator", { parent: -1, frame: [100, 200, 400, 600] }),
  node("Button", "One", { actions: ["invoke"] }),
  node("Button", "Plus", { actions: ["invoke"], frame: [240, 260, 80, 40] }),
  node("Button", "Equals", { actions: ["invoke"], frame: [340, 260, 80, 40] }),
  node("Edit", "Expression", { actions: ["value"], value: "12", frame: [120, 220, 360, 30] }),
  node("Pane", "History", { actions: ["scroll"], frame: [120, 400, 360, 300] }),
  node("Pane", "Memory", { actions: ["scroll"], frame: [120, 400, 100, 100] }),
];

const USER = { id: 11, pid: 100, app: "WindowsTerminal", title: "bun hands --listen", minimized: false, frame: [0, 0, 900, 600] };
const THEIRS = { id: 300, pid: 7, app: "ApplicationFrameHost", title: "Calculator", minimized: false, frame: [900, 100, 400, 600] };
const OURS = { id: 500, pid: 7, app: "ApplicationFrameHost", title: "Calculator", minimized: true, frame: [-32000, -32000, 160, 28] };

/** A desk where the user already has a Calculator of their own, and the hand's appears on the second listing after the launch. */
function desk(replies: Record<string, unknown | ((args: (string | number)[]) => unknown)> = {}) {
  let listings = 0;
  let placed = false;
  fakeHelper({
    windows: () => ({ foreground: 11, cursor: [0, 0], displays: [[0, 0, 1920, 1080]], windows: [USER, THEIRS, ...(++listings >= 3 ? [placed ? { ...OURS, minimized: false, frame: [100, 200, 400, 600] } : OURS] : [])] }),
    launch: { pid: 1, foreground: 11 },
    behind: () => ((placed = true), { ok: true, tookFocus: false }),
    tree: { nodes: TREE },
    act: { ok: true, tookFocus: false, value: null },
    key: { ok: true },
    pointer: { ok: true },
    close: { ok: true },
    ...replies,
  });
}

async function onCalculator(replies: Parameters<typeof desk>[0] = {}, log: string[] = []) {
  desk(replies);
  const hand = await openHand({ log: (line) => log.push(line), ...quiet });
  await hand.launch("Calculator");
  const obs = await hand.observe();
  helper.length = 0;
  return { hand, obs };
}

test("launch starts the app behind the user's windows and takes its new window, never the one the user has", async () => {
  desk();
  const hand = await openHand(quiet);
  await hand.launch("Calculator");
  expect(helper.map((args) => args[0])).toEqual(["windows", "launch", "windows", "windows", "behind", "windows"]);
  expect([text(helper[1]![1]!), text(helper[1]![2]!), helper[1]![3]]).toEqual(["calc", "", "background"]);
  expect(helper[4]).toEqual(["behind", 500, 11]); // under everything, and the user keeps the window they were in
  expect(hand.window()).toEqual({ hwnd: 500, frame: [400, 600] });
});

test("an app that shows no window of its own is one sentence, and a window it pulled forward is given back", async () => {
  let listings = 0;
  fakeHelper({ windows: () => ({ foreground: ++listings === 1 ? 11 : 300, cursor: [0, 0], displays: [], windows: [USER, THEIRS] }), launch: { pid: 1, foreground: 11 }, front: { ok: true } });
  const hand = await openHand(quiet);
  expect(hand.launch("Calculator")).rejects.toThrow("Calculator showed no window of its own");
  await Bun.sleep(10);
  expect(helper.at(-1)).toEqual(["front", 11]);
  expect(hand.window()).toBeNull();
});

test("a native look is one run of the helper: the tree's first node is the window", async () => {
  const { hand, obs } = await onCalculator();
  expect(obs.title).toBe("Calculator");
  expect(obs.size).toEqual([400, 600]);
  expect(obs.elements.map((e) => `${e.id} ${e.role} ${e.name}`)).toEqual(["n1 button One", "n2 button Plus", "n3 button Equals", "n4 text field Expression"]);
  expect(obs.elements[0]!.rect).toEqual({ x: 40, y: 60, w: 80, h: 40 });
  await hand.observe();
  expect(helper).toEqual([["tree", 500]]);
  expect(hand.window()).toEqual({ hwnd: 500, frame: [400, 600] }); // no `page`: a native rect is the window's pixels already
  expect(hand.place(obs.elements[0]!)).toEqual([40, 60, 80, 40]);
});

test("native actions are patterns, EM_REPLACESEL and posted keys: one run of the helper each", async () => {
  const log: string[] = [];
  const { hand, obs } = await onCalculator({}, log);
  const [one, , , field] = obs.elements;
  await hand.perform({ kind: "click", target: one!, button: "left", count: 1, press: 0 });
  expect(helper).toEqual([["act", "500", one!.ref, "press"]]);

  helper.length = 0;
  await hand.perform({ kind: "type", target: field!, input: "sum", text: "12*31", submit: true });
  expect(helper.map((args) => args.slice(0, 4))).toEqual([["act", "500", field!.ref, "set"], ["key", "500", 13, ""]]); // prettier-ignore
  expect(text(helper[0]![4]!)).toBe("12*31");
  expect(log.join("\n")).not.toContain("12*31");

  helper.length = 0;
  await hand.perform({ kind: "key", combo: "Escape" });
  expect(helper).toEqual([["key", 500, 27, ""]]);

  helper.length = 0;
  await hand.perform({ kind: "scroll", direction: "down" });
  expect(helper).toEqual([["act", "500", TREE[5]!.ref, "down"]]); // the larger of the two areas

  helper.length = 0;
  await hand.perform({ kind: "click", target: one!, button: "left", count: 2 });
  expect(helper).toEqual([["pointer", 500, 2, 100 + 80, 200 + 80]]); // screen pixels: the window's corner plus the control's centre

  helper.length = 0;
  await hand.perform({ kind: "wait" });
  expect(helper).toEqual([]);
});

test("what would need the user's pointer, keyboard or focus is refused in one sentence, and nothing is sent", async () => {
  const { hand, obs } = await onCalculator();
  const one = obs.elements[0]!;
  const refused: [Action, string][] = [
    [{ kind: "click", target: one, button: "right", count: 1 }, 'a right click on button "One" needs the real pointer, and a hand never takes it'],
    [{ kind: "key", combo: "ctrl+a" }, "ctrl+a needs the real keyboard, and a hand never takes it"],
    [{ kind: "type", target: null, input: "sum", text: "12", submit: false }, "typing with no field named needs the keyboard, and a hand never takes it"],
    [{ kind: "select", target: one, option: "x" }, 'button "One" cannot be set from behind: press it, then press the option it shows'],
    [{ kind: "click", target: el(0), button: "left", count: 1 }, 'button "Compose" belongs to a window the hand is no longer working in'],
  ];
  for (const [action, sentence] of refused) {
    const error = (await hand.perform(action).catch((e: Error) => e)) as Error;
    expect(error.message).toBe(sentence);
    expect(error.message).not.toMatch(/\n|\.$/);
  }
  expect(helper).toEqual([]);
});

test("a control that will not be worked from behind, or is gone, is one sentence", async () => {
  const stubborn = await onCalculator({ act: { ok: false, tookFocus: false, value: null } });
  expect(stubborn.hand.perform({ kind: "click", target: stubborn.obs.elements[0]!, button: "left", count: 1 })).rejects.toThrow('button "One" cannot be pressed from behind');
  expect(stubborn.hand.perform({ kind: "type", target: stubborn.obs.elements[3]!, input: "sum", text: "1", submit: false })).rejects.toThrow('text field "Expression" does not take text from behind');
  expect(stubborn.hand.perform({ kind: "scroll", direction: "up" })).rejects.toThrow("nothing in this window scrolls from behind");
  await Bun.sleep(0);
  mock.restore();
  const gone = await onCalculator({ act: () => { throw new Error("the control is gone"); } }); // prettier-ignore
  expect(gone.hand.perform({ kind: "click", target: gone.obs.elements[0]!, button: "left", count: 1 })).rejects.toThrow("the control is gone");
});

test("a window that has closed says so", async () => {
  const { hand } = await onCalculator();
  mock.restore();
  fakeHelper({ tree: { nodes: [] }, windows: { foreground: 11, cursor: [0, 0], displays: [], windows: [USER] } });
  expect(hand.observe()).rejects.toThrow('the "Calculator" window has closed');
});

test("the user's window is named by its title", async () => {
  desk();
  const hand = await openHand(quiet);
  expect(await hand.onScreen()).toBe("bun hands --listen");
  mock.restore();
  windows.stale();
  spyOn(windows.native, "run").mockImplementation(() => { throw new Error("the helper did not build"); }); // prettier-ignore
  expect(await hand.onScreen()).toBeNull();
});

test("close lets go of the page and closes only the windows the hand opened", async () => {
  const browser = fakeBrowser();
  const closing = spyOn(browser.cdp, "close");
  desk();
  const hand = await openHand({ cdp: browser.cdp, ...quiet });
  await hand.observe();
  await hand.launch("Calculator");
  helper.length = 0;
  await hand.close();
  expect(browser.of("Target.detachFromTarget").map((s) => s.params)).toEqual([{ sessionId: "S1" }]);
  expect(closing).not.toHaveBeenCalled(); // the connection is the process's, not the hand's
  expect(helper).toEqual([["close", 500]]); // WM_CLOSE to its own Calculator; the user's (300) and the browser are left alone
  expect(hand.window()).toBeNull();
});
