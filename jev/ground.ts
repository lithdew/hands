// ground.ts — a screen as choices: how a goal is grounded in one element, without vision.
//
// Jev cannot point. It picks one of at most 255 labels, or says how true one sentence
// is. So "click the right thing" is a question of presentation: which words stand for
// each element, where they go (state or criteria), and what happens past 255 elements.
// Every presenter here takes the same (task, observation) and costs ONE round trip:
//
//   today          what cua.ts `decide` sends: elements in `state.screen` AND again as criteria
//   criteria       descriptions only in the criteria; past 250 elements, several Choices in one request
//   bareIds        elements once in state as `e7: button "Send"`, criteria are bare ids
//   pruned         a code-side prefilter to the top K, then `criteria`
//   nouls          one Noul per element, all in one request (absolute, not relative)
//   grouped        a Choice per container plus a Choice over the containers, same request; P(group) x P(element)
//   flattened      one Choice over whole actions: click X, type input into Y, press Enter, scroll, done
//
// `describe` is the vocabulary: a `Look` switches role, region, container, field state and
// nearby text on and off, and `ocr` strips an element to what a screenshot OCR would give.
// ground.eval.ts measures all of it. What won is `ground` at the bottom: bare ids, the list once in state,
// the wording that says what a match is, and a confidence floor below which the vision model is asked.

import { APIError, TypeSafeClient, choice, noul, type ChoiceResponse, type EntryType, type NoulResponse, type Questions } from "@typesafe-ai/sdk";
import { KEYS, MOVES, elementLabels, jevState } from "./cua";
import { COMPOSE_LABEL } from "./intent";
import { jevApiKey } from "./jev";
import { MAX_ELEMENTS, regionOf, type Observation, type UiElement } from "./observe";

// ---------------------------------------------------------------- types

/** A UiElement plus what a DOM gives for free. `icon`: no visible text, the name comes from aria-label/alt/title. */
export type Candidate = UiElement & { href?: string; icon?: boolean; region?: string; row?: string };
export type Screen = Omit<Observation, "elements"> & { elements: Candidate[] };
export type Task = { goal: string; inputs: Record<string, string>; history: string[]; doneWhen?: string };
/** `click`: which element. `field`: which text field, and which prepared input. */
export type Want = "click" | "field";

/** The words one element gets. */
export type Look = {
  role: boolean; region: boolean; within: boolean;
  /** Field state: `containing "x"` / `empty` / `focused`. */
  state: boolean;
  /** How identical descriptions are told apart. */
  twins: "ordinal" | "near" | "none";
  /** Screenshot proxy: visible text only, a field shows its value, an element without visible text is `icon`. */
  ocr: boolean;
  /** With `ocr`: an icon captioner names the icons (optimistically, with their accessible name). */
  caption: boolean;
};
export const FULL: Look = { role: true, region: true, within: true, state: true, twins: "ordinal", ocr: false, caption: false };

export type Wording = { click: EntryType; field: EntryType; none: string; noField: string };
export type Meter = { requests: number; rounds: number; ms: number; tokens: number };
export type Grounded = {
  /** Element id, FOCUSED_FIELD, or NONE. */
  pick: string;
  input: string | null;
  /** Canonical whole action, from presenters that decide one: click_e7, type_body_e9, key_Return, scroll_down, done, none. */
  action: string | null;
  confidence: number;
  prob: number;
  /** Best first. NONE may be among them. */
  ranked: [string, number][];
  meter: Meter;
  /** Absolute yes/no answers asked next to the Choice, e.g. "what the goal needs is listed". */
  checks?: Record<string, number>;
  note?: string;
};
export type Ctx = { ask: AskRaw; hand: { width: number; height: number }; look?: Look; wording?: Wording; k?: number; by?: "within" | "chunk"; describeCriteria?: boolean };
export type Presenter = (task: Task, screen: Screen, want: Want, ctx: Ctx) => Promise<Grounded>;

type Answer = ChoiceResponse | NoulResponse;
export type AskRaw = (state: EntryType, questions: Questions) => Promise<{ answers: Record<string, Answer>; tokens: number; ms: number }>;

