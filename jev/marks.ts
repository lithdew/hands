// marks.ts — handles for what Jev has no words for, made on our side while the vision planner is being asked.
//
// When Jev is stuck it asks a vision model (planner.ts). Until now that model had to GUESS pixel rectangles for the
// controls it saw, and what it saw never reached Jev's list. Both are backwards: we own the pixels and the geometry,
// the model owns the meaning. So the split here is Set-of-Mark:
//
//   decompose(obs, png, hand, deps)   no model. Every region Jev lacks words for gets a number and an EXACT rectangle:
//                                       unnamed   controls the observer knows but cannot name (icon buttons): DOM/UIA rectangles
//                                       text      OCR phrases where the tree cannot see: canvas, iframe, a native app with no tree
//                                       region    flat-coloured boxes in those same places (swatches, drawn buttons); a phrase
//                                                 inside one names it and takes its rectangle
//                                       cell      a grid A1..H6, only where nothing else gives a handle; the planner refines a
//                                                 cell once by saying where in it ("top left"), so no second look is needed
//                                     known elements keep their own id as their number, so a step can cite a twin exactly.
//                                     The numbers are drawn on the screenshot (tiny PNG codec + 5x7 font, no dependency).
//   makeMarkedPlan (planner.ts)       the model answers in references: steps cite marks, unnamed marks get a caption
//                                     {mark, name, role, container, editable}, and it says which text/region/cell marks are controls.
//   applyMarks(obs, marks, plan)      captioned marks join Jev's list as source "vision", in reading order, with the
//                                     container, behind rectangles we measured. ground.eval.ts ranked what Jev misses most:
//                                     a caption for every textless control, then the row or container, then whether it is a field.
//   createMarkMemory / learn / recall captions are kept. DOM-backed ones come back on every later look for free (the DOM says
//                                     the control is still there); pixel-backed ones only against a fresh screenshot whose
//                                     pixels still match; identical icons share one caption through a pixel signature.
//   offerReadable(obs, marks)         before any model: OCR text in a blind spot already has words, so it can join Jev's list at once.
//   snapPlan(plan, marks)             for a caller that sends the clean screenshot at once and decomposes while the model
//                                     thinks: the model's guessed rectangles are replaced by the marks they fall on.
//
// Nothing here acts, and nothing here reads a captcha: a bot check is `blocked`, the user's to answer.

import { deflateSync, inflateSync } from "node:zlib";
import type { Observation, Rect, UiElement } from "./observe";

// ---------------------------------------------------------------- types

export type Screen = { width: number; height: number };
export type Bitmap = { width: number; height: number; /** RGBA, row by row. */ data: Uint8Array };

/** A control the observer found but has no words for. `after`: how many named elements precede it in the observer's order. */
export type Unnamed = { role: string; rect: Rect; within?: string; row?: string; after?: number; editable?: boolean };
/** A rectangle the observer cannot see into: a canvas, an iframe, an embed, a video. */
export type Opaque = { kind: string; name?: string; rect: Rect };
/** An Observation with what win/observe.ts should pass along. Both are optional: without them only an empty tree is decomposed. */
export type Markable = Observation & { unnamed?: Unnamed[]; opaque?: Opaque[] };

export type OcrWord = { t: string; x: number; y: number; w: number; h: number };
export type OcrLine = { text: string; words: OcrWord[] };
/** win/ocr.ts on Windows. Absent elsewhere: then there are no text marks, only unnamed controls, regions and cells. */
export type Ocr = (png: Uint8Array) => Promise<OcrLine[]>;

export type MarkKind = "known" | "unnamed" | "text" | "region" | "cell";
export type Mark = {
  /** What is drawn and what the planner cites: "17", or "C4" for a cell. */
  label: string;
  /** What Jev picks: a known element keeps its id ("e7"); a new mark is "m17" / "mC4". */
  id: string;
  kind: MarkKind;
  rect: Rect;
  role: string;
  /** Known: its name. Text: the words OCR read. Otherwise empty until someone captions it (or memory already has). */
  name: string;
  within: string;
  editable: boolean;
  /** Position among the named elements, when the observer gave one. */
  after?: number;
  /** Which `obs.unnamed` entry this is. What lets a caption be recalled without pixels. */
  unnamedIndex?: number;
  /** Pixel signature. Identical icons share it, and so share a caption. */
  sig?: string;
  /** Marks that look the same as this one; the planner is asked about the first of a group only. */
  sameAs?: string;
  /** The name came from memory, not from the screen: the planner need not caption it again. */
  learned?: boolean;
};

export type Marks = {
  marks: Mark[];
  /** The screenshot with every mark drawn on it; the clean one when it could not be decoded. */
  image: Uint8Array;
  clean: Uint8Array;
  drawn: boolean;
  screen: Screen;
  timings: { decodeMs: number; ocrMs: number; regionsMs: number; drawMs: number; encodeMs: number; totalMs: number };
};

export const SUBCELLS = ["top left", "top", "top right", "left", "center", "right", "bottom left", "bottom", "bottom right"] as const;
export type Subcell = (typeof SUBCELLS)[number];
/** What the planner says about one mark. */
export type Caption = { mark: string; name: string; role: string; container: string; editable: boolean; at: Subcell | null };

