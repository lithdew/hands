// kits/mathvideo.ts — a mathematics explainer in 3Blue1Brown's visual language, rendered with Remotion.
//
// The script is DATA. The writer (an LLM) chooses the scenes, the matrices and the words; it cannot draw.
// Drawing is a closed set of scene templates, implemented once as Remotion components (./mathvideo/src):
// a number plane under a matrix, the unit square and its area, a collapse onto a line, typeset lines, a
// worked inverse, a product, a recap. Who does what:
//
//   LLM    writes video/script.json: which scenes, in which order, which matrices, what is said
//   code   recomputes EVERY number (determinant, inverse, A·A⁻¹ = I, products) in exact rationals, checks
//          shapes and timing, parses every LaTeX string with KaTeX. No model's arithmetic is trusted
//   JEV    one request per scene, all at once (about half a second for the whole script): which template
//          from the closed set fits this narration, does the narration match what that template will show,
//          do its numbers agree with code's, is it one idea. Closed questions, in bulk: Jev's kind of work
//   LLM    gets back exactly what was wrong, with the right values, and corrects its own file
//   code   renders: Remotion + headless Chrome, a video and one still per scene; cached by script and sources
//
// manim itself is not used, and the output says so and why (README.md, written by the build from a probe).

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { choice, noul, type Ask, type ChoiceResponse, type NoulResponse, type Questions } from "../../jev";
import type { Kit, KitContext, Step, Workspace } from "../relay";
import type { Result } from "../web";
import { LIMITS, TEMPLATES, TEMPLATE_NAMES, briefOfTemplates, check, facts, screen, stillsOf, storyboard, type Script, type TemplateName } from "./mathvideo/src/script";

// ---------------------------------------------------------------- where things live

const SOURCES = join(import.meta.dir, "mathvideo");
/** The working copy: sources plus node_modules, on a fast filesystem, outside the repository. */
const HOME = process.env.PUK_MATHVIDEO_HOME ?? join(homedir(), "puk-relay", "mathvideo");
const CACHE = join(import.meta.dir, "..", "..", "..", "out", "relay", "cache", "mathvideo");
/** Headless Chrome needs three libraries this machine lacks system-wide; they are unpacked here, without sudo. */
const CHROME_LIBS = process.env.PUK_CHROME_LIBS ?? "/mnt/c/Users/Chili/puk/out/relay/libs/root/usr/lib/x86_64-linux-gnu";
const SCRIPT = "video/script.json";
const SCALE = Number(process.env.PUK_MATHVIDEO_SCALE ?? 2 / 3), CONCURRENCY = process.env.PUK_MATHVIDEO_CONCURRENCY ?? "4";
/** For work on the templates only (mathvideo.dev.ts): "stills" skips the video. */
const ONLY = process.env.PUK_MATHVIDEO_ONLY ?? "all";

const BRIEF = `The deliverable is an explainer video in the visual language of 3Blue1Brown's manim: a dark number plane, the basis vectors î and ĵ, a matrix shown as a motion of the whole plane, typeset matrices.
You write ONE file, ${SCRIPT}. The kit's build turns it into video/out.mp4 and video/stills/*.png with Remotion, and itself writes video/README.md (which tools made the video, honestly) and video/storyboard.md. Do not write those, and do not plan research about tools or installation: the toolchain is fixed (manim cannot be installed on this machine, so Remotion renders everything in manim's style). One research step is worthwhile, for the content only: how this topic is explained visually and intuitively by the explainer the request names, and what a viewer usually gets wrong. Standard mathematics may be stated from your own knowledge; code checks every number. The script is for a viewer: nothing in it (titles, subtitles, narration) mentions notes, sources, tools, rendering or how the video was made.

${SCRIPT} is { "title": string, "scenes": [ ... ] }. The script is data: you cannot draw, you choose from a closed set of scene templates and give their parameters. Every scene is { "id": short_snake_case, "template": one of the names below, "seconds": number, "narration": string, "heading": optional string of at most ${LIMITS.heading} characters (not for "title") } plus that template's own parameters and nothing else.

Templates:
${briefOfTemplates()}

Rules the build enforces:
- ${LIMITS.scenes[0]} to ${LIMITS.scenes[1]} scenes, ${LIMITS.totalSeconds[0]} to ${LIMITS.totalSeconds[1]} seconds in all, each scene ${LIMITS.sceneSeconds[0]} to ${LIMITS.sceneSeconds[1]} seconds. One idea per scene.
- There is no voice: the narration appears as captions, a sentence at a time. Pace it at about 2.2 words a second (a 12 second scene carries about 26 words; never more than ${LIMITS.wordsPerSecond[1]} words a second). Plain spoken English, no LaTeX, numbers as digits.
- The narration of a scene talks about what THAT scene's template shows (read what each template shows, above), and may only state numbers that are true of the scene's own matrices. Build intuition with the plane templates before formulas; a viewer should see the idea happen, then see it typeset.
- Matrices are [[a, b], [c, d]] by rows; a fraction is a string, "1/2". Prefer small whole numbers. Every determinant, inverse and product you give is recomputed by code, and a wrong one is sent back to you.`;

