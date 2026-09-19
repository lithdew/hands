/**
 * Who works a task: our Jev loop, with the pi agent behind it for what Jev cannot finish.
 *
 *   understand   pilot.ts reads the request, and side by side with it (the same round of Jev) one question of our
 *                own: is this about an application on this computer? The pilot only knows urls.
 *   work         pilot.run in the hand's browser, or `hand.launch` and screen.ts on that window. The app's plan is
 *                written while the app starts, so neither waits for the other.
 *   show         every step goes to the feed BEFORE it is performed and is never waited for (steps.ts)
 *   ask          a flagged action waits for `feed.approve`. No, and no answer, are both final: nothing else is tried.
 *   hand over    only when Jev gave up or ran out of looks, HANDS_DRIVER does not say jev, and pi is signed in
 *
 * Measured on the old tree's simulated apps: 14 of 14 tasks in 6.7 Jev rounds and no model call, against 8 of 14
 * in 15.5 rounds and 1.4 calls for the step contract the pi agent's clicker uses. Hence this order.
 */

import { type Ask, choice, makeAsk, noul } from "./ask.ts";
import { agentModel, jevOnly } from "./config.ts";
import { type CursorKind, type FrameSize, MASK } from "./cursor.ts";
import type { Observation } from "./elements.ts";
import type { ApprovalRequest as FeedApproval, Feed, TaskStatus } from "./feed.ts";
import type { RiskFlag } from "./gate.ts";
import type { Hand } from "./hand.ts";
import { type Llm, makeLlm } from "./intent.ts";
import { fileStore, type LearnedStore } from "./learned.ts";
import { runtime } from "./llm.ts";
import { createPilot, loadContacts, type PilotDeps, type Tier } from "./pilot.ts";
import { NotBrowserWork, type PlannedTask, planTasks } from "./plan.ts";
import type { Contact } from "./recipes.ts";
import { type ApprovalRequest, type RunResult, runScreens, type ScreenStep } from "./screen.ts";
import { type Step, stepLine } from "./steps.ts";

export type DriveStatus = RunResult["status"] | "failed";

