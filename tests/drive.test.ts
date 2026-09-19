import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Ask } from "../src/ask.ts";
import { MASK } from "../src/cursor.ts";
import { drive, type DriveOptions, handover, nativeApp, toApproval, toStep } from "../src/drive.ts";
import type { Observation, UiElement } from "../src/elements.ts";
import type { ApprovalRequest, TaskStatus } from "../src/feed.ts";
import type { Risk } from "../src/gate.ts";
import type { Hand } from "../src/hand.ts";
import type { LlmRequest } from "../src/intent.ts";
import { memoryStore } from "../src/learned.ts";
import type { Action, RunResult, runScreens, ScreenStep } from "../src/screen.ts";
import type { Step } from "../src/steps.ts";

// ------------------------------------------------------------------ fakes

const el = (id: string, name: string, overrides: Partial<UiElement> = {}): UiElement => ({
  id, role: "button", name, value: "", editable: false, focused: false, within: "", ref: id.startsWith("n") ? id : Number(id.slice(1)), rect: { x: 10, y: 20, w: 30, h: 40 }, ...overrides,
}); // prettier-ignore

const flat = ({ rect }: UiElement): [number, number, number, number] => [rect.x, rect.y, rect.w, rect.h];
const screenOf = (elements: UiElement[], mark = "a", texts: string[] = []): Observation => ({ elements, texts, title: "Calculator", size: [320, 500], fingerprint: mark });

/** Everything a drive touches, in the order it touched it. */
function world(looks: Observation[] = [screenOf([el("n1", "One")])]) {
  const events: string[] = [];
  const [steps, cards, asked, lines] = [[] as Step[], [] as [number, TaskStatus, string][], [] as ApprovalRequest[], [] as string[]];
  let look = 0;
  const hand: Hand = {
    id: 1,
    observe: async () => (events.push("observe"), looks[Math.min(look++, looks.length - 1)]!),
    perform: async (action: Action) => void events.push(`perform ${action.kind}${"target" in action && action.target ? ` ${action.target.name}` : ""}`),
    open: async (url) => void events.push(`open ${url}`),
    launch: async (app) => void events.push(`launch ${app}`),
    here: async () => null,
    onScreen: async () => null,
    window: () => ({ hwnd: 4242, frame: [640, 1000], page: { x: 8, y: 90, scale: 2 } }),
    place: (el) => (typeof el.ref === "string" ? flat(el) : [8 + el.rect.x * 2, 90 + el.rect.y * 2, el.rect.w * 2, el.rect.h * 2]), // as hand.ts: a page sits under the toolbar, at the display's scale
    close: async () => {},
  };
  let answer: boolean | Promise<boolean> = true;
  const feed: DriveOptions["feed"] = {
    // A feed that never gets back to the hand: nothing may wait for it.
    step: (step) => (steps.push(step), events.push(`step ${step.kind} ${step.label}`), new Promise(() => {}) as unknown as void),
    approve: async (request) => (asked.push(request), events.push("approve"), answer),
    task: (id, status, request) => (cards.push([id, status, request]), void events.push(`card ${status}`)),
  };
  return { events, steps, cards, asked, lines, hand, feed, answers: (next: boolean | Promise<boolean>) => (answer = next) };
}

type Reply = string | number | ((state: any) => string | number);
/** Jev, answering by question name. Anything not named is a plain no, or the last label offered (the "none of these" of every question here). */
const fakeAsk = (replies: Record<string, Reply> = {}, seenQuestions: string[] = []): Ask =>
  (async (state: unknown, questions: Record<string, { type: string; criteria: Record<string, unknown> }>) =>
    Object.fromEntries(
      Object.entries(questions).map(([name, q]) => {
        seenQuestions.push(name);
        const given = typeof replies[name] === "function" ? (replies[name] as (s: unknown) => string | number)(state) : replies[name];
        if (q.type === "noul") return [name, { type: "noul", noul: typeof given === "number" ? given : 0 }];
        return [name, { type: "choice", choice: typeof given === "string" ? given : Object.keys(q.criteria).at(-1)!, confidence: 1 }];
      }),
    )) as unknown as Ask;

