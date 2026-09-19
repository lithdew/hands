#!/usr/bin/env bun
// run.ts — carry out one of the five tasks with the relay, then judge it against its fixed standard.
//
//   bun jev/relay/run.ts <task> [--no-judge]     tasks: mock-exam rl-summary personal-site matrix-video pitch-video
//   bun jev/relay/run.ts judge <task>            judge what is already in out/relay/<task>
//   bun jev/relay/run.ts list
//
// Everything lands in out/relay/<task>/ (gitignored): the files, notes/, trace.json, judgement.json.

import { join } from "node:path";
import { createJev } from "../jev";
import { judge } from "./judge";
import { KITS } from "./kits";
import { createStreamingOpenAI } from "./llm";
import { relay, workspace } from "./relay";
import { TASKS } from "./tasks";

const [first, second] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dirOf = (id: string) => join(import.meta.dir, "..", "..", "out", "relay", id);
// Streamed (llm.ts): from this machine a socket that is silent for 60 s is cut, and the writer and the judge both think for longer.
// The judge is given the same client as its transport only: its model, effort, prompts and rubric are its own (judge.ts).
const llm = createStreamingOpenAI({ timeoutMs: 600_000 });
const show = (j: Awaited<ReturnType<typeof judge>>) => { for (const v of j.verdicts) console.log(`  ${v.pass ? "pass" : "FAIL"} ${v.must ? "must" : "    "} ${v.id.padEnd(12)} ${v.why.replace(/\s+/g, " ").slice(0, 260)}`); console.log(`\n${j.task}: ${j.passed ? "UP TO STANDARD" : "not yet"} (${j.score})`); };

if (first === "list" || !first) { for (const t of TASKS) console.log(`${t.id.padEnd(15)} ${t.said}`); process.exit(0); }
if (first === "judge") { show(await judge(second!, dirOf(second!), llm)); process.exit(0); }

const spec = TASKS.find((t) => t.id === first);
if (!spec) { console.error(`no such task: ${first}`); process.exit(2); }
const ws = await workspace(dirOf(spec.id), (line) => console.log(`  ${line}`));
console.log(`${spec.id}: "${spec.said}"`);
const result = await relay(spec.said, ws, { ask: createJev(), llm, kit: KITS[spec.kit]! });
const t = result.trace, llmMs = t.llmCalls.reduce((sum, call) => sum + call.ms, 0);
console.log(`\n${(t.ms / 1000).toFixed(0)} s in all. Jev: ${t.jevRequests} requests, ${(t.jevMs / 1000).toFixed(1)} s, sifted ${t.sifted} results and passages down to ${t.kept}. LLM: ${t.llmCalls.length} calls, ${(llmMs / 1000).toFixed(0)} s. Pages fetched: ${t.fetched}. Redone: ${t.redone.join(", ") || "nothing"}.`);
if (result.failed.length) console.log(`steps Jev did not accept:\n  ${result.failed.join("\n  ")}`);
console.log(`files: ${Object.keys(ws.files).join(", ") || "none"}`);
if (!process.argv.includes("--no-judge")) show(await judge(spec.id, ws.dir, llm));
