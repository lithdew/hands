import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask } from "../jev";
import type { Llm, LlmRequest } from "../openai";
import { relay, workspace, type Kit } from "./relay";

// Jev says yes to everything; the kit's own hooks are what is under test.
const yes: Ask = (async (_state: unknown, questions: Record<string, { type: string }>) => Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: 0.9 }]))) as unknown as Ask;

test("a kit's context, own sources, admit and review are all used, and no web is needed for them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-test-")), calls: LlmRequest[] = [];
  let reviews = 0;
  const llm: Llm = async (req) => {
    calls.push(req);
    if (req.schema.name === "relay_plan") return { deliverable: "out.md", steps: [
      { id: "look", worker: "research", goal: "what is known", queries: [], needs: [], accept: ["The notes say something."] },
      { id: "write", worker: "write", goal: "write it", queries: [], needs: ["look"], accept: ["The file exists."] }] };
    if (req.schema.name === "notes") return { notes: `read: ${JSON.parse(req.user).material}`, missing: [] };
    return { files: [{ path: "out.md", content: `attempt ${calls.filter((c) => c.schema.name === "files").length}` }] };
  };
  const kit: Kit = { name: "test", brief: "One file, out.md.", context: async () => "the user is Ada",
    sources: async () => [{ title: "local", url: "local:a", snippet: "", blocks: ["a passage that is kept, about Ada and her work", "a passage about SOMEONE ELSE with the same name"] }],
    admit: async (_ask, passages) => passages.filter((p) => !p.text.includes("SOMEONE ELSE")),
    review: async () => (reviews++ === 0 ? ["The file says too much."] : []),
    build: async () => ({ ok: true, log: "built", outputs: ["out.md"] }) };
  const result = await relay("make it", await workspace(dir), { ask: yes, llm, kit });

  expect(JSON.parse(calls[0]!.user)).toEqual({ request: "make it", known_before_planning: "the user is Ada" });
  const read = calls.find((c) => c.schema.name === "notes")!;
  expect(read.user).toContain("a passage that is kept");
  expect(read.user).not.toContain("SOMEONE ELSE");
  // The review sent the writer back once, with what it wrote before.
  const writes = calls.filter((c) => c.schema.name === "files");
  expect(writes).toHaveLength(2);
  expect(JSON.parse(writes[1]!.user).not_yet_true_last_time).toEqual(["The file says too much."]);
  expect(JSON.parse(writes[1]!.user).your_files_last_time).toEqual({ "out.md": "attempt 1" });
  // The director planned no build; the kit has one, so it ran.
  expect(result.plan.steps.map((s) => s.worker)).toEqual(["research", "write", "build"]);
  expect(result.ok).toBe(true);
  expect(result.trace.fetched).toBe(0);
  await rm(dir, { recursive: true, force: true });
});
