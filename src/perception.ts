/** Turn the display into clickable items: OCR text blocks and accessibility controls. */

import sharp from "sharp";
import { MAX_OPTIONS, MIN_OCR_CONFIDENCE } from "./config.ts";
import * as macos from "./macos.ts";
import { type AxNode, type Box, type Capture, type Frame, fromAx, type Item, item, type Point, roleWord, type Screen, sizePt, toPoints } from "./models.ts";
import { OCR_RECTS, OCR_REGION_PCT, phase, type Timing } from "./timing.ts";

export type Line = [text: string, confidence: number, box: Box];
export const ECHO_CHARS = 24;
export const MIN_BOX_OVERLAP = 0.5; // intersection over the smaller box
export const MIN_TOKEN_OVERLAP = 0.5;

// OCR costs about two thirds of a step, and it scales with the amount of text, so the way to make it
// cheaper is to read less of the screen: the frontmost window's own columns instead of the display,
// and within them only the blobs of tiles that changed since the previous capture, one crop each.
export const MENU_BAR_PT = 40.0; // the strip above every window, which the app's own menus live in
export const REGION_MARGIN_PT = 8.0; // slack around the window, for the shadow and a clipped glyph
export const THUMB_DIVISOR = 8; // the change detector works on a 1/8 scale grayscale copy
export const TILE_PX = 256.0; // tile side in capture pixels
export const TILE_DIFF = 6.0; // mean absolute 8-bit difference that counts a tile as changed
export const REOCR_FRACTION = 0.6; // above this share of changed tiles, reading the whole region is cheaper
export const MAX_REOCR_RECTS = 4; // past this, the per-call overhead outweighs the pixels another rectangle saves

export interface CaptureOptions {
  /** Capture this window alone rather than the display the frontmost window is on. It need not be in front, or visible at all. */
  target?: { pid: number; windowId: number };
  out?: string; // where a live capture is written; required unless `imagePath` replays one
  imagePath?: string;
  app?: string;
  url?: string;
  browser?: string;
  timing?: Timing;
}

/**
 * Capture the display the frontmost window is on, or load a saved capture for replay (then app/url
 * are taken as given).
 *
 * Each query below is a round trip to the window server, AX, or AppleScript. Pass `timing` to
 * record the seconds each one costs under "app", "window", "screenshot", "field", and "url".
 */
export async function capture(options: CaptureOptions = {}): Promise<Screen> {
  if (options.target) return captureWindow(options.target, options);
  const { imagePath, app, url, browser = "", timing } = options;
  const replay = imagePath !== undefined && app !== undefined;
  if (!replay) macos.releaseElements();
  const [frontmost, pid] = await phase(timing, "app", async (): Promise<[string, number | null]> => {
    if (replay) return [app, null];
    const [name, id] = await macos.frontmostAppAndPid();
    return [app ?? name, id];
  });
  const window = await phase(timing, "window", () => (replay ? null : macos.frontmostWindowBounds(pid)));
  const display = macos.displayFor(window);
  const image = await phase(timing, "screenshot", () => {
    if (imagePath) return macos.captureAt(imagePath);
    if (!options.out) throw new Error("capture needs somewhere to write the screenshot");
    return macos.screenshot(display, options.out);
  });
  const field = await phase(timing, "field", () => (replay ? null : macos.focusedField()));
  const pageUrl = await phase(timing, "url", () => (url !== undefined ? url : replay ? null : macos.browserUrl(browser)));
  return {
    image,
    scale: image.width / display.frame[2],
    app: frontmost,
    field,
    url: pageUrl,
    pid,
    window,
    origin: replay ? [0, 0] : [display.frame[0], display.frame[1]],
    axRefs: new Map(),
    offscreen: [],
  };
}

/**
 * One window, read where it lies. The capture is the window and nothing else, so its origin is the
 * window's own corner and everything downstream works unchanged. There is no focused field: the
 * keyboard focus belongs to whatever the user is doing.
 */
