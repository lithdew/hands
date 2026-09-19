// render.mjs — script.json in, out.mp4 and one still per scene out. Run by node (Remotion's renderer), from the kit's build.
//
//   node render.mjs <script.json> <outDir> [--only=stills|video] [--scale=1] [--concurrency=4] [--seconds=N]
//
// Bundles once, renders the stills first (a broken scene fails in seconds, not after the whole video),
// then the video. The last line printed is JSON: what was made and how long each part took.

import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [scriptPath, outDir, ...flags] = process.argv.slice(2);
const flag = (name, otherwise) => flags.find((f) => f.startsWith(`--${name}=`))?.split("=")[1] ?? otherwise;
const only = flag("only", ""), scale = Number(flag("scale", "1")), concurrency = Number(flag("concurrency", "4")), FPS = 30;
const started = Date.now(), ms = {};
const timed = async (what, run) => { const t = Date.now(); try { return await run(); } finally { ms[what] = Date.now() - t; } };

try {
  const script = JSON.parse(await readFile(scriptPath, "utf8"));
  const frames = script.scenes.map((s) => Math.max(FPS, Math.round((s.seconds ?? 6) * FPS)));
  if (flag("seconds", "")) { let at = 0; script.scenes = script.scenes.filter((_, i) => { const keep = at < Number(flag("seconds")) * FPS; at += frames[i]; return keep; }); }   // a short render, for trying things
  await mkdir(join(outDir, "stills"), { recursive: true });
  await timed("browser", () => ensureBrowser());
  const serveUrl = await timed("bundle", () => bundle({ entryPoint: join(dirname(fileURLToPath(import.meta.url)), "src", "Root.tsx"), onProgress: () => {} }));
  const inputProps = { script }, chromiumOptions = flag("gl", "") ? { gl: flag("gl") } : {};
  const composition = await selectComposition({ serveUrl, id: "Pitch", inputProps, chromiumOptions });
  const stills = [];
  if (only !== "video") await timed("stills", async () => {
    for (const old of await readdir(join(outDir, "stills"))) if (old.endsWith(".png")) await rm(join(outDir, "stills", old));
    let from = 0;
    for (const [i, scene] of script.scenes.entries()) {
      const name = `${String(i + 1).padStart(2, "0")}-${scene.id}.png`;
      await renderStill({ composition, serveUrl, inputProps, chromiumOptions, scale: 1, frame: Math.min(composition.durationInFrames - 1, from + Math.round(frames[i] * 0.8)), output: join(outDir, "stills", name), overwrite: true });
      stills.push(`stills/${name}`);
      from += frames[i];
    }
  });
  if (only !== "stills") await timed("video", () => renderMedia({ composition, serveUrl, inputProps, chromiumOptions, scale, concurrency, codec: "h264", crf: 20, imageFormat: "jpeg", jpegQuality: 90, outputLocation: join(outDir, "out.mp4"), overwrite: true,
    onProgress: ({ renderedFrames }) => { if (renderedFrames % 300 === 0 && renderedFrames) console.error(`rendered ${renderedFrames}/${composition.durationInFrames} frames, ${Math.round((Date.now() - started) / 1000)} s`); } }));
  console.log(JSON.stringify({ ok: true, seconds: composition.durationInFrames / FPS, frames: composition.durationInFrames, width: Math.round(composition.width * scale), height: Math.round(composition.height * scale), stills, video: only === "stills" ? null : "out.mp4", ms: { ...ms, total: Date.now() - started } }));
  process.exit(0);
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error?.stack ?? error).slice(0, 3000), ms: { ...ms, total: Date.now() - started } }));
  process.exit(1);
}
