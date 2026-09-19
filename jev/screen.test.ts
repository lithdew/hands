import { describe, expect, test } from "bun:test";
import type { Intent } from "./intent";
import { assertContract, type Ask } from "./jev";
import { decideScreen, describeScreenAction, runScreens, structureOf, type ScreenAction, type ScreenDeps } from "./screen";
import type { Observation } from "./observe";
import { SIM_HAND, World } from "./sim";

const EMAIL: Intent = {
  goal: "Send an email to Sam Rivera", launcher: "browser", url: "https://mail.google.com/", avoid: [], doneWhen: "The screen says the message was sent.",
  inputs: { recipient: "sam.rivera@example.com", subject: "Reminder", body: "See you at ten." },
};

type Script = (name: string, question: any, state: any) => string | number | undefined;

/** A scripted Jev. Unscripted choices keep, pick nothing, or take the first label; unscripted nouls say no. */
function fakeJev(script: Script) {
  const calls: { state: any; questions: Record<string, any> }[] = [];
  const ask: Ask = async (state, questions) => {
    calls.push({ state, questions });
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(questions) as [string, any][]) {
      const r = script(name, q, state);
      if (q.type === "noul") { answers[name] = { type: "noul", noul: typeof r === "number" ? r : 0 }; continue; }
      const fallback = ["keep_as_is", "none_of_these"].find((l) => Object.hasOwn(q.criteria, l)) ?? Object.keys(q.criteria)[0]!;
      answers[name] = { type: "choice", choice: typeof r === "string" ? r : fallback, confidence: 0.9, probabilities: {} };
    }
    assertContract(questions, answers);
    return answers as never;
  };
  return { ask, calls, decisions: () => calls.filter((c) => "move" in c.questions), gates: () => calls.filter((c) => "irreversible" in c.questions) };
}

const idOf = (world: World, key: string) => world.look().elements.find((el) => world.keyOf(el.id) === key)!.id;
const llm = async () => { throw new Error("no LLM call is expected"); };

