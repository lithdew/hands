/**
 * A request from the words to the card, with only the platform faked: the real drive, pilot, screen loop, hand and
 * feed, over a helper, a browser, a Jev and a plan model that are scripts of replies. What the four halves were
 * each tested against was the others' fakes; this is them against each other.
 */

import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { Ask } from "../src/ask.ts";
import type { Cdp, CdpEvent } from "../src/devtools.ts";
import { drive, type DriveOptions } from "../src/drive.ts";
import type { PageDump } from "../src/elements.ts";
import { openFeed } from "../src/feed.ts";
import { openHand } from "../src/hand.ts";
import { memoryStore } from "../src/learned.ts";
import type { NativeSession } from "../src/macos.ts";
import type { NarrationInput } from "../src/narrate.ts";
import type { Step } from "../src/steps.ts";
import * as windows from "../src/windows.ts";
import type { UiaNode } from "../src/windows.ts";

// ------------------------------------------------------------------ the world, in the order things happened in it

let events: string[];
let steps: Step[];
let printed: string[];
let logged: string[];
let narrated: NarrationInput[];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  [events, steps, printed, logged, narrated] = [[], [], [], [], []];
  saved = { HANDS_FEED: process.env.HANDS_FEED, HANDS_DRIVER: process.env.HANDS_DRIVER, HANDS_NARRATOR_MODEL: process.env.HANDS_NARRATOR_MODEL };
  for (const name of Object.keys(saved)) delete process.env[name];
  windows.stale();
  // Whether the hand's browser runs is read off its profile's lock, next to the helper: a test has neither.
  spyOn(windows, "helperPath").mockReturnValue("/nonexistent/hands/hands-test.exe");
});
afterEach(() => {
  mock.restore();
  for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
});

/** windows.cs as a script of replies. Anything the test did not expect fails it, the way tests/helpers.ts guards the Mac. */
function fakeHelper(replies: Record<string, unknown | ((args: (string | number)[]) => unknown)>): (string | number)[][] {
  const calls: (string | number)[][] = [];
  spyOn(windows.native, "run").mockImplementation((...args: (string | number)[]) => {
    calls.push(args);
    events.push(`helper ${args[0]}${args[0] === "act" ? ` ${args[3]}` : ""}`);
    const reply = replies[String(args[0])];
    if (reply === undefined) throw new Error(`the test did not expect the helper to be asked for ${JSON.stringify(args[0])}`);
    return typeof reply === "function" ? reply(args) : reply;
  });
  return calls;
}

/** The real feed over feed.cs as a pipe, and in front of it a recorder: a step is noted the moment the driver reports it. */
function watchedFeed() {
  const exited = Promise.withResolvers<number>();
  let hangUp = () => {};
  const stdout = new ReadableStream<Uint8Array>({ start: (controller) => void (hangUp = () => (controller.close(), exited.resolve(0))) });
  const session: NativeSession = {
    stdout, stderr: new ReadableStream(), exited: exited.promise, end: () => hangUp(), kill: () => hangUp(),
    write: (line) => void (line.startsWith("draw ") || events.push(`feed ${line.trimEnd()}`)),
  }; // prettier-ignore
  const feed = openFeed({ open: () => session, print: (line) => printed.push(line), summarize: async (input) => (narrated.push(input), "Working on it."), narrateEveryMs: 1, cardLingerMs: 1, tileLingerMs: 1 });
  const watched: DriveOptions["feed"] = { step: (step) => (steps.push(step), events.push(`step ${step.kind} ${step.label}`), feed.step(step)), approve: (request) => feed.approve(request), task: (...row) => feed.task(...row) };
  return { feed, watched };
}

type Reply = string | number | ((state: any) => string | number);
/** Jev, answering by question name. Anything not named is a plain no, or the last label offered (every question's "none of these"). */
const fakeAsk = (replies: Record<string, Reply>): Ask =>
  (async (state: unknown, questions: Record<string, { type: string; criteria: Record<string, unknown> }>) =>
    Object.fromEntries(
      Object.entries(questions).map(([name, q]) => {
        const given = typeof replies[name] === "function" ? (replies[name] as (s: unknown) => string | number)(state) : replies[name];
        if (q.type === "noul") return [name, { type: "noul", noul: typeof given === "number" ? given : 0 }];
        return [name, { type: "choice", choice: typeof given === "string" ? given : Object.keys(q.criteria).at(-1)!, confidence: 1 }];
      }),
    )) as unknown as Ask;

