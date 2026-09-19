// cua.ts — the computer-use loop. Jev drives a hand until the intent is met.
//
//   what the user said
//     -> intent.ts   small LLM, once: goal, inputs to type, done_when
//     -> this loop, per step:
//          observe.ts   the screen as labelled text (accessibility tree, no model)
//          Jev          move and speculative arguments in one request
//          gate.ts      Jev again: is this one risky? if so, wait for the user
//          desktop.ts   click / type / key / scroll inside the hand
//     -> planner.ts  only when stuck: a vision model Jev picks looks at the
//                    screenshot and hands back a plan, then Jev carries on
//
// Jev never produces a coordinate or a string. It picks a move from MOVES, an
// element from the labels on screen, an input from the intent, a key from
// KEYS. `decide` assembles those picks into an Action, so an Action that
// clicks nowhere or types text nobody wrote cannot be built.
//
// CLI: bun jev/cua.ts run <id> [--steps=N] <what the user said...>
//      bun jev/cua.ts next <id> <what the user said...>     decide one step, do nothing
//
// Requires: a running hand (bun desktop.ts up 1), TYPESAFE_API_KEY, OPENAI_API_KEY

import {
  click,
  defaultExec,
  getHand,
  launch,
  launchBrowser,
  pressKey,
  screenshot,
  scroll,
  typeText,
  type Exec,
  type Hand,
  type MouseButton,
} from "../desktop";
import { assessRisk, needsApproval, terminalApprove, type Approve, type Risk } from "./gate";
import { COMPOSE_LABEL, composeText, parseIntent, type Intent } from "./intent";
import { choice, createJev, noul, type Ask } from "./jev";
import { centerOf, describeElement, observe, withVisionElements, type Observation, type UiElement } from "./observe";
import { createOpenAI, type Llm } from "./openai";
import { choosePlanner, makePlan, type Plan } from "./planner";

// ---------------------------------------------------------------- types

export type Action =
  | { kind: "click"; target: UiElement; button: MouseButton; count: 1 | 2 }
  | { kind: "type"; target: UiElement | null; input: string; text: string; submit: boolean }
  | { kind: "key"; combo: keyof typeof KEYS }
  | { kind: "scroll"; direction: "up" | "down" }
  | { kind: "wait" };

/** What one look at the screen led to. */
export type Decision =
  | { kind: "act"; action: Action }
  | { kind: "done" }
  | { kind: "escalate"; reason: string; mustPlan: boolean; retryObservation?: boolean };

export type StepRecord = { n: number; did: string; risk: number | null; outcome: string };

export type RunResult = {
  status: "done" | "gave_up" | "denied" | "out_of_steps" | "dry_run" | "cancelled";
  reason: string;
  steps: StepRecord[];
};