export interface DriveOptions {
  hand: Hand;
  feed: Pick<Feed, "step" | "approve" | "task">;
  signal?: AbortSignal;
  /** The pi agent, given the request and what Jev did. Resolves true when it saw the task through. None: nothing is handed over. */
  fallback?: (prompt: string) => Promise<boolean>;
  /** The provider/model the fallback runs on. Its provider has to be signed in before anything is handed to it. */
  model?: string;
  print?(line: string): void;
  /** The loop's own notes, a line per look. */
  log?(line: string): void;
  // Seams for tests.
  ask?: Ask;
  llm?: Llm;
  contacts?: readonly Contact[];
  store?: LearnedStore;
  runScreens?: typeof runScreens;
  piReady?: (model: string) => Promise<boolean>;
  today?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface DriveResult {
  /** Who understood it: a tier of the pilot, or `app` for an application on this computer. */
  by: Tier | "app" | null;
  /** How Jev's run ended. A handover does not change it. */
  status: DriveStatus;
  reason: string;
  /** What the hand's row on the card was left saying. */
  card: TaskStatus;
  handedOver: boolean;
  /** Read off the last screen, when the user asked to be told something. */
  answer: string | null;
  /** Resolves when background learning is over. Never rejects. */
  learning: Promise<void>;
}

// ------------------------------------------------------------------ steps

const KIND: Record<ScreenStep["kind"], CursorKind> = { click: "click", type: "type", select: "control", key: "key", scroll: "scroll", wait: "wait", look: "look" };

/** A step of screen.ts as the feed takes it. `size`: what the rectangles were measured in, for a hand that has no window to name. */
export function toStep(step: ScreenStep, hand: Pick<Hand, "id" | "window" | "place">, tier = "screen", size?: FrameSize): Step {
  const window = hand.window();
  const frame = window?.frame ?? size;
  // describeAction explains a key in brackets, which is for Jev. A person reads "press Return".
  const out: Step = { hand: hand.id, kind: KIND[step.kind], label: step.kind === "key" ? step.label.replace(/ \(.*\)$/, "") : step.label, tier };
  if (window) out.hwnd = window.hwnd;
  if (frame) out.frame = frame;
  // The hand knows where a page sits in its window (under the toolbar, at the display's scale); a native control is the window's pixels already.
  if (step.target) out.rect = hand.place(step.target);
  if (step.kind === "click" && step.label.startsWith("double click")) out.count = 2;
  if (step.kind === "click" && step.label.startsWith("right click")) out.button = "right";
  // screen.ts never lets a password out of the loop: the feed is told that something secret goes in, and nothing else.
  if (step.kind === "type") Object.assign(out, step.target?.secret ? { text: MASK, secret: true } : step.text !== undefined ? { text: step.text } : {});
  if (step.kind === "key" || step.kind === "scroll") out.text = step.label.split(" ")[1];
  return out;
}

const WHY: Record<RiskFlag, string> = {
  irreversible: "which cannot be undone",
  spends_money: "which spends money",
  destroys_data: "which deletes something",
  handles_secret: "which handles a password or a key",
  off_goal: "which is not what you asked for",
};

/** The gate's question as the card asks it: the action in words, and the control and page it would be done to. */
export function toApproval(request: ApprovalRequest, hand: number, page?: string): FeedApproval {
  const target = [request.target && (request.target.name || request.target.role), page].filter(Boolean).join("; ");
  return { hand, what: `${request.action}, ${WHY[request.risk.worst]}`, ...(target ? { target } : {}) };
}

// ------------------------------------------------------------------ an application on this computer

/** Applications Jev can name by itself. The name is what `hand.launch` is given; the words are what Jev reads. */
export const APPS = {
  Calculator: "The Calculator: working out a sum, arithmetic, converting a unit.",
  Notepad: "Notepad: plain text typed into a window on this computer.",
  Paint: "Paint: a picture or a drawing.",
} as const;
const [BROWSER, NO_APP, APP_SURE] = ["browser", "no_app", 0.6] as const;

/** One request, asked next to the pilot's reading. The wording is the old tree's triage, which routed "open calculator" and "search youtube" apart. */
export async function nativeApp(ask: Ask, request: string): Promise<{ name: string; onlyOpen: boolean } | null> {
  const a = await ask({ request }, {
    app: choice("Which application on this computer does `request` name, or clearly need opened first? Anything on the web, a web site or a search is `browser`.", {
      ...APPS, [BROWSER]: "The web browser: web sites, searching, email, anything online.", [NO_APP]: "No application needs opening, or it is unclear which." }),
    only_open: noul("`request` asks only to open, start or show an application, and nothing more once it is open."),
  }); // prettier-ignore
  if (a.app.confidence < APP_SURE || !Object.hasOwn(APPS, a.app.choice)) return null;
  return { name: a.app.choice, onlyOpen: a.only_open.noul >= 0.5 };
}

// ------------------------------------------------------------------ the fallback

/** Is the provider of `model` signed in? pi answers "Provider is not configured" only once a task is under way, which is too late to find out. */
export async function piConfigured(model: string): Promise<boolean> {
  try {
    return (await runtime()).hasConfiguredAuth(model.slice(0, model.indexOf("/")));
  } catch {
    return false;
  }
}

/** The task as the pi agent gets it: the user's words first, then what was already tried, so it looks before it repeats anything. */
export function handover(request: string, tried: { reason: string; opened: string[]; steps: ScreenStep[] }): string {
  const did = tried.steps.slice(-8).map((step) => `${step.label}${step.outcome ? ` (${step.outcome})` : ""}`);
  return `${request}

(A faster worker tried this first and stopped: ${tried.reason}.${tried.opened.length ? ` It opened ${tried.opened.join(", ")}, which is still open behind the user's windows.` : ""}${did.length ? ` It did: ${did.join("; ")}.` : ""} Some of the task may be done already: look before you act, and do not do again what is done.)`;
}

// Tried on real Jev with a Calculator's lines: this wording picked "Display is 372" at 0.96 and nothing (0.97) for a request the screen did not answer; "which line tells the user what `request` asks" picked the expression line at 0.29.
const ANSWER_WORDING = "`request` was carried out, and the labels are what the screen shows now. Which one line holds the result the user is waiting to hear?";

/** What the user asked to be told, read off the last screen. Jev picks the line; it never writes one. */
async function answerFrom(ask: Ask, request: string, seen: Observation): Promise<string | null> {
  const lines = [...new Set([...seen.texts, ...seen.elements.filter((el) => el.value && !el.secret).map((el) => `${el.name}: ${el.value}`)])].slice(0, 200);
  const labels = Object.fromEntries(lines.map((line, i) => [`t${i + 1}`, line]));
  const a = await ask({ request, window: seen.title }, { line: choice(ANSWER_WORDING, { ...labels, none: "No line here answers it." }) });
  return a.line.confidence >= 0.5 ? (labels[a.line.choice] ?? null) : null;
}

// ------------------------------------------------------------------ drive

let shared: Ask | undefined;
/** One client for every task: the first request on a cold connection costs about two seconds, a warm one a third of one. */
const jev = (): Ask => (shared ??= makeAsk());
/** Asked as the program starts, so the first real question finds the connection open. */
export const warm = (): void => void jev()({ text: "ready" }, { ready: noul("The text says ready.") }).catch(() => {});

const CARD: Record<DriveStatus, TaskStatus> = { done: "done", gave_up: "failed", out_of_steps: "failed", failed: "failed", denied: "stopped", cancelled: "stopped" };
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Outcome {
  by: DriveResult["by"];
  status: DriveStatus;
  reason: string;
  runs: RunResult[];
  wantsAnswer?: boolean;
  learning?: Promise<void>;
}

export async function drive(request: string, options: DriveOptions): Promise<DriveResult> {
  const { hand, feed, signal } = options;
  const [print, ask, llm] = [options.print ?? console.log, options.ask ?? jev(), options.llm ?? makeLlm()];
  const [run, today] = [options.runScreens ?? runScreens, options.today ?? (() => new Date())];
  const [words, started, opened] = [request.trim(), performance.now(), [] as string[]];
  let [seen, looks] = [undefined as Observation | undefined, 0];

  /** One line in the terminal and one event for the feed, which returns at once and is never waited for. */
  const report = (step: Pick<Step, "kind" | "label"> & Partial<Step>): void => {
    const window = hand.window();
    const whole: Step = { hand: hand.id, ...(window ? { hwnd: window.hwnd, frame: window.frame } : {}), ...step };
    try {
      print(stepLine(whole));
      void feed.step(whole);
    } catch {} // what watches a hand is never a reason for it to stop
  };

  const deps: PilotDeps = {
    ask,
    llm,
    contacts: options.contacts ?? (await loadContacts()),
    store: options.store ?? (await fileStore()),
    today,
    // What the loop says about a look that led to no action (a retry, a value that does not match, an action held back) is a step too: the narrator reads steps.
    log: (line) => {
      options.log?.(line);
      const note = /^look \d+: (.*)$/.exec(line)?.[1];
      if (note && !note.includes(" -> ")) report({ kind: "think", label: note });
    },
    sleep: options.sleep,
    drive: options.runScreens,
    observe: async () => (report({ kind: "look", label: `look ${++looks}` }), (seen = await hand.observe())),
    perform: (action) => hand.perform(action),
    open: (url, by) => (opened.push(url), report({ kind: "navigate", label: `open ${URL.parse(url)?.hostname ?? url}`, text: url, tier: by }), hand.open(url)),
    // While an app is the worked window the browser's page is not where a follow-up carries on from.
    here: async () => (hand.window() && !hand.window()!.page ? null : hand.here()),
    onScreen: () => hand.onScreen(),
    approve: (asked) => feed.approve(toApproval(asked, hand.id, seen?.title)),
    // The user's own words, as they said them. A goal a model wrote can never allow a consequence.
    authorization: () => words,
    onStep: (step) => report(toStep(step, hand, "screen", seen?.size)),
  };
  const pilot = createPilot(deps);

  /** The pilot has no word for an app, so its plan (plan.ts `app`) and its loop are put together here. */
  async function inApp(app: { name: string; onlyOpen: boolean }): Promise<Outcome> {
    opened.push(app.name);
    report({ kind: "open", label: `open ${app.name}`, text: app.name, tier: "app" });
    const planning = app.onlyOpen ? null : planTasks(llm, words, { today: today(), contacts: deps.contacts, app: app.name }).catch((error) => message(error));
    await hand.launch(app.name);
    if (!planning) return { by: "app", status: "done", reason: `${app.name} is open`, runs: [] };
    const planned: PlannedTask[] | string = await planning;
    if (typeof planned === "string") return { by: "app", status: "gave_up", reason: `${app.name} is open, and the rest could not be planned (${planned})`, runs: [] };
    const runs: RunResult[] = [];
    for (const task of planned) {
      if (signal?.aborted) break;
      report({ kind: "think", label: task.intent.goal, tier: "plan" });
      runs.push(await run(task.intent, deps, { signal }));
      if (runs.at(-1)!.status !== "done") break;
    }
    const last = runs.at(-1);
    return { by: "app", status: last?.status ?? "cancelled", reason: last?.reason ?? "the task was taken back", runs, wantsAnswer: planned.some((task) => task.wantsAnswer) };
  }

  async function work(): Promise<Outcome> {
    // One round of Jev: what the pilot asks, and which application, side by side.
    const [reading, app] = await Promise.all([pilot.read(words), nativeApp(ask, words).catch(() => null)]);
    if (signal?.aborted) return { by: null, status: "cancelled", reason: "the task was taken back", runs: [] };
    // A recipe knows its task whatever else the words suggest; quick.ts claims anything that mentions a site.
    if (app && (!reading || reading.by === "quick")) return inApp(app);
    let understood = reading;
    try {
      understood ??= await pilot.understand(words, null);
    } catch (error) {
      return { by: "plan", status: "gave_up", reason: error instanceof NotBrowserWork ? error.message : `there is no plan for it (${message(error)})`, runs: [] };
    }
    report({ kind: "think", label: understood.tasks[0]?.intent.goal ?? understood.detail, tier: understood.by });
    return pilot.run(words, { signal }, understood);
  }

  feed.task(hand.id, "running", words);
  report({ kind: "think", label: "reading the request" });
  const outcome = await work().catch((error): Outcome => ({ by: null, status: signal?.aborted ? "cancelled" : "failed", reason: message(error), runs: [] }));
  const { status, reason } = outcome;
  const result: DriveResult = { by: outcome.by, status, reason, card: CARD[status], handedOver: false, answer: null, learning: outcome.learning ?? Promise.resolve() };
  const took = `${looks} look${looks === 1 ? "" : "s"}, ${outcome.runs.reduce((n, r) => n + r.steps.length, 0)} actions, ${((performance.now() - started) / 1000).toFixed(1)} s`;

  if (status === "done") {
    print(`done by ${outcome.by}: ${took}`);
    if (outcome.wantsAnswer && seen) result.answer = await answerFrom(ask, words, seen).catch(() => null);
    if (result.answer) print(`answer: ${result.answer}`);
  } else if ((status === "gave_up" || status === "out_of_steps") && !signal?.aborted) {
    // Only what Jev was lost on goes further. What the user declined, or took back, is over (and never reaches here).
    const model = options.model ?? agentModel();
    const why = `Jev ${status === "gave_up" ? "gave up" : "ran out of looks"} after ${took}: ${reason}`;
    if (options.fallback && !jevOnly() && (await (options.piReady ?? piConfigured)(model))) {
      print(`${why}. Handing it to ${model}.`);
      report({ kind: "think", label: "handing over to the agent", tier: "pi" });
      result.handedOver = true;
      const finished = await options.fallback(handover(words, { reason, opened, steps: outcome.runs.flatMap((r) => r.steps) })).catch((error) => (print(`the agent failed: ${message(error)}`), false));
      result.card = finished ? "done" : signal?.aborted ? "stopped" : "failed";
    } else print(`${why}. ${jevOnly() ? "HANDS_DRIVER=jev keeps it from the fallback agent." : `The fallback agent (${model}) is not signed in: run \`pi\`, then /login, to enable it.`}`);
  } else print(`${CARD[status]}: ${reason}`);

  feed.task(hand.id, result.card, words);
  return result;
}
