import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask } from "../jev";
import type { LlmRequest } from "../openai";
import { batches, describe as describeFiles, directorPrompt, relay, tidyPlan, verbatim, workspace, type Kit, type Plan, type Step } from "./relay";
import { arxivEntries, cached, limiter, worthKeeping } from "./web";

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
  test("a kit with a build gets a build step when the director planned none, and only then", () => {
    const builds: Kit = { ...kit, build: async () => ({ ok: true, log: "", outputs: [] }) };
    expect(tidyPlan({ deliverable: "", steps: [step("find", "research"), step("build", "write", ["find"])] }, builds).steps.map((s) => `${s.id}:${s.worker}`)).toEqual(["find:research", "build:write", "build_:build"]);
    expect(tidyPlan({ deliverable: "", steps: [step("make", "write"), step("ship", "build", ["make"])] }, builds).steps.map((s) => s.id)).toEqual(["make", "ship"]);
    expect(tidyPlan({ deliverable: "", steps: [] }, builds).steps).toEqual([]);
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
  test("the cache keeps an answer and never a failure, and a kit says what a failure is for its own requests", async () => {
    const name = `test-${Bun.hash(String(performance.now())).toString(16)}`;
    let made = 0;
    const ask = (value: unknown, keep?: (v: unknown) => boolean) => cached(name, async () => { made++; return value; }, false, keep);
    expect(await ask(null, (v) => v !== null)).toBe(null);
    expect(await ask([], (v) => v !== null)).toEqual([]); // an empty listing is an answer when the kit says so
    expect(await ask(["never made"], (v) => v !== null)).toEqual([]);
    expect(made).toBe(2);
    expect(await ask(["made"])).toEqual(["made"]); // by this file's own rule an empty listing on disk is a failure: asked again
    expect(made).toBe(3);
    await rm(join(import.meta.dir, "..", "..", "out", "relay", "cache", `${name}.json`), { force: true });
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

describe("a kit's hooks, each in its place", () => {
  // Jev says yes to everything; the kit's own hooks are what is under test.
  const yes = (async (_state: unknown, questions: Record<string, unknown>) => Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: 0.9 }]))) as unknown as Ask;
  const fresh = async () => workspace(await mkdtemp(join(tmpdir(), "relay-test-")));

  test("context, sources that bring their passages, admit, review and an unplanned build are all used, and no web is needed for them", async () => {
    const calls: LlmRequest[] = [], seen: string[] = [];
    let reviews = 0;
    const llm = async (req: LlmRequest) => {
      calls.push(req);
      if (req.schema.name === "relay_plan") return { deliverable: "out.md", steps: [step("look", "research", [], ["The notes say something."]), step("write", "write", ["look"], ["The file exists."])] };
      if (req.schema.name === "notes") return { notes: `read: ${(JSON.parse(req.user) as { material: string }).material}`, missing: [] };
      return { files: [{ path: "out.md", content: `attempt ${calls.filter((c) => c.schema.name === "files").length}` }] };
    };
    const theKit: Kit = { name: "test", brief: "One file, out.md.", context: async () => "the user is Ada",
      sources: async (query) => { seen.push(query); return [{ title: "local", url: "local:a", snippet: "", blocks: ["a passage that is kept, about Ada and her work", "a passage about SOMEONE ELSE with the same name"] }]; },
      admit: async (ctx, _step, passages) => { ctx.ws.counts.read = passages.length; return passages.filter((p) => !p.text.includes("SOMEONE ELSE")); },
      prepare: async () => ({}),
      review: async () => (reviews++ === 0 ? ["The file says too much."] : []),
      build: async (_ws, ctx) => ({ ok: true, log: `built for ${ctx.task}`, outputs: ["out.md"] }) };
    const ws = await fresh();
    const result = await relay("make it", ws, { ask: yes, llm, kit: theKit });

    expect(JSON.parse(calls[0]!.user)).toEqual({ request: "make it", known_before_planning: "the user is Ada" });
    // Planned without queries, the step asked the kit's sources with its goal; the source's passages were sifted, never fetched.
    expect(seen).toEqual(["goal of look"]);
    const read = calls.find((c) => c.schema.name === "notes")!;
    expect(read.user).toContain("a passage that is kept");
    expect(read.user).not.toContain("SOMEONE ELSE");
    expect(ws.sources.look!.map((s) => s.url)).toEqual(["local:a"]);
    expect(result.trace.fetched).toBe(0);
    expect(result.trace.counts).toEqual({ read: 2 });
    // The review sent the writer back once, with what it wrote before; `prepare` gave it the notes alone.
    const writes = calls.filter((c) => c.schema.name === "files").map((c) => JSON.parse(c.user) as Record<string, unknown>);
    expect(writes).toHaveLength(2);
    expect(writes[0]!.sources_word_for_word).toBeUndefined();
    expect(writes[1]!.wrong_with_them).toEqual(["The file says too much."]);
    expect(writes[1]!.your_files_as_they_stand).toEqual({ "out.md": "attempt 1" });
    // The director planned no build; the kit has one, so it ran, and code alone says whether it succeeded.
    expect(result.plan.steps.map((s) => s.worker)).toEqual(["research", "write", "build"]);
    expect(result.plan.steps[2]!.accept).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("without `prepare` the writer gets the best sources word for word; a result's whole `text` is one passage for `admit`", async () => {
    const admitted: string[] = [];
    const llm = async (req: LlmRequest) => req.schema.name === "relay_plan" ? { deliverable: "out.md", steps: [step("look", "research"), step("write", "write", ["look"])] } : req.schema.name === "notes" ? { notes: "A fact [u].", missing: [] } : { files: [{ path: "out.md", content: Object.keys(JSON.parse(req.user) as object).join(" ") }] };
    const ws = await fresh();
    await relay("make it", ws, { ask: yes, llm, kit: { ...kit, sources: async () => [{ title: "whole", url: "u:1", snippet: "an abstract", text: "the whole abstract", date: "2026-01-02" }], admit: async (_ctx, _step, passages) => { admitted.push(...passages.map((p) => p.text)); return passages; } } });
    expect(admitted).toEqual(["the whole abstract"]);
    expect(ws.sources.look).toEqual([{ url: "u:1", title: "whole", score: 0.9, text: "the whole abstract", date: "2026-01-02" }]);
    expect(ws.files["out.md"]).toContain("sources_word_for_word");
  });

  test("a review that throws is logged and does not end the run", async () => {
    const lines: string[] = [];
    const llm = async (req: LlmRequest) => req.schema.name === "relay_plan" ? { deliverable: "out.md", steps: [step("write", "write")] } : { files: [{ path: "out.md", content: "draft" }] };
    const result = await relay("make it", await fresh(), { ask: yes, llm, kit: { ...kit, review: async () => { throw new Error("no network"); } }, log: (line) => lines.push(line) });
    expect(result.ok).toBe(true);
    expect(lines.some((l) => l.includes("review: no network"))).toBe(true);
  });

  test("the checker is shown a page as a reader reads it, not its stylesheet", () => {
    const made = describeFiles({ "site/index.html": `<html><head><style>${"body{color:red}".repeat(900)}</style></head><body><h1>Ada</h1><p>See <a href="https://a.test/x">my notes</a>.</p></body></html>` }, ["site/index.html"]);
    expect(made).toContain("# Ada");
    expect(made).toContain("my notes (https://a.test/x)");
    expect(made).not.toContain("color:red");
  });
});
