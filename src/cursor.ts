/**
 * What a hand is doing, as something a preview can draw.
 *
 * A hand acts through channels that have no pointer: a UI Automation pattern, EM_REPLACESEL, keys posted to a
 * window, DevTools input, AXPress on the Mac. The preview of its window therefore shows a page changing by
 * itself. These events say who did what, and where, so the feed can draw a pointer for each hand over the
 * picture it shows (timeline.ts animates them, paint.ts draws them, feed.ts sends them to the screen).
 *
 * Everything is a share (0..1) of the frame, the window being worked, so one event is right for a 300 px tile
 * and a whole screen alike. An event is a note about an action already on its way, never a step of it:
 * nothing here waits.
 */

/** Things done to the window. `control`: operated with no pointer (a pattern, AXPress). `open`, `menu`, `navigate`: no place in the window at all. */
export const ACTION_KINDS = ["move", "click", "drag", "scroll", "type", "key", "control", "navigate", "open", "menu"] as const;
/** What the hand is doing when it is not touching anything. */
export const STATE_KINDS = ["think", "look", "wait", "blocked", "done", "error", "idle"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export type StateKind = (typeof STATE_KINDS)[number];
export type CursorKind = ActionKind | StateKind;

export interface XY {
  x: number;
  y: number;
}
/** x, y, w, h: each a share of the frame. */
export type Part = [number, number, number, number];
/** A frame's size in the pixels its coordinates are given in. */
export type FrameSize = [width: number, height: number];

export interface CursorEvent {
  /** Hand id, 1-based. */
  hand: number;
  kind: CursorKind;
  /** When the action was sent, ms since the epoch. Orders events; the feed animates on its own clock. */
  t: number;
  /** Where the pointer goes. Absent: it stays where it is. */
  x?: number;
  y?: number;
  /** The control the action is about, outlined for `type` and `control`, where the control matters more than a point. */
  rect?: Part;
  /** `drag`: the stroke, start first. `x`,`y` is its first point. */
  path?: XY[];
  /** `type`: the text (never a password). `key`: the chord. `scroll`: up or down. `navigate`: the address. `open`: the app. `menu`: the path. `control`: the value set, if any. */
  text?: string;
  /** `click` only. */
  button?: "left" | "right" | "middle";
  count?: number;
  /** One short literal line about the step: "click Search". */
  caption?: string;
  /** The frame the numbers are shares of; the feed letterboxes with it. */
  frame?: FrameSize;
}

export const MASK = "••••••";
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** One line, cut to length: a caption is read at a glance, and typed text is a hint, not a record. */
export function short(text: string, max = 48): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** A hand's identity colour. Past four they repeat. windows' feed.cs holds the same four for the tiles. */
export const HAND_COLORS = ["#7aa2f7", "#bb9af7", "#73daca", "#ff9e64"] as const;
export const handColor = (hand: number): string => HAND_COLORS[(Math.max(1, Math.trunc(hand) || 1) - 1) % HAND_COLORS.length]!;

/** A pixel of the frame as a share of it. A point outside is pulled to the edge: the pointer never leaves the picture. */
export function normalizePoint(x: number, y: number, [width, height]: FrameSize): XY | null {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: round4(clamp01(x / width)), y: round4(clamp01(y / height)) };
}

/** A pixel rectangle (x, y, w, h) as a Part, cut to the frame. Null when nothing of it is inside. */
export function normalizeRect([x, y, w, h]: [number, number, number, number], [width, height]: FrameSize): Part | null {
  if (!(width > 0) || !(height > 0) || ![x, y, w, h].every(Number.isFinite)) return null;
  const [left, top, right, bottom] = [clamp01(x / width), clamp01(y / height), clamp01((x + w) / width), clamp01((y + h) / height)];
  if (right <= left || bottom <= top) return null;
  return [round4(left), round4(top), round4(right - left), round4(bottom - top)];
}

/** The `x`, `y`, `rect` and `frame` of an event from what a driver has: a control's rectangle, a bare point, or neither. */
export function locate(frame: FrameSize, target: { rect?: [number, number, number, number]; point?: [number, number] } = {}): Pick<CursorEvent, "x" | "y" | "rect" | "frame"> {
  const size: FrameSize = [Math.round(frame[0]), Math.round(frame[1])];
  const rect = target.rect && normalizeRect(target.rect, frame);
  const [px, py] = target.point ?? (target.rect ? [target.rect[0] + target.rect[2] / 2, target.rect[1] + target.rect[3] / 2] : [NaN, NaN]);
  return { ...(normalizePoint(px, py, frame) ?? {}), ...(rect ? { rect } : {}), frame: size };
}

/** Is this a CursorEvent, as far as the feed needs to trust it? Anything else is dropped. */
export function isCursorEvent(value: unknown): value is CursorEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  const unit = (n: unknown) => typeof n === "number" && n >= 0 && n <= 1;
  if (!Number.isInteger(e.hand) || (e.hand as number) < 1 || typeof e.t !== "number") return false;
  if (!(ACTION_KINDS as readonly unknown[]).includes(e.kind) && !(STATE_KINDS as readonly unknown[]).includes(e.kind)) return false;
  if ((e.x === undefined) !== (e.y === undefined) || (e.x !== undefined && !(unit(e.x) && unit(e.y)))) return false;
  if (e.rect !== undefined && !(Array.isArray(e.rect) && e.rect.length === 4 && e.rect.every(unit))) return false;
  if (e.path !== undefined && !(Array.isArray(e.path) && e.path.every((p) => p && unit((p as XY).x) && unit((p as XY).y)))) return false;
  return true;
}
