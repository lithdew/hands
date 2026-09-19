// marks.eval.ts — after the vision planner has looked, does Jev click the right thing?
//
//   bun jev/marks.eval.ts                     every case, every arm (about 50 vision calls the first time, then cached)
//   bun jev/marks.eval.ts --only=files,paint  some pages; --styles=0 skips the marking-style comparison; --planner=deep
//   bun jev/marks.eval.ts report              the tables again from out/jev-marks-eval.json, no requests
//   bun jev/marks.eval.ts marks               decompose every fixture, write out/marks/<page>.png, print the legends
//   bun jev/marks.eval.ts shoot               rebuild the fixtures with headless Chrome (throwaway profile, no window)
//
// A case is one stuck look: a goal, a screenshot, what the observer reads off that page, and the control that has to
// be clicked. The arms differ in what the vision planner is asked and what reaches Jev afterwards:
//
//   wired      today's contract as runScreens uses it: prose steps go into `plan`, nothing joins Jev's list
//   merged     today's contract as runIntent used it: the rectangles the model GUESSED join the list (withVisionElements)
//   snapped    the same plan, its guessed rectangles moved onto the marks we made meanwhile (fully concurrent route)
//   marks      marked screenshot in, references out, captioned marks join the list with measured rectangles (applyMarks)
//   lean       the marks contract asked to caption only what its steps need (`captionAll: false`), on some cases
//   local      no planner at all: the text OCR read in a blind spot joins the list as it is (offerReadable)
//   recalled   no planner at all: what an earlier marked plan on the same screen taught, put back by `recall`
//
// Every arm ends in the real `decideScreen` against real Jev, and is right when the action it returns lands inside the
// gold control's rectangle. "stuck" means it escalated again.
//
// What is real: Jev, the vision model, its tokens and latency, Windows OCR, the screenshots (Chrome rendered them), and
// the element lists (win/observe.ts READ_PAGE ran in those pages, once as it is and once with the change asked of it).
// What is not: the five pages. They are mine (fixtures/marks/pages), built to be the hard classes: icon-only
// toolbars, twin rows of icon buttons, an app drawn on a canvas, a widget in a sandboxed (opaque-origin) iframe, and a
// bot check, where the only right answer is `blocked`. Nothing was clicked: no case runs past its first decision.
//
// Results go to out/jev-marks-eval.json. Vision answers are cached by request in out/.jev-marks-cache.json.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Hand } from "../desktop";
import { createOcr } from "../win/ocr";
import { pageObservation, READ_PAGE } from "../win/observe";
import { elementLabels, jevState } from "./cua";
import type { Intent } from "./intent";
import { createJev, type Ask } from "./jev";
import { applyMarks, createMarkMemory, decompose, learn, legendOf, offerReadable, recall, snapPlan, type Markable, type Marks, type Ocr } from "./marks";
import { withVisionElements, type Observation } from "./observe";
import { outputJson, responsesBody, type Llm, type LlmRequest } from "./openai";
import { choosePlanner, makeMarkedPlan, makePlan, PLANNERS, type MarkedPlan, type MarkStyle, type Plan, type PlannerName } from "./planner";
import { decideScreen, type ScreenDecision } from "./screen";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(import.meta.dir, "fixtures", "marks");
export const PAGES = ["editor", "files", "paint", "embed", "verify"] as const;
export const SIZE = { width: 1280, height: 800 };

// ---------------------------------------------------------------- the observer, as it is and as it should become

/**
 * win/observe.ts READ_PAGE with the change marks.ts needs, applied to the very string the hand runs, so the eval
 * cannot drift from the observer: controls without a name are passed along instead of dropped, and so are the
 * rectangles the DOM cannot see into (canvas, iframe, embed, video).
 */
export function nextReadPage(script: string): string {
  const swap = (from: string, to: string) => { if (!script.includes(from)) throw new Error(`READ_PAGE no longer contains: ${from}`); script = script.replace(from, to); };
  swap("const picked = [];", `const rowOf = (el) => { const row = el.closest("tr,li,[role=row],[role=listitem],article"); return row ? clean(row.innerText) : ""; };
  const picked = [], unnamed = [];`);
  swap("if (!name && !editable) continue;", "if (!name && !editable) { unnamed.push({ role, within: within(el), row: rowOf(el), after: picked.length, x: r.left, y: r.top, w: r.width, h: r.height }); continue; }");
  swap("return JSON.stringify({ url: location.href, title: document.title, ready: document.readyState, elements: kept, texts });", `const opaque = [];
  for (const el of document.querySelectorAll("canvas,iframe,embed,object,video")) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 30 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    opaque.push({ kind: el.tagName.toLowerCase(), name: clean(el.getAttribute("aria-label") || el.title || ""), x: r.left + el.clientLeft, y: r.top + el.clientTop, w: el.clientWidth || r.width, h: el.clientHeight || r.height });
  }
  return JSON.stringify({ url: location.href, title: document.title, ready: document.readyState, elements: kept, texts, unnamed: unnamed.slice(0, 80), opaque: opaque.slice(0, 8) });`);
  return script;
}

