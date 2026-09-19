import { describe, expect, test } from "bun:test";
import type { Intent } from "./intent";
import { assertContract, type Ask } from "./jev";
import { generalise, learnedIntent, memoryStore, type Learned } from "./learned";
import type { Llm, LlmRequest } from "./openai";
import { createPilot } from "./pilot";
import { NotBrowserWork, planTasks, toPlannedTask } from "./plan";
import { describeScreenAction, runScreens, type ScreenAction } from "./screen";
import { SIM_HAND, World } from "./sim";

const TODAY = new Date(2026, 8, 19, 12);
const CONTACTS = [{ name: "Sam Rivera", email: "sam.rivera@example.com" }, { name: "Dana Whitfield", email: "dana.w@example.com" }, { name: "Mom" }];
const ctx = { today: TODAY, contacts: CONTACTS };

type Script = (name: string, question: any, state: any) => string | number | undefined;

/** A scripted Jev. Unscripted choices decline (keep, none, not said, other) or take the first label; unscripted nouls say no. */
function fakeJev(script: Script) {
  const calls: { state: any; questions: Record<string, any> }[] = [];
  const ask: Ask = async (state, questions) => {
    calls.push({ state, questions });
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(questions) as [string, any][]) {
      const r = script(name, q, state);
      if (q.type === "noul") { answers[name] = { type: "noul", noul: typeof r === "number" ? r : 0 }; continue; }
      const fallback = ["keep_as_is", "none_of_these", "other", "not_said", "nothing_to_type", "no_site"].find((l) => Object.hasOwn(q.criteria, l)) ?? Object.keys(q.criteria)[0]!;
      const pick = typeof r === "string" ? r : fallback;
      answers[name] = { type: "choice", choice: pick, confidence: 0.9, probabilities: { [pick]: 0.9 } };
    }
    assertContract(questions, answers);
    return answers as never;
  };
  return { ask, calls };
}

function fakeLlm(replies: Record<string, unknown>) {
  const calls: LlmRequest[] = [];
  const llm: Llm = async (req) => { calls.push(req); if (!(req.schema.name in replies)) throw new Error(`unexpected LLM call: ${req.schema.name}`); return replies[req.schema.name]; };
  return { llm, calls };
}

const NOTE_PLAN = { goal: "Add a note titled Lisbon trip that says book the airport transfer.", url: "https://keep.google.com/", facts: [], done_when: "The note shows in the list.", avoid: [], wants_answer: false,
  inputs: [{ name: "Note Title", value: "Lisbon trip" }, { name: "note_text", value: "book the airport transfer" }], steps: ["Click 'Take a note…'.", "Type note_title into 'Title'.", "Type note_text into 'Note'.", "Click 'Close'."] };

describe("toPlannedTask", () => {
  test("a contact's address is filled in by code, plain in an input and encoded in a url, even when the model encoded the placeholder", () => {
    const task = toPlannedTask({ ...NOTE_PLAN, url: "https://mail.google.com/mail/?view=cm&to={email:Sam Rivera}%2C%7Bemail%3ADana%20Whitfield%7D", inputs: [{ name: "recipients", value: "{email:sam rivera}" }] }, ctx);
    expect(task.intent.url).toBe("https://mail.google.com/mail/?view=cm&to=sam.rivera%40example.com%2Cdana.w%40example.com");
    expect(task.intent.inputs).toEqual({ recipients: "sam.rivera@example.com" });
  });

  test("the model never hands us an address of its own, a command, or an unbounded plan", () => {
    expect(() => toPlannedTask({ ...NOTE_PLAN, url: "https://mail.google.com/?to={email:Bob}" }, ctx)).toThrow(/not a contact/);
    expect(() => toPlannedTask({ ...NOTE_PLAN, url: "{email:Mom}" }, ctx)).toThrow(/not a contact with one/); // a contact without an address
    expect(() => toPlannedTask({ ...NOTE_PLAN, url: "javascript:alert(1)" }, ctx)).toThrow(/http/);
    expect(() => toPlannedTask({ ...NOTE_PLAN, url: "" }, ctx)).toThrow(/no start url/);
    const long = toPlannedTask({ ...NOTE_PLAN, steps: Array.from({ length: 20 }, (_, i) => `step ${i}`), facts: Array.from({ length: 20 }, (_, i) => `fact: ${i}`) }, ctx);
    expect(long.intent.steps).toHaveLength(8);
    expect(long.intent.facts).toHaveLength(8);
    expect(Object.keys(long.intent.inputs)).toEqual(["note_title", "note_text"]); // names become Choice labels
  });

  test("planTasks keeps the order of several tasks and refuses an empty plan", async () => {
    const two = await planTasks(fakeLlm({ task_plan: { tasks: [{ ...NOTE_PLAN, url: "https://messages.google.com/web" }, NOTE_PLAN] } }).llm, "text mom and then make a note", ctx);
    expect(two.map((t) => URL.parse(t.intent.url!)!.host)).toEqual(["messages.google.com", "keep.google.com"]);
    await expect(planTasks(fakeLlm({ task_plan: { tasks: [] } }).llm, "hm", ctx)).rejects.toThrow(/no tasks/);
    await expect(planTasks(fakeLlm({ task_plan: { can_do: false, tasks: [] } }).llm, "rename the file on my desktop", ctx)).rejects.toBeInstanceOf(NotBrowserWork);
  });
});

