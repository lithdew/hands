/**
 * The TypeSafe side: what Jev is told of the screen, the one request a step makes, and its answers read back.
 *
 * The screen goes once, in state, one line per item in reading order (`12: link 'Charles Babbage' (middle-left)`), and
 * the questions that pick an item, a field or an off-screen control take bare ids. Shown so, and asked in words that say
 * what a match is, Jev picked the right element 98% of the time in the teammate's measurements (D:/projects/puk/jev
 * README.md, ground.eval.ts), against 78% for items described in state and again as the labels; the request is also
 * less than half the size, which is what put a date picker over Jev's token limit. Only kinds that can run are offered,
 * and absolute questions (goal_met, submit, stuck) ride along, since a Choice always prefers something.
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  type ChoiceQuestion,
  type ChoiceResponse,
  choice,
  noul,
  type Questions,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import { CLICK_AT, DONE_AGREED, DONE_AT, FIELD_AT, HISTORY_SHOWN, ITEM_CHARS, JEV_RETRIES, JEV_TIMEOUT_MS, jevModel, OFFSCREEN_CHARS, PER_CHOICE, SITES } from "./config.ts";
import { dateHints, nowContext } from "./dates.ts";
import { type Field, fieldSummary, fromAx, isText, type Item, region, repr, roleWord, type Screen } from "./models.ts";
import { offscreenFor } from "./perception.ts";

export type ChoiceAnswer = ChoiceResponse;
export const OFFSCREEN_PREFIX = "offscreen:";
export const NONE = "none_of_these";
export const FOCUSED = "focused_field";
/** The question each kind that lands somewhere takes its target from. */
const TARGETS: Record<string, "item" | "field" | "offscreen" | "site"> = {
  click_item: "item",
  press_offscreen: "offscreen",
  type_text: "field",
  type_email: "field",
  use_browser: "site",
};

export const PRESS_OFFSCREEN =
  "Activate a labelled control that the app exposes but that is not currently visible on screen " +
  "(chosen in the offscreen question). Use when the needed control is known to exist but is " +
  "scrolled out of view or not yet shown.";

// The teammate's measured wordings (D:/projects/puk/jev/ground.ts WORDINGS.direct, screen.ts), word for word where
// they fit: the state here names the list `elements`, as theirs did.
const KIND =
  "You are driving this computer one action at a time. Which kind of action makes the most progress toward `goal` right now? " +
  "`history` lists what was done already, oldest first, and whether the screen changed after each. The actions in " +
  "`already_tried_on_this_screen` were taken on this same screen before.";
const ITEM =
  "Which one element does the worker have to click now to carry out `goal`? The right element has the name, or sits in the " +
  "container, that `goal` talks about. Choose none_of_these when what `goal` talks about is not listed.";
const NO_ITEM = "What `goal` needs is not in this list. An element that only has a similar name is not it.";
const FIELD = "Which one text field does the worker have to type into now to carry out `goal`? Choose none_of_these when no listed field is meant for it.";
const NO_FIELD = "What `goal` needs is not in this list.";
const OFFSCREEN =
  "Which one control in `offscreen_controls` does the worker have to press now to carry out `goal`? They are real controls of the " +
  "app, reachable without the mouse, but nothing on screen shows them. Choose none_of_these when what `goal` talks about is not listed.";
const SITE =
  "If the browser is used this step, which website should it show? Name a site from the list when the goal calls for that one, " +
  "'other' when the goal calls for a site the list does not name, and 'none' to stay on the page that is already open in the browser.";
const GOAL_MET = "The screen described in `elements` shows that `goal` is already achieved: nothing is left to do for it.";
const SUBMIT = "Right after typing, Enter should be pressed, because this field is a search box, an address bar or a single line prompt that submits with Enter.";
const STUCK = "`history` shows the worker repeating an action or making no progress toward `goal`.";

/** Which website use_browser opens. The catalog, plus one key for anything else and one for nothing. */
export const siteCriteria = (): Record<string, string> => ({
  ...SITES,
  other: "A website is needed to progress the goal, but it is not one of the sites named in this list.",
  none: "No website needs to be opened: the page already open in the browser is the one to continue with.",
});

