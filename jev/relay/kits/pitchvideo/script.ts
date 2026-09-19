// script.ts — a pitch video as data, and everything about it that is exact. Pure.
//
// The writer (an LLM) chooses the scenes, the words and the claims. Code owns what can be counted:
// the shape of each scene, how long its narration takes to say, and whether every number on screen
// or in the narration stands in the passage cited for it. Whether a passage SUPPORTS a claim is a
// judgment, and that one goes to Jev (review.ts).

export const TEMPLATES = {
  title: "The opening: the product's name large, one line under it. No list, no figure.",
  problem: "What is wrong today: two or three pains side by side, each a short title and a line.",
  stat: "One measured figure shown very large, with what it measures and the scope it was measured in.",
  compare: "Two measured values side by side, before and after (or without and with): the same metric twice.",
  how: "How it works: three or four parts in a row joined by arrows, each with a name, its role and a detail.",
  list: "Several separate capabilities as a grid of cards, each with a title and a line.",
  demo: "One task being carried out: what the user asked, then the worker's actions one after another in a small preview window in the corner of the user's screen, then the result.",
  close: "The ending: what to remember and what is asked of the audience.",
} as const;
export type Template = keyof typeof TEMPLATES;

export const ICONS = {
  mic: "speech, voice, listening, a spoken request", bolt: "speed, fast, low latency, milliseconds", brain: "a language model, reasoning, judgment, planning, writing",
  window: "an application window, a desktop, a native app", cursor: "clicking, pointer, input, operating a control", shield: "safety, approval, a gate, permission, blocking a risky action",
  eye: "seeing, a screenshot, vision, observing the screen", layers: "several at once, parallel workers, virtual desktops, background", clock: "time, waiting, slow, duration",
  check: "done, correct, accuracy, verified, solved", mail: "email, a message", globe: "the browser, a web page, a site", list: "choices, a closed set, labels, a form, elements",
  target: "picking the right element, grounding, precision", route: "routing, handoff, choosing who does what, steps in order", lock: "privacy, the user's own screen and focus kept, isolation",
  code: "code, types, a contract, exact work, deterministic", chart: "measurement, an evaluation, results, a benchmark", user: "the user, a person, keeping control", spark: "anything else",
} as const;
export type Icon = keyof typeof ICONS;

export type Claim = { text: string; sources: string[] };
export type Card = { title: string; detail: string; icon?: Icon };
export type Scene = {
  id: string; template: Template; narration: string; headline: string; kicker?: string; claims: Claim[]; seconds?: number;
  sub?: string;                                                    // title
  pains?: Card[];                                                  // problem
  stat?: { value: string; label: string; scope: string };          // stat
  before?: { value: string; label: string }; after?: { value: string; label: string }; metric?: string;   // compare
  steps?: (Card & { role?: string })[];                            // how
  items?: Card[];                                                  // list
  task?: string; actions?: string[]; result?: string;              // demo
  ask?: string; points?: string[];                                 // close
};
export type Script = { title: string; tagline?: string; scenes: Scene[] };

export const WPM = 155, FPS = 30;
export const LIMITS = { scenes: [7, 11], words: [200, 300], sceneWords: [12, 48], headline: 64 } as const;

