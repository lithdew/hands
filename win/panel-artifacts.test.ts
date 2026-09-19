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
    expect(html).toContain('sandbox="allow-scripts" referrerpolicy="no-referrer"');
    expect(html).not.toContain('sandbox="allow-scripts allow-same-origin"');
  });

  test("reuses one preview across progress polls and clears it on task or hand changes", () => {
    const actions: string[] = [];
    const frame = {
      removeAttribute: (name: string) => actions.push(`remove:${name}`),
      set src(value: string) { actions.push(`src:${value}`); },
    };
    const sync = new Function("artifactPreview", "$", `let artifactPreviewKey = null; ${functionSource("syncArtifactPreview", "loadPreview")} return syncArtifactPreview;`)(frame, () => ({ append: () => actions.push("stash") }));
    const artifact = { runId, url: `/artifacts/${runId}/index.html` };
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
});