// ---------------------------------------------------------------- shoot: pixels and ground truth from one page

type Box = { x: number; y: number; w: number; h: number };
type PageElement = { role: string; name: string; value: string; editable: boolean; focused: boolean; within: string; options?: string[] } & Box;
type PageDump = { url: string; title: string; ready: string; elements: PageElement[]; texts: string[]; unnamed?: ({ role: string; within: string; row: string; after: number } & Box)[]; opaque?: ({ kind: string; name: string } & Box)[] };
export type Truth = { page: string; shot: string; inner: [number, number]; today: PageDump; next: PageDump; gold: Record<string, Box>; controls: Box[] };

const CHROME = process.env.PUK_CHROME ?? "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";
const text = async (argv: string[]) => (await new Response(Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" }).stdout).text()).trim();

/** Everything a person could click, named or not. The guessed rectangles of today's planner are scored against these. */
const CONTROLS = "a[href],button:not([disabled]),input:not([type=hidden]),textarea,select,[role=button],[contenteditable=true]";

/**
 * Headless Chrome with a profile made for this run and deleted after it: no window, never the user's profile.
 * WSL cannot reach a DevTools port on Windows, so the page measures itself: a script added to a copy of the page
 * runs the observer's own READ_PAGE, collects every `data-gold` rectangle, and leaves it all in the DOM for --dump-dom.
 * The layouts are fixed at 1280x800, so the second run, which takes the screenshot, shows the same rectangles.
 */
async function shoot(): Promise<void> {
  const winTemp = await text(["wslpath", "-u", await text(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "[IO.Path]::GetTempPath()"])]);
  const dir = await mkdtemp(join(winTemp, "puk-marks-")), winDir = await text(["wslpath", "-w", dir]);
  const chrome = async (args: string[]) => {
    const proc = Bun.spawn([CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars",
      "--force-device-scale-factor=1", `--user-data-dir=${winDir}\\profile`, "--virtual-time-budget=2500", ...args], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 45_000);   // only ever the process started here, by handle
    const out = await new Response(proc.stdout).text();
    await proc.exited; clearTimeout(timer);
    return out;
  };
  try {
    await mkdir(FIXTURES, { recursive: true });
    for (const page of PAGES) {
      const html = await Bun.file(join(FIXTURES, "pages", `${page}.html`)).text();
      const collector = `<pre id="puk-truth" style="display:none"></pre><script>setTimeout(() => {
        const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
        const gold = Object.assign({}, window.__gold || {}), controls = [...(window.__controls || [])];
        for (const el of document.querySelectorAll("[data-gold]")) gold[el.dataset.gold] = rect(el);
        for (const el of document.querySelectorAll(${JSON.stringify(CONTROLS)})) controls.push(rect(el));
        const out = { inner: [innerWidth, innerHeight], today: JSON.parse(${READ_PAGE}), next: JSON.parse(${nextReadPage(READ_PAGE)}), gold, controls };
        document.getElementById("puk-truth").textContent = btoa(unescape(encodeURIComponent(JSON.stringify(out))));
      }, 800);</script>`;
      const end = html.lastIndexOf("</body></html>");   // the last one: an iframe's srcdoc has its own
      await Bun.write(join(dir, `${page}.html`), `${html.slice(0, end)}${collector}${html.slice(end)}`);
      const url = `file:///${winDir.replaceAll("\\", "/")}/${page}.html`;
      // The window is larger than the page by what Chrome keeps for itself in this mode, so the viewport is 1280x800.
      const dom = await chrome([`--window-size=${SIZE.width + 22},${SIZE.height + 98}`, "--dump-dom", url]);
      const found = /<pre id="puk-truth"[^>]*>([^<]+)<\/pre>/.exec(dom);
      if (!found) throw new Error(`${page}: the page did not report its rectangles`);
      const measured = JSON.parse(Buffer.from(found[1]!, "base64").toString("utf8")) as Omit<Truth, "page" | "shot">;
      if (measured.inner[0] !== SIZE.width || measured.inner[1] !== SIZE.height) throw new Error(`${page}: measured at ${measured.inner.join("x")}, not ${SIZE.width}x${SIZE.height}`);
      await chrome([`--window-size=${SIZE.width},${SIZE.height}`, `--screenshot=${winDir}\\${page}.png`, url]);
      await Bun.write(join(FIXTURES, `${page}.png`), Bun.file(join(dir, `${page}.png`)));
      const scrub = (dump: PageDump) => ({ ...dump, url: `https://harness.invalid/${page}` });
      const truth: Truth = { page, shot: `${page}.png`, ...measured, today: scrub(measured.today), next: scrub(measured.next) };
      await Bun.write(join(FIXTURES, `${page}.json`), `${JSON.stringify(truth, null, 1)}\n`);
      console.log(`${page}: ${truth.today.elements.length} named, ${truth.next.unnamed?.length ?? 0} unnamed, ${truth.next.opaque?.length ?? 0} opaque, ${Object.keys(truth.gold).length} gold, ${truth.controls.length} controls`);
    }
  } finally {
    // Chrome's crash handler can hold the profile for a moment after the browser has gone.
    for (let attempt = 0; attempt < 5; attempt++) { try { await rm(dir, { recursive: true, force: true }); break; } catch { await Bun.sleep(600); } }
  }
}

// ---------------------------------------------------------------- fixtures -> what the loop would hold

const GEOMETRY = { area: [0, 0, SIZE.width, SIZE.height] as [number, number, number, number], scale: 1 };
export async function loadTruth(page: string): Promise<{ truth: Truth; png: Uint8Array }> {
  return { truth: await Bun.file(join(FIXTURES, `${page}.json`)).json() as Truth, png: new Uint8Array(await Bun.file(join(FIXTURES, `${page}.png`)).arrayBuffer()) };
}
/** What runScreens holds today: win/observe.ts `pageObservation` over the observer's own dump. */
export const observedToday = (truth: Truth): Markable => pageObservation(truth.today, [truth.today.title], GEOMETRY);
/** The same with the change asked of win/observe.ts: unnamed controls and blind rectangles ride along. */
export function observedNext(truth: Truth): Markable {
  const box = (b: Box) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.max(1, Math.round(b.w)), h: Math.max(1, Math.round(b.h)) });
  return { ...observedToday(truth), unnamed: (truth.next.unnamed ?? []).map((u) => ({ role: u.role, within: u.within, row: u.row, after: u.after, rect: box(u) })), opaque: (truth.next.opaque ?? []).map((o) => ({ kind: o.kind, name: o.name, rect: box(o) })) };
}