// ---------------------------------------------------------------- the working copy

const run = async (cmd: string[], cwd: string, env: Record<string, string> = {}, timeoutMs = 1_800_000, onLine?: (line: string) => void) => {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const lines = async () => { let out = "", rest = ""; const decoder = new TextDecoder(); for await (const chunk of proc.stdout) { const text = decoder.decode(chunk, { stream: true }); out += text; rest += text; const parts = rest.split("\n"); rest = parts.pop() ?? ""; for (const line of parts) onLine?.(line); } return out; };
  const [out, err, code] = await Promise.all([lines(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, out, err };
};

async function sourceFiles(): Promise<string[]> {
  return ["package.json", "render.mjs", ...[...new Bun.Glob("src/**/*.{ts,tsx,css}").scanSync(SOURCES)].sort()];
}

/** Copies the sources into the working copy when they differ, installs once. Returns a hash of the sources. */
export async function prepare(log: (line: string) => void = () => {}): Promise<string> {
  await mkdir(HOME, { recursive: true });
  const hasher = new Bun.CryptoHasher("sha256");
  for (const path of await sourceFiles()) {
    const text = await Bun.file(join(SOURCES, path)).text();
    if (path !== "render.mjs") hasher.update(`${path}\n${text}\n`); // what is drawn depends on the templates, not on the script that drives the renderer
    const target = Bun.file(join(HOME, path));
    if (!(await target.exists()) || (await target.text()) !== text) await Bun.write(target, text);
  }
  const installed = async () => (await Promise.all(["remotion", "@remotion/renderer", "@remotion/bundler", "katex", "react"].map((name) => Bun.file(join(HOME, "node_modules", name, "package.json")).exists()))).every(Boolean);
  if (!(await installed())) {
    log("installing the template project's dependencies (once)");
    const done = await run(["bun", "install"], HOME, {}, 600_000);
    if (!(await installed())) throw new Error(`could not install Remotion and KaTeX into ${HOME}: ${(done.err || done.out).slice(-600)}`);
  }
  return hasher.digest("hex").slice(0, 16);
}

/** KaTeX's own parser, from the working copy: what it cannot parse, it cannot typeset. */
async function texChecker(): Promise<(latex: string) => string | null> {
  const katex = await import(join(HOME, "node_modules", "katex", "dist", "katex.mjs")).then((m) => m.default ?? m).catch(() => null) as { renderToString(latex: string, options: object): string } | null;
  if (!katex) return () => null;
  return (latex) => { try { katex.renderToString(latex, { throwOnError: true, strict: "ignore", displayMode: true }); return null; } catch (e) { return (e instanceof Error ? e.message : String(e)).replace(/^KaTeX parse error:\s*/, "").slice(0, 200); } };
}

/** Only what THIS run wrote: a script left on disk by an earlier run is not this run's work. */
function readScript(ws: Workspace): { text: string; raw: unknown; problem?: string } {
  const text = ws.files[SCRIPT] ?? "";
  if (!text.trim()) return { text, raw: null, problem: `${SCRIPT} has not been written.` };
  try { return { text, raw: JSON.parse(text) }; } catch (e) { return { text, raw: null, problem: `${SCRIPT} is not valid JSON: ${e instanceof Error ? e.message : e}` }; }
}

// ---------------------------------------------------------------- research that does not hang on a search engine

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();

/** A lesson of the explainer this kit imitates, from its sitemap: every lesson page holds the lesson's full text. Exported for tests. */
export function lessonsIn(sitemap: string): Result[] {
  return [...sitemap.matchAll(/<loc>(https:\/\/www\.3blue1brown\.com\/lessons\/([a-z0-9-]+))\/?<\/loc>/g)].map((m) => { const name = m[2]!.replace(/-/g, " "); return { title: `3Blue1Brown lesson: ${name}`, url: m[1]!, snippet: `The full text of 3Blue1Brown's own lesson "${name}", as it is explained in the video, with what is shown on screen.` }; });
}

/** Asked once a step: all of 3Blue1Brown's lessons (about 180 titles; Jev's sift picks the few that serve the goal, which is its kind
 *  of work) and Wikipedia's search for each query, for the mathematics itself. The web search may refuse (429 when several runs share
 *  an address); these two answer, so a research step always has something real to read. */
async function sourcesAtOnce(queries: string[]): Promise<Result[]> {
  const get = (url: string) => fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15_000) });
  const lessons = get("https://www.3blue1brown.com/sitemap.xml").then((r) => (r.ok ? r.text() : ""), () => "").then(lessonsIn);
  const wikipedia = queries.slice(0, 4).map((q) => get(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=4&srsearch=${encodeURIComponent(q)}`)
    .then((r) => (r.ok ? r.json() : null), () => null)
    .then((body) => ((body as { query?: { search?: { title: string; snippet: string }[] } } | null)?.query?.search ?? []).map((hit) => ({ title: `${hit.title} (Wikipedia)`, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`, snippet: plain(hit.snippet) }))));
  return (await Promise.all([lessons, ...wikipedia])).flat();
}