const planOf = (task: Record<string, unknown>) => ({ can_do: true, tasks: [{ url: "", inputs: [], presses: [], facts: [], steps: [], avoid: [], wants_answer: false, ...task }] });
const once = (state: any) => (state.history?.length ? 1 : 0);
const quiet = { sleep: async () => {} };
const options = (watched: DriveOptions["feed"], more: Partial<DriveOptions>): Omit<DriveOptions, "hand"> => ({
  feed: watched, print: (line) => printed.push(line), log: (line) => logged.push(line), contacts: [], store: memoryStore(), piReady: async () => false, ...quiet, ...more,
}); // prettier-ignore

// ------------------------------------------------------------------ an application: every step is a run of the helper

const node = (type: string, name: string, more: Partial<UiaNode> = {}): UiaNode => ({
  ref: `500:${type}.${name}`, parent: 0, type, name, help: "", value: "", frame: [140, 260, 80, 40], offscreen: false, enabled: true, focused: false, password: false, actions: type === "Button" ? ["invoke"] : [], ...more,
}); // prettier-ignore
const keypad = (display: string): UiaNode[] => [
  node("Window", "Calculator", { ref: "500:1", parent: -1, frame: [100, 200, 400, 600] }),
  node("Text", `Display is ${display}`, { frame: [120, 220, 360, 60] }),
  node("Button", "One"),
  node("Button", "Two", { frame: [220, 260, 80, 40] }),
  node("Button", "Three", { frame: [300, 260, 80, 40] }),
  node("Button", "Multiply by", { frame: [380, 260, 80, 40] }),
  node("Button", "Equals", { frame: [380, 700, 80, 40] }),
];

const USER = { id: 11, pid: 100, app: "WindowsTerminal", title: "bun hands", minimized: false, frame: [0, 0, 900, 600] };
const THEIRS = { id: 300, pid: 7, app: "ApplicationFrameHost", title: "Calculator", minimized: false, frame: [900, 100, 400, 600] };
const OURS = { id: 500, pid: 7, app: "ApplicationFrameHost", title: "Calculator", minimized: true, frame: [-32000, -32000, 160, 28] };