async function showMarks(ocr: Ocr): Promise<void> {
  await mkdir(join(ROOT, "out", "marks"), { recursive: true });
  for (const page of PAGES) {
    const { truth, png } = await loadTruth(page), marks = await decompose(observedNext(truth), png, SIZE, { ocr });
    await Bun.write(join(ROOT, "out", "marks", `${page}.png`), marks.image);
    console.log(`\n${page}: ${marks.marks.length} marks ${JSON.stringify(marks.timings)} ${Math.round(marks.image.length / 1024)} KB`);
    for (const line of legendOf(marks.marks)) console.log(`  ${line}`);
  }
}

// ---------------------------------------------------------------- cases

type Class = "icons" | "twins" | "canvas" | "iframe" | "named" | "blocked";
type Case = { id: string; page: (typeof PAGES)[number]; cls: Class; goal: string; gold: string[]; inputs?: Record<string, string>; /** Also asked in the other marking styles. */ styles?: boolean; /** Also asked with `captionAll: false`. */ lean?: boolean };
const CASES: Case[] = [
  { id: "print", page: "editor", cls: "icons", goal: "Print this note.", gold: ["print"], styles: true },
  { id: "attach", page: "editor", cls: "icons", goal: "Attach a file to this note.", gold: ["attach"], lean: true },
  { id: "settings", page: "editor", cls: "icons", goal: "Open the settings of Quill Notes.", gold: ["settings"], styles: true },
  { id: "new-note", page: "editor", cls: "icons", goal: "Create a new note.", gold: ["new_note"] },
  { id: "undo", page: "editor", cls: "icons", goal: "Undo the last change in the note.", gold: ["undo"], lean: true },
  { id: "share-named", page: "editor", cls: "named", goal: "Share this note.", gold: ["@Share"] },
  { id: "delete-report", page: "files", cls: "twins", goal: "Delete the file report-q3.pdf.", gold: ["trash_report_q3"], styles: true },
  { id: "download-budget", page: "files", cls: "twins", goal: "Download budget-2026.xlsx.", gold: ["download_budget_2026"], lean: true },
  { id: "share-photos", page: "files", cls: "twins", goal: "Share the file holiday-photos.zip.", gold: ["share_holiday_photos"], styles: true },
  { id: "delete-invoice", page: "files", cls: "twins", goal: "Delete invoice-0142.pdf.", gold: ["trash_invoice_0142"], lean: true },
  { id: "download-lease", page: "files", cls: "twins", goal: "Download the file lease-agreement.docx.", gold: ["download_lease_agreement"] },
  { id: "eraser", page: "paint", cls: "canvas", goal: "Select the eraser tool in Sketchpad.", gold: ["tool_eraser"], lean: true },
  { id: "red", page: "paint", cls: "canvas", goal: "Choose the red colour in Sketchpad.", gold: ["color_red"], styles: true },
  { id: "export", page: "paint", cls: "canvas", goal: "Export the drawing as a PNG.", gold: ["menu_export_png"] },
  { id: "blue", page: "paint", cls: "canvas", goal: "Choose the blue colour in Sketchpad.", gold: ["color_blue"], lean: true },
  { id: "large", page: "paint", cls: "canvas", goal: "Set the brush size to the largest one.", gold: ["size_large"] },
  { id: "slot", page: "embed", cls: "iframe", goal: "Book a table at Osteria Pellegrino at 7:30 PM.", gold: ["slot_730"], styles: true },
  { id: "find", page: "embed", cls: "iframe", goal: "Find a table for two at Osteria Pellegrino this Thursday.", gold: ["find"], lean: true },
  { id: "email", page: "embed", cls: "iframe", goal: "Put my email address in the booking form so the confirmation reaches me.", gold: ["email"], inputs: { email: "sam.rivera@example.com" } },
  { id: "guest", page: "embed", cls: "iframe", goal: "Add one more guest to the reservation: three people instead of two.", gold: ["guests_plus"], lean: true },
  { id: "botcheck", page: "verify", cls: "blocked", goal: "Download the annual report 2026.", gold: [] },
];

