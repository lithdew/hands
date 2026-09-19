/**
 * A plan the model wrote once becomes a recipe Jev can fill in alone next time.
 *
 * recipes.ts is a few task shapes written by hand; plan.ts handles the rest with a model call of a couple of
 * seconds. When such a plan has worked, the same model is asked (in the background, after the task is done) to
 * rewrite it with the specifics taken out: "{title}" where the title was. Next time a request of that shape comes,
 * Jev picks the shape and marks where each part is in what was said, the same two-choice span pick recipes.ts
 * uses, and code fills the template. One Jev request, no model.
 *
 * Only plans whose every specific is a literal run of the request are kept. A date worked out from "tomorrow" is
 * not, and a template that still carries one is refused: replaying last week's date would be worse than planning again.
 *
 * A specific is not always an input. A search plan types nothing: what was asked for rides in its link
 * (`linkParts`), and it is taken out by name like the rest. Before that was checked, a model made up
 * "{what to search for}" by itself, only {snake_case} was looked for, and a hand was sent that sentence 13 times.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { type Ask, type ChoiceResponse, choice, type NoulResponse, noul, type Questions } from "./ask.ts";
import type { Intent, JsonSchema, Llm } from "./intent.ts";
import { KNOWN_SITES, type PlannedTask } from "./plan.ts";

// ------------------------------------------------------------------ types

export type Learned = {
  shape: string;
  /** Templates: `{name}` stands for the input of that name. In `url` it is filled in percent-encoded. */
  goal: string; url: string; steps: string[]; doneWhen: string; avoid: string[];
  /** Parts of the request Jev marks: the name and what the part is ("the title of the note"). `link`: it rides in the url and is never typed. */
  slots: { name: string; what: string; link?: boolean }[];
  uses: number;
  /** 2: what the link carries was taken out too. A recipe from before is not read back, a search may be baked into its url. */
  v: typeof VERSION;
};
export type LearnedStore = { all(): Learned[]; add(recipe: Learned): void; used(shape: string): void };

// ------------------------------------------------------------------ config

const VERSION = 2;
const MIN_CONFIDENCE = 0.5, MIN_SHAPE_CONFIDENCE = 0.6;
/** Every learned shape adds its span questions to the one request, so only the most used are asked about. */
const MAX_ASKED = 12, MAX_WORDS = 120, NONE = "none_of_these";

const GENERAL_SCHEMA: JsonSchema = {
  name: "general_plan",
  schema: { type: "object", additionalProperties: false, required: ["reusable", "shape", "goal", "url", "steps", "done_when", "parts"],
    properties: { reusable: { type: "boolean" }, shape: { type: "string" }, goal: { type: "string" }, url: { type: "string" }, steps: { type: "array", items: { type: "string" } }, done_when: { type: "string" },
      parts: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "what"], properties: { name: { type: "string" }, what: { type: "string" } } } } } },
};

const GENERAL_SYSTEM = `A plan for a spoken request worked. Rewrite it so it can be reused for other requests of the same kind.
You get the request, the plan, and "parts": named pieces of the plan that are word for word from the request.
Replace every occurrence of a part's text in goal, url, steps and done_when with {name} (in the url too, where the text may be percent-encoded). Change nothing else.
- shape: the kind of task with no specifics, e.g. "Add a titled note in Google Keep".
- parts: for each part, its name and "what": a few plain words saying what that piece of a request is, e.g. "the title of the note", "what the note should say". Someone will use them to find the same piece in a different request.
- reusable: true only if, after that, nothing specific to this one request is left anywhere: no date, time, number, name, address or wording that came from the request or from today's date. If anything such is left, false.`;

// ------------------------------------------------------------------ stores

export function memoryStore(seed: Learned[] = []): LearnedStore {
  const recipes = [...seed];
  return {
    all: () => [...recipes].sort((a, b) => b.uses - a.uses),
    add(recipe) { const at = recipes.findIndex((r) => r.shape.toLowerCase() === recipe.shape.toLowerCase()); if (at >= 0) recipes[at] = { ...recipe, uses: recipes[at]!.uses }; else recipes.push(recipe); },
    used(shape) { const hit = recipes.find((r) => r.shape === shape); if (hit) hit.uses++; },
  };
}

