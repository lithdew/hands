// jev.ts — typed decisions from Jev (TypeSafe's System One model).
//
// Jev reads text and answers closed questions. It cannot write a string or a
// coordinate, only pick from what we offer:
//
//   choice(instructions, {label: description})   one label, with confidence
//   noul(instructions)                           probability of "yes", 0..1
//   score(instructions, [level0, level1, ...])   position on a rubric
//
// The SDK types the answers from the questions at compile time. `createJev`
// adds the runtime half of that contract: an answer that is missing, of the
// wrong type, or a label we never offered throws a ContractError before any
// caller can act on it.
//
//   const ask = createJev();
//   const a = await ask(state, { go: noul("The light is green") });
//   a.go.noul
//
// CLI: bun jev/jev.ts models | ping
//
// Requires: TYPESAFE_API_KEY in .env.local

import {
  TypeSafeClient,
  APIError,
  type EntryType,
  type Questions,
  type SystemOneResult,
  type TypeSafeClientConfig,
  type RequestOptions,
} from "@typesafe-ai/sdk";
import { debugLog, rememberSecret } from "../desktop";

export { choice, noul, score } from "@typesafe-ai/sdk";
export type { ChoiceResponse, EntryType, NoulResponse, Questions } from "@typesafe-ai/sdk";

// ---------------------------------------------------------------- types

export type Answers<Q extends Questions> = SystemOneResult<Q>["answers"];

/** Ask Jev a set of independent questions about `state`. Tests replace this with a fake. */
export type Ask = <const Q extends Questions>(state: EntryType, questions: Q, options?: RequestOptions) => Promise<Answers<Q>>;

/** Jev answered outside the contract we gave it. Never act on the answer. */
export class ContractError extends Error {}

// ---------------------------------------------------------------- config

/** A Choice question takes at most this many labels. */
export const MAX_CHOICES = 255;

// ---------------------------------------------------------------- contract

/** Throws unless every question has an answer of its own type, within its own labels. */
export function assertContract<Q extends Questions>(questions: Q, answers: unknown): asserts answers is Answers<Q> {
  if (typeof answers !== "object" || answers === null) throw new ContractError("Jev returned no answers");
  for (const [name, question] of Object.entries(questions)) {
    const answer = (answers as Record<string, unknown>)[name] as Record<string, unknown> | undefined;
    if (!answer || answer.type !== question.type) {
      throw new ContractError(`"${name}": expected a ${question.type} answer`);
    }
    if (question.type === "noul") {
      if (!isProbability(answer.noul)) throw new ContractError(`"${name}": noul is not within 0..1`);
    } else if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) {
        throw new ContractError(`"${name}": the selected choice is not one of the offered labels`);
      }
      if (!isProbability(answer.confidence)) throw new ContractError(`"${name}": confidence is not within 0..1`);
    } else if (typeof answer.score !== "number" || !Number.isFinite(answer.score)) {
      throw new ContractError(`"${name}": score is not a number`);
    }
  }
}

function isProbability(n: unknown): n is number {
  return typeof n === "number" && n >= 0 && n <= 1;
}

// ---------------------------------------------------------------- client

/** `config.fetch` is the seam for tests, like `exec` in desktop.ts. */
export function createJev(config: TypeSafeClientConfig = {}): Ask {
  const apiKey = (config.apiKey ?? jevApiKey())?.trim();
  rememberSecret(apiKey);
  if (!apiKey) throw new Error("Set TYPESAFE_API_KEY (or JEV) in .env to enable Jev.");
  const client = new TypeSafeClient({ defaultModel: process.env.JEV_MODEL, retry: { maxRetries: 0 }, logLevel: "off", ...config, apiKey });
  return async (state, questions, options) => {
    for (const [name, q] of Object.entries(questions)) {
      if (q.type === "choice" && Object.keys(q.criteria).length > MAX_CHOICES) {
        throw new ContractError(`"${name}": ${Object.keys(q.criteria).length} labels, the limit is ${MAX_CHOICES}`);
      }
    }
    let answers: unknown;
    const started = performance.now();
    try {
      ({ answers } = await client.systemOne({ state, questions }, options));
    } catch (error) {
      debugLog("jev.error", { ms: Math.round(performance.now() - started), error: error instanceof Error ? error.message : "Request failed" });
      // Server bodies and connection errors can echo credentials. Keep them out
      // of both the control panel and CLI logs; one request has a bounded timeout.
      if (error instanceof APIError) throw new Error(`Jev request failed (HTTP ${error.status}).`);
      throw new Error(options?.signal?.aborted ? "Jev request cancelled." : "Jev is unavailable or timed out.");
    }
    debugLog("jev.answers", { ms: Math.round(performance.now() - started), answers });
    assertContract(questions, answers);
    return answers;
  };
}

export function jevApiKey(): string | undefined {
  return process.env.TYPESAFE_API_KEY?.trim() || process.env.JEV_API_KEY?.trim() || process.env.JEV?.trim() || process.env.jev_key?.trim();
}

// ---------------------------------------------------------------- CLI

async function main(argv: string[]) {
  const { noul } = await import("@typesafe-ai/sdk");
  switch (argv[0]) {
    case "models": {
      for (const m of await new TypeSafeClient({ apiKey: jevApiKey(), logLevel: "off" }).models.list()) console.log(`${m.name}\t${m.description}`);
      return;
    }
    case "ping": {
      const started = performance.now();
      const a = await createJev()("The sky is blue.", { blue: noul("The text says the sky is blue") });
      console.log(`noul ${a.blue.noul.toFixed(3)} in ${Math.round(performance.now() - started)} ms`);
      return;
    }
    default:
      console.log(
        ["usage: bun jev/jev.ts <command>", "  models   list models the key can use", "  ping     one noul round trip"].join(
          "\n",
        ),
      );
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
