/**
 * Jev, asked many things at once. decide.ts asks the classifier one question a step; the Jev driver (pilot.ts,
 * screen.ts) asks a screen's worth in one request, because independent questions are answered in the time of one,
 * and sequential requests are what a task's time is made of.
 *
 * The SDK types the answers from the questions. `makeAsk` adds the runtime half: an answer that is missing, of
 * the wrong type, or a label nobody offered throws before any caller can act on it.
 */

import { APIError, type EntryType, type Questions, type RequestOptions, type SystemOneResult, TypeSafeClient } from "@typesafe-ai/sdk";

export { choice, noul } from "@typesafe-ai/sdk";
export type { ChoiceResponse, EntryType, NoulResponse, Questions } from "@typesafe-ai/sdk";

export type Answers<Q extends Questions> = SystemOneResult<Q>["answers"];
/** Ask Jev a set of independent questions about `state`. A test replaces this with a fake. */
export type Ask = <const Q extends Questions>(state: EntryType, questions: Q, options?: RequestOptions) => Promise<Answers<Q>>;

/** Jev answered outside the contract it was given. Never act on the answer. */
export class ContractError extends Error {}

export const MAX_CHOICES = 255; // TypeSafe Choice ceiling, as config.ts MAX_OPTIONS

const probability = (n: unknown): n is number => typeof n === "number" && n >= 0 && n <= 1;

/** Throws unless every question has an answer of its own type, within its own labels. */
export function assertContract<Q extends Questions>(questions: Q, answers: unknown): asserts answers is Answers<Q> {
  if (typeof answers !== "object" || answers === null) throw new ContractError("Jev returned no answers");
  for (const [name, question] of Object.entries(questions)) {
    const answer = (answers as Record<string, Record<string, unknown> | undefined>)[name];
    if (!answer || answer.type !== question.type) throw new ContractError(`"${name}": expected a ${question.type} answer`);
    if (question.type === "noul") {
      if (!probability(answer.noul)) throw new ContractError(`"${name}": noul is not within 0..1`);
    } else if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) throw new ContractError(`"${name}": the selected choice is not one of the offered labels`);
      if (!probability(answer.confidence)) throw new ContractError(`"${name}": confidence is not within 0..1`);
    } else if (typeof answer.score !== "number" || !Number.isFinite(answer.score)) throw new ContractError(`"${name}": score is not a number`);
  }
}

/** The same client runner.ts makes, behind the contract. */
export function makeAsk(client: Pick<TypeSafeClient, "systemOne"> = new TypeSafeClient({ logLevel: "off" })): Ask {
  return async (state, questions, options) => {
    for (const [name, q] of Object.entries(questions)) {
      const labels = q.type === "choice" ? Object.keys(q.criteria).length : 0;
      if (labels > MAX_CHOICES) throw new ContractError(`"${name}": ${labels} labels, the limit is ${MAX_CHOICES}`);
    }
    let answers: unknown;
    try {
      ({ answers } = await client.systemOne({ state, questions }, options));
    } catch (error) {
      // A server body or a connection error can echo the key, so neither is shown.
      if (error instanceof APIError) throw new Error(`Jev request failed (HTTP ${error.status})`);
      throw new Error(options?.signal?.aborted ? "Jev request cancelled" : "Jev is unavailable or timed out");
    }
    assertContract(questions, answers);
    return answers;
  };
}
