#!/usr/bin/env bun
/** Live model calls; synthetic observations, no desktop input or real messages.
 * bun jev/eval.ts --live --suite=decisions --split=development --rounds=3
 * Results are append-only JSONL plus a machine-readable summary in out/evals/.
 */
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { redact } from "../desktop";
import { CONTRACTS, deciders, type ContractName } from "./contracts";
import { describeAction, type Decision } from "./cua";
import { EVAL_HAND, FIXTURES, INTENT_CASES, decisionSignature } from "./eval-fixtures";
import { assessRisk, needsApproval } from "./gate";
import { parseIntent } from "./intent";
import { choice, createJev, noul, type Ask, type Questions } from "./jev";
import { createOpenAI, type Llm } from "./openai";
import { quickIntent } from "./quick";

export type Call = { phase: string; ms: number; stateBytes: number; requestBytes: number; questions: number; maxChoices: number; inputTokens?: number; model?: string; answers?: unknown; error?: string };
export type Row = { suite: string; strategy: string; case: string; category: string; split: string; round: number; ok: boolean; direct: boolean; ms: number; decisionMs: number; gateMs: number; handoff: boolean; unnecessaryHandoff: boolean; wrongAction: boolean; falseAllow: boolean; expected: unknown; actual?: unknown; error?: string; calls: Call[] };
type Job = Omit<Row, "ok" | "direct" | "ms" | "decisionMs" | "gateMs" | "handoff" | "unnecessaryHandoff" | "wrongAction" | "falseAllow" | "calls"> & { run(row: Row, ask: Ask, phase: (value: string) => void): Promise<void> };

export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!);
}

export function summarize(rows: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.suite}/${row.strategy}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].map(([id, group]) => {
    const decisionCalls = group.flatMap((r) => r.calls.filter((c) => c.phase === "decision"));
    return {
      id, n: group.length, correct: group.filter((r) => r.ok).length, direct: group.filter((r) => r.direct).length,
      errors: group.filter((r) => r.error).length, handoffs: group.filter((r) => r.handoff).length,
      unnecessaryHandoffs: group.filter((r) => r.unnecessaryHandoff).length,
      wrongActions: group.filter((r) => r.wrongAction).length, falseAllows: group.filter((r) => r.falseAllow).length,
      decisionP50Ms: percentile(group.map((r) => r.decisionMs), .5), decisionP95Ms: percentile(group.map((r) => r.decisionMs), .95),
      totalP50Ms: percentile(group.map((r) => r.ms), .5), totalP95Ms: percentile(group.map((r) => r.ms), .95),
      gateP50Ms: percentile(group.filter((r) => r.gateMs > 0).map((r) => r.gateMs), .5),
      meanDecisionBytes: decisionCalls.length ? Math.round(decisionCalls.reduce((sum, c) => sum + c.requestBytes, 0) / decisionCalls.length) : null,
      meanDecisionTokens: decisionCalls.length ? Math.round(decisionCalls.reduce((sum, c) => sum + (c.inputTokens ?? 0), 0) / decisionCalls.length) : null,
      inputTokens: group.flatMap((r) => r.calls).reduce((sum, c) => sum + (c.inputTokens ?? 0), 0),
    };
  });
}

class WriterNeeded extends Error {}
const dryWriter: Llm = async () => { throw new WriterNeeded("Text generation required"); };

function decisionJobs(rounds: number, split: string, strategies: ContractName[]): Job[] {
  return Array.from({ length: rounds }, (_, round) => FIXTURES.filter((f) => split === "all" || f.split === split).flatMap((f) => strategies.map((strategy): Job => ({
    suite: "decisions", strategy, case: f.id, category: f.category, split: f.split, round, expected: f.expected,
    async run(row, ask, phase) {
      let decision: Decision;
      const started = performance.now();
      try { decision = await deciders[strategy]({ ask, llm: dryWriter }, EVAL_HAND, f.intent, f.observation, { history: f.history, plan: null }); }
      catch (error) { if (!(error instanceof WriterNeeded)) throw error; decision = { kind: "escalate", reason: "write_new_text", mustPlan: true }; }
      row.decisionMs = performance.now() - started;
      const signature = decisionSignature(decision);
      row.actual = { signature, decision };
      row.direct = f.expected.includes(signature);
      row.ok = row.direct || Boolean(f.acceptable?.includes(signature));
      row.handoff = decision.kind === "escalate";
      row.unnecessaryHandoff = row.handoff && !f.expected.some((e) => e === "escalate" || e === "compose");
      row.wrongAction = decision.kind === "act" && !row.ok;
      if (decision.kind === "act" && decision.action.kind !== "wait") {
        phase("gate");
        const gateStart = performance.now();
        // Original contracts also used the old scope-free action description.
        const action = ["fanout", "compact"].includes(strategy) && "target" in decision.action && decision.action.target
          ? { ...decision.action, target: { ...decision.action.target, within: "" } } : decision.action;
        const risk = await assessRisk(ask, { goal: f.intent.goal, avoid: f.intent.avoid, action: describeAction(action) });
        row.gateMs = performance.now() - gateStart;
        const gate = needsApproval(risk) ? "approval" : "allow";
        row.actual = { signature, decision, gate, risk };
        row.falseAllow = row.ok && f.gate === "approval" && gate === "allow";
        // A false-positive approval is a workflow failure, even for a correct pick.
        row.ok &&= gate === f.gate;
      }
    },
  })))).flat();
}

