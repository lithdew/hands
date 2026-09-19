/**
 * Pure: artifact workflow events (workflows/run.ts) -> what a person watching
 * the panel, the corner preview caption or the F8 HUD should read.
 *
 * `advance` folds one event into a small progress state and returns at most
 * one feed line for it (null for noise); `liveText` is the compact status the
 * PIP caption and HUD show; `enrich` adds the timeline to AgentStatus.artifact.
 */
import type { AgentStatus } from "../ai";
import type { ArtifactEvent } from "../workflows/run";

export type ArtifactStatus = NonNullable<AgentStatus["artifact"]>;
export type ArtifactProgressState = {
  phase: string; atMs: number;
  /** Completed phases in order, raw names; Jev's decision pauses are not phases a person needs. */
  phases: string[];
  sources: { total: number; started: number; done: number; failed: number; failures: string[] };
  render: { percent: number | null; step: string | null };
  checks: { passed: number; failed: number } | null;
  visual: { done: number; total: number };
  decision: string | null;
};

const PHASE_WORDS: Record<string, string> = {
  routing: "routing", planning: "planning", "plan-contract-repair": "repairing plan", jev_execution: "Jev deciding",
  research: "fetching sources", creating: "writing", repair: "repairing", saving: "saving files", reviewing: "checking files",
  review: "content review", rendering: "rendering", previewing: "previewing", "visual-review": "visual review",
  complete: "complete", "needs-review": "needs review", failed: "failed", cancelled: "cancelled",
};
/** Phases that a model turn follows at once: their line is the hand-off ("Planning with ..."), not the bare phase. */
const HANDOFF_PHASES: Record<string, { verb: string; noun: string }> = {
  planning: { verb: "Planning", noun: "Plan" }, "plan-contract-repair": { verb: "Repairing the plan", noun: "Plan repair" },
  creating: { verb: "Writing", noun: "Draft" }, repair: { verb: "Repairing", noun: "Repair" }, review: { verb: "Reviewing content", noun: "Content review" },
  "visual-review": { verb: "Visual review", noun: "Visual review" },
};
const PHASE_LINES: Record<string, string> = { research: "Fetching sources", saving: "Saving files", reviewing: "Checking files", rendering: "Rendering video", previewing: "Previewing in a browser", complete: "Complete", "needs-review": "Saved for review" };
const CHECK_STAGES: Record<string, string> = { reviewing: "Content review", review: "Content review", rendering: "Render", previewing: "Preview", "visual-review": "Visual review" };
export const TERMINAL_PHASES = ["complete", "needs-review", "failed", "cancelled"];

export const phaseWord = (phase: string): string => PHASE_WORDS[phase] ?? phase.replace(/[-_]+/g, " ");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Run-relative time as a person reads it: 0:07, 6:12, 1:02:03. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000)), s = total % 60, m = Math.floor(total / 60) % 60, h = Math.floor(total / 3600);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
/** A duration in prose: 42s, 1m 05s. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}
/** A source as the feed names it: host and last path segment, never a whole URL. */
export function sourceName(url: string): string {
  try {
    const u = new URL(url), last = u.pathname.split("/").filter(Boolean).at(-1) ?? "";
    return `${u.hostname.replace(/^www\./, "")}${last ? `/${last.slice(0, 32)}` : ""}`;
  } catch { return url.slice(0, 40); }
}

export const initialProgress = (): ArtifactProgressState => ({
  phase: "routing", atMs: 0, phases: [], sources: { total: 0, started: 0, done: 0, failed: 0, failures: [] },
  render: { percent: null, step: null }, checks: null, visual: { done: 0, total: 0 }, decision: null,
});