async function captureWindow(target: { pid: number; windowId: number }, { out, url, timing }: CaptureOptions): Promise<Screen> {
  macos.releaseElements();
  const window = await phase(timing, "window", () => macos.appWindows(target.pid).find((w) => w.id === target.windowId)?.frame ?? null);
  if (!window) throw new Error("the window is gone: closed, minimized, or on another desktop");
  if (!out) throw new Error("capture needs somewhere to write the screenshot");
  const image = await phase(timing, "screenshot", () => macos.screenshotWindow(target.windowId, out));
  return {
    image,
    scale: image.width / window[2],
    app: macos.appName(target.pid),
    field: null,
    url: url ?? null,
    pid: target.pid,
    window,
    origin: [window[0], window[1]],
    windowId: target.windowId,
    axRefs: new Map(),
    offscreen: [],
  };
}

const normalize = (value: string): string => value.toLowerCase().split(/\s+/).filter(Boolean).join(" ");

/** Substrings that identify a screen line as the command that launched this run. No goal, no echoes: every line contains "". */
export function goalEchoes(goal: string): Set<string> {
  const norm = normalize(goal);
  if (!norm) return new Set();
  return new Set(norm.length >= ECHO_CHARS ? [norm.slice(0, ECHO_CHARS), norm.slice(-ECHO_CHARS)] : [norm]);
}

export function isEcho(value: string, echoes: Set<string>): boolean {
  const norm = normalize(value);
  return [...echoes].some((echo) => norm.includes(echo));
}

/**
 * Everything worth clicking on this screen: OCR text blocks, plus the app's own controls.
 *
 * Fills `screen.axRefs` on the way, so an item that came from the accessibility tree can be
 * pressed through it later. The merge renumbers everything, hence the side table over the
 * final indices rather than a handle on the item itself, which has to stay printable.
 *
 * Fills `screen.offscreen` too: labelled controls the app exposes but does not show. They are
 * offered on their own, never as items, because nothing on the capture points at them.
 *
 * A `cache` carries the previous capture's OCR, so only the tiles that changed are read again.
 * Pass none to read the whole region every time, which is what a replay and an inspection do.
 */
export async function perceive(screen: Screen, budget: number, goal: string, timing?: Timing, cache?: OcrCache): Promise<Item[]> {
  const blocks = await phase(timing, "ocr", () => ocr(screen, budget, goal, cache, timing));
  const [nodes, hidden] = await phase(timing, "ax", () => axNodes(screen, budget));
  const merged = mergeWithOrigins(blocks, toAxItems(nodes, screen.scale, screen.origin), budget);
  screen.axRefs.clear();
  for (const [it, origin] of merged) if (origin !== null && nodes[origin]!.ref) screen.axRefs.set(it.index, nodes[origin]!.ref);
  const items = merged.map(([it]) => it);
  screen.offscreen.length = 0;
  screen.offscreen.push(...offscreenControls(hidden, items));
  return items;
}

/**
 * The screen's text as items, filtered and merged into blocks.
 *
 * The filter runs over the raw lines every step, including the reused ones, so a cached line is
 * treated exactly as a freshly read one.
 */
export async function ocr(screen: Screen, budget: number, goal: string, cache?: OcrCache, timing?: Timing): Promise<Item[]> {
  const [lines, readPct, rects] = await ocrLines(screen, cache);
  if (timing) {
    timing[OCR_REGION_PCT] = Math.round(readPct * 10) / 10;
    timing[OCR_RECTS] = rects;
  }
  const echoes = goalEchoes(goal);
  const kept = lines
    .filter(([t, c]) => t.trim() && c >= MIN_OCR_CONFIDENCE && !isEcho(t, echoes))
    .map(([t, c, b]): Line => [t.trim(), c, b]);
  return toItems(mergeBlocks(kept), budget);
}

// ------------------------------------------------------------------ reading less of the screen

/** A grayscale copy of a capture, one byte per pixel. */
export interface Thumb {
  data: Uint8Array;
  width: number;
  height: number;
}

const sameNumbers = (a: readonly number[] | null, b: readonly number[] | null): boolean =>
  a === b || (a !== null && b !== null && a.length === b.length && a.every((v, i) => v === b[i]));
const sameBoxes = (a: Box[], b: Box[]): boolean => a.length === b.length && a.every((box, i) => sameNumbers(box, b[i]!));

