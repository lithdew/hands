/** Execute one decided action. Every function returns a one-line description for the history. */

import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { SITES, SUBMIT_AT, WAIT_S } from "./config.ts";
import { chosenField, type Decision, OFFSCREEN_PREFIX } from "./decide.ts";
import { hand, quote } from "./hand.ts";
import { platform as macos } from "./platform.ts";
import { center, type Field, type Item, type Point, repr, type Screen, toPoints } from "./models.ts";
import { composeText, composeUrl, type Writer } from "./writer.ts";

export const NOOP_MARKERS = ["refused", "failed"];

export interface Context {
  goal: string;
  browser: string;
  email: string | null;
  typesafe: TypeSafeClient;
  writer: Writer | null;
  history: string[];
  /** How the actions reach the machine. Unset, they go through the seat, on the user's own screen (`bun clicker`); a hand sets it to its own window, worked from behind (src/tools.ts). */
  drive?: Drive;
  /** The text to type, as the hand gave it: typed as it is, and no writer is asked. */
  text?: string | null;
}

/**
 * The loop's actions on one window from behind, as a hand works its own: nothing moves the user's pointer or takes
 * their keyboard. Each returns the line for the history, where "refused" or "failed" marks one that did nothing.
 */
export interface Drive {
  /** Press an item, or click it with a pointer addressed to the window alone. */
  click(it: Item, screen: Screen): Promise<string>;
  /** Press a control the app exposes but does not show, by its key in `screen.offscreen`. */
  offscreen(key: string, screen: Screen): Promise<string>;
  /** Put text in a field: its value when it takes one, else keys posted to the window. Returns which way ran, as fillField does. */
  fill(field: Field, text: string): Promise<string>;
  /** The field as it is now, for checking what was typed; null when that cannot be read. */
  reread(field: Field): Field | null;
  /** Return or Escape, posted to the window. */
  key(name: "return" | "escape"): Promise<void>;
  /** A page of the window up (positive) or down. */
  scroll(lines: number): Promise<void>;
}

type Handler = (decision: Decision, screen: Screen, items: Item[], ctx: Context) => string | Promise<string>;

export const isNoop = (description: string): boolean => NOOP_MARKERS.some((marker) => description.includes(marker));

/** Text compared the way a field keeps it: any run of white space as one space, ends trimmed, case aside. */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
const brief = (text: string, limit = 80): string => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** Do what the decision says. A kind with nothing to act on is refused, as a line the loop reads as a no-op: never an exception. */
export async function perform(decision: Decision, screen: Screen, items: Item[], ctx: Context): Promise<string> {
  const key = decision.chosen;
  const chosen = items.find((it) => String(it.index) === key);
  if (chosen) return ctx.drive ? ctx.drive.click(chosen, screen) : clickItem(chosen, screen);
  if (key.startsWith(OFFSCREEN_PREFIX)) {
    const control = key.slice(OFFSCREEN_PREFIX.length);
    return ctx.drive ? ctx.drive.offscreen(control, screen) : pressOffscreen(control, screen);
  }
  const handler = HANDLERS[key];
  if (!handler) return `${key} refused: it names nothing on this screen`;
  return handler(decision, screen, items, ctx);
}

/**
 * Press an item the app declared through the accessibility tree; click the pixel under it otherwise.
 *
 * A press goes to the control itself, so it lands even when the center of the box is covered by
 * a sticky header, a cookie banner, or a tooltip. An element that refuses still has a location.
 */
export async function clickItem(it: Item, screen: Screen): Promise<string> {
  await hand.cue("press", `click ${quote(it.text)}`, center(it).map((v) => v / screen.scale) as Point);
  const ref = screen.axRefs.get(it.index);
  if (ref !== undefined && macos.axPress(ref)) return `pressed ${repr(it.text)} via accessibility`;
  await macos.clickAt(toPoints(screen, it));
  if (ref === undefined) return `clicked ${repr(it.text)}`;
  return `clicked ${repr(it.text)} (accessibility press did not take)`;
}

/**
 * Press a control the app exposes but does not show.
 *
 * AXPress does not need the element to be visible: a note row scrolled thousands of points down
 * and a link the browser parked above the viewport both take it. There is no pixel to fall back
 * on, so a refusal is the end of it and reads as a no-op.
 */
export function pressOffscreen(key: string, screen: Screen): string {
  const node = /^\d+$/.test(key) ? screen.offscreen[Number(key)] : undefined;
  if (!node) return `press_offscreen refused: there is no off-screen control ${repr(key)}`;
  void hand.cue("press", `press ${quote(node.label)}`);
  if (macos.axPress(node.ref)) return `pressed ${repr(node.label)} (off-screen control) via accessibility`;
  return `press_offscreen refused: ${repr(node.label)} did not accept the press`;
}

/**
 * Put text in the focused field, by value if the element accepts one and keystrokes otherwise.
 *
 * Setting the value is one message instead of one per character, and it cannot be stolen by a
 * page that moves the focus mid-word. It is also widely ignored, so the value is read back and
 * only a field that really holds the text counts. Returns which path ran, for the history.
 */
