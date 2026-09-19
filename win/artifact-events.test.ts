import { describe, expect, test } from "bun:test";
import type { ArtifactEvent } from "../workflows/run";
import { advance, artifactProgress, clock, duration, enrich, initialProgress, liveText, sourceName } from "./artifact-events";

const at = (atMs: number, event: string, phase: string, extra: Partial<ArtifactEvent> = {}): ArtifactEvent => ({ atMs, event, phase, ...extra });
const runId = "81d52de1-9fbc-4e46-8129-e9b98ce88d74";

describe("artifact events as feed lines", () => {
  test("formats run time and durations the way a person reads them", () => {
    expect(clock(0)).toBe("0:00"); expect(clock(7_400)).toBe("0:07"); expect(clock(372_000)).toBe("6:12"); expect(clock(3_723_000)).toBe("1:02:03");
    expect(duration(42_400)).toBe("42s"); expect(duration(65_000)).toBe("1m 05s");
    expect(sourceName("https://www.hkust.edu.hk/courses/math/outline.pdf")).toBe("hkust.edu.hk/outline.pdf");
    expect(sourceName("not a url")).toBe("not a url");
  });

  test("a video run reads as plain labels, one line per meaningful step, raw event names hidden", () => {
    const state = initialProgress();
    const lines = [
      at(0, "run_started", "routing"),
      at(3_000, "routed", "routing", { model: "gpt-5.6-luna" }),
      at(3_000, "phase", "planning"),
      at(3_000, "jev_handoff", "planning", { model: "gpt-5.6-luna" }),
      at(45_000, "agent_returned", "planning", { model: "gpt-5.6-luna", durationMs: 42_000 }),
      at(47_000, "phase", "jev_execution"),
      at(47_000, "jev_decision", "jev_execution", { detail: "research" }),
      at(47_000, "phase", "research"),
      at(48_000, "source", "research", { detail: "fetching https://arxiv.org/abs/1", count: 9 }),
      at(48_000, "source", "research", { detail: "fetching https://www.hkust.edu.hk/courses/outline.pdf", count: 9 }),
      at(50_000, "source", "research", { detail: "ok https://arxiv.org/abs/1", count: 9 }),
      at(52_000, "source", "research", { detail: "failed https://www.hkust.edu.hk/courses/outline.pdf — Source retrieval timed out.", count: 9 }),
      at(60_000, "phase", "creating"),
      at(60_000, "jev_handoff", "creating", { model: "gpt-6-astra" }),
      at(120_000, "agent_returned", "creating", { model: "gpt-6-astra", durationMs: 60_000 }),
      at(121_000, "phase", "saving"),
      at(121_000, "bundle_saved", "saving", { count: 6 }),
      at(121_000, "phase", "reviewing"),
      at(122_000, "phase", "review"),
      at(122_000, "jev_handoff", "review", { model: "gpt-6-astra" }),
      at(187_000, "agent_returned", "review", { model: "gpt-6-astra", durationMs: 65_000 }),
      at(187_000, "checks", "review", { count: 5, failed: 0, detail: "" }),
      at(190_000, "phase", "rendering"),
      at(191_000, "render", "rendering", { detail: "manim: {\"scene\":\"inverse-returns\"}" }),
      at(200_000, "render", "rendering", { detail: "render: {\"frames\":1728}" }),
      at(230_000, "render", "rendering", { detail: "Rendered 40%" }),
      at(231_000, "render", "rendering", { detail: "Rendered 40%" }),
      at(300_000, "render", "rendering", { detail: "verify-decode: \"\"" }),
      at(310_000, "checks", "rendering", { count: 7, failed: 0, detail: "" }),
      at(311_000, "phase", "previewing"),
      at(340_000, "checks", "previewing", { count: 22, failed: 0, detail: "" }),
      at(341_000, "phase", "visual-review"),
      at(341_000, "jev_handoff", "visual-review", { model: "gpt-6-astra" }),
      at(350_000, "agent_returned", "visual-review", { model: "gpt-6-astra", durationMs: 9_000 }),
      at(350_000, "visual_review", "visual-review", { count: 3, failed: 0, detail: "1/3 passed: Legible scene text" }),
      at(360_000, "jev_handoff", "visual-review", { model: "gpt-6-astra" }),
      at(370_000, "phase", "jev_execution"),
      at(371_000, "jev_decision", "jev_execution", { detail: "deliver", durationMs: 800 }),
      at(372_000, "phase", "complete"),
      at(372_000, "artifact_delivered", "complete", { count: 6 }),
    ].map(event => advance(state, event));
    expect(lines.filter(Boolean)).toEqual([
      "Choosing the artifact kind and specialist · 0:00",
      "Specialist: gpt-5.6-luna · 0:03",
      "Planning with gpt-5.6-luna · 0:03",
      "Plan returned in 42s · 0:45",
      "Jev: research · 0:47",
      "Fetching sources · 0:47",
      "Fetched 1/9 sources · 0:50",
      "Fetched 2/9 sources (1 failed: hkust.edu.hk/outline.pdf) · 0:52",
      "Writing with gpt-6-astra · 1:00",
      "Draft returned in 1m 00s · 2:00",
      "Saving files · 2:01",
      "Saved 6 files · 2:01",
      "Checking files · 2:01",
      "Reviewing content with gpt-6-astra · 2:02",
      "Content review returned in 1m 05s · 3:07",
      "Content review: 5 checks, 0 failed · 3:07",
      "Rendering video · 3:10",
      "ManimGL scene: inverse-returns · 3:11",
      "Rendering 1728 frames · 3:20",
      "Rendering video · 40% · 3:50",
      "Verifying the video decodes · 5:00",
      "Render: 7 checks, 0 failed · 5:10",
      "Previewing in a browser · 5:11",
      "Preview: 22 checks, 0 failed · 5:40",
      "Visual review 1 with gpt-6-astra · 5:41",
      "Visual review 1/3: passed — Legible scene text · 5:50",
      "Visual review 2/3 with gpt-6-astra · 6:00",
      "Jev: deliver · 6:11",
      "Complete · 23/23 checks passed · 6:12", // 22 preview checks plus the passed visual review
    ]);
    for (const line of lines.filter(Boolean)) expect(line).not.toMatch(/jev_handoff|agent_returned|jev_decision|artifact_delivered|run_failed|bundle_saved|visual_review|render-progress/);
    expect(state.phases).toEqual(["routing", "planning", "research", "creating", "saving", "reviewing", "review", "rendering", "previewing", "visual-review"]);
    expect(state.decision).toBe("deliver");
    expect(liveText("video", state)).toBe("video · complete · 23 checks passed");
  });

  test("live text stays compact through fetching, rendering and previewing", () => {
    const state = initialProgress();
    advance(state, at(1_000, "phase", "research"));
    expect(liveText("report", state)).toBe("report · fetching sources");
    for (let i = 0; i < 6; i++) advance(state, at(2_000 + i, "source", "research", { detail: `ok https://example.org/${i}`, count: 9 }));
    expect(liveText("report", state)).toBe("report · fetching sources 6/9");
    advance(state, at(10_000, "phase", "rendering"));
    expect(liveText("video", state)).toBe("video · rendering");
    advance(state, at(11_000, "render", "rendering", { detail: "manim: {\"scene\":\"opening\"}" }));
    expect(liveText("video", state)).toBe("video · rendering · manim opening");
    advance(state, at(12_000, "render", "rendering", { detail: "Rendered 40%" }));
    expect(liveText("video", state)).toBe("video · rendering 40%");
    advance(state, at(13_000, "phase", "previewing"));
    expect(liveText("website", state)).toBe("website · previewing");
    advance(state, at(14_000, "phase", "jev_execution"));
    expect(liveText("website", state)).toBe("website · Jev deciding");
    advance(state, at(15_000, "phase", "needs-review"));
    advance(state, at(15_000, "checks", "needs-review", { count: 22, failed: 2, detail: "visual-review-1, runtime-errors" }));
    expect(liveText("website", state)).toBe("website · needs review · 2 failed");
  });

  test("failures and cancellations say so once, with the reason", () => {
    const failed = initialProgress();
    expect(advance(failed, at(90_000, "phase", "failed"))).toBeNull();
    expect(advance(failed, at(90_000, "run_failed", "failed", { detail: "Artifact needs correction: the exam omits solutions." }))).toBe("Failed: Artifact needs correction: the exam omits solutions. · 1:30");
    const cancelled = initialProgress();
    advance(cancelled, at(5_000, "phase", "cancelled"));
    expect(advance(cancelled, at(5_000, "run_failed", "cancelled", { detail: "The operation was aborted." }))).toBe("Cancelled · 0:05");
    expect(advance(initialProgress(), at(1, "checks", "previewing", { count: 22, failed: 2, detail: "runtime-errors, visual-review-1" }))).toBe("Preview: 22 checks, 2 failed (runtime-errors, visual-review-1) · 0:00");
    expect(advance(initialProgress(), at(1, "source", "research", { detail: "ok" }))).toBe("Fetched 1/1 sources · 0:00");
    expect(advance(initialProgress(), at(1, "unknown_event", "routing"))).toBeNull();
  });

  test("enriched status carries the timeline the panel draws and prefers the runtime's own check tally", () => {
    const tracker = artifactProgress(() => 1_000_000);
    tracker.event(at(0, "run_started", "routing"));
    tracker.event(at(3_000, "phase", "planning"));
    tracker.event(at(40_000, "phase", "jev_execution"));
    tracker.event(at(40_000, "jev_decision", "jev_execution", { detail: "research" }));
    tracker.event(at(41_000, "phase", "research"));
    tracker.event(at(60_000, "checks", "research", { count: 3, failed: 1, detail: "x" }));
    const status = tracker.status({ runId, kind: "report", directory: "out/artifacts/x", phase: "research" });
    expect(status).toEqual({ runId, kind: "report", directory: "out/artifacts/x", phase: "research", startedAt: 1_000_000, elapsedMs: 60_000, progress: "fetching sources", timeline: ["routing", "planning"], checks: { passed: 2, failed: 1 }, decision: "research" });
    expect(tracker.text("report")).toBe("report · fetching sources");
    const done = enrich({ runId, kind: "report", directory: "d", phase: "complete", checks: { passed: 22, failed: 0 } }, tracker.state, 1_000_000);
    expect(done.checks).toEqual({ passed: 22, failed: 0 });
    expect(done.done).toBe(true);
    expect(status.done).toBeUndefined();
  });
});