/**
 * The previous capture's OCR, and what makes it reusable.
 *
 * Holds a reduced grayscale copy of the capture, to find what moved, and the raw lines before
 * merging and filtering, in full-capture pixels. One cache belongs to one run.
 */
export class OcrCache {
  app: string | null = null;
  window: Frame | null = null;
  region: Box | null = null;
  thumb: Thumb | null = null;
  lines: Line[] = [];

  /** Never across a different app, a moved or resized window, or a different read region. */
  reusable(screen: Screen, region: Box, thumb: Thumb): boolean {
    return (
      this.thumb !== null &&
      this.thumb.width === thumb.width &&
      this.thumb.height === thumb.height &&
      this.app === screen.app &&
      sameNumbers(this.window, screen.window) &&
      sameNumbers(this.region, region)
    );
  }

  store(screen: Screen, region: Box, thumb: Thumb, lines: Line[]): void {
    [this.app, this.window, this.region, this.thumb, this.lines] = [screen.app, screen.window, region, thumb, [...lines]];
  }
}

/**
 * Raw OCR lines for this capture in full-capture pixels, the share of it read, and how many crops.
 *
 * Without a cache this reads the region once. With one it reads only the rectangles covering the
 * tiles that changed, one Vision call each, unless too much of the screen moved, in which case the
 * whole region is cheaper than stitching. A line a re-read rectangle touches is dropped and read
 * again whole, because Vision segments a crop slightly differently from the full image.
 */
export async function ocrLines(screen: Screen, cache?: OcrCache): Promise<[lines: Line[], readPct: number, rects: number]> {
  const region = ocrRegion(screen);
  const area = Math.max(1, screen.image.width * screen.image.height);
  const readPct = (rects: Box[]) => (100 * rects.reduce((sum, rect) => sum + areaOf(rect), 0)) / area;
  if (!cache) return [ocrCrop(screen.image, region), readPct([region]), 0];

  const readRegion = (): [Line[], number, number] => {
    const lines = ocrCrop(screen.image, region);
    cache.store(screen, region, thumb, lines);
    return [lines, readPct([region]), 0];
  };
  const thumb = await thumbnail(screen.image);
  if (!cache.reusable(screen, region, thumb)) return readRegion();
  const tiles = tilesIn(region);
  const changed = changedTiles(thumb, cache.thumb!, tiles);
  if (changed.length > REOCR_FRACTION * tiles.length) return readRegion();
  const rects = reocrRects(changed, region, cache.lines);
  if (!rects.length) {
    cache.store(screen, region, thumb, cache.lines);
    return [cache.lines, 0, 0];
  }
  if (rects.reduce((sum, rect) => sum + areaOf(rect), 0) > REOCR_FRACTION * areaOf(region)) return readRegion();
  const fresh = rects.flatMap((rect) => ocrCrop(screen.image, rect));
  const lines = mergeReocr(cache.lines, fresh, rects);
  cache.store(screen, region, thumb, lines);
  return [lines, readPct(rects), rects.length];
}

/**
 * The part of the capture worth reading, in capture pixels.
 *
 * The frontmost window with a margin, joined with the menu bar strip over the same columns and
 * clamped to the display. Text on the desktop and in background windows is noise to the decision,
 * so it is left unread. Clipping the strip to the window's x-range is what makes the crop worth
 * anything on a full-height window, whose own rectangle already reaches the bottom of the display.
 *
 * The cost is that status items to the right of the window, the clock and the menu extras, go
 * unread. They stay clickable: the accessibility tree lists them as AXMenuBarItem controls.
 */
export function ocrRegion(screen: Screen): Box {
  const [width, height] = [screen.image.width, screen.image.height];
  if (!screen.window) return [0, 0, width, height];
  const [x, y, w, h] = [screen.window[0] - screen.origin[0], screen.window[1] - screen.origin[1], screen.window[2], screen.window[3]];
  const [scale, margin] = [screen.scale, REGION_MARGIN_PT];
  const window: Box = [(x - margin) * scale, (y - margin) * scale, (x + w + margin) * scale, (y + h + margin) * scale];
  const joined: Box = [window[0], Math.min(window[1], 0), window[2], Math.max(window[3], MENU_BAR_PT * scale)];
  const clamped: Box = [Math.max(0, joined[0]), Math.max(0, joined[1]), Math.min(width, joined[2]), Math.min(height, joined[3])];
  return clamped[2] > clamped[0] && clamped[3] > clamped[1] ? clamped : [0, 0, width, height];
}