export async function fillField(field: Field, text: string): Promise<string> {
  void hand.cue("write", `typing ${quote(text)}`);
  if (field.ref !== undefined) {
    macos.axFocus(field.ref);
    if (macos.axSetValue(field.ref, text) && macos.axValue(field.ref)?.endsWith(text)) return "via accessibility";
  }
  await macos.typeText(text);
  return "via keystrokes";
}

/**
 * Go to the browser, and open the website the site answer named (`bun clicker` only: a hand opens pages itself).
 *
 * `none` is the page already open there, so bringing the browser forward is the whole action. A
 * catalog key is its URL, and `other` is a site outside the catalog, which only the writer can
 * name. Opening a URL activates the browser too, so the three cases differ only in the page.
 */
const useBrowser: Handler = async (decision, _screen, _items, ctx) => {
  const site = decision.site?.choice ?? "none";
  if (site === "none") {
    if (await macos.activate(ctx.browser)) return `activated ${ctx.browser}`;
    return `use_browser failed: ${ctx.browser} did not come to the front`;
  }
  let url = SITES[site];
  if (url === undefined) {
    if (!ctx.writer) return "use_browser refused: the site is outside the catalog and no writer is available to propose a URL";
    url = await composeUrl(ctx.writer, ctx.goal, ctx.history);
  }
  if (!url) return "use_browser refused: the writer proposed no usable URL for this goal";
  void hand.cue("go", `open ${url.replace(/^https?:\/\//, "")}`);
  if (await macos.openUrl(ctx.browser, url)) return `opened ${url}`;
  return `use_browser failed: opened ${url} but ${ctx.browser} did not come to the front`;
};

/**
 * Type into the field the field question chose, then press Return when the submit answer says so. The text is the
 * hand's own when it gave one, the user's email for type_email, and else the writer's. What the field holds afterwards
 * is checked here, in code: a field that reads back without the text is a failure, and nothing is submitted.
 */
const typeInto =
  (email: boolean): Handler =>
  async (decision, screen, items, ctx) => {
    const kind = email ? "type_email" : "type_text";
    const field = chosenField(decision, screen, items);
    if (!field) return `${kind} refused: no field was chosen`;
    let text = email ? (ctx.email ?? "") : (ctx.text ?? "");
    if (!email && !text) {
      if (!ctx.writer) return "type_text refused: no text was given, and no writer is available to write it";
      text = await composeText(ctx.writer, ctx.goal, { ...screen, field }, items, ctx.history);
      if (!text) return `type_text refused: the writer declined to fill ${repr(field.label)}`;
    }
    if (!text) return `${kind} refused: there is nothing to type`;
    // A field with no element behind it is clicked first, so the keys land in it and not wherever the window's cursor was.
    const it = items.find((candidate) => String(candidate.index) === decision.field?.choice);
    if (field.ref === undefined && it && ctx.drive) {
      const clicked = await ctx.drive.click(it, screen);
      if (isNoop(clicked)) return `${kind} failed: ${clicked}`;
    }
    const how = ctx.drive ? await ctx.drive.fill(field, text) : await fillField(field, text);
    if (how.includes("failed")) return `${kind} failed: ${repr(field.label)} ${how}`;
    const shown = email ? "the email address" : repr(text);
    const now = ctx.drive ? ctx.drive.reread(field) : macos.focusedField();
    if (now && !flat(now.value).includes(flat(text))) return `${kind} failed: typed ${shown} into ${repr(field.label)} ${how}, but it holds ${repr(brief(now.value))}`;
    const typed = `typed ${shown} into ${repr(field.label)} ${how}`;
    if ((decision.extra.submit ?? 0) < SUBMIT_AT) return typed;
    void hand.cue("key", "press return");
    await (ctx.drive ? ctx.drive.key("return") : macos.press("return"));
    return `${typed}, and pressed Return`;
  };

const key =
  (name: "return" | "escape", description: string): Handler =>
  async (_decision, _screen, _items, ctx) => {
    void hand.cue("key", `press ${name}`);
    await (ctx.drive ? ctx.drive.key(name) : macos.press(name));
    return description;
  };
const scroll =
  (lines: number, description: string): Handler =>
  async (_decision, _screen, _items, ctx) => {
    void hand.cue("scroll", description, undefined, { swipe: [0, Math.sign(lines)] });
    await (ctx.drive ? ctx.drive.scroll(lines) : macos.scroll(lines));
    return description;
  };
/** A page still loading: the wait is real, since a hand's next look only settles after an action of its own. */
const wait: Handler = async () => {
  void hand.cue("wait", `waiting ${WAIT_S}s`);
  await macos.sleepWatching(WAIT_S);
  return `waited ${WAIT_S}s`;
};

const HANDLERS: Record<string, Handler> = {
  use_browser: useBrowser,
  type_email: typeInto(true),
  type_text: typeInto(false),
  press_enter: key("return", "pressed Return"),
  press_escape: key("escape", "pressed Escape"),
  scroll_down: scroll(-10, "scrolled down"),
  scroll_up: scroll(10, "scrolled up"),
  wait,
  // A kind whose target question said none_of_these (the run stops before this, as unsure).
  click_item: () => "click_item refused: no item was chosen",
  press_offscreen: () => "press_offscreen refused: no control was chosen",
};
