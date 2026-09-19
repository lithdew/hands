/** The TypeSafe side: state, criteria, and the one multi-Choice request. */

import { type ChoiceResponse, choice, noul, type Questions, type TypeSafeClient } from "@typesafe-ai/sdk";
import { SITES } from "./config.ts";
import { dateHints, nowContext } from "./dates.ts";
import { type AxNode, type Field, fieldSummary, fromAx, type Item, region, repr, roleWord, type Screen } from "./models.ts";

export type ChoiceAnswer = ChoiceResponse;
export const STOP_KINDS = ["done", "none"];
export const OFFSCREEN_PREFIX = "offscreen:";
export const PRESS_OFFSCREEN =
  "Activate a labelled control that the app exposes but that is not currently visible on screen " +
  "(chosen in the offscreen question). Use when the needed control is known to exist but is " +
  "scrolled out of view or not yet shown.";

/** Deterministic actions offered alongside click_item. Keep them mutually exclusive. */
export function fixedActions(browser: string, email: string | null): Record<string, string> {
  const actions: Record<string, string> = {
    use_browser:
      `Work in ${browser}: bring it to the front, and open a website there if one is needed. The ` +
      "site question says which website, or says that the page already open there is the one to " +
      "continue with. This is the only way to reach a website: never click the address bar, a URL, " +
      "or a search box to get there. Works from any app, including this one.",
    type_text:
      "Type free text into the focused text field. A writing model composes the text from the " +
      "goal and the field's label. Only valid when a text field is focused and needs content.",
    press_enter: "Press Return to submit the focused form or field.",
    press_escape: "Press Escape to dismiss a dialog, menu, or popup.",
    scroll_down: "Scroll down to reveal more of the page.",
    scroll_up: "Scroll up.",
    wait: "Nothing to do yet; the screen is still loading or changing.",
    done: "The goal is already achieved.",
    none: "Nothing on screen or in this list helps with the goal.",
  };
  if (email) {
    actions.type_email =
      "Type the user's email address into the focused text field. Use this, not type_text, " +
      "whenever the field wants an email or username.";
  }
  return actions;
}

export function kindCriteria(browser: string, email: string | null, offscreen = false): Record<string, string> {
  return {
    click_item: "Click one of the on-screen text items (chosen in the item question).",
    ...(offscreen ? { press_offscreen: PRESS_OFFSCREEN } : {}),
    ...fixedActions(browser, email),
  };
}

/** Each item as one line. A role prefix marks the ones the app itself declared. */
export function itemCriteria(screen: Screen, items: Item[]): Record<string, string> {
  const hints = dateHints(items, screen);
  return Object.fromEntries(
    items.map((it) => [
      String(it.index),
      `${fromAx(it) && it.role ? `${it.role} ` : ""}${repr(it.text)} (${region(screen, it)}${hints.has(it.index) ? `; ${hints.get(it.index)}` : ""})`,
    ]),
  );
}

/** Each off-screen control as one line, keyed by its position in `screen.offscreen`. */
export const offscreenCriteria = (nodes: AxNode[]): Record<string, string> =>
  Object.fromEntries(nodes.map((node, i) => [String(i), `${roleWord(node)} ${repr(node.label)} (not visible)`]));

/** The same controls as state, with the key the offscreen question answers with. */
export const offscreenRecords = (nodes: AxNode[]) => nodes.map((node, i) => ({ k: i, role: roleWord(node), label: node.label }));

/** Which website use_browser opens. The catalog, plus one key for anything else and one for nothing. */
export const siteCriteria = (): Record<string, string> => ({
  ...SITES,
  other: "A website is needed to progress the goal, but it is not one of the sites named in this list.",
  none: "No website needs to be opened: the page already open in the browser is the one to continue with.",
});

