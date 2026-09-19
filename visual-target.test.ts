import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ASTRA } from "./model-policy";
import { createVisualTargetAssessor, type VisualTargetEvidence, type VisualTargetModel, type VisualTargetRequest } from "./visual-target";

function png(marker = 0) {
  const data = Buffer.alloc(25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.writeUInt32BE(1000, 16); data.writeUInt32BE(800, 20); data[24] = marker;
  return data.toString("base64");
}
const request = (): VisualTargetRequest => ({ frame: { targetKey: "fixture-owner", observationId: "capture-1", generation: 1,
  instructionRevision: 4, width: 1000, height: 800, image: { type: "image", mimeType: "image/png", data: png() } },
  action: { action: "canvas_click", delivery: "foreground", x: 80, y: 18 } });
const target = { category: "browser_tab", label: "Inbox", uncertainty: "low" } as const;
const answer = (value: unknown = { start: target, end: null }) => ({ text: JSON.stringify(value), stopReason: "stop", provider: "openai", model: ASTRA });

test("assessment sends the exact image to Astra low and returns bound, explicitly inferred evidence only", async () => {
  const state = request(), seen: { prompt: string; options: Parameters<VisualTargetModel>[1] }[] = [];
  const assessor = createVisualTargetAssessor(async (prompt, options) => { seen.push({ prompt, options }); return answer(); });
  const evidence = await assessor.assess(() => state);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.options).toMatchObject({ provider: "openai", model: ASTRA, effort: "low", maxTokens: 900, timeoutMs: 15000 });
  expect(Buffer.from(seen[0]!.options.image).toString("base64")).toBe(state.frame.image.data);
  expect(seen[0]!.prompt).toContain('"x":80,"y":18');
  expect(seen[0]!.prompt).toContain("including browser chrome");
  expect(evidence).toMatchObject({ kind: "model-inference", inference: { start: target, end: null }, binding: { observationId: "capture-1", generation: 1, instructionRevision: 4 } });
  expect(evidence.binding.imageSha256).toBe(createHash("sha256").update(Buffer.from(png(), "base64")).digest("hex"));
  expect(evidence.evidencePolicy).toContain("not ground truth or authorization");
  expect(evidence).not.toHaveProperty("allow"); expect(evidence).not.toHaveProperty("permission");
  expect(Object.isFrozen(evidence.inference.start)).toBe(true);
  assessor.assertCurrent(evidence, () => state);
  let mutations = 0;
  assessor.consume(evidence, () => state); mutations++;
  expect(() => { assessor.consume(evidence, () => state); mutations++; }).toThrow("consumed");
  expect(mutations).toBe(1);
});

test("a drag describes both exact endpoints and never claims its intervening path", async () => {
  const state = request(); state.action = { action: "canvas_drag", delivery: "foreground", x: 20, y: 100, to_x: 300, to_y: 500 };
  const end = { category: "canvas", label: "Blank canvas", uncertainty: "low" } as const;
  const assessor = createVisualTargetAssessor(async prompt => { expect(prompt).toContain('"to_x":300,"to_y":500'); return answer({ start: target, end }); });
  const evidence = await assessor.assess(() => state);
  expect(evidence.inference.end).toEqual(end); expect(evidence.evidencePolicy).toContain("not the intervening path");
  await expect(createVisualTargetAssessor(async () => answer()).assess(() => state)).rejects.toThrow("endpoints");
  await expect(createVisualTargetAssessor(async () => answer({ start: target, end: { ...end, uncertainty: "high" } })).assess(() => state)).rejects.toThrow("unclear");
});

test("unclear, malformed, overlong, permission-bearing and incomplete model responses fail without fallback", async () => {
  for (const response of [
    answer({ start: { ...target, uncertainty: "medium" }, end: null }),
    answer({ start: { ...target, category: "unknown" }, end: null }),
    answer({ start: target, end: null, permission: "approved" }),
    answer({ start: { ...target, label: "x".repeat(181) }, end: null }),
    answer({ start: target, end: target }),
    { ...answer(), text: "not JSON" }, { ...answer(), text: "x".repeat(2501) },
    { ...answer(), stopReason: "length" }, { ...answer(), stopReason: "error" },
    { ...answer(), model: "unapproved-model" }, { ...answer(), provider: "other" },
  ]) {
    let calls = 0;
    const assessor = createVisualTargetAssessor(async () => { calls++; return response; });
    await expect(assessor.assess(request)).rejects.toThrow(); expect(calls).toBe(1);
  }
});

