/** Execute one decided action. Every function returns a one-line description for the history. */

import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { SITES } from "./config.ts";
import { type Decision, OFFSCREEN_PREFIX, verifyTyped } from "./decide.ts";
import { hand, quote } from "./hand.ts";
import { platform as macos } from "./platform.ts";
import { center, type Field, isText, type Item, type Point, repr, type Screen, toPoints } from "./models.ts";
import { composeText, composeUrl, type Writer } from "./writer.ts";

export const VERIFY_THRESHOLD = 0.5;
export const NOOP_MARKERS = ["refused", "failed", "waited"];

export interface Context {
  goal: string;
  browser: string;
  email: string | null;
  typesafe: TypeSafeClient;
  writer: Writer | null;
  history: string[];
}

type Handler = (decision: Decision, screen: Screen, items: Item[], ctx: Context) => string | Promise<string>;

export const isNoop = (description: string): boolean => NOOP_MARKERS.some((marker) => description.includes(marker));

export async function perform(decision: Decision, screen: Screen, items: Item[], ctx: Context): Promise<string> {
  const key = decision.chosen;
  const chosen = items.find((it) => String(it.index) === key);
  if (chosen) return clickItem(chosen, screen);
  if (key.startsWith(OFFSCREEN_PREFIX)) return pressOffscreen(key.slice(OFFSCREEN_PREFIX.length), screen);
  const handler = HANDLERS[key];
  if (!handler) throw new Error(`unknown action ${repr(key)}`);
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
 * Go to the browser, and open the website the site answer named.
 *
 * `none` is the page already open there, so bringing the browser forward is the whole action. A
 * catalog key is its URL, and `other` is a site outside the catalog, which only the writer can
 * name. Opening a URL activates the browser too, so the three cases differ only in the page.
 */
const useBrowser: Handler = async (decision, _screen, _items, ctx) => {
  const site = decision.site.choice;
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

const typeEmail: Handler = async (_decision, screen, _items, ctx) => {
  if (!(screen.field && isText(screen.field))) return "type_email refused: no text field is focused";
  return `typed email ${await fillField(screen.field, ctx.email ?? "")}`;
};

const typeTextAction: Handler = async (_decision, screen, items, ctx) => {
  if (!(screen.field && isText(screen.field))) return "type_text refused: no text field is focused";
  if (!ctx.writer) return "type_text refused: no writer available";
  const text = await composeText(ctx.writer, ctx.goal, screen, items, ctx.history);
  if (!text) return "type_text refused: writer declined to fill this field";
  const how = await fillField(screen.field, text);
  await Bun.sleep(300);
  const p = await verifyTyped(ctx.typesafe, ctx.goal, screen.field, text, macos.focusedField());
  if (p < VERIFY_THRESHOLD) {
    await macos.clearField();
    return `typed ${repr(text)} into ${repr(screen.field.label)} ${how} but verification failed (${p.toFixed(2)}); cleared it`;
  }
  return `typed ${repr(text)} into ${repr(screen.field.label)} ${how} (verified ${p.toFixed(2)})`;
};

const key = (name: string, description: string): Handler => async () => (void hand.cue("key", `press ${name}`), await macos.press(name), description);
const scroll = (lines: number, description: string): Handler => async () => (
  void hand.cue("scroll", description, undefined, { swipe: [0, Math.sign(lines)] }), await macos.scroll(lines), description
);

const HANDLERS: Record<string, Handler> = {
  use_browser: useBrowser,
  type_email: typeEmail,
  type_text: typeTextAction,
  press_enter: key("return", "pressed Return"),
  press_escape: key("escape", "pressed Escape"),
  scroll_down: scroll(-10, "scrolled down"),
  scroll_up: scroll(10, "scrolled up"),
  wait: () => "waited",
};
