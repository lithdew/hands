/**
 * Jev's reflexes: what a hand learns from TypeSafe's classifier without a turn of its own model, one request of about
 * a third of a second each.
 *
 * - A page of the hand's own browser window that needs the user (a sign-in, a CAPTCHA, a verification code, payment
 *   details) is recognised at once, and its listing starts with a line that says so and what to do.
 * - A cookie banner there is turned down: Jev picks the button that declines the optional cookies, among the ones
 *   whose words read as declining and never as accepting, and the tools press it from behind.
 * - A hand that finishes as done has its answer checked against its last screen: how likely that screen shows it so.
 *
 * A page is asked about only when cheap word triggers match among its items, and once per page (its URL and items).
 * The items go once, in state, a line each with a bare id, as src/decide.ts sends them. Every request gives up after
 * REFLEX_MS with no retry, nothing here ever throws, and nothing is asked without TYPESAFE_API_KEY or with
 * HANDS_REFLEXES=off. Each request is logged, with its milliseconds, to reflex.log in the run folder.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { type ChoiceResponse, choice, noul, type Questions, type TypeSafeClient } from "@typesafe-ai/sdk";
import * as config from "./config.ts";
import { failure, itemLine, jevClient, NONE } from "./decide.ts";
import { fromAx, type Item, region, repr, type Screen } from "./models.ts";
import { mostShared } from "./perception.ts";

type Jev = Pick<TypeSafeClient, "systemOne">;
/** A line of the reflex log: what was asked, how long it took, and what came of it. */
export type Log = (record: Record<string, unknown>) => void;