export function baseState(goal: string, screen: Screen, items: Item[], history: string[]) {
  const hints = dateHints(items, screen);
  return {
    goal,
    now: nowContext(),
    frontmost_app: screen.app,
    browser_active_tab_url: screen.url,
    focused_field: screen.field ? fieldSummary(screen.field) : null,
    previous_actions: history.slice(-8),
    screen_items_in_reading_order: items.map((it) => ({
      i: it.index,
      text: it.text,
      where: region(screen, it),
      ...(it.role ? { role: it.role } : {}),
      ...(hints.has(it.index) ? { when: hints.get(it.index)! } : {}),
    })),
    ...(screen.offscreen.length ? { offscreen_controls: offscreenRecords(screen.offscreen) } : {}),
  };
}

export class Decision {
  constructor(
    readonly kind: ChoiceAnswer,
    readonly item: ChoiceAnswer | null,
    readonly site: ChoiceAnswer,
    readonly offscreen: ChoiceAnswer | null = null,
  ) {}

  get clicking(): boolean {
    return this.kind.choice === "click_item" && this.item !== null;
  }

  get pressingOffscreen(): boolean {
    return this.kind.choice === "press_offscreen" && this.offscreen !== null;
  }

  get chosen(): string {
    if (this.clicking) return this.item!.choice;
    if (this.pressingOffscreen) return `${OFFSCREEN_PREFIX}${this.offscreen!.choice}`;
    return this.kind.choice;
  }

  get confidence(): number {
    // Only the answers that name a target lower the confidence: a click or a press lands
    // somewhere, and the wrong somewhere is not undone. use_browser reads the site answer too,
    // but every outcome of it is a page the next step can leave, so a split there must not
    // stop the run.
    if (this.clicking) return Math.min(this.kind.confidence, this.item!.confidence);
    if (this.pressingOffscreen) return Math.min(this.kind.confidence, this.offscreen!.confidence);
    return this.kind.confidence;
  }

  get stops(): boolean {
    return STOP_KINDS.includes(this.kind.choice);
  }
}

export async function decide(
  client: TypeSafeClient,
  goal: string,
  screen: Screen,
  items: Item[],
  history: string[],
  browser: string,
  email: string | null,
): Promise<Decision> {
  const questions: Questions = {
    kind: choice(
      "You are driving this computer one action at a time. Which kind of action " +
        "makes the most progress toward the goal right now? Do not repeat an action " +
        "that was just taken unless the screen changed.",
      kindCriteria(browser, email, screen.offscreen.length > 0),
    ),
    site: choice(
      "If the browser is used this step, which website should it show? Name a site from the " +
        "list when the goal calls for that one, 'other' when the goal calls for a site the list " +
        "does not name, and 'none' to stay on the page that is already open in the browser.",
      siteCriteria(),
    ),
  };
  if (items.length) {
    questions.item = choice(
      "If clicking an on-screen item is the right move, which item? Items marked with a " +
        "role come from the app's accessibility tree and are real controls; plain items are " +
        "text read from the screen.",
      itemCriteria(screen, items),
    );
  }
  if (screen.offscreen.length) {
    questions.offscreen = choice(
      "If activating a control that is not on screen is the right move, which control? " +
        "These are real controls of the app, reachable without the mouse, but nothing on " +
        "the capture points at them.",
      offscreenCriteria(screen.offscreen),
    );
  }
  const { answers } = await client.systemOne({ state: baseState(goal, screen, items, history), questions });
  const answer = (name: string) => (answers[name] as ChoiceAnswer | undefined) ?? null;
  return new Decision(answer("kind")!, answer("item"), answer("site")!, answer("offscreen"));
}

/** Probability that the field now holds a sensible value for its purpose. */
export async function verifyTyped(client: TypeSafeClient, goal: string, fieldBefore: Field, typed: string, fieldAfter: Field | null): Promise<number> {
  const state = {
    goal,
    field: fieldSummary(fieldBefore),
    text_typed: typed,
    field_value_now: fieldAfter ? fieldAfter.value.slice(0, 300) : null,
    field_still_focused: Boolean(fieldAfter && fieldAfter.role === fieldBefore.role && fieldAfter.label === fieldBefore.label),
  };
  const ok = noul(
    "Did the typing succeed: does the field now contain the typed text, and is that " +
      "text a sensible value for what this field asks for, given the goal?",
  );
  return (await client.systemOne({ state, questions: { ok } })).answers.ok.noul;
}