export type Deps = {
  ask: Ask;
  llm: Llm;
  approve: Approve;
  /** Decision-contract seam for controlled evals; production uses decide. */
  decide?: typeof decide;
  observe?: (hand: Hand) => Promise<Observation>;
  /** Other desktops (win/) bring their own input and capture. Default: desktop.ts, through `exec`. */
  perform?: (hand: Hand, action: Action) => Promise<void>;
  screenshot?: (hand: Hand) => Promise<Uint8Array>;
  /** How long a screen gets to react before it is read again. Default SETTLE_MS. */
  settleMs?: number;
  exec?: Exec;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

export type RunOptions = {
  maxSteps?: number;
  maxPlans?: number;
  dryRun?: boolean;
  /** Stops the run before its next action. listen.ts uses it when the speaker takes a task back. */
  signal?: AbortSignal;
  /**
   * For runs that start before the speaker has finished. While it returns a
   * promise, the intent may still change. The hand may open, click and scroll,
   * but it does not type (the words are the part still arriving) and does not
   * perform or offer for approval anything the gate flags. The loop waits for
   * the promise, then decides again against what was finally said.
   */
  settles?: () => Promise<void> | null;
  /** Risk level that counts as risky. Lower it while the intent is still partial. */
  riskThreshold?: () => number;
  /** At most this many passive reobservations before planning an uncertain wait. */
  maxObservationRetries?: number;
};

type Memory = { history: string[]; plan: Plan | null };

// ---------------------------------------------------------------- config

/** Below this confidence in the next move, Jev gets a second opinion. */
const MIN_CONFIDENCE = Number(process.env.PUK_MIN_CONFIDENCE ?? 0.45);
const STUCK_THRESHOLD = 0.7;
/** Jev's `stuck` only counts once there is this much history. Real Jev said 0.57 on a run that had not started. */
const STUCK_NEEDS_HISTORY = 3;
/** `goal_met` alone ends the run at this level; with the "done" move, DONE_AGREED is enough. */
const DONE_THRESHOLD = 0.8;
const DONE_AGREED = 0.5;
const SETTLE_MS = 700;
const WAIT_MS = 1500;
/** How long a freshly launched app gets before the first look at the screen. */
export const APP_START_MS = 2500;
const SCROLL_NOTCHES = 5;
const HISTORY_SHOWN = 10;

/** Every move a hand can make. Jev's answer is one of these keys, by type. */
export const MOVES = {
  click: "Left click one element: press a button, follow a link, put the cursor in a field, pick a menu item or a tab.",
  double_click: "Double click one element: open a file or folder in a list.",
  right_click: "Open the context menu of one element.",
  type: "Type text into a text field, using one of `inputs` or newly written text.",
  key: "Press a key or shortcut: Enter to submit, Escape to close, Tab to move on, a browser shortcut.",
  scroll: "Scroll, because what is needed is probably above or below what is visible.",
  wait: "Do nothing for a moment, because the screen is still loading.",
  done: "Stop, because `done_when` is already true on this screen.",
  ask_planner: "Ask a vision model to look at the screen, because `screen` and `history` do not show what to do next.",
} as const;

/** Every key a hand can press. Combos are in desktop.ts `pressKey` syntax. */
export const KEYS = {
  Return: "Enter: submit the focused form, confirm the default button, run a search.",
  Tab: "Move focus to the next field.",
  "shift+Tab": "Move focus to the previous field.",
  Escape: "Close a dialog, menu or popup. Cancel.",
  BackSpace: "Delete the character before the cursor.",
  space: "Toggle the focused checkbox or press the focused button.",
  Down: "Move down in a list or menu.",
  Up: "Move up in a list or menu.",
  pagedown: "Scroll one page down with the keyboard.",
  pageup: "Scroll one page up with the keyboard.",
  "ctrl+a": "Select everything in the focused field.",
  "ctrl+l": "Browser: focus the address bar.",
  "ctrl+t": "Browser: open a new tab.",
  "ctrl+w": "Close the current tab.",
  "ctrl+f": "Find text on the page.",
  "ctrl+s": "Save.",
  "ctrl+z": "Undo the last edit.",
  "alt+Left": "Browser: go back one page.",
  F5: "Reload the page.",
} as const;

/**
 * Most toolkits build their accessibility tree only when told someone is
 * reading it. Apps a hand starts get these, so observe.ts has something to read.
 */
export const A11Y_ENV = {
  ACCESSIBILITY_ENABLED: "1", // Chromium, Electron
  QT_ACCESSIBILITY: "1",
  QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1",
  GNOME_ACCESSIBILITY: "1", // Firefox, LibreOffice
};

const NONE = "none_of_these";
const FOCUSED_FIELD = "focused_field";

// ---------------------------------------------------------------- state for Jev

function preview(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** Label -> description for a Choice over elements. Twins are told apart by order. Exported for tests. */
export function elementLabels(elements: UiElement[], hand: Hand): Record<string, string> {
  const described = elements.map((el) => describeElement(el, hand));
  const total = new Map<string, number>();
  for (const d of described) total.set(d, (total.get(d) ?? 0) + 1);
  const nth = new Map<string, number>();
  const labels: Record<string, string> = {};
  elements.forEach((el, i) => {
    const d = described[i]!;
    const n = total.get(d)!;
    if (n === 1) return void (labels[el.id] = d);
    const k = nth.get(d) ?? 0;
    nth.set(d, k + 1);
    labels[el.id] = `${d}, the ${ORDINALS[k] ?? `number ${k + 1}`} of ${n} like it from the top`;
  });
  return labels;
}

/** Everything Jev knows when it decides. Exported for tests. */
export function jevState(intent: Intent, obs: Observation, memory: Memory, hand: Hand) {
  return {
    goal: intent.goal,
    done_when: intent.doneWhen,
    avoid: intent.avoid,
    inputs: Object.fromEntries(Object.entries(intent.inputs).map(([k, v]) => [k, preview(v)])),
    plan: memory.plan ? { situation: memory.plan.situation, steps: memory.plan.steps } : null,
    history: memory.history.slice(-HISTORY_SHOWN),
    screen: {
      windows: obs.frames,
      elements: Object.values(elementLabels(obs.elements, hand)),
      text: obs.texts,
    },
  };
}

/** One line for the history, the gate and the approval prompt. */
export function describeAction(action: Action): string {
  const on = (el: UiElement) =>
    `${el.role} ${JSON.stringify(el.name || "(no name)")}${el.within && el.within !== el.name ? ` in ${JSON.stringify(el.within)}` : ""}${el.frame ? ` in window ${JSON.stringify(el.frame)}` : ""}`;
  switch (action.kind) {
    case "click": {
      const how = action.count === 2 ? "double click" : action.button === "right" ? "right click" : "click";
      return `${how} ${on(action.target)}`;
    }
    case "type": {
      const where = action.target ? on(action.target) : "the focused field";
      return `type ${action.input} (${JSON.stringify(preview(action.text, 60))}) into ${where}${action.submit ? ", then press Enter" : ""}`;
    }
    case "key":
      return `press ${action.combo} (${KEYS[action.combo]})`;
    case "scroll":
      return `scroll ${action.direction}`;
    case "wait":
      return "wait for the screen to settle";
  }
}

// ---------------------------------------------------------------- decide

/**
 * One look at the screen, one Jev request for the move and its speculative
 * arguments. Each question is evaluated independently against the same state.
 */
export async function decide(
  deps: Pick<Deps, "ask" | "llm">,
  hand: Hand,
  intent: Intent,
  obs: Observation,
  memory: Memory,
): Promise<Decision> {
  // Read-only pages and loading states can be understood from visible text.
  // Missing controls alone is not evidence that a vision planner is needed.
  if (obs.elements.length === 0 && obs.texts.length === 0) {
    return { kind: "escalate", reason: "nothing on screen is readable as text", mustPlan: true };
  }
  const state = jevState(intent, obs, memory, hand);

  // One request. Jev answers independent questions together, so what the move would
  // need (which element, which text, which key) is asked alongside the move instead
  // of in a second round trip once the move is known. Each is phrased to stand alone.
  const typed = state.history.join("\n");
  const first = await deps.ask(state, {
    move: choice(
      "What should the worker do next to make progress on `goal`? Follow `plan.steps` when there is a plan. `history` lists what was already done, oldest first.",
      MOVES,
    ),
    goal_met: noul("`screen` shows that `done_when` is already true."),
    stuck: noul("`history` shows the worker repeating an action or making no progress toward `goal`."),
    target: choice("If the worker clicks one element next to make progress on `goal`, which one?", {
      ...elementLabels(obs.elements, hand),
      [NONE]: "No listed element is the right thing to click.",
    }),
    input: choice("If the worker types into a field next, which text belongs there?", {
      ...Object.fromEntries(
        Object.entries(intent.inputs).map(([name, value]) => [
          name,
          `${JSON.stringify(preview(value))}${typed.includes(`type ${name} `) ? " (already typed once)" : ""}`,
        ]),
      ),
      [COMPOSE_LABEL]: "None of the prepared inputs. The text has to be written now, based on what is on screen.",
    }),
    field: choice("If the worker types into a field next, which field?", {
      ...elementLabels(obs.elements.filter((el) => el.editable), hand),
      [FOCUSED_FIELD]: "The field that already has keyboard focus. The cursor is already in the right place.",
      [NONE]: "No listed field is right, and no field has focus.",
    }),
    submit: noul(
      "Right after typing, Enter should be pressed, because this field is a search box, an address bar or a single line prompt that submits with Enter.",
    ),
    key: choice("If the worker presses a key next, which one?", KEYS),
    direction: choice("If the worker scrolls next to find what it needs, which way?", {
      down: "What is needed is further down the page or list.",
      up: "What is needed is further up the page or list.",
    }),
  });
  const move = first.move.choice;
  const goalMet = first.goal_met.noul;

  if (goalMet >= DONE_THRESHOLD || (move === "done" && goalMet >= DONE_AGREED)) return { kind: "done" };
  if (move === "done") {
    return { kind: "escalate", reason: "the worker wants to stop but the screen does not show the goal as met", mustPlan: true };
  }
  if (move === "ask_planner") return { kind: "escalate", reason: "the screen and history do not show what to do next", mustPlan: true };
  if (first.move.confidence < MIN_CONFIDENCE) {
    return { kind: "escalate", reason: `unsure what to do next (leaning "${move}")`, mustPlan: false, retryObservation: move === "wait" };
  }
  const saysStuck = memory.history.length >= STUCK_NEEDS_HISTORY && first.stuck.noul >= STUCK_THRESHOLD;
  if (saysStuck || isLooping(memory.history)) {
    return { kind: "escalate", reason: "repeating actions without progress", mustPlan: false };
  }

  const action = await argumentsFor(move, deps, intent, obs, first);
  if (!action) return { kind: "escalate", reason: `wants to ${move} but no listed element fits`, mustPlan: true };
  return { kind: "act", action };
}

/** Same action three times in a row and the screen never changed. */
export function isLooping(history: string[]): boolean {
  const last = history.slice(-3);
  return last.length === 3 && last.every((h) => h === last[0] && h.endsWith("no visible change"));
}

/** The action for `move`, from answers `decide` already has. Only newly written text costs another call. */
async function argumentsFor(
  move: Exclude<keyof typeof MOVES, "done" | "ask_planner">,
  deps: Pick<Deps, "ask" | "llm">,
  intent: Intent,
  obs: Observation,
  a: {
    target: { choice: string };
    input: { choice: string };
    field: { choice: string };
    submit: { noul: number };
    key: { choice: keyof typeof KEYS };
    direction: { choice: "up" | "down" };
  },
): Promise<Action | null> {
  const byId = new Map(obs.elements.map((el) => [el.id, el]));

  switch (move) {
    case "click":
    case "double_click":
    case "right_click": {
      const target = byId.get(a.target.choice);
      if (!target) return null;
      return { kind: "click", target, button: move === "right_click" ? "right" : "left", count: move === "double_click" ? 2 : 1 };
    }

    case "type": {
      if (a.field.choice === NONE) return null;
      const target = byId.get(a.field.choice) ?? null;
      const input = a.input.choice;
      const text =
        input === COMPOSE_LABEL
          ? await composeText(deps.llm, { intent, field: target?.name || "the focused field", screenTexts: obs.texts })
          : intent.inputs[input]!;
      return { kind: "type", target, input, text, submit: a.submit.noul >= 0.5 };
    }

    case "key":
      return { kind: "key", combo: a.key.choice };

    case "scroll":
      return { kind: "scroll", direction: a.direction.choice };

    case "wait":
      return { kind: "wait" };

    default:
      return move satisfies never; // a new entry in MOVES does not compile until it is handled here
  }
}

// ---------------------------------------------------------------- act

export async function perform(hand: Hand, action: Action, deps: Pick<Deps, "exec" | "sleep">): Promise<void> {
  const exec = deps.exec ?? defaultExec;
  const sleep = deps.sleep ?? Bun.sleep;
  switch (action.kind) {
    case "click": {
      const c = centerOf(action.target.rect);
      return click(hand, c.x, c.y, { button: action.button, count: action.count }, exec);
    }
    case "type": {
      if (action.target) {
        const c = centerOf(action.target.rect);
        await click(hand, c.x, c.y, {}, exec);
        await sleep(150);
      }
      await typeText(hand, action.text, exec);
      if (action.submit) await pressKey(hand, "Return", exec);
      return;
    }
    case "key":
      return pressKey(hand, action.combo, exec);
    case "scroll": {
      const dy = action.direction === "down" ? SCROLL_NOTCHES : -SCROLL_NOTCHES;
      return scroll(hand, hand.width / 2, hand.height / 2, dy, 0, exec);
    }
    case "wait":
      return sleep(WAIT_MS);
  }
}

/** Open what the intent starts from. The launcher is a closed set; no command comes from a model. */
export async function openFor(hand: Hand, intent: Intent): Promise<void> {
  switch (intent.launcher) {
    case "browser":
      // launchBrowser takes no env of its own, but builds the app's env from ours.
      Object.assign(process.env, A11Y_ENV);
      await launchBrowser(hand, intent.url ?? "about:blank");
      return;
    case "terminal":
      launch(hand, [Bun.which("foot") ? "foot" : "alacritty"], A11Y_ENV);
      return;
    case "files": {
      const bin = ["nautilus", "thunar", "dolphin", "nemo"].find((b) => Bun.which(b));
      if (!bin) throw new Error("no file manager found (looked for nautilus, thunar, dolphin, nemo)");
      launch(hand, [bin], A11Y_ENV);
      return;
    }
    case "none":
      return;
  }
}

// ---------------------------------------------------------------- loop

/**
 * Drive one hand until the intent is met. Holds no shared state, so hands run
 * concurrently. `goal` may be a function: it is read again at every step, so an
 * intent that is refined while the hand works takes effect on the next step.
 */
export async function runIntent(
  hand: Hand,
  goal: Intent | (() => Intent),
  deps: Deps,
  opts: RunOptions = {},
): Promise<RunResult> {
  const current = typeof goal === "function" ? goal : () => goal;
  const look = deps.observe ?? ((h: Hand) => observe(h, deps.exec));
  const sleep = deps.sleep ?? Bun.sleep;
  const log = deps.log ?? (() => {});
  const maxSteps = opts.maxSteps ?? 30;
  let plansLeft = opts.maxPlans ?? 5;
  let observationRetries = opts.maxObservationRetries ?? 1;

  const memory: Memory = { history: [], plan: null };
  const steps: StepRecord[] = [];
  let seen: { fingerprint: string; elements: Plan["elements"] } | null = null;
  let carried: Observation | null = null;
  const end = (status: RunResult["status"], reason: string): RunResult => ({ status, reason, steps });

  for (let n = 1; n <= maxSteps; n++) {
    if (opts.signal?.aborted) return end("cancelled", "the task was taken back");
    const intent = current();
    const instructionAtDecision = JSON.stringify(intent);
    // The look that judged the last action is also the look for this one.
    let obs = carried ?? (await look(hand));
    carried = null;
    // What the planner saw stays usable only while the screen it saw is still there.
    if (seen && seen.fingerprint === obs.fingerprint) obs = withVisionElements(obs, seen.elements, hand);

    const decision = await (deps.decide ?? decide)(deps, hand, intent, obs, memory);
    if (decision.kind === "done") return end("done", intent.doneWhen);

    if (decision.kind === "escalate") {
      // A transient screen can resolve without a screenshot or a model plan.
      // The budget is per run, so changing animations cannot reset it forever.
      if (decision.retryObservation && !decision.mustPlan && observationRetries > 0) {
        if (opts.signal?.aborted) return end("cancelled", "the task was taken back");
        observationRetries--;
        log(`step ${n}: observing again before planning (${decision.reason})`);
        await sleep(SETTLE_MS);
        continue;
      }
      const alreadyPlannedHere = seen?.fingerprint === obs.fingerprint;
      if (plansLeft <= 0 || alreadyPlannedHere) {
        if (decision.mustPlan) return end("gave_up", decision.reason);
        // Unsure, but not blind: the next look may differ, so let the step budget decide.
        memory.history.push(`hesitated: ${decision.reason} -> no visible change`);
        await sleep(SETTLE_MS);
        continue;
      }
      plansLeft--;
      const which = await choosePlanner(deps.ask, { ...jevState(intent, obs, memory, hand), stuck_because: decision.reason });
      log(`step ${n}: stuck (${decision.reason}); asking the ${which} planner`);
      const plan = await makePlan(deps.llm, which, hand, {
        intent,
        history: memory.history,
        knownElements: Object.values(elementLabels(obs.elements, hand)),
        reason: decision.reason,
        screenshotPng: await (deps.screenshot ? deps.screenshot(hand) : screenshot(hand, {}, deps.exec ?? defaultExec)),
      });
      if (plan.blocked) return end("gave_up", plan.blocked);
      memory.plan = plan;
      seen = { fingerprint: obs.fingerprint, elements: plan.elements };
      memory.history.push(`asked the ${which} planner: ${preview(plan.situation, 160)}`);
      continue;
    }

    const did = describeAction(decision.action);
    if (opts.dryRun) return end("dry_run", did);

    const typesEarly = decision.action.kind === "type" ? opts.settles?.() : null;
    if (typesEarly) {
      log(`step ${n}: holding until the speaker finishes: ${did}`);
      await typesEarly;
      continue;
    }

    let risk: Risk | null = null;
    if (decision.action.kind !== "wait") {
      risk = await assessRisk(deps.ask, { goal: intent.goal, avoid: intent.avoid, action: did });
      if (needsApproval(risk, opts.riskThreshold?.())) {
        const speechEnds = opts.settles?.();
        if (speechEnds) {
          log(`step ${n}: holding until the speaker finishes: ${did} (${risk.worst} ${risk.level.toFixed(2)})`);
          await speechEnds;
          continue; // decide again, against what was finally said
        }
        log(`step ${n}: paused for approval: ${did} (${risk.worst} ${risk.level.toFixed(2)})`);
        if (!(await deps.approve({ hand: hand.id, action: did, risk }))) {
          steps.push({ n, did, risk: risk.level, outcome: "denied by the user" });
          return end("denied", did);
        }
        if (opts.signal?.aborted) return end("cancelled", "the task was taken back");
        const fresh = await look(hand);
        if (fresh.fingerprint !== obs.fingerprint || JSON.stringify(current()) !== instructionAtDecision) {
          carried = fresh;
          log(`step ${n}: approval expired because the screen or instruction changed`);
          continue;
        }
      }
    }

    if (opts.signal?.aborted) return end("cancelled", "the task was taken back"); // it may have come during the gate
    if (JSON.stringify(current()) !== instructionAtDecision) continue;
    await (deps.perform ? deps.perform(hand, decision.action) : perform(hand, decision.action, deps));
    await sleep(deps.settleMs ?? SETTLE_MS);
    const after = await look(hand);
    carried = after;
    const outcome = after.fingerprint === obs.fingerprint ? "no visible change" : "screen changed";
    memory.history.push(`${did} -> ${outcome}`);
    steps.push({ n, did, risk: risk?.level ?? null, outcome });
    log(`step ${n}: ${did} -> ${outcome}`);
  }
  return end("out_of_steps", `not finished after ${maxSteps} steps`);
}

// ---------------------------------------------------------------- CLI

async function main(argv: string[]) {
  const [cmd, idStr, ...rest] = argv;
  if (cmd !== "run" && cmd !== "next") {
    console.log(
      [
        "usage: bun jev/cua.ts <command>",
        "  run <id> [--steps=N] <what the user said...>   drive hand <id> until the task is done",
        "  next <id> <what the user said...>              show the next action Jev would take; do nothing",
      ].join("\n"),
    );
    return;
  }
  const hand = Number.isInteger(Number(idStr)) ? await getHand(Number(idStr)) : null;
  if (!hand) throw new Error(`no running hand with id "${idStr}". Try: bun desktop.ts up 1`);
  const maxSteps = Number(rest.find((a) => a.startsWith("--steps="))?.slice(8) ?? 30);
  const said = rest.filter((a) => !a.startsWith("--")).join(" ");

  const llm = createOpenAI();
  const deps: Deps = { ask: createJev(), llm, approve: terminalApprove, log: console.log };

  const intent = await parseIntent(llm, said);
  console.log(JSON.stringify(intent, null, 2));
  if (cmd === "run") {
    await openFor(hand, intent);
    if (intent.launcher !== "none") await Bun.sleep(APP_START_MS);
  }
  const result = await runIntent(hand, intent, deps, { maxSteps, dryRun: cmd === "next" });
  console.log(`${result.status}: ${result.reason}`);
  if (result.status !== "done" && result.status !== "dry_run") process.exit(2);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