const READING = "The writer will script an explainer video. Keep: how the source SHOWS each idea (what is drawn, what moves, which example), the order in which the ideas come, the sentences that carry the intuition, the definitions and formulas stated exactly, and what learners get wrong. Skip what is off the goal's topic.";

// ---------------------------------------------------------------- review: code, then Jev, in bulk

export type SceneVerdict = { id: string; template: TemplateName; picked: TemplateName; confidence: number; matches: number; numbers: number | null; oneIdea: number };
export const THRESHOLDS = { template: 0.8, matches: 0.35, numbers: 0.5, oneIdea: 0.25 };
/** Templates a narration alone cannot tell apart: both are typeset lines, or both are a plane moving under one matrix. */
const ALIKE: TemplateName[][] = [["equation", "worked_inverse", "product", "recap"], ["transform", "area", "undo"], ["title", "recap"]];
const alike = (a: TemplateName, b: TemplateName) => a === b || ALIKE.some((group) => group.includes(a) && group.includes(b));

/** One request per scene, all in flight together. */
export async function jevReview(ask: Ask, script: Script): Promise<SceneVerdict[]> {
  const labels = Object.fromEntries(TEMPLATE_NAMES.map((name) => [name, TEMPLATES[name].shows])) as Record<TemplateName, string>;
  return Promise.all(script.scenes.map(async (scene) => {
    const computed = facts(scene);
    const questions = {
      template: choice("A narrator says `narration` over one scene of a mathematics video. Which kind of scene shows best what the narrator is talking about?", labels),
      matches: noul(`What \`narration\` talks about is what the viewer sees on screen. On screen: ${JSON.stringify(screen(scene))}`, { true: "The narration describes, explains or comments on what is on screen.", false: "The narration is about something the screen does not show, or contradicts what it shows." }),
      one_idea: noul("`narration` makes one main point.", { true: "One idea, perhaps with a consequence or an example of it.", false: "Two or more separate ideas that would each need their own scene." }),
      ...(computed.length ? { numbers: noul(`Every number that \`narration\` states agrees with these facts, which were computed exactly: ${JSON.stringify(computed.join(" "))}`, { true: "Each number in the narration appears in the facts with the same meaning, or the narration states no numbers.", false: "The narration gives a determinant, an entry, a coordinate or an area that differs from the facts." }) } : {}),
    } satisfies Questions;
    const answers = await ask({ narration: scene.narration, heading: scene.heading ?? "" }, questions) as unknown as { template: ChoiceResponse; matches: NoulResponse; one_idea: NoulResponse; numbers?: NoulResponse };
    return { id: scene.id, template: scene.template, picked: answers.template.choice as TemplateName, confidence: answers.template.confidence, matches: answers.matches.noul, numbers: answers.numbers?.noul ?? null, oneIdea: answers.one_idea.noul };
  }));
}

