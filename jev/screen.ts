// screen.ts — one look, one request, a whole screen's worth of actions.
//
// cua.ts decides one action per look: on a compose window that is a look and two
// requests (decide, gate) each for the recipient, the subject, the body and Send.
// Jev answers any number of independent questions in the time of one, so this
// asks about the whole screen at once:
//
//   fill_e12   which prepared text belongs in THIS field?        one question per text field
//   set_e7     which option should THIS dropdown be set to?      one per native dropdown
//   next       once the fields are right, what gets clicked?     the button that moves on
//   differs_0  does the screen show another value than this fact? one per fact of the intent
//   right_e3   is what THIS control shows what the goal asks?     one per control that cannot be set directly
//   press_0    which control enters THIS key?                     one per key of `intent.presses` (a calculator entry)
//   ...and everything `decide` in cua.ts asks, for screens with nothing to fill
//
// Code assembles a batch (fills, then the click), gates every action of it in
// parallel (one round trip, and each action still has a gate request to itself),
// and performs them in order. The batch stops as soon as the screen grows or
// loses elements (contact suggestions, an error, a new page) and Jev looks again.
//
// Code, not Jev, skips a field that already holds the right text.
//
//   runScreens(hand, intent, deps, opts)   same contract as cua.ts `runIntent`

import { debugLog, type Hand } from "../desktop";
import { argumentsFor, describeAction, elementLabels, gateObservation, isLooping, jevState, KEYS, MOVES, type Action, type Deps, type RunOptions, type RunResult, type StepRecord } from "./cua";
import { assessRisk, blocksAction, isRisky, needsApproval, RISK_FLAGS, RISK_THRESHOLD, type Risk } from "./gate";
import { COMPOSE_LABEL, composeText, type Intent } from "./intent";
import { choice, noul, type Answers, type ChoiceResponse, type NoulResponse, type Questions } from "./jev";
import { describeElement, withVisionElements, type Observation, type UiElement } from "./observe";
import { choosePlanner, makePlan, type Plan } from "./planner";

// ---------------------------------------------------------------- types

/** `press`: this click is key number `press` of `intent.presses`. The loop counts them off, so none is entered twice. */
export type ScreenAction = (Action | { kind: "select"; target: UiElement; option: string }) & { press?: number };
export type ScreenDecision =
  /** `doubts`: facts of the intent that this screen shows differently. Nothing risky is performed over one. */
  | { kind: "act"; actions: ScreenAction[]; doubts?: string[] }
  | { kind: "done" }
  /** `retryObservation`: the screen is probably still settling; looking again is cheaper than a plan (as in cua.ts). */
  | { kind: "escalate"; reason: string; mustPlan: boolean; retryObservation?: boolean };
export type ScreenDeps = Omit<Deps, "perform"> & { perform: (hand: Hand, action: ScreenAction) => Promise<void> };
type Memory = { history: string[]; plan: Plan | null; /** How many of `intent.presses` have been entered. */ pressed?: number };

// ---------------------------------------------------------------- config

const MIN_CONFIDENCE = Number(process.env.PUK_MIN_CONFIDENCE ?? 0.45);
const FILL_CONFIDENCE = 0.5;
const STUCK_THRESHOLD = 0.7, STUCK_NEEDS_HISTORY = 3, DONE_THRESHOLD = 0.8, DONE_AGREED = 0.5;
/** Fields and dropdowns asked about per look. Each is one more question, not one more request. */
const MAX_FIELDS = 16;
const KEEP = "keep_as_is", NONE = "none_of_these", FOCUSED_FIELD = "focused_field";
// How the screen is shown to Jev, from ground.eval.ts (141 cases, 8 real pages of up to 704 elements): the elements once,
// in `state`, in reading order and with their ids, and bare ids as the labels to pick from: 98% right against 78% for
// descriptions repeated as criteria (a twin button is read next to its row instead of losing to the row's link).
/** Act on a pick at this confidence, else ask for help. Wrong clicks left: 1%. Right field picks often sit at 0.3 to 0.7. */
const CLICK_AT = 0.5, FIELD_AT = 0.3;
/** A Choice takes 255 labels. A longer page is several Choices in the same request; the list in `state` stays whole. */
const PER_CHOICE = 250;
/** Keys of a press sequence mapped per request, and how long a keypad gets between two of them. */
const MAX_PRESSES = 40, PRESS_SETTLE_MS = 40;
const CLICK_WORDING = "Which one element does the worker have to click now to carry out `goal`? The right element has the name, or sits in the container, that `goal` or the current step of `plan.steps` talks about. Choose none_of_these when it is not listed.";
const NONE_WORDING = "What `goal` needs is not in this list. An element that only has a similar name is not it.";