// ---------------------------------------------------------------- config

export const NONE = "none_of_these";
export const FOCUSED_FIELD = "focused_field";
/** Elements per Choice. 255 is the API limit; the rest is room for none_of_these and focused_field. */
const PER_CHOICE = 250;
const PER_NOUL_REQUEST = 400;
const GROUP_MAX = 40;
const HISTORY_SHOWN = 10;
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

export const WORDINGS = {
  /** cua.ts `decide`, word for word. */
  today: {
    click: "If the worker clicks one element next to make progress on `goal`, which one?",
    field: "If the worker types into a field next, which field?",
    none: "No listed element is the right thing to click.",
    noField: "No listed field is right, and no field has focus.",
  },
  /** Says what a match is, and that a lookalike is not one. */
  direct: {
    click: "Which one element does the worker have to click now to carry out `goal`? The right element has the name, or sits in the container, that `goal` talks about. Choose none_of_these when what `goal` talks about is not listed.",
    field: "Which one text field does the worker have to type into now to carry out `goal`? Choose none_of_these when no listed field is meant for it.",
    none: "What `goal` needs is not in this list. An element that only has a similar name is not it.",
    noField: "What `goal` needs is not in this list, and no field has focus.",
  },
} satisfies Record<string, Wording>;

/** Structured instructions with the goal written into the question itself: one hop less than "`goal`". */
export function inlineWording(task: Task): Wording {
  return {
    click: { goal: task.goal, question: "Which one element does the worker click next to carry out the goal above?", rule: "Choose none_of_these when the element the goal needs is not listed." },
    field: { goal: task.goal, question: "Which one text field does the worker type into next to carry out the goal above?", rule: "Choose none_of_these when the field the goal needs is not listed." },
    none: WORDINGS.direct.none, noField: WORDINGS.direct.noField,
  };
}

// ---------------------------------------------------------------- words