/** The same, kept in a JSON file. A file that cannot be read is an empty store, not an error. */
export async function fileStore(path = process.env.HANDS_LEARNED ?? join(homedir(), ".hands", "learned.json")): Promise<LearnedStore> {
  const seed = await Bun.file(path).json().then((raw) => (Array.isArray(raw) ? raw.filter(isLearned) : []), () => []);
  const store = memoryStore(seed), save = () => void Bun.write(path, JSON.stringify(store.all(), null, 2)).catch(() => {});
  return { all: store.all, add: (recipe) => { store.add(recipe); save(); }, used: (shape) => { store.used(shape); save(); } };
}

function isLearned(r: unknown): r is Learned {
  const x = r as Learned;
  return x?.v === VERSION && typeof x.shape === "string" && typeof x.goal === "string" && typeof x.url === "string" && typeof x.doneWhen === "string" && Array.isArray(x.steps) && x.steps.every((s) => typeof s === "string") && Array.isArray(x.avoid) && Array.isArray(x.slots)
    && x.slots.every((s) => typeof s?.name === "string" && typeof s.what === "string") && sound(x) && URL.parse(fill(x.url, {}, true))?.protocol === "https:";
}

// ------------------------------------------------------------------ templates

const fill = (template: string, values: Record<string, string>, encoded = false) => template.replace(/\{([a-z0-9_]+)\}/g, (_, name: string) => (encoded ? encodeURIComponent(values[name] ?? "") : values[name] ?? ""));
/** Anything in braces, plain or percent-encoded, whatever is inside: a model also writes {what to search for}, and `fill` leaves that as it is. */
const BRACES = /\{([^{}]*)\}|%7B(.*?)%7D/gi;
const placeholders = (text: string) => [...text.matchAll(BRACES)].map((m) => m[1] ?? m[2]!);
const templates = (r: Pick<Learned, "goal" | "url" | "doneWhen" | "steps">) => [r.goal, r.url, r.doneWhen, ...r.steps];
/** Every part of the recipe is one Jev will be asked for. Otherwise the braces would reach a hand as they are. */
const sound = (r: Learned) => templates(r).flatMap(placeholders).every((p) => r.slots.some((s) => s.name === p));
/** Nothing in braces is left in what a hand would be given. */
export const filledIn = (intent: Intent) => !templates({ goal: intent.goal, url: intent.url ?? "", doneWhen: intent.doneWhen, steps: intent.steps ?? [] }).some((t) => placeholders(t).length);
/** A year, an ISO date or a clock time left in a template is a specific that would be replayed stale. */
const STALE = /\b20\d\d\b|\d{4}-\d{2}-\d{2}|\b\d{1,2}:\d{2}\b/;

// ------------------------------------------------------------------ what the link carries

const spoken = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const decoded = (text: string) => { try { return decodeURIComponent(text.replace(/\+/g, " ")); } catch { return text; } };
/** Words of a known site's own link ("maps", "search", "results") are its address, whatever the request says. */
const SITE_WORDS = new Set(KNOWN_SITES.flatMap((s) => [s.home, s.link.split(" ")[0]!]).flatMap((u) => spoken(URL.parse(u)?.pathname ?? "")));

/**
 * The pieces of a plan's link that came from the request, by name: {search_query: "lofi hip hop"}.
 * Null when a piece has words of the request and is not a literal run of it (the model reworded it,
 * or looked an address up), or when it is one bare word of the path, which may as well be the site's
 * own ("search"). Either way Jev could not be asked for it next time. A string comparison, no model.
 */