const HAND: Hand = { id: 1, pid: 1, display: "marks-eval", ...SIZE };
const intentOf = (c: Case): Intent => ({ goal: c.goal, launcher: "browser", url: null, inputs: c.inputs ?? {}, doneWhen: "The screen shows that this was done.", avoid: [] });
/** `@Name` is a named element of the page (a control the observer already has); anything else is a `data-gold` key. */
const goldBoxes = (c: Case, truth: Truth): Box[] => c.gold.map((key) => (key.startsWith("@") ? truth.today.elements.find((el) => el.name === key.slice(1))! : truth.gold[key]!));
const within = (p: { x: number; y: number }, b: Box, slack = 0) => p.x >= b.x - slack && p.x <= b.x + b.w + slack && p.y >= b.y - slack && p.y <= b.y + b.h + slack;
const middle = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

// ---------------------------------------------------------------- metered models

type Usage = { inputTokens: number; outputTokens: number; ms: number; cached: boolean };
type Cache = Record<string, { json: unknown; inputTokens: number; outputTokens: number; ms: number }>;
const CACHE = join(ROOT, "out", ".jev-marks-cache.json");

/** The Responses API through jev/openai.ts's own request builder, with what the `Llm` seam hides: tokens and time. */
function meteredLlm(cache: Cache, fresh: boolean): (into: Usage[]) => Llm {
  const apiKey = (process.env.OPENAI_API_KEY ?? process.env.OAI)?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return (into) => async (req: LlmRequest) => {
    const key = Bun.hash(JSON.stringify([req.model, req.effort, req.system, req.user, req.schema, req.imagePng ? Bun.hash(req.imagePng).toString(36) : null])).toString(36);
    const hit = fresh ? undefined : cache[key];
    if (hit) { into.push({ inputTokens: hit.inputTokens, outputTokens: hit.outputTokens, ms: hit.ms, cached: true }); return hit.json; }
    const started = performance.now();
    const res = await fetch(`${base}/responses`, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(responsesBody(req)), signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`OpenAI ${req.model} failed (${res.status}): ${(await res.text()).replaceAll(apiKey, "[redacted]").slice(0, 300)}`);
    const body = await res.json() as { usage?: { input_tokens?: number; output_tokens?: number } }, json = outputJson(body), ms = Math.round(performance.now() - started);
    const entry = { json, inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0, ms };
    cache[key] = entry; into.push({ ...entry, cached: false });
    return json;
  };
}

/** Jev, with patience on a busy signal and the raw answers kept, so a pick can be read even when the decision was "stuck". */
function recordingAsk(ask: Ask, into: { answers: Record<string, unknown>; requests: number; ms: number }): Ask {
  return (async (state: never, questions: never, options?: never) => {
    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      try { const answers = await ask(state, questions, options); into.answers = answers as Record<string, unknown>; into.requests++; into.ms += performance.now() - started; return answers; }
      catch (error) { if (attempt >= 4) throw error; await Bun.sleep(1500 * (attempt + 1)); }
    }
  }) as unknown as Ask;
}

// ---------------------------------------------------------------- one arm: what Jev does with this list and this plan

type Verdict = "right" | "wrong" | "stuck";
type ArmResult = { verdict: Verdict; did: string; pick: string | null; pickRight: boolean; confidence: number; offered: number; jevMs: number };

async function decideWith(ask: Ask, c: Case, truth: Truth, obs: Observation, plan: Plan | null): Promise<ArmResult> {
  const seen = { answers: {} as Record<string, unknown>, requests: 0, ms: 0 }, gold = goldBoxes(c, truth);
  const decision: ScreenDecision = await decideScreen({ ask: recordingAsk(ask, seen), llm: async () => { throw new Error("no text is composed in this eval"); } }, HAND, intentOf(c), obs, { history: [], plan });
  const on = (id: string | undefined) => { const el = obs.elements.find((e) => e.id === id); return Boolean(el && gold.some((g) => within(middle(el.rect), g, 1))); };
  // The element Jev leaned to, whatever the move question said.
  const leaning = Object.entries(seen.answers).filter(([name]) => /^target_\d+$/.test(name)).map(([, v]) => v as { choice: string; confidence: number }).filter((v) => v.choice !== "none_of_these").sort((a, b) => b.confidence - a.confidence)[0];
  let verdict: Verdict = "stuck", did = decision.kind === "escalate" ? `escalate: ${decision.reason}` : decision.kind;
  if (decision.kind === "act") {
    const first = decision.actions.find((a) => "target" in a && a.target) as { kind: string; target: { id: string; name: string } } | undefined;
    verdict = first && on(first.target.id) ? "right" : "wrong";
    did = decision.actions.map((a) => `${a.kind}${"target" in a && a.target ? ` ${a.target.id} ${JSON.stringify(a.target.name)}` : ""}`).join("; ");
  } else if (decision.kind === "done") verdict = "wrong";
  return { verdict, did, pick: leaning?.choice ?? null, pickRight: on(leaning?.choice), confidence: leaning?.confidence ?? 0, offered: obs.elements.length, jevMs: Math.round(seen.ms) };
}