const preview = (text: string, max = 80) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max)}...` : flat; };

/** What a screenshot shows of an element: its text, a field's content instead of its label, nothing for an icon. */
function visibleText(el: Candidate, look: Look): string | null {
  if (el.icon) return look.caption ? el.name : null;
  return (el.editable || el.role === "dropdown") && el.value ? el.value : el.name;
}

/** The words Jev reads for one element, before twins are told apart. */
export function describe(el: Candidate, hand: { width: number; height: number }, look: Look = FULL): string {
  const text = look.ocr ? visibleText(el, look) : el.name || null;
  const parts = [look.role ? el.role : "", text === null ? (look.ocr ? "icon" : "(no name)") : JSON.stringify(text)].filter(Boolean);
  if (look.state && el.editable) parts.push(el.value ? `containing ${JSON.stringify(preview(el.value, 60))}` : "empty");
  if (look.state && el.focused) parts.push("focused");
  const where: string[] = [];
  if (look.region) where.push(el.region ?? regionOf(el.rect, hand));
  if (look.within && el.within && el.within !== el.name) where.push(`in ${JSON.stringify(el.within)}`);
  return where.length ? `${parts.join(" ")} (${where.join(", ")})` : parts.join(" ");
}

/** What sits next to a twin: its DOM row when the observer has one, and the nearest distinctive (long, unique) name before it. */
function nearOf(elements: Candidate[], i: number, counts: Map<string, number>): string {
  const el = elements[i]!, parts: string[] = el.row && el.row !== el.name ? [preview(el.row, 100)] : [];
  for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
    const name = elements[j]!.name;
    if (name.length < 24 || counts.get(name) !== 1 || (el.row ?? "").includes(name.slice(0, 20))) continue;
    parts.push(preview(name, 100));
    break;
  }
  return parts.join(" / ");
}

/** id -> description, twins told apart the way `look.twins` says. */
export function labelsFor(elements: Candidate[], hand: { width: number; height: number }, look: Look = FULL, all: Candidate[] = elements): Record<string, string> {
  const described = elements.map((el) => describe(el, hand, look));
  const names = new Map<string, number>();
  for (const el of all) names.set(el.name, (names.get(el.name) ?? 0) + 1);
  const total = new Map<string, number>();
  for (const d of described) total.set(d, (total.get(d) ?? 0) + 1);
  if (look.twins === "near") {
    elements.forEach((el, i) => {
      if (total.get(described[i]!)! === 1) return;
      const near = nearOf(all, all.indexOf(el), names);
      if (near) described[i] = `${described[i]}, next to ${JSON.stringify(near)}`;
    });
    total.clear();
    for (const d of described) total.set(d, (total.get(d) ?? 0) + 1);
  }
  const nth = new Map<string, number>(), labels: Record<string, string> = {};
  elements.forEach((el, i) => {
    const d = described[i]!, n = total.get(d)!;
    if (n === 1 || look.twins === "none") return void (labels[el.id] = d);
    const k = nth.get(d) ?? 0;
    nth.set(d, k + 1);
    labels[el.id] = `${d}, the ${ORDINALS[k] ?? `number ${k + 1}`} of ${n} like it from the top`;
  });
  return labels;
}

/** Everything but the elements: what the presenters that list elements in the criteria put in `state`. */
export function taskState(task: Task, screen: Screen) {
  return {
    goal: task.goal,
    ...(task.doneWhen ? { done_when: task.doneWhen } : {}),
    inputs: Object.fromEntries(Object.entries(task.inputs).map(([k, v]) => [k, preview(v)])),
    history: task.history.slice(-HISTORY_SHOWN),
    page: { windows: screen.frames, text: screen.texts },
  };
}

// ---------------------------------------------------------------- prefilter

const STOP = new Set("a an the to of for in on at and or my me i is it its this that with from by about be as so then please click go want need one new now all his her him".split(" "));
const stem = (w: string) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w);
const tokens = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
const POPUP = /^(option|menu ?item|listitem)$/i;
const DIALOG = /dialog|suggestions|error|alert/i;

/**
 * The K elements most likely to matter, without a model: words shared with the goal and the inputs (rare words count
 * more) and a small prior for controls over links. On top of the K, always: every field, every popup item, an open
 * dialog, and whatever shares a container with the focused field. It can only lose the right element, never find
 * it, so its recall is a ceiling. It reads letters, not meaning: "bicycles" does not find "bikes".
 */
export function prefilter(task: Task, elements: Candidate[], k: number): Candidate[] {
  const wanted = new Set(tokens([task.goal, ...Object.values(task.inputs).filter((v) => v.length < 60)].join(" ")));
  const bag = elements.map((el) => ({ name: new Set(tokens(`${el.name} ${el.value} ${el.row ?? ""}`)), within: new Set(tokens(el.within)) }));
  const df = new Map<string, number>();
  for (const b of bag) for (const t of new Set([...b.name, ...b.within])) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + elements.length / (df.get(t) ?? 1));
  const focusedIn = elements.find((el) => el.focused)?.within;
  const scored = elements.map((el, i) => {
    let score = /button|tab|option|menu|checkbox|dropdown/.test(el.role) ? 0.3 : 0;
    for (const t of wanted) {
      if (bag[i]!.name.has(t)) score += idf(t);
      else if (t.length >= 4 && [...bag[i]!.name].some((w) => w.startsWith(t) || (w.length >= 4 && t.startsWith(w)))) score += idf(t) / 2;
      if (bag[i]!.within.has(t)) score += idf(t) / 2;
    }
    const always = el.editable || POPUP.test(el.role) || DIALOG.test(el.within) || (!!focusedIn && el.within === focusedIn);
    return { el, i, score, always };
  });
  const keep = new Set(scored.filter((s) => s.always).map((s) => s.i));
  for (const s of scored.filter((s) => !s.always).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, k)) keep.add(s.i);
  return scored.filter((s) => keep.has(s.i)).map((s) => s.el);
}

// ---------------------------------------------------------------- asking

/** A metered client: token usage and latency per request, a few requests at a time, patience on HTTP 429. */
export function createMeteredJev(concurrency = 6): AskRaw {
  const client = new TypeSafeClient({ apiKey: jevApiKey(), defaultModel: process.env.JEV_MODEL, retry: { maxRetries: 0 }, logLevel: "off" });
  let running = 0;
  const waiting: (() => void)[] = [];
  const acquire = async () => { if (running >= concurrency) await new Promise<void>((go) => waiting.push(go)); running++; };
  const release = () => { running--; waiting.shift()?.(); };
  return async (state, questions) => {
    await acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        const started = performance.now();
        try {
          const result = await client.systemOne({ state, questions }, { timeout: 60_000 });
          return { answers: result.answers as Record<string, Answer>, tokens: result.usage.input_tokens, ms: performance.now() - started };
        } catch (error) {
          const status = error instanceof APIError ? error.status : 0;
          if (attempt >= 5 || (status !== 429 && status < 500 && status !== 0)) throw new Error(`Jev request failed (${status ? `HTTP ${status}` : "connection"}).`);
          await Bun.sleep(status === 429 ? 2000 * 2 ** attempt : 500 * (attempt + 1));
        }
      }
    } finally { release(); }
  };
}

/** Overlapping requests are one round trip: the round costs what its slowest request costs. */
async function round(meter: Meter, ask: AskRaw, requests: { state: EntryType; questions: Questions }[]): Promise<Record<string, Answer>[]> {
  const results = await Promise.all(requests.map((r) => ask(r.state, r.questions)));
  meter.rounds++; meter.requests += requests.length;
  meter.ms += Math.max(...results.map((r) => r.ms)); meter.tokens += results.reduce((sum, r) => sum + r.tokens, 0);
  return results.map((r) => r.answers);
}

const newMeter = (): Meter => ({ requests: 0, rounds: 0, ms: 0, tokens: 0 });
const chunked = <T>(items: T[], size: number): T[][] => { const parts = Math.max(1, Math.ceil(items.length / size)), each = Math.ceil(items.length / parts); return Array.from({ length: parts }, (_, i) => items.slice(i * each, (i + 1) * each)); };

/** One decision out of several Choices that each saw a part of the list: the most confident part that found something wins. */
function combine(parts: ChoiceResponse[]): Pick<Grounded, "pick" | "confidence" | "prob" | "ranked"> {
  const ranked = parts.flatMap((p) => Object.entries(p.probabilities).filter(([label]) => label !== NONE)).sort((a, b) => b[1] - a[1]).slice(0, 5) as [string, number][];
  const found = parts.filter((p) => p.choice !== NONE).sort((a, b) => b.confidence - a.confidence || b.probabilities[b.choice]! - a.probabilities[a.choice]!)[0];
  if (!found) return { pick: NONE, confidence: Math.min(...parts.map((p) => p.confidence)), prob: Math.min(...parts.map((p) => p.probabilities[NONE] ?? 0)), ranked: [[NONE, 1], ...ranked] };
  return { pick: found.choice, confidence: found.confidence, prob: found.probabilities[found.choice]!, ranked };
}

function inputQuestion(task: Task) {
  const typed = task.history.join("\n");
  return choice("If the worker types into a field next, which text belongs there?", {
    ...Object.fromEntries(Object.entries(task.inputs).map(([name, value]) => [name, `${JSON.stringify(preview(value))}${typed.includes(`type ${name} `) ? " (already typed once)" : ""}`])),
    [COMPOSE_LABEL]: "None of the prepared inputs. The text has to be written now, based on what is on screen.",
  });
}

const pool = (screen: Screen, want: Want, look: Look) => (want === "field" && !(look.ocr && !look.state) ? screen.elements.filter((el) => el.editable) : screen.elements);
const extras = (want: Want, w: Wording): Record<string, string> => (want === "field" ? { [FOCUSED_FIELD]: "The field that already has keyboard focus. The cursor is already in the right place.", [NONE]: w.noField } : { [NONE]: w.none });

// ---------------------------------------------------------------- presenters

/** cua.ts `decide`, as it is: all nine questions, the elements in `state.screen.elements` and again in two criteria. */
export const today: Presenter = async (task, screen, want, ctx) => {
  const meter = newMeter();
  const obs = { ...screen, elements: screen.elements.slice(0, Math.min(MAX_ELEMENTS, PER_CHOICE)) }; // observe.ts stops reading there
  const intent = { goal: task.goal, launcher: "none" as const, url: null, inputs: task.inputs, doneWhen: task.doneWhen ?? "The goal is visibly achieved.", avoid: [] };
  const hand = { id: 1, pid: 1, display: "", ...ctx.hand };
  const state = jevState(intent, obs, { history: task.history, plan: null }, hand);
  const W = WORDINGS.today;
  const [a] = await round(meter, ctx.ask, [{ state, questions: {
    move: choice("What should the worker do next to make progress on `goal`? Follow `plan.steps` when there is a plan. `history` lists what was already done, oldest first.", MOVES),
    goal_met: noul("`screen` shows that `done_when` is already true."),
    stuck: noul("`history` shows the worker repeating an action or making no progress toward `goal`."),
    target: choice(W.click, { ...elementLabels(obs.elements, hand), [NONE]: W.none }),
    input: inputQuestion(task),
    field: choice(W.field, { ...elementLabels(obs.elements.filter((el) => el.editable), hand), ...extras("field", W) }),
    submit: noul("Right after typing, Enter should be pressed, because this field is a search box, an address bar or a single line prompt that submits with Enter."),
    key: choice("If the worker presses a key next, which one?", KEYS),
    direction: choice("If the worker scrolls next to find what it needs, which way?", { down: "What is needed is further down the page or list.", up: "What is needed is further up the page or list." }),
  } }]);
  const c = (name: string) => a![name] as ChoiceResponse, asked = c(want === "click" ? "target" : "field");
  const move = c("move").choice, met = (a!.goal_met as NoulResponse).noul;
  const focused = obs.elements.find((el) => el.focused)?.id;
  const action = met >= 0.8 || (move === "done" && met >= 0.5) ? "done"
    : move === "done" || move === "ask_planner" || c("move").confidence < 0.45 ? "none"
    : move === "click" || move === "double_click" || move === "right_click" ? (c("target").choice === NONE ? "none" : `click_${c("target").choice}`)
    : move === "type" ? (c("field").choice === NONE ? "none" : `type_${c("input").choice}_${c("field").choice === FOCUSED_FIELD ? focused ?? FOCUSED_FIELD : c("field").choice}`)
    : move === "key" ? `key_${c("key").choice}` : move === "scroll" ? `scroll_${c("direction").choice}` : "wait";
  return { ...combine([asked]), input: c("input").choice, action, meter, note: `move ${move} ${c("move").confidence.toFixed(2)}` };
};

/** Descriptions only in the criteria. Past 250 elements the list is cut in reading order: several Choices, still one request. */
export const criteria: Presenter = async (task, screen, want, ctx) => {
  const meter = newMeter(), look = ctx.look ?? FULL, W = ctx.wording ?? WORDINGS.today;
  const elements = pool(screen, want, look), labels = labelsFor(elements, ctx.hand, look, screen.elements);
  const questions: Questions = want === "field" ? { input: inputQuestion(task) } : {};
  const parts = chunked(elements, PER_CHOICE);
  parts.forEach((part, i) => { questions[`pick_${i}`] = choice(W[want], { ...Object.fromEntries(part.map((el) => [el.id, labels[el.id]!])), ...extras(want, W) }); });
  const [a] = await round(meter, ctx.ask, [{ state: taskState(task, screen), questions }]);
  return { ...combine(parts.map((_, i) => a![`pick_${i}`] as ChoiceResponse)), input: want === "field" ? (a!.input as ChoiceResponse).choice : null, action: null, meter };
};

/** The same cut, but each part is a request of its own, all sent together. */
export const parallel: Presenter = async (task, screen, want, ctx) => {
  const meter = newMeter(), look = ctx.look ?? FULL, W = ctx.wording ?? WORDINGS.today;
  const elements = pool(screen, want, look), labels = labelsFor(elements, ctx.hand, look, screen.elements), state = taskState(task, screen);
  const answers = await round(meter, ctx.ask, chunked(elements, ctx.k ?? PER_CHOICE).map((part, i) => ({ state, questions: {
    ...(want === "field" && i === 0 ? { input: inputQuestion(task) } : {}),
    pick: choice(W[want], { ...Object.fromEntries(part.map((el) => [el.id, labels[el.id]!])), ...extras(want, W) }),
  } })));
  return { ...combine(answers.map((a) => a.pick as ChoiceResponse)), input: want === "field" ? (answers[0]!.input as ChoiceResponse).choice : null, action: null, meter };
};

/** Absolute questions that ride along with a Choice: a Choice always prefers something, these can all say no. */
const PRESENCE = {
  listed: "One of the listed `elements` is what the worker has to click or type into next for `goal`.",
  named: "`goal` names a specific thing: a person, a story, a file, a time, a category, a button. `elements` lists that exact thing, not just something similar.",
};

/**
 * Elements described once, in state, as `e7: button "Send" ...`, in reading order, so a twin is read next to its row.
 * The criteria are bare ids (or, with `ctx.describeCriteria`, the same words again). Past 250 elements the ids are
 * cut into several Choices; the list in state stays whole.
 */
export const bareIds: Presenter = async (task, screen, want, ctx) => {
  const meter = newMeter(), look = ctx.look ?? FULL, W = ctx.wording ?? WORDINGS.today;
  const elements = pool(screen, want, look), labels = labelsFor(elements, ctx.hand, look, screen.elements);
  const questions: Questions = { ...(want === "field" ? { input: inputQuestion(task) } : {}), listed: noul(PRESENCE.listed), named: noul(PRESENCE.named) };
  const parts = chunked(elements, PER_CHOICE);
  parts.forEach((part, i) => { questions[`pick_${i}`] = choice(W[want], { ...Object.fromEntries(part.map((el) => [el.id, ctx.describeCriteria ? labels[el.id]! : null])), ...extras(want, W) }); });
  const state = { ...taskState(task, screen), elements: elements.map((el) => `${el.id}: ${labels[el.id]}`) };
  const [a] = await round(meter, ctx.ask, [{ state, questions }]);
  return { ...combine(parts.map((_, i) => a![`pick_${i}`] as ChoiceResponse)), input: want === "field" ? (a!.input as ChoiceResponse).choice : null, action: null, meter,
    checks: { listed: (a!.listed as NoulResponse).noul, named: (a!.named as NoulResponse).noul } };
};

/** Prefilter to `ctx.k`, keep two neighbours on each side of every survivor (a twin needs its row), then `bareIds`. */
export const prunedBare: Presenter = (task, screen, want, ctx) => {
  const kept = new Set(prefilter(task, screen.elements, ctx.k ?? 30).map((el) => el.id));
  const near = screen.elements.filter((_, i, all) => all.slice(Math.max(0, i - 2), i + 3).some((el) => kept.has(el.id)));
  return bareIds(task, { ...screen, elements: near }, want, ctx);
};

/** Prefilter in code to `ctx.k`, then `criteria` over the survivors. */
export const pruned: Presenter = (task, screen, want, ctx) => {
  const kept = prefilter(task, screen.elements, ctx.k ?? 30);
  return criteria(task, { ...screen, elements: kept }, want, ctx);
};

/** One Noul per element. Absolute: all of them may be low, which is how "nothing fits" shows. `ranked` holds the nouls. */
export const nouls: Presenter = async (task, screen, want, ctx) => {
  const meter = newMeter(), look = ctx.look ?? FULL;
  const elements = pool(screen, want, look), labels = labelsFor(elements, ctx.hand, look, screen.elements), state = taskState(task, screen);
  const lead = want === "click" ? "Clicking this element is the right next step toward `goal`" : "Typing into this field is the right next step toward `goal`";
  const answers = await round(meter, ctx.ask, chunked(elements, PER_NOUL_REQUEST).map((part, i) => ({ state, questions: {
    ...(want === "field" && i === 0 ? { input: inputQuestion(task) } : {}),
    ...Object.fromEntries(part.map((el) => [el.id, noul(`${lead}: ${labels[el.id]}`)])),
  } })));
  const all = answers.flatMap((a) => Object.entries(a).filter(([name]) => name !== "input").map(([id, v]) => [id, (v as NoulResponse).noul] as [string, number])).sort((a, b) => b[1] - a[1]);
  const best: [string, number] = all[0] ?? [NONE, 0], second = all[1]?.[1] ?? 0;
  return { pick: best[1] >= 0.5 ? best[0] : NONE, confidence: best[1], prob: best[1] - second, ranked: all.slice(0, 8), input: want === "field" ? (answers[0]!.input as ChoiceResponse).choice : null, action: null, meter };
};

/**
 * The taxonomy walk from the docs, flattened into one request: a Choice over the groups and, speculatively, a Choice
 * inside every group. Code multiplies them. Groups are the containers (`within`), or plain runs of 20 (`ctx.by`).
 */
export const grouped: Presenter = async (task, screen, want, ctx) => {
  const meter = newMeter(), look = ctx.look ?? FULL, W = ctx.wording ?? WORDINGS.today;
  const elements = pool(screen, want, look), labels = labelsFor(elements, ctx.hand, look, screen.elements);
  const groups: { name: string; members: Candidate[] }[] = [];
  if (ctx.by === "chunk") chunked(elements, 20).forEach((members, i) => groups.push({ name: `part ${i + 1}`, members }));
  else {
    const byName = new Map<string, Candidate[]>();
    for (const el of elements) { const key = el.within || `${el.region ?? regionOf(el.rect, ctx.hand)} of the page`; byName.set(key, [...(byName.get(key) ?? []), el]); }
    for (const [name, members] of byName) chunked(members, GROUP_MAX).forEach((part, i, parts) => groups.push({ name: parts.length > 1 ? `${name} (part ${i + 1})` : name, members: part }));
  }
  if (groups.length > PER_CHOICE) throw new Error(`${groups.length} groups`);
  const what = want === "click" ? "element to click" : "field to type into";
  const questions: Questions = {
    ...(want === "field" ? { input: inputQuestion(task) } : {}),
    group: choice(`The elements of the screen are listed in groups. Which group holds the ${what} next to make progress on \`goal\`?`, {
      ...Object.fromEntries(groups.map((g, i) => [`g${i}`, { group: g.name, holds: g.members.slice(0, 12).map((el) => `${el.role} ${JSON.stringify(preview(el.name, 40))}`), ...(g.members.length > 12 ? { and_more: g.members.length - 12 } : {}) }])),
      [NONE]: "No group holds it.",
    }),
  };
  groups.forEach((g, i) => { questions[`in_${i}`] = choice(W[want], { ...Object.fromEntries(g.members.map((el) => [el.id, labels[el.id]!])), ...extras(want, W) }); });
  const [a] = await round(meter, ctx.ask, [{ state: taskState(task, screen), questions }]);
  const top = a!.group as ChoiceResponse;
  const scores = new Map<string, number>([[NONE, top.probabilities[NONE] ?? 0]]);
  groups.forEach((_, i) => {
    const pg = top.probabilities[`g${i}`] ?? 0, inside = a![`in_${i}`] as ChoiceResponse;
    for (const [label, p] of Object.entries(inside.probabilities)) scores.set(label, (scores.get(label) ?? 0) + pg * p);
  });
  const ranked = [...scores].sort((x, y) => y[1] - x[1]).slice(0, 6);
  const [pick, prob] = ranked[0]!;
  const home = groups.findIndex((g) => g.members.some((el) => el.id === pick));
  const confidence = home < 0 ? top.confidence : Math.min(top.confidence, (a![`in_${home}`] as ChoiceResponse).confidence);
  return { pick, confidence, prob, ranked, input: want === "field" ? (a!.input as ChoiceResponse).choice : null, action: null, meter, note: `group ${top.choice} ${top.confidence.toFixed(2)}, ${groups.length} groups` };
};

