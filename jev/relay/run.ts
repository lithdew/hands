#!/usr/bin/env bun
// run.ts — carry out one of the five tasks with the relay, then judge it against its fixed standard.
//
//   bun jev/relay/run.ts <task> [--no-judge] [--keep] [--cache-llm]     tasks: mock-exam rl-summary personal-site matrix-video pitch-video
//   bun jev/relay/run.ts judge <task>            judge what is already in out/relay/<task>
//   bun jev/relay/run.ts list
//
// Everything lands in out/relay/<task>/ (gitignored): the files, notes/, trace.json, judgement.json.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createJev } from "../jev";
import { createOpenAI, type Llm } from "../openai";
import { judge } from "./judge";
import { KITS } from "./kits";
import { relay, workspace } from "./relay";
import { TASKS } from "./tasks";

const [first, second] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dirOf = (id: string) => join(import.meta.dir, "..", "..", "out", "relay", id);
const show = (j: Awaited<ReturnType<typeof judge>>) => { for (const v of j.verdicts) console.log(`  ${v.pass ? "pass" : "FAIL"} ${v.must ? "must" : "    "} ${v.id.padEnd(12)} ${v.why.replace(/\s+/g, " ").slice(0, 260)}`); console.log(`\n${j.task}: ${j.passed ? "UP TO STANDARD" : "not yet"} (${j.score})`); };

/** --cache-llm, for whoever is improving a late stage: an LLM answer to the very same request is read from disk, so the early stages cost nothing the second time. Never for a run that is to be measured. */
function remembered(llm: Llm): Llm {
  const dir = join(import.meta.dir, "..", "..", "out", "relay", "cache");
  return async (req) => {
    const file = Bun.file(join(dir, `llm-${Bun.hash(JSON.stringify([req.model, req.effort, req.system, req.user, req.schema.name])).toString(16)}.json`));
    if (await file.exists()) return file.json();
    const answer = await llm(req);
    await mkdir(dir, { recursive: true });
    await Bun.write(file, JSON.stringify(answer));
    return answer;
  };
}

if (first === "list" || !first) { for (const t of TASKS) console.log(`${t.id.padEnd(15)} ${t.said}`); process.exit(0); }
// judge.ts reads every file in the directory as the work, its own last judgement.json included, and has been seen to quote it as evidence. An old verdict is not the work.
if (first === "judge") { await rm(join(dirOf(second!), "judgement.json"), { force: true }); show(await judge(second!, dirOf(second!))); process.exit(0); }

const spec = TASKS.find((t) => t.id === first);
if (!spec) { console.error(`no such task: ${first}`); process.exit(2); }
// A clean run: what an earlier run left (files of another plan, its notes, an old judgement) is not this run's work, and the judge
// reads the whole folder. --keep leaves the files where they are (to go on from them), and still takes away the old verdict and notes.
if (process.argv.includes("--keep")) { await rm(join(dirOf(spec.id), "judgement.json"), { force: true }); await rm(join(dirOf(spec.id), "notes"), { recursive: true, force: true }); }
else await rm(dirOf(spec.id), { recursive: true, force: true });
const ws = await workspace(dirOf(spec.id), (line) => console.log(`  ${line}`));
console.log(`${spec.id}: "${spec.said}"`);
const result = await relay(spec.said, ws, { ask: createJev(), llm: process.argv.includes("--cache-llm") ? remembered(createOpenAI({ timeoutMs: 240_000 })) : createOpenAI({ timeoutMs: 240_000 }), kit: KITS[spec.kit]! });
const t = result.trace, llmMs = t.llmCalls.reduce((sum, call) => sum + call.ms, 0);
console.log(`\n${(t.ms / 1000).toFixed(0)} s in all. Jev: ${t.jevRequests} requests (${t.jevQuestions} questions), ${(t.jevMs / 1000).toFixed(1)} s, sifted ${t.sifted} results and passages down to ${t.kept}. LLM: ${t.llmCalls.length} calls, ${(llmMs / 1000).toFixed(0)} s. Pages fetched: ${t.fetched}. Redone: ${t.redone.join(", ") || "nothing"}.`);
if (t.counts && Object.keys(t.counts).length) console.log(`the kit's own use of Jev: ${Object.entries(t.counts).map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`).join(", ")}.`);
if (result.failed.length) console.log(`steps Jev did not accept:\n  ${result.failed.join("\n  ")}`);
console.log(`files: ${Object.keys(ws.files).join(", ") || "none"}`);
if (!process.argv.includes("--no-judge")) show(await judge(spec.id, ws.dir));