export const words = (s: string) => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
/** Seconds a narration takes at the speaking rate, to a tenth. Timing is arithmetic, so code does it. */
export const secondsFor = (narration: string) => Math.round((words(narration) / WPM) * 600) / 10;
export const sentencesOf = (s: string) => s.split(/(?<=[.!?]["')]?)\s+(?=["'(]?[A-Z0-9])/).map((x) => x.trim()).filter(Boolean);

// ---------------------------------------------------------------- numbers

const NUMBER_WORDS: Record<string, string> = { two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90", hundred: "100", thousand: "1000", twice: "2" };

/** Every number a text states, as digits: "4,900" -> 4900, "nine" -> 9, "18/18" -> 18, 18. "one" and "a" are not counted: they are mostly not numbers. F8 and e7 are names, not numbers. */
export function numbersIn(text: string): string[] {
  const digits = [...text.matchAll(/(?<![A-Za-z\d.,])\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,(?=\d{3})/g, "").replace(/,$/, "").replace(/^0+(?=\d)/, ""));
  const spoken = [...text.toLowerCase().matchAll(/[a-z]+/g)].map((m) => NUMBER_WORDS[m[0]]).filter((n): n is string => Boolean(n)).flatMap((n) => n.split("/"));
  return [...digits, ...spoken];
}

/** Numbers in `text` that `source` does not have. 98 matches 98% and 98.0; nothing is computed: a difference or a ratio the source does not state is a number it does not have. */
export function numbersMissing(text: string, source: string): string[] {
  const norm = (n: string) => String(Number(n)), have = new Set(numbersIn(source).map(norm));
  return [...new Set(numbersIn(text).filter((n) => !have.has(norm(n))))];
}

// ---------------------------------------------------------------- shape

const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const cards = (v: unknown, min: number, max: number) => Array.isArray(v) && v.length >= min && v.length <= max && v.every((c) => c && str((c as Card).title) && str((c as Card).detail));

/** What each template needs. A message names the scene and says what to write, because it goes back to the writer as it is. */
const NEEDS: Record<Template, (s: Scene) => string | null> = {
  title: (s) => (str(s.sub) ? null : `needs "sub": one line under the name`),
  problem: (s) => (cards(s.pains, 2, 3) ? null : `needs "pains": two or three of { title, detail }`),
  stat: (s) => (s.stat && str(s.stat.value) && str(s.stat.label) && str(s.stat.scope) ? (s.stat.value.length <= 9 ? null : `"stat.value" must be the figure alone, at most 9 characters ("98%", "5.6", "18/18"); put the rest in "stat.label"`) : `needs "stat": { value, label, scope }`),
  compare: (s) => (s.before && s.after && str(s.before.value) && str(s.before.label) && str(s.after.value) && str(s.after.label) && str(s.metric) ? (Math.max(s.before.value.length, s.after.value.length) <= 9 ? null : `"before.value" and "after.value" must be figures alone, at most 9 characters`) : `needs "metric" (what is measured), "before": { value, label } and "after": { value, label }`),
  how: (s) => (cards(s.steps, 3, 4) ? null : `needs "steps": three or four of { title, role, detail }`),
  list: (s) => (cards(s.items, 3, 6) ? null : `needs "items": three to six of { title, detail }`),
  demo: (s) => (str(s.task) && Array.isArray(s.actions) && s.actions.length >= 3 && s.actions.length <= 5 && s.actions.every(str) && str(s.result) ? null : `needs "task" (the request in the user's words), "actions": three to five short strings, and "result"`),
  close: (s) => (str(s.ask) ? null : `needs "ask": what is asked of the audience`),
};

export function parseScript(json: string): { script?: Script; problems: string[] } {
  let raw: unknown;
  try { raw = JSON.parse(json.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "")); } catch (e) { return { problems: [`video/script.json is not valid JSON: ${e instanceof Error ? e.message : e}`] }; }
  const script = raw as Script, problems: string[] = [];
  if (!script || !Array.isArray(script.scenes)) return { problems: [`video/script.json must be { "title", "tagline", "scenes": [...] }`] };
  if (!str(script.title)) problems.push(`the script needs a "title": the product's name`);
  const ids = new Set<string>();
  script.scenes.forEach((s, i) => {
    const at = `scene ${i + 1}${str(s?.id) ? ` (${s.id})` : ""}`;
    if (!s || typeof s !== "object") return void problems.push(`${at}: not an object`);
    if (!str(s.id)) s.id = `scene_${i + 1}`;
    s.id = s.id.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 32) || `scene-${i + 1}`;
    if (ids.has(s.id)) s.id = `${s.id}-${i + 1}`;
    ids.add(s.id);
    if (!Object.hasOwn(TEMPLATES, s.template)) return void problems.push(`${at}: "template" must be one of ${Object.keys(TEMPLATES).join(", ")}`);
    if (!str(s.narration)) problems.push(`${at}: needs "narration"`);
    if (!str(s.headline)) problems.push(`${at}: needs "headline"`); else if (s.headline.length > LIMITS.headline) problems.push(`${at}: "headline" is ${s.headline.length} characters; at most ${LIMITS.headline}`);
    if (!Array.isArray(s.claims)) s.claims = [];
    s.claims = s.claims.filter((c) => c && str(c.text)).map((c) => ({ text: c.text, sources: (Array.isArray(c.sources) ? c.sources : str((c as unknown as { source?: string }).source) ? [(c as unknown as { source: string }).source] : []).filter(str) }));
    const need = NEEDS[s.template](s);
    if (need) problems.push(`${at}, template "${s.template}": ${need}`);
  });
  return { script, problems };
}

/** Length: code sets each scene's seconds from its narration, then says where the words do not fit. */
export function timing(script: Script): { problems: string[]; words: number; seconds: number; wpm: number } {
  const problems: string[] = [];
  for (const s of script.scenes) {
    const n = words(s.narration ?? "");
    s.seconds = secondsFor(s.narration ?? "");
    if (n < LIMITS.sceneWords[0] || n > LIMITS.sceneWords[1]) problems.push(`scene "${s.id}": its narration is ${n} words; a scene's narration is ${LIMITS.sceneWords[0]} to ${LIMITS.sceneWords[1]} words (it is on screen for as long as it takes to say)`);
  }
  const total = script.scenes.reduce((sum, s) => sum + words(s.narration ?? ""), 0), seconds = Math.round(script.scenes.reduce((sum, s) => sum + (s.seconds ?? 0), 0) * 10) / 10;
  const titles = script.scenes.filter((s) => s.template === "title").length, closes = script.scenes.filter((s) => s.template === "close").length;
  if (titles > 1) problems.push(`the "title" template is used ${titles} times; it is the opening and is used once (introduce the product with "list", "how" or "problem" instead)`);
  if (closes !== 1 || script.scenes[script.scenes.length - 1]?.template !== "close") problems.push(`the last scene, and only the last, uses the "close" template`);
  if (script.scenes.length < LIMITS.scenes[0] || script.scenes.length > LIMITS.scenes[1]) problems.push(`there are ${script.scenes.length} scenes; write ${LIMITS.scenes[0]} to ${LIMITS.scenes[1]}`);
  if (total < LIMITS.words[0] || total > LIMITS.words[1]) problems.push(`the narration is ${total} words in all (${seconds} s at ${WPM} words a minute); write ${LIMITS.words[0]} to ${LIMITS.words[1]} words, ${total > LIMITS.words[1] ? `so cut about ${total - 250}` : `so add about ${250 - total}`}`);
  return { problems, words: total, seconds, wpm: seconds ? Math.round((total / seconds) * 60) : 0 };
}

/** Everything a scene puts in front of the viewer: its narration and every string a template draws. */
export function shownText(s: Scene): string[] {
  const card = (c: Card & { role?: string }) => [c.title, c.role, c.detail];
  return [s.narration, s.headline, s.kicker, s.sub, ...(s.pains ?? []).flatMap(card), s.stat?.value, s.stat?.label, s.stat?.scope, s.metric, s.before?.value, s.before?.label, s.after?.value, s.after?.label,
    ...(s.steps ?? []).flatMap(card), ...(s.items ?? []).flatMap(card), s.task, ...(s.actions ?? []), s.result, s.ask, ...(s.points ?? [])].filter(str);
}