/** The most confident Choice that picked an element; none only when every part says none. */
function strongest(picks: ChoiceResponse[]): { choice: string; confidence: number } {
  const real = picks.filter((p) => p.choice !== NONE).sort((a, b) => b.confidence - a.confidence)[0];
  return real ?? { choice: NONE, confidence: Math.min(...picks.map((p) => p.confidence)) };
}
/** Things that are only on screen while something is open and waiting for an answer. */
const POPUP_ROLES = /^(option|menu ?item|listitem|gridcell)$/i, POPUP_CONTAINERS = /calendar|picker|suggestion|listbox|menu(?! ?bar)/i; // a menu bar is always there; it is not an open menu

const preview = (text: string, max = 80) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max)}...` : flat; };
const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

export function describeScreenAction(action: ScreenAction): string {
  if (action.kind !== "select") return describeAction(action as Action);
  return `set dropdown ${JSON.stringify(action.target.name)} to ${JSON.stringify(action.option)}`;
}

/** Which elements exist, ignoring what the fields hold. A batch is only valid while this stays the same. */
export function structureOf(obs: Observation): string {
  return obs.elements.map((el) => `${el.role}|${el.name}|${el.within}`).join("\n");
}

// ---------------------------------------------------------------- decide

export async function decideScreen(deps: Pick<Deps, "ask" | "llm">, hand: Hand, intent: Intent, obs: Observation, memory: Memory): Promise<ScreenDecision> {
  // A read-only page or a loading state can be understood from its text. No controls is not yet a reason for a vision plan.
  if (obs.elements.length === 0 && obs.texts.length === 0) return { kind: "escalate", reason: "nothing on screen is readable as text", mustPlan: true };
  const labels = elementLabels(obs.elements, hand), seen = jevState(intent, obs, memory, hand);
  const state = { ...seen, screen: { ...seen.screen, elements: obs.elements.map((el) => `${el.id}: ${labels[el.id]}`) } };
  const ids = (elements: UiElement[]) => Object.fromEntries(elements.map((el) => [el.id, null]));
  const parts = Array.from({ length: Math.ceil(obs.elements.length / PER_CHOICE) }, (_, i) => obs.elements.slice(i * PER_CHOICE, (i + 1) * PER_CHOICE));
  const typed = state.history.join("\n");
  const inputs = Object.fromEntries(Object.entries(intent.inputs).map(([name, value]) => [name, JSON.stringify(preview(value))]));
  const fields = obs.elements.filter((el) => el.editable).slice(0, MAX_FIELDS);
  const dropdowns = obs.elements.filter((el) => el.options?.length).slice(0, MAX_FIELDS);

  const perField: Questions = {};
  for (const el of fields) {
    perField[`fill_${el.id}`] = choice(`One text field on \`screen\` is: ${describeElement(el, hand)}. Which prepared text has to be in this one field for \`goal\`?`, {
      ...inputs,
      [KEEP]: "None. Leave this field as it is: what it holds is already right, or the field is optional, or it is a search box or field that `goal` does not need, or no prepared text is meant for it.",
      [COMPOSE_LABEL]: "None of the prepared texts, yet `goal` cannot be reached with this field empty: the text has to be written now, from what is on screen.",
    });
  }
  for (const el of dropdowns) {
    perField[`set_${el.id}`] = choice(`One dropdown on \`screen\` is ${JSON.stringify(el.name)}, now set to ${JSON.stringify(el.value || "nothing")}. Which value does \`goal\` ask for in this dropdown?`, {
      ...Object.fromEntries(el.options!.map((o) => [o, null])),
      [KEEP]: "Leave it as it is: `goal` says nothing about this dropdown, or it is optional.",
    });
  }

  // A control that shows a value but cannot be set directly (a custom date picker). Nobody
  // moves on from a form while one of these is wrong: Jev is asked about each, by name.
  const shown = obs.elements.filter((el) => !el.editable && !el.options?.length && el.value).slice(0, MAX_FIELDS);
  for (const el of shown) {
    perField[`right_${el.id}`] = noul(`The ${el.role} ${JSON.stringify(el.name)} on \`screen\` now shows ${JSON.stringify(el.value)}. That is what \`goal\` asks for there, or \`goal\` says nothing about it.`, {
      true: "It matches `goal`, or `goal` does not mention it.", false: "`goal` asks for a different value than the one shown." });
  }

  // A run of keys on a screen that stays the same (a calculator) is not six looks: every key still to be entered is
  // matched to its control in this one request, and the loop presses them one after another.
  const entered = memory.pressed ?? 0, keys = (intent.presses ?? []).slice(entered, entered + MAX_PRESSES);
  if (parts.length === 1) keys.forEach((key, i) => {
    perField[`press_${i}`] = choice(`The worker has to enter ${JSON.stringify(key)} now, as one key of a keypad or one button. Which one element is the key or button that enters ${JSON.stringify(key)}? Signs have names: "×" or "*" is multiply, "÷" or "/" is divide, "=" is equals.`, {
      ...ids(obs.elements.filter((el) => !el.editable)), [NONE]: `No listed element enters ${JSON.stringify(key)}.` });
  });

  // The values the task stands or falls with. Asked on every look, in the same request; used when something is about to be committed.
  const facts = (intent.facts ?? []).slice(0, 8);
  facts.forEach((fact, i) => {
    perField[`differs_${i}`] = noul(`The task needs this: ${JSON.stringify(fact)}. \`screen\` shows a DIFFERENT value for it.`, {
      true: "A control or a line of text on `screen` shows another value for the same thing (another date, another number of people, another person).",
      false: "`screen` shows the same value, written in any format, or does not show this thing at all." });
  });

  parts.forEach((part, i) => {
    perField[`target_${i}`] = choice(CLICK_WORDING, { ...ids(part), [NONE]: NONE_WORDING });
    perField[`next_${i}`] = choice("Suppose every text field and dropdown in `screen.elements` already holds the right value. Which one element does the worker click then, to move `goal` forward?", {
      ...ids(part), [NONE]: "Nothing. No click is needed after the fields, or the right element is not in this list." });
  });

  const fixed = {
    move: choice("What should the worker do next to make progress on `goal`? Follow `plan.steps` when there is a plan. `history` lists what was already done, oldest first.", MOVES),
    goal_met: noul("`screen` shows that `done_when` is already true."),
    stuck: noul("`history` shows the worker repeating an action or making no progress toward `goal`."),
    input: choice("If the worker types into a field next, which text belongs there?", {
      ...Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name, `${value}${typed.includes(`type ${name} `) ? " (already typed once)" : ""}`])),
      [COMPOSE_LABEL]: "None of the prepared inputs. The text has to be written now, based on what is on screen.",
    }),
    field: choice("Which one text field does the worker have to type into now to carry out `goal`? Choose none_of_these when no listed field is meant for it.", {
      ...ids(fields),
      [FOCUSED_FIELD]: "The field that already has keyboard focus. The cursor is already in the right place.",
      [NONE]: "What `goal` needs is not in this list, and no field has focus.",
    }),
    open_popup: noul("`screen` shows something the worker opened that waits for a pick before anything else can be done: an open dropdown list, a calendar or date picker, a list of suggestions, a menu."),
    submit: noul("Right after typing, Enter should be pressed, because this field is a search box, an address bar or a single line prompt that submits with Enter."),
    key: choice("If the worker presses a key next, which one?", KEYS),
    direction: choice("If the worker scrolls next to find what it needs, which way?", { down: "What is needed is further down the page or list.", up: "What is needed is further up the page or list." }),
  };
  // One request. The per-field questions are only known at run time, so their answers are read by name.
  const answers = await deps.ask(state, { ...fixed, ...perField });
  const a = answers as unknown as Answers<typeof fixed>, per = answers as unknown as Record<string, ChoiceResponse>;
  const nothing = { choice: NONE, confidence: 1 }; // a screen of text alone offers nothing to pick
  const target = parts.length ? strongest(parts.map((_, i) => per[`target_${i}`]!)) : nothing, next = parts.length ? strongest(parts.map((_, i) => per[`next_${i}`]!)) : nothing;
  const doubts = facts.filter((_, i) => (answers as unknown as Record<string, NoulResponse>)[`differs_${i}`]!.noul >= 0.6);
  const wrong = shown.filter((el) => (answers as unknown as Record<string, NoulResponse>)[`right_${el.id}`]!.noul < 0.5);

  const move = a.move.choice, goalMet = a.goal_met.noul;
  if (goalMet >= DONE_THRESHOLD || (move === "done" && goalMet >= DONE_AGREED)) return { kind: "done" };

  // An open list, calendar or menu wants an answer first: typing elsewhere would dismiss it.
  // Code knows the usual shapes; Jev is asked as well, for the ones code does not know.
  const popup = obs.elements.some((el) => POPUP_ROLES.test(el.role) || POPUP_CONTAINERS.test(el.within)) || a.open_popup.noul >= 0.7;

  // A wrong control is the next thing to fix, whatever else the screen offers.
  if (wrong.length && !popup) return { kind: "act", actions: [{ kind: "click", target: wrong[0]!, button: "left", count: 1 }], doubts };

  // The keys, if every one of them found its control. One that did not means this is not the keypad yet: decide as usual.
  if (keys.length && parts.length === 1 && !popup) {
    const picks = keys.map((_, i) => per[`press_${i}`]!), found = picks.map((pick) => obs.elements.find((el) => el.id === pick.choice));
    debugLog("jev.presses", keys.map((key, i) => `${key} -> ${found[i]?.name ?? picks[i]!.choice} (${picks[i]!.confidence.toFixed(2)})`));
    if (found.every(Boolean) && picks.every((pick) => pick.confidence >= CLICK_AT)) {
      return { kind: "act", doubts, actions: found.map((target, i) => ({ kind: "click", target: target!, button: "left", count: 1, press: entered + i })) };
    }
  }

  // What the fields need, from the per-field answers. Code drops what is already there.
  const batch: ScreenAction[] = [];
  for (const el of popup ? [] : fields) {
    const pick = per[`fill_${el.id}`]!;
    if (pick.choice === KEEP || pick.confidence < FILL_CONFIDENCE) continue;
    if (pick.choice === COMPOSE_LABEL) {
      if (el.value) continue;
      const text = await composeText(deps.llm, { intent, field: el.name || "the field", screenTexts: obs.texts });
      batch.push({ kind: "type", target: el, input: COMPOSE_LABEL, text, submit: false });
    } else {
      const text = intent.inputs[pick.choice];
      // Observers may cut a long value short, so the start of the text being there counts as there.
      const held = el.value.replace(/\s+/g, " ").trim().toLowerCase();
      if (text === undefined || same(el.value, text) || held.includes(preview(text, 40).toLowerCase().replace(/\.\.\.$/, ""))) continue;
      batch.push({ kind: "type", target: el, input: pick.choice, text, submit: false });
    }
  }
  for (const el of popup ? [] : dropdowns) {
    const pick = per[`set_${el.id}`]!;
    if (pick.choice === KEEP || pick.confidence < FILL_CONFIDENCE || same(pick.choice, el.value)) continue;
    batch.push({ kind: "select", target: el, option: pick.choice });
  }

  if (batch.length) {
    const only = batch.length === 1 && batch[0]!.kind === "type" ? batch[0]! : null;
    if (only && only.kind === "type" && a.submit.noul >= 0.5) return { kind: "act", actions: [{ ...only, submit: true }], doubts };
    const after = obs.elements.find((el) => el.id === next.choice);
    if (!wrong.length && after && !after.editable && next.confidence >= FILL_CONFIDENCE) batch.push({ kind: "click", target: after, button: "left", count: 1 });
    return { kind: "act", actions: batch, doubts };
  }

  // Nothing to fill: one action, decided the way cua.ts decides it.
  if (move === "done") return { kind: "escalate", reason: "the worker wants to stop but the screen does not show the goal as met", mustPlan: true };
  if (move === "ask_planner") return { kind: "escalate", reason: "the screen and history do not show what to do next", mustPlan: true };
  if (a.move.confidence < MIN_CONFIDENCE) return { kind: "escalate", reason: `unsure what to do next (leaning "${move}")`, mustPlan: false, retryObservation: move === "wait" };
  if ((memory.history.length >= STUCK_NEEDS_HISTORY && a.stuck.noul >= STUCK_THRESHOLD) || isLooping(memory.history)) return { kind: "escalate", reason: "repeating actions without progress", mustPlan: false };
  const action = await argumentsFor(move, deps, intent, obs, { ...a, target });
  if (!action) return { kind: "escalate", reason: `wants to ${move} but no listed element fits`, mustPlan: true };
  if (action.kind === "click" && target.confidence < CLICK_AT) return { kind: "escalate", reason: `unsure which element to click (leaning ${JSON.stringify(action.target.name)})`, mustPlan: false };
  if (action.kind === "type" && action.target && a.field.confidence < FIELD_AT) return { kind: "escalate", reason: `unsure which field to type into (leaning ${JSON.stringify(action.target.name)})`, mustPlan: false };
  return { kind: "act", actions: [action], doubts };
}

