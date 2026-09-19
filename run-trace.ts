import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const phases = ["routing", "model", "gate", "approval", "tool_execution", "observation", "handoff", "narration"] as const;
export type TracePhase = typeof phases[number];
export type TraceOutcome = "ok" | "failed" | "cancelled" | "deadline" | "blocked" | "interrupted";
export type TraceEvent = "route" | "tool_proposed" | "tool_result" | "retry" | "recovery" | "handoff" | "stop" | "decision";
export type TraceMetadata = Partial<{
  tool: string; action: string; provider: string; model: string; decision: string;
  outcome: TraceOutcome; failureClass: string; stopReason: string; effort: string;
  exitCode: number; durationMs: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; attempt: number; revision: number;
  timedOut: boolean; cancelled: boolean; fallback: boolean;
}>;
type PhaseSummary = { count: number; totalMs: number; failed: number; interrupted: number };

const allowedStrings: Record<string, readonly string[]> = {
  tool: ["apps", "jev", "open_app", "bash", "computer", "computer_look", "computer_act", "computer_browser"],
  action: ["windows", "window", "screen", "attach", "tabs", "snapshot", "canvas_snapshot", "canvas_click", "canvas_drag", "focused_text", "navigate", "click", "type", "key", "scroll", "dialog", "set_value", "screenshot", "batch", "draw", "move"],
  provider: ["openai", "gemini", "jev"],
  model: ["gpt-5.6-luna", "gemini-3.8-flash", "gpt-6-astra", "jev", "Jev"],
  decision: ["allow", "approval", "blocked", "approved", "declined"],
  outcome: ["ok", "failed", "cancelled", "deadline", "blocked", "interrupted"],
  failureClass: ["nonzero-exit", "timeout", "cancelled", "shell-parser-or-quoting", "command-unavailable", "python-alias-unavailable", "missing-path", "permission-denied", "tool-error", "semantic-observation", "semantic-unobserved"],
  stopReason: ["stop", "length", "toolUse", "error", "aborted"],
  effort: ["low"],
};
const numericKeys = ["exitCode", "durationMs", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "attempt", "revision"];
const booleanKeys = ["timedOut", "cancelled", "fallback"];

// No free-form values cross this boundary, even if a caller bypasses TS types.
function safeMetadata(input: TraceMetadata): TraceMetadata {
  if (!input || typeof input !== "object") return {};
  const output: Record<string, string | number | boolean> = {};
  for (const [key, allowed] of Object.entries(allowedStrings)) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && allowed.includes(value)) output[key] = value;
  }
  for (const key of numericKeys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12 && (key === "exitCode" || value >= 0)) output[key] = Math.round(value);
  }
  for (const key of booleanKeys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "boolean") output[key] = value;
  }
  return output as TraceMetadata;
}

export interface RunTraceOptions {
  hand: number;
  directory?: string;
  enabled?: boolean;
  maxEvents?: number;
  maxBytes?: number;
  /** Monotonic clock and append sink are injectable for deterministic tests. */
  now?: () => number;
  write?: (line: string) => Promise<void>;
}