/** Human words for one render progress detail from workflows/media/render.ts. */
function renderStep(detail: string): { line: string; step: string; percent?: number } | null {
  const pct = /^Rendered (\d+)%$/.exec(detail);
  if (pct) return { line: `Rendering video · ${pct[1]}%`, step: `${pct[1]}%`, percent: Number(pct[1]) };
  const split = detail.indexOf(":"), name = split < 0 ? detail : detail.slice(0, split), rest = split < 0 ? "" : detail.slice(split + 1).trim();
  let data: Record<string, unknown> = {};
  try { const parsed = JSON.parse(rest); if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>; } catch { /* plain text detail */ }
  switch (name) {
    case "manim": { const scene = typeof data.scene === "string" ? data.scene : rest; return { line: `ManimGL scene: ${scene}`, step: `manim ${scene}` }; }
    case "bundle": return { line: "Bundling the video composition", step: "bundling" };
    case "browser": return { line: "Opening the render browser", step: "opening browser" };
    case "render": return { line: typeof data.frames === "number" ? `Rendering ${data.frames} frames` : "Rendering frames", step: "0%", percent: 0 };
    case "verify-decode": return { line: "Verifying the video decodes", step: "verifying decode" };
    case "complete": return { line: `Render complete${typeof data.durationSeconds === "number" ? ` · ${Math.round(data.durationSeconds)}s of video` : ""}`, step: "rendered" };
    default: return name ? { line: `Render: ${name.replace(/[-_]+/g, " ")}`, step: name.replace(/[-_]+/g, " ") } : null;
  }
}

/** Fold one workflow event into `state`; the returned line (with run time) is for the activity feed, null is noise. */
export function advance(state: ArtifactProgressState, event: ArtifactEvent): string | null {
  state.atMs = Math.max(state.atMs, event.atMs);
  if (event.phase !== state.phase) {
    if (state.phase !== "jev_execution" && !state.phases.includes(state.phase)) state.phases.push(state.phase);
    state.phase = event.phase;
    if (event.phase === "visual-review" && state.phases.at(-1) !== "visual-review") state.visual.done = 0;
  }
  const at = ` · ${clock(event.atMs)}`;
  const detail = event.detail ?? "";
  switch (event.event) {
    case "run_started": return `Choosing the artifact kind and specialist${at}`;
    case "checkpoint_loaded": return `Resuming run ${detail.slice(0, 8)}${event.count ? ` (${event.count} files)` : ""}${at}`;
    case "routed": return `Specialist: ${event.model ?? "chosen"}${at}`;
    case "phase": {
      const line = PHASE_LINES[event.phase];
      if (!line) return null;
      if (event.phase === "complete" || event.phase === "needs-review") {
        const c = state.checks;
        return `${line}${c ? ` · ${c.passed}/${c.passed + c.failed} checks passed` : ""}${at}`;
      }
      return `${line}${at}`;
    }
    case "jev_handoff": {
      const role = HANDOFF_PHASES[event.phase];
      const verb = role ? role.verb : cap(phaseWord(event.phase));
      const which = event.phase === "visual-review" ? ` ${state.visual.done + 1}${state.visual.total ? `/${state.visual.total}` : ""}` : "";
      return `${verb}${which}${event.model ? ` with ${event.model}` : ""}${at}`;
    }
    case "agent_returned": {
      if (event.phase === "visual-review") return null; // its verdict line follows
      const noun = HANDOFF_PHASES[event.phase]?.noun ?? cap(phaseWord(event.phase));
      return `${noun} returned${event.durationMs != null ? ` in ${duration(event.durationMs)}` : ""}${at}`;
    }
    case "jev_decision": state.decision = detail || null; return detail ? `Jev: ${detail}${at}` : null;
    case "source": {
      const m = /^(fetching|ok|failed)(?:\s+(\S+))?(?:\s+—\s+(.*))?$/.exec(detail);
      if (!m) return null;
      const s = state.sources;
      if (event.count) s.total = Math.max(s.total, event.count);
      if (m[1] === "fetching") { s.started++; s.total = Math.max(s.total, s.started); return null; }
      s.done++; s.total = Math.max(s.total, s.done);
      if (m[1] === "failed") { s.failed++; if (m[2] && s.failures.length < 4) s.failures.push(sourceName(m[2])); }
      return `Fetched ${s.done}/${s.total} sources${s.failed ? ` (${s.failed} failed${s.failures.length ? `: ${s.failures.join(", ")}` : ""})` : ""}${at}`;
    }
    case "sources_reused": return `Reused ${event.count ?? 0} sources from the previous run${at}`;
    case "bundle_reused": return `Reused ${event.count ?? 0} files from the previous run${at}`;
    case "bundle_saved": return `Saved ${event.count ?? 0} files${at}`;
    case "media_reused": return `Reused the rendered video from run ${detail.slice(0, 8)}${at}`;
    case "media_reuse_skipped": return `Rendering again: the evidence images changed${at}`;
    case "render": {
      const step = renderStep(detail);
      if (!step) return null;
      if (step.percent != null) { if (step.percent === state.render.percent) return null; state.render.percent = step.percent; }
      state.render.step = step.step;
      return `${step.line}${at}`;
    }
    case "checks": {
      const total = event.count ?? 0, failed = event.failed ?? 0;
      state.checks = { passed: Math.max(0, total - failed), failed };
      return `${CHECK_STAGES[event.phase] ?? "Checks"}: ${total} checks, ${failed} failed${failed && detail ? ` (${detail})` : ""}${at}`;
    }
    case "visual_review": {
      if (event.count) state.visual.total = event.count;
      state.visual.done++;
      const m = /^(\d+)\/(\d+)\s+(passed|failed)(?::\s*(.*))?$/.exec(detail);
      // Visual reviews are checks too: the closing tally must not read "33/33 passed" after a failed review.
      if (m) state.checks = { passed: (state.checks?.passed ?? 0) + (m[3] === "passed" ? 1 : 0), failed: (state.checks?.failed ?? 0) + (m[3] === "failed" ? 1 : 0) };
      if (!m) return `Visual review ${state.visual.done}${state.visual.total ? `/${state.visual.total}` : ""}${at}`;
      return `Visual review ${m[1]}/${m[2]}: ${m[3]}${m[4] ? ` — ${m[4].slice(0, 120)}` : ""}${at}`;
    }
    case "artifact_delivered": return null; // the complete / needs-review phase line says it
    case "run_failed": return event.phase === "cancelled" ? `Cancelled${at}` : `Failed: ${detail.slice(0, 200) || "the artifact run stopped"}${at}`;
    default: return null;
  }
}

