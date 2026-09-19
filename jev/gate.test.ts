import { describe, expect, test } from "bun:test";
import { assessRisk, needsApproval, RISK_FLAGS, terminalApprove, type Risk } from "./gate";
import { assertContract, type Ask } from "./jev";

/** Answers each risk question with the given probability (0 when not listed). */
function fakeAsk(nouls: Partial<Record<(typeof RISK_FLAGS)[number], number>>) {
  const calls: { state: any; questions: any }[] = [];
  const ask: Ask = async (state, questions) => {
    calls.push({ state, questions });
    const answers = Object.fromEntries(
      Object.keys(questions).map((name) => [name, { type: "noul", noul: (nouls as Record<string, number>)[name] ?? 0 }]),
    );
    assertContract(questions, answers);
    return answers;
  };
  return { ask, calls };
}

const ctx = { goal: "Email Sam that I am late.", avoid: ["do not cc anyone"], action: 'click button "Send"' };

describe("assessRisk", () => {
  test("asks every flag in one request and reports the worst", async () => {
    const { ask, calls } = fakeAsk({ irreversible: 0.93, off_goal: 0.04 });
    const risk = await assessRisk(ask, ctx);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.questions).sort()).toEqual([...RISK_FLAGS].sort());
    expect(risk.worst).toBe("irreversible");
    expect(risk.level).toBe(0.93);
    expect(risk.flags.off_goal).toBe(0.04);
  });

  test("judges the goal and the action only, never text read off the screen", async () => {
    const { ask, calls } = fakeAsk({});
    await assessRisk(ask, ctx);
    expect(calls[0]!.state).toEqual({ goal: ctx.goal, avoid: ctx.avoid, action: ctx.action });
  });
});

describe("needsApproval", () => {
  const risk = (level: number): Risk => ({ level, worst: "irreversible", flags: {} as Risk["flags"] });

  test("pauses at and above the threshold", () => {
    expect(needsApproval(risk(0.49), 0.5)).toBe(false);
    expect(needsApproval(risk(0.5), 0.5)).toBe(true);
    expect(needsApproval(risk(0.99), 0.5)).toBe(true);
  });

  test("invalid thresholds and risk scores cannot disable approval", () => {
    for (const value of [NaN, Infinity, -1, 1.01]) {
      expect(needsApproval(risk(0), value)).toBe(true);
      expect(needsApproval(risk(value), 0.5)).toBe(true);
    }
  });
});

describe("terminalApprove", () => {
  test("says no when there is no terminal to ask on", async () => {
    const saved = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      const risk: Risk = { level: 0.9, worst: "spends_money", flags: {} as Risk["flags"] };
      expect(await terminalApprove({ hand: 1, action: "click Buy", risk })).toBe(false);
    } finally {
      process.stdin.isTTY = saved;
    }
  });
});
