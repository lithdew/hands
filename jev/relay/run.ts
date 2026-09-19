#!/usr/bin/env bun
// run.ts — carry out one of the five tasks with the relay, then judge it against its fixed standard.
//
//   bun jev/relay/run.ts <task> [--no-judge]     tasks: mock-exam rl-summary personal-site matrix-video pitch-video
//   bun jev/relay/run.ts judge <task>            judge what is already in out/relay/<task>
//   bun jev/relay/run.ts list
//
// Everything lands in out/relay/<task>/ (gitignored): the files, notes/, trace.json, judgement.json.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createJev } from "../jev";
import { createOpenAI } from "../openai";
import { judge } from "./judge";
import { KITS } from "./kits";
import { relay, workspace } from "./relay";
import { TASKS } from "./tasks";

const [first, second] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dirOf = (id: string) => join(import.meta.dir, "..", "..", "out", "relay", id);
const show = (j: Awaited<ReturnType<typeof judge>>) => { for (const v of j.verdicts) console.log(`  ${v.pass ? "pass" : "FAIL"} ${v.must ? "must" : "    "} ${v.id.padEnd(12)} ${v.why.replace(/\s+/g, " ").slice(0, 260)}`); console.log(`\n${j.task}: ${j.passed ? "UP TO STANDARD" : "not yet"} (${j.score})`); };

if (first === "list" || !first) { for (const t of TASKS) console.log(`${t.id.padEnd(15)} ${t.said}`); process.exit(0); }
if (first === "judge") { show(await judge(second!, dirOf(second!))); process.exit(0); }

const spec = TASKS.find((t) => t.id === first);
if (!spec) { console.error(`no such task: ${first}`); process.exit(2); }
// A clean run: what an earlier run left (files of another plan, an old judgement) is not this run's work, and the judge reads the whole folder.
if (!process.argv.includes("--keep")) await rm(dirOf(spec.id), { recursive: true, force: true });
const ws = await workspace(dirOf(spec.id), (line) => console.log(`  ${line}`));
console.log(`${spec.id}: "${spec.said}"`);
const result = await relay(spec.said, ws, { ask: createJev(), llm: createOpenAI({ timeoutMs: 240_000 }), kit: KITS[spec.kit]! });
const t = result.trace, llmMs = t.llmCalls.reduce((sum, call) => sum + call.ms, 0);
console.log(`\n${(t.ms / 1000).toFixed(0)} s in all. Jev: ${t.jevRequests} requests, ${(t.jevMs / 1000).toFixed(1)} s, sifted ${t.sifted} results and passages down to ${t.kept}. LLM: ${t.llmCalls.length} calls, ${(llmMs / 1000).toFixed(0)} s. Pages fetched: ${t.fetched}. Redone: ${t.redone.join(", ") || "nothing"}.`);
if (t.counts && Object.keys(t.counts).length) console.log(`the kit's own use of Jev: ${Object.entries(t.counts).map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`).join(", ")}.`);
if (result.failed.length) console.log(`steps Jev did not accept:\n  ${result.failed.join("\n  ")}`);
console.log(`files: ${Object.keys(ws.files).join(", ") || "none"}`);
if (!process.argv.includes("--no-judge")) show(await judge(spec.id, ws.dir));
