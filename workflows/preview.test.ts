import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewArtifacts, previewBrowserExecutable } from "./preview";

let directory: string, outputDir: string, base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "hands-preview-test-"));
  directory = join(base, "files"); outputDir = join(base, "preview");
  await mkdir(directory);
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });
const options = () => ({ directory, outputDir, entrypoint: "index.html" });
const html = (body: string, extra = "") => `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Generated test artifact</title><style>body{margin:0;padding:24px;font:18px/1.5 system-ui;box-sizing:border-box}*{box-sizing:border-box}img{max-width:100%}</style>${extra}<body>${body}</body></html>`;

describe("isolated generated artifact preview", () => {
  test("invalid or missing entrypoints fail before launching a browser", async () => {
    const missing = await previewArtifacts(options());
    expect(missing.checks[0]?.name).toBe("preview-entrypoint");
    expect(missing.checks[0]?.passed).toBe(false);
    const escape = await previewArtifacts({ ...options(), entrypoint: "../secret.html" });
    expect(escape.checks[0]?.passed).toBe(false);
    expect(escape.screenshots).toEqual([]);
  });

  test("already-cancelled previews make no browser or output", async () => {
    const controller = new AbortController(); controller.abort(new Error("Stop this artifact"));
    await expect(previewArtifacts({ ...options(), signal: controller.signal })).rejects.toThrow("Stop this artifact");
  });

  test.skipIf(!previewBrowserExecutable())("renders responsive pages at both requested sizes with the product sandbox", async () => {
    await writeFile(join(directory, "index.html"), html('<h1>Actual generated artifact</h1><p id="about">This is a local preview.</p><a href="#about">About</a> <a href="project.html">Project</a><p id="script-check"></p>', '<script>addEventListener("DOMContentLoaded",()=>{document.getElementById("script-check").textContent="Script rendered"})</script>'));
    await writeFile(join(directory, "project.html"), html('<h1>Project page</h1><a href="index.html">Home</a>'));
    const result = await previewArtifacts(options());
    expect(result.checks.filter(check => !check.passed)).toEqual([]);
    expect(result.screenshots).toHaveLength(4);
    for (const path of result.screenshots) expect((await Bun.file(path).arrayBuffer()).byteLength).toBeGreaterThan(2000);
    expect(result.checks.find(check => check.name === "local-navigation")?.detail).toContain("2 HTML page(s)");
    expect(result.checks.find(check => check.name === "automated-preview-scope")?.detail).toContain("not a visual quality");
  }, 45_000);

  test.skipIf(!previewBrowserExecutable())("reports overflow, broken navigation/assets and generated JavaScript errors", async () => {
    await writeFile(join(directory, "index.html"), html('<h1>Defective artifact</h1><div style="width:1700px">Too wide</div><a href="missing.html">Missing page</a><a href="#missing-anchor">Missing anchor</a><img src="missing.png" width="200" height="100"><script>throw new Error("generated bug")</script>'));
    const result = await previewArtifacts(options());
    for (const name of ["desktop-overflow", "mobile-overflow", "local-navigation", "loaded-assets", "runtime-errors"]) {
      expect(result.checks.find(check => check.name === name)?.passed).toBe(false);
    }
    expect(result.checks.find(check => check.name === "runtime-errors")?.detail).toContain("generated bug");
    expect(result.screenshots).toHaveLength(2);
  }, 45_000);

  test.skipIf(!previewBrowserExecutable())("media request cancellation tolerance does not accept an unplayable video", async () => {
    await writeFile(join(directory, "index.html"), html('<h1>Broken lesson video</h1><video controls preload="auto" src="invalid.mp4" style="max-width:100%"></video>'));
    await writeFile(join(directory, "invalid.mp4"), "This is not a video.");
    const result = await previewArtifacts(options());
    for (const name of ["desktop-video-playback", "mobile-video-playback"]) {
      expect(result.checks.find(check => check.name === name)?.passed).toBe(false);
    }
  }, 45_000);

  test.skipIf(!previewBrowserExecutable())("generated code cannot fetch a control API or escape to external network", async () => {
    await writeFile(join(directory, "index.html"), html('<h1>Contained preview</h1><script>fetch("/task", {method:"POST",body:"bad"}).catch(()=>{}); fetch("https://example.test/").catch(()=>{})</script><img src="https://example.test/private.png">'));
    const result = await previewArtifacts(options());
    expect(result.checks.find(check => check.name === "runtime-errors")?.passed).toBe(false);
    expect(result.checks.find(check => check.name === "runtime-errors")?.detail).toMatch(/Content Security Policy|connect-src|Refused/i);
    expect(result.screenshots).toHaveLength(2);
  }, 45_000);
});
