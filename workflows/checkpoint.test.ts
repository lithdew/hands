import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask } from "../jev/jev";
import { mediaEvidenceMatches } from "./checkpoint";
import { runArtifactWorkflow, type ArtifactDependencies } from "./run";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const storyboard = JSON.stringify({ version: 1, title: "Evidence fixture", kind: "pitch", sources: [], scenes: [
  { id: "proof", title: "Actual evidence", visual: "evidence", durationSeconds: 30, artifactImage: "artifact-1" },
  { id: "close", title: "Next step", visual: "closing", durationSeconds: 30 },
] });
const ask: Ask = async (_state, questions) => Object.fromEntries(Object.entries(questions).map(([key, q]) => [key, {
  type: "choice", choice: key === "kind" ? "video" : key === "model" ? "gpt-6-astra" : Object.keys((q as any).criteria)[0], confidence: 1,
}])) as never;
const review = { passed: true, summary: "Fixture review", issues: [] };

test("media reuse hashes current used images, not their IDs or previous source paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "hands-image-hash-")), image = join(root, "current.png");
  const saved = { evidenceAssets: [{ id: "artifact-1", sha256: digest("original"), source: "previous/unused/path.png" }] };
  try {
    await writeFile(image, "original");
    expect(await mediaEvidenceMatches(storyboard, saved, { "artifact-1": image, unused: "missing.png" })).toBe(true);
    await writeFile(image, "replacement");
    expect(await mediaEvidenceMatches(storyboard, saved, { "artifact-1": image })).toBe(false);
    expect(await mediaEvidenceMatches(storyboard, saved)).toBe(false);
    expect(await mediaEvidenceMatches(storyboard, saved, { "artifact-1": join(root, "missing.png") })).toBe(false);
    await writeFile(image, "original");
    expect(await mediaEvidenceMatches(storyboard, { evidenceAssets: [] }, { "artifact-1": image })).toBe(false);
    const withSecond = JSON.parse(storyboard); withSecond.scenes[1].artifactImage = "artifact-2";
    expect(await mediaEvidenceMatches(JSON.stringify(withSecond), saved, { "artifact-1": image, "artifact-2": image })).toBe(false);
    const noImages = JSON.parse(storyboard); delete noImages.scenes[0].artifactImage;
    expect(await mediaEvidenceMatches(JSON.stringify(noImages), {})).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function checkpointFixture(root: string) {
  const id = crypto.randomUUID(), directory = join(root, id), image = join(root, "evidence.png");
  const files = [{ path: "index.html", content: "<!doctype html><title>Fixture</title>" }, { path: "storyboard.json", content: storyboard }];
  const bundle = { title: "Fixture", summary: "Fixture", entrypoint: "index.html", files, sources: [], limitations: [] };
  await mkdir(join(directory, "attempt-0"), { recursive: true }); await mkdir(join(directory, "files/media"), { recursive: true });
  await writeFile(image, "original");
  await writeFile(join(directory, "plan.json"), JSON.stringify({ title: "Fixture", kind: "video", brief: "Fixture", sources: [], requiredFiles: files.map(f => f.path), checks: ["Fixture"] }));
  await writeFile(join(directory, "sources.json"), JSON.stringify([{ url: "https://example.test/search", title: "Discovery fixture", kind: "search", status: "ok", retrievedAt: "2026-09-20" }]));
  await writeFile(join(directory, "attempt-0/bundle.json"), JSON.stringify(bundle));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ runId: id, events: [], checks: [{ name: "independent-content-review", passed: true }], files: files.map(f => ({ path: f.path, sha256: digest(f.content) })) }));
  // Deliberately mocked media: these tests exercise reuse dispatch, not codecs.
  await writeFile(join(directory, "files/media/video.mp4"), "saved-video-fixture");
  await writeFile(join(directory, "files/media/contact-sheet.png"), "saved-image-fixture");
  await writeFile(join(directory, "render.json"), JSON.stringify({ fullDecodePassed: true, sha256: digest("saved-video-fixture"), durationSeconds: 60, evidenceAssets: [{ id: "artifact-1", source: image, sha256: digest("original") }] }));
  return { id, directory, image };
}

for (const mode of ["same", "changed", "missing", "preview-only"] as const) test(`workflow media recovery: ${mode} evidence`, async () => {
  const root = await mkdtemp(join(tmpdir(), "hands-reuse-")); let rendered = 0;
  try {
    const fixture = await checkpointFixture(root);
    if (mode === "changed") await writeFile(fixture.image, "replacement");
    const dependencies: ArtifactDependencies = { outputRoot: root, ask, gather: async () => [], model: async () => ({ text: JSON.stringify(review), model: "gpt-6-astra" }), preview: async () => ({ checks: [], screenshots: [] }),
      render: async (_spec, output, options) => {
        rendered++;
        if (!options.evidenceAssets?.["artifact-1"]) throw new Error("Missing current evidence image");
        await mkdir(output); await writeFile(join(output, "contact-sheet.png"), "new-image-fixture");
        return { fullDecodePassed: true, durationSeconds: 60 };
      },
    };
    const input = { request: mode === "preview-only" ? `Create a video showcasing ${fixture.id}` : "Create a video", resumeRunId: fixture.id, executeOnly: true, reuseMedia: mode !== "preview-only", previewOnly: mode === "preview-only", evidenceAssets: mode === "same" || mode === "changed" ? { "artifact-1": fixture.image } : undefined };
    if (mode === "missing") {
      await expect(runArtifactWorkflow(input, dependencies)).rejects.toThrow("Missing current evidence image");
      expect(rendered).toBe(1);
    } else {
      const result = await runArtifactWorkflow(input, dependencies);
      expect(result.status).toBe("complete");
      expect(rendered).toBe(mode === "changed" ? 1 : 0);
      expect(result.events.some(e => e.event === "media_reused")).toBe(mode !== "changed");
      expect(result.events.some(e => e.event === "media_reuse_skipped")).toBe(mode === "changed");
      if (mode === "preview-only") {
        await writeFile(join(fixture.directory, "files/media/video.mp4"), "corrupted");
        await expect(runArtifactWorkflow(input, dependencies)).rejects.toThrow("full-decode manifest");
        expect(rendered).toBe(0);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reuse-media without a resume checkpoint fails before any model or routing call", async () => {
  const root = await mkdtemp(join(tmpdir(), "hands-reuse-no-id-"));
  try {
    await expect(runArtifactWorkflow({ request: "Create a video", reuseMedia: true }, { outputRoot: root, ask: async () => { throw new Error("Unexpected routing call"); } })).rejects.toThrow("--reuse-media with --resume");
  } finally { await rm(root, { recursive: true, force: true }); }
});