// ---------------------------------------------------------------- one case

type GuessStats = { elements: number; onAControl: number; onTheTarget: boolean; bestOffsetPx: number | null };
type MarkedStats = { style: MarkStyle; usage: Usage; /** The provider would not answer (a policy flag, an outage). Recorded, never reworded and retried. */ refused?: string; blocked: boolean; captions: number; citedRight: boolean; goldOffered: boolean; goldName: string | null; arm: ArmResult | null };
type CaseResult = {
  id: string; page: string; cls: Class; goal: string;
  timing: { decomposeMs: number; ocrMs: number; choosePlannerMs: number; togetherMs: number; marks: Marks["timings"] };
  marks: { total: number; byKind: Record<string, number>; goldHasMark: string[] };
  baseline: ArmResult;
  today: { usage: Usage; refused?: string; blocked: boolean; guesses: GuessStats; wired: ArmResult | null; merged: ArmResult | null; snapped: ArmResult | null };
  marked: MarkedStats[];
  lean: MarkedStats | null;
  local: ArmResult | null;
  recalled: (ArmResult & { added: number; recallMs: number }) | null;
};

function scoreGuesses(plan: Plan, truth: Truth, gold: Box[]): GuessStats {
  const centres = plan.elements.map((el) => middle(el.rect));
  const offsets = gold.flatMap((g) => centres.map((p) => Math.hypot(p.x - middle(g).x, p.y - middle(g).y)));
  return { elements: plan.elements.length, onAControl: centres.filter((p) => truth.controls.some((b) => within(p, b))).length, onTheTarget: centres.some((p) => gold.some((g) => within(p, g))), bestOffsetPx: offsets.length ? Math.round(Math.min(...offsets)) : null };
}

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, ms: 0, cached: false };
const why = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);

async function markedArm(ask: Ask, llmFor: (into: Usage[]) => Llm, planner: PlannerName, c: Case, truth: Truth, next: Markable, marks: Marks, reason: string, style: MarkStyle, captionAll = true): Promise<{ stats: MarkedStats; plan: MarkedPlan | null }> {
  const used: Usage[] = [], gold = goldBoxes(c, truth);
  let plan: MarkedPlan;
  try { plan = await makeMarkedPlan(llmFor(used), planner, HAND, { intent: intentOf(c), history: [], reason, marks, style, captionAll }); }
  catch (error) { return { plan: null, stats: { style, usage: NO_USAGE, refused: why(error), blocked: false, captions: 0, citedRight: false, goldOffered: false, goldName: null, arm: null } }; }
  const obs = applyMarks(next, marks, plan), offered = obs.elements.find((el) => gold.some((g) => within(middle(el.rect), g, 1)));
  const cited = marks.marks.find((m) => m.id === plan.cited.find(Boolean));
  const stats: MarkedStats = { style, usage: used[0]!, blocked: Boolean(plan.blocked), captions: plan.captions.length, citedRight: Boolean(cited && gold.some((g) => within(middle(cited.rect), g, 1))),
    goldOffered: Boolean(offered), goldName: offered?.name ?? null, arm: plan.blocked || c.cls === "blocked" ? null : await decideWith(ask, c, truth, obs, plan) };
  return { stats, plan };
}

// ---------------------------------------------------------------- run

type Options = { only: string[] | null; styles: boolean; planner: PlannerName; fresh: boolean; verbose: boolean };
const OUT = join(ROOT, "out", "jev-marks-eval.json");