/** OCR one rectangle of the capture. Boxes come back in full-capture pixels, so nothing downstream knows a crop happened. */
export const ocrCrop = (image: Capture, rect: Box): Line[] => macos.recognizeText(image.path, rect);

/** A grayscale copy at 1/divisor scale. Averaged down, which smooths away the compression noise that would otherwise read as a change. */
export async function thumbnail(image: Capture, divisor = THUMB_DIVISOR): Promise<Thumb> {
  const [width, height] = [Math.max(1, Math.floor(image.width / divisor)), Math.max(1, Math.floor(image.height / divisor))];
  const data = await sharp(image.path).greyscale().resize(width, height, { fit: "fill", kernel: "linear" }).raw().toBuffer();
  return { data, width, height };
}

/** The region cut into tiles aligned to its own origin. The last row and column are short. */
export function tilesIn(region: Box, tile = TILE_PX): Box[] {
  const [x1, y1, x2, y2] = region;
  const out: Box[] = [];
  for (let y = y1; y < y2; y += tile) for (let x = x1; x < x2; x += tile) out.push([x, y, Math.min(x + tile, x2), Math.min(y + tile, y2)]);
  return out;
}

/**
 * True when the tile's mean absolute pixel difference clears the threshold. A tile whose patch
 * cannot be compared counts as changed, so a doubt is always paid for with a re-read.
 */
export function tileChanged(thumb: Thumb, previous: Thumb, tile: Box, divisor = THUMB_DIVISOR, threshold = TILE_DIFF): boolean {
  if (thumb.width !== previous.width || thumb.height !== previous.height) return true;
  const [x1, y1, x2, y2] = tile.map((v) => Math.round(v / divisor)) as Box;
  const [right, bottom] = [Math.min(thumb.width, Math.max(x2, x1 + 1)), Math.min(thumb.height, Math.max(y2, y1 + 1))];
  const [left, top] = [Math.max(0, x1), Math.max(0, y1)];
  if (right <= left || bottom <= top) return true;
  let sum = 0;
  for (let y = top; y < bottom; y++) {
    for (let i = y * thumb.width + left, end = y * thumb.width + right; i < end; i++) sum += Math.abs(thumb.data[i]! - previous.data[i]!);
  }
  return sum / ((right - left) * (bottom - top)) > threshold;
}

export const changedTiles = (thumb: Thumb, previous: Thumb, tiles: Box[], divisor = THUMB_DIVISOR, threshold = TILE_DIFF): Box[] =>
  tiles.filter((tile) => tileChanged(thumb, previous, tile, divisor, threshold));

/**
 * The changed tiles grouped into blobs that touch along a side or at a corner.
 *
 * Scattered change is the ordinary case: the menu bar clock ticks a digit while one panel
 * repaints. A single bounding box around both spans the display and forces a full read, where
 * two boxes leave everything between them alone.
 */
export function tileClusters(changed: Box[], tile = TILE_PX): Box[][] {
  const parent = changed.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  changed.forEach((a, i) => {
    for (let j = i + 1; j < changed.length; j++) {
      const b = changed[j]!;
      if (Math.abs(a[0] - b[0]) <= 1.5 * tile && Math.abs(a[1] - b[1]) <= 1.5 * tile) parent[root(i)] = root(j);
    }
  });
  const blobs = new Map<number, Box[]>();
  changed.forEach((box, i) => blobs.set(root(i), [...(blobs.get(root(i)) ?? []), box]));
  return [...blobs.values()];
}

/**
 * The rectangles to read again, one Vision call each. Empty when nothing changed.
 *
 * One rectangle per blob of changed tiles, each grown until it cuts no known line, the ones that
 * end up touching merged, and the count brought down to `limit` by merging the closest pairs.
 */
