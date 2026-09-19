import { expect, test } from "bun:test";
import type { Ask } from "../jev";
import { sift, spread } from "./sift";

/** A fake Jev: a noul per question, high when the question's text mentions "exam". */
const fake: Ask = (async (_state: unknown, questions: Record<string, { instructions?: string }>) =>
  Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, { type: "noul", noul: /exam/i.test(JSON.stringify(q)) ? 0.9 : 0.1 }]))) as unknown as Ask;

test("spread keeps the order and caps each site", () => {
  const items = ["https://a.edu/1", "https://a.edu/2", "https://a.edu/3", "https://b.edu/1", "https://c.edu/1", "https://b.edu/2"].map((url) => ({ url }));
  expect(spread(items, 4, 2).map((i) => i.url)).toEqual(["https://a.edu/1", "https://a.edu/2", "https://b.edu/1", "https://c.edu/1"]);
  expect(spread(items, 10, 1)).toHaveLength(3);
  expect(spread([], 5, 2)).toEqual([]);
});

test("sift keeps what passes, best first", async () => {
  const kept = await sift(fake, "find exams", [{ text: "Campus map" }, { text: "Final exam 2019" }, { text: "Parking" }], "link");
  expect(kept.map((k) => k.text)).toEqual(["Final exam 2019"]);
});

test("when nothing passes: the best three for results, nothing for links", async () => {
  const items = [{ text: "Campus map" }, { text: "Parking" }, { text: "Dining" }, { text: "Jobs" }];
  expect(await sift(fake, "find exams", items, "search result")).toHaveLength(3);
  expect(await sift(fake, "find exams", items, "link", { orNone: true })).toHaveLength(0);
});

test("more than sixty items go out as several requests", async () => {
  let requests = 0;
  const counting: Ask = (async (state: unknown, questions: never) => { requests++; return (fake as unknown as (s: unknown, q: never) => Promise<unknown>)(state, questions); }) as unknown as Ask;
  const kept = await sift(counting, "find exams", Array.from({ length: 130 }, (_, i) => ({ text: i % 10 ? `page ${i}` : `exam ${i}` })), "link");
  expect(requests).toBe(3);
  expect(kept).toHaveLength(13);
});