export function problemsFrom(verdicts: SceneVerdict[], script: Script): string[] {
  const out: string[] = [];
  for (const v of verdicts) {
    const scene = script.scenes.find((s) => s.id === v.id)!, at = `Scene "${v.id}"`;
    // An opening or a closing speaks about the whole topic, so its words alone always sound like some other scene. Only a plain miss counts there.
    const framing = v.template === "title" || v.template === "recap";
    if (framing) { if (v.matches < THRESHOLDS.matches / 2) out.push(`${at}: the narration does not go with what is on screen. On screen: ${screen(scene)}`); }
    else if (!alike(v.picked, v.template) && v.confidence >= THRESHOLDS.template && v.matches < 0.6) out.push(`${at}: the narration reads like a "${v.picked}" scene (${TEMPLATES[v.picked].shows.split(".")[0]}), but the scene uses "${v.template}". Change the template, or make the narration talk about what "${v.template}" shows.`);
    else if (v.matches < THRESHOLDS.matches) out.push(`${at}: the narration does not talk about what is on screen. On screen: ${screen(scene)}`);
    if (v.numbers !== null && v.numbers < THRESHOLDS.numbers) out.push(`${at}: a number in the narration disagrees with what code computed: ${facts(scene).join(" ")}`);
    if (v.oneIdea < THRESHOLDS.oneIdea) out.push(`${at}: the narration makes more than one point; keep one idea and move the other to its own scene.`);
  }
  return out;
}

let lastReview = { scenes: 0, requests: 0, ms: 0, rounds: 0 };

async function review(ctx: KitContext, step: Step): Promise<string[]> {
  const { ws, ask, log } = ctx, { text, raw, problem } = readScript(ws);
  // A write step that was never meant to produce the script (an outline, say) is not this review's business.
  if (!text.trim() && !/script/i.test(`${step.id} ${step.goal}`)) return [];
  if (problem) return [problem];
  await prepare(log).catch(() => "");
  const checked = check(raw, await texChecker());
  const problems = checked.problems.map((p) => p.text);
  if (!checked.script) return problems;
  const usable = { ...checked.script, scenes: checked.script.scenes.filter((s) => s && typeof s.narration === "string" && TEMPLATE_NAMES.includes(s.template)) };
  const t = performance.now();
  const verdicts = await jevReview(ask, usable).catch((e) => { log(`Jev's review could not run: ${e instanceof Error ? e.message : e}`); return [] as SceneVerdict[]; });
  lastReview = { scenes: usable.scenes.length, requests: lastReview.requests + verdicts.length, ms: lastReview.ms + Math.round(performance.now() - t), rounds: lastReview.rounds + 1 };
  const fromJev = problemsFrom(verdicts, usable);
  log(`review: code found ${problems.length} problem${problems.length === 1 ? "" : "s"}; Jev read ${verdicts.length} scenes in ${Math.round(performance.now() - t)} ms and objected to ${fromJev.length}`);
  await Bun.write(join(ws.dir, "notes", `review-${lastReview.rounds}.json`), JSON.stringify({ code: checked.problems, jev: verdicts, jevProblems: fromJev }, null, 2));
  return [...problems, ...fromJev];
}

// ---------------------------------------------------------------- build: validate, render (or reuse), say how it was made

