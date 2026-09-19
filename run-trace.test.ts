import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunTrace, toolTraceOutcome } from "./run-trace";

function memoryTrace(options: Partial<Parameters<typeof createRunTrace>[0]> = {}) {
  const lines: string[] = [];
  const trace = createRunTrace({ hand: 1, write: async (line) => { lines.push(line); }, ...options });
  return { trace, lines, records: () => lines.map((line) => JSON.parse(line)) };
}

test("trace stores only allowlisted metadata, never task, arguments, output or image data", async () => {
  const { trace, lines, records } = memoryTrace();
  trace.event("tool_proposed", {
    tool: "computer_browser", action: "click", provider: "gemini", model: "gemini-3.8-flash",
    task: "PRIVATE_TASK", args: { url: "https://private.example/PRIVATE_URL" },
    output: "PRIVATE_OUTPUT", screenshot: "PRIVATE_IMAGE", secret: "PRIVATE_KEY",
  } as any);
  trace.event("tool_result", { tool: "PRIVATE_TOOL", action: "PRIVATE_ACTION", model: "PRIVATE_MODEL", decision: "PRIVATE_DECISION", exitCode: Infinity } as any);
  trace.event("PRIVATE_EVENT" as any, { tool: "bash" });
  trace.event("decision", null as any);
  trace.finish("ok");
  await trace.flush();
  expect(lines.join("")).not.toContain("PRIVATE_");
  expect(records().find((r) => r.kind === "tool_proposed")).toMatchObject({ tool: "computer_browser", action: "click", provider: "gemini", model: "gemini-3.8-flash" });
  expect(records().find((r) => r.kind === "tool_result").tool).toBeUndefined();
  expect(records().at(-1).outcome).toBe("ok");
});

test("gate, approval and actual execution get distinct monotonic spans", async () => {
  let clock = 0;
  const { trace, records } = memoryTrace({ now: () => clock });
  const gate = trace.span("gate", { tool: "bash" });
  clock = 350; gate({ outcome: "ok", decision: "approval" });
  const approval = trace.span("approval", { tool: "bash" });
  clock = 20_350; approval({ outcome: "ok", decision: "approved" });
  const execution = trace.span("tool_execution", { tool: "bash" });
  clock = 20_410; execution({ outcome: "failed", exitCode: 1 });
  execution({ outcome: "ok" }); // callbacks are idempotent
  trace.finish("failed");
  clock = 99_999;
  const summary = await trace.flush();
  expect(summary.elapsedMs).toBe(20_410);
  expect(summary.phases.gate).toEqual({ count: 1, totalMs: 350, failed: 0, interrupted: 0 });
  expect(summary.phases.approval?.totalMs).toBe(20_000);
  expect(summary.phases.tool_execution).toEqual({ count: 1, totalMs: 60, failed: 1, interrupted: 0 });
  expect(records().filter((r) => r.kind === "span_end").map((r) => r.durationMs)).toEqual([350, 20_000, 60]);
});

test("finish closes pending spans once and discards late callbacks and events", async () => {
  let clock = 1;
  const { trace, records } = memoryTrace({ now: () => clock });
  const end = trace.span("model", { model: "gpt-5.6-luna" });
  clock = 101; trace.finish("deadline");
  end({ outcome: "ok", outputTokens: 999 });
  trace.finish("ok"); trace.event("retry", { attempt: 1 });
  const summary = await trace.flush();
  expect(summary.activeSpans).toBe(0);
  expect(summary.phases.model).toEqual({ count: 1, totalMs: 100, failed: 1, interrupted: 1 });
  expect(records().filter((r) => r.kind === "run_end")).toHaveLength(1);
  expect(records().at(-1).outcome).toBe("deadline");
  expect(JSON.stringify(records())).not.toContain("999");
});

