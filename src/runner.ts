/** The step loop and the run folder. */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type TypeSafeClient, TypeSafeError } from "@typesafe-ai/sdk";
import { type Context, isNoop, perform } from "./actions.ts";
import { DEFAULT_DELAY, DEFAULT_MIN_CONFIDENCE, DEFAULT_STEPS, GATE_AT, MAX_ITEMS, RETRY_ITEMS, STUCK_AFTER, STUCK_AT } from "./config.ts";
import { type Decision, failure, type Look, newClient, OFFSCREEN_PREFIX, type Request, request, send, tooLarge, warm } from "./decide.ts";
import { assessRisk, consequential } from "./gate.ts";
import { platform as macos } from "./platform.ts";
import { Abort, fieldRecord, type Item, repr, roleWord, type Screen } from "./models.ts";
import { capture, keptByBudget, OcrCache, perceive } from "./perception.ts";
import { annotate, axCount, type Log, makeLog, renderRequest, top } from "./report.ts";
import { formatTiming, phase, summarize, type Timing } from "./timing.ts";
import { type Answer, composeAnswer } from "./writer.ts";

export const MAX_CONSECUTIVE_NOOPS = 2; // actions in a row that were refused or failed
export const LOOP = 3; // the same action this many times, the screen unchanged after each: a loop (the teammate's rule)
export const MAX_IDLE = 4; // actions in a row, of any kind, after which the screen had not changed
const STOP_POLL_MS = 100; // how often a request out to Jev looks for the user's stop

// The outcomes that end with an answer, each in words the writer can pass on. A dry run took no
// action and an abort is the user's own stop, so neither has anything to report.
export const STOPPED: Record<string, string> = {
  done: "the classifier judged the goal already achieved on this screen",
  "nothing helps": "the classifier found nothing on this screen that helps with the goal",
  "low confidence": "the classifier was not confident enough in any next action",
  stalled: "the last actions changed nothing",
  "step limit": "the run used every step it was allowed",
};

/** Why a run ends as blank, which only the browser's own setting mends for good. */
export const BLANK =
  "the browser has not drawn this covered page, so there is nothing on it to read, and showing it to the browser did not change that. " +
  "Chrome's NativeWindowOcclusionEnabled policy, set to 0, lets it draw pages out of sight (the README says how, under Windows)";

export interface RunConfig {
  goal: string;
  out: string;
  act?: boolean;
  steps?: number;
  minConfidence?: number;
  delay?: number; // seconds after each action; 0 where the look waits for the window to settle itself (a hand's)
  image?: string; // replay a saved capture (never acts)
  app?: string; // frontmost app to report during replay
  url?: string; // browser URL to report during replay
  look?: (out: string, timing?: Timing) => Promise<Screen>; // how a step sees: a hand's own window (src/tools.ts); the screen, by default
  /** The first step's screen and items, when the caller holds a capture nothing has acted on since: no new one is taken. */
  first?: [Screen, Item[]];
  /** Show a page that reads as blank to its browser (src/tools.ts): once per URL, then it is looked at again. True when it may have helped. */
  prime?: (screen: Screen) => Promise<boolean>;
  /** Whether the run ends with the writer's answer. Default true; a hand reads the window it is left with itself. */
  answer?: boolean;
  /** The most items a step shows Jev. Default MAX_ITEMS. */
  items?: number;
  /** Look at a click's consequences before making it (src/gate.ts). Default true. */
  gate?: boolean;
  /** The client to ask. Default a new one. */
  typesafe?: TypeSafeClient;
}

type Config = Required<Pick<RunConfig, "goal" | "out" | "act" | "steps" | "minConfidence" | "delay" | "answer" | "items" | "gate">> &
  Pick<RunConfig, "image" | "app" | "url" | "look" | "first" | "prime" | "typesafe">;