/** What a step can offer. A kind that cannot run still draws votes, and reads as doubt when it wins, so it is left out. */
export interface Offer {
  items: boolean; // something on screen to click
  fields: boolean; // a text field to type into
  text: string | null; // what to type, as the hand gave it
  write: boolean; // a writer that composes what to type when the hand gave nothing
  email: string | null;
  offscreen: boolean;
  /** The browser use_browser works in: only `bun clicker`, on the screen in front. A hand opens its pages with its own `browser`. */
  browse: string | null;
}

export function kindCriteria(offer: Offer): Record<string, string> {
  const kinds: Record<string, string> = {};
  if (offer.items) kinds.click_item = "Click one of the listed elements (chosen in the item question).";
  if (offer.offscreen) kinds.press_offscreen = PRESS_OFFSCREEN;
  if (offer.browse) {
    kinds.use_browser =
      `Work in ${offer.browse}: bring it to the front, and open a website there if one is needed. The site question says which ` +
      "website, or says that the page already open there is the one to continue with. This is the only way to reach a website: " +
      "never click the address bar, a URL, or a search box to get there. Works from any app, including this one.";
  }
  if (offer.fields && (offer.text || offer.write)) {
    kinds.type_text = offer.text
      ? "Type `text_to_type` into the text field chosen in the field question."
      : "Type into the text field chosen in the field question. A writing model composes the text from `goal` and the field's label.";
  }
  if (offer.fields && offer.email) {
    kinds.type_email = "Type the user's email address into the text field chosen in the field question. Use this, not type_text, whenever the field wants an email or username.";
  }
  if (offer.fields) kinds.press_enter = "Press Return to submit the field or form just filled in.";
  Object.assign(kinds, {
    press_escape: "Press Escape to dismiss a dialog, menu, or popup.",
    scroll_down: "Scroll down to reveal more of the page.",
    scroll_up: "Scroll up.",
    wait: "Nothing to do yet: the screen is still loading or changing.",
    done: "`goal` is already achieved on this screen.",
    none: "Nothing on screen or in these lists helps with `goal`.",
  });
  return kinds;
}

const cut = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/**
 * One item as Jev reads it: its id, its role (`text` for words read off the picture), its words, what a field holds,
 * and where it lies, with a date's distance from today when it names one.
 */
export function itemLine(screen: Screen, it: Item, hint?: string): string {
  const control = fromAx(it) && it.role;
  const holds = control && it.role === "field" && it.value !== undefined ? (it.value ? ` containing ${repr(cut(it.value, 60))}` : " empty") : "";
  return `${it.index}: ${control ? it.role : "text"} ${repr(cut(it.text, ITEM_CHARS))}${holds} (${region(screen, it)}${hint ? `; ${hint}` : ""})`;
}

/** The fields among the items: controls the app says take text. */
const fieldItems =(items: Item[]): Item[] => items.filter((it) => fromAx(it) && it.role === "field");

/** Everything one request is built from. */
export interface Look {
  goal: string;
  screen: Screen;
  items: Item[];
  history: string[];
  /** Actions taken before on a screen that looked the same as this one. */
  tried?: string[];
  text?: string | null;
  write?: boolean;
  email?: string | null;
  browse?: string | null;
  /** False leaves the off-screen controls out (the smaller request after one over the token limit). */
  offscreen?: boolean;
}

export interface Request {
  state: Record<string, unknown>;
  questions: Questions;
  /** The item ids of each item question, item_0 on: past PER_CHOICE the item question is asked in parts. */
  parts: string[][];
  /** Which of `screen.offscreen` the offscreen question offers, by position. */
  offscreen: number[];
}