function latencyJobs(rounds: number): Job[] {
  return Array.from({ length: rounds }, (_, round) => [8, 80, 150].flatMap((count) => [1, 9, 32].map((questionCount): Job => ({
    suite: "latency", strategy: `${count}-elements-${questionCount}-questions`, case: "choice-width", category: "transport-and-inference", split: "microbenchmark", round, expected: "Privacy",
    async run(row, ask) {
      const index = (round * 17 + 3) % count;
      const options = Object.fromEntries(Array.from({ length: count }, (_, i) => [`e${i}`, i === index ? "Privacy" : `Navigation link ${i}`]));
      const questions: Questions = Object.fromEntries(Array.from({ length: questionCount }, (_, i) => [`pick_${i}`, choice("Which control is labelled Privacy?", options)]));
      const started = performance.now();
      const answers = await ask({ request: "Open Privacy", controls: options }, questions);
      row.decisionMs = performance.now() - started;
      row.actual = Object.values(answers).map((a) => a.type === "choice" ? a.choice : null);
      row.ok = Object.values(answers).every((a) => a.type === "choice" && a.choice === `e${index}`);
      row.direct = row.ok;
    },
  })))).flat();
}

function intentJobs(rounds: number, withLlm: boolean): Job[] {
  const llm = withLlm ? createOpenAI({ timeoutMs: 30_000 }) : null;
  return Array.from({ length: rounds }, (_, round) => INTENT_CASES.flatMap((f) => ["quick", "literal", ...(withLlm ? ["llm"] : [])].map((strategy): Job => ({
    suite: "intent", strategy, case: f.id, category: "literal-extraction", split: "development", round, expected: { url: f.url, query: f.query },
    async run(row, ask) {
      const started = performance.now();
      const result = strategy === "llm" ? await parseIntent(llm!, f.said) : await quickIntent(ask, f.said, { legacy: strategy === "quick" });
      row.decisionMs = performance.now() - started;
      row.actual = result;
      row.handoff = result === null;
      row.unnecessaryHandoff = row.handoff; // All fixtures can be built from literal text + known sites.
      row.ok = result !== null && result.url === f.url && (f.query === null ? Object.keys(result.inputs).length === 0 : Object.values(result.inputs).includes(f.query));
      row.direct = row.ok;
    },
  })))).flat();
}