test("missing images, inconsistent geometry and invalid pointers fail before a model call", async () => {
  for (const mutate of [
    (state: VisualTargetRequest) => { state.frame.image.data = ""; },
    (state: VisualTargetRequest) => { state.frame.image.data = "not png"; },
    (state: VisualTargetRequest) => { state.frame.width = 200; },
    (state: VisualTargetRequest) => { state.frame.generation = -1; },
    (state: VisualTargetRequest) => { state.action.x = 1000; },
    (state: VisualTargetRequest) => { state.action.x = 0; state.action.y = 0; },
    (state: VisualTargetRequest) => { state.action = { action: "canvas_drag", delivery: "foreground", x: 20, y: 30, to_x: 20, to_y: 30 }; },
  ]) {
    let calls = 0; const state = request(); mutate(state);
    const assessor = createVisualTargetAssessor(async () => { calls++; return answer(); });
    await expect(assessor.assess(() => state)).rejects.toThrow(); expect(calls).toBe(0);
  }
  await expect(createVisualTargetAssessor(async () => answer()).assess(() => undefined)).rejects.toThrow("current exact canvas image");
});

test("every capture or action identity change during inference rejects stale evidence", async () => {
  for (const mutate of [
    (state: VisualTargetRequest) => { state.frame.image.data = png(1); },
    (state: VisualTargetRequest) => { state.frame.observationId = "capture-2"; },
    (state: VisualTargetRequest) => { state.frame.generation++; },
    (state: VisualTargetRequest) => { state.frame.instructionRevision++; },
    (state: VisualTargetRequest) => { state.frame.targetKey = "different-owner"; },
    (state: VisualTargetRequest) => { state.action.x++; },
  ]) {
    const state = request(), pending = Promise.withResolvers<ReturnType<typeof answer>>();
    const assessor = createVisualTargetAssessor(() => pending.promise);
    const result = assessor.assess(() => state);
    mutate(state); pending.resolve(answer());
    await expect(result).rejects.toThrow("changed during visual assessment");
  }
});

test("a late change before dispatch, reset, or a forged receipt cannot pass the consumption guard", async () => {
  for (const change of ["image", "generation", "instruction", "action", "missing", "reset", "forged"] as const) {
    let state: VisualTargetRequest | undefined = request(), mutations = 0;
    const assessor = createVisualTargetAssessor(async () => answer());
    let evidence = await assessor.assess(() => state);
    if (change === "image") state.frame.image.data = png(1);
    if (change === "generation") state.frame.generation++;
    if (change === "instruction") state.frame.instructionRevision++;
    if (change === "action") state.action.x++;
    if (change === "missing") state = undefined;
    if (change === "reset") assessor.reset();
    if (change === "forged") evidence = structuredClone(evidence) as VisualTargetEvidence;
    expect(() => { assessor.consume(evidence, () => state); mutations++; }).toThrow();
    expect(mutations).toBe(0);
  }
});

test("cancellation and replacement end pending inference even if the model ignores abort", async () => {
  const never = Promise.withResolvers<ReturnType<typeof answer>>();
  let modelSignal: AbortSignal | undefined, calls = 0;
  const assessor = createVisualTargetAssessor(async (_prompt, options) => { calls++; modelSignal = options.signal; return never.promise; });
  const abort = new AbortController(), pending = assessor.assess(request, abort.signal);
  abort.abort(new Error("fixture cancellation"));
  await expect(pending).rejects.toThrow("fixture cancellation"); expect(modelSignal?.aborted).toBe(true); expect(calls).toBe(1);
  const before = new AbortController(); before.abort(new Error("already cancelled"));
  await expect(assessor.assess(request, before.signal)).rejects.toThrow("already cancelled"); expect(calls).toBe(1);
  const prior = assessor.assess(request); assessor.reset();
  await expect(prior).rejects.toThrow("superseded");
  never.resolve(answer());
});

test("a newer assessment invalidates earlier evidence and pending results", async () => {
  let calls = 0; const pending = Promise.withResolvers<ReturnType<typeof answer>>();
  const assessor = createVisualTargetAssessor(async () => ++calls === 2 ? pending.promise : answer());
  const first = await assessor.assess(request), second = assessor.assess(request);
  expect(() => assessor.consume(first, request)).toThrow("stale");
  const third = assessor.assess(request);
  await expect(second).rejects.toThrow("newer visual target assessment");
  assessor.consume(await third, request); pending.resolve(answer());
  expect(calls).toBe(3);
});