const GENERAL = { reusable: true, shape: "Add a titled note in Google Keep", goal: "Add a note titled {note_title} that says {note_text}.", url: "https://keep.google.com/", done_when: "The note shows in the list.",
  steps: ["Click 'Take a note…'.", "Type note_title into 'Title'.", "Type note_text into 'Note'.", "Click 'Close'."], parts: [{ name: "note_title", what: "the title of the note" }, { name: "note_text", what: "what the note says" }] };
const SAID = "add a note titled Lisbon trip that says book the airport transfer";

describe("generalise", () => {
  const task = toPlannedTask(NOTE_PLAN, ctx);
  test("a plan whose every text was said becomes a template", async () => {
    const learned = (await generalise(fakeLlm({ general_plan: GENERAL }).llm, SAID, task))!;
    expect(learned.slots).toEqual([{ name: "note_title", what: "the title of the note" }, { name: "note_text", what: "what the note says" }]);
    expect(learned.goal).toBe("Add a note titled {note_title} that says {note_text}.");
  });

  test("whether a text was said is a string comparison, so no model is asked when one was not", async () => {
    const written = toPlannedTask({ ...NOTE_PLAN, inputs: [{ name: "body", value: "Hi Sam, a friendly reminder." }] }, ctx), none = fakeLlm({});
    expect(await generalise(none.llm, "email sam a reminder", written)).toBeNull();
    expect(none.calls).toHaveLength(0);
  });

  test("the model's word is not enough: stale dates, unknown placeholders and another site are refused", async () => {
    for (const bad of [{ goal: "Add a note on 2026-09-20 titled {note_title}" }, { steps: ["Set the time to 7:00 PM."] }, { goal: "Add {something_else}" }, { url: "https://evil.example/{note_title}" }, { reusable: false }, { parts: [] }]) {
      expect(await generalise(fakeLlm({ general_plan: { ...GENERAL, ...bad } }).llm, SAID, task)).toBeNull();
    }
  });
});

describe("learnedIntent", () => {
  const recipe: Learned = { shape: GENERAL.shape, goal: GENERAL.goal, url: "https://keep.google.com/#q={note_title}", steps: GENERAL.steps, doneWhen: GENERAL.done_when, avoid: [], slots: GENERAL.parts, uses: 0 };
  //            w1  w2 w3   w4     w5      w6   w7   w8    w9  w10     w11 w12 w13  w14
  const next = "add a note titled Packing that says bring the charger and the blue jacket";

  test("one request picks the shape and marks each part in what was said", async () => {
    const store = memoryStore([recipe]);
    const jev = fakeJev((name) => ({ shape: "r1", r1_covers: 0.9, r1_note_title_from: "w5", r1_note_title_to: "w5", r1_note_text_from: "w8", r1_note_text_to: "w14" })[name]);
    const got = (await learnedIntent(jev.ask, next, store))!;
    expect(jev.calls).toHaveLength(1);
    expect(got.intent.inputs).toEqual({ note_title: "Packing", note_text: "bring the charger and the blue jacket" });
    expect(got.intent.goal).toBe("Add a note titled Packing that says bring the charger and the blue jacket.");
    expect(got.intent.url).toBe("https://keep.google.com/#q=Packing");
    expect(store.all()[0]!.uses).toBe(1);
  });

  test("a shape that does not cover the whole request is not used, and an empty store asks nothing", async () => {
    const partly = fakeJev((name) => ({ shape: "r1", r1_covers: 0.2, r1_note_title_from: "w5", r1_note_title_to: "w5", r1_note_text_from: "w8", r1_note_text_to: "w14" })[name]);
    expect(await learnedIntent(partly.ask, `${next} and email it to Sam`, memoryStore([recipe]))).toBeNull();
    const idle = fakeJev(() => undefined);
    expect(await learnedIntent(idle.ask, next, memoryStore())).toBeNull();
    expect(idle.calls).toHaveLength(0);
  });
});