export function linkParts(link: string | null, said: string, inputs: Record<string, string>): Record<string, string> | null {
  const url = URL.parse(link ?? ""), parts: Record<string, string> = {};
  if (!url) return parts;
  const heard = spoken(said), flat = ` ${heard.join(" ")} `, typed = new Set(Object.values(inputs).map((v) => spoken(v).join(" ")));
  const pieces = [...[...url.searchParams].map(([key, text]) => ({ key, text, query: true })),
    ...[...url.pathname.split("/"), ...url.hash.slice(1).split(/[\/=&]/)].map((piece) => ({ key: "link_text", text: decoded(piece), query: false }))];
  for (const { key, text, query } of pieces) {
    const words = spoken(text);
    if (!words.some((w) => w.length >= 3 && heard.includes(w)) || typed.has(words.join(" "))) continue; // the site's own, or an input the model will take out by its name
    if (!query && words.length === 1) { if (SITE_WORDS.has(words[0]!)) continue; return null; }
    if (!flat.includes(` ${words.join(" ")} `)) return null;
    let name = key.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "link_text";
    while (Object.hasOwn(inputs, name) || Object.hasOwn(parts, name)) name += "_";
    parts[name] = text.trim();
  }
  return parts;
}

/** The template, filled in again, is the link that worked: same place, same values, however each was encoded. */
function sameLink(a: string, b: string | null): boolean {
  const x = URL.parse(a), y = URL.parse(b ?? "");
  return !!x && !!y && x.origin === y.origin && decoded(x.pathname) === decoded(y.pathname) && decoded(x.hash) === decoded(y.hash) && JSON.stringify([...x.searchParams].sort()) === JSON.stringify([...y.searchParams].sort());
}

// ------------------------------------------------------------------ generalise

/** After a planned task finished: the plan with its specifics taken out, or null when it cannot be reused safely. */
export async function generalise(llm: Llm, said: string, task: PlannedTask): Promise<Learned | null> {
  const intent = task.intent;
  // Every input has to be a literal run of the request, or Jev could not find it in the next one.
  // Whether it is one is a string comparison, so code decides it, not a model.
  const flat = said.toLowerCase().replace(/\s+/g, " ");
  if (Object.values(intent.inputs).some((v) => !flat.includes(v.toLowerCase().replace(/\s+/g, " ").replace(/[.!?]$/, "")))) return null;
  // The same goes for what the link carries. With no inputs and nothing named here, the model was left to name a part itself.
  const carried = linkParts(intent.url, said, intent.inputs);
  if (!carried) return null;
  const parts = { ...intent.inputs, ...carried }, names = Object.keys(parts);
  const raw = (await llm({ system: GENERAL_SYSTEM, schema: GENERAL_SCHEMA,
    user: JSON.stringify({ request: said, plan: { goal: intent.goal, url: intent.url, steps: intent.steps ?? [], done_when: intent.doneWhen }, parts }) })) as Record<string, unknown>;
  if (raw?.reusable !== true || typeof raw.shape !== "string" || typeof raw.goal !== "string" || typeof raw.url !== "string" || typeof raw.done_when !== "string" || !Array.isArray(raw.steps)) return null;
  // Models also percent-encode the braces inside a url, as they do with {email:...} in plan.ts.
  const plain = (text: string) => text.replace(/%7B([a-z0-9_]+)%7D/gi, "{$1}");
  const steps = (raw.steps as unknown[]).filter((s): s is string => typeof s === "string").map(plain), url = plain(raw.url);
  const texts = [raw.goal, url, raw.done_when, ...steps];
  // The model's word is not enough: no placeholder we cannot fill, no stale specific, and filled in again it is the link that worked.
  if (texts.flatMap(placeholders).some((p) => !names.includes(p)) || texts.some((t) => STALE.test(t))) return null;
  if (!sameLink(fill(url, parts, true), intent.url)) return null;
  // Nor may a part stay behind where it was: in the link it would be searched for again whatever is asked next time.
  const left = ` ${spoken(decoded(texts.map((t) => t.replace(BRACES, " ")).join(" | "))).join(" ")} `;
  if (names.some((n) => left.includes(` ${spoken(parts[n]!).join(" ")} `)) || Object.keys(carried).some((n) => !placeholders(url).includes(n))) return null;
  const whats = new Map((Array.isArray(raw.parts) ? (raw.parts as { name?: unknown; what?: unknown }[]) : []).map((p) => [String(p?.name), String(p?.what ?? "").trim().slice(0, 120)]));
  if (names.some((n) => !whats.get(n))) return null;
  return { shape: raw.shape.trim().slice(0, 160), goal: raw.goal, url, steps, doneWhen: raw.done_when, avoid: intent.avoid, slots: names.map((name) => ({ name, what: whats.get(name)!, ...(Object.hasOwn(carried, name) ? { link: true } : {}) })), uses: 0, v: VERSION };
}