export interface RunState {
  history: string[]; // what each action did, with whether the screen changed after it once the next look has said
  timings: Timing[];
  consecutiveNoops: number;
  idle: number; // actions in a row after which the screen had not changed
  outcome: string; // every way out of the loop names its own; only an exception leaves "crashed"
  reason: string | null; // the outcome's why, in words
  ocrCache: OcrCache; // carries one step's OCR into the next
  view: [Screen, Item[]] | null; // the latest capture, until an action makes it stale
  answer: Answer | null;
  pending: Promise<unknown>[]; // annotated screenshots still being written
  decision: Decision | null; // Jev's answers for the capture in `view`, when it has answered for it
  seconds: number;
  primed: Set<string>; // the URLs a blank page was shown to its browser at
  seen: Map<string, number[]>; // a screen's fingerprint, and the actions taken on it, by their place in `history`
  acted: string | null; // the fingerprint of the screen the last action was taken on, until the next look tells what it did
}

/** Drive the loop. ctxFactory(typesafe, history) builds the action Context. */
export async function run(config: RunConfig, ctxFactory: (typesafe: TypeSafeClient, history: string[]) => Context): Promise<RunState> {
  const cfg: Config = { act: false, steps: DEFAULT_STEPS, minConfidence: DEFAULT_MIN_CONFIDENCE, delay: DEFAULT_DELAY, answer: true, items: MAX_ITEMS, gate: true, ...config };
  mkdirSync(cfg.out, { recursive: true });
  const log = makeLog(join(cfg.out, "run.log"));
  log(`run folder: ${cfg.out}`);
  if (cfg.act) log("driving the machine. abort: Ctrl-C, or slam the mouse into the top-left corner.");

  const state: RunState = {
    history: [],
    timings: [],
    consecutiveNoops: 0,
    idle: 0,
    outcome: "crashed",
    reason: null,
    ocrCache: new OcrCache(),
    view: null,
    answer: null,
    pending: [],
    decision: null,
    seconds: 0,
    primed: new Set(),
    seen: new Map(),
    acted: null,
  };
  const started = Date.now();
  const onInterrupt = () => macos.interrupt();
  process.once("SIGINT", onInterrupt);
  try {
    const client = cfg.typesafe ?? newClient();
    if (!cfg.first) warm(client); // the connection opens while the first capture is taken
    const ctx = ctxFactory(client, state.history);
    let step = 1;
    while (step <= cfg.steps && (await runStep(cfg, ctx, state, step, log))) step++;
    if (step > cfg.steps) {
      log(`\nstopped after ${cfg.steps} steps`);
      state.outcome = "step limit";
      state.reason = `it used all ${cfg.steps} steps it was given`;
    }
    if (cfg.answer) await conclude(cfg, ctx, state, log);
  } catch (error) {
    if (!(error instanceof Abort)) throw error;
    state.outcome = `aborted (${error.message || "Ctrl-C"})`;
    log(`\n${state.outcome} after ${state.history.length} actions`);
  } finally {
    process.off("SIGINT", onInterrupt);
    await Promise.allSettled(state.pending);
    state.seconds = Math.round((Date.now() - started) / 100) / 10;
    const summary = {
      goal: cfg.goal,
      act: cfg.act,
      steps_taken: state.history.length,
      outcome: state.outcome,
      reason: state.reason,
      answer: state.answer?.text ?? null,
      goal_achieved: state.answer?.achieved ?? null,
      seconds: state.seconds,
      timing: summarize(state.timings),
      history: state.history,
      config: Object.fromEntries(Object.entries(cfg).flatMap(([k, v]) => (v === null || (typeof v !== "object" && typeof v !== "function") ? [[k, String(v)]] : []))),
    };
    await Bun.write(join(cfg.out, "run.json"), JSON.stringify(summary, null, 2));
    log(`run folder: ${cfg.out}`);
  }
  return state;
}

/**
 * Hand the screen the run ended on to the writer, for the answer the classifier cannot put into words.
 *
 * The last step's capture serves when nothing acted after it. An action makes it stale, so the
 * screen is captured again, and saved so the answer can be checked against what it was read from.
 */