export function reocrRects(changed: Box[], region: Box, lines: Line[], limit = MAX_REOCR_RECTS, tile = TILE_PX): Box[] {
  let rects = settled(tileClusters(changed, tile).map((blob) => blobRect(blob, region, tile)), lines, region);
  while (rects.length > limit) {
    const [i, j] = closestPair(rects);
    rects = settled([unionBox(rects[i]!, rects[j]!), ...rects.filter((_, k) => k !== i && k !== j)], lines, region);
  }
  return rects;
}

/** One blob's bounding box, padded by a tile so a line crossing the edge is read whole, clamped. */
export function blobRect(blob: Box[], region: Box, tile = TILE_PX): Box {
  const x1 = Math.min(...blob.map((b) => b[0])) - tile;
  const y1 = Math.min(...blob.map((b) => b[1])) - tile;
  const x2 = Math.max(...blob.map((b) => b[2])) + tile;
  const y2 = Math.max(...blob.map((b) => b[3])) + tile;
  return [Math.max(region[0], x1), Math.max(region[1], y1), Math.min(region[2], x2), Math.min(region[3], y2)];
}

/**
 * Grow every rectangle past the lines it would cut, merge the ones that meet, until neither moves.
 *
 * Growing can push two rectangles together, and a merged rectangle has edges neither original had,
 * which can cut a line neither of them cut. So the two steps run to a fixed point, which they reach:
 * a rectangle only ever grows, bounded by the region, and a merge only ever removes one.
 */
export function settled(rects: Box[], lines: Line[], region: Box): Box[] {
  for (;;) {
    const grown = rects.map((rect) => grownForLines(rect, lines, region));
    const merged = mergeTouching(grown);
    if (sameBoxes(grown, rects) && sameBoxes(merged, grown)) return merged;
    rects = merged;
  }
}

/** The rectangles with every overlapping or touching pair replaced by the box around both. */
export function mergeTouching(rects: Box[]): Box[] {
  let out = [...rects];
  for (let merged = true; merged; ) {
    merged = false;
    search: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (!boxesTouch(out[i]!, out[j]!)) continue;
        out = [unionBox(out[i]!, out[j]!), ...out.filter((_, k) => k !== i && k !== j)];
        merged = true;
        break search;
      }
    }
  }
  return out;
}

/** Positions of the two rectangles with the smallest gap between them. */
export function closestPair(rects: Box[]): [number, number] {
  let best: [number, number, number] = [Infinity, 0, 0];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const gap = gapBetween(rects[i]!, rects[j]!);
      if (gap < best[0]) best = [gap, i, j];
    }
  }
  return [best[1], best[2]];
}

/** Distance between two rectangles, zero when they overlap or touch. */
export function gapBetween(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]));
  const dy = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]));
  return Math.hypot(dx, dy);
}

export const unionBox = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/** Overlapping, or meeting along an edge or at a corner: worth reading as one rectangle. */
export const boxesTouch = (a: Box, b: Box): boolean => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

export const areaOf = (box: Box): number => Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);

/**
 * The rectangle grown until no known line straddles its edge, clamped to the region.
 *
 * A crop cuts a line in half, and Vision reads the visible half as its own line, so a rectangle
 * that ends mid-line would trade a whole headline for a fragment. Reading a larger rectangle is
 * the cheaper mistake.
 */
export function grownForLines(rect: Box, lines: Line[], region: Box): Box {
  let current = rect;
  for (let growing = true; growing; ) {
    growing = false;
    for (const [, , box] of lines) {
      if (!boxesIntersect(box, current)) continue;
      const grown: Box = [
        Math.max(region[0], Math.min(current[0], box[0])),
        Math.max(region[1], Math.min(current[1], box[1])),
        Math.min(region[2], Math.max(current[2], box[2])),
        Math.min(region[3], Math.max(current[3], box[3])),
      ];
      if (!sameNumbers(grown, current)) {
        current = grown;
        growing = true;
      }
    }
  }
  return current;
}

export const boxesIntersect = (a: Box, b: Box): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** Previous lines no re-read rectangle touches, plus every line just read inside them. */
export const mergeReocr = (previous: Line[], fresh: Line[], rects: Box[]): Line[] => [
  ...previous.filter((line) => !rects.some((rect) => boxesIntersect(line[2], rect))),
  ...fresh,
];