// ---------------------------------------------------------------- loop

/** Drive one hand until the intent is met, a screen at a time. Same options and result as cua.ts `runIntent`. */
export async function runScreens(hand: Hand, goal: Intent | (() => Intent), deps: ScreenDeps, opts: RunOptions = {}): Promise<RunResult> {
  const current = typeof goal === "function" ? goal : () => goal;
  const look = deps.observe!, sleep = deps.sleep ?? Bun.sleep, log = deps.log ?? (() => {});
  const maxSteps = opts.maxSteps ?? 30;
  let plansLeft = opts.maxPlans ?? 5;
  // A plan written before the first look (plan.ts) sits where a vision plan would: `move` follows `plan.steps`.
  const ahead = current().steps;
  const memory: Memory = { history: [], plan: ahead?.length ? { situation: "Planned before the first look, from the request alone.", steps: ahead, elements: [], blocked: null } : null };
  const steps: StepRecord[] = [];
  let planned: string | null = null, carried: Observation | null = null, heldBack = 0;
  let observationRetries = opts.maxObservationRetries ?? 1;
  let sighted: { fingerprint: string; elements: Plan["elements"] } | null = null;
  const end = (status: RunResult["status"], reason: string): RunResult => ({ status, reason, steps });

  for (let n = 1; n <= maxSteps; n++) {
    if (opts.signal?.aborted) return end("cancelled", "the task was taken back");
    const intent = current(), instructionAtDecision = JSON.stringify(intent);
    const authorizationAtDecision = deps.authorization?.();
    const instructionChanged = () => JSON.stringify(current()) !== instructionAtDecision || deps.authorization?.() !== authorizationAtDecision;
    let obs = carried ?? (await look(hand));
    carried = null;
    // What the planner saw stays in Jev's list for as long as the screen it saw is still there. Without this a plan
    // changes nothing Jev can pick from (marks.eval.ts: 1 of 20 right after a plan, 19 of 20 with its elements merged).
    if (sighted && sighted.fingerprint === obs.fingerprint) obs = withVisionElements(obs, sighted.elements, hand);

    const decision = await decideScreen(deps, hand, intent, obs, memory);
    if (opts.signal?.aborted) return end("cancelled", "the task was taken back");
    if (instructionChanged()) continue; // refined while Jev was deciding: decide again
    if (decision.kind === "done") return end("done", intent.doneWhen);

    if (decision.kind === "escalate") {
      // A transient screen can resolve without a screenshot or a plan. The budget is per run, so an animation cannot reset it for ever.
      if (decision.retryObservation && !decision.mustPlan && observationRetries > 0) {
        observationRetries--;
        log(`look ${n}: observing again before planning (${decision.reason})`);
        await sleep(deps.settleMs ?? 700);
        continue;
      }
      if (plansLeft <= 0 || planned === obs.fingerprint) {
        if (decision.mustPlan) return end("gave_up", decision.reason);
        memory.history.push(`hesitated: ${decision.reason} -> no visible change`);
        await sleep(deps.settleMs ?? 700);
        continue;
      }
      plansLeft--;
      const which = await choosePlanner(deps.ask, { ...jevState(intent, obs, memory, hand), stuck_because: decision.reason });
      log(`look ${n}: stuck (${decision.reason}); asking the ${which} planner`);
      const plan = await makePlan(deps.llm, which, hand, { intent, history: memory.history, knownElements: Object.values(elementLabels(obs.elements, hand)), reason: decision.reason, screenshotPng: await deps.screenshot!(hand) });
      if (plan.blocked) return end("gave_up", plan.blocked);
      memory.plan = plan; planned = obs.fingerprint;
      sighted = { fingerprint: obs.fingerprint, elements: plan.elements };
      memory.history.push(`asked the ${which} planner: ${preview(plan.situation, 160)}`);
      continue;
    }

    const speaking = opts.settles?.();
    if (speaking && decision.actions.some((action) => action.kind === "type")) { log(`look ${n}: holding until the speaker finishes`); await speaking; continue; }

    // Every action still gets a gate request of its own; they go out together.
    const described = decision.actions.map(describeScreenAction);
    const exact = decision.actions.map((action) => action.kind === "select" ? describeScreenAction(action) : describeAction(action, { fullText: true }));
    const latest = current();
    if (instructionChanged()) continue;
    const gateGoal = latest.goal, gateAvoid = [...latest.avoid];
    const authorization = opts.settles?.() ? undefined : authorizationAtDecision;
    const observation = gateObservation(obs);
    const risks: (Risk | null)[] = await Promise.all(decision.actions.map((action, i) => (action.kind === "wait" ? null : assessRisk(deps.ask, { goal: gateGoal, avoid: gateAvoid, action: exact[i]!, authorization, observation }))));
    if (opts.signal?.aborted) return end("cancelled", "the task was taken back");
    // A correction during the parallel gates also expires the approval prompts.
    if (instructionChanged()) continue;
    if (opts.dryRun) return end("dry_run", described.join("; "));

    const structure = structureOf(obs);
    let seen = obs;
    for (const [i, planned_] of decision.actions.entries()) {
      if (opts.signal?.aborted) return end("cancelled", "the task was taken back");
      if (instructionChanged()) break;
      // Ids are positions in the list, so they stay valid exactly as long as the structure does.
      if (i > 0 && structureOf(seen) !== structure) { log(`look ${n}: the screen changed shape after ${i} of ${decision.actions.length} actions; looking again`); break; }
      const target = "target" in planned_ && planned_.target ? seen.elements.find((el) => el.id === planned_.target!.id) ?? planned_.target : null;
      const action = (target ? { ...planned_, target } : planned_) as ScreenAction;
      const did = described[i]!;
      let risk = risks[i]!;
      // Initial batch gates saw the form before earlier inputs changed it.
      // Check a consequential commit against the actual resulting fields.
      if (i > 0 && risk && authorization && isRisky(risk, opts.riskThreshold?.())) {
        risk = await assessRisk(deps.ask, { goal: gateGoal, avoid: gateAvoid, action: exact[i]!, authorization: opts.settles?.() ? undefined : authorization, observation: gateObservation(seen) });
        if (opts.signal?.aborted) return end("cancelled", "the task was taken back");
        if (instructionChanged()) break;
      }
      if (risk && blocksAction(risk)) {
        // A consequential action, or one that contradicts the user, ends the run. A reversible step that Jev merely
        // judges off the goal (scrolling an article at off_goal 0.50 ended whole tasks) is held back instead, so the
        // next look picks a different move; three in a row still give up.
        const threshold = opts.riskThreshold?.() ?? RISK_THRESHOLD;
        const consequential = RISK_FLAGS.some((flag) => flag !== "off_goal" && risk!.flags[flag] >= threshold) || (risk.authorization?.contradictsUser ?? 0) >= 0.5;
        if (consequential || ++heldBack > 2) return end("denied", "This action conflicts with the current user instruction.");
        log(`look ${n}: not doing "${did}": Jev judged it off the goal (${risk.flags.off_goal.toFixed(2)})`);
        memory.history.push(`held back "${did}": judged off the goal -> choose a different next step`);
        steps.push({ n, did, risk: risk.level, outcome: "held back as off-goal" });
        break;
      }
      if (risk && needsApproval(risk, opts.riskThreshold?.())) {
        // Committing over a value the screen shows differently is how a table gets booked for the wrong day.
        if (decision.doubts?.length) {
          log(`look ${n}: not doing "${did}": the screen shows a different value than ${decision.doubts.join("; ")}`);
          memory.history.push(`held back "${did}": the screen shows a different value than ${decision.doubts.join("; ")} -> no visible change`);
          if (++heldBack > 2) return end("gave_up", `the screen keeps showing a different value than ${decision.doubts.join("; ")}`);
          break;
        }
        const speechEnds = opts.settles?.();
        if (speechEnds) { await speechEnds; break; }
        log(`look ${n}: paused for approval: ${did} (${risk.worst} ${risk.level.toFixed(2)})`);
        if (!(await deps.approve({ hand: hand.id, action: exact[i]!, risk }))) { steps.push({ n, did, risk: risk.level, outcome: "denied by the user" }); return end("denied", did); }
        if (opts.signal?.aborted) return end("cancelled", "the task was taken back");
        // The user approved what they were shown. If the screen or the request moved on while they decided, that approval is spent.
        const fresh = await look(hand);
        if (fresh.fingerprint !== seen.fingerprint || instructionChanged()) { carried = fresh; log(`look ${n}: approval expired because the screen or instruction changed`); break; }
      }
      if (opts.signal?.aborted) return end("cancelled", "the task was taken back");
      if (instructionChanged()) break;
      // A fresh speech hold can start during the gate, approval or its final look.
      // Wait for it, then decide and gate again instead of spending the old approval.
      const speechAtInput = action.kind === "type" || risk && isRisky(risk, opts.riskThreshold?.()) ? opts.settles?.() : null;
      if (speechAtInput) { log(`look ${n}: holding until the speaker finishes`); await speechAtInput; break; }
      await deps.perform(hand, action);
      if (action.press !== undefined) memory.pressed = action.press + 1;
      await sleep(action.press !== undefined ? PRESS_SETTLE_MS : deps.settleMs ?? 700);
      const after = await look(hand);
      const outcome = after.fingerprint === seen.fingerprint ? "no visible change" : "screen changed";
      memory.history.push(`${did} -> ${outcome}`);
      steps.push({ n, did, risk: risk?.level ?? null, outcome });
      log(`look ${n}: ${did} -> ${outcome}`);
      seen = carried = after;
    }
  }
  return end("out_of_steps", `not finished after ${maxSteps} looks`);
}
