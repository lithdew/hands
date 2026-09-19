import { describe, expect, test } from "bun:test";

const html = await Bun.file(new URL("./panel.html", import.meta.url)).text();
const runId = "81d52de1-9fbc-4e46-8129-e9b98ce88d74";
const origin = "http://127.0.0.1:7777";
const functionSource = (start: string, end: string) => html.slice(html.indexOf(`function ${start}(`), html.indexOf(`function ${end}(`));
const artifactOf = new Function("location", `${functionSource("artifactOf", "openArtifact")} return artifactOf;`)({ origin });

describe("artifact preview selection", () => {
  test("keeps an unfinished artifact visible without offering an unrelated browser", () => {
    expect(artifactOf({ artifact: { runId, kind: "video", phase: "rendering" } })).toEqual({ runId, kind: "video", phase: "rendering", url: null });
    expect(artifactOf({})).toBeNull();
    expect(html).toContain("if (!selectedArtifact && !pendingShot");
    expect(html).toContain("selectedTarget !== target || selectedArtifact || browserChanging");
    expect(html).toContain("if (nextArtifact || selectedArtifact) invalidatePreview()");
  });

  test("allows only the same run's local artifact preview URL", () => {
    const artifact = { runId, kind: "website", phase: "complete", previewUrl: `/artifacts/${runId}/index.html` };
    expect(artifactOf({ artifact }).url).toBe(artifact.previewUrl);
    for (const previewUrl of ["https://example.test/", "/task", `/artifacts/${runId}/../other/index.html`, `/artifacts/${runId}/%2e%2e%2ftask`, `/artifacts/${runId}/index.html?control=/stop`, `/artifacts/${runId}/index.html#oops`, `/artifacts/${runId}/index.html%3asecret`]) {
      expect(artifactOf({ artifact: { ...artifact, previewUrl } }).url).toBeNull();
    }
    expect(artifactOf({ artifact: { ...artifact, runId: "../../outside" } })).toBeNull();
    expect(html).toContain('sandbox="allow-scripts" allow="fullscreen" allowfullscreen referrerpolicy="no-referrer"');
    expect(html).not.toContain('sandbox="allow-scripts allow-same-origin"');
    const artifactFrame = html.match(/<iframe id="artifact-preview"[^>]*>/)?.[0] ?? "";
    expect(artifactFrame.match(/allow="([^"]*)"/)?.[1]).toBe("fullscreen");
    expect(artifactFrame.match(/sandbox="([^"]*)"/)?.[1]).toBe("allow-scripts");
  });

  test("reuses one preview across progress polls and clears it on task or hand changes", () => {
    const actions: string[] = [];
    const frame = {
      removeAttribute: (name: string) => actions.push(`remove:${name}`),
      set src(value: string) { actions.push(`src:${value}`); },
    };
    const sync = new Function("artifactPreview", "$", `let artifactPreviewKey = null, artifactPreviewReady = false; ${functionSource("syncArtifactPreview", "loadPreview")} return syncArtifactPreview;`)(frame, () => ({ append: () => actions.push("stash") }));
    const artifact = { runId, url: `/artifacts/${runId}/index.html`, phase: "previewing" };
    sync(1, artifact);
    expect(actions).toEqual(["remove:src", "stash", `src:${artifact.url}`]);
    sync(1, { ...artifact, phase: "complete" });
    expect(actions).toHaveLength(3);
    sync(2, artifact);
    expect(actions).toHaveLength(6);
    sync(2, null);
    expect(actions.slice(-2)).toEqual(["remove:src", "stash"]);
    const count = actions.length;
    sync(2, null);
    expect(actions).toHaveLength(count);
  });

  test("reloads an early preview once when media becomes available without restarting playback on polls", () => {
    const sources: string[] = [];
    const frame = { removeAttribute() {}, set src(value: string) { sources.push(value); } };
    const sync = new Function("artifactPreview", "$", `let artifactPreviewKey = null, artifactPreviewReady = false; ${functionSource("syncArtifactPreview", "loadPreview")} return syncArtifactPreview;`)(frame, () => ({ append() {} }));
    const artifact = { runId, url: `/artifacts/${runId}/index.html`, phase: "rendering" };
    sync(1, artifact);
    sync(1, artifact);
    expect(sources).toHaveLength(1);
    sync(1, { ...artifact, phase: "previewing" });
    expect(sources).toHaveLength(2);
    for (const phase of ["visual-review", "jev_execution", "complete", "complete"]) sync(1, { ...artifact, phase });
    expect(sources).toHaveLength(2);
    sync(1, null);
    sync(1, { ...artifact, phase: "complete" });
    expect(sources).toHaveLength(3);
  });

  test("draws the run's timeline from the enriched status and ignores malformed extras", () => {
    const { artifactOf: of, artifactTimeline } = new Function("location", `${functionSource("artifactOf", "openArtifact")} return { artifactOf, artifactTimeline };`)({ origin });
    const artifact = of({ artifact: { runId, kind: "video", phase: "rendering", progress: "rendering 40%", timeline: ["routing", "planning", 7, "writing"], checks: { passed: 5, failed: 0 }, decision: "execute", startedAt: 1_000, elapsedMs: 200_000 } });
    expect(artifact.progress).toBe("rendering 40%");
    expect(artifact.timeline).toEqual(["routing", "planning", "writing"]);
    expect(artifact.checks).toEqual({ passed: 5, failed: 0 });
    expect(artifactTimeline(artifact, 373_000)).toEqual({ done: ["routing", "planning", "writing"], current: "rendering 40%", meta: "6:12 · 5 checks, 0 failed · Jev: execute", failed: false });
    const finished = of({ artifact: { runId, kind: "report", phase: "needs-review", progress: "needs review · 2 failed", checks: { passed: 20, failed: 2 }, decision: "stop", startedAt: 1_000, elapsedMs: 65_000, done: true } });
    expect(artifactTimeline(finished, 9_999_999)).toEqual({ done: [], current: "needs review · 2 failed", meta: "1:05 · 22 checks, 2 failed · Jev: stop", failed: true });
    expect(of({ artifact: { runId, kind: "report", phase: "planning", checks: { passed: "5" }, timeline: "planning", progress: 4 } })).toEqual({ runId, kind: "report", phase: "planning", url: null });
    expect(html).toContain("el('span', 'tile-phases')");
    expect(html).toContain("renderTimeline(tile.querySelector('.tile-phases'), artifact)");
    expect(html).toContain(".tile-phases:empty{display:none}");
    expect(html).toContain("artifact.kind + ' · ' + (artifact.progress || artifact.phase)");
  });

  test("a phone-width window wraps the answer and header instead of scrolling sideways", () => {
    expect(html).toContain(".main{grid-template-columns:minmax(0,1fr)}");
    expect(html).toContain(".hints span{white-space:normal}");
    expect(html).toContain(".deck,.stage-in,.reply,.card,#approvals{min-width:0}");
    expect(html).toMatch(/#answer\{[^}]*overflow-wrap:anywhere/);
    expect(html).toMatch(/#voice\{[^}]*overflow-wrap:anywhere/);
    expect(html).toMatch(/\.card pre\{[^}]*overflow-wrap:anywhere/);
  });

  test("keeps task errors visible while hiding an unrelated browser reconnect error from artifacts", () => {
    const error = new Function(`${functionSource("panelError", "openArtifact")} return panelError;`)();
    const status = { hand: 1, listener: {} };
    const browser = { error: "Chrome needs reconnection" };
    const local = { hand: 1, message: "Changing browser failed" };
    expect(error(status, {}, browser, { runId }, local)).toBe("");
    expect(error(status, { error: "Render failed" }, browser, { runId }, local)).toBe("Render failed");
    expect(error({ ...status, lastError: "Microphone failed" }, {}, browser, { runId }, local)).toBe("Microphone failed");
    expect(error(status, {}, browser, null, local)).toBe("Changing browser failed");
    expect(error(status, {}, browser, null, { ...local, hand: 2 })).toBe("Chrome needs reconnection");
  });
});