async function manimProbe(): Promise<string> {
  const onPath = Bun.which("manim") ?? Bun.which("manimgl");
  const imported = await run(["python3", "-c", "import manim"], HOME, {}, 20_000).then((r) => r.code === 0, () => false);
  const latex = Bun.which("latex") ?? Bun.which("pdflatex"), compiler = Bun.which("cc") ?? Bun.which("gcc") ?? Bun.which("clang");
  if (onPath || imported) return `manim was found on this machine (${onPath ?? "importable from python3"}), but this kit does not drive it: every frame of this video was drawn by Remotion.`;
  return `manim is NOT installed here (no \`manim\` on PATH, and \`python3 -c "import manim"\` fails), and it could not be installed: \`pip install manim\` stops at pycairo, which has no Linux wheel and must be compiled against cairo's headers, and this machine has ${compiler ? "no cairo headers" : "no C compiler, no cairo headers"}, ${latex ? "" : "no LaTeX (manim typesets formulas with it), "}no system ffmpeg and no sudo. So manim drew nothing in this video.`;
}

async function readme(script: Script, seconds: number, stills: string[], cached: boolean): Promise<string> {
  const remotion = await Bun.file(join(HOME, "node_modules", "remotion", "package.json")).json().then((p) => p.version, () => "4"), katex = await Bun.file(join(HOME, "node_modules", "katex", "package.json")).json().then((p) => p.version, () => "");
  return `# How this video was made

The request asked for "three blue one brown's tool", which is **manim**, and for **Remotion**. Honestly:

- **manim: not used.** ${await manimProbe()}
- **Remotion ${remotion}: drew every frame.** React components rendered by Remotion in headless Chrome and encoded to H.264 by the ffmpeg that Remotion bundles. The video is Remotion alone, *in manim's visual language*, rebuilt by hand: manim's palette (BLUE_D grid, GREEN_C for î, RED_C for ĵ, YELLOW for areas and results) on a near-black background, a NumberPlane with a static grey grid behind the moving blue one, a matrix applied the way manim's ApplyMatrix does it (every point travels in a straight line from x to Ax, with manim's \`smooth\` easing), and lines that fade in with a small upward shift.
- **KaTeX ${katex}: typeset the mathematics** (LaTeX's fonts and brackets in the browser), because there is no LaTeX here.
- **No voice track.** The narration in script.json is shown as captions, a sentence at a time.

Why this way: the point of the request is a 3Blue1Brown-style explanation and Remotion in the pipeline. With manim impossible to install, imitating its look faithfully in Remotion is the honest way to deliver both, rather than pretending manim ran.

## Who did what

- A language model wrote \`video/script.json\`: which scenes, in which order, which matrices, what is said. It cannot draw: each scene names one of ${TEMPLATE_NAMES.length} fixed templates (${TEMPLATE_NAMES.join(", ")}) and gives its parameters.
- Code recomputed every number in exact rational arithmetic (determinants, inverses, that A·A⁻¹ is the identity, products) and checked timing and LaTeX. What the video typesets is what code computed, not what a model claimed. See \`video/storyboard.md\`.
- Jev (TypeSafe's System One, a fast model that answers closed questions) read every scene${lastReview.rounds ? `: ${lastReview.requests} requests over ${lastReview.rounds} review round${lastReview.rounds === 1 ? "" : "s"}, ${lastReview.ms} ms in all` : ""}: which template fits the narration, whether the narration matches what the template shows, whether its numbers agree with code's.
- Code rendered: ${script.scenes.length} scenes, ${seconds} seconds at 30 fps, ${Math.round(1920 * SCALE)}x${Math.round(1080 * SCALE)}; ${stills.length} stills at 1920x1080, one per scene that shows mathematics${cached ? " (this render was reused from the cache: the script and the templates had not changed)" : ""}.

## Files

- \`video/script.json\` the script (data), as the model wrote it
- \`video/storyboard.md\` each scene: what is on screen, what is said, what code computed
- \`video/out.mp4\`, \`video/stills/*.png\` the render
`;
}