const planOf = (task: Record<string, unknown> = {}) => ({
  can_do: true,
  tasks: [{ goal: "Find lofi videos on YouTube.", url: "https://www.youtube.com/results?search_query=lofi", inputs: [], presses: [], facts: [], steps: [], done_when: "Results are listed.", avoid: [], wants_answer: false, ...task }],
});

/** A screen loop that does what it is told: report, act, end. */
const scripted = (status: RunResult["status"], actions: Action[] = [], reason = "because"): typeof runScreens =>
  async (_intent, deps) => {
    await deps.observe();
    const steps: ScreenStep[] = [];
    for (const action of actions) {
      const step: ScreenStep = { kind: action.kind, label: `${action.kind} it`, ...("target" in action && action.target ? { target: action.target } : {}) };
      deps.onStep?.(step);
      steps.push(step);
      await deps.perform(action);
    }
    return { status, reason, steps };
  };

const click = (target: UiElement): Action => ({ kind: "click", target, button: "left", count: 1 });
const risk = (worst: Risk["worst"] = "irreversible"): Risk => ({ level: 0.9, worst, flags: { irreversible: 0, spends_money: 0, destroys_data: 0, handles_secret: 0, off_goal: 0, [worst]: 0.9 } });

function options(w: ReturnType<typeof world>, more: Partial<DriveOptions> = {}): DriveOptions {
  return { hand: w.hand, feed: w.feed, print: (line) => w.lines.push(line), ask: fakeAsk(), llm: async () => planOf(), contacts: [], store: memoryStore(), sleep: async () => {}, piReady: async () => false, ...more };
}

let driver: string | undefined;
beforeEach(() => ((driver = process.env.HANDS_DRIVER), delete process.env.HANDS_DRIVER));
afterEach(() => (driver === undefined ? delete process.env.HANDS_DRIVER : (process.env.HANDS_DRIVER = driver)));

// ------------------------------------------------------------------ steps

test("a step carries the hand's window, the control where the hand says it is, and who decided it", () => {
  const { hand } = world();
  const target = el("e3", "Search");
  expect(toStep({ kind: "click", label: 'click button "Search"', target }, hand)).toEqual({
    hand: 1, kind: "click", label: 'click button "Search"', tier: "screen", hwnd: 4242, frame: [640, 1000], rect: [28, 130, 60, 80],
  }); // prettier-ignore
  // A native control is measured in its window's pixels already.
  expect(toStep({ kind: "click", label: 'click button "Seven"', target: el("n7", "Seven") }, hand).rect).toEqual([10, 20, 30, 40]);
  expect(toStep({ kind: "click", label: 'double click list item "report.pdf"', target }, hand).count).toBe(2);
  expect(toStep({ kind: "click", label: 'right click list item "report.pdf"', target }, hand).button).toBe("right");
  expect(toStep({ kind: "select", label: 'set dropdown "Party size" to "4 people"', target }, hand).kind).toBe("control");
  expect(toStep({ kind: "key", label: "press Return (Enter: submit the focused form.)" }, hand)).toMatchObject({ kind: "key", label: "press Return", text: "Return" });
  expect(toStep({ kind: "scroll", label: "scroll up" }, hand)).toMatchObject({ kind: "scroll", text: "up" });
  expect(toStep({ kind: "wait", label: "wait for the screen to settle" }, hand, "plan")).toMatchObject({ kind: "wait", tier: "plan" });
});

test("what is typed is shown, and a password is only ever a mask", () => {
  const { hand } = world();
  const field = el("e1", "Search", { role: "text field", editable: true });
  expect(toStep({ kind: "type", label: 'type search_query ("lofi") into text field "Search"', target: field, text: "lofi" }, hand)).toMatchObject({ kind: "type", text: "lofi" });
  const secret = toStep({ kind: "type", label: 'type password ((hidden)) into password field "Password"', target: { ...field, secret: true } }, hand);
  expect(secret).toMatchObject({ kind: "type", text: MASK, secret: true });
  expect(JSON.stringify(secret)).not.toContain("hunter2");
});

