import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask } from "../jev";
import type { LlmRequest } from "../openai";
import { batches, describe as describeFiles, directorPrompt, relay, tidyPlan, verbatim, workspace, type Kit, type Plan, type Step } from "./relay";
import { arxivEntries, limiter, worthKeeping } from "./web";

const step = (id: string, worker: Step["worker"], needs: string[] = [], accept = ["It is there."]): Step => ({ id, worker, goal: `goal of ${id}`, queries: [], needs, accept });
const kit: Kit = { name: "test", brief: "One file, out.md." };

describe("the plan, as code sees it", () => {
  test("a kit with nothing to build is not offered a build, and a planned one is dropped", () => {
    expect(directorPrompt(kit)).not.toContain('"build" runs');
    expect(directorPrompt(kit)).toContain("plan no build step");
    expect(directorPrompt({ ...kit, build: async () => ({ ok: true, log: "", outputs: [] }) })).toContain('"build" runs');
    const plan: Plan = { deliverable: "out.md", steps: [step("find", "research"), step("write it!", "write", ["find", "nowhere"], ["a", "b", "c", "d"]), step("build", "build", ["write it!"])] };
    const tidy = tidyPlan(plan, kit);
    expect(tidy.steps.map((s) => s.id)).toEqual(["find", "write_it_"]);
    expect(tidy.steps[1]!.needs).toEqual(["find"]);
    expect(tidy.steps[1]!.accept).toHaveLength(3);
  });
  test("two steps never share an id", () => {
    expect(tidyPlan({ deliverable: "", steps: [step("a", "research"), step("a", "research")] }, kit).steps.map((s) => s.id)).toEqual(["a", "a_"]);
  });
  test("the director is told who checks its statements", () => {
    expect(directorPrompt(kit)).toContain("literal reader");
    expect(directorPrompt(kit)).toContain("checked exactly by code");
  });
  test("research steps that do not need each other go out together; everything else one at a time", () => {
    const steps = [step("a", "research"), step("b", "research"), step("c", "research", ["a"]), step("d", "research"), step("w", "write", ["a", "b", "c", "d"]), step("x", "write", ["w"])];
    expect(batches(steps).map((b) => b.map((s) => s.id))).toEqual([["a", "b"], ["c", "d"], ["w"], ["x"]]);
  });
});

describe("what reaches the writer and the check", () => {
  test("the best sources word for word, the budget shared between the steps", () => {
    const sources = { a: [{ url: "u1", title: "t1", score: 0.9, text: "x".repeat(5000) }, { url: "u2", title: "t2", score: 0.8, text: "y".repeat(5000) }], b: [{ url: "u3", title: "t3", score: 0.7, text: "short" }], c: [] };
    const got = verbatim(sources, ["a", "b", "c", "missing"], 8000);
    expect(Object.keys(got)).toEqual(["a", "b"]);
    expect(got.a!.map((s) => s.text.length)).toEqual([3000, 1000]);
    expect(got.b).toEqual([{ title: "t3", address: "u3", text: "short" }]);
  });
  test("every file from its start, the budget shared", () => {
    const made = describeFiles({ "a.md": "a".repeat(30_000), "b.md": "bbb" }, ["a.md", "b.md"], 10_000);
    expect(made).toContain("FILE a.md (30000 characters)");
    expect(made.length).toBeLessThan(5_200);
  });
});

describe("web", () => {
  test("a failure is not kept: an empty listing, a page that did not come", () => {
    expect(worthKeeping([])).toBe(false);
    expect(worthKeeping([{ url: "u" }])).toBe(true);
    expect(worthKeeping({ status: 429, blocks: [] })).toBe(false);
    expect(worthKeeping({ status: 0 })).toBe(false);
    expect(worthKeeping({ status: 404 })).toBe(true);
    expect(worthKeeping({ status: 200 })).toBe(true);
  });
  test("a limiter lets so many run at once, and all of them finish", async () => {
    const turn = limiter(2);
    let running = 0, most = 0;
    const done = await Promise.all([1, 2, 3, 4, 5].map((n) => turn(async () => { most = Math.max(most, ++running); await Bun.sleep(5); running--; return n; })));
    expect(done).toEqual([1, 2, 3, 4, 5]);
    expect(most).toBe(2);
  });
  test("an arXiv entry keeps its whole abstract, its date and a clean address", () => {
    const xml = `<feed><entry><id>http://arxiv.org/abs/2505.24760v2</id><published>2025-05-30T17:59:59Z</published><title>REASONING GYM:\n  Environments &amp; Rewards</title><summary>  ${"Long abstract. ".repeat(100)}</summary></entry><entry><id>http://arxiv.org/api/errors#x</id><title>Error</title><summary>bad</summary></entry></feed>`;
    const [entry, ...rest] = arxivEntries(xml);
    expect(rest).toEqual([]);
    expect(entry!.url).toBe("https://arxiv.org/abs/2505.24760");
    expect(entry!.title).toBe("REASONING GYM: Environments & Rewards");
    expect(entry!.date).toBe("2025-05-30");
    expect(entry!.text!.length).toBeGreaterThan(1400);
    expect(entry!.snippet.length).toBeLessThanOrEqual(900);
  });
});