async function conclude(cfg: Config, ctx: Context, state: RunState, log: Log): Promise<void> {
  const stopped = STOPPED[state.outcome];
  if (stopped === undefined) return;
  if (!ctx.writer) return log("\nno answer: the writer is disabled (no credentials for the writer model; run `pi` and /login)");
  const started = performance.now();
  if (state.view === null) {
    macos.checkAbort();
    const out = join(cfg.out, "answer-raw.png");
    const screen = cfg.look ? await cfg.look(out) : await capture({ out, imagePath: cfg.image, app: cfg.app, url: cfg.url, browser: ctx.browser });
    state.view = [screen, await perceive(screen, cfg.items, cfg.look ? "" : cfg.goal)];
  }
  const [screen, items] = state.view;
  try {
    state.answer = await composeAnswer(ctx.writer, cfg.goal, screen, items, state.history, stopped);
  } catch (error) {
    return log(`\nno answer: the writer failed (${error instanceof Error ? error.message : error})`);
  }
  const verdict = state.answer.achieved ? "goal achieved" : "goal not achieved";
  log(`\nanswer (${verdict}, ${((performance.now() - started) / 1000).toFixed(1)}s):\n  ${state.answer.text}`);
}

/** A screen as the stall rules compare it: every item's role, text and value, and the URL. Where things lie is left out, so a page that only reflowed is the same screen. */
export const fingerprint = (screen: Screen, items: Item[]): string =>
  String(Bun.hash(`${screen.url ?? ""}\n${items.map((it) => `${it.role}|${it.text}|${it.value ?? ""}`).join("\n")}`));

/**
 * A page with nothing to read: a web page with no items at all, or an old picture with nothing from the page's own tree.
 * A covered browser window draws nothing, and builds no tree for a page that loaded out of sight (measured).
 */
export const blank = (screen: Screen, items: Item[]): boolean =>
  (items.length === 0 && /^https?:/i.test(screen.url ?? "")) || (screen.image.stale === true && axCount(items) === 0);

/**
 * `work` with a signal that fires when the user stops the hand: the platform's interrupt (a stop, a pause, a click on the
 * hand, Ctrl-C, the mouse in a corner), looked at while the request is out. The stop ends the wait at once, whether or
 * not the work heeds its signal, and is thrown as the Abort it was.
 */
export async function stoppable<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const stop = new AbortController();
  const stopped = new Promise<never>((_, reject) => stop.signal.addEventListener("abort", () => reject(stop.signal.reason)));
  const watch = setInterval(() => {
    try {
      macos.checkAbort();
    } catch (error) {
      stop.abort(error);
    }
  }, STOP_POLL_MS);
  const working = work(stop.signal);
  working.catch(() => {}); // what a stopped request says as it ends is not waited for
  try {
    return await Promise.race([working, stopped]);
  } finally {
    clearInterval(watch);
  }
}

/** The step's screen and its items: for the first step the caller's own capture when it gave one, else a new capture. */
async function see(cfg: Config, state: RunState, prefix: string, timing: Timing, reuse: boolean, browser: string): Promise<[Screen, Item[]]> {
  if (reuse && cfg.first) {
    state.pending.push(Bun.write(`${prefix}-raw.png`, Bun.file(cfg.first[0].image.path)));
    return cfg.first;
  }
  if (cfg.image) await Bun.write(`${prefix}-raw.png`, Bun.file(cfg.image));
  const screen = await phase(timing, "capture", () =>
    cfg.look ? cfg.look(`${prefix}-raw.png`, timing) : capture({ out: `${prefix}-raw.png`, imagePath: cfg.image, app: cfg.app, url: cfg.url, browser, timing }),
  );
  // Only the whole display can show the command that started the run, whose words would read as the goal met: a hand's window holds none.
  return [screen, await perceive(screen, cfg.items, cfg.look ? "" : cfg.goal, timing, cfg.image ? undefined : state.ocrCache)];
}

/** The last action told by what the look after it found, and the count of actions in a row that changed nothing. A first wait that changed nothing is waiting, not doing nothing. */
function tag(state: RunState, print: string): void {
  if (state.acted === null) return;
  const i = state.history.length - 1;
  const line = state.history[i]!;
  const changed = print !== state.acted;
  state.history[i] = `${line} -> ${changed ? "screen changed" : "no visible change"}`;
  const firstWait = line.startsWith("waited") && !state.history[i - 1]?.startsWith("waited");
  state.idle = changed ? 0 : firstWait ? state.idle : state.idle + 1;
  state.acted = null;
}