/** The request for one step: state that describes the screen once, and the questions, only for what can run. */
export function request(look: Look): Request {
  const { goal, screen, items } = look;
  const hints = dateHints(items, screen);
  const fields = fieldItems(items);
  const focused = screen.field && isText(screen.field) ? screen.field : null; // `bun clicker` only: from behind no field has the focus
  const shown = look.offscreen === false ? [] : offscreenFor(screen.offscreen, goal);
  const offer: Offer = {
    items: items.length > 0,
    fields: fields.length > 0 || focused !== null,
    text: look.text ?? null,
    write: look.write ?? false,
    email: look.email ?? null,
    offscreen: shown.length > 0,
    browse: look.browse ?? null,
  };
  const parts: string[][] = [];
  for (let i = 0; i < items.length; i += PER_CHOICE) parts.push(items.slice(i, i + PER_CHOICE).map((it) => String(it.index)));
  const bare = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, null]));

  const questions: Questions = { kind: choice(KIND, kindCriteria(offer)), goal_met: noul(GOAL_MET), stuck: noul(STUCK) };
  parts.forEach((ids, i) => (questions[`item_${i}`] = choice(ITEM, { ...bare(ids), [NONE]: NO_ITEM })));
  if (offer.fields && (offer.text || offer.write || offer.email)) {
    questions.field = choice(FIELD, {
      ...bare(fields.map((it) => String(it.index))),
      ...(focused ? { [FOCUSED]: "The field that already has keyboard focus, `focused_field`." } : {}),
      [NONE]: NO_FIELD,
    });
    questions.submit = noul(SUBMIT);
  }
  if (shown.length) questions.offscreen = choice(OFFSCREEN, { ...bare(shown.map((i) => `o${i}`)), [NONE]: NO_ITEM });
  if (offer.browse) questions.site = choice(SITE, siteCriteria());

  const state: Record<string, unknown> = {
    goal,
    ...(offer.text ? { text_to_type: offer.text } : {}),
    now: nowContext(),
    app: screen.app,
    url: screen.url,
    history: look.history.slice(-HISTORY_SHOWN),
    ...(look.tried?.length ? { already_tried_on_this_screen: look.tried } : {}),
    ...(focused ? { focused_field: fieldSummary(focused) } : {}),
    elements: items.map((it) => itemLine(screen, it, hints.get(it.index))),
    ...(shown.length
      ? { offscreen_controls: shown.map((i) => `o${i}: ${roleWord(screen.offscreen[i]!)} ${repr(cut(screen.offscreen[i]!.label, OFFSCREEN_CHARS))} (not visible)`) }
      : {}),
  };
  return { state, questions, parts, offscreen: shown };
}

/** What a step's answers cost and came from, for the run folder. */
export interface Meta {
  model: string | null;
  inputTokens: number | null;
}

export interface Extra {
  field?: ChoiceAnswer | null;
  goalMet?: number | null; // null: the reply had none, and the kind alone says whether the run is done
  submit?: number | null;
  stuck?: number | null;
  /** What makes the reply unusable (a missing answer, a label that was not offered), for the answers the chosen kind needs. */
  problem?: string | null;
  /** The item question's parts, each as answered, when there was more than one. */
  parts?: ChoiceAnswer[];
  meta?: Meta;
}

export class Decision {
  constructor(
    readonly kind: ChoiceAnswer,
    readonly item: ChoiceAnswer | null,
    readonly site: ChoiceAnswer | null,
    readonly offscreen: ChoiceAnswer | null = null,
    readonly extra: Extra = {},
  ) {}

  get field(): ChoiceAnswer | null {
    return this.extra.field ?? null;
  }

  get goalMet(): number | null {
    return this.extra.goalMet ?? null;
  }

  get clicking(): boolean {
    return this.kind.choice === "click_item" && this.item !== null && this.item.choice !== NONE;
  }

  get pressingOffscreen(): boolean {
    return this.kind.choice === "press_offscreen" && this.offscreen !== null && this.offscreen.choice !== NONE;
  }

  get typing(): boolean {
    return (this.kind.choice === "type_text" || this.kind.choice === "type_email") && this.field !== null && this.field.choice !== NONE;
  }

  /** The item clicked, `offscreen:N` for an off-screen control, or the kind itself. A kind whose target said none_of_these stays the kind, which acts on nothing. */
  get chosen(): string {
    if (this.clicking) return this.item!.choice;
    if (this.pressingOffscreen) return `${OFFSCREEN_PREFIX}${this.offscreen!.choice.replace(/^o/, "")}`;
    return this.kind.choice;
  }

  /** The item the action lands on, for the annotated capture: the one clicked, or the field typed into. */
  get target(): string | null {
    return this.clicking ? this.item!.choice : this.typing ? this.field!.choice : null;
  }

