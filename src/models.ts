/** Data carried between perception, decision, and action. */

export const TEXT_ROLES = new Set(["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]);
export type Box = [number, number, number, number]; // x1, y1, x2, y2 in capture pixels
export type Frame = [number, number, number, number]; // x, y, w, h in screen points
export type Point = [number, number];

// Accessibility roles as one human word. Anything unlisted is "other".
export const ROLE_WORDS: Record<string, string> = {
  AXButton: "button",
  AXCell: "cell",
  AXCheckBox: "checkbox",
  AXComboBox: "field",
  AXDockItem: "dock item",
  AXImage: "image",
  AXLink: "link",
  AXMenuBarItem: "menu",
  AXMenuButton: "button",
  AXPopUpButton: "popup",
  AXRadioButton: "radio",
  AXRow: "cell",
  AXSearchField: "field",
  AXSlider: "slider",
  AXTab: "tab",
  AXTextArea: "field",
  AXTextField: "field",
};

/** Raised when the user triggers an escape hatch. */
export class Abort extends Error {}

/**
 * One clickable thing: text plus its pixel box on the capture.
 *
 * `source` says where it came from: "ocr" for a merged text block, "ax" for an
 * accessibility control, "ax+ocr" when the two agree on the same thing. `role` is a
 * short human word (button, link, field, ...) and is empty for OCR-only items.
 */
export interface Item {
  index: number;
  text: string;
  ocrConfidence: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  role: string;
  source: "ocr" | "ax" | "ax+ocr";
  value?: string; // what a field holds now, when its control says (never a password's)
}

export const item =(index: number, text: string, ocrConfidence: number, box: Box, role = "", source: Item["source"] = "ocr"): Item => ({
  index,
  text,
  ocrConfidence,
  x1: box[0],
  y1: box[1],
  x2: box[2],
  y2: box[3],
  role,
  source,
});

export const center = (it: Item): Point => [(it.x1 + it.x2) / 2, (it.y1 + it.y2) / 2];
export const fromAx = (it: Item): boolean => it.source !== "ocr";

/**
 * One actionable accessibility element, in screen points.
 *
 * `ref` is the element itself, the handle an action is sent to. It is opaque here.
 */
export interface AxNode {
  role: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  pressable: boolean;
  ref?: unknown;
  value?: string; // a field's current text, when the platform reads it (never a password's)
}

export const roleWord = (node: AxNode): string => ROLE_WORDS[node.role] ?? "other";

/**
 * The focused accessibility element, in screen points.
 *
 * `ref` is the element itself, so text can be set on it directly instead of typed.
 */
export interface Field {
  role: string;
  label: string;
  placeholder: string;
  value: string;
  x: number;
  y: number;
  w: number;
  h: number;
  ref?: unknown;
}

export const isText = (f: Field): boolean => TEXT_ROLES.has(f.role);

/** Everything but the opaque element handle, which no log can serialize. */
export const fieldRecord = ({ ref: _ref, ...rest }: Field) => rest;

export const fieldSummary = (f: Field) => ({
  role: f.role,
  label: f.label,
  placeholder: f.placeholder,
  current_value: f.value.slice(0, 200),
});

/** A capture on disk. Pixels are only decoded by whoever needs them (Vision, sharp). */
export interface Capture {
  path: string;
  width: number;
  height: number;
  stale?: boolean; // the picture may be older than the window: a covered Chromium window keeps its last visible frame (measured)
}

/** Everything captured about one display at one instant. */
export interface Screen {
  image: Capture;
  scale: number; // capture pixels per screen point
  app: string;
  field: Field | null;
  url: string | null;
  pid: number | null; // frontmost process, for the accessibility walk; null in replay
  window: Frame | null; // frontmost window, x/y/w/h in global points; null in replay
  origin: Point; // the capture's top-left in global points: a display's, [0, 0] on the main one, or a window's
  windowId?: number; // set when the capture is of one window alone, which may sit behind others
  axRefs: Map<number, unknown>; // item index -> accessibility element, when it has one
  offscreen: AxNode[]; // labelled controls the app exposes but does not show
  // What the listing's header says about the window beyond its app and size:
  dialog?: string | null; // the title of a dialog the window has open, which is what was captured
  theirs?: boolean; // the window is the user's own, not one the hand opened
  tabs?: { count: number; active: string }; // a browser window of the hand's own: its tabs, which stand in for its tab strip and toolbar
  readOnly?: boolean; // the user's screen, captured to be read and never acted on
}

export const sizePt = (s: Screen): Point => [s.image.width / s.scale, s.image.height / s.scale];

export function region(s: Screen, it: Item): string {
  const [cx, cy] = center(it);
  const col = ["left", "center", "right"][Math.min(2, Math.floor((3 * cx) / s.image.width))];
  const row = ["top", "middle", "bottom"][Math.min(2, Math.floor((3 * cy) / s.image.height))];
  return `${row}-${col}`;
}

/** An item's center in global screen points, which is what synthetic input takes. */
export function toPoints(s: Screen, it: Item): Point {
  const [cx, cy] = center(it);
  return [s.origin[0] + cx / s.scale, s.origin[1] + cy / s.scale];
}

// What Python's str.isprintable() rejects: controls, format characters, unassigned, surrogates, and every separator but the space.
const UNPRINTABLE = /[\p{C}\p{Z}]/u;

/** Python's repr() for a string, because the criteria the classifier was tuned on quote labels that way. */
export function repr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const hex = (digits: number) => code.toString(16).padStart(digits, "0");
    if (ch === "\\" || ch === quote) out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === " " || !UNPRINTABLE.test(ch)) out += ch;
    else out += code <= 0xff ? `\\x${hex(2)}` : code <= 0xffff ? `\\u${hex(4)}` : `\\U${hex(8)}`;
  }
  return quote + out + quote;
}
