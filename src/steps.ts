/**
 * What a driver tells the feed: one Step just before each action, and its states in between.
 *
 * This is the seam between whoever works the window (Jev's loop, the pi agent's tools) and everything the user
 * sees of it. A driver fills in what it has, in the pixels it already works in, and never waits on the result:
 * `feed.step(step)` returns at once, and a feed that is off, or broken, takes the same calls and does nothing.
 *
 * From one Step come the pointer's event (cursor.ts), the line the narrator reads, and the tile's strip.
 */

import { type CursorEvent, type CursorKind, type FrameSize, locate, MASK, normalizePoint, short, type XY } from "./cursor.ts";

export interface Step {
  /** Hand id, 1-based. */
  hand: number;
  /** What is about to be done (click, type, control, navigate, ...) or the state the hand is in (think, look, wait, done, ...). */
  kind: CursorKind;
  /** One short literal line: "click Search", "type the subject". */
  label: string;
  /** The window being worked, so the hand's tile can follow it. */
  hwnd?: number;
  /** That window's size, in the pixels `rect`, `point` and `path` are given in. */
  frame?: FrameSize;
  /** The control, as x, y, w, h from the window's top left. */
  rect?: [number, number, number, number];
  /** A bare point, when there is no control to name. */
  point?: [number, number];
  /** `drag`: the stroke, start first. */
  path?: [number, number][];
  /** `type`: the text. `key`: the chord. `scroll`: up or down. `navigate`: the address. `open`: the app. `menu`: the path. */
  text?: string;
  /** The text goes into a password field, or is one: it is never shown and never read to the narrator. */
  secret?: boolean;
  button?: "left" | "right" | "middle";
  count?: number;
  /** Who decided it: recipe, learned, quick, plan, screen, pi. */
  tier?: string;
}

const shown = (step: Step): string | undefined => (step.text === undefined ? undefined : step.secret ? MASK : short(step.text, 80));
/** The label as it may be shown: a driver that quotes what it types in its label has the secret masked there too. */
export const stepLabel = (step: Step): string => (step.secret && step.text ? step.label.split(step.text).join(MASK) : step.label);

/** The pointer's event for a step. `frame` is the last size known for the hand, for a step that carries none. */
export function toCursorEvent(step: Step, frame?: FrameSize, now = Date.now()): CursorEvent {
  const size = step.frame ?? frame;
  const event: CursorEvent = { hand: step.hand, kind: step.kind, t: now, caption: short(stepLabel(step)) };
  if (size) Object.assign(event, locate(size, { rect: step.rect, point: step.point ?? step.path?.[0] }));
  if (size && step.path) {
    const path = step.path.map(([x, y]) => normalizePoint(x, y, size)).filter((p): p is XY => p !== null);
    if (path.length >= 2) event.path = path;
  }
  const text = shown(step);
  if (text !== undefined) event.text = text;
  if (step.button) event.button = step.button;
  if (step.count) event.count = step.count;
  return event;
}

/** The step as the narrator reads it, and as the terminal prints it. What was typed is quoted, and masked when secret. */
export function stepLine(step: Step): string {
  const text = shown(step);
  const label = stepLabel(step);
  const said = text === undefined || label.includes(text) ? label : `${label}: ${JSON.stringify(text)}`;
  return step.tier ? `[${step.tier}] ${said}` : said;
}