  /** The answer the chosen kind takes its target from, when it has one. */
  get targetAnswer(): ChoiceAnswer | null {
    return this.clicking ? this.item : this.pressingOffscreen ? this.offscreen : this.typing ? this.field : null;
  }

  get confidence(): number {
    // Only the answers that name a target lower the confidence: a click or a press lands somewhere, and the wrong
    // somewhere is not undone. use_browser reads the site answer too, but every outcome of it is a page the next step
    // can leave, so a split there must not stop the run.
    const target = this.targetAnswer;
    return target ? Math.min(this.kind.confidence, target.confidence) : this.kind.confidence;
  }

  /** Why the pick is not sure enough to act on, each answer against its own bar; null when it is. */
  doubt(kindAt: number): string | null {
    const low = (what: string, answer: ChoiceAnswer, at: number) => (answer.confidence < at ? `${what} ${repr(answer.choice)} at ${answer.confidence.toFixed(2)}, below ${at}` : null);
    return (
      low("kind", this.kind, kindAt) ??
      (this.clicking ? low("item", this.item!, CLICK_AT) : null) ??
      (this.pressingOffscreen ? low("off-screen control", this.offscreen!, CLICK_AT) : null) ??
      (this.typing ? low("field", this.field!, FIELD_AT) : null)
    );
  }

  /** The screen shows the goal met: goal_met on its own at DONE_AT, or at DONE_AGREED when the kind says done. A reply without goal_met leaves it to the kind. */
  get done(): boolean {
    const met = this.goalMet;
    if (met !== null && met >= DONE_AT) return true;
    return this.kind.choice === "done" && (met === null || met >= DONE_AGREED);
  }

  /** A kind that lands somewhere, whose target question found nothing that fits. */
  get targetless(): boolean {
    const needs = TARGETS[this.kind.choice];
    return needs !== undefined && needs !== "site" && this.targetAnswer === null;
  }
}

type Answer = Record<string, unknown> | undefined;
const asChoice = (answer: Answer): ChoiceAnswer | null => (answer && typeof answer.choice === "string" && typeof answer.confidence === "number" ? (answer as unknown as ChoiceAnswer) : null);
const asNoul = (answer: Answer): number | null => (answer && typeof answer.noul === "number" ? answer.noul : null);

/**
 * The item question's parts as one answer, the teammate's way (screen.ts strongest): the most confident part that
 * picked an item; none_of_these only when every part said so. Its probabilities are every part's, for the report.
 */
export function combine(parts: ChoiceAnswer[]): ChoiceAnswer {
  if (parts.length === 1) return parts[0]!;
  const found = parts.filter((p) => p.choice !== NONE).sort((a, b) => b.confidence - a.confidence)[0];
  const probabilities: Record<string, number> = {};
  for (const part of parts) for (const [label, p] of Object.entries(part.probabilities)) if (label !== NONE) probabilities[label] = p;
  probabilities[NONE] = Math.min(...parts.map((p) => p.probabilities[NONE] ?? 0));
  if (found) return { type: "choice", choice: found.choice, confidence: found.confidence, probabilities };
  return { type: "choice", choice: NONE, confidence: Math.min(...parts.map((p) => p.confidence)), probabilities };
}

/** The labels a Choice of the request offered. */
const offered = (req: Request, name: string): string[] => Object.keys((req.questions[name] as ChoiceQuestion | undefined)?.criteria ?? {});