async function run(opts: Options): Promise<void> {
  await mkdir(join(ROOT, "out"), { recursive: true });
  const cacheFile = Bun.file(CACHE), cache: Cache = (await cacheFile.exists()) ? await cacheFile.json() : {};
  const ask = createJev(), llmFor = meteredLlm(cache, opts.fresh), ocr = createOcr();
  const cases = CASES.filter((c) => !opts.only || opts.only.includes(c.page) || opts.only.includes(c.id));
  const loaded = new Map(await Promise.all([...new Set(cases.map((c) => c.page))].map(async (page) => [page, await loadTruth(page)] as const)));
  const started = performance.now(), ocrStart = performance.now();
  await ocr.ready();
  const ocrStartMs = Math.round(performance.now() - ocrStart);
  await ocr(loaded.values().next().value!.png);   // the engine's first recognition is slow once; a hand warms it at start-up

  // Phase 1, one case at a time so the clock means something: the local decomposition beside the Jev round trip it hides behind.
  const prepared = new Map<string, { marks: Marks; timing: CaseResult["timing"] }>();
  for (const c of cases) {
    const { truth, png } = loaded.get(c.page)!, today = observedToday(truth), t0 = performance.now();
    let decomposeMs = 0, choosePlannerMs = 0;
    const [marks] = await Promise.all([
      decompose(observedNext(truth), png, SIZE, { ocr }).then((m) => { decomposeMs = Math.round(performance.now() - t0); return m; }),
      choosePlanner(ask, { ...jevState(intentOf(c), today, { history: [], plan: null }, HAND), stuck_because: "unsure which element to click" }).then(() => { choosePlannerMs = Math.round(performance.now() - t0); }),
    ]);
    prepared.set(c.id, { marks, timing: { decomposeMs, ocrMs: marks.timings.ocrMs, choosePlannerMs, togetherMs: Math.round(performance.now() - t0), marks: marks.timings } });
  }

  // Phase 2: pages side by side, a page's cases in order (the first marked plan of a page is what `recalled` draws on).
  const results: CaseResult[] = [];
  await Promise.all([...loaded.keys()].map(async (page) => {
    const memory = createMarkMemory();
    for (const c of cases.filter((x) => x.page === page)) {
      const { truth, png } = loaded.get(page)!, today = observedToday(truth), next = observedNext(truth), gold = goldBoxes(c, truth), { marks, timing } = prepared.get(c.id)!;
      const baseline = await decideWith(ask, c, truth, today, null);
      const reason = baseline.did.startsWith("escalate: ") ? baseline.did.slice(10) : "unsure which element to click";

      const usedToday: Usage[] = [];
      let plan: Plan | null = null, refused: string | undefined;
      try { plan = await makePlan(llmFor(usedToday), opts.planner, HAND, { intent: intentOf(c), history: [], knownElements: Object.values(elementLabels(today.elements, HAND)), reason, screenshotPng: png }); }
      catch (error) { refused = why(error); }
      const guesses = plan ? scoreGuesses(plan, truth, gold) : { elements: 0, onAControl: 0, onTheTarget: false, bestOffsetPx: null };

      // What an earlier look at this same screen taught, before any planner is asked again.
      const recallStarted = performance.now(), remembered = recall(memory, next, png), recallMs = Math.round(performance.now() - recallStarted), added = remembered.elements.length - next.elements.length;
      const recalled = added > 0 ? { ...(await decideWith(ask, c, truth, remembered, null)), added, recallMs } : null;

      const usable = plan && !plan.blocked && c.cls !== "blocked" ? plan : null;
      const [wired, merged, snapped, first] = await Promise.all([
        usable && decideWith(ask, c, truth, today, usable),
        usable && decideWith(ask, c, truth, withVisionElements(today, usable.elements, HAND), usable),
        usable && decideWith(ask, c, truth, withVisionElements(today, snapPlan(usable, marks).elements, HAND), usable),
        markedArm(ask, llmFor, opts.planner, c, truth, next, marks, reason, "drawn"),
      ]);
      if (first.plan) learn(memory, next, marks, first.plan);
      const marked = [first.stats];
      const lean = c.lean ? (await markedArm(ask, llmFor, opts.planner, c, truth, next, marks, reason, "drawn", false)).stats : null;
      // Before any model: does the text OCR read in the blind spot already get Jev there?
      const readable = offerReadable(next, marks), local = readable.elements.length > next.elements.length && c.cls !== "blocked" ? await decideWith(ask, c, truth, readable, null) : null;
      if (opts.styles && c.styles) for (const style of ["legend", "schematic"] as const) marked.push((await markedArm(ask, llmFor, opts.planner, c, truth, next, marks, reason, style)).stats);

      const byKind: Record<string, number> = {};
      for (const m of marks.marks) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
      results.push({ id: c.id, page, cls: c.cls, goal: c.goal, timing, marks: { total: marks.marks.length, byKind, goldHasMark: marks.marks.filter((m) => m.kind !== "cell" && gold.some((g) => within(middle(m.rect), g, 1))).map((m) => `${m.label}:${m.kind}`) },
        baseline, today: { usage: usedToday[0] ?? NO_USAGE, refused, blocked: Boolean(plan?.blocked), guesses, wired, merged, snapped }, marked, lean, local, recalled });
      if (opts.verbose) console.log(`${c.id}: baseline ${baseline.verdict} | merged ${merged?.verdict ?? "-"} | snapped ${snapped?.verdict ?? "-"} | marks ${first.stats.arm?.verdict ?? (first.stats.blocked ? "blocked" : first.stats.refused ? "refused" : "-")} (${first.stats.arm?.did ?? first.stats.refused ?? ""})${refused ? ` | today refused: ${refused}` : ""} | local ${local?.verdict ?? "-"} | recalled ${recalled?.verdict ?? "-"}`);
      await Bun.write(CACHE, JSON.stringify(cache));
    }
  }));
  ocr.close();
  results.sort((a, b) => cases.findIndex((c) => c.id === a.id) - cases.findIndex((c) => c.id === b.id));
  const out = { ran: new Date().toISOString(), planner: opts.planner, model: PLANNERS[opts.planner].model, effort: PLANNERS[opts.planner].effort, ocrStartMs, wallClockS: Math.round((performance.now() - started) / 1000), synthetic: "all five pages are harness pages written for this eval (jev/fixtures/marks/pages)", results };
  await Bun.write(OUT, `${JSON.stringify(out, null, 1)}\n`);
  report(out);
}