test("a sum, from the words to the answer: reported, then pressed, behind the user's windows", async () => {
  let [listings, placed, pressed] = [0, false, 0];
  const helper = fakeHelper({
    // The user has a Calculator of their own. The hand's appears two listings after the launch, minimized, and `behind` gives it its size.
    windows: () => ({ foreground: 11, cursor: [0, 0], displays: [[0, 0, 1920, 1080]], windows: [USER, THEIRS, ...(++listings >= 3 ? [placed ? { ...OURS, minimized: false, frame: [100, 200, 400, 600] } : OURS] : [])] }),
    launch: { pid: 1, foreground: 11 },
    behind: () => ((placed = true), { ok: true, tookFocus: false }),
    tree: () => ({ nodes: keypad(pressed >= 6 ? "372" : "0") }),
    act: () => (pressed++, { ok: true, tookFocus: false, value: null }),
    close: { ok: true },
  });
  const { feed, watched } = watchedFeed();
  const hand = await openHand(quiet);
  const ask = fakeAsk({ app: "Calculator", press_0: "n1", press_1: "n2", press_2: "n4", press_3: "n3", press_4: "n1", press_5: "n5", goal_met: once, line: "t2" });
  const llm = async () => planOf({ goal: "Work out 12 times 31 in Calculator.", presses: ["1", "2", "×", "3", "1", "="], done_when: "The display shows 372.", wants_answer: true });

  const result = await drive("open the calculator and work out 12 times 31", { hand, ...options(watched, { ask, llm }) });
  expect(result).toMatchObject({ by: "app", status: "done", card: "done", answer: "Display is 372", handedOver: false });

  // The order of it: the row, the open step before the launch, a look, six presses each told before it is made, a look, done.
  const told = events.filter((e) => /^(feed task|step (open|look|click)|helper (launch|behind|tree|act))/.test(e));
  const press = (name: string) => [`step click click button "${name}"`, "helper act press"];
  expect(told).toEqual([
    "feed task 1 running open the calculator and work out 12 times 31",
    "step open open Calculator", "helper launch", "helper behind",
    "step look look 1", "helper tree",
    ...["One", "Two", "Multiply by", "Three", "One", "Equals"].flatMap(press),
    "step look look 2", "helper tree",
    "feed task 1 done open the calculator and work out 12 times 31",
  ]); // prettier-ignore

  // What the feed is given to draw with: the window from the first step after the launch, and each key in that window's own pixels.
  expect(events).toContain("feed pip 1 500");
  expect(events.indexOf("feed pip 1 500")).toBeLessThan(events.indexOf("step look look 1"));
  const clicks = steps.filter((s) => s.kind === "click");
  expect(clicks.map((s) => s.rect)).toEqual([[40, 60, 80, 40], [120, 60, 80, 40], [280, 60, 80, 40], [200, 60, 80, 40], [40, 60, 80, 40], [280, 500, 80, 40]]); // prettier-ignore
  for (const step of clicks) expect(step).toMatchObject({ hand: 1, hwnd: 500, frame: [400, 600], tier: "screen" });
  expect(steps.find((s) => s.kind === "open")).toMatchObject({ text: "Calculator", tier: "app" });
  expect(events).toContain('feed label 1 working click button "Equals"');

  // Nothing came forward, nothing took the seat, and the user's own Calculator was never touched.
  expect(helper.map((args) => args[0]).filter((command) => ["front", "input", "pointer", "key", "grab"].includes(String(command)))).toEqual([]);
  expect(helper.filter((args) => args[0] === "act").every((args) => args[1] === "500" && args[3] === "press")).toBe(true);
  expect(helper.find((args) => args[0] === "behind")).toEqual(["behind", 500, 11]);
  expect(helper.some((args) => args.includes(300))).toBe(false);

  expect(printed.slice(-2)).toEqual([expect.stringMatching(/^done by app: 2 looks, 6 actions/), "answer: Display is 372"]);

  // The window stays for the look at the result, and goes the way its close button closes it.
  expect(helper.some((args) => args[0] === "close")).toBe(false);
  await hand.close();
  expect(helper.at(-1)).toEqual(["close", 500]);
  await feed.close();
});

// ------------------------------------------------------------------ a page: every step goes down the one DevTools session

const SIGN_IN: PageDump = {
  url: "https://demo.example.com/login", title: "Sign in", ready: "complete", view: [1200, 800], texts: ["Sign in to Demo"],
  elements: [
    { i: 0, role: "text field", name: "Email", value: "", editable: true, focused: false, within: "form", secret: false, x: 300, y: 200, w: 400, h: 30 },
    { i: 1, role: "password field", name: "Password", value: "", editable: true, focused: false, within: "form", secret: true, x: 300, y: 260, w: 400, h: 30 },
    { i: 2, role: "button", name: "Sign in", value: "", editable: false, focused: false, within: "form", secret: false, x: 300, y: 320, w: 120, h: 40 },
  ],
}; // prettier-ignore

/** Chrome as a script of replies: every command is noted, and a page script answers as the page would. */
function fakeBrowser() {
  const closed = Promise.withResolvers<void>();
  const sizes = [1216, 895, 1.5]; // the window around the 1200 x 800 viewport, and the display's scale
  const cdp: Cdp = {
    async send(method: string, params: any = {}): Promise<any> {
      const script = method !== "Runtime.evaluate" ? "" : params.expression.includes("__hands = {") ? "look" : params.expression.includes("scrollIntoView") ? "reveal" : params.expression.includes("el.focus()") ? "focus" : "ready";
      events.push(`cdp ${script || (method.startsWith("Input.dispatch") ? `${method} ${params.type}` : method)}`);
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "T1", type: "page", title: SIGN_IN.title, url: SIGN_IN.url }] };
      if (method === "Target.attachToTarget") return { sessionId: "S1" };
      if (script === "look") return { result: { value: JSON.stringify([JSON.stringify(SIGN_IN), ...sizes]) } };
      if (script === "ready") return { result: { value: JSON.stringify(["complete", ...SIGN_IN.view, ...sizes]) } };
      if (script === "reveal") return { result: { value: JSON.stringify({ x: 300, y: 320, w: 120, h: 40 }) } };
      if (script === "focus") return { result: { value: "focused" } };
      return {};
    },
    on: (_handler: (event: CdpEvent) => void) => () => {},
    close: () => closed.resolve(),
    closed: closed.promise,
  };
  return cdp;
}