/** The answers read back into a Decision, checked for what the chosen kind needs (the teammate's assertContract, jev/jev.ts). */
export function readAnswers(req: Request, answers: Record<string, Answer>, meta: Meta = { model: null, inputTokens: null }): Decision {
  const kind = asChoice(answers.kind);
  const parts = req.parts.map((_, i) => asChoice(answers[`item_${i}`]));
  const whole = parts.every((part) => part !== null) ? (parts as ChoiceAnswer[]) : null;
  const item = whole && whole.length ? combine(whole) : null;
  const field = asChoice(answers.field);
  const offscreen = asChoice(answers.offscreen);
  const site = asChoice(answers.site);
  const outOf = (name: string, answer: ChoiceAnswer | null): string | null =>
    answer === null ? `the reply has no ${name} answer` : offered(req, name).includes(answer.choice) ? null : `the ${name} answer ${repr(answer.choice)} was not offered`;
  let problem: string | null = null;
  if (!kind) problem = "the reply has no answer for the kind of action";
  else if (!offered(req, "kind").includes(kind.choice)) problem = `the kind ${repr(kind.choice)} was not offered`;
  else {
    const needs = TARGETS[kind.choice];
    if (needs === "item") problem = whole ? (whole.map((part, i) => outOf(`item_${i}`, part)).find((p) => p !== null) ?? null) : "the reply has no item answer";
    else if (needs) problem = outOf(needs, { field, offscreen, site }[needs]);
  }
  const fallback: ChoiceAnswer = { type: "choice", choice: "none", confidence: 0, probabilities: {} };
  return new Decision(kind ?? fallback, item, site, offscreen, {
    field,
    goalMet: asNoul(answers.goal_met),
    submit: asNoul(answers.submit),
    stuck: asNoul(answers.stuck),
    problem,
    parts: whole && whole.length > 1 ? whole : undefined,
    meta,
  });
}

/** A built request sent to Jev, and its answers read back. `signal` ends the request when the user stops the hand. */
export async function send(client: TypeSafeClient, req: Request, signal?: AbortSignal): Promise<Decision> {
  const result = await client.systemOne({ state: req.state as never, questions: req.questions }, signal ? { signal } : undefined);
  const { answers, model, usage } = result as unknown as { answers: Record<string, Answer>; model?: string; usage?: { input_tokens?: number } };
  return readAnswers(req, answers, { model: model ?? null, inputTokens: usage?.input_tokens ?? null });
}

/** One step's question to Jev. */
export const decide = (client: TypeSafeClient, look: Look, signal?: AbortSignal): Promise<Decision> => send(client, request(look), signal);

/** Jev refused the request for its size: the state and its longest question are over the model's token limit. */
export const tooLarge = (error: unknown): boolean => error instanceof APIError && error.status === 400 && JSON.stringify(error.body ?? "").includes("max_tokens_exceeded");

/** A failed request in a few words, for the run's outcome. */
export function failure(error: unknown): string {
  if (error instanceof APITimeoutError) return `no answer within ${error.timeoutMs} ms`;
  if (error instanceof APIConnectionError) return `no connection (${error.message})`;
  if (error instanceof APIError) {
    const detail = (error.body as { detail?: { error_type?: string } } | undefined)?.detail?.error_type;
    return `${error.status}${detail ? ` ${detail}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** A client of our own settings: an attempt is cut off well before a step would feel stuck, and tried once more. */
export const newClient = (): TypeSafeClient =>
  new TypeSafeClient({ timeout: JEV_TIMEOUT_MS, retry: { maxRetries: JEV_RETRIES, backoffInitialMs: 250 }, defaultModel: jevModel() });

let shared: TypeSafeClient | null = null;
/** The client every clicker run of this process shares, so that a later run finds its connection open. Made on first use, once the key is known to be set. */
export const jevClient = (): TypeSafeClient => (shared ??= newClient());

/** Open the connection before the first question, while the first capture is under way: a cold one costs about a second. Never fails. */
export function warm(client: TypeSafeClient): void {
  try {
    void client.models.list({ timeout: 3000 }).catch(() => {});
  } catch {
    // a client with no model list (a test's stand-in): nothing to warm
  }
}

/** The field a Decision chose, as the Field an action types into: an item of the screen, or the focused field of `bun clicker`. */
export function chosenField(decision: Decision, screen: Screen, items: Item[]): Field | null {
  const key = decision.field?.choice;
  if (key === undefined || key === NONE) return null;
  if (key === FOCUSED) return screen.field && isText(screen.field) ? screen.field : null;
  const it = items.find((candidate) => String(candidate.index) === key);
  if (!it) return null;
  const [x, y] = [screen.origin[0] + it.x1 / screen.scale, screen.origin[1] + it.y1 / screen.scale];
  return { role: "AXTextField", label: it.text, placeholder: "", value: it.value ?? "", x, y, w: (it.x2 - it.x1) / screen.scale, h: (it.y2 - it.y1) / screen.scale, ref: screen.axRefs.get(it.index) };
}
