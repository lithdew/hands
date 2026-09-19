// render.mjs — script.json in, out.mp4 and stills out. Run by the kit with Node from the installed working copy:
//
//   node render.mjs --script s.json --out dir --bundle dir --stills '[{"name":"01-x.png","frame":120}]'
//                   [--scale 0.6667] [--concurrency 4] [--only stills|video]
//
// One bundle (reused while the sources are unchanged), one browser, the video, then every still from the same
// composition. Prints one line per event; a failure is a line that starts with "ERROR" and exit code 1.
import { bundle } from "@remotion/bundler";
import { openBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
let browser = null;
// Killed by the kit (a timeout) or by hand: take headless Chrome down too, or it renders on as an orphan.
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { Promise.resolve(browser?.close({ silent: true })).finally(() => process.exit(143)); });
const started = Date.now(), say =(line) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)} s] ${line}`);

try {
  const script = JSON.parse(readFileSync(arg("script"), "utf8")), out = arg("out"), only = arg("only", "all");
  const stills = JSON.parse(arg("stills", "[]")), scale = Number(arg("scale", "1")), concurrency = Number(arg("concurrency", "4"));
  const bundleDir = arg("bundle", join(here, "bundle"));
  mkdirSync(join(out, "stills"), { recursive: true });

  let serveUrl = bundleDir;
  if (!existsSync(join(bundleDir, "index.html"))) { serveUrl = await bundle({ entryPoint: join(here, "src", "index.ts"), outDir: bundleDir, enableCaching: true }); say(`bundled the templates`); } else say(`reused the bundle`);

  // No GL backend asked for: measured on 300 frames of these templates, 21 s against 51 s ("angle") and 88 s ("swangle"). Nothing here needs WebGL.
  const gl = arg("gl", "none"), inputProps = { script }, chromiumOptions = gl === "none" ? {} : { gl };
  browser = await openBrowser("chrome", { chromiumOptions });
  const composition = await selectComposition({ serveUrl, id: "Main", inputProps, puppeteerInstance: browser, chromiumOptions });
  say(`composition: ${composition.durationInFrames} frames at ${composition.fps} fps, ${composition.width}x${composition.height}`);

  if (only !== "video") for (const still of stills) {
    await renderStill({ composition, serveUrl, inputProps, puppeteerInstance: browser, chromiumOptions, frame: Math.min(still.frame, composition.durationInFrames - 1), output: join(out, "stills", still.name), imageFormat: "png", scale: still.scale ?? 1, overwrite: true });
    say(`still ${still.name} (frame ${still.frame})`);
  }
  if (only !== "stills") {
    let last = -1;
    await renderMedia({ composition, serveUrl, inputProps, puppeteerInstance: browser, chromiumOptions, codec: "h264", crf: 20, imageFormat: "jpeg", jpegQuality: 90, scale, concurrency, outputLocation: join(out, "out.mp4"), overwrite: true,
      onProgress: ({ progress }) => { const pct = Math.floor(progress * 10); if (pct !== last) { last = pct; say(`video ${pct * 10}%`); } } });
    say(`video out.mp4: ${(composition.durationInFrames / composition.fps).toFixed(1)} seconds, ${Math.round(composition.width * scale)}x${Math.round(composition.height * scale)}`);
  }
  await browser.close({ silent: true });
  process.exit(0);
} catch (error) {
  console.log(`ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`.slice(0, 3000));
  process.exit(1);
}