test("a page, from the words to done: no run of the helper per step, and a password is a mask everywhere it could show", async () => {
  const helper = fakeHelper({ windows: { foreground: 11, cursor: [0, 0], displays: [[0, 0, 1920, 1080]], windows: [USER] } }); // the planner is told what the user looks at: one listing a task
  spyOn(windows, "browserWindow").mockResolvedValue({ id: 900, pid: 9, frame: [50, 60, 1824, 1343] });
  const { feed, watched } = watchedFeed();
  const pause = { sleep: () => Bun.sleep(2) }; // a real moment between actions, which is when the narrator gets a word in
  const hand = await openHand({ cdp: fakeBrowser(), ...pause });
  const ask = fakeAsk({ fill_e1: "email", fill_e2: "password", next_0: "e3", goal_met: once });
  const llm = async () => planOf({ goal: "Sign in to the demo site.", url: "https://demo.example.com/login", inputs: [{ name: "email", value: "dana@example.com" }, { name: "password", value: "hunter2" }], done_when: "The account page is open." }); // prettier-ignore

  const result = await drive("sign in to the demo site as dana", { hand, ...options(watched, { ask, llm, ...pause }) });
  expect(result).toMatchObject({ by: "plan", status: "done", card: "done" });

  // One request to Jev fills the form and presses the button: three actions, each told first, each over DevTools, each checked by a look.
  const told = events.filter((e) => /^(feed task|step (navigate|look|type|click)|cdp (Page.navigate|look|Input.insertText|Input.dispatchMouseEvent mousePressed)|helper)/.test(e));
  expect(told.slice(0, 5)).toEqual(["feed task 1 running sign in to the demo site as dana", "helper windows", "step navigate open demo.example.com", "cdp Page.navigate", "step look look 1"]);
  const from = told.indexOf("step look look 1");
  expect(told.slice(from).filter((e) => e.startsWith("step") || e.startsWith("cdp Input") || e.startsWith("helper"))).toEqual([
    "step look look 1",
    'step type type email ("dana@example.com") into text field "Email" in "form"', "cdp Input.insertText", "step look look 2",
    'step type type password ((hidden)) into password field "Password" in "form"', "cdp Input.insertText", "step look look 3",
    'step click click button "Sign in" in "form"', "cdp Input.dispatchMouseEvent mousePressed", "step look look 4",
  ]); // prettier-ignore
  expect(helper.map((args) => args[0])).toEqual(["windows"]);

  // CSS pixels of the viewport, placed in the window: 12 of border beside it, 131 of toolbar above, at one and a half.
  const [email, password, button] = steps.filter((s) => s.kind === "type" || s.kind === "click");
  expect(email).toMatchObject({ hwnd: 900, frame: [1824, 1343], rect: [12 + 450, 131 + 300, 600, 45], text: "dana@example.com" });
  expect(password).toMatchObject({ rect: [12 + 450, 131 + 390, 600, 45], secret: true });
  expect(button).toMatchObject({ rect: [12 + 450, 131 + 480, 180, 60] });
  expect(steps.find((s) => s.kind === "look")).toMatchObject({ hwnd: 900, frame: [1824, 1343] });

  // The narrator read the steps as they were made, and said so on the card.
  expect(narrated.flatMap((input) => input.steps).some((step) => step.text.includes("type password"))).toBe(true);
  expect(events).toContain("feed progress 1 Working on it.");
  expect(JSON.stringify([steps, printed, logged, narrated, events.filter((e) => e.startsWith("feed"))])).not.toContain("hunter2");
  await hand.close();
  await feed.close();
});