/** Why the run is going nowhere, or null: the same action LOOP times with no change after each, or MAX_IDLE actions in a row that changed nothing. */
function stalled(state: RunState): string | null {
  const last = state.history.slice(-LOOP);
  if (last.length === LOOP && last.every((line) => line === last[0] && line.endsWith("no visible change"))) {
    return `the same action ${LOOP} times, and the screen did not change: ${last[0]!.replace(/ -> no visible change$/, "")}`;
  }
  if (state.idle >= MAX_IDLE) return `${state.idle} actions in a row changed nothing on the screen`;
  return null;
}

async function runStep(cfg: Config, ctx: Context, state: RunState, step: number, log: Log): Promise<boolean> {
  macos.checkAbort();
  const timing: Timing = {};
  const started = performance.now();
  const prefix = join(cfg.out, `step-${String(step).padStart(3, "0")}`); // three digits, so a run of 100 steps still lists in order
  const name = prefix.slice(cfg.out.length + 1);
  const done = (keepGoing: boolean): boolean => {
    timing.act ??= 0;
    timing.total ??= Math.round(performance.now() - started) / 1000;
    state.timings.push(timing);
    log(formatTiming(timing));
    return keepGoing;
  };
  const stop = (outcome: string, reason: string | null): boolean => {
    state.outcome = outcome;
    state.reason = reason;
    log(`  ${outcome}${reason ? `: ${reason}` : ""}; stopping`);
    return false;
  };

  let [screen, items] = await see(cfg, state, prefix, timing, step === 1, ctx.browser);
  state.view = [screen, items];
  state.decision = null; // until Jev answers for this capture
  // A page that reads as blank is shown to its browser, once per URL, and looked at again without spending a step.
  while (blank(screen, items)) {
    const url = screen.url ?? "";
    log(`\nstep ${step}: ${repr(url)} reads as blank (items=${items.length} ax=${axCount(items)}${screen.image.stale ? ", an old picture" : ""})`);
    if (!cfg.prime || state.primed.has(url)) return done(stop("blank", BLANK));
    state.primed.add(url);
    const shown = await phase(timing, "prime", () => cfg.prime!(screen));
    log(`  ${shown ? "showed it to the browser" : "could not show it to the browser"}; looking again`);
    [screen, items] = await see(cfg, state, prefix, timing, false, ctx.browser);
    state.view = [screen, items];
  }

  const print = fingerprint(screen, items);
  tag(state, print);
  const going = stalled(state);
  if (going) {
    log(`\nstep ${step}:`);
    return done(stop("stalled", going));
  }

  const look: Look = {
    goal: cfg.goal,
    screen,
    items,
    history: state.history,
    tried: (state.seen.get(print) ?? []).map((i) => state.history[i]!),
    text: ctx.text ?? null,
    write: ctx.writer !== null,
    email: ctx.email,
    browse: ctx.drive ? null : ctx.browser,
  };
  const decision = await consult(ctx, state, look, prefix, timing, log);
  if (!decision) return done(false);
  state.decision = decision;
  state.pending.push(annotate(screen, items, decision.target ?? decision.chosen, `${prefix}.png`)); // nothing waits on the picture
  report(step, screen, items, decision, log);

  const keepGoing = await resolve(cfg, ctx, state, screen, items, decision, print, timing, stop, log);
  timing.act ??= 0;
  timing.total = Math.round(performance.now() - started) / 1000;
  await Bun.write(`${prefix}-answers.json`, JSON.stringify(answers(decision, screen, items, timing), null, 2));
  log(`  files: ${name}-raw.png, ${name}.png, ${name}-payload.txt, ${name}-answers.json`);
  done(keepGoing);
  if (state.view === null && cfg.delay > 0) await macos.sleepWatching(cfg.delay); // an action ran: let the screen settle before the next step, or the answer, reads it
  return keepGoing;
}

