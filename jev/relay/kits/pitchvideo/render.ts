// render.ts — the kit's build: video/script.json -> video/out.mp4 and video/stills/*.png, with Remotion.
//
// The template project's SOURCE is in ./remotion. It is copied to a work directory on a native
// filesystem (bundling from /mnt/c took a minute; from ext4, seconds), where its node_modules are
// installed once. A render that fails comes back as a log for the relay, never as a thrown error,
// and a script that has not changed is not rendered twice.
//
//   PUK_PITCH_WORKDIR   where to build            default ~/puk-relay/pitch-video
//   PUK_CHROME_LIBS     extra LD_LIBRARY_PATH for Remotion's headless Chrome (libnss3 and friends without sudo)
//   PUK_PITCH_CONCURRENCY   browser tabs rendering at once (4)
//   PUK_PITCH_SCALE         the video's scale; 2/3 of 1920x1080 is 1280x720, which software rendering manages in minutes.
//                           The stills are always full size: they are what is looked at.

import { cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "../../relay";
import { FPS, TEMPLATES, parseScript, timing } from "./script";

const SOURCE = join(import.meta.dir, "remotion");
const WORK = process.env.PUK_PITCH_WORKDIR ?? join(homedir(), "puk-relay", "pitch-video");
const LIBS = [process.env.PUK_CHROME_LIBS, join(import.meta.dir, "..", "..", "..", "..", "out", "relay", "libs", "root", "usr", "lib", "x86_64-linux-gnu"), "/mnt/c/Users/Chili/puk/out/relay/libs/root/usr/lib/x86_64-linux-gnu"].filter((p): p is string => Boolean(p));

async function run(cmd: string[], cwd: string, timeoutMs: number, env: Record<string, string> = {}, progress?: (line: string) => void): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const stderr = (async () => { let all = ""; const decoder = new TextDecoder(); for await (const chunk of proc.stderr) { const text = decoder.decode(chunk); all += text; for (const line of text.split("\n")) if (progress && /^rendered /.test(line)) progress(line.trim()); } return all; })();
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), stderr, proc.exited]);
  clearTimeout(timer);
  return { code, out, err };
}

async function sourceHash(): Promise<string> {
  const files = [...new Bun.Glob("**/*").scanSync(SOURCE)].filter((f) => !f.includes("node_modules")).sort();
  const parts = await Promise.all([join(import.meta.dir, "script.ts"), ...files.map((f) => join(SOURCE, f))].map((f) => Bun.file(f).text()));
  return Bun.hash(parts.join("\u0000")).toString(16);
}

/** The work directory: sources copied, dependencies installed when they are missing or the manifest changed. */
async function prepare(log: (line: string) => void): Promise<string | null> {
  await mkdir(join(WORK, "kit"), { recursive: true });
  const manifest = await Bun.file(join(SOURCE, "package.json")).text();
  const installed = await Bun.file(join(WORK, "package.json")).text().catch(() => "");
  if (installed !== manifest || !(await Bun.file(join(WORK, "node_modules", "remotion", "package.json")).exists())) {
    log("render: installing Remotion into the work directory (once)");
    await Bun.write(join(WORK, "package.json"), manifest);
    const npm = await run(["npm", "install", "--no-audit", "--no-fund"], WORK, 600_000);
    if (npm.code !== 0) return `npm install failed in ${WORK}:\n${npm.err.slice(-1500)}`;
  }
  await rm(join(WORK, "kit", "remotion", "src"), { recursive: true, force: true });   // only the sources: Remotion keeps its downloaded browser under this directory's node_modules
  await cp(SOURCE, join(WORK, "kit", "remotion"), { recursive: true, filter: (src) => !src.includes("node_modules") });
  await Bun.write(join(WORK, "kit", "script.ts"), await Bun.file(join(import.meta.dir, "script.ts")).text());
  return null;
}