// ------------------------------------------------------------------ accessibility items and the merge

/**
 * The frontmost app's labelled controls, in screen points, and the off-screen ones it still exposes.
 *
 * Icon-only buttons are invisible to OCR and live only here. Accessibility is best effort:
 * a missing pid, a refusing app, or a raising bridge all mean OCR carries the step alone.
 */
export function axNodes(screen: Screen, budget: number): [nodes: AxNode[], hidden: AxNode[]] {
  if (screen.pid === null) return [[], []];
  try {
    const [nodes, hidden] = macos.actionableElements(screen.pid, [...screen.origin, ...sizePt(screen)], { windowId: screen.windowId });
    return [nodes.slice(0, budget).filter((node) => node.label), hidden.filter((node) => node.label)];
  } catch {
    return [[], []];
  }
}

/**
 * The off-screen controls worth offering: one per role and label, minus anything already on screen.
 *
 * An app repeats a label across a scrolled list and across the copies of a view it keeps alive, and
 * the first one is as good as any since the press goes to the element. A label the visible list
 * already carries is dropped outright: the item on screen is the better way to reach it.
 */
export function offscreenControls(nodes: AxNode[], items: Item[]): AxNode[] {
  const visible = new Set(items.map((it) => it.text));
  const seen = new Set<string>();
  return nodes.filter((node) => {
    const key = JSON.stringify([node.role, node.label]);
    if (seen.has(key) || visible.has(node.label)) return false;
    seen.add(key);
    return true;
  });
}

/** Controls as items, converted from global screen points to pixels on the captured display. */
export const toAxItems = (nodes: AxNode[], scale: number, origin: Point = [0, 0]): Item[] =>
  nodes.map((node, i) => {
    const [x, y] = [node.x - origin[0], node.y - origin[1]];
    return item(i, node.label, 1.0, [x * scale, y * scale, (x + node.w) * scale, (y + node.h) * scale], roleWord(node), "ax");
  });

/** The frontmost app's labelled on-screen controls as items on the capture. */
export const axItems = (screen: Screen, budget: number): Item[] => toAxItems(axNodes(screen, budget)[0], screen.scale, screen.origin);

/** One item per thing. An accessibility control that sits on the OCR block naming it replaces both. */
export const mergeSources = (ocrItems: Item[], controls: Item[], budget = MAX_OPTIONS): Item[] =>
  mergeWithOrigins(ocrItems, controls, budget).map(([it]) => it);

/**
 * The merge, each item paired with the position of the control it came from, or null for plain text.
 *
 * The pairing survives the budget cut and the renumbering, which is the only way back from a
 * final item to the accessibility element behind it.
 */
export function mergeWithOrigins(ocrItems: Item[], controls: Item[], budget = MAX_OPTIONS): [Item, number | null][] {
  const taken = new Set<number>();
  const merged: [Item, number | null][] = [];
  controls.forEach((control, origin) => {
    let [best, bestOverlap] = [-1, MIN_BOX_OVERLAP];
    ocrItems.forEach((block, i) => {
      if (taken.has(i)) return;
      const overlap = boxOverlap(control, block);
      if (overlap >= bestOverlap && textsMatch(control.text, block.text)) [best, bestOverlap] = [i, overlap];
    });
    if (best < 0) return void merged.push([control, origin]);
    const block = ocrItems[best]!;
    taken.add(best);
    const label = control.text.length >= block.text.length ? control.text : block.text;
    merged.push([{ ...block, text: label, role: control.role, source: "ax+ocr" }, origin]);
  });
  ocrItems.forEach((block, i) => void (taken.has(i) || merged.push([block, null])));
  const kept = keptByBudget(merged.map(([it]) => it), budget).map((i) => merged[i]!);
  return readingOrder(kept.map(([it]) => it)).map((j, i) => [{ ...kept[j]![0], index: i }, kept[j]![1]]);
}

/** Intersection over the smaller box, so a tight control inside a wide text line still counts. */
export function boxOverlap(a: Item, b: Item): number {
  const wide = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const tall = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  const smaller = Math.min((a.x2 - a.x1) * (a.y2 - a.y1), (b.x2 - b.x1) * (b.y2 - b.y1));
  return wide > 0 && tall > 0 && smaller > 0 ? (wide * tall) / smaller : 0;
}

