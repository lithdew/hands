import { describe, expect, test } from "bun:test";
import { assertContract, choice, ContractError, createJev, MAX_CHOICES, noul, score } from "./jev";

/** A fetch that records the request and replies with canned answers. */
function fakeFetch(answers: unknown, status = 200) {
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return Response.json({ model: "jev-latest", answers, usage: { input_tokens: 1, output_tokens: 0 } }, { status });
  };
  return { fetch, calls };
}

const questions = {
  move: choice("What next?", { click: "Click something", wait: "Do nothing" }),
  risky: noul("The action is risky"),
};

describe("assertContract", () => {
  test("accepts answers that match their questions", () => {
    expect(() =>
      assertContract(questions, {
        move: { type: "choice", choice: "click", confidence: 0.9, probabilities: { click: 0.9, wait: 0.1 } },
        risky: { type: "noul", noul: 0.02 },
      }),
    ).not.toThrow();
  });

  test("rejects a label that was never offered", () => {
    expect(() =>
      assertContract(questions, {
        move: { type: "choice", choice: "format_disk", confidence: 0.99, probabilities: {} },
        risky: { type: "noul", noul: 0 },
      }),
    ).toThrow(ContractError);
  });

  test("rejects an inherited property name as a label", () => {
    expect(() =>
      assertContract(questions, {
        move: { type: "choice", choice: "toString", confidence: 0.9, probabilities: {} },
        risky: { type: "noul", noul: 0 },
      }),
    ).toThrow(/not one of the offered labels/);
  });

  test("rejects a missing answer", () => {
    expect(() => assertContract(questions, { risky: { type: "noul", noul: 0.1 } })).toThrow(/"move"/);
  });

  test("rejects an answer of another type", () => {
    expect(() =>
      assertContract(questions, { move: { type: "noul", noul: 0.5 }, risky: { type: "noul", noul: 0.5 } }),
    ).toThrow(/expected a choice answer/);
  });

  test("rejects a probability outside 0..1", () => {
    expect(() =>
      assertContract(
        { risky: noul("x") },
        { risky: { type: "noul", noul: 1.2 } },
      ),
    ).toThrow(/not within 0..1/);
  });

  test("rejects a score that is not a number", () => {
    expect(() =>
      assertContract({ s: score("x", ["low", "high"]) }, { s: { type: "score", score: "high" } }),
    ).toThrow(/score is not a number/);
  });
});

describe("createJev", () => {
  test("posts state and questions to /v1/systemone with the key", async () => {
    const { fetch, calls } = fakeFetch({
      move: { type: "choice", choice: "wait", confidence: 0.8, probabilities: { click: 0.2, wait: 0.8 } },
      risky: { type: "noul", noul: 0.1 },
    });
    const ask = createJev({ apiKey: "sk-test", fetch });
    const answers = await ask({ goal: "open the settings" }, questions);

    expect(answers.move.choice).toBe("wait");
    expect(answers.risky.noul).toBe(0.1);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer sk-test");
    expect(calls[0]!.body.model).toBe("jev-latest");
    expect(calls[0]!.body.state).toEqual({ goal: "open the settings" });
    expect(calls[0]!.body.questions.move).toEqual({
      type: "choice",
      instructions: "What next?",
      criteria: { click: "Click something", wait: "Do nothing" },
    });
    expect(calls[0]!.body.questions.risky.type).toBe("noul");
  });

  test("throws when the server answers outside the offered labels", async () => {
    const { fetch } = fakeFetch({
      move: { type: "choice", choice: "rm_rf", confidence: 1, probabilities: {} },
      risky: { type: "noul", noul: 0 },
    });
    const ask = createJev({ apiKey: "sk-test", fetch });
    await expect(ask("state", questions)).rejects.toThrow(ContractError);
  });

  test("refuses more labels than a Choice can take, before any request", async () => {
    const { fetch, calls } = fakeFetch({});
    const ask = createJev({ apiKey: "sk-test", fetch });
    const many = Object.fromEntries(Array.from({ length: MAX_CHOICES + 1 }, (_, i) => [`e${i}`, "x"]));
    await expect(ask("state", { target: choice("Which?", many) })).rejects.toThrow(/the limit is 255/);
    expect(calls).toHaveLength(0);
  });
});
