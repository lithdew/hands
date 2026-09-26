import { expect, test } from "bun:test";
import { APITimeoutError, AuthenticationError, TypeSafeClient } from "@typesafe-ai/sdk";
import { decided, jev as typesafe, NAMED, route, ROUTE_MS, SURE, THEIRS, WAY, WAYS } from "../src/route.ts";

// route.ts against a scripted TypeSafe client: what it asks, and what it makes of the answers. No call here reaches TypeSafe.

type Asked = { request: { state: Record<string, unknown>; questions: Record<string, { type: string; instructions?: unknown; criteria?: unknown }> }; options: unknown };

/** A client that answers every request with `reply`, or throws what it throws. */
function jev(reply: () => unknown) {
  const asked: Asked[] = [];
  const fake = {
    systemOne: (request: unknown, options: unknown) => {
      asked.push({ request, options } as Asked);
      return Promise.resolve().then(reply);
    },
  } as never;
  return { client: () => fake, asked };
}

const answers = (choice: string, confidence: number, theirs: number, named: number) => ({
  model: "jev-1.13.0",
  usage: { input_tokens: 300, output_tokens: 0 },
  answers: {
    way: { type: "choice", choice, confidence, probabilities: { web: choice === "web" ? confidence : 0.01, computer: choice === "computer" ? confidence : 0.01, both: choice === "both" ? confidence : 0.01 } },
    theirs: { type: "noul", noul: theirs },
    named: { type: "noul", noul: named },
  },
});

test("one request: the task, the user's words and the time as state; the way as a choice and two yes/no questions; 1.5 s and no retry", async () => {
  const { client, asked } = jev(() => answers("web", 0.98, 0.02, 0.01));
  const got = await route(client, "What is the weather in Hong Kong today?", " what's the weather ");
  expect(got).toMatchObject({ way: "web", why: "Jev chose web (0.98)" });
  expect(got.probabilities).toEqual({ web: 0.98, computer: 0.01, both: 0.01, confidence: 0.98, theirs: 0.02, named: 0.01 });
  expect(got.ms).toBeGreaterThanOrEqual(0);
  expect(asked.length).toBe(1);
  const { request, options } = asked[0]!;
  expect(request.state).toMatchObject({ request: "What is the weather in Hong Kong today?", user_words: "what's the weather" });
  expect(request.state.now).toMatchObject({ today: expect.any(String), local_time: expect.any(String) });
  expect(request.state.follows_a_lookup).toBeUndefined();
  expect(request.questions).toEqual({ way: { type: "choice", instructions: WAY, criteria: WAYS }, theirs: { type: "noul", instructions: THEIRS, criteria: undefined }, named: { type: "noul", instructions: NAMED, criteria: undefined } });
  expect(Object.keys(WAYS)).toEqual(["web", "computer", "both"]);
  expect(options).toEqual({ timeout: ROUTE_MS, retry: { maxRetries: 0 } });
  expect(ROUTE_MS).toBe(1500);
});

test("a task that follows a lookup carries it in the state; no words from the user is null", async () => {
  const { client, asked } = jev(() => answers("computer", 0.9, 0.1, 0.9));
  await route(client, "Open the first one", "", { question: "Best ramen in Central?", answer: "Ichiran and Butao.", sources: [{ title: "Guide", url: "https://example.com/" }] });
  expect(asked[0]!.request.state).toMatchObject({ request: "Open the first one", user_words: null, follows_a_lookup: { question: "Best ramen in Central?", answer: "Ichiran and Butao." } });
});

test("the rule: the user's own or a named app or site is a hand's; web or both only at 0.6 confidence or more; the computer when Jev says so", () => {
  const way = (choice: string, confidence: number) => ({ choice, confidence, probabilities: { [choice]: confidence } });
  expect(SURE).toBe(0.6);
  expect(decided(way("web", 0.99), 0.02, 0.01, 300)).toMatchObject({ way: "web", ms: 300 });
  expect(decided(way("both", 0.95), 0.4, 0.05, 300).way).toBe("both");
  expect(decided(way("web", 0.6), 0.5, 0.5, 300).way).toBe("web"); // at the lines, not past them
  expect(decided(way("web", 0.99), 0.51, 0.01, 300)).toMatchObject({ way: "computer", why: "it needs something of the user's own (0.51)" });
  expect(decided(way("both", 0.99), 0.93, 0.01, 300).way).toBe("computer"); // nothing of theirs goes into a search
  expect(decided(way("web", 0.78), 0.03, 0.95, 300)).toMatchObject({ way: "computer", why: "the user named an app or a site, or asked to be shown (0.95)" });
  expect(decided(way("web", 0.59), 0.02, 0.02, 300)).toMatchObject({ way: "computer", why: "Jev leaned to web, but not surely (0.59)" });
  expect(decided(way("computer", 0.97), 0.1, 0.1, 300)).toMatchObject({ way: "computer", why: "Jev chose the computer (0.97)" });
  expect(decided(way("something else", 0.99), 0.1, 0.1, 300).way).toBe("computer");
});

test("an error, a timeout or no key is a hand, never a throw, and says why", async () => {
  const failures: [() => unknown, string][] = [
    [() => { throw new APITimeoutError(1500); }, "Jev could not be asked: "],
    [() => { throw new AuthenticationError(401, { detail: "bad key" }, new Headers()); }, "Jev could not be asked: "],
    [() => { throw new Error("TYPESAFE_API_KEY is missing"); }, "Jev could not be asked: TYPESAFE_API_KEY is missing"],
    [() => ({ answers: {} }), "Jev could not be asked: "], // an answer without its questions
  ]; // prettier-ignore
  for (const [reply, why] of failures) {
    const got = await route(jev(reply).client, "open Paint", "open paint");
    expect(got).toMatchObject({ way: "computer", probabilities: {} });
    expect(got.why).toStartWith(why);
  }
});

test("with no TYPESAFE_API_KEY the client cannot be made at all, and that too is a hand, not a throw", async () => {
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    expect(() => new TypeSafeClient()).toThrow("No API key was provided"); // at once, not in a promise
    const got = await route(typesafe, "What is the weather in Hong Kong today?", "what's the weather"); // as live.ts asks: no test makes the client, so none is kept from one with a key
    expect(got).toMatchObject({ way: "computer", probabilities: {} });
    expect(got.why).toStartWith("Jev could not be asked: No API key was provided");
  } finally {
    if (key !== undefined) process.env.TYPESAFE_API_KEY = key;
  }
});