// ------------------------------------------------------------------ recall

type Edge = ChoiceResponse;
function edge(answer: Edge): number { // as in recipes.ts: an edge torn between neighbours is not an unsure edge
  const i = Number(answer.choice.slice(1));
  return Math.min(1, [i - 1, i, i + 1].reduce((sum, k) => sum + (answer.probabilities[`w${k}`] ?? 0), 0));
}

/** One request: which learned shape is this, and where in `said` is each of its parts? Null when none fits. */
export async function learnedIntent(ask: Ask, said: string, store: LearnedStore): Promise<{ intent: Intent; shape: string; confidence: number } | null> {
  const recipes = store.all().filter(sound).slice(0, MAX_ASKED), request = said.trim(), words = request.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  if (!recipes.length || words.length < 2) return null;
  const labels = Object.fromEntries(words.map((w, i) => [`w${i + 1}`, `"${w}" in: ${words.slice(Math.max(0, i - 2), i).join(" ")} [${w}] ${words.slice(i + 1, i + 3).join(" ")}`.trim()]));

  const questions: Questions = {
    shape: choice("Which kind of task is `request`?", { ...Object.fromEntries(recipes.map((r, i) => [`r${i + 1}`, r.shape])), [NONE]: "None of these, or more than one task, or it is unclear." }),
  };
  recipes.forEach((r, i) => {
    // Asked for every shape at once, so that the right one needs no second request.
    questions[`r${i + 1}_covers`] = noul(`Everything \`request\` asks for is this and nothing more: ${r.shape}${r.slots.length ? `, given ${r.slots.map((s) => s.what).join(", ")}` : ""}.`);
    for (const slot of r.slots) {
      questions[`r${i + 1}_${slot.name}_from`] = choice(`Part of \`request\` is ${slot.what}. Which word is the FIRST word of that part? Words before it that only give the order or say where to do it, such as the name of a website or an app, are not part of it.`, labels);
      // Jev reads literally: left at "the last word", a search ran on to the end, "lofi hip hop video on youtube".
      questions[`r${i + 1}_${slot.name}_to`] = choice(`Part of \`request\` is ${slot.what}. Which word is the LAST word of that part? Words after it that only say where to do it, such as the name of a website or an app, are not part of it.`, labels);
    }
  });
  // The questions are only known at run time, so their answers are read by name.
  const answers = await ask({ request }, questions);
  const picks = answers as unknown as Record<string, ChoiceResponse>, nouls = answers as unknown as Record<string, NoulResponse>;

  const picked = picks.shape!.choice, at = Number(picked.slice(1)) - 1, recipe = recipes[at];
  if (picked === NONE || !recipe || picks.shape!.confidence < MIN_SHAPE_CONFIDENCE || nouls[`${picked}_covers`]!.noul < 0.5) return null;
  const sure = [picks.shape!.confidence], values: Record<string, string> = {};
  for (const slot of recipe.slots) {
    const from = picks[`${picked}_${slot.name}_from`]!, to = picks[`${picked}_${slot.name}_to`]!, i = Number(from.choice.slice(1)) - 1, j = Number(to.choice.slice(1)) - 1;
    const text = i >= 0 && j >= i ? words.slice(i, j + 1).join(" ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.!?)]+$/gu, "") : "";
    if (!text || Math.min(edge(from), edge(to)) < MIN_CONFIDENCE) return null;
    sure.push(edge(from), edge(to));
    values[slot.name] = text;
  }
  const url = URL.parse(fill(recipe.url, values, true));
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  store.used(recipe.shape);
  // What rides in the link is not offered to a field: the page arrives with it searched for.
  const inputs = Object.fromEntries(recipe.slots.filter((s) => !s.link).map((s) => [s.name, values[s.name]!]));
  return { shape: recipe.shape, confidence: Math.min(...sure), intent: { goal: fill(recipe.goal, values), url: url.href, inputs, doneWhen: fill(recipe.doneWhen, values), avoid: recipe.avoid, steps: recipe.steps.map((s) => fill(s, values)) } };
}