export async function build(ws: Workspace, opts: { only?: "stills" | "video" } = {}): Promise<{ ok: boolean; log: string; outputs: string[] }> {
  const started = performance.now(), video = join(ws.dir, "video");
  try {
    const json = ws.files["video/script.json"] ?? await Bun.file(join(video, "script.json")).text().catch(() => "");
    const parsed = parseScript(json);
    if (!parsed.script?.scenes.length) return { ok: false, log: `not rendered: video/script.json is not a script the templates can draw.\n${parsed.problems.join("\n")}`, outputs: [] };
    const script = parsed.script, drawable = script.scenes.filter((s) => s && Object.hasOwn(TEMPLATES, s.template));
    const skipped = script.scenes.length - drawable.length;
    script.scenes = drawable;
    const time = timing(script), text = JSON.stringify(script);
    const scale = process.env.PUK_PITCH_SCALE ?? String(2 / 3);
    const hash = Bun.hash(`${text}\u0000${await sourceHash()}\u0000${opts.only ?? ""}\u0000${scale}`).toString(16), out = join(WORK, "out", hash);
    type Result = { ok: boolean; error?: string; seconds?: number; frames?: number; width?: number; height?: number; stills?: string[]; video?: string | null; ms?: Record<string, number> };
    // What is in the workspace may have been made from another script. Remove it first: a failed render must not leave an old video looking like a new one.
    await rm(join(video, "out.mp4"), { force: true });
    await rm(join(video, "stills"), { recursive: true, force: true });
    // A render is kept under the hash of what it was made from (the script and the templates), so the same script is never rendered twice.
    let result = await Bun.file(join(out, "result.json")).json().catch(() => null) as Result | null, again = false;
    if (result?.ok && (await Promise.all([...(result.stills ?? []), ...(result.video ? [result.video] : [])].map((f) => Bun.file(join(out, f)).exists()))).every(Boolean)) again = true;
    else {
      const failed = await prepare(ws.log);
      if (failed) return { ok: false, log: failed, outputs: [] };
      await rm(out, { recursive: true, force: true });
      await mkdir(out, { recursive: true });
      await Bun.write(join(out, "script.json"), text);
      const libs = (await Promise.all(LIBS.map(async (p) => ((await Bun.file(join(p, "libnss3.so")).exists()) ? p : null)))).filter(Boolean);
      const flags = [`--concurrency=${process.env.PUK_PITCH_CONCURRENCY ?? "4"}`, `--scale=${scale}`, ...(opts.only ? [`--only=${opts.only}`] : [])];
      const made = await run(["node", "render.mjs", join(out, "script.json"), out, ...flags], join(WORK, "kit", "remotion"), 40 * 60_000, { LD_LIBRARY_PATH: [...libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }, (line) => ws.log(`render: ${line}`));
      const last = made.out.trim().split("\n").pop() ?? "";
      result = (() => { try { return JSON.parse(last) as Result; } catch { return null; } })();
      if (!result?.ok) return { ok: false, log: `the Remotion render FAILED (exit ${made.code}).\n${result?.error ?? last}\n${made.err.slice(-1500)}`, outputs: [] };
      await Bun.write(join(out, "result.json"), JSON.stringify(result));
    }

    await mkdir(join(video, "stills"), { recursive: true });
    const outputs: string[] = [];
    for (const still of result.stills ?? []) { await Bun.write(join(video, still), Bun.file(join(out, still))); outputs.push(`video/${still}`); }
    if (result.video) { await Bun.write(join(video, "out.mp4"), Bun.file(join(out, "out.mp4"))); outputs.unshift("video/out.mp4"); }
    const seconds = result.seconds ?? 0, ms = result.ms ?? {};
    const log = [`Rendered with Remotion from video/script.json (${script.scenes.length} scenes, ${time.words} words of narration).${skipped ? ` ${skipped} scenes with an unknown template were left out.` : ""}${parsed.problems.length ? ` The script still has problems: ${parsed.problems.join("; ")}` : ""}`,
      result.video ? `video/out.mp4 exists: ${seconds.toFixed(1)} seconds long (${result.frames} frames at ${FPS} frames a second, ${result.width}x${result.height}, h264), which ${seconds >= 60 && seconds <= 180 ? "is" : "is NOT"} between 60 and 180 seconds.` : "No video was asked for, only stills.",
      `${result.stills?.length ?? 0} stills are in video/stills, one for each scene: ${(result.stills ?? []).join(", ")}.`,
      `The narration is ${time.wpm} words a minute over the video's length.`,
      `video/claims.md ${ws.files["video/claims.md"] ? "was generated by the kit from the script's claims, with each source passage quoted from its repository file" : "has not been generated"}.`,
      `Render time: bundle ${Math.round((ms.bundle ?? 0) / 1000)} s, stills ${Math.round((ms.stills ?? 0) / 1000)} s, video ${Math.round((ms.video ?? 0) / 1000)} s; ${Math.round((performance.now() - started) / 1000)} s in all.`].join("\n");
    return { ok: true, log: again ? `${log}\n(not rendered again: this script and these templates were already rendered; the files were copied from that render)` : log, outputs };
  } catch (error) {
    return { ok: false, log: `the build could not run: ${error instanceof Error ? error.message : error}`, outputs: [] };
  }
}
