// learned.ts — a plan the LLM wrote once becomes a recipe Jev can fill in alone next time.
//
// recipes.ts is four task shapes written by hand. plan.ts handles the rest with
// an LLM call of a couple of seconds. When such a plan has worked, the same model
// is asked (in the background, after the task is done) to rewrite it with the
// specifics taken out: "{title}" where the title was. Next time a request of that
// shape comes, Jev picks the shape and marks where each part is in what was said,
// the same two-choice span pick recipes.ts uses, and code fills the template.
// One Jev request, no LLM.
//
//   generalise(llm, said, task)        -> Learned | null     after a planned task finished
//   learnedIntent(ask, said, store)    -> { intent, shape } | null
//
// Only plans whose every specific is a literal run of the request are kept. A
// date worked out from "tomorrow" is not, and a template that still carries one
// is refused: replaying last week's date would be worse than planning again.

import type { Intent } from "./intent";
import { choice, noul, type Ask, type ChoiceResponse, type NoulResponse, type Questions } from "./jev";
import type { JsonSchema, Llm } from "./openai";
import { PLAN_MODELS, type PlannedTask } from "./plan";

// ---------------------------------------------------------------- types

export type Learned = {
  shape: string;
  /** Templates: `{name}` stands for the input of that name. In `url` it is filled in percent-encoded. */
  goal: string; url: string; steps: string[]; doneWhen: string; avoid: string[];
  /** Parts of the request Jev marks: the name and what the part is ("the title of the note"). */
  slots: { name: string; what: string }[];
  uses: number;
};
export type LearnedStore = { all(): Learned[]; add(recipe: Learned): void; used(shape: string): void };

// ---------------------------------------------------------------- config

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

// ---------------------------------------------------------------- stores

export function memoryStore(seed: Learned[] = []): LearnedStore {
  const recipes = [...seed];
  return {
    all: () => [...recipes].sort((a, b) => b.uses - a.uses),
    add(recipe) { const at = recipes.findIndex((r) => r.shape.toLowerCase() === recipe.shape.toLowerCase()); if (at >= 0) recipes[at] = { ...recipe, uses: recipes[at]!.uses }; else recipes.push(recipe); },
    used(shape) { const hit = recipes.find((r) => r.shape === shape); if (hit) hit.uses++; },
  };
}

/** The same, kept in a JSON file. A file that cannot be read is an empty store, not an error. */
export async function fileStore(path = process.env.PUK_LEARNED ?? "out/jev-learned.json"): Promise<LearnedStore> {
  const seed = await Bun.file(path).json().then((raw) => (Array.isArray(raw) ? raw.filter(isLearned) : []), () => []);
  const store = memoryStore(seed), save = () => void Bun.write(path, JSON.stringify(store.all(), null, 2)).catch(() => {});
  return { all: store.all, add: (recipe) => { store.add(recipe); save(); }, used: (shape) => { store.used(shape); save(); } };
}

function isLearned(r: unknown): r is Learned {
  const x = r as Learned;
  return typeof x?.shape === "string" && typeof x.goal === "string" && typeof x.url === "string" && typeof x.doneWhen === "string" && Array.isArray(x.steps) && Array.isArray(x.avoid) && Array.isArray(x.slots)
    && x.slots.every((s) => typeof s?.name === "string" && typeof s.what === "string") && URL.parse(fill(x.url, {}, true))?.protocol === "https:";
}

// ---------------------------------------------------------------- templates

const fill = (template: string, values: Record<string, string>, encoded = false) => template.replace(/\{([a-z0-9_]+)\}/g, (_, name: string) => (encoded ? encodeURIComponent(values[name] ?? "") : values[name] ?? ""));
const placeholders = (text: string) => [...text.matchAll(/\{([a-z0-9_]+)\}/g)].map((m) => m[1]!);
/** A year, an ISO date or a clock time left in a template is a specific that would be replayed stale. */
const STALE = /\b20\d\d\b|\d{4}-\d{2}-\d{2}|\b\d{1,2}:\d{2}\b/;