// ---------------------------------------------------------------- config

const GRID = { cols: 8, rows: 6 };
const MAX_NEW = 60, MAX_KNOWN_DRAWN = 60;
/** A flat region is a candidate control between these sizes; larger is a panel or the drawing itself. */
const REGION = { min: 14, max: 360, fill: 0.55, aspect: 12 };
const PALETTE: [number, number, number][] = [[230, 25, 75], [0, 130, 60], [67, 99, 216], [200, 90, 0], [145, 30, 180], [0, 128, 128], [154, 99, 36], [128, 0, 0], [0, 0, 117], [200, 0, 160]];
const FONT: Record<string, string> = {
  "0": "01110100011000110001100011000101110", "1": "00100011000010000100001000010001110", "2": "01110100010000100010001000100011111", "3": "11111000100010000010000011000101110",
  "4": "00010001100101010010111110001000010", "5": "11111100001111000001000011000101110", "6": "00110010001000011110100011000101110", "7": "11111000010001000100010000100001000",
  "8": "01110100011000101110100011000101110", "9": "01110100011000101111000010001001100", A: "01110100011000111111100011000110001", B: "11110100011000111110100011000111110",
  C: "01110100011000010000100001000101110", D: "11100100101000110001100011001011100", E: "11111100001000011110100001000011111", F: "11111100001000011110100001000010000",
  G: "01110100011000010111100011000101111", H: "10001100011000111111100011000110001",
};

// ---------------------------------------------------------------- geometry and words

const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const inside = (p: { x: number; y: number }, r: Rect) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
export const iou = (a: Rect, b: Rect) => { const o = overlap(a, b); return o ? o / (area(a) + area(b) - o) : 0; };
const round = (r: Rect): Rect => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)) });
const clip = (r: Rect, s: Screen): Rect => { const x = Math.max(0, r.x), y = Math.max(0, r.y); return { x, y, w: Math.min(s.width, r.x + r.w) - x, h: Math.min(s.height, r.y + r.h) - y }; };
const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Share of the shorter text's words found in the other: "Find a table" against "find a table now" is 1. */
export function similarity(a: string, b: string): number {
  const x = words(a), y = new Set(words(b));
  if (!x.length || !y.size) return 0;
  return x.filter((w) => y.has(w)).length / Math.min(x.length, y.size);
}
/** Reading order with a tolerance: things on one line read left to right even when their tops differ by a few pixels. */
function reads(a: Rect, b: Rect): number {
  const ca = centre(a), cb = centre(b), sameLine = Math.abs(ca.y - cb.y) < Math.max(8, Math.min(a.h, b.h) / 2);
  return sameLine ? ca.x - cb.x : ca.y - cb.y;
}

// ---------------------------------------------------------------- PNG in, PNG out

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** 8 bit, non-interlaced PNGs of any colour type: what Chrome, .NET and grim write. Throws on anything else. */
export function decodePng(png: Uint8Array): Bitmap {
  if (SIGNATURE.some((byte, i) => png[i] !== byte)) throw new Error("not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength), idat: Uint8Array[] = [];
  let width = 0, height = 0, type = -1, palette: Uint8Array | null = null, alpha: Uint8Array | null = null;
  for (let at = 8; at + 12 <= png.length;) {
    const length = view.getUint32(at), name = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!), body = png.subarray(at + 8, at + 8 + length);
    if (name === "IHDR") {
      width = view.getUint32(at + 8); height = view.getUint32(at + 12); type = body[9]!;
      if (body[8] !== 8 || body[12] !== 0 || !(type in CHANNELS)) throw new Error(`PNG kind not handled (depth ${body[8]}, colour type ${type}, interlace ${body[12]})`);
    } else if (name === "PLTE") palette = body; else if (name === "tRNS") alpha = body; else if (name === "IDAT") idat.push(body); else if (name === "IEND") break;
    at += 12 + length;
  }
  const bpp = CHANNELS[type]!, stride = width * bpp, raw = inflateSync(idat.length === 1 ? idat[0]! : Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error("PNG data is short");
  const data = new Uint8Array(width * height * 4), line = new Uint8Array(stride), above = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!, from = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0, b = above[i]!, c = i >= bpp ? above[i - bpp]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = a; else if (filter === 2) predicted = b; else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = (raw[from + i]! + predicted) & 255;
    }
    for (let x = 0, o = y * width * 4; x < width; x++, o += 4) {
      const i = x * bpp;
      if (type === 2 || type === 6) { data[o] = line[i]!; data[o + 1] = line[i + 1]!; data[o + 2] = line[i + 2]!; data[o + 3] = type === 6 ? line[i + 3]! : 255; }
      else if (type === 3) { const p = line[i]! * 3; data[o] = palette?.[p] ?? 0; data[o + 1] = palette?.[p + 1] ?? 0; data[o + 2] = palette?.[p + 2] ?? 0; data[o + 3] = alpha?.[line[i]!] ?? 255; }
      else { data[o] = data[o + 1] = data[o + 2] = line[i]!; data[o + 3] = type === 4 ? line[i + 1]! : 255; }
    }
    above.set(line);
  }
  return { width, height, data };
}