// ---------------------------------------------------------------- report

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
const share = (hits: number, of: number) => (of ? `${hits}/${of}` : "-");

function report(out: { planner: string; model: string; effort: string; ocrStartMs: number; results: CaseResult[] }): void {
  const rs = out.results, acting = rs.filter((r) => r.cls !== "blocked");
  const right = (arm: (r: CaseResult) => ArmResult | null | undefined, set: CaseResult[]) => share(set.filter((r) => arm(r)?.verdict === "right").length, set.filter((r) => arm(r) !== undefined).length);
  const drawn = (r: CaseResult) => r.marked.find((m) => m.style === "drawn")!;
  console.log(`\nplanner: ${out.planner} (${out.model}, ${out.effort} effort), ${rs.length} cases\n`);
  console.log("Jev's decision after the plan lands on the gold control (decideScreen, real Jev):");
  console.log("| class | cases | no plan | wired (steps only) | merged (guessed rects) | snapped to marks | marks | recalled, no planner |\n| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const cls of [...new Set(acting.map((r) => r.cls)), "all"]) {
    const set = cls === "all" ? acting : acting.filter((r) => r.cls === cls), seen = set.filter((r) => r.recalled);
    console.log(`| ${cls} | ${set.length} | ${right((r) => r.baseline, set)} | ${right((r) => r.today.wired, set)} | ${right((r) => r.today.merged, set)} | ${right((r) => r.today.snapped, set)} | ${right((r) => drawn(r).arm, set)} | ${share(seen.filter((r) => r.recalled!.verdict === "right").length, seen.length)} |`);
  }
  const wrongs = (arm: (r: CaseResult) => ArmResult | null | undefined) => `${acting.filter((r) => arm(r)?.verdict === "wrong").length} wrong, ${acting.filter((r) => arm(r)?.verdict === "stuck").length} stuck`;
  console.log(`\nnot right: merged ${wrongs((r) => r.today.merged)}; snapped ${wrongs((r) => r.today.snapped)}; marks ${wrongs((r) => drawn(r).arm)}; recalled ${wrongs((r) => r.recalled)}`);

  const g = acting.map((r) => r.today.guesses), all = g.reduce((n, x) => n + x.elements, 0), on = g.reduce((n, x) => n + x.onAControl, 0);
  console.log(`\ntoday's guessed rectangles: ${all} returned over ${acting.length} cases; centre on no control at all: ${all - on}/${all} (${Math.round((100 * (all - on)) / Math.max(1, all))}%); ` +
    `cases where none landed on the target: ${acting.filter((r) => !r.today.guesses.onTheTarget).length}/${acting.length}; nearest guess to the target, median ${median(g.flatMap((x) => (x.bestOffsetPx === null ? [] : [x.bestOffsetPx])))} px`);
  console.log(`marks: the target had a mark in ${acting.filter((r) => r.marks.goldHasMark.length).length}/${acting.length}; the plan's first cited mark was the target in ${acting.filter((r) => drawn(r).citedRight).length}/${acting.length}; the target reached Jev's list in ${acting.filter((r) => drawn(r).goldOffered).length}/${acting.length}`);
  const blocked = rs.filter((r) => r.cls === "blocked");
  for (const r of blocked) console.log(`bot check (${r.id}): today's contract ${r.today.refused ? `was refused by the provider (${r.today.refused})` : r.today.blocked ? "said blocked" : "did NOT say blocked"}; marks ${drawn(r).refused ? `was refused by the provider (${drawn(r).refused})` : drawn(r).blocked ? "said blocked" : "did NOT say blocked"}`);
  const refusals = rs.flatMap((r) => [r.today.refused ? `${r.id}/today` : "", ...r.marked.map((m) => (m.refused ? `${r.id}/${m.style}` : ""))]).filter(Boolean);
  if (refusals.length) console.log(`vision calls the provider would not answer: ${refusals.join(", ")}`);

  // A cached answer keeps the latency of the call that produced it.
  const live = (us: Usage[]) => us.filter((u) => u.ms > 0), t = rs.filter((r) => !r.today.refused).map((r) => r.today.usage), m = rs.filter((r) => !drawn(r).refused).map((r) => drawn(r).usage);
  console.log("\n| vision call | tokens in | tokens out | latency (median) |\n| --- | --- | --- | --- |");
  console.log(`| today's contract | ${Math.round(mean(t.map((u) => u.inputTokens)))} | ${Math.round(mean(t.map((u) => u.outputTokens)))} | ${(median(live(t).map((u) => u.ms)) / 1000).toFixed(1)} s (${live(t).length} calls) |`);
  console.log(`| marks, drawn | ${Math.round(mean(m.map((u) => u.inputTokens)))} | ${Math.round(mean(m.map((u) => u.outputTokens)))} | ${(median(live(m).map((u) => u.ms)) / 1000).toFixed(1)} s (${live(m).length} calls) |`);

  const leans = rs.filter((r) => r.lean && !r.lean.refused);
  if (leans.length) {
    const full = leans.map((r) => drawn(r)), slim = leans.map((r) => r.lean!);
    console.log(`\ncaption everything or only what the steps need (${leans.length} cases):\n| captions | per plan | tokens out | latency | Jev right |\n| --- | --- | --- | --- | --- |`);
    for (const [name, set] of [["every unnamed mark (default)", full], ["only what the steps need", slim]] as const) console.log(`| ${name} | ${mean(set.map((x) => x.captions)).toFixed(1)} | ${Math.round(mean(set.map((x) => x.usage.outputTokens)))} | ${(median(live(set.map((x) => x.usage)).map((u) => u.ms)) / 1000).toFixed(1)} s | ${share(set.filter((x) => x.arm?.verdict === "right").length, set.length)} |`);
  }
  const locals = acting.filter((r) => r.local);
  if (locals.length) console.log(`\nlocal only (OCR text in blind spots offered to Jev, no planner): right ${share(locals.filter((r) => r.local!.verdict === "right").length, locals.length)}, wrong ${locals.filter((r) => r.local!.verdict === "wrong").length}, still stuck ${locals.filter((r) => r.local!.verdict === "stuck").length}   ${locals.map((r) => `${r.id}:${r.local!.verdict}`).join(" ")}`);

  const styled = rs.filter((r) => r.marked.length > 1);
  if (styled.length) {
    console.log(`\nhow the marks reach the model (${styled.length} cases, same marks, same question):\n| style | first cited mark is the target | target reached Jev | Jev right | tokens in | tokens out | latency |\n| --- | --- | --- | --- | --- | --- | --- |`);
    for (const style of ["drawn", "legend", "schematic"] as const) {
      const ms = styled.map((r) => r.marked.find((x) => x.style === style)!).filter(Boolean);
      console.log(`| ${style} | ${share(ms.filter((x) => x.citedRight).length, ms.length)} | ${share(ms.filter((x) => x.goldOffered).length, ms.length)} | ${share(ms.filter((x) => x.arm?.verdict === "right").length, ms.length)} | ${Math.round(mean(ms.map((x) => x.usage.inputTokens)))} | ${Math.round(mean(ms.map((x) => x.usage.outputTokens)))} | ${(median(live(ms.map((x) => x.usage)).map((u) => u.ms)) / 1000).toFixed(1)} s |`);
    }
  }

  const blind = rs.filter((r) => r.timing.ocrMs > 0), sighted = rs.filter((r) => r.timing.ocrMs === 0);
  const added = (set: CaseResult[]) => Math.round(mean(set.map((r) => Math.max(0, r.timing.togetherMs - r.timing.choosePlannerMs))));
  console.log(`\nlocal decomposition (OCR process start ${out.ocrStartMs} ms, once):`);
  console.log("| screens | decompose | of which OCR | regions | draw + encode | choosePlanner beside it | wall clock added | hidden |\n| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [name, set] of [["blind spots (canvas, iframe): OCR runs", blind], ["DOM only: no OCR", sighted]] as const) {
    if (!set.length) continue;
    const d = mean(set.map((r) => r.timing.decomposeMs));
    console.log(`| ${name} | ${Math.round(d)} ms | ${Math.round(mean(set.map((r) => r.timing.ocrMs)))} ms | ${Math.round(mean(set.map((r) => r.timing.marks.regionsMs)))} ms | ${Math.round(mean(set.map((r) => r.timing.marks.drawMs + r.timing.marks.encodeMs)))} ms | ${Math.round(mean(set.map((r) => r.timing.choosePlannerMs)))} ms | ${added(set)} ms | ${Math.round(100 * (1 - added(set) / Math.max(1, d)))}% |`);
  }
  const recalls = rs.filter((r) => r.recalled);
  if (recalls.length) console.log(`\nrecall: ${recalls.length} later looks got ${Math.round(mean(recalls.map((r) => r.recalled!.added)))} elements back in ${Math.round(mean(recalls.map((r) => r.recalled!.recallMs)))} ms, no vision call`);
  console.log("\nper case (marks arm):");
  for (const r of rs) console.log(`  ${r.id.padEnd(16)} ${r.cls.padEnd(8)} ${(drawn(r).arm?.verdict ?? (drawn(r).blocked ? "blocked" : drawn(r).refused ? "refused" : "-")).padEnd(8)} ${drawn(r).arm?.did ?? ""}${drawn(r).goldName ? `   [target offered as ${JSON.stringify(drawn(r).goldName)}]` : ""}`);
}

if (import.meta.main) {
  const command = process.argv[2], flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  if (command === "shoot") await shoot();
  else if (command === "marks") { const ocr = createOcr(); await ocr.ready(); try { await showMarks(ocr); } finally { ocr.close(); } }
  else if (command === "report") report(await Bun.file(OUT).json());
  else await run({ only: flag("only")?.split(",") ?? null, styles: flag("styles") !== "0", planner: flag("planner") === "deep" ? "deep" : "quick", fresh: process.argv.includes("--fresh"), verbose: !process.argv.includes("--quiet") });
}