/** Compact live status without the kind: "rendering 40%", "fetching sources 6/9", "previewing". */
export function progressText(state: ArtifactProgressState): string {
  const word = phaseWord(state.phase);
  switch (state.phase) {
    case "research": return state.sources.total ? `${word} ${state.sources.done}/${state.sources.total}` : word;
    case "rendering": return state.render.percent != null ? `${word} ${state.render.percent}%` : state.render.step ? `${word} · ${state.render.step}` : word;
    case "visual-review": return `${word} ${Math.min(state.visual.done + 1, Math.max(state.visual.total, state.visual.done + 1))}${state.visual.total ? `/${state.visual.total}` : ""}`;
    case "complete": return state.checks ? `${word} · ${state.checks.passed} checks passed` : word;
    case "needs-review": return state.checks?.failed ? `${word} · ${state.checks.failed} failed` : word;
    default: return word;
  }
}
/** What the corner preview caption and the HUD progress line read: "video · rendering 40%". */
export const liveText = (kind: string, state: ArtifactProgressState): string => `${kind} · ${progressText(state)}`;

/** AgentStatus.artifact with the timeline the panel draws. Counts from the runtime's own status win over the event tally. */
export function enrich(artifact: ArtifactStatus, state: ArtifactProgressState, startedAt: number): ArtifactStatus {
  const checks = artifact.checks ?? state.checks ?? undefined;
  return {
    ...artifact, startedAt, elapsedMs: state.atMs, progress: progressText(state), timeline: state.phases.map(phaseWord),
    ...(checks ? { checks } : {}), ...(state.decision ? { decision: state.decision } : {}), ...(TERMINAL_PHASES.includes(artifact.phase) ? { done: true } : {}),
  };
}

/** One run's tracker for win/jev.ts: feed lines from events, enriched status, live caption text. */
export function artifactProgress(now: () => number = Date.now) {
  const state = initialProgress(), startedAt = now();
  return {
    state,
    event: (event: ArtifactEvent) => advance(state, event),
    status: (artifact: ArtifactStatus) => enrich(artifact, state, startedAt),
    text: (kind: string) => liveText(kind, state),
  };
}
