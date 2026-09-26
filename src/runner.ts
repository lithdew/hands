/** The step loop and the run folder. */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { type Context, isNoop, perform } from "./actions.ts";
import { DEFAULT_DELAY, DEFAULT_MIN_CONFIDENCE, DEFAULT_STEPS, MAX_OPTIONS } from "./config.ts";
import { type Decision, decide, offscreenRecords } from "./decide.ts";
import { platform as macos } from "./platform.ts";
import { Abort, fieldRecord, type Item, repr, type Screen } from "./models.ts";
import { capture, OcrCache, perceive } from "./perception.ts";
import { annotate, axCount, type Log, makeLog, renderPayload, top } from "./report.ts";
import { formatTiming, phase, summarize, type Timing } from "./timing.ts";
import { type Answer, composeAnswer } from "./writer.ts";

export const MAX_CONSECUTIVE_NOOPS = 2;

// The outcomes that end with an answer, each in words the writer can pass on. A dry run took no
// action and an abort is the user's own stop, so neither has anything to report.
export const STOPPED: Record<string, string> = {
  done: "the classifier judged the goal already achieved on this screen",
  "nothing helps": "the classifier found nothing on this screen that helps with the goal",
  "low confidence": "the classifier was not confident enough in any next action",
  stalled: "the last actions changed nothing",
  "step limit": "the run used every step it was allowed",
};

export interface RunConfig {
  goal: string;
  out: string;
  act?: boolean;
  steps?: number;
  minConfidence?: number;
  delay?: number;
  image?: string; // replay a saved capture (never acts)
  app?: string; // frontmost app to report during replay
  url?: string; // browser URL to report during replay
  look?: (out: string, timing?: Timing) => Promise<Screen>; // how a step sees: a hand's own window (src/tools.ts); the screen, by default
}

type Config = Required<Pick<RunConfig, "goal" | "out" | "act" | "steps" | "minConfidence" | "delay">> & Pick<RunConfig, "image" | "app" | "url" | "look">;

export interface RunState {
  history: string[];
  timings: Timing[];
  consecutiveNoops: number;
  lastUrl: string | null;
  outcome: string; // every way out of the loop names its own; only an exception leaves "crashed"
  ocrCache: OcrCache; // carries one step's OCR into the next
  view: [Screen, Item[]] | null; // the latest capture, until an action makes it stale
  answer: Answer | null;
  pending: Promise<unknown>[]; // annotated screenshots still being written
}

/** Drive the loop. ctxFactory(typesafe, history) builds the action Context. */
export async function run(config: RunConfig, ctxFactory: (typesafe: TypeSafeClient, history: string[]) => Context): Promise<RunState> {
  const cfg: Config = { act: false, steps: DEFAULT_STEPS, minConfidence: DEFAULT_MIN_CONFIDENCE, delay: DEFAULT_DELAY, ...config };
  mkdirSync(cfg.out, { recursive: true });
  const log = makeLog(join(cfg.out, "run.log"));
  log(`run folder: ${cfg.out}`);
  if (cfg.act) log("driving the machine. abort: Ctrl-C, or slam the mouse into the top-left corner.");

  const state: RunState = {
    history: [],
    timings: [],
    consecutiveNoops: 0,
    lastUrl: null,
    outcome: "crashed",
    ocrCache: new OcrCache(),
    view: null,
    answer: null,
    pending: [],
  };
  const started = Date.now();
  const onInterrupt = () => macos.interrupt();
  process.once("SIGINT", onInterrupt);
  try {
    const ctx = ctxFactory(new TypeSafeClient(), state.history);
    let step = 1;
    while (step <= cfg.steps && (await runStep(cfg, ctx, state, step, log))) step++;
    if (step > cfg.steps) {
      log(`\nstopped after ${cfg.steps} steps`);
      state.outcome = "step limit";
    }
    await conclude(cfg, ctx, state, log);
  } catch (error) {
    if (!(error instanceof Abort)) throw error;
    state.outcome = `aborted (${error.message || "Ctrl-C"})`;
    log(`\n${state.outcome} after ${state.history.length} actions`);
  } finally {
    process.off("SIGINT", onInterrupt);
    await Promise.allSettled(state.pending);
    const summary = {
      goal: cfg.goal,
      act: cfg.act,
      steps_taken: state.history.length,
      outcome: state.outcome,
      answer: state.answer?.text ?? null,
      goal_achieved: state.answer?.achieved ?? null,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      timing: summarize(state.timings),
      history: state.history,
      config: Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, String(v)])),
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
    state.view = [screen, await perceive(screen, MAX_OPTIONS, cfg.goal)];
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