/**
 * Ask Jev, and once more with a smaller request when this one is over its token limit: fewer items (the faintest text
 * goes first) and no off-screen controls. Null, with the outcome said, when Jev cannot answer: a failed request ends
 * the run with what the hand needs to know, never as an exception.
 */
async function consult(ctx: Context, state: RunState, look: Look, prefix: string, timing: Timing, log: Log): Promise<Decision | null> {
  let req: Request = request(look);
  await Bun.write(`${prefix}-payload.txt`, renderRequest(req, look.screen, look.items));
  for (let smaller = false; ; smaller = true) {
    try {
      return await phase(timing, "decide", () => stoppable((signal) => send(ctx.typesafe, req, signal)));
    } catch (error) {
      if (!(error instanceof TypeSafeError)) throw error;
      if (tooLarge(error) && !smaller) {
        const kept = keptByBudget(look.items, RETRY_ITEMS).map((i) => look.items[i]!);
        log(`  the request is over Jev's token limit: asking again with ${kept.length} of ${look.items.length} items and no off-screen controls`);
        req = request({ ...look, items: kept, offscreen: false });
        await Bun.write(`${prefix}-payload-smaller.txt`, renderRequest(req, look.screen, kept));
        continue;
      }
      state.outcome = `classifier failed: ${failure(error)}`;
      state.reason = null;
      log(`  ${state.outcome}; stopping`);
      return null;
    }
  }
}

/** One step's answers in the log: the likeliest kinds and targets, and the yes/no answers. */
function report(step: number, screen: Screen, items: Item[], decision: Decision, log: Log): void {
  const byIndex = new Map(items.map((it) => [String(it.index), it]));
  log(
    `\nstep ${step}: app=${repr(screen.app)} url=${screen.url === null ? "None" : repr(screen.url)} items=${items.length} ax=${axCount(items)} ` +
      `offscreen=${screen.offscreen.length} kind=${decision.kind.choice} (${decision.kind.confidence.toFixed(2)})${decision.site ? ` site=${decision.site.choice}` : ""}`,
  );
  for (const [key, p] of top(decision.kind, 4)) log(`  ${p.toFixed(2).padStart(5)}  ${key}`);
  const targets: [string, typeof decision.item, number][] = [["item", decision.item, 4], ["field", decision.field, 3], ["offscreen", decision.offscreen, 3]];
  for (const [what, answer, n] of targets) {
    if (!answer) continue;
    log(`  ${what} (${answer.confidence.toFixed(2)}):`);
    for (const [key, p] of top(answer, n)) {
      const label = what === "offscreen" ? screen.offscreen[Number(key.replace(/^o/, ""))]?.label : byIndex.get(key)?.text;
      log(`  ${p.toFixed(2).padStart(5)}  [${key}] ${repr(label ?? "")}`);
    }
  }
  const nouls = (["goalMet", "submit", "stuck"] as const).flatMap((key) => (decision.extra[key] == null ? [] : [`${key === "goalMet" ? "goal_met" : key} ${decision.extra[key]!.toFixed(2)}`]));
  if (nouls.length) log(`  ${nouls.join("  ")}`);
}

/** The click a decision makes, in words, when its label reads like a commitment (src/gate.ts); null for anything else. */
function commitment(decision: Decision, screen: Screen, items: Item[]): string | null {
  if (decision.clicking) {
    const it = items.find((candidate) => String(candidate.index) === decision.chosen);
    return it && consequential(it.text) ? `click ${it.role || "text"} ${repr(it.text)}` : null;
  }
  if (decision.pressingOffscreen) {
    const node = screen.offscreen[Number(decision.chosen.slice(OFFSCREEN_PREFIX.length))];
    return node && consequential(node.label) ? `press ${roleWord(node)} ${repr(node.label)}` : null;
  }
  return null;
}