/** Local, bounded JSONL. Writes never block an action and failures never escape. */
export function createRunTrace(options: RunTraceOptions) {
  const runId = crypto.randomUUID();
  const hand = Number.isSafeInteger(options.hand) && options.hand >= 0 ? options.hand : 0;
  const startedAt = new Date().toISOString();
  const path = join(options.directory ?? "out/runs", `${startedAt.replace(/[:.]/g, "-")}-hand-${hand}-${runId}.jsonl`);
  const now = options.now ?? (() => performance.now());
  const started = now();
  const limit = (value: number | undefined, fallback: number, min: number, max: number) => value !== undefined && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
  const maxEvents = limit(options.maxEvents, 512, 2, 4096);
  const maxBytes = limit(options.maxBytes, 256 * 1024, 4096, 1024 * 1024);
  let directoryReady: Promise<unknown> | undefined;
  const write = options.write ?? (async (line: string) => {
    await (directoryReady ??= mkdir(options.directory ?? "out/runs", { recursive: true }));
    await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
  });
  let queue = Promise.resolve(), done = false, ioError = false, events = 0, written = 0, bytes = 0, dropped = 0, nextSpan = 0;
  let endedAt: number | undefined;
  const totals: Partial<Record<TracePhase, PhaseSummary>> = {};
  const active = new Map<number, { phase: TracePhase; started: number; meta: TraceMetadata }>();
  const elapsed = (since = started) => Math.max(0, Math.round((endedAt ?? now()) - since));
  const summary = () => ({ runId, hand, path, elapsedMs: elapsed(), events, written, bytes, dropped, ioError, finished: done, activeSpans: active.size, phases: structuredClone(totals) });
  function emit(kind: string, data: Record<string, unknown> = {}, terminal = false) {
    if (options.enabled === false || (done && !terminal)) return;
    const line = JSON.stringify({ v: 1, runId, hand, seq: events + 1, atMs: elapsed(), kind, ...data }) + "\n";
    const size = Buffer.byteLength(line);
    // Reserve space and one event for run_end, including the bounded aggregate.
    if (!terminal && (events >= maxEvents - 1 || bytes + size > maxBytes - 2048)) { dropped++; return; }
    events++; bytes += size;
    queue = queue.then(async () => {
      if (ioError) return;
      try { await write(line); written++; }
      catch { ioError = true; }
    });
  }
  emit("run_start", { startedAt });
  function endSpan(id: number, metadata: TraceMetadata = {}) {
    const span = active.get(id);
    if (!span || done) return;
    active.delete(id);
    const durationMs = elapsed(span.started);
    const meta = safeMetadata({ ...span.meta, ...metadata });
    const total = totals[span.phase] ??= { count: 0, totalMs: 0, failed: 0, interrupted: 0 };
    total.count++; total.totalMs += durationMs;
    if (meta.outcome && meta.outcome !== "ok") total.failed++;
    if (meta.outcome === "interrupted") total.interrupted++;
    emit("span_end", { span: id, phase: span.phase, ...meta, durationMs });
  }
  return {
    runId, path,
    event(kind: TraceEvent, metadata: TraceMetadata = {}) {
      if (["route", "tool_proposed", "tool_result", "retry", "recovery", "handoff", "stop", "decision"].includes(kind)) emit(kind, safeMetadata(metadata));
    },
    span(phase: TracePhase, metadata: TraceMetadata = {}) {
      if (done || options.enabled === false || !phases.includes(phase)) return (_metadata?: TraceMetadata) => {};
      // An unclosed caller span cannot grow memory indefinitely.
      if (active.size >= 64) { dropped++; return (_metadata?: TraceMetadata) => {}; }
      const id = ++nextSpan;
      const meta = safeMetadata(metadata);
      active.set(id, { phase, started: now(), meta });
      emit("span_start", { span: id, phase, ...meta });
      return (metadata: TraceMetadata = {}) => endSpan(id, metadata);
    },
    finish(outcome: TraceOutcome) {
      if (done) return;
      endedAt = now();
      for (const id of active.keys()) endSpan(id, { outcome: "interrupted" });
      done = true;
      emit("run_end", { ...safeMetadata({ outcome }), durationMs: elapsed(), dropped, phases: structuredClone(totals) }, true);
    },
    async flush() { await queue; return summary(); },
    summary,
  };
}

/** Inspect only bounded text locally; return categories, never the text itself. */
export function toolTraceOutcome(result: unknown, isError = false): TraceMetadata {
  let exitCode: number | undefined, timedOut = false, cancelled = false, text = "";
  const visit = (value: unknown, depth: number) => {
    if (depth > 3 || !value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (typeof obj.exitCode === "number" && Number.isFinite(obj.exitCode)) exitCode = obj.exitCode;
    timedOut ||= obj.timedOut === true; cancelled ||= obj.cancelled === true;
    for (const key of ["stderr", "stdout", "message", "error", "text"]) {
      if (typeof obj[key] !== "string") continue;
      const part = (obj[key] as string).slice(0, Math.max(0, 32768 - text.length));
      text += part;
      if (key === "text" && part.startsWith("{")) { try { visit(JSON.parse(part), depth + 1); } catch {} }
    }
    if (Array.isArray(obj.content)) for (const item of obj.content.slice(0, 4)) visit(item, depth + 1);
    if (obj.details) visit(obj.details, depth + 1);
  };
  visit(result, 0);
  const failed = isError || timedOut || cancelled || (exitCode !== undefined && exitCode !== 0);
  const failureClass = cancelled ? "cancelled" : timedOut ? "timeout"
    : /Python was not found|Python.*Microsoft Store/i.test(text) ? "python-alias-unavailable"
    : /ParserError|UnexpectedToken|MissingExpression|MissingEnd|StringMissing|Unexpected token|operator.*reserved|redirection.*not supported/i.test(text) ? "shell-parser-or-quoting"
    : /CommandNotFoundException|not recognized as|command not found/i.test(text) ? "command-unavailable"
    : /No such file|cannot find|can't open file|does not exist/i.test(text) ? "missing-path"
    : /access.*denied|Permission denied/i.test(text) ? "permission-denied"
    : exitCode !== undefined && exitCode !== 0 ? "nonzero-exit" : "tool-error";
  return { outcome: cancelled ? "cancelled" : timedOut ? "deadline" : failed ? "failed" : "ok", ...(exitCode !== undefined ? { exitCode } : {}), ...(timedOut ? { timedOut } : {}), ...(cancelled ? { cancelled } : {}), ...(failed ? { failureClass } : {}) };
}