test("a hand with no window yet still says where, in what the look measured", () => {
  const { hand } = world();
  const step = toStep({ kind: "click", label: "click it", target: el("e1", "Go") }, { ...hand, window: () => null, place: flat }, "screen", [800, 600]);
  expect(step).toMatchObject({ rect: [10, 20, 30, 40], frame: [800, 600] });
  expect(step.hwnd).toBeUndefined();
});

test("the gate's question becomes the card's: the action in words, the control and the page", () => {
  const asked = toApproval({ action: 'click button "Send" in "New Message"', target: el("e9", "Send"), risk: risk() }, 2, "Inbox - Gmail");
  expect(asked).toEqual({ hand: 2, what: 'click button "Send" in "New Message", which cannot be undone', target: "Send; Inbox - Gmail" });
  expect(toApproval({ action: "press Return", risk: risk("spends_money") }, 1)).toEqual({ hand: 1, what: "press Return, which spends money" });
});

// ------------------------------------------------------------------ the run

test("every step reaches the feed before its action, and a feed that never answers holds nothing up", async () => {
  const w = world();
  const button = el("n1", "One");
  const result = await drive("find lofi hip hop videos on youtube", options(w, { runScreens: scripted("done", [click(button), click(button)]) }));
  expect(result).toMatchObject({ by: "plan", status: "done", card: "done", handedOver: false });
  expect(w.events).toEqual([
    "card running",
    "step think reading the request",
    "step think Find lofi videos on YouTube.",
    "step navigate open www.youtube.com",
    "open https://www.youtube.com/results?search_query=lofi",
    "step look look 1",
    "observe",
    "step click click it",
    "perform click One",
    "step click click it",
    "perform click One",
    "card done",
  ]);
  expect(w.steps.find((s) => s.kind === "navigate")).toMatchObject({ text: "https://www.youtube.com/results?search_query=lofi", tier: "plan", hwnd: 4242 });
  expect(w.steps.find((s) => s.kind === "click")).toMatchObject({ tier: "screen", rect: [10, 20, 30, 40], frame: [640, 1000] });
  expect(w.lines).toContain("[screen] click it");
  expect(w.lines.at(-1)).toStartWith("done by plan: 1 look, 2 actions");
  expect(w.cards).toEqual([[1, "running", "find lofi hip hop videos on youtube"], [1, "done", "find lofi hip hop videos on youtube"]]); // prettier-ignore
});

test("a look that led to no action is a step too, so the narrator can say why nothing moved", async () => {
  const w = world();
  const hesitant: typeof runScreens = async (_intent, deps) => {
    deps.log?.("look 1: looking again (the screen is still loading)");
    deps.log?.('look 2: click button "Go" -> screen changed'); // an action's outcome: its step was already reported
    deps.log?.("understood by plan: 1 task");
    return { status: "done", reason: "", steps: [] };
  };
  await drive("find lofi videos", options(w, { runScreens: hesitant }));
  expect(w.steps.filter((s) => s.kind === "think").map((s) => s.label)).toEqual(["reading the request", "Find lofi videos on YouTube.", "looking again (the screen is still loading)"]);
});

test("the gate is given the user's own words, never the goal a model wrote", async () => {
  const w = world();
  let authorization: string | undefined;
  const spy: typeof runScreens = async (_intent, deps) => ((authorization = deps.authorization?.()), { status: "done", reason: "", steps: [] });
  await drive("  find lofi hip hop videos on youtube ", options(w, { runScreens: spy }));
  expect(authorization).toBe("find lofi hip hop videos on youtube");
});

// The real loop: one look at a Send button that Jev wants clicked and the gate flags.
const sending = () => world([screenOf([el("e1", "Send")], "draft")]);
const gated = { move: "click", target_0: "e1", irreversible: 0.9, goal_met: (state: any) => (state.history?.length ? 1 : 0) };