/** RGB, every row filtered against the one above (screens are mostly vertical repetition), fast deflate. */
export function encodePng(bitmap: Bitmap): Uint8Array {
  const { width, height, data } = bitmap, stride = width * 3, raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const to = y * (stride + 1);
    raw[to] = 2;
    for (let x = 0; x < width; x++) for (let ch = 0; ch < 3; ch++) raw[to + 1 + x * 3 + ch] = (data[(y * width + x) * 4 + ch]! - (y ? data[((y - 1) * width + x) * 4 + ch]! : 0)) & 255;
  }
  const chunk = (name: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length), view = new DataView(out.buffer);
    view.setUint32(0, body.length); for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i); out.set(body, 8);
    view.setUint32(8 + body.length, Number(Bun.hash.crc32(out.subarray(4, 8 + body.length))));
    return out;
  };
  const header = new Uint8Array(13), hv = new DataView(header.buffer);
  hv.setUint32(0, width); hv.setUint32(4, height); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Uint8Array.from(SIGNATURE), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 3 })), chunk("IEND", new Uint8Array(0))]);
}

// ---------------------------------------------------------------- drawing

type Colour = [number, number, number];
function fill(b: Bitmap, r: Rect, [red, green, blue]: Colour, opacity = 1): void {
  const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y)), x1 = Math.min(b.width, Math.round(r.x + r.w)), y1 = Math.min(b.height, Math.round(r.y + r.h));
  for (let y = y0; y < y1; y++) for (let x = x0, o = (y * b.width + x0) * 4; x < x1; x++, o += 4) {
    b.data[o] = b.data[o]! + (red - b.data[o]!) * opacity; b.data[o + 1] = b.data[o + 1]! + (green - b.data[o + 1]!) * opacity; b.data[o + 2] = b.data[o + 2]! + (blue - b.data[o + 2]!) * opacity;
  }
}
function outline(b: Bitmap, r: Rect, colour: Colour, thick: number, opacity = 1): void {
  fill(b, { x: r.x, y: r.y, w: r.w, h: thick }, colour, opacity); fill(b, { x: r.x, y: r.y + r.h - thick, w: r.w, h: thick }, colour, opacity);
  fill(b, { x: r.x, y: r.y + thick, w: thick, h: r.h - 2 * thick }, colour, opacity); fill(b, { x: r.x + r.w - thick, y: r.y + thick, w: thick, h: r.h - 2 * thick }, colour, opacity);
}
const tagSize = (label: string, scale: number) => ({ w: label.length * 6 * scale + scale * 2, h: 7 * scale + scale * 2 + 2 });
function tag(b: Bitmap, x: number, y: number, label: string, colour: Colour, scale: number): void {
  const size = tagSize(label, scale);
  fill(b, { x, y, ...size }, colour);
  [...label].forEach((ch, n) => {
    const glyph = FONT[ch];
    if (!glyph) return;
    for (let i = 0; i < 35; i++) if (glyph[i] === "1") fill(b, { x: x + scale * 1.5 + n * 6 * scale + (i % 5) * scale, y: y + scale + 1 + Math.floor(i / 5) * scale, w: scale, h: scale }, [255, 255, 255]);
  });
}

/** Boxes and numbers on a copy of the screen. A tag sits outside its box where there is room, so it does not cover a small icon. */
export function drawMarks(screen: Bitmap, marks: Mark[], opts: { schematic?: boolean } = {}): Bitmap {
  const b: Bitmap = { width: screen.width, height: screen.height, data: opts.schematic ? new Uint8Array(screen.data.length).fill(255) : Uint8Array.from(screen.data) };
  const placed: Rect[] = [];
  const cells = marks.filter((m) => m.kind === "cell"), rest = marks.filter((m) => m.kind !== "cell");
  for (const m of cells) { outline(b, m.rect, [90, 90, 90], 1, 0.55); tag(b, m.rect.x + 2, m.rect.y + 2, m.label, [90, 90, 90], 1.5); placed.push({ x: m.rect.x + 2, y: m.rect.y + 2, ...tagSize(m.label, 1.5) }); }
  rest.forEach((m, i) => {
    const colour = PALETTE[i % PALETTE.length]!, known = m.kind === "known";
    outline(b, { x: m.rect.x - 1, y: m.rect.y - 1, w: m.rect.w + 2, h: m.rect.h + 2 }, colour, known ? 1 : 2, known ? 0.8 : 1);
  });
  rest.forEach((m, i) => {
    const colour = PALETTE[i % PALETTE.length]!, size = tagSize(m.label, 2), r = m.rect;
    const spots = [{ x: r.x - 1, y: r.y - size.h - 1 }, { x: r.x - 1, y: r.y + r.h + 1 }, { x: r.x - size.w - 1, y: r.y }, { x: r.x + r.w + 1, y: r.y }, { x: r.x + r.w - size.w, y: r.y - size.h - 1 }, { x: r.x, y: r.y }];
    const free = (s: { x: number; y: number }) => s.x >= 0 && s.y >= 0 && s.x + size.w <= b.width && s.y + size.h <= b.height
      && !placed.some((p) => overlap(p, { ...s, ...size })) && !rest.some((o) => o !== m && overlap(o.rect, { ...s, ...size }) > size.w * size.h * 0.3);
    const spot = spots.find(free) ?? spots.find((s) => s.x >= 0 && s.y >= 0 && s.x + size.w <= b.width && s.y + size.h <= b.height && !placed.some((p) => overlap(p, { ...s, ...size }))) ?? spots[5]!;
    // A tag that has to sit on its own box is black: a red tag on a blue swatch would make the model see a red swatch.
    tag(b, spot.x, spot.y, m.label, spot === spots[5] ? [0, 0, 0] : colour, 2); placed.push({ ...spot, ...size });
  });
  return b;
}