async function runStep(cfg: Config, ctx: Context, state: RunState, step: number, log: Log): Promise<boolean> {
  macos.checkAbort();
  const timing: Timing = {};
  const started = performance.now();
  const prefix = join(cfg.out, `step-${String(step).padStart(3, "0")}`); // three digits, so a run of 100 steps still lists in order
  const name = prefix.slice(cfg.out.length + 1);
  if (cfg.image) await Bun.write(`${prefix}-raw.png`, Bun.file(cfg.image));
  const screen = await phase(timing, "capture", () =>
    cfg.look ? cfg.look(`${prefix}-raw.png`, timing) : capture({ out: `${prefix}-raw.png`, imagePath: cfg.image, app: cfg.app, url: cfg.url, browser: ctx.browser, timing }),
  );
  const items = await perceive(screen, MAX_OPTIONS, cfg.goal, timing, cfg.image ? undefined : state.ocrCache);
  state.view = [screen, items];
  await Bun.write(`${prefix}-payload.txt`, renderPayload(cfg.goal, screen, items, state.history, ctx.browser, ctx.email));

  const decision = await phase(timing, "decide", () => decide(ctx.typesafe, cfg.goal, screen, items, state.history, ctx.browser, ctx.email));
  const byIndex = new Map(items.map((it) => [String(it.index), it]));
  state.pending.push(annotate(screen, items, decision.chosen, `${prefix}.png`)); // nothing waits on the picture

  const fieldDesc = screen.field ? ` field=${screen.field.role}:${repr(screen.field.label)}` : "";
  log(
    `\nstep ${step}: app=${repr(screen.app)}${fieldDesc} url=${screen.url === null ? "None" : repr(screen.url)} items=${items.length} ax=${axCount(items)} ` +
      `offscreen=${screen.offscreen.length} kind=${decision.kind.choice} (${decision.kind.confidence.toFixed(2)}) site=${decision.site.choice}`,
  );
  for (const [key, p] of top(decision.kind, 4)) log(`  ${p.toFixed(2).padStart(5)}  ${key}`);
  if (decision.item) {
    log(`  item (${decision.item.confidence.toFixed(2)}):`);
    for (const [key, p] of top(decision.item, 4)) log(`  ${p.toFixed(2).padStart(5)}  [${key}] ${repr(byIndex.get(key)?.text ?? "")}`);
  }
  if (decision.offscreen) {
    log(`  offscreen (${decision.offscreen.confidence.toFixed(2)}):`);
    for (const [key, p] of top(decision.offscreen, 3)) log(`  ${p.toFixed(2).padStart(5)}  [${key}] ${repr(screen.offscreen[Number(key)]?.label ?? "")}`);
  }

  const keepGoing = await resolve(cfg, ctx, state, screen, items, decision, timing, log);
  timing.act ??= 0;
  timing.total = Math.round(performance.now() - started) / 1000;
  state.timings.push(timing);

  await Bun.write(`${prefix}-answers.json`, JSON.stringify(answers(decision, screen, items, timing), null, 2));
  log(`  files: ${name}-raw.png, ${name}.png, ${name}-payload.txt, ${name}-answers.json`);
  log(formatTiming(timing));

  if (state.view === null) await macos.sleepWatching(cfg.delay); // an action ran: let the screen settle before the next step, or the answer, reads it
  return keepGoing;
}

/** Apply the stop rules, then the action. True to keep looping. */
async function resolve(cfg: Config, ctx: Context, state: RunState, screen: Screen, items: Item[], decision: Decision, timing: Timing, log: Log): Promise<boolean> {
  if (decision.stops) {
    log(`  model says ${repr(decision.kind.choice)}; stopping`);
    state.outcome = decision.kind.choice === "done" ? "done" : "nothing helps";
    return false;
  }
  if (decision.confidence < cfg.minConfidence) {
    log(`  confidence ${decision.confidence.toFixed(2)} below ${cfg.minConfidence}; stopping`);
    state.outcome = "low confidence";
    return false;
  }
  if (!cfg.act || cfg.image) {
    log(`  would do: ${decision.chosen}. dry run (pass --act without --image to drive the machine)`);
    state.outcome = "dry run";
    return false;
  }

  const what = await phase(timing, "act", () => perform(decision, screen, items, ctx));
  state.view = null;
  const repeated = state.history.at(-1) === what && screen.url === state.lastUrl;
  state.lastUrl = screen.url;
  state.history.push(what);
  log(`  did: ${what}`);
  if (isNoop(what) || repeated) {
    state.consecutiveNoops += 1;
    if (state.consecutiveNoops >= MAX_CONSECUTIVE_NOOPS) {
      log(`  ${MAX_CONSECUTIVE_NOOPS} consecutive no-ops; stopping`);
      state.outcome = "stalled";
      return false;
    }
  } else {
    state.consecutiveNoops = 0;
  }
  return true;
}

/** What the classifier returned for this step, plus what it cost. */
export function answers(decision: Decision, screen: Screen, items: Item[], timing: Timing) {
  return {
    kind: decision.kind.choice,
    kind_confidence: decision.kind.confidence,
    kind_probabilities: decision.kind.probabilities,
    item: decision.item?.choice ?? null,
    item_confidence: decision.item?.confidence ?? null,
    item_probabilities: decision.item?.probabilities ?? null,
    site: decision.site.choice,
    site_probabilities: decision.site.probabilities,
    offscreen: decision.offscreen?.choice ?? null,
    offscreen_probabilities: decision.offscreen?.probabilities ?? null,
    offscreen_controls: offscreenRecords(screen.offscreen),
    chosen: decision.chosen,
    confidence: decision.confidence,
    timing,
    items,
    field: screen.field ? fieldRecord(screen.field) : null,
    app: screen.app,
    url: screen.url,
  };
}