test("an allowed action is asked about on the card, then done", async () => {
  const w = sending();
  const result = await drive("send it", options(w, { ask: fakeAsk(gated) }));
  expect(w.asked).toEqual([{ hand: 1, what: 'click button "Send", which cannot be undone', target: "Send; Calculator" }]);
  expect(w.events.indexOf("approve")).toBeLessThan(w.events.indexOf("perform click Send"));
  expect(result).toMatchObject({ status: "done", card: "done" });
});

for (const [how, answer] of [["declined", () => false], ["left unanswered", () => Bun.sleep(5).then(() => false)]] as const) {
  test(`an action that is ${how} is not done, and nobody else is asked to do it`, async () => {
    const w = sending();
    w.answers(answer());
    let handed = 0;
    const result = await drive("send it", options(w, { ask: fakeAsk(gated), piReady: async () => true, fallback: async () => (handed++, true) }));
    expect(result).toMatchObject({ status: "denied", card: "stopped", handedOver: false });
    expect(w.events.filter((e) => e.startsWith("perform"))).toEqual([]);
    expect(handed).toBe(0);
    expect(w.cards.at(-1)).toEqual([1, "stopped", "send it"]);
    expect(w.lines.at(-1)).toBe('stopped: click button "Send"');
  });
}

test("what Jev gives up on goes to the pi agent only when pi is signed in, with what was tried", async () => {
  for (const status of ["gave_up", "out_of_steps"] as const) {
    const w = world();
    const prompts: string[] = [];
    const result = await drive("find lofi videos", options(w, { runScreens: scripted(status, [click(el("e1", "Search"))], "no listed element fits"), model: "openai/gpt-5.6-luna", piReady: async (model) => model === "openai/gpt-5.6-luna", fallback: async (prompt) => (prompts.push(prompt), true) })); // prettier-ignore
    expect(result).toMatchObject({ status, handedOver: true, card: "done" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toStartWith("find lofi videos\n");
    expect(prompts[0]).toContain("no listed element fits");
    expect(prompts[0]).toContain("https://www.youtube.com/results?search_query=lofi");
    expect(prompts[0]).toContain("click it");
    expect(w.cards.map(([, s]) => s)).toEqual(["running", "done"]);
  }
});

test("an agent that fails leaves the card failed", async () => {
  const w = world();
  const result = await drive("find lofi videos", options(w, { runScreens: scripted("gave_up"), piReady: async () => true, fallback: async () => false }));
  expect(result).toMatchObject({ handedOver: true, card: "failed" });
});

test("with pi not signed in, one line says what Jev could not do and how to enable the fallback", async () => {
  const w = world();
  let handed = 0;
  const result = await drive("find lofi videos", options(w, { runScreens: scripted("gave_up", [], "no listed element fits"), piReady: async () => false, fallback: async () => (handed++, true) }));
  expect(result).toMatchObject({ status: "gave_up", card: "failed", handedOver: false });
  expect(handed).toBe(0);
  const said = w.lines.filter((line) => line.includes("Jev gave up"));
  expect(said).toHaveLength(1);
  expect(said[0]).toContain("no listed element fits");
  expect(said[0]).toContain("run `pi`, then /login");
  expect(w.cards.at(-1)![1]).toBe("failed");
});

test("HANDS_DRIVER=jev keeps a task from the fallback even when pi is signed in", async () => {
  process.env.HANDS_DRIVER = "jev";
  const w = world();
  let handed = 0;
  const result = await drive("find lofi videos", options(w, { runScreens: scripted("gave_up"), piReady: async () => true, fallback: async () => (handed++, true) }));
  expect([result.handedOver, handed]).toEqual([false, 0]);
  expect(w.lines.at(-1)).toContain("HANDS_DRIVER=jev");
});

test("a request no browser can do is given up on, not crashed on", async () => {
  const w = world();
  const result = await drive("rename the files on my desktop", options(w, { llm: async () => ({ can_do: false, tasks: [] }) }));
  expect(result).toMatchObject({ by: "plan", status: "gave_up", reason: "it is not something a web browser can do", card: "failed" });
  expect(w.events.some((e) => e.startsWith("open") || e.startsWith("perform"))).toBe(false);
});

test("a hand that throws fails the task in one sentence, and nothing is handed over", async () => {
  const w = world();
  w.hand.open = async () => Promise.reject(new Error("the browser did not start"));
  let handed = 0;
  const result = await drive("find lofi videos", options(w, { piReady: async () => true, fallback: async () => (handed++, true) }));
  expect(result).toMatchObject({ status: "failed", reason: "the browser did not start", card: "failed" });
  expect(w.lines.at(-1)).toBe("failed: the browser did not start");
  expect(handed).toBe(0);
});

test("what the hand cannot do from behind ends Jev's run in that sentence, with what it did, and the agent is asked", async () => {
  const w = world();
  const prompts: string[] = [];
  w.hand.perform = async () => Promise.reject(new Error('button "One" cannot be pressed from behind'));
  const result = await drive("press one", options(w, { ask: fakeAsk({ move: "click", target_0: "n1" }), piReady: async () => true, fallback: async (prompt) => (prompts.push(prompt), true) }));
  expect(result).toMatchObject({ status: "gave_up", reason: 'button "One" cannot be pressed from behind', handedOver: true });
  expect(prompts[0]).toContain('click button "One" (could not be done)');
});

test("a follow-up with nothing open to follow is one line, and nothing is looked at", async () => {
  const w = world();
  const result = await drive("reply to that", options(w, { llm: async () => planOf({ goal: "Reply to the open email.", url: "" }) }));
  expect(result).toMatchObject({ by: "plan", status: "gave_up", card: "failed", reason: "there is no plan for it (it names no site, and the hand has no page open to carry on from)" });
  expect(w.events.some((e) => e === "observe" || e.startsWith("open"))).toBe(false);
});

test("a password typed into the field that has the focus is as hidden as one typed into a named field", async () => {
  const field = el("e1", "Password", { role: "password field", editable: true, focused: true, secret: true });
  const w = world([screenOf([field, el("e2", "Sign in")], "login")]);
  const llm = async () => planOf({ goal: "Sign in.", url: "https://demo.example.com/login", inputs: [{ name: "password", value: "hunter2" }] });
  const logged: string[] = [];
  await drive("sign in", options(w, { llm, log: (line) => logged.push(line), ask: fakeAsk({ fill_e1: "keep_as_is", move: "type", field: "focused_field", input: "password", goal_met: (state: any) => (state.history?.length ? 1 : 0) }) }));
  expect(w.steps.find((s) => s.kind === "type")).toMatchObject({ text: MASK, secret: true });
  expect(w.events).toContain("perform type Password");
  expect(JSON.stringify([w.steps, w.lines, logged])).not.toContain("hunter2");
});

test("taking the task back through the signal stops the loop and the card, and nothing is handed over", async () => {
  const w = world();
  const stop = new AbortController();
  let handed = 0;
  w.hand.perform = async () => stop.abort();
  const result = await drive("send it", options(w, { signal: stop.signal, ask: fakeAsk({ move: "click", target_0: "n1" }), piReady: async () => true, fallback: async () => (handed++, true) }));
  expect(result).toMatchObject({ status: "cancelled", card: "stopped", handedOver: false });
  expect(handed).toBe(0);
  expect(w.lines.at(-1)).toBe("stopped: the task was taken back");
});

// ------------------------------------------------------------------ an application on this computer

test("Jev names an application only when it is sure, and never the browser", async () => {
  expect(await nativeApp(fakeAsk({ app: "Calculator" }), "open the calculator")).toEqual({ name: "Calculator", onlyOpen: false });
  expect(await nativeApp(fakeAsk({ app: "Notepad", only_open: 0.9 }), "open notepad")).toEqual({ name: "Notepad", onlyOpen: true });
  expect(await nativeApp(fakeAsk({ app: "browser" }), "search youtube")).toBeNull();
  expect(await nativeApp(fakeAsk(), "what now")).toBeNull();
  const unsure = (async () => ({ app: { type: "choice", choice: "Paint", confidence: 0.4 }, only_open: { type: "noul", noul: 0 } })) as unknown as Ask;
  expect(await nativeApp(unsure, "maybe draw")).toBeNull();
});

test("a sum is typed into the real Calculator: launched, planned for that app, every key pressed in one look", async () => {
  const keys = [el("n1", "One"), el("n2", "Two"), el("n3", "Multiply by"), el("n4", "Three"), el("n5", "Equals")];
  const w = world([screenOf(keys, "empty", ["window: Calculator", "Display is 0"]), screenOf(keys, "result", ["window: Calculator", "Display is 372"])]);
  const planned: LlmRequest[] = [];
  const llm = async (request: LlmRequest) => (planned.push(request), planOf({ goal: "Work out 12 times 31 in Calculator.", url: "", presses: ["1", "2", "×", "3", "1", "="], done_when: "The display shows 372.", wants_answer: true }));
  const ask = fakeAsk({ app: "Calculator", press_0: "n1", press_1: "n2", press_2: "n3", press_3: "n4", press_4: "n1", press_5: "n5", goal_met: (state: any) => (state.history?.length ? 1 : 0), line: "t2" });
  const result = await drive("open the calculator and work out 12 times 31", options(w, { ask, llm }));

  expect(result).toMatchObject({ by: "app", status: "done", card: "done", answer: "Display is 372" });
  expect(planned).toHaveLength(1);
  expect(planned[0]!.system).toContain('desktop application "Calculator"');
  expect(w.events.filter((e) => e.startsWith("launch") || e.startsWith("open") || e.startsWith("perform"))).toEqual([
    "launch Calculator", "perform click One", "perform click Two", "perform click Multiply by", "perform click Three", "perform click One", "perform click Equals",
  ]); // prettier-ignore
  expect(w.events.indexOf("step open open Calculator")).toBeLessThan(w.events.indexOf("launch Calculator"));
  for (const [i, event] of w.events.entries()) if (event.startsWith("perform")) expect(w.events[i - 1]).toStartWith("step click");
  expect(w.steps.find((s) => s.kind === "open")).toMatchObject({ text: "Calculator", tier: "app" });
  expect(w.events.filter((e) => e === "observe")).toHaveLength(2); // six keys, two looks
  expect(w.lines.slice(-2)).toEqual([expect.stringMatching(/^done by app: 2 looks, 6 actions/), "answer: Display is 372"]);
});

test("asked only to open an application, the hand opens it and no model is called", async () => {
  const w = world();
  let calls = 0;
  const result = await drive("open notepad", options(w, { ask: fakeAsk({ app: "Notepad", only_open: 1 }), llm: async () => (calls++, planOf()) }));
  expect(result).toMatchObject({ by: "app", status: "done", reason: "Notepad is open" });
  expect([calls, w.events.includes("launch Notepad"), w.events.includes("observe")]).toEqual([0, true, false]);
});

test("an application that cannot be planned for stays open and is handed over as that", async () => {
  const w = world();
  const prompts: string[] = [];
  const result = await drive("draw a cat in paint", options(w, { ask: fakeAsk({ app: "Paint" }), llm: async () => ({ can_do: false, tasks: [] }), piReady: async () => true, fallback: async (prompt) => (prompts.push(prompt), true) }));
  expect(result).toMatchObject({ by: "app", status: "gave_up", handedOver: true });
  expect(prompts[0]).toContain("It opened Paint");
});

test("the note for the agent keeps the last few steps and what came of them", () => {
  const steps: ScreenStep[] = Array.from({ length: 10 }, (_, n) => ({ kind: "click", label: `click ${n}`, outcome: "screen changed" }));
  const note = handover("book a table", { reason: "unsure which element to click", opened: ["https://www.opentable.com/"], steps });
  expect(note).toStartWith("book a table\n\n(");
  expect(note).toContain("click 9 (screen changed)");
  expect(note).not.toContain("click 1 (");
});