/** The clean screen on top and a diagram of the marks below it, as one image: for models that read a busy screenshot badly. */
export function stackSchematic(screen: Bitmap, marks: Mark[]): Bitmap {
  const diagram = drawMarks(screen, marks, { schematic: true }), data = new Uint8Array(screen.data.length * 2);
  data.set(screen.data); data.set(diagram.data, screen.data.length);
  return { width: screen.width, height: screen.height * 2, data };
}

// ---------------------------------------------------------------- what pixels alone can tell

/**
 * What a rectangle looks like, as a hash of its pixels (coarsened a little, the outermost pixel left out). Exact on
 * purpose: the same icon in every row of a list gives the same string, so one caption serves them all, and anything
 * that differs at all is a different look. An 8x8 brightness pattern was tried first and called every thin line icon
 * of a toolbar the same picture. Wrongly "different" costs a caption; wrongly "same" would put a wrong name on a button.
 */
export function signatureOf(b: Bitmap, rect: Rect): string {
  const outer = clip(round(rect), b), r = { x: outer.x + 1, y: outer.y + 1, w: outer.w - 2, h: outer.h - 2 };
  if (r.w < 4 || r.h < 4) return "";
  const bytes = new Uint8Array(r.w * r.h * 3);
  for (let y = 0, i = 0; y < r.h; y++) for (let x = 0, o = ((r.y + y) * b.width + r.x) * 4; x < r.w; x++, o += 4) { bytes[i++] = b.data[o]! >> 4; bytes[i++] = b.data[o + 1]! >> 4; bytes[i++] = b.data[o + 2]! >> 4; }
  return `${r.w}x${r.h}-${Bun.hash(bytes).toString(36)}`;
}
export const sameLook = (a: string, b: string) => a !== "" && a === b;

/** Flat-coloured boxes inside `roi`: swatches, buttons drawn on a canvas, fields in a frame. Connected pixels of one (coarse) colour. */
export function flatRegions(b: Bitmap, roi: Rect): Rect[] {
  const r = clip(round(roi), b), W = r.w, H = r.h;
  if (W < REGION.min || H < REGION.min) return [];
  const colour = new Uint16Array(W * H), seen = new Uint8Array(W * H), stack = new Int32Array(W * H), found: Rect[] = [];
  for (let y = 0; y < H; y++) for (let x = 0, o = ((r.y + y) * b.width + r.x) * 4; x < W; x++, o += 4) colour[y * W + x] = ((b.data[o]! >> 3) << 10) | ((b.data[o + 1]! >> 3) << 5) | (b.data[o + 2]! >> 3);
  for (let start = 0; start < W * H; start++) {
    if (seen[start]) continue;
    const want = colour[start]!;
    let top = 0, size = 0, minX = W, minY = H, maxX = 0, maxY = 0;
    stack[top++] = start; seen[start] = 1;
    while (top) {
      const p = stack[--top]!, x = p % W, y = (p - x) / W;
      size++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && !seen[p - 1] && colour[p - 1] === want) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < W - 1 && !seen[p + 1] && colour[p + 1] === want) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (y > 0 && !seen[p - W] && colour[p - W] === want) { seen[p - W] = 1; stack[top++] = p - W; }
      if (y < H - 1 && !seen[p + W] && colour[p + W] === want) { seen[p + W] = 1; stack[top++] = p + W; }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    if (w < REGION.min || h < REGION.min || w > REGION.max || h > REGION.max || size < w * h * REGION.fill || w > h * REGION.aspect || h > w * REGION.aspect) continue;
    found.push({ x: r.x + minX, y: r.y + minY, w, h });
  }
  // The dot inside a size button is part of the button, not a second control.
  return found.filter((a) => !found.some((o) => o !== a && area(o) > area(a) && overlap(a, o) >= area(a) * 0.9));
}