describe("decideScreen", () => {
  test("a compose window is one request: every field's text, then the button", async () => {
    const world = new World(); world.open("https://mail.google.com/mail/?view=cm");
    const obs = world.look(), to = idOf(world, "to"), subject = idOf(world, "subject"), body = idOf(world, "body"), send = idOf(world, "send");
    const jev = fakeJev((name) => ({ [`fill_${to}`]: "recipient", [`fill_${subject}`]: "subject", [`fill_${body}`]: "body", next_0: send, move: "type" })[name]);
    const decision = await decideScreen({ ask: jev.ask, llm }, SIM_HAND, EMAIL, obs, { history: [], plan: null });
    expect(jev.calls).toHaveLength(1);
    expect(decision.kind === "act" && decision.actions.map(describeScreenAction).map((d) => d.split(/ in (?:window )?"/)[0])).toEqual([
      'type recipient ("sam.rivera@example.com") into text field "To recipients"', 'type subject ("Reminder") into text field "Subject"', 'type body ("See you at ten.") into text field "Message Body"', 'click button "Send"',
    ]);
    expect(Object.keys(jev.calls[0]!.questions)).not.toContain(`fill_${send}`); // only text fields get a fill question
  });

  test("code, not Jev, skips a field that already holds its text", async () => {
    const world = new World(); world.open(`https://mail.google.com/mail/?${new URLSearchParams({ view: "cm", to: EMAIL.inputs.recipient!, su: EMAIL.inputs.subject!, body: EMAIL.inputs.body! })}`);
    const send = idOf(world, "send");
    const jev = fakeJev((name) => (name.startsWith("fill_") ? { to: "recipient", subject: "subject", body: "body" }[world.keyOf(name.slice(5))!] : { move: "click", target_0: send, next_0: send }[name]));
    const decision = await decideScreen({ ask: jev.ask, llm }, SIM_HAND, EMAIL, world.look(), { history: [], plan: null });
    expect(decision.kind === "act" && decision.actions.map((a) => a.kind)).toEqual(["click"]);
  });

  test("an open list of suggestions is answered before anything is filled", async () => {
    const world = new World(); world.open("https://mail.google.com/mail/?view=cm&to=Sam");
    const option = idOf(world, "suggest_0"), subject = idOf(world, "subject");
    const jev = fakeJev((name) => ({ [`fill_${subject}`]: "subject", move: "click", target_0: option })[name]);
    const decision = await decideScreen({ ask: jev.ask, llm }, SIM_HAND, EMAIL, world.look(), { history: [], plan: null });
    expect(decision.kind === "act" && decision.actions.map(describeScreenAction)[0]).toContain('click option "Sam Rivera');
    expect(decision.kind === "act" && decision.actions).toHaveLength(1);
  });

  test("a dropdown whose options can be read is set without opening it; one that cannot is checked by name and fixed first", async () => {
    const table: Intent = { ...EMAIL, goal: "Reserve a table for 4 on Friday, September 25, 2026 at 8:00 PM", inputs: { restaurant_or_cuisine: "sushi" } };
    const world = new World(); world.open("https://www.opentable.com/");
    const date = idOf(world, "date"), time = idOf(world, "time"), party = idOf(world, "party"), term = idOf(world, "term"), go = idOf(world, "go");
    const script = (dateIsRight: number): Script => (name) => ({ [`right_${date}`]: dateIsRight, [`set_${time}`]: "8:00 PM", [`set_${party}`]: "4 people", [`fill_${term}`]: "restaurant_or_cuisine", next_0: go, move: "type" })[name];

    const fixFirst = await decideScreen({ ask: fakeJev(script(0.1)).ask, llm }, SIM_HAND, table, world.look(), { history: [], plan: null });
    expect(fixFirst.kind === "act" && fixFirst.actions.map(describeScreenAction).map((d) => d.split(/ in (?:window )?"/)[0])).toEqual(['click dropdown "Date"']);

    const batch = await decideScreen({ ask: fakeJev(script(0.9)).ask, llm }, SIM_HAND, table, world.look(), { history: [], plan: null });
    expect(batch.kind === "act" && batch.actions.map((a) => a.kind)).toEqual(["type", "select", "select", "click"]);
  });
});

describe("runScreens", () => {
  function depsFor(world: World, ask: Ask, approvals: string[]): ScreenDeps {
    return { ask, llm, sleep: async () => {}, settleMs: 0, screenshot: async () => new Uint8Array(), observe: async () => world.look(),
      perform: async (_hand, action: ScreenAction) => world.act(action, describeScreenAction(action)),
      approve: async ({ action }) => { approvals.push(action); return true; } };
  }

  test("a whole email in two looks: the batch is gated action by action in one round, and only Send asks the user", async () => {
    const world = new World(); world.open("https://mail.google.com/mail/?view=cm");
    const approvals: string[] = [];
    const jev = fakeJev((name, _q, state) => {
      if (name === "irreversible") return /click button "Send"/.test(state.action) ? 0.9 : 0.02;
      if (name === "goal_met") return world.gmail.sent.length ? 0.95 : 0;
      if (name.startsWith("fill_")) return { to: "recipient", subject: "subject", body: "body" }[world.keyOf(name.slice(5))!];
      if (name === "next_0") return world.gmail.compose ? idOf(world, "send") : undefined;
      return undefined;
    });
    const result = await runScreens(SIM_HAND, EMAIL, depsFor(world, jev.ask, approvals));
    expect(result.status).toBe("done");
    expect(world.gmail.sent).toEqual([{ to: ["sam.rivera@example.com"], subject: "Reminder", body: "See you at ten.", account: "chi@example.com" }]);
    expect(jev.decisions()).toHaveLength(2); // the form, then the look that sees "Message sent"
    expect(jev.gates()).toHaveLength(4); // one gate request per action, as in cua.ts
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toContain('click button "Send"');
  });

  test("a batch stops when the screen grows new elements, and Jev looks again", async () => {
    const world = new World(); world.open("https://mail.google.com/mail/?view=cm");
    const named: Intent = { ...EMAIL, inputs: { ...EMAIL.inputs, recipient: "Sam" } };
    let looks = 0;
    const jev = fakeJev((name) => {
      if (name === "move") looks++;
      if (looks > 1) return name === "move" ? "ask_planner" : undefined; // stop after the first batch
      if (name.startsWith("fill_")) return { to: "recipient", subject: "subject" }[world.keyOf(name.slice(5))!];
      return undefined;
    });
    await runScreens(SIM_HAND, named, depsFor(world, jev.ask, []), { maxPlans: 0 });
    expect(world.acted.map((d) => d.split(/ in (?:window )?"/)[0])).toEqual(['type recipient ("Sam") into text field "To recipients"']); // the suggestions opened: Subject was not typed over them
    expect(world.gmail.compose?.suggest.length).toBeGreaterThan(0);
  });

  test("structureOf ignores what fields hold", () => {
    const world = new World(); world.open("https://keep.google.com/");
    world.act({ kind: "click", target: world.look().elements.find((el) => el.name === "Take a note…")!, button: "left", count: 1 }, "");
    const before = structureOf(world.look());
    world.act({ kind: "type", target: world.look().elements.find((el) => el.name === "Note")!, input: "note", text: "milk", submit: false }, "");
    expect(structureOf(world.look())).toBe(before);
  });
});

describe("press sequences", () => {
  // The Windows Calculator as win/uia.ts reads it: a keypad whose buttons never change, and a display that is text.
  const KEYS = ["Clear", "Divide by", "Multiply by", "Minus", "Plus", "Equals", "Zero", "One", "Two", "Three"];
  function keypad() {
    let display = "0";
    const pressed: string[] = [];
    const look = (): Observation => ({ frames: ["Calculator"], texts: ["window: Calculator", `Display is ${display}`], fingerprint: display + pressed.length,
      elements: KEYS.map((name, i) => ({ id: `n${i}`, source: "atspi" as const, role: "button", name, value: "", editable: false, focused: false, within: "Number pad", frame: "Calculator", rect: { x: 10 + i * 40, y: 300, w: 36, h: 36 } })) });
    return { look, pressed, press: (name: string) => { pressed.push(name); if (name === "Equals") display = "372"; } };
  }
  const intent: Intent = { goal: "Enter 12 × 31 in the calculator.", launcher: "none", url: null, inputs: {}, doneWhen: "The display shows 372.", avoid: [], presses: ["1", "2", "×", "3", "1", "="] };
  const NAMES: Record<string, string> = { "1": "One", "2": "Two", "3": "Three", "×": "Multiply by", "=": "Equals" };

  test("six keys are one decision: every key finds its button in the same request, and they are pressed in order", async () => {
    const pad = keypad();
    const jev = fakeJev((name, q) => {
      if (name === "goal_met") return pad.pressed.includes("Equals") ? 0.95 : 0;
      const key = /^press_(\d+)$/.exec(name);
      if (key) return pad.look().elements.find((el) => el.name === NAMES[/enter "(.+?)" now/.exec(q.instructions)![1]!])!.id;
      return undefined;
    });
    const result = await runScreens(SIM_HAND, intent, { ask: jev.ask, llm, sleep: async () => {}, settleMs: 0, screenshot: async () => new Uint8Array(), approve: async () => true, observe: async () => pad.look(),
      perform: async (_hand, action: ScreenAction) => { if (action.kind === "click") pad.press(action.target.name); } });
    expect(result.status).toBe("done");
    expect(pad.pressed).toEqual(["One", "Two", "Multiply by", "Three", "One", "Equals"]);
    expect(jev.decisions()).toHaveLength(2); // the keypad, then the look that reads the display
    expect(Object.keys(jev.decisions()[1]!.questions).filter((q) => q.startsWith("press_"))).toEqual([]); // entered keys are not asked about again
  });

  test("a window's menu bar is not an open menu: the keys are still entered in one go", async () => {
    const pad = keypad();
    // Every classic Windows window has these in its title bar.
    const withTitleBar = (): Observation => { const seen = pad.look(); return { ...seen, elements: [{ ...seen.elements[0]!, id: "n90", role: "menu", name: "System", within: "System Menu Bar" }, ...seen.elements] }; };
    const jev = fakeJev((name, q) => {
      if (name === "goal_met") return pad.pressed.includes("Equals") ? 0.95 : 0;
      if (/^press_/.test(name)) return withTitleBar().elements.find((el) => el.name === NAMES[/enter "(.+?)" now/.exec(q.instructions)![1]!])!.id;
      return undefined;
    });
    await runScreens(SIM_HAND, intent, { ask: jev.ask, llm, sleep: async () => {}, settleMs: 0, screenshot: async () => new Uint8Array(), approve: async () => true, observe: async () => withTitleBar(),
      perform: async (_hand, action: ScreenAction) => { if (action.kind === "click") pad.press(action.target.name); } });
    expect(pad.pressed).toEqual(["One", "Two", "Multiply by", "Three", "One", "Equals"]);
    expect(jev.decisions()).toHaveLength(2);
  });

  test("a key with no button means this is not the keypad yet: nothing is half entered", async () => {
    const pad = keypad();
    const jev = fakeJev((name) => (name === "press_0" ? "n7" : name === "move" ? "ask_planner" : undefined)); // only the first key is found
    await runScreens(SIM_HAND, intent, { ask: jev.ask, llm, sleep: async () => {}, settleMs: 0, screenshot: async () => new Uint8Array(), approve: async () => true, observe: async () => pad.look(),
      perform: async (_hand, action: ScreenAction) => { if (action.kind === "click") pad.press(action.target.name); } }, { maxPlans: 0 });
    expect(pad.pressed).toEqual([]);
  });
});

describe("approval", () => {
  test("a batch verifies its completed draft before using the user's existing send permission", async () => {
    const world = new World(); world.open("https://mail.google.com/mail/?view=cm");
    const jev = fakeJev((name, _q, state) => {
      const sending = state.action?.startsWith('click button "Send"');
      if (name === "irreversible") return sending ? 0.99 : 0;
      if (name === "authorized") return !sending || Object.values(EMAIL.inputs).every((value) => state.observation.fields.some((field: any) => field.value === value)) ? 0.99 : 0;
      if (name === "goal_met") return world.gmail.sent.length ? 0.99 : 0;
      if (name.startsWith("fill_")) return { to: "recipient", subject: "subject", body: "body" }[world.keyOf(name.slice(5))!];
      if (name === "next_0" && world.gmail.compose) return idOf(world, "send");
      return undefined;
    });
    // A backend may keep a structural fingerprint while field values change.
    const result = await runScreens(SIM_HAND, EMAIL, { ask: jev.ask, llm, sleep: async () => {}, observe: async () => ({ ...world.look(), fingerprint: "unchanged-structure" }),
      authorization: () => `Send one email to ${EMAIL.inputs.recipient} with subject "${EMAIL.inputs.subject}" and body "${EMAIL.inputs.body}".`,
      approve: async () => { throw new Error("The exact send was already requested"); },
      perform: async (_hand, action) => world.act(action, describeScreenAction(action)) });
    expect(result.status).toBe("done");
    expect(world.gmail.sent).toEqual([{ to: [EMAIL.inputs.recipient!], subject: EMAIL.inputs.subject!, body: EMAIL.inputs.body!, account: "chi@example.com" }]);
    const sendChecks = jev.gates().filter((call) => call.state.action.startsWith('click button "Send"'));
    expect(sendChecks).toHaveLength(2); // Initial empty form, then actual fields after filling.
    expect(sendChecks[0]!.state.observation.fields.every((field: any) => !field.value)).toBe(true);
    expect(sendChecks[1]!.state.observation.fields.filter((field: any) => field.name !== "Search mail").map((field: any) => field.value)).toEqual(Object.values(EMAIL.inputs));
    expect(result.steps.at(-1)!.risk).toBe(0.99);
  });

  test("a raw correction between batch inputs invalidates the remaining actions before the parsed goal changes", async () => {
    const world = new World(); world.open("https://mail.google.com/mail/?view=cm");
    const to = idOf(world, "to"), send = idOf(world, "send");
    let authorization = "Send the requested email to Sam";
    const jev = fakeJev((name, _q, state) => {
      if (name === "irreversible") return state.action.startsWith('click button "Send"') ? 0.99 : 0;
      return { [`fill_${to}`]: "recipient", next_0: send, authorized: 0.99 }[name];
    });
    const result = await runScreens(SIM_HAND, EMAIL, { ask: jev.ask, llm, sleep: async () => {}, observe: async () => world.look(), authorization: () => authorization,
      approve: async () => { throw new Error("A stale batch must not reach approval"); },
      perform: async (_hand, action) => { world.act(action, describeScreenAction(action)); authorization = "Do not send. Keep this as a draft."; } }, { maxSteps: 1 });
    expect(result.status).toBe("out_of_steps");
    expect(world.acted).toHaveLength(1);
    expect(world.gmail.sent).toEqual([]);
  });

  test("the full body reaches the gate and approval while history keeps its short preview", async () => {
    const world = new World(); world.open("https://mail.google.com/mail/?view=cm");
    const body = `${"A harmless draft sentence. ".repeat(6)}\nSynthetic credential: example-secret-for-test-only  `;
    const writing: Intent = { ...EMAIL, goal: "Prepare the requested draft", inputs: { body }, avoid: ["Do not expose credentials"] };
    const bodyId = idOf(world, "body");
    const jev = fakeJev((name, _q, state) => {
      if (name === "handles_secret") return state.action.includes("example-secret-for-test-only") ? 0.99 : 0;
      return name === `fill_${bodyId}` ? "body" : undefined;
    });
    const approvals: string[] = [];
    const result = await runScreens(SIM_HAND, writing, { ask: jev.ask, llm, observe: async () => world.look(), sleep: async () => {},
      perform: async (_hand, action) => world.act(action, describeScreenAction(action)),
      approve: async ({ action }) => { approvals.push(action); return false; } });
    const gate = jev.gates()[0]!.state;
    expect(gate).toMatchObject({ goal: writing.goal, avoid: writing.avoid });
    expect(gate.action).toContain(JSON.stringify(body));
    expect(gate.action).toContain('into text field "Message Body"');
    expect(approvals).toEqual([gate.action]);
    expect(result.status).toBe("denied");
    expect(result.steps[0]!.did).not.toContain("example-secret-for-test-only");
    expect(world.acted).toEqual([]);
  });

  test("a recipient correction during the gates replaces the proposal before asking for approval", async () => {
    const world = new World(); world.open("https://mail.google.com/mail/?view=cm");
    const to = idOf(world, "to");
    let current: Intent = { ...EMAIL, goal: "Prepare a message to the original recipient", inputs: { recipient: "original@example.test" } };
    let corrected = false;
    const jev = fakeJev((name) => {
      if (name === "irreversible") {
        if (!corrected) {
          corrected = true;
          current = { ...current, goal: "Prepare the message only to the corrected recipient", inputs: { recipient: "corrected@example.test" }, avoid: ["Do not use the original recipient"] };
        }
        return 0.9;
      }
      return name === `fill_${to}` ? "recipient" : undefined;
    });
    const approvals: string[] = [];
    const result = await runScreens(SIM_HAND, () => current, { ask: jev.ask, llm, observe: async () => world.look(), sleep: async () => {},
      perform: async (_hand, action) => world.act(action, describeScreenAction(action)),
      approve: async ({ action }) => { approvals.push(action); return false; } }, { maxSteps: 3 });
    expect(jev.gates()).toHaveLength(2);
    const latestGate = jev.gates()[1]!.state;
    expect(latestGate).toMatchObject({ goal: current.goal, avoid: current.avoid });
    expect(latestGate.action).toContain("corrected@example.test");
    expect(approvals).toEqual([latestGate.action]);
    expect(result.status).toBe("denied");
    expect(world.acted).toEqual([]);
  });

  test("a correction after the first batch input prevents approval of its remaining Send action", async () => {
    const world = new World(); world.open("https://mail.google.com/mail/?view=cm");
    const to = idOf(world, "to"), send = idOf(world, "send");
    let current = EMAIL;
    const jev = fakeJev((name, _q, state) => {
      if (name === "irreversible") return state.action.startsWith('click button "Send"') ? 0.9 : 0;
      return { [`fill_${to}`]: "recipient", next_0: send }[name];
    });
    const approvals: string[] = [];
    const result = await runScreens(SIM_HAND, () => current, { ask: jev.ask, llm, observe: async () => world.look(), sleep: async () => {},
      perform: async (_hand, action) => { world.act(action, describeScreenAction(action)); current = { ...EMAIL, goal: "Keep the email as a draft", avoid: ["Do not send"] }; },
      approve: async ({ action }) => { approvals.push(action); return true; } }, { maxSteps: 1 });
    expect(jev.gates()).toHaveLength(2);
    expect(world.acted).toHaveLength(1);
    expect(world.gmail.sent).toEqual([]);
    expect(approvals).toEqual([]);
    expect(result.status).toBe("out_of_steps");
  });

  test("cancellation during a gate prevents even a stale approval prompt", async () => {
    const world = new World(); world.open("https://mail.google.com/mail/?view=cm");
    const abort = new AbortController(), approvals: string[] = [];
    const jev = fakeJev((name) => {
      if (name === "irreversible") { abort.abort(); return 0.9; }
      return { move: "click", target_0: idOf(world, "send") }[name];
    });
    const result = await runScreens(SIM_HAND, EMAIL, { ask: jev.ask, llm, observe: async () => world.look(), sleep: async () => {},
      perform: async (_hand, action) => world.act(action, describeScreenAction(action)),
      approve: async ({ action }) => { approvals.push(action); return true; } }, { signal: abort.signal });
    expect(result.status).toBe("cancelled");
    expect(approvals).toEqual([]);
    expect(world.acted).toEqual([]);
  });

  test.each(["approval", "confirmation look"])("speech restarting during %s expires approval before Send", async (startsAt) => {
    const world = new World(); world.open(`https://mail.google.com/mail/?${new URLSearchParams({ view: "cm", to: EMAIL.inputs.recipient!, su: EMAIL.inputs.subject!, body: EMAIL.inputs.body! })}`);
    const speech = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
    let speaking = false, asked = 0, looks = 0;
    const jev = fakeJev((name, _q, state) => {
      if (name === "irreversible") return 0.9;
      if (name === "goal_met") return world.gmail.sent.length ? 0.95 : 0;
      return { move: "click", target_0: world.gmail.compose ? idOf(world, "send") : "none_of_these" }[name];
    });
    const run = runScreens(SIM_HAND, EMAIL, { ask: jev.ask, llm, sleep: async () => {},
      observe: async () => { if (++looks === 2 && startsAt === "confirmation look") speaking = true; return world.look(); },
      perform: async (_hand, action) => world.act(action, describeScreenAction(action)),
      approve: async () => { if (++asked === 1 && startsAt === "approval") speaking = true; return true; } },
    { maxSteps: 3, settles: () => { if (!speaking) return null; held.resolve(); return speech.promise; } });
    const paused = await Promise.race([held.promise.then(() => true), run.then(() => false)]);
    try {
      expect(paused).toBe(true);
      expect(world.acted).toEqual([]);
      expect(asked).toBe(1);
    } finally { speaking = false; speech.resolve(); }
    expect((await run).status).toBe("done");
    expect(asked).toBe(2);
    expect(world.gmail.sent).toHaveLength(1);
    expect(jev.gates()).toHaveLength(2);
  });

  test("an approval is spent if the screen moved on while the user was deciding: Jev looks again instead of acting on it", async () => {
    const world = new World(); world.open(`https://mail.google.com/mail/?${new URLSearchParams({ view: "cm", to: EMAIL.inputs.recipient!, su: EMAIL.inputs.subject!, body: EMAIL.inputs.body! })}`);
    let asked = 0;
    const jev = fakeJev((name, _q, state) => {
      if (name === "irreversible") return /click button "Send"/.test(state.action) ? 0.9 : 0.02;
      if (name === "goal_met") return world.gmail.sent.length ? 0.95 : 0;
      if (name === "move") return "click";
      if (name === "target_0" || name === "next_0") return world.gmail.compose ? idOf(world, "send") : undefined;
      return undefined;
    });
    const result = await runScreens(SIM_HAND, EMAIL, { ask: jev.ask, llm, sleep: async () => {}, settleMs: 0, screenshot: async () => new Uint8Array(), observe: async () => world.look(),
      perform: async (_hand, action: ScreenAction) => world.act(action, describeScreenAction(action)),
      // While the first approval is pending, the page changes under it (the subject is edited).
      approve: async () => { if (++asked === 1) world.act({ kind: "type", target: world.look().elements.find((el) => el.name === "Subject")!, input: "subject", text: "Changed meanwhile", submit: false }, ""); return true; } });
    expect(asked).toBe(2); // asked again, about the screen as it now is
    expect(result.status).toBe("done");
    expect(world.gmail.sent).toHaveLength(1);
  });
});