export async function build(ws: Workspace): Promise<{ ok: boolean; log: string; outputs: string[] }> {
  // Whatever an earlier run or an earlier attempt rendered is not this script's video: a build that fails leaves none behind.
  await rm(join(ws.dir, "video", "out.mp4"), { force: true });
  await rm(join(ws.dir, "video", "stills"), { recursive: true, force: true });
  const { text, raw, problem } = readScript(ws);
  if (problem) return { ok: false, log: problem, outputs: [] };
  const sources = await prepare(ws.log);
  const checked = check(raw, await texChecker());
  const hard = checked.problems.filter((p) => p.hard);
  if (hard.length || !checked.script) return { ok: false, log: `${SCRIPT} cannot be rendered as it is:\n${hard.map((p) => `- ${p.text}`).join("\n")}`, outputs: [] };
  const script = checked.script, stills = stillsOf(script);

  const key = new Bun.CryptoHasher("sha256").update(`${sources}|${SCALE}|${ONLY}|${text}`).digest("hex").slice(0, 20), cached = join(CACHE, key);
  const complete = async () => (ONLY === "stills" || await Bun.file(join(cached, "out.mp4")).exists()) && (await Promise.all(stills.map((s) => Bun.file(join(cached, "stills", s.name)).exists()))).every(Boolean);
  let log = "", reused = await complete();
  if (!reused) {
    await rm(cached, { recursive: true, force: true }); await mkdir(cached, { recursive: true });
    const scriptPath = join(cached, "script.json"); await Bun.write(scriptPath, text);
    const started = performance.now();
    const done = await run(["node", "render.mjs", "--script", scriptPath, "--out", cached, "--bundle", join(HOME, "bundles", sources), "--stills", JSON.stringify(stills), "--scale", String(SCALE), "--concurrency", CONCURRENCY, "--only", ONLY], HOME,
      { LD_LIBRARY_PATH: [CHROME_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }, 1_800_000, (line) => { if (/video \d+0%|bundled|composition/.test(line)) ws.log(`render ${line}`); });
    log = `${done.out}\n${done.code === 0 ? "" : done.err.slice(-1500)}`.trim();
    ws.log(`render: ${Math.round((performance.now() - started) / 1000)} s, exit ${done.code}`);
    if (done.code !== 0 || !(await complete())) { await rm(cached, { recursive: true, force: true }); return { ok: false, log: `The render failed. If a parameter of a scene caused it, correct that scene.\n${log.slice(-2500)}`, outputs: [] }; }
  }

  await rm(join(ws.dir, "video", "stills"), { recursive: true, force: true });
  await mkdir(join(ws.dir, "video", "stills"), { recursive: true });
  if (ONLY !== "stills") await cp(join(cached, "out.mp4"), join(ws.dir, "video", "out.mp4"));
  for (const name of await readdir(join(cached, "stills"))) await cp(join(cached, "stills", name), join(ws.dir, "video", "stills", name));
  await ws.write("video/storyboard.md", storyboard(script));
  await ws.write("video/README.md", await readme(script, checked.seconds, stills.map((s) => s.name), reused));
  const soft = checked.problems.filter((p) => !p.hard);
  return { ok: true, outputs: ["video/out.mp4", ...stills.map((s) => `video/stills/${s.name}`), "video/storyboard.md", "video/README.md"],
    // Said in plain sentences: the step's acceptance statements are read off this log by a literal reader.
    log: `The build succeeded without errors. Before rendering, code checked video/script.json and it passed: the format and every template's parameters are valid, every determinant, inverse and product is arithmetically correct, every LaTeX line typesets, and the timing is within limits.
video/out.mp4 was rendered with Remotion${reused ? " (reused from the cache: same script, same templates)" : ""}: ${script.scenes.length} scenes, ${checked.seconds} seconds long, 30 frames a second, ${Math.round(1920 * SCALE)}x${Math.round(1080 * SCALE)}. ${stills.length} PNG stills were written to video/stills, one for each scene that shows mathematics. video/README.md says which tools made it and why (Remotion alone in manim's style; manim could not be installed). video/storyboard.md lists every scene with the numbers code computed.${soft.length ? `\nNot blocking: ${soft.map((p) => p.text).join(" ")}` : ""}\nScenes: ${script.scenes.map((s) => `${s.id} (${s.template}, ${s.seconds} s)`).join("; ")}\n${log.split("\n").filter((l) => /composition|video out|bundle/.test(l)).join("\n")}` };
}

export const mathvideo: Kit = { name: "mathvideo", brief: BRIEF, sourcesAtOnce, reading: READING, review, build };