/** One Choice over whole actions that code enumerated, instead of a move plus separate argument questions. */
export const flattened: Presenter = async (task, screen, _want, ctx) => {
  const meter = newMeter(), look = ctx.look ?? FULL;
  const labels = labelsFor(screen.elements, ctx.hand, look);
  const typed = task.history.join("\n");
  const fixed: Record<string, string> = {
    key_Return: "Press Enter: submit the focused form, send what was just typed, run the search.",
    key_Escape: "Press Escape: close a dialog, menu or popup.",
    key_Tab: "Press Tab: move focus to the next field.",
    scroll_down: "Scroll down: what is needed is probably further down the page or list.",
    scroll_up: "Scroll up: what is needed is probably further up the page or list.",
    done: "Stop: `goal` is already achieved on this screen.",
    none: "None of these actions is right, or `page` and `history` do not show what to do next. Ask a vision model to look.",
  };
  const actions: [string, string][] = [];
  for (const el of screen.elements) {
    if (!el.editable) { actions.push([`click_${el.id}`, `Click ${labels[el.id]}`]); continue; }
    for (const [name, value] of Object.entries(task.inputs)) actions.push([`type_${name}_${el.id}`, `Type ${name} (${JSON.stringify(preview(value, 50))})${typed.includes(`type ${name} `) ? ", already typed once," : ""} into ${labels[el.id]}`]);
    if (!Object.keys(task.inputs).length) actions.push([`click_${el.id}`, `Click into ${labels[el.id]}`]);
  }
  const parts = chunked(actions, PER_CHOICE - Object.keys(fixed).length);
  const questions: Questions = {};
  parts.forEach((part, i) => { questions[`act_${i}`] = choice("Which single action should the worker take next to make progress on `goal`? `history` lists what was already done, oldest first.", { ...Object.fromEntries(part), ...fixed }); });
  const [a] = await round(meter, ctx.ask, [{ state: taskState(task, screen), questions }]);
  const answers = parts.map((_, i) => a![`act_${i}`] as ChoiceResponse);
  // A part that saw nothing to click falls back on a fixed action; a part that found an element outranks it.
  const onElement = (p: ChoiceResponse) => /^(click|type)_/.test(p.choice);
  const best = [...answers].sort((x, y) => Number(onElement(y)) - Number(onElement(x)) || y.confidence - x.confidence)[0]!;
  const ranked = answers.flatMap((p) => Object.entries(p.probabilities)).sort((x, y) => y[1] - x[1]).filter(([label], i, list) => list.findIndex(([l]) => l === label) === i).slice(0, 5) as [string, number][];
  const click = /^click_(.+)$/.exec(best.choice), type = /^type_(.+)_([^_]+)$/.exec(best.choice);
  return { pick: click ? click[1]! : type ? type[2]! : NONE, input: type ? type[1]! : null, action: best.choice, confidence: best.confidence, prob: best.probabilities[best.choice]!, ranked, meter };
};

