// The two knobs this kit adds to the relay: `web: false` (the kit's own sources are all there is) and `inHand`
// (how many sources that came with their text a research step keeps). Scripted LLM, scripted Jev, no network.
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask } from "../../../jev";
import type { Llm, LlmRequest } from "../../../openai";
import { relay, workspace, type Kit } from "../../relay";

test("with web off, research reads only the kit's passages, Jev scores every one, and the best `inHand` reach the note-taker", async () => {
  const ws = await workspace(await mkdtemp(join(tmpdir(), "relay-knobs-")));
  const calls: LlmRequest[] = [];
  const llm: Llm = async (req) => {
    calls.push(req);
    if (req.schema.name === "relay_plan") return { deliverable: "a.md", steps: [
      { id: "find", worker: "research", goal: "find the figure", queries: ["a query that must never reach the web"], needs: [], accept: [] },
      { id: "draft", worker: "write", goal: "write a.md", queries: [], needs: ["find"], accept: [] }] };
    if (req.schema.name === "notes") return { notes: "the figure is 42 [doc.md:3]", missing: [] };
    return { files: [{ path: "a.md", content: "the figure is 42" }] };
  };
  const scores: Record<string, number> = { "doc.md:3": 0.9, "doc.md:9": 0.2, "doc.md:12": 0.8, "doc.md:20": 0.7 };
  const ask = (async (_state: unknown, questions: Record<string, { instructions: string }>) => Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: "noul", noul: Object.entries(scores).find(([url]) => q.instructions.includes(`(${url})`))?.[1] ?? 0.9 }]))) as unknown as Ask;
  const kit: Kit = { name: "test", brief: "Write a.md.", web: false, inHand: 2,
    sources: async () => Object.keys(scores).map((url) => ({ title: url, url, snippet: `passage at ${url}`, text: `the whole passage at ${url}` })) };

  const result = await relay("make it", ws, { ask, llm, kit });

  expect(result.ok).toBe(true);
  expect(JSON.parse(calls.find((c) => c.schema.name === "notes")!.user).material).toBe("SOURCE doc.md:3 (doc.md:3)\nthe whole passage at doc.md:3\n\nSOURCE doc.md:12 (doc.md:12)\nthe whole passage at doc.md:12");
  expect(result.trace).toMatchObject({ sifted: 4, kept: 2, fetched: 0 });
});