test("event and byte limits reserve a terminal summary and bounded aggregates", async () => {
  const capped = memoryTrace({ maxEvents: 6 });
  for (let i = 0; i < 100; i++) {
    const end = capped.trace.span("tool_execution", { tool: "bash" }); end({ outcome: "ok" });
  }
  capped.trace.finish("ok");
  const summary = await capped.trace.flush();
  expect(capped.records()).toHaveLength(6);
  expect(capped.records().at(-1).kind).toBe("run_end");
  expect(summary.dropped).toBe(196);
  expect(summary.phases.tool_execution?.count).toBe(100);
  const bytes = memoryTrace({ maxEvents: 4096, maxBytes: 4096 });
  for (let i = 0; i < 1000; i++) bytes.trace.event("tool_proposed", { tool: "computer_browser", action: "snapshot", model: "gemini-3.8-flash" });
  bytes.trace.finish("ok"); await bytes.trace.flush();
  expect(Buffer.byteLength(bytes.lines.join(""))).toBeLessThanOrEqual(4096);
  expect(bytes.records().at(-1).kind).toBe("run_end");
  expect(bytes.trace.summary().dropped).toBeGreaterThan(0);
});

test("write failures are contained and actions do not wait for a slow writer", async () => {
  const pending = Promise.withResolvers<void>();
  let calls = 0;
  const trace = createRunTrace({ hand: 1, write: async () => { calls++; await pending.promise; throw new Error("PRIVATE_DISK_ERROR"); } });
  trace.event("route", { model: "gpt-5.6-luna" }); trace.finish("ok");
  expect(trace.summary().finished).toBe(true);
  expect(trace.summary().written).toBe(0);
  pending.resolve();
  const summary = await trace.flush();
  expect(summary.ioError).toBe(true);
  expect(calls).toBe(1);
  expect(JSON.stringify(summary)).not.toContain("PRIVATE_DISK_ERROR");
});

test("real JSONL persists in sequence with distinct files for concurrent hands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "puk-trace-test-"));
  const traces = [createRunTrace({ hand: 1, directory }), createRunTrace({ hand: 2, directory })];
  try {
    for (const trace of traces) { trace.event("route", { provider: "openai", model: "gpt-5.6-luna" }); trace.finish("ok"); }
    const summaries = await Promise.all(traces.map((trace) => trace.flush()));
    expect(summaries.every((s) => !s.ioError && s.written === 3)).toBe(true);
    expect(await readdir(directory)).toHaveLength(2);
    for (const trace of traces) {
      const records = (await readFile(trace.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
      expect(records.every((r) => r.runId === trace.runId)).toBe(true);
    }
  } finally {
    await Promise.all(traces.map((trace) => unlink(trace.path).catch(() => {})));
    await rmdir(directory);
  }
});

test("shell exit failures cannot become success merely because isError is false", () => {
  const wrap = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }, { type: "image", data: "PRIVATE_IMAGE" }], details: {} });
  expect(toolTraceOutcome(wrap({ exitCode: 1, stderr: "PRIVATE_CONTACT: command not found" }), false)).toEqual({ outcome: "failed", exitCode: 1, failureClass: "command-unavailable" });
  expect(toolTraceOutcome(wrap({ exitCode: 1, stderr: "Python was not found; Microsoft Store alias PRIVATE_TASK" }))).toMatchObject({ outcome: "failed", failureClass: "python-alias-unavailable" });
  expect(toolTraceOutcome(wrap({ exitCode: 1, stderr: "ParserError PRIVATE_COMMAND" }))).toMatchObject({ outcome: "failed", failureClass: "shell-parser-or-quoting" });
  expect(toolTraceOutcome({ exitCode: 0, timedOut: true })).toMatchObject({ outcome: "deadline", failureClass: "timeout", timedOut: true });
  expect(toolTraceOutcome({ cancelled: true })).toMatchObject({ outcome: "cancelled", cancelled: true });
  expect(toolTraceOutcome(new Error("PRIVATE_CONTENT"), true)).toEqual({ outcome: "failed", failureClass: "tool-error" });
  expect(toolTraceOutcome(wrap({ exitCode: 0, stdout: "PRIVATE_MAIL" }))).toEqual({ outcome: "ok", exitCode: 0 });
});

test("disabled traces do not create files or writes", async () => {
  const { trace, lines } = memoryTrace({ enabled: false });
  trace.span("model")({ outcome: "ok" }); trace.event("route"); trace.finish("ok");
  expect((await trace.flush()).written).toBe(0);
  expect(lines).toHaveLength(0);
});