/** The reflex log in a run folder, a JSON line a request. Never throws. */
export const logTo =
  (runDir: string): Log =>
  (record) => {
    try {
      appendFileSync(join(runDir, "reflex.log"), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    } catch {} // a log that cannot be written is no reason to stop a hand
  };

// ------------------------------------------------------------------ the words that make a page worth asking about

/** What a page's items may show: each a reason to ask Jev about it. */
export type Sign = "cookie" | "sign_in" | "captcha" | "code" | "payment";

const COOKIE = /\bcookies?\b|\bconsent\b|\bgdpr\b|\bprivacy (choices|settings|preferences|options)\b|\byour privacy\b/i;
const PASSWORD = /\bpass(word|code|phrase)s?\b/i;
const SIGN_IN = /\b(sign|log)[ -]?(in|on)\b/i;
const ACCOUNT_FIELD = /\be-?mail\b|\buser ?name\b|\bphone\b|\baccount\b|\blogin\b/i;
const CAPTCHA =
  /\b(re|h)?captcha\b|\bverify (that )?you(?:'re| are) (a )?human\b|\b(i'?m|i am) not a robot\b|\bare you a (robot|human)\b|\bhuman verification\b|\bunusual traffic\b|\bchecking (if the site connection is secure|your browser)\b/i;
const CODE =
  /\bverification code\b|\bone[- ]time (code|password|passcode|pin)\b|\b(2|two)[- ](step|factor)\b|\b2fa\b|\bauthenticator\b|\benter (the|your) (\d[- ]digit )?code\b|\bsecurity code\b/i;
const PAYMENT = /\b(card ?number|credit card|debit card|cvc|cvv|cardholder|name on (the )?card|expir(y|ation) date|billing address)\b|\bmm ?\/ ?yy\b/i;

/** Words that turn down a banner: reject, decline, necessary or essential only, refuse, deny, continue without accepting, close. */
const DECLINES =
  /\b(reject|decline|refuse|deny|disagree|dismiss|close)\b|\bno,? thanks\b|\bcontinue without (accepting|agreeing|consent)|\b(necessary|essential|required)( cookies)? only\b|\bonly (allow |use )?(the )?(strictly )?(necessary|essential|required)\b/i;
/** Words that accept: never pressed, whatever else the label says. `without accepting` is not accepting. */
const ACCEPTS = /(?<!without )\b(accept|agree)|\ballow all\b|\bok(ay)?\b|\bgot it\b|\bi understand\b/i;
/** A close button that is only its cross. */
const CROSS = /^\s*[x×✕✖╳]\s*$/i;

/** The buttons and links whose words turn a cookie banner down, and never accept it: the only things the reflex may press. */
export const declining = (items: Item[]): Item[] =>
  items.filter((it) => fromAx(it) && (it.role === "button" || it.role === "link") && (DECLINES.test(it.text) || CROSS.test(it.text)) && !ACCEPTS.test(it.text));

/**
 * What a page's items show that may be worth a question: cookie words with a button that declines; a password, a
 * sentence about signing in, or a sign-in beside an account field (a lone "Sign in" link in a header is not one); a
 * CAPTCHA; a code to enter; payment details.
 */
export function signs(items: Item[]): Set<Sign> {
  const found = new Set<Sign>();
  const any = (words: RegExp) => items.some((it) => words.test(it.text));
  if (any(COOKIE) && declining(items).length) found.add("cookie");
  const signIn = items.filter((it) => SIGN_IN.test(it.text));
  const sentence = signIn.some((it) => it.text.trim().split(/\s+/).length >= 3);
  const accountField = items.some((it) => it.role === "field" && ACCOUNT_FIELD.test(it.text) && !/\bsearch\b/i.test(it.text));
  if (any(PASSWORD) || sentence || (signIn.length && accountField)) found.add("sign_in");
  if (any(CAPTCHA)) found.add("captcha");
  if (any(CODE)) found.add("code");
  if (any(PAYMENT)) found.add("payment");
  return found;
}

/** Whether an item carries any trigger's words: such items go to Jev first when a page lists more than it is shown. */
const telling = (it: Item): boolean => [COOKIE, PASSWORD, SIGN_IN, CAPTCHA, CODE, PAYMENT].some((words) => words.test(it.text));

// ------------------------------------------------------------------ the page's question

export type Wall = "sign_in_wall" | "captcha" | "code_needed" | "payment_form";
export const WALLS: Wall[] = ["sign_in_wall", "captcha", "code_needed", "payment_form"];

export const COOKIE_BANNER =
  "A cookie or privacy consent banner or dialog is showing on the page described in `elements`: it asks the visitor to accept cookies, or to choose which ones to allow.";
export const WALL_QUESTIONS: Record<Wall, string> = {
  sign_in_wall:
    "The page described in `elements` wants the visitor to sign in before it shows or does anything more: a sign-in form, or a wall in front of the content that asks for an account. A Sign in link among the page's other links does not count.",
  captcha: "The page described in `elements` shows a CAPTCHA or a check that the visitor is human (\"verify you are human\", \"I'm not a robot\", a puzzle to solve) before it goes on.",
  code_needed: "The page described in `elements` asks for a verification code: a one-time code sent by text message or email, or one from an authenticator app, to sign in or to confirm something.",
  payment_form: "The page described in `elements` asks for payment details: a card number with its expiry date and security code, or a bank account.",
};
export const DECLINE = "Which one element turns down the optional cookies, or closes the cookie banner without accepting them? Choose none_of_these when no listed element does.";
const NO_DECLINE = "No listed element turns down the optional cookies or closes the banner without accepting them.";

/** What the model is told of a wall, and what to do about it. */
const WALL_NOTES: Record<Wall, (at: string) => string> = {
  sign_in_wall: (at) => `Jev: this page wants a sign-in (${at}). If the task did not give you the credentials, finish with needs_you and say what the user must do.`,
  captcha: (at) => `Jev: this page shows a CAPTCHA (${at}). Only the user can solve it: finish with needs_you and say what the user must do.`,
  code_needed: (at) => `Jev: this page asks for a verification code (${at}). It is a code the user has: unless the task gave it to you, finish with needs_you and say what the user must do.`,
  payment_form: (at) => `Jev: this page asks for payment details (${at}). Payment details are never typed by a hand: finish with needs_you and say what the user must do.`,
};

/** Jev's answers on one page. */
export interface Verdict {
  /** cookie_banner and each wall, 0 to 1; empty when the request failed. */
  scores: Partial<Record<Wall | "cookie_banner", number>>;
  /** Its pick among the declining buttons, when it was offered any. */
  decline: ChoiceResponse | null;
  ms: number;
  error?: string;
}

/** The items a page's question shows: all of them, or past `cap` the ones that tell (and the candidates) first, then the rest in reading order. */
function shortlist(items: Item[], first: (it: Item) => boolean, cap: number): Item[] {
  if (items.length <= cap) return items;
  const kept = new Set(items.filter(first).slice(0, cap).map((it) => it.index));
  for (const it of items) {
    if (kept.size >= cap) break;
    kept.add(it.index);
  }
  return items.filter((it) => kept.has(it.index));
}

/** The one request for a page: the five questions, and the pick among the declining buttons when there are any. */
export function pageRequest(screen: Screen, items: Item[], candidates: Item[]): { state: { url: string | null; title?: string; elements: string[] }; questions: Questions } {
  const ids = new Set(candidates.map((it) => it.index));
  const shown = shortlist(items, (it) => ids.has(it.index) || telling(it), config.REFLEX_ITEMS);
  const questions: Questions = { cookie_banner: noul(COOKIE_BANNER) };
  for (const wall of WALLS) questions[wall] = noul(WALL_QUESTIONS[wall]);
  if (candidates.length) questions.decline = choice(DECLINE, { ...Object.fromEntries(candidates.map((it) => [String(it.index), null])), [NONE]: NO_DECLINE });
  return { state: { url: screen.url, ...(screen.tabs?.active ? { title: screen.tabs.active } : {}), elements: shown.map((it) => itemLine(screen, it)) }, questions };
}

type Answer = { noul?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown } | undefined;
const asNoul = (answer: Answer): number | null => (typeof answer?.noul === "number" && Number.isFinite(answer.noul) ? Math.min(1, Math.max(0, answer.noul)) : null);

/** Ask Jev about a page. Never throws: a failed request is a verdict with no scores, and its error. */
export async function askPage(client: () => Jev, screen: Screen, items: Item[], candidates: Item[], signal?: AbortSignal): Promise<Verdict> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const { state, questions } = pageRequest(screen, items, candidates);
    const { answers } = await client().systemOne({ state: state as never, questions }, { timeout: config.REFLEX_MS, retry: { maxRetries: 0 }, ...(signal ? { signal } : {}) });
    const said = answers as Record<string, Answer>;
    const scores: Verdict["scores"] = {};
    for (const name of ["cookie_banner", ...WALLS] as const) {
      const value = asNoul(said[name]);
      if (value !== null) scores[name] = value;
    }
    const picked = said.decline;
    const offered = new Set([...candidates.map((it) => String(it.index)), NONE]);
    const decline = picked && typeof picked.choice === "string" && offered.has(picked.choice) && typeof picked.confidence === "number" ? (picked as unknown as ChoiceResponse) : null;
    return { scores, decline, ms: ms() };
  } catch (error) {
    return { scores: {}, decline: null, ms: ms(), error: failure(error) };
  }
}

