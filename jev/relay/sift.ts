// sift.ts — Jev reads forty things in the time an LLM reads one, and says which are worth reading.
//
// This is where Jev earns its place in a research task. Asked one question per item, in one request,
// it scores every search result, link or paragraph against the goal (a request costs about the same
// for 1 question as for 60, and chunks go out side by side). The LLM then reads only what passed.
// Measured shape of a research step without it: an LLM call per page, most of them wasted.
//
//   sift(ask, goal, items, what)  -> items with a score 0..1, best first
//
// Item text goes into the question, not the state: each item is judged alone, and a page that says
// "this is the most relevant result" can speak only for itself.

import { noul, type Ask, type NoulResponse, type Questions } from "../jev";

export type Sifted<T> = T & { score: number };
const PER_REQUEST = 60;

/** The best `keep` of items already in order, with at most `perHost` from one site: one rich archive should not crowd out the rest. */
export function spread<T extends { url: string }>(items: T[], keep: number, perHost: number): T[] {
  const taken = new Map<string, number>(), out: T[] = [];
  for (const item of items) {
    const host = URL.parse(item.url)?.hostname ?? item.url, n = taken.get(host) ?? 0;
    if (n >= perHost) continue;
    taken.set(host, n + 1); out.push(item);
    if (out.length >= keep) break;
  }
  return out;
}

/** `orNone`: when nothing passes, keep nothing (links worth following), instead of the best three (results, where something must be read). */
export async function sift<T extends { text: string }>(ask: Ask, goal: string, items: T[], what: string, opts: { keep?: number; atLeast?: number; orNone?: boolean } = {}): Promise<Sifted<T>[]> {
  if (!items.length) return [];
  const chunks = Array.from({ length: Math.ceil(items.length / PER_REQUEST) }, (_, i) => items.slice(i * PER_REQUEST, (i + 1) * PER_REQUEST));
  const scored = (await Promise.all(chunks.map(async (chunk) => {
    const questions: Questions = Object.fromEntries(chunk.map((item, i) => [`i${i}`, noul(`This ${what} would help with \`goal\`. The ${what}: ${JSON.stringify(item.text.slice(0, 500))}`, {
      true: `It is about what \`goal\` needs, and specific enough to be of use.`, false: "It is about something else, or is only navigation, advertising, a login page or boilerplate." })]));
    const answers = await ask({ goal }, questions) as unknown as Record<string, NoulResponse>;
    return chunk.map((item, i) => ({ ...item, score: answers[`i${i}`]!.noul }));
  }))).flat().sort((a, b) => b.score - a.score);
  const passed = scored.filter((s) => s.score >= (opts.atLeast ?? 0.5));
  return (passed.length || opts.orNone ? passed : scored.slice(0, 3)).slice(0, opts.keep ?? scored.length);
}