export function shuffle<T>(values: T[], seed: number): T[] {
  const result = [...values];
  let n = seed >>> 0;
  for (let i = result.length - 1; i > 0; i--) {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    const j = n % (i + 1); [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

async function main() {
  const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const suite = arg("suite", "decisions"), split = arg("split", "development"), rounds = Number(arg("rounds", "3")), seed = Number(arg("seed", "20260919"));
  const strategies = arg("strategies", CONTRACTS.join(",")).split(",") as ContractName[];
  if (!["decisions", "latency", "intent", "all"].includes(suite) || !["development", "holdout", "all"].includes(split) || !Number.isInteger(rounds) || rounds < 1 || rounds > 10 || !Number.isSafeInteger(seed) || strategies.some((s) => !CONTRACTS.includes(s))) throw new Error("Invalid suite, split, rounds (1..10), seed or strategies.");
  if (!process.argv.includes("--live")) {
    console.log("Dry-run harness: real API calls require --live. No desktop actions. Use --suite=decisions|latency|intent|all --split=development|holdout|all --rounds=3 --strategies=fanout,compact,evidence,actions,scores. Optional --llm benchmarks the intent writer too.");
    return;
  }
  const jobs = shuffle([
    ...(["decisions", "all"].includes(suite) ? decisionJobs(rounds, split, strategies) : []),
    ...(["latency", "all"].includes(suite) ? latencyJobs(rounds) : []),
    ...(["intent", "all"].includes(suite) ? intentJobs(rounds, process.argv.includes("--llm")) : []),
  ], seed);
  const directory = arg("out", `out/evals/${new Date().toISOString().replace(/[:.]/g, "-")}-jev-${suite}-${split}`);
  await mkdir(directory, { recursive: true });
  if (await Bun.file(`${directory}/results.jsonl`).exists()) throw new Error("Refusing to overwrite an existing eval run. Choose a new --out directory.");
  const hashes = Object.fromEntries(await Promise.all(["jev/cua.ts", "jev/contracts.ts", "jev/quick.ts", "jev/eval-fixtures.ts", "jev/eval.ts", "jev/gate.ts"].map(async (path) => [path, createHash("sha256").update(await Bun.file(path).text()).digest("hex")])));
  let usage: { input_tokens?: number; model?: string } = {};
  const rawAsk = createJev({ timeout: 10_000, fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (response.ok) {
      const body = await response.clone().json() as { usage?: { input_tokens?: number }; model?: string };
      usage = { ...body.usage, model: body.model };
    }
    return response;
  } });
  const coldStart = performance.now();
  const warmup = await rawAsk({ text: "ready" }, { ready: noul("The text is ready.") }).then(() => ({ ms: performance.now() - coldStart, ok: true })).catch((error) => ({ ms: performance.now() - coldStart, ok: false, error: redact(String(error)) }));
  await Bun.write(`${directory}/metadata.json`, JSON.stringify({ date: new Date().toISOString(), suite, split, rounds, seed, concurrency: 1, jobs: jobs.length, platform: process.platform, bun: Bun.version, model: usage.model ?? process.env.JEV_MODEL ?? "jev-latest", warmup, hashes, note: "Synthetic observations. Real Jev; mocked writer and actions except optional --llm intent suite. Existing independent exact-action gate retained. No automatic retries. Errors remain in denominators; latency uses nearest-rank percentiles. Input bytes are serialized state + questions, excluding HTTP headers. Cold probe excluded from aggregate latencies." }, null, 2));
  const writer = Bun.file(`${directory}/results.jsonl`).writer();
  const rows: Row[] = [];
  console.log(JSON.stringify({ directory, jobs: jobs.length, warmup }));
  try {
    for (const job of jobs) {
      const { run, ...identity } = job;
      const row: Row = { ...identity, ok: false, direct: false, ms: 0, decisionMs: 0, gateMs: 0, handoff: false, unnecessaryHandoff: false, wrongAction: false, falseAllow: false, calls: [] };
      let phase = "decision";
      const ask: Ask = async (state, questions, options) => {
        usage = {};
        const started = performance.now();
        const call: Call = { phase, ms: 0, stateBytes: Buffer.byteLength(JSON.stringify(state)), requestBytes: Buffer.byteLength(JSON.stringify({ state, questions })), questions: Object.keys(questions).length, maxChoices: Math.max(0, ...Object.values(questions).map((q) => q.type === "choice" ? Object.keys(q.criteria).length : 0)) };
        row.calls.push(call);
        try { const answers = await rawAsk(state, questions, options); call.answers = answers; return answers; }
        catch (error) { call.error = redact(String(error)); throw error; }
        finally { call.ms = performance.now() - started; call.inputTokens = usage.input_tokens; call.model = usage.model; }
      };
      const start = performance.now();
      try { await run(row, ask, (value) => { phase = value; }); }
      catch (error) { row.error = redact(String(error)); row.ok = false; }
      row.ms = performance.now() - start;
      // Timeout/failure latency belongs in the same denominator as successes.
      if (!row.decisionMs) row.decisionMs = row.calls.filter((c) => c.phase === "decision").reduce((sum, c) => sum + c.ms, 0) || (phase === "decision" && row.error ? row.ms : 0);
      if (!row.gateMs) row.gateMs = row.calls.filter((c) => c.phase === "gate").reduce((sum, c) => sum + c.ms, 0);
      rows.push(row);
      writer.write(redact(JSON.stringify(row)) + "\n"); await writer.flush();
      if (rows.length % 12 === 0 || !row.ok) console.log(JSON.stringify({ completed: rows.length, total: jobs.length, strategy: row.strategy, case: row.case, ok: row.ok, decisionMs: Math.round(row.decisionMs), actual: (row.actual as any)?.signature, error: row.error }));
    }
  } finally {
    await writer.end();
    const summary = summarize(rows);
    await Bun.write(`${directory}/summary.json`, JSON.stringify({ completed: rows.length, planned: jobs.length, summary }, null, 2));
    console.log(JSON.stringify({ directory, summary }, null, 2));
  }
}

if (import.meta.main) main().catch((error) => { console.error(redact(String(error))); process.exitCode = 1; });