/** The line a listing starts with when the page wants the user: the likeliest wall at WALL_AT or more, or null. */
export function wallNote(verdict: Verdict): string | null {
  const [wall, score] = WALLS.map((one): [Wall, number] => [one, verdict.scores[one] ?? 0]).sort((a, b) => b[1] - a[1])[0]!;
  return score >= config.WALL_AT ? WALL_NOTES[wall](score.toFixed(2)) : null;
}

/** What the page reflex found on one listing: a line to lead it with, and a button to press now. */
export interface PageLook {
  note: string | null;
  /** The button Jev picked to turn down a cookie banner: pressed from behind, at most once a URL. */
  press: Item | null;
  verdict: Verdict;
}

const REMEMBERED = 200; // pages whose verdict is kept, so a page looked at again costs nothing

/**
 * The page reflex of one hand. `look` is given every listing of a web page in the hand's own browser window (the
 * tools decide which those are): it asks Jev once per page, when the page's words call for it, and says what it found.
 */
export class PageReflex {
  private seen = new Map<string, Verdict>(); // by page: its URL and its items
  private declined = new Set<string>(); // URLs whose banner a press was picked for
  constructor(private readonly options: { client?: () => Jev; log?: Log } = {}) {}

  /** What to lead the listing with, and what to press; null when the page gave no reason to ask. Never throws. `press` false: say, but press nothing. */
  async look(screen: Screen, items: Item[], press = true): Promise<PageLook | null> {
    try {
      const url = screen.url;
      if (!config.reflexes() || !url || !/^https?:\/\//i.test(url)) return null;
      const found = signs(items);
      if (!found.size) return null;
      const page = String(Bun.hash(`${url}\n${items.map((it) => `${it.role} ${it.text}`).join("\n")}`));
      let verdict = this.seen.get(page);
      const fresh = verdict === undefined;
      const candidates = declining(items);
      if (!verdict) {
        verdict = await askPage(this.options.client ?? jevClient, screen, items, candidates);
        if (this.seen.size >= REMEMBERED) this.seen.delete(this.seen.keys().next().value!);
        this.seen.set(page, verdict);
      }
      const note = wallNote(verdict);
      const where = url.replace(/#.*$/, "");
      const { decline } = verdict;
      const banner = (verdict.scores.cookie_banner ?? 0) >= config.BANNER_AT;
      const pick = banner && decline && decline.choice !== NONE && decline.confidence >= config.DECLINE_AT ? candidates.find((it) => String(it.index) === decline.choice) : undefined;
      const pressing = pick && press && !this.declined.has(where) ? pick : null;
      if (pressing) this.declined.add(where);
      if (fresh) {
        this.options.log?.({
          reflex: "page",
          url,
          signs: [...found],
          ms: verdict.ms,
          scores: verdict.scores,
          ...(decline ? { decline: { choice: decline.choice, text: candidates.find((it) => String(it.index) === decline.choice)?.text ?? null, confidence: decline.confidence } } : {}),
          ...(candidates.length ? { candidates: candidates.map((it) => it.text) } : {}),
          ...(note ? { note } : {}),
          ...(pressing ? { press: pressing.text } : {}),
          ...(verdict.error ? { error: verdict.error } : {}),
        });
      }
      return { note, press: pressing, verdict };
    } catch (error) {
      this.options.log?.({ reflex: "page", url: screen.url, error: failure(error) });
      return null;
    }
  }
}

// ------------------------------------------------------------------ the done check

export const CHECK = "The screen described in `elements` shows that `claim` is so: what it says can be read or seen on this screen.";
const CLAIM_CHARS = 600;

const cut = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** One item as the done check reads it: as src/decide.ts writes it, with more of its words. */
const checkLine = (screen: Screen, it: Item): string => `${it.index}: ${fromAx(it) && it.role ? it.role : "text"} ${repr(cut(it.text, config.CHECK_CHARS))} (${region(screen, it)})`;

/**
 * How likely the hand's last screen shows that `claim` is so, 0 to 1: one noul, the items once in state (past
 * CHECK_ITEMS, the ones sharing most words with the claim). Null when it was not asked (reflexes off, no key, nothing
 * to read) or the request failed. Never throws.
 */
export async function doneCheck(screen: Screen, items: Item[], claim: string, options: { client?: () => Jev; log?: Log; signal?: AbortSignal } = {}): Promise<number | null> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const said = claim.replace(/\s+/g, " ").trim();
  if (!config.reflexes() || !said || !items.length) return null;
  try {
    const shown = items.length > config.CHECK_ITEMS ? mostShared(items.map((it) => it.text), said, config.CHECK_ITEMS).map((i) => items[i]!) : items;
    const state = { claim: cut(said, CLAIM_CHARS), app: screen.app, url: screen.url, elements: shown.map((it) => checkLine(screen, it)) };
    const { answers } = await (options.client ?? jevClient)().systemOne(
      { state: state as never, questions: { shows: noul(CHECK) } },
      { timeout: config.REFLEX_MS, retry: { maxRetries: 0 }, ...(options.signal ? { signal: options.signal } : {}) },
    );
    const checked = asNoul((answers as Record<string, Answer>).shows);
    options.log?.({ reflex: "check", url: screen.url, app: screen.app, claim: cut(said, 200), ms: ms(), checked, items: shown.length });
    return checked;
  } catch (error) {
    options.log?.({ reflex: "check", url: screen.url, app: screen.app, claim: cut(said, 200), ms: ms(), error: failure(error) });
    return null;
  }
}