/** One label contains the other, or they share half their words. */
export function textsMatch(a: string, b: string): boolean {
  const [x, y] = [normalize(a), normalize(b)];
  if (!x || !y) return false;
  if (y.includes(x) || x.includes(y)) return true;
  const [wordsX, wordsY] = [new Set(x.split(" ")), new Set(y.split(" "))];
  const shared = [...wordsX].filter((word) => wordsY.has(word)).length;
  return shared / Math.min(wordsX.size, wordsY.size) >= MIN_TOKEN_OVERLAP;
}

/**
 * Which items survive the Choice ceiling: the faintest OCR-only blocks go first,
 * and a control is never dropped for text. Their positions, in the order given.
 */
export function keptByBudget(items: Item[], budget: number): number[] {
  const all = items.map((_, i) => i);
  if (items.length <= budget) return all;
  const ranked = [...all].sort((a, b) => Number(fromAx(items[a]!)) - Number(fromAx(items[b]!)) || items[a]!.ocrConfidence - items[b]!.ocrConfidence);
  const dropped = new Set(ranked.slice(0, items.length - budget));
  return all.filter((i) => !dropped.has(i));
}

export const toItems = (lines: Line[], budget: number): Item[] => orderItems(lines.map(([t, c, b]) => item(0, t, c, b))).slice(0, budget);

/** Number items in reading order: rows by the median item height, then left to right. */
export const orderItems = (items: Item[]): Item[] => readingOrder(items).map((j, i) => ({ ...items[j]!, index: i }));

/** Positions of the items in reading order: rows by the median item height, then left to right. */
export function readingOrder(items: Item[]): number[] {
  const heights = items.map((it) => it.y2 - it.y1).sort((a, b) => a - b);
  const rowH = Math.max(1, heights[Math.floor(heights.length / 2)] ?? 1);
  const row = (it: Item) => Math.round((it.y1 + it.y2) / 2 / rowH);
  return items.map((_, i) => i).sort((a, b) => row(items[a]!) - row(items[b]!) || items[a]!.x1 - items[b]!.x1);
}

/** Join lines that continue a block above them: aligned left edge, small gap, similar height. */
export function mergeBlocks(lines: Line[]): Line[] {
  const blocks: { text: string; conf: number; box: Box; lastH: number }[] = [];
  for (const [value, conf, [x1, y1, x2, y2]] of [...lines].sort((a, b) => a[2][1] - b[2][1] || a[2][0] - b[2][0])) {
    const h = y2 - y1;
    let best: { gap: number; block: (typeof blocks)[number] } | null = null;
    for (const block of blocks) {
      const [bx1, , , by2] = block.box;
      const bh = block.lastH;
      const gap = y1 - by2;
      const ratio = h / Math.max(bh, 1);
      const continues = Math.abs(x1 - bx1) < 0.6 * bh && -0.2 * bh < gap && gap < 0.8 * bh && 0.7 < ratio && ratio < 1.4;
      if (continues && (best === null || gap < best.gap)) best = { gap, block };
    }
    if (best === null) {
      blocks.push({ text: value, conf, box: [x1, y1, x2, y2], lastH: h });
      continue;
    }
    const { block } = best;
    const [bx1, by1, bx2] = block.box;
    block.text = `${block.text} ${value}`;
    block.conf = Math.min(block.conf, conf);
    block.box = [Math.min(bx1, x1), by1, Math.max(bx2, x2), y2];
    block.lastH = h;
  }
  return blocks.map(({ text: value, conf, box }) => [value, conf, box]);
}

/** Text of items within a radius of the focused field, in screen points. */
export function nearField(screen: Screen, items: Item[], radiusPt = 160): string[] {
  const f = screen.field;
  if (!f) return [];
  return items
    .filter((it) => {
      const [cx, cy] = toPoints(screen, it);
      return Math.abs(cx - (f.x + f.w / 2)) < radiusPt + f.w / 2 && Math.abs(cy - (f.y + f.h / 2)) < radiusPt;
    })
    .map((it) => it.text);
}
