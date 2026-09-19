import { describe, expect, test } from "bun:test";
import { actionCandidates, decideActions, decideCompact, decideScores } from "./contracts";
import { decide, describeAction, runIntent } from "./cua";
import { EVAL_HAND, FIXTURES, element, type Fixture } from "./eval-fixtures";
import { percentile, shuffle, summarize, type Row } from "./eval";
import { assertContract, type Ask, type Questions } from "./jev";

const noWriter = async (): Promise<never> => { throw new Error("Unexpected writer call"); };

function fakeAsk(pick: (name: string, q: Questions[string], state: any) => string | number) {
  const calls: { state: any; questions: Questions }[] = [];
  const ask: Ask = async (state, questions) => {
    calls.push({ state, questions });
    const answers = Object.fromEntries(Object.entries(questions).map(([name, q]) => {
      const selected = pick(name, q, state);
      return [name, q.type === "noul" ? { type: "noul", noul: Number(selected) } : { type: "choice", choice: String(selected), confidence: .95, probabilities: Object.fromEntries(Object.keys(q.type === "choice" ? q.criteria : {}).map((id) => [id, id === selected ? .95 : 0])) }];
    }));
    assertContract(questions, answers);
    return answers as never;
  };
  return { ask, calls };
}

describe("decision contracts", () => {
  test("text-only completion is judged by Jev, while a completely unreadable screen still escalates", async () => {
    const f = FIXTURES.find((f) => f.id === "read-only-complete")!;
    const fake = fakeAsk((name, q) => name === "goal_met" ? .98 : q.type === "noul" ? 0 : name === "move" ? "done" : Object.keys(q.type === "choice" ? q.criteria : {})[0]!);
    expect(await decide({ ask: fake.ask, llm: noWriter }, EVAL_HAND, f.intent, f.observation, { history: [], plan: null })).toEqual({ kind: "done" });
    expect(fake.calls).toHaveLength(1);
    expect((await decide({ ask: fake.ask, llm: noWriter }, EVAL_HAND, f.intent, { ...f.observation, texts: [] }, { history: [], plan: null })).kind).toBe("escalate");
    expect(fake.calls).toHaveLength(1);
  });

  test("loading without controls can wait and observe again instead of invoking the planner", async () => {
    const f = FIXTURES.find((f) => f.id === "loading")!;
    const fake = fakeAsk((name, q) => q.type === "noul" ? 0 : name === "move" ? "wait" : Object.keys(q.type === "choice" ? q.criteria : {})[0]!);
    expect(await decide({ ask: fake.ask, llm: noWriter }, EVAL_HAND, f.intent, f.observation, { history: [], plan: null })).toEqual({ kind: "act", action: { kind: "wait" } });
  });

  test("the action check retains a target's scope when identical button names occur", () => {
    expect(describeAction({ kind: "click", target: element("e1", "Save", "button", { within: "Notifications" }), button: "left", count: 1 })).toContain('button "Save" in "Notifications"');
  });

  test("compact questions resolve IDs in the shared state without duplicating labels", async () => {
    const f = FIXTURES.find((f) => f.id === "wiki-empty")!;
    const fake = fakeAsk((name, q) => q.type === "noul" ? name === "submit" ? .9 : 0 : ({ move: "type", field: "e1", input: "search_query", target: "e1", key: "Return", direction: "down" })[name] ?? Object.keys(q.type === "choice" ? q.criteria : {})[0]!);
    const result = await decideCompact({ ask: fake.ask, llm: noWriter }, EVAL_HAND, f.intent, f.observation, { history: [], plan: null });
    expect(result).toMatchObject({ kind: "act", action: { kind: "type", target: { id: "e1" }, text: "capybaras", submit: true } });
    expect(fake.calls[0]!.state.screen.elements.e1).toContain("Search Wikipedia");
    expect(fake.calls[0]!.questions.target).toMatchObject({ criteria: { e1: null } });
  });

  test("a complete choice binds the exact input and destination even when field order differs", async () => {
    const f = FIXTURES.find((f) => f.id === "holdout-flight")!;
    const candidates = actionCandidates(f.intent, f.observation)!;
    const wanted = [...candidates].find(([, c]) => c.action?.kind === "type" && c.action.input === "origin" && c.action.target?.id === "e2" && !c.action.submit)![0];
    const fake = fakeAsk((name) => name === "action" ? wanted : 0);
    expect(await decideActions({ ask: fake.ask, llm: noWriter }, EVAL_HAND, f.intent, f.observation, { history: [], plan: null })).toMatchObject({ kind: "act", action: { kind: "type", target: { id: "e2" }, text: "Tokyo", submit: false } });
  });

  test("candidate overflow preserves coverage by falling back instead of truncating actions", async () => {
    const f = FIXTURES.find((f) => f.id === "wiki-empty")!;
    const observation = { ...f.observation, elements: Array.from({ length: 150 }, (_, i) => element(`e${i + 1}`, `Field ${i}`, "text field")) };
    expect(actionCandidates(f.intent, observation)).toBeNull();
    const fake = fakeAsk((name, q) => q.type === "noul" ? name === "goal_met" ? .9 : 0 : Object.keys(q.type === "choice" ? q.criteria : {})[0]!);
    expect(await decideActions({ ask: fake.ask, llm: noWriter }, EVAL_HAND, f.intent, observation, { history: [], plan: null })).toEqual({ kind: "done" });
    expect(fake.calls[0]!.questions).toHaveProperty("move");
    expect(Object.keys((fake.calls[0]!.questions.target as any).criteria)).toHaveLength(151);
  });

  test("the real control loop uses the injected decider and retains its independent action check", async () => {
    const f = FIXTURES.find((f) => f.id === "wiki-empty")!;
    const gate = fakeAsk(() => 0);
    let decisions = 0, actions = 0;
    const result = await runIntent(EVAL_HAND, f.intent, {
      ask: gate.ask, llm: noWriter, approve: async () => false, observe: async () => f.observation, sleep: async () => {},
      decide: async () => ++decisions === 1 ? { kind: "act", action: { kind: "key", combo: "Return" } } : { kind: "done" },
      perform: async () => { actions++; },
    });
    expect(result.status).toBe("done"); expect(actions).toBe(1);
    expect(gate.calls).toHaveLength(1);
    expect(gate.calls[0]!.questions).toHaveProperty("irreversible");
  });
});

describe("eval accounting", () => {
  test("failure latency and failed cases remain in the denominators", () => {
    const base: Row = { suite: "test", strategy: "s", case: "c", category: "c", split: "test", round: 0, ok: true, direct: true, ms: 300, decisionMs: 300, gateMs: 0, handoff: false, unnecessaryHandoff: false, wrongAction: false, falseAllow: false, expected: [], calls: [] };
    const report = summarize([base, { ...base, ok: false, direct: false, ms: 10_000, decisionMs: 10_000, error: "timeout" }])[0]!;
    expect(report.n).toBe(2); expect(report.correct).toBe(1); expect(report.errors).toBe(1); expect(report.decisionP95Ms).toBe(10_000);
    expect(percentile([], .5)).toBeNull();
  });

  test("interleaving is repeatable and keeps every trial", () => {
    const values = Array.from({ length: 30 }, (_, i) => i);
    expect(shuffle(values, 42)).toEqual(shuffle(values, 42));
    expect(shuffle(values, 42)).not.toEqual(values);
    expect(shuffle(values, 42).toSorted((a, b) => a - b)).toEqual(values);
  });
});