/** After a planned task finished: the plan with its specifics taken out, or null when it cannot be reused safely. */
export async function generalise(llm: Llm, said: string, task: PlannedTask): Promise<Learned | null> {
  const intent = task.intent, names = Object.keys(intent.inputs);
  // Every input has to be a literal run of the request, or Jev could not find it in the next one.
  // Whether it is one is a string comparison, so code decides it, not a model.
  const flat = said.toLowerCase().replace(/\s+/g, " ");
  if (names.some((n) => !flat.includes(intent.inputs[n]!.toLowerCase().replace(/\s+/g, " ").replace(/[.!?]$/, "")))) return null;
  const raw = (await llm({ ...PLAN_MODELS.quick, system: GENERAL_SYSTEM, schema: GENERAL_SCHEMA,
    user: JSON.stringify({ request: said, plan: { goal: intent.goal, url: intent.url, steps: intent.steps ?? [], done_when: intent.doneWhen }, parts: intent.inputs }) })) as Record<string, unknown>;
  if (raw?.reusable !== true || typeof raw.shape !== "string" || typeof raw.goal !== "string" || typeof raw.url !== "string" || typeof raw.done_when !== "string" || !Array.isArray(raw.steps)) return null;
  const steps = (raw.steps as unknown[]).filter((s): s is string => typeof s === "string");
  const texts = [raw.goal, raw.url, raw.done_when, ...steps];
  // The model's word is not enough: no placeholder we cannot fill, no stale specific, and the same site as the plan that worked.
  if (texts.flatMap(placeholders).some((p) => !names.includes(p)) || texts.some((t) => STALE.test(t))) return null;
  if (URL.parse(fill(raw.url, intent.inputs, true))?.host !== URL.parse(intent.url ?? "")?.host) return null;
  const whats = new Map((Array.isArray(raw.parts) ? (raw.parts as { name?: unknown; what?: unknown }[]) : []).map((p) => [String(p?.name), String(p?.what ?? "").trim().slice(0, 120)]));
  if (names.some((n) => !whats.get(n))) return null;
  return { shape: raw.shape.trim().slice(0, 160), goal: raw.goal, url: raw.url, steps, doneWhen: raw.done_when, avoid: intent.avoid, slots: names.map((name) => ({ name, what: whats.get(name)! })), uses: 0 };
}

// ---------------------------------------------------------------- recall

type Edge = ChoiceResponse;
function edge(answer: Edge): number { // as in recipes.ts: an edge torn between neighbours is not an unsure edge
  const i = Number(answer.choice.slice(1));
  return Math.min(1, [i - 1, i, i + 1].reduce((sum, k) => sum + (answer.probabilities[`w${k}`] ?? 0), 0));
}

/** One request: which learned shape is this, and where in `said` is each of its parts? Null when none fits. */
export async function learnedIntent(ask: Ask, said: string, store: LearnedStore): Promise<{ intent: Intent; shape: string; confidence: number } | null> {
  const recipes = store.all().slice(0, MAX_ASKED), request = said.trim(), words = request.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  if (!recipes.length || words.length < 2) return null;
  const labels = Object.fromEntries(words.map((w, i) => [`w${i + 1}`, `"${w}" in: ${words.slice(Math.max(0, i - 2), i).join(" ")} [${w}] ${words.slice(i + 1, i + 3).join(" ")}`.trim()]));

  const questions: Questions = {
    shape: choice("Which kind of task is `request`?", { ...Object.fromEntries(recipes.map((r, i) => [`r${i + 1}`, r.shape])), [NONE]: "None of these, or more than one task, or it is unclear." }),
  };
  recipes.forEach((r, i) => {
    // Asked for every shape at once, so that the right one needs no second request.
    questions[`r${i + 1}_covers`] = noul(`Everything \`request\` asks for is this and nothing more: ${r.shape}${r.slots.length ? `, given ${r.slots.map((s) => s.what).join(", ")}` : ""}.`);
    for (const slot of r.slots) {
      questions[`r${i + 1}_${slot.name}_from`] = choice(`Part of \`request\` is ${slot.what}. Which word is the FIRST word of that part? Words that only give the order come before it and are not part of it.`, labels);
      questions[`r${i + 1}_${slot.name}_to`] = choice(`Part of \`request\` is ${slot.what}. Which word is the LAST word of that part?`, labels);
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
  return { shape: recipe.shape, confidence: Math.min(...sure), intent: { goal: fill(recipe.goal, values), launcher: "browser", url: url.href, inputs: values, doneWhen: fill(recipe.doneWhen, values), avoid: recipe.avoid, steps: recipe.steps.map((s) => fill(s, values)) } };
}