// ---------------------------------------------------------------- what won

export type GroundDecision =
  | { kind: "act"; id: string; input: string | null; confidence: number }
  | { kind: "escalate"; reason: string; leaning: string | null; confidence: number };

/**
 * Below this confidence the pick is not acted on. Measured in ground.eval.ts over 138 decisions x 2 rounds: clicks at
 * 0.5 kept wrong clicks at 1-2% of decisions while holding back 3-4% of the right ones; no field pick was wrong at any level.
 */
export const ACT_AT: Record<Want, number> = { click: 0.5, field: 0.3 };

/** One request: which element (or field + input), or a reason to ask the vision model. */
export async function ground(task: Task, screen: Screen, want: Want, ask: AskRaw, hand: { width: number; height: number }): Promise<GroundDecision> {
  const g = await bareIds(task, screen, want, { ask, hand, wording: WORDINGS.direct });
  if (g.pick === NONE) return { kind: "escalate", reason: "what the goal needs is not among the elements on screen", leaning: g.ranked.find(([id]) => id !== NONE)?.[0] ?? null, confidence: g.confidence };
  if (g.confidence < ACT_AT[want]) return { kind: "escalate", reason: `unsure which ${want === "click" ? "element" : "field"} (leaning ${g.pick})`, leaning: g.pick, confidence: g.confidence };
  const id = g.pick === FOCUSED_FIELD ? screen.elements.find((el) => el.focused)?.id ?? FOCUSED_FIELD : g.pick;
  return { kind: "act", id, input: g.input, confidence: g.confidence };
}

export const PRESENTERS = { today, criteria, parallel, bareIds, pruned, prunedBare, nouls, grouped, flattened } satisfies Record<string, Presenter>;