describe("createPilot", () => {
  function pilotFor(world: World, ask: Ask, llm: Llm, store = memoryStore()) {
    return createPilot({ ask, llm, contacts: CONTACTS, store, today: () => TODAY, sleep: async () => {}, settleMs: 0, screenshot: async () => new Uint8Array(), approve: async () => true,
      observe: async () => world.look(), perform: async (_hand, action: ScreenAction) => world.act(action, describeScreenAction(action)), open: async (_hand, url) => world.open(url) });
  }

  test("an everyday request is understood in one round of Jev and no LLM", async () => {
    //            w1   w2 w3  w4  w5    w6
    const said = "note to self buy oat milk";
    const jev = fakeJev((name) => ({ task: "make_note", note_from: "w4", note_to: "w6" })[name]);
    const understood = await pilotFor(new World(), jev.ask, fakeLlm({}).llm).understand(said);
    expect(understood.by).toBe("recipe");
    expect(understood.tasks[0]!.intent.inputs).toEqual({ note: "Buy oat milk." });
  });

  test("quick.ts is only trusted when Jev says the request is only a site to open or search", async () => {
    const world = new World(), plan = fakeLlm({ task_plan: { tasks: [NOTE_PLAN] } });
    const claims: Script = (name) => ({ launcher: "browser", site: "gmail", text: "sam" })[name]; // what quick.ts did with "email sam ..."
    expect((await pilotFor(world, fakeJev(claims).ask, plan.llm).understand("email sam the quarterly numbers as a chart")).by).toBe("plan");
    expect((await pilotFor(world, fakeJev((name) => (name === "simple" ? 0.9 : claims(name, null, null))).ask, plan.llm).understand("open gmail and search for sam")).by).toBe("quick");
    // "open calculator": quick.ts says nothing needs opening and "calculator" is to be typed. That is not a task for a browser.
    const noSite: Script = (name) => ({ launcher: "none", site: "no_site", text: "calculator", simple: 0.95 })[name];
    expect(await pilotFor(world, fakeJev(noSite).ask, plan.llm).read("open calculator")).toBeNull();
  });

  test("what no recipe covers is planned once, driven with the plan's steps, then learned for next time", async () => {
    const world = new World(), store = memoryStore(), model = fakeLlm({ task_plan: { tasks: [NOTE_PLAN] }, general_plan: GENERAL });
    const jev = fakeJev((name, _q, state) => {
      if (name === "goal_met") return world.keep.saved.length ? 0.95 : 0;
      if (name.startsWith("fill_")) return { title: "note_title", body: "note_text" }[world.keyOf(name.slice(5))!];
      const id = (key: string) => world.look().elements.find((el) => world.keyOf(el.id) === key)?.id;
      if (name === "move") return "click";
      if (name === "target_0") return id("take");
      if (name === "next_0") return id("close");
      return state && undefined;
    });
    const result = await pilotFor(world, jev.ask, model.llm, store).run(SIM_HAND, SAID);
    await result.learning;
    expect(result).toMatchObject({ by: "plan", status: "done" });
    expect(world.keep.saved).toEqual([{ title: "Lisbon trip", body: "book the airport transfer" }]);
    expect(jev.calls.find((c) => "move" in c.questions)!.state.plan.steps).toEqual(NOTE_PLAN.steps); // Jev was shown the plan
    expect(model.calls.map((c) => c.schema.name)).toEqual(["task_plan", "general_plan"]);
    expect(store.all().map((r) => r.shape)).toEqual(["Add a titled note in Google Keep"]);
  });
});

describe("facts", () => {
  test("nothing risky is done while the screen shows a different value than a fact, and the run gives up rather than commit", async () => {
    const world = new World(); world.open("https://www.opentable.com/s?term=Keens&covers=2&dateTime=2026-09-19T19:00");
    world.act({ kind: "click", target: world.look().elements.find((el) => el.name === "7:00 PM" && el.within === "Keens Steakhouse")!, button: "left", count: 1 }, "");
    const intent: Intent = { goal: "Reserve a table for 4", launcher: "browser", url: null, inputs: {}, doneWhen: "confirmed", avoid: [], facts: ["party size: 4 people"] };
    const complete = () => world.look().elements.find((el) => el.name === "Complete reservation")!.id;
    const jev = fakeJev((name) => ({ move: "click", target_0: complete(), next_0: complete(), differs_0: 0.9, irreversible: 0.9 })[name]);
    const approvals: string[] = [];
    const result = await runScreens(SIM_HAND, intent, { ask: jev.ask, llm: fakeLlm({}).llm, sleep: async () => {}, settleMs: 0, screenshot: async () => new Uint8Array(), observe: async () => world.look(),
      perform: async (_hand, action: ScreenAction) => world.act(action, describeScreenAction(action)), approve: async ({ action }) => { approvals.push(action); return true; } }, { maxPlans: 0 });
    expect(result.status).toBe("gave_up");
    expect(result.reason).toContain("party size: 4 people");
    expect(world.opentable.booked).toBeNull();
    expect(approvals).toHaveLength(0); // the user is not even asked to approve a wrong booking
  });
});