describe("the loop, with a fake Jev and a fake LLM", () => {
  // No queries, so no network: the point is who is asked what, and what a redo is given.
  const plan: Plan = { deliverable: "out.md", steps: [step("find", "research"), step("make", "write", ["find"]), step("ship", "build")] };
  const run = async (theKit: Kit, accept: (statement: string, made: string) => boolean = () => true) => {
    const asked: LlmRequest[] = [];
    const llm = async (req: LlmRequest) => {
      asked.push(req);
      if (req.schema.name === "relay_plan") return plan;
      if (req.schema.name === "notes") return { notes: "A fact [address].", missing: [] };
      if (req.schema.name === "research_again") return { queries: [], reread: false };
      const given = JSON.parse(req.user) as { your_files_as_they_stand?: Record<string, string> };
      return { files: [{ path: "out.md", content: given.your_files_as_they_stand ? "second draft" : "first draft" }] };
    };
    const ask = (async (state: { made?: string }, questions: Record<string, { instructions?: string }>) => Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, { type: "noul", noul: accept(JSON.stringify(q), state.made ?? "") ? 0.9 : 0.1 }]))) as unknown as Ask;
    const ws = await workspace(await mkdtemp(join(tmpdir(), "relay-test-")));
    return { result: await relay("make it", ws, { ask, llm, kit: theKit }), asked, ws };
  };

  test("a plain kit: plan, read, write; the build the kit does not have is never run", async () => {
    const { result, asked, ws } = await run(kit);
    expect(result.ok).toBe(true);
    expect(result.plan.steps.map((s) => s.id)).toEqual(["find", "make"]);
    expect(asked.map((r) => r.schema.name)).toEqual(["relay_plan", "notes", "files"]);
    expect(ws.files["out.md"]).toBe("first draft");
    expect(result.trace.jevQuestions).toBe(2);
  });

  test("the kit prepares what the writer gets, and its review sends the writer its own file back with what is wrong", async () => {
    let reviews = 0;
    const { result, asked, ws } = await run({ ...kit, reading: "Keep it to the theme.", prepare: async () => ({ chosen: ["only this"] }), review: async () => reviews++ ? [] : ["It is 3,000 words; the limit is 2,500."] });
    expect(asked[1]!.system).toContain("Keep it to the theme.");
    const [first, second] = asked.filter((r) => r.schema.name === "files").map((r) => JSON.parse(r.user) as Record<string, unknown>);
    expect(first!.chosen).toEqual(["only this"]);
    expect(first!.your_files_as_they_stand).toBeUndefined();
    expect(second!.your_files_as_they_stand).toEqual({ "out.md": "first draft" });
    expect(second!.wrong_with_them).toEqual(["It is 3,000 words; the limit is 2,500."]);
    expect(ws.files["out.md"]).toBe("second draft");
    expect(result.ok).toBe(true);
    expect(result.trace.redone).toEqual(["make"]);
  });

  test("a build that failed sends the files back to their writer with its log, and builds again", async () => {
    let builds = 0;
    const { result, asked, ws } = await run({ ...kit, build: async (w) => ({ ok: w.files["out.md"] === "second draft", log: `build ${++builds}: out.md line 3: unexpected token`, outputs: [] }) });
    expect(result.plan.steps.map((s) => s.id)).toEqual(["find", "make", "ship"]);
    const mend = JSON.parse(asked.filter((r) => r.schema.name === "files")[1]!.user) as { wrong_with_them: string[] };
    expect(mend.wrong_with_them[0]).toContain("unexpected token");
    expect(ws.files["out.md"]).toBe("second draft");
    expect(builds).toBe(2);
    expect(result.ok).toBe(true);
  });

  test("research that no search or reading could mend is not redone", async () => {
    const { result, asked } = await run(kit, (statement) => !statement.includes("It is there.") ? true : false);
    expect(asked.map((r) => r.schema.name)).toEqual(["relay_plan", "notes", "research_again", "files", "files"]);
    expect(result.trace.redone).toEqual(["make"]);
    expect(result.failed.map((f) => f.split(":")[0])).toEqual(["find", "make"]);
  });
});