/** OCR lines cut where a person would see separate labels: "New   Open   Save" is three things, not one. */
export function phrasesOf(lines: OcrLine[]): { text: string; rect: Rect }[] {
  const out: { text: string; rect: Rect }[] = [];
  for (const line of lines) {
    let run: OcrWord[] = [];
    const flush = () => {
      if (!run.length) return;
      const x = Math.min(...run.map((w) => w.x)), y = Math.min(...run.map((w) => w.y));
      out.push({ text: run.map((w) => w.t).join(" "), rect: { x, y, w: Math.max(...run.map((w) => w.x + w.w)) - x, h: Math.max(...run.map((w) => w.y + w.h)) - y } });
      run = [];
    };
    const tall = [...line.words].map((w) => w.h).sort((a, b) => a - b)[Math.floor(line.words.length / 2)] ?? 12;
    for (const word of line.words) {
      const last = run[run.length - 1];
      if (last && word.x - (last.x + last.w) > Math.max(10, tall * 1.1)) flush();
      run.push(word);
    }
    flush();
  }
  // One stray letter is what the engine makes of an icon.
  return out.filter((p) => (p.text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2);
}

// ---------------------------------------------------------------- decompose

export type DecomposeDeps = { ocr?: Ocr; memory?: MarkMemory; log?: (line: string) => void };

/**
 * Everything on this screen that Jev has no words for, numbered, with rectangles we measured. No model is asked.
 * Start it the moment the screenshot exists: it runs beside `choosePlanner` (one Jev round trip), which hides most of it.
 */
export async function decompose(obs: Markable, png: Uint8Array, screen: Screen, deps: DecomposeDeps = {}): Promise<Marks> {
  const started = performance.now(), timings = { decodeMs: 0, ocrMs: 0, regionsMs: 0, drawMs: 0, encodeMs: 0, totalMs: 0 };
  const blind = obs.elements.length === 0 && !obs.opaque?.length;
  const opaque: Opaque[] = blind ? [{ kind: "screen", rect: { x: 0, y: 0, w: screen.width, h: screen.height } }] : (obs.opaque ?? []).map((o) => ({ ...o, rect: clip(round(o.rect), screen) })).filter((o) => o.rect.w > 0 && o.rect.h > 0);
  const opaqueAt = (r: Rect) => opaque.find((o) => inside(centre(r), o.rect));
  const holder = (o: Opaque | undefined) => (o ? o.name || (o.kind === "screen" ? "" : o.kind) : "");
  // OCR only where the tree is blind; it runs in its own process, so start it before the pixel work here and the two overlap.
  const reading = deps.ocr && opaque.length ? deps.ocr(png).then((lines) => { timings.ocrMs = Math.round(performance.now() - started); return lines; }, (error) => { deps.log?.(`marks: no OCR (${error instanceof Error ? error.message : error})`); return [] as OcrLine[]; }) : Promise.resolve([] as OcrLine[]);
  let bitmap: Bitmap | null = null;
  try { bitmap = decodePng(png); } catch (error) { deps.log?.(`marks: screenshot not decoded (${error instanceof Error ? error.message : error})`); }
  // A capture may be scaled (a high-DPI window): pixels are read and drawn in the PNG's space, every rectangle we keep is
  // in the hand's. A PNG of another shape is not a picture of this screen, and nothing is drawn on it.
  if (bitmap && Math.abs(bitmap.width / bitmap.height - screen.width / screen.height) > 0.02) { deps.log?.(`marks: screenshot is ${bitmap.width}x${bitmap.height}, the hand is ${screen.width}x${screen.height}`); bitmap = null; }
  const scale = bitmap ? bitmap.width / screen.width : 1;
  const toPng = (r: Rect): Rect => ({ x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale }), toHand = (r: Rect): Rect => round({ x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale });
  timings.decodeMs = Math.round(performance.now() - started);

  const regionsStarted = performance.now();
  const flat = bitmap ? opaque.flatMap((o) => flatRegions(bitmap!, toPng(o.rect)).map(toHand)) : [];
  timings.regionsMs = Math.round(performance.now() - regionsStarted);
  const phrases = phrasesOf(await reading).map((p) => ({ ...p, rect: toHand(p.rect) }));

  type Draft = Omit<Mark, "label" | "id">;
  const known = obs.elements, fresh: Draft[] = [];
  const taken = (r: Rect, name = "") => known.some((el) => iou(el.rect, r) >= 0.5 || (inside(centre(r), el.rect) && (!name || el.editable || similarity(name, `${el.name} ${el.value}`) >= 0.5)))
    || fresh.some((m) => iou(m.rect, r) >= 0.5);

  (obs.unnamed ?? []).forEach((u, unnamedIndex) => {
    const rect = clip(round(u.rect), screen);
    if (rect.w < 4 || rect.h < 4 || taken(rect)) return;
    fresh.push({ kind: "unnamed", rect, role: u.role || "button", name: "", within: u.row || u.within || "", editable: Boolean(u.editable), after: u.after, unnamedIndex });
  });
  // A phrase inside a flat box names the box and takes its rectangle: that is a drawn button. Two phrases in one box make it a panel.
  const boxed = new Set<Rect>();
  for (const box of flat) {
    const held = phrases.filter((p) => inside(centre(p.rect), box));
    if (held.length > 1) { boxed.add(box); continue; }
    if (held.length === 1 && area(box) <= area(held[0]!.rect) * 25) { held[0]!.rect = box; boxed.add(box); }
  }
  // OCR is used only where the tree is blind. Everywhere else the tree already has the words, and better: with roles.
  for (const p of phrases) {
    const home = opaqueAt(p.rect);
    if (!home || taken(p.rect, p.text)) continue;
    fresh.push({ kind: "text", rect: p.rect, role: "text", name: p.text.slice(0, 80), within: holder(home), editable: false });
  }
  for (const box of flat) if (!boxed.has(box) && !taken(box)) fresh.push({ kind: "region", rect: box, role: "region", name: "", within: holder(opaqueAt(box)), editable: false });

  fresh.sort((a, b) => reads(a.rect, b.rect));
  const kept = fresh.slice(0, MAX_NEW);
  if (bitmap) for (const m of kept) m.sig = signatureOf(bitmap, toPng(m.rect));

  // The grid: only over blind spots, and only where nothing above already gives a handle.
  const cw = screen.width / GRID.cols, ch = screen.height / GRID.rows, cells: Draft[] = [];
  for (let row = 0; row < GRID.rows && opaque.length; row++) for (let col = 0; col < GRID.cols; col++) {
    const rect = round({ x: col * cw, y: row * ch, w: cw, h: ch }), blindShare = opaque.reduce((sum, o) => sum + overlap(o.rect, rect), 0) / area(rect);
    const covered = kept.reduce((sum, m) => sum + overlap(m.rect, rect), 0) / area(rect), holds = kept.filter((m) => inside(centre(m.rect), rect)).length;
    if (blindShare < 0.5 || covered > 0.4 || holds >= 3) continue;
    cells.push({ kind: "cell", rect, role: "region", name: "", within: holder(opaqueAt(rect)), editable: false, sig: bitmap ? signatureOf(bitmap, toPng(rect)) : undefined });
  }

  // Known elements keep their own number, so a step can name a twin exactly. On a dense page only the twins are drawn.
  const twins = new Set(known.filter((el) => known.some((o) => o !== el && o.name === el.name && o.role === el.role)).map((el) => el.id));
  const shown = (known.length <= MAX_KNOWN_DRAWN ? known : known.filter((el) => twins.has(el.id)).slice(0, MAX_KNOWN_DRAWN)).filter((el) => /^e\d+$/.test(el.id));
  const highest = known.reduce((max, el) => Math.max(max, Number(/^e(\d+)$/.exec(el.id)?.[1] ?? 0)), 0);
  const marks: Mark[] = [
    ...shown.map((el): Mark => ({ label: el.id.slice(1), id: el.id, kind: "known", rect: clip(round(el.rect), screen), role: el.role, name: el.name, within: el.within, editable: el.editable })),
    ...kept.map((m, i): Mark => ({ ...m, label: String(highest + i + 1), id: `m${highest + i + 1}` })),
    ...cells.map((m): Mark => { const label = `${String.fromCharCode(65 + Math.round(m.rect.x / cw))}${Math.round(m.rect.y / ch) + 1}`; return { ...m, label, id: `m${label}` }; }),
  ];
  // Identical icons are asked about once; what memory already knows is not asked about at all.
  for (const [i, m] of marks.entries()) {
    if (!m.sig || (m.kind !== "unnamed" && m.kind !== "region")) continue;
    const learned = deps.memory && recallLook(deps.memory, m.sig);
    if (learned && !m.name) { m.name = learned.name; m.role = learned.role; m.editable = learned.editable; m.learned = true; }
    const first = marks.slice(0, i).find((o) => o.kind === m.kind && o.role === m.role && sameLook(o.sig ?? "", m.sig!));
    if (first) m.sameAs = first.sameAs ?? first.label;
  }

  let image = png, drawn = false;
  if (bitmap) {
    const drawStarted = performance.now(), picture = drawMarks(bitmap, scale === 1 ? marks : marks.map((m) => ({ ...m, rect: round(toPng(m.rect)) })));
    timings.drawMs = Math.round(performance.now() - drawStarted);
    const encodeStarted = performance.now();
    image = encodePng(picture); drawn = true;
    timings.encodeMs = Math.round(performance.now() - encodeStarted);
  }
  timings.totalMs = Math.round(performance.now() - started);
  return { marks, image, clean: png, drawn, screen, timings };
}

/** What the planner is told about the marks, one line each. `coords`: for sending the clean screenshot instead of the drawn one. */
export function legendOf(marks: Mark[], opts: { coords?: boolean } = {}): string[] {
  const where = (m: Mark) => (opts.coords ? ` at x=${m.rect.x} y=${m.rect.y} w=${m.rect.w} h=${m.rect.h}` : "");
  const lines: string[] = [];
  for (const m of marks) {
    if (m.kind === "cell") continue;
    const inn = m.within ? `, in ${JSON.stringify(m.within.slice(0, 60))}` : "";
    if (m.kind === "known") lines.push(`${m.label}: ${m.role} ${JSON.stringify(m.name.slice(0, 60))} (the worker has this one)${where(m)}`);
    else if (m.learned) lines.push(`${m.label}: ${m.role} ${JSON.stringify(m.name)} (captioned before)${inn}${where(m)}`);
    else if (m.sameAs) lines.push(`${m.label}: looks the same as ${m.sameAs}${inn}${where(m)}`);
    else if (m.kind === "unnamed") lines.push(`${m.label}: ${m.role} with no name${inn}${where(m)}`);
    else if (m.kind === "text") lines.push(`${m.label}: text ${JSON.stringify(m.name)}${inn}${where(m)}`);
    else lines.push(`${m.label}: flat region ${m.rect.w}x${m.rect.h}${inn}${where(m)}`);
  }
  const cells = marks.filter((m) => m.kind === "cell");
  if (cells.length) lines.push(`${cells.map((m) => m.label).join(" ")}: grid cells${opts.coords ? ` of ${cells[0]!.rect.w}x${cells[0]!.rect.h}, columns A-H from the left, rows 1-6 from the top` : ""}, a last resort where nothing else marks the thing`);
  return lines;
}

// ---------------------------------------------------------------- the plan comes back

/** The ninth of a cell the planner pointed at: a cell is 160x133, a ninth of it is about the size of a button. */
export function subcell(rect: Rect, at: Subcell | null): Rect {
  if (!at) return rect;
  const col = at.includes("left") ? 0 : at.includes("right") ? 2 : 1, row = at.startsWith("top") ? 0 : at.startsWith("bottom") ? 2 : 1;
  return round({ x: rect.x + (col * rect.w) / 3, y: rect.y + (row * rect.h) / 3, w: rect.w / 3, h: rect.h / 3 });
}

type Addition = { element: Omit<UiElement, "id">; id: string; after?: number };

/** Captions resolved against the marks: one entry per new thing Jev should be offered. A caption of one icon covers the ones that look the same. */
function additions(marks: Mark[], captions: Caption[], frame: string): Addition[] {
  const byLabel = new Map(marks.map((m) => [m.label, m])), out = new Map<string, Addition>();
  const add = (m: Mark, c: Caption, inherited: boolean) => {
    if (m.kind === "known" || out.has(m.id) || !c.name.trim()) return;
    const role = c.role.trim() || (m.kind === "unnamed" ? m.role : "button");
    // A look-alike sits in its own row: it takes the caption, never the container.
    const within = (inherited ? m.within : c.container.trim() || m.within).slice(0, 80);
    out.set(m.id, { id: m.id, after: m.after, element: { source: "vision", role, name: c.name.trim().slice(0, 120), value: "", editable: c.editable || m.editable, focused: false, within, frame, rect: m.kind === "cell" ? subcell(m.rect, c.at) : m.rect } });
  };
  for (const c of captions) {
    const m = byLabel.get(c.mark.trim().replace(/^m(?=[\dA-H])/i, ""));
    if (!m) continue;
    add(m, c, false);
    for (const twin of marks) if (twin.sameAs === (m.sameAs ?? m.label) || (m.sameAs && twin.label === m.sameAs)) add(twin, c, true);
  }
  // What memory had already named needs no caption from the planner to be offered.
  for (const m of marks) if (m.learned && m.name) add(m, { mark: m.label, name: m.name, role: m.role, container: m.within, editable: m.editable, at: null }, true);
  return [...out.values()];
}

/** New elements go where a reader would meet them: after the named element the observer saw before them, else by position. */
function weave(elements: UiElement[], extra: Addition[]): UiElement[] {
  const named = elements.filter((el) => el.source !== "vision"), slots: UiElement[][] = Array.from({ length: named.length + 1 }, () => []);
  for (const add of extra) {
    if (elements.some((el) => el.id === add.id)) continue;
    let slot = add.after !== undefined ? Math.min(Math.max(0, add.after), named.length) : 0;
    if (add.after === undefined) named.forEach((el, i) => { if (reads(el.rect, add.element.rect) <= 0) slot = i + 1; });
    slots[slot]!.push({ ...add.element, id: add.id });
  }
  return [...slots[0]!.sort((a, b) => reads(a.rect, b.rect)), ...named.flatMap((el, i) => [el, ...slots[i + 1]!.sort((a, b) => reads(a.rect, b.rect))])];
}

/**
 * The observation Jev decides on after a marked plan: every captioned mark is an element with source "vision", the
 * rectangle we measured, the container, and its place in reading order. The fingerprint stays the real screen's.
 */
export function applyMarks(obs: Observation, marks: Marks, plan: { captions: Caption[] }): Observation {
  return { ...obs, elements: weave(obs.elements, additions(marks.marks, plan.captions, obs.frames[0] ?? "")) };
}

/**
 * What can be offered to Jev before any model has looked: text OCR read in a blind spot has words already, and words are
 * what Jev needs. Try this first on a stuck look (it costs a screenshot and about 300 ms); ask the planner when Jev is
 * still stuck, with the same `marks`. Textless things (swatches, icons) and fields still need the planner's caption.
 */
export function offerReadable(obs: Observation, marks: Marks): Observation {
  const readable = marks.marks.filter((m) => m.kind === "text" && m.name);
  return { ...obs, elements: weave(obs.elements, readable.map((m) => ({ id: m.id, element: { source: "vision", role: "text", name: m.name, value: "", editable: false, focused: false, within: m.within, frame: obs.frames[0] ?? "", rect: m.rect } }))) };
}

/** Steps as Jev should read them: every cited mark by the id Jev will find in its list. */
export function citeForJev(marks: Mark[], cited: string | null): string | null {
  if (!cited) return null;
  const label = cited.trim().replace(/^m(?=[\dA-H])/i, "");
  return marks.find((m) => m.label === label)?.id ?? null;
}

/**
 * For the fully concurrent route (clean screenshot to the model at once, decomposition meanwhile): a rectangle the
 * model guessed is replaced by the mark it lands on. A guess that lands on nothing is kept as it was.
 */
export function snapPlan<T extends { elements: { role: string; name: string; rect: Rect }[] }>(plan: T, marks: Marks): T {
  const targets = marks.marks.filter((m) => m.kind !== "cell" && m.kind !== "known");
  const elements = plan.elements.map((el) => {
    const c = centre(el.rect), named = targets.filter((m) => m.name && similarity(el.name, m.name) >= 0.6);
    const hit = [...named, ...targets].map((m) => { const mc = centre(m.rect); return { m, far: Math.hypot(mc.x - c.x, mc.y - c.y), on: inside(c, m.rect) || iou(el.rect, m.rect) >= 0.2 }; })
      .filter((t) => t.on || t.far <= 32).sort((a, b) => Number(b.on) - Number(a.on) || a.far - b.far)[0];
    return hit ? { ...el, rect: hit.m.rect } : el;
  });
  return { ...plan, elements };
}

// ---------------------------------------------------------------- memory

type Learned = { name: string; role: string; editable: boolean };
type Remembered = Learned & { id: string; within: string; after?: number; from: { unnamed: number } | { opaque: number; dx: number; dy: number; w: number; h: number; sig: string } };
export type MarkMemory = { looks: { sig: string; learned: Learned }[]; screens: Map<string, Remembered[]> };
export const createMarkMemory = (): MarkMemory => ({ looks: [], screens: new Map() });

/** A screen's shape without its positions: the same page scrolled, or with other text in its fields, is the same screen. */
export function screenKey(obs: Markable): string {
  return Bun.hash(JSON.stringify([obs.elements.filter((el) => el.source !== "vision").map((el) => [el.role, el.name, el.within]), (obs.unnamed ?? []).map((u) => [u.role, u.row ?? u.within ?? ""]), (obs.opaque ?? []).map((o) => [o.kind, Math.round(o.rect.w), Math.round(o.rect.h)])])).toString(36);
}
const recallLook = (memory: MarkMemory, sig: string) => memory.looks.find((l) => sameLook(l.sig, sig))?.learned;

/** Keep what a marked plan taught us: per icon look, and per screen. */
export function learn(memory: MarkMemory, obs: Markable, marks: Marks, plan: { captions: Caption[] }): void {
  const kept: Remembered[] = [];
  for (const add of additions(marks.marks, plan.captions, "")) {
    const m = marks.marks.find((x) => x.id === add.id)!, learned = { name: add.element.name, role: add.element.role, editable: add.element.editable };
    if (m.sig && (m.kind === "unnamed" || m.kind === "region") && !recallLook(memory, m.sig)) memory.looks.push({ sig: m.sig, learned });
    if (m.unnamedIndex !== undefined) kept.push({ ...learned, id: m.id, within: add.element.within, after: m.after, from: { unnamed: m.unnamedIndex } });
    else {
      const home = (obs.opaque ?? []).findIndex((o) => inside(centre(add.element.rect), o.rect));
      if (home >= 0 && m.sig) kept.push({ ...learned, id: m.id, within: add.element.within, from: { opaque: home, dx: add.element.rect.x - obs.opaque![home]!.rect.x, dy: add.element.rect.y - obs.opaque![home]!.rect.y, w: add.element.rect.w, h: add.element.rect.h, sig: m.sig } });
    }
  }
  if (kept.length) memory.screens.set(screenKey(obs), kept);
}

/**
 * Put back what was learned on this screen. Call it on EVERY look: it costs a hash. Captions of controls the DOM knows come
 * back as soon as the screen has the same shape (rectangles are the fresh ones). Captions that rest on pixels alone
 * (canvas, iframe) come back only with a screenshot whose pixels at that place still look the same.
 */
export function recall(memory: MarkMemory, obs: Markable, png?: Uint8Array, screen?: Screen): Observation {
  const kept = memory.screens.get(screenKey(obs));
  if (!kept) return obs;
  let bitmap: Bitmap | null = null;
  if (png && kept.some((k) => "opaque" in k.from)) try { bitmap = decodePng(png); } catch { /* pixel-backed captions stay out */ }
  const extra: Addition[] = [];
  for (const k of kept) {
    let rect: Rect | null = null;
    if ("unnamed" in k.from) rect = obs.unnamed?.[k.from.unnamed]?.rect ?? null;
    else if (bitmap) { const o = obs.opaque?.[k.from.opaque]; const at = o && { x: o.rect.x + k.from.dx, y: o.rect.y + k.from.dy, w: k.from.w, h: k.from.h }, zoom = screen ? bitmap.width / screen.width : 1; if (at && sameLook(signatureOf(bitmap, { x: at.x * zoom, y: at.y * zoom, w: at.w * zoom, h: at.h * zoom }), k.from.sig)) rect = at; }
    if (rect) extra.push({ id: k.id, after: k.after, element: { source: "vision", role: k.role, name: k.name, value: "", editable: k.editable, focused: false, within: k.within, frame: obs.frames[0] ?? "", rect: round(rect) } });
  }
  return extra.length ? { ...obs, elements: weave(obs.elements, extra) } : obs;
}