/** Apply the stop rules, then the action. True to keep looping. */
async function resolve(
  cfg: Config,
  ctx: Context,
  state: RunState,
  screen: Screen,
  items: Item[],
  decision: Decision,
  print: string,
  timing: Timing,
  stop: (outcome: string, reason: string | null) => boolean,
  log: Log,
): Promise<boolean> {
  const met = decision.goalMet;
  if (decision.extra.problem) return stop("unsure", decision.extra.problem);
  if (decision.done) return stop("done", met === null ? null : `goal_met ${met.toFixed(2)}`);
  if (decision.kind.choice === "done") return stop("unsure", `Jev would stop, but does not see the goal met on this screen (goal_met ${met?.toFixed(2)})`);
  if (decision.kind.choice === "none") return stop("nothing helps", "Jev found nothing on this screen that helps with the goal");
  if (decision.targetless) return stop("unsure", `Jev would ${decision.kind.choice.replace("_", " ")}, but found nothing listed that fits the goal`);
  const doubt = decision.doubt(cfg.minConfidence);
  if (doubt) return stop("low confidence", doubt);
  const stuck = decision.extra.stuck ?? 0;
  if (state.history.length >= STUCK_AFTER && stuck >= STUCK_AT) return stop("stalled", `Jev says the run repeats itself or makes no progress (stuck ${stuck.toFixed(2)})`);
  if (!cfg.act || cfg.image) {
    log(`  would do: ${decision.chosen}. dry run (pass --act without --image to drive the machine)`);
    state.outcome = "dry run";
    return false;
  }

  const commits = cfg.gate ? commitment(decision, screen, items) : null;
  if (commits) {
    try {
      const risk = await phase(timing, "gate", () => stoppable((signal) => assessRisk(ctx.typesafe, { goal: cfg.goal, action: commits, app: screen.app, url: screen.url }, signal)));
      log(`  gate: ${Object.entries(risk.flags).map(([flag, p]) => `${flag} ${p.toFixed(2)}`).join("  ")}`);
      if (risk.level >= GATE_AT) return stop(`needs approval: ${commits}`, `${risk.worst.replace("_", " ")} ${risk.level.toFixed(2)}`);
    } catch (error) {
      if (!(error instanceof TypeSafeError)) throw error;
      return stop(`needs approval: ${commits}`, `the check of its consequences failed (${failure(error)})`);
    }
  }

  const what = await phase(timing, "act", () => perform(decision, screen, items, ctx));
  state.view = null;
  state.seen.set(print, [...(state.seen.get(print) ?? []), state.history.length]);
  state.history.push(what);
  state.acted = print;
  log(`  did: ${what}`);
  if (!isNoop(what)) state.consecutiveNoops = 0;
  else if (++state.consecutiveNoops >= MAX_CONSECUTIVE_NOOPS) return stop("stalled", `${MAX_CONSECUTIVE_NOOPS} actions in a row were refused or failed`);
  return true;
}

/** What the classifier returned for this step, what it cost, and the model that answered. */
export function answers(decision: Decision, screen: Screen, items: Item[], timing: Timing) {
  const { extra } = decision;
  return {
    kind: decision.kind.choice,
    kind_confidence: decision.kind.confidence,
    kind_probabilities: decision.kind.probabilities,
    item: decision.item?.choice ?? null,
    item_confidence: decision.item?.confidence ?? null,
    item_probabilities: decision.item?.probabilities ?? null,
    item_parts: extra.parts?.map((part) => ({ choice: part.choice, confidence: part.confidence })) ?? null,
    field: decision.field?.choice ?? null,
    field_confidence: decision.field?.confidence ?? null,
    field_probabilities: decision.field?.probabilities ?? null,
    offscreen: decision.offscreen?.choice ?? null,
    offscreen_probabilities: decision.offscreen?.probabilities ?? null,
    site: decision.site?.choice ?? null,
    site_probabilities: decision.site?.probabilities ?? null,
    goal_met: extra.goalMet ?? null,
    submit: extra.submit ?? null,
    stuck: extra.stuck ?? null,
    problem: extra.problem ?? null,
    chosen: decision.chosen,
    confidence: decision.confidence,
    model: extra.meta?.model ?? null,
    input_tokens: extra.meta?.inputTokens ?? null,
    timing,
    items,
    offscreen_controls: screen.offscreen.map((node, i) => ({ k: i, role: roleWord(node), label: node.label })),
    field_focused: screen.field ? fieldRecord(screen.field) : null,
    app: screen.app,
    url: screen.url,
  };
}
