import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import * as macos from "../src/macos.ts";
import type { Box, Capture, Frame, Screen } from "../src/models.ts";
import {
  boxesIntersect,
  changedTiles,
  type Line,
  MAX_REOCR_RECTS,
  MENU_BAR_PT,
  mergeReocr,
  OcrCache,
  ocrCrop,
  ocrLines,
  ocrRegion,
  reocrRects,
  thumbnail,
  tileClusters,
  tilesIn,
} from "../src/perception.ts";
import { guardMachine } from "./helpers.ts";

beforeEach(guardMachine);
afterEach(() => mock.restore());

const dir = mkdtempSync(join(tmpdir(), "hands-ocr-cache-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface ScreenOptions {
  width?: number;
  height?: number;
  scale?: number;
  app?: string;
  image?: Capture;
}

const screenWith = (window: Frame | null, { width = 2000, height = 1200, scale = 2, app = "Google Chrome", image }: ScreenOptions = {}): Screen => ({
  image: image ?? { path: join(dir, "never-decoded.png"), width, height },
  scale,
  app,
  field: null,
  url: null,
  pid: null,
  window,
  origin: [0, 0],
  axRefs: new Map(),
  offscreen: [],
});

const line = (text: string, x1: number, y1: number, x2: number, y2: number, conf = 1): Line => [text, conf, [x1, y1, x2, y2]];

describe("the region", () => {
  test("region is the whole capture without a window", () => {
    expect(ocrRegion(screenWith(null))).toEqual([0, 0, 2000, 1200]);
  });

  test("region covers the window with a margin and the menu bar", () => {
    // window 100..500 pt vertically, scale 2, so 200..1000 px, plus an 8 pt margin below it
    const region = ocrRegion(screenWith([50, 100, 600, 400]));
    expect(region).toEqual([(50 - 8) * 2, 0, (50 + 600 + 8) * 2, (100 + 400 + 8) * 2]);
  });

  test("region clips the menu bar strip to the window columns", () => {
    // The strip reaches the top of the display but never past the window's own sides.
    const region = ocrRegion(screenWith([300, 200, 400, 300]));
    expect(region[0]).toBe((300 - 8) * 2);
    expect(region[2]).toBe((300 + 400 + 8) * 2);
    expect(region[1]).toBe(0); // up to the menu bar
    expect(region[2]).toBeLessThan(2000); // the clock and the menu extras to the right go unread
  });

  test("region reaches the menu bar even for a window low on the display", () => {
    expect(ocrRegion(screenWith([50, 400, 600, 100]))[1]).toBe(0); // the menu bar strip is always read
  });

  test("region is at least the menu bar strip for a window above it", () => {
    expect(ocrRegion(screenWith([50, 0, 600, 10]))[3]).toBe(MENU_BAR_PT * 2);
  });

  test("region clamps a window larger than the display", () => {
    expect(ocrRegion(screenWith([-100, -50, 4000, 3000]))).toEqual([0, 0, 2000, 1200]);
  });

  test("region falls back to the whole capture for a degenerate window", () => {
    expect(ocrRegion(screenWith([0, 0, 0, 0], { scale: 0 }))).toEqual([0, 0, 2000, 1200]);
  });
});

let painted = 0;

/** A dark capture on disk with white boxes on it, which is what `thumbnail` and `ocrLines` decode. */
async function paint([width, height]: [number, number] = [2048, 1024], boxes: Box[] = [], shade = 30): Promise<Capture> {
  const path = join(dir, `painted-${++painted}.png`);
  const flat = (w: number, h: number, v: number) => ({ create: { width: w, height: h, channels: 3 as const, background: { r: v, g: v, b: v } } });
  await sharp(flat(width, height, shade))
    .composite(boxes.map(([x1, y1, x2, y2]) => ({ input: flat(x2 - x1, y2 - y1, 255), left: x1, top: y1 })))
    .png({ compressionLevel: 1 })
    .toFile(path);
  return { path, width, height };
}

describe("tiles and change detection", () => {
  const SMALL: [number, number] = [1024, 512];
  const tiles = tilesIn([0, 0, 1024, 512]);

  test("tiles cover the region aligned to its origin", () => {
    const cut = tilesIn([100, 100, 700, 400], 256);
    expect(cut).toHaveLength(3 * 2);
    expect(cut[0]).toEqual([100, 100, 356, 356]);
    expect(cut.at(-1)).toEqual([612, 356, 700, 400]); // the last row and column are short
  });

  test("no tile changes between identical captures", async () => {
    const thumb = await thumbnail(await paint(SMALL));
    expect(changedTiles(thumb, thumb, tiles)).toEqual([]);
  });

  test("only the painted tile changes", async () => {
    const [before, after] = [await paint(SMALL), await paint(SMALL, [[300, 300, 400, 400]])];
    const changed = changedTiles(await thumbnail(after), await thumbnail(before), tiles);
    expect(changed).toEqual([[256, 256, 512, 512]]);
  });

  test("a whole new screen changes every tile", async () => {
    const [before, after] = [await paint(SMALL), await paint(SMALL, [[0, 0, 1024, 512]])];
    expect(changedTiles(await thumbnail(after), await thumbnail(before), tiles)).toHaveLength(tiles.length);
  });

  test("faint noise does not count as a change", async () => {
    const [before, after] = [await paint(SMALL), await paint(SMALL, [], 33)];
    expect(changedTiles(await thumbnail(after), await thumbnail(before), tiles)).toEqual([]);
  });

  test("a rect pads by one tile and clamps to the region", () => {
    const region: Box = [0, 0, 1024, 512];
    expect(reocrRects([[256, 256, 512, 512]], region, [])).toEqual([[0, 0, 768, 512]]);
    expect(reocrRects([], region, [])).toEqual([]);
  });
});

/** Tiles at the given [column, row] positions, laid on one grid. */
const grid = (...cells: [number, number][]): Box[] => cells.map(([c, r]) => [c * 256, r * 256, (c + 1) * 256, (r + 1) * 256]);

describe("clustering the changed tiles", () => {
  const REGION: Box = [0, 0, 4096, 2304];
  const FIVE_BLOBS = [0, 6, 12, 16, 21].map((column): [number, number] => [column, 0]); // the middle two are the closest pair
  const WIDE_REGION: Box = [0, 0, 8192, 2304];

  test("touching tiles are one blob", () => {
    expect(tileClusters(grid([0, 0], [1, 0], [1, 1]))).toHaveLength(1);
  });

  test("tiles touching only at a corner are one blob", () => {
    expect(tileClusters(grid([0, 0], [1, 1]))).toHaveLength(1);
  });

  test("far apart tiles are separate blobs", () => {
    expect(tileClusters(grid([0, 0], [8, 6]))).toHaveLength(2);
  });

  test("two far changes become two rectangles", () => {
    // The menu bar clock plus a repaint low on the page: one rectangle each, not one across both.
    const rects = reocrRects([...grid([0, 0]), ...grid([12, 7])], REGION, []);
    expect(rects).toEqual([
      [0, 0, 512, 512],
      [2816, 1536, 3584, 2304],
    ]);
  });

  test("blobs that touch once grown become one rectangle", () => {
    expect(reocrRects([...grid([0, 0]), ...grid([3, 0])], REGION, [])).toHaveLength(1);
  });

  test("a line straddling an edge can merge two rectangles", () => {
    const apart = [...grid([0, 0]), ...grid([8, 0])];
    expect(reocrRects(apart, REGION, [])).toHaveLength(2);
    const spanning = [line("a headline running across both", 400, 100, 2000, 140)];
    expect(reocrRects(apart, REGION, spanning)).toHaveLength(1);
  });

  test("more blobs than the cap merge down to it", () => {
    expect(tileClusters(grid(...FIVE_BLOBS))).toHaveLength(5);
    expect(reocrRects(grid(...FIVE_BLOBS), WIDE_REGION, [])).toHaveLength(MAX_REOCR_RECTS);
  });

  test("the closest pair is the one merged", () => {
    const rects = reocrRects(grid(...FIVE_BLOBS), WIDE_REGION, []);
    expect(rects).toContainEqual([2816, 0, 4608, 512]); // columns 12 and 16, the smallest gap, read as one
    expect(rects).toContainEqual([0, 0, 512, 512]); // column 0, further from its neighbour, left alone
  });
});

describe("lines", () => {
  test("boxes intersect only on real overlap", () => {
    expect(boxesIntersect([0, 0, 10, 10], [5, 5, 20, 20])).toBe(true);
    expect(boxesIntersect([0, 0, 10, 10], [10, 0, 20, 10])).toBe(false);
  });

  test("reocr replaces every line the rectangle touches", () => {
    // A line that only straddles the edge goes too: the fresh read covers it whole.
    const previous = [line("stale", 100, 100, 200, 130), line("kept", 900, 900, 1000, 930), line("straddles", 90, 40, 110, 70)];
    const fresh = [line("fresh", 100, 100, 260, 130)];
    const merged = mergeReocr(previous, fresh, [[50, 50, 400, 400]]);
    expect(merged.map(([text]) => text)).toEqual(["kept", "fresh"]);
  });

  test("reocr keeps a line that only touches the rectangle edge", () => {
    const previous = [line("outside", 10, 10, 50, 40)];
    expect(mergeReocr(previous, [], [[50, 10, 400, 400]])).toEqual(previous);
  });

  test("ocr crop reads one rectangle and hands back full-capture coordinates untouched", () => {
    // Vision does the crop and the offset now, inside macos.recognizeText: what is left here is the hand-over.
    const read = spyOn(macos, "recognizeText").mockImplementation(() => [["hello", 0.9, [310, 420, 360, 450]]]);
    const image: Capture = { path: join(dir, "capture.png"), width: 1000, height: 800 };
    expect(ocrCrop(image, [300, 400, 500, 500])).toEqual([["hello", 0.9, [310, 420, 360, 450]]]);
    expect(read.mock.calls).toEqual([[image.path, [300, 400, 500, 500]]]);
  });

  // The offset itself can only be seen through Vision. It reads a file and touches nothing else, so this one runs for real.
  test.skipIf(process.platform !== "darwin")("a crop's boxes come back in full-capture coordinates", async () => {
    spyOn(macos, "recognizeText").mockRestore();
    const path = join(dir, "hello.png");
    const text = (x: number, y: number, word: string) => `<text x="${x}" y="${y}" font-family="Helvetica" font-size="48">${word}</text>`;
    const page = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><rect width="1000" height="800" fill="white"/>`;
    await sharp(Buffer.from(`${page}${text(320, 470, "hello")}${text(40, 100, "elsewhere")}</svg>`))
      .png()
      .toFile(path);
    const image: Capture = { path, width: 1000, height: 800 };
    const whole = ocrCrop(image, [0, 0, 1000, 800]).find(([word]) => word === "hello");
    const cropped = ocrCrop(image, [300, 400, 500, 500]);
    expect(whole).toBeDefined();
    expect(cropped.map(([word]) => word)).toEqual(["hello"]); // the crop, not the capture
    cropped[0]![2].forEach((edge, i) => expect(Math.abs(edge - whole![2][i]!)).toBeLessThan(8)); // and where the whole capture has it
  });
});

describe("the reuse decision", () => {
  /** Record every rectangle handed to Vision, and answer with one line naming it. */
  function recordReads(): Box[] {
    const seen: Box[] = [];
    spyOn(macos, "recognizeText").mockImplementation((_path, rect) => {
      const [x, y] = rect!;
      seen.push(rect!.map(Math.round) as Box);
      return [line(`read ${seen.length}`, x, y, x + 10, y + 10)];
    });
    return seen;
  }

  /** A 2048x1024 capture whose window covers it, so the region is the whole image. */
  const captureOf = async (boxes: Box[] = [], app = "Google Chrome", window: Frame = [0, 0, 1024, 512]) =>
    screenWith(window, { image: await paint([2048, 1024], boxes), app, scale: 2 });

  const texts = (lines: Line[]) => lines.map(([text]) => text);
  const WHOLE: Box = [0, 0, 2048, 1024];

  test("first capture reads the whole region", async () => {
    const reads = recordReads();
    const [lines, pct, rects] = await ocrLines(await captureOf(), new OcrCache());
    expect(reads).toEqual([WHOLE]);
    expect(pct).toBe(100);
    expect(rects).toBe(0); // a full read counts no rectangles
    expect(texts(lines)).toEqual(["read 1"]);
  });

  test("an unchanged capture is not read again", async () => {
    const reads = recordReads();
    const cache = new OcrCache();
    await ocrLines(await captureOf(), cache);
    const [lines, pct, rects] = await ocrLines(await captureOf(), cache);
    expect(reads).toHaveLength(1);
    expect([pct, rects]).toEqual([0, 0]);
    expect(texts(lines)).toEqual(["read 1"]);
  });

  test("a small change reads only the rectangle around it", async () => {
    const reads = recordReads();
    const cache = new OcrCache();
    await ocrLines(await captureOf(), cache);
    const [lines, pct, rects] = await ocrLines(await captureOf([[300, 300, 400, 400]]), cache);
    expect(reads[1]).toEqual([0, 0, 768, 768]);
    expect(pct).toBeLessThan(50);
    expect(rects).toBe(1);
    expect(texts(lines)).toEqual(["read 2"]); // the first read's line sat inside the rectangle
  });

  test("a change over the threshold reads the whole region", async () => {
    const reads = recordReads();
    const cache = new OcrCache();
    await ocrLines(await captureOf(), cache);
    const [, pct, rects] = await ocrLines(await captureOf([WHOLE]), cache);
    expect(reads[1]).toEqual(WHOLE);
    expect([pct, rects]).toEqual([100, 0]);
  });

  test("a different app is never reused", async () => {
    const reads = recordReads();
    const cache = new OcrCache();
    const first = await captureOf();
    await ocrLines(first, cache);
    await ocrLines({ ...first, app: "Slack" }, cache);
    expect(reads).toEqual([WHOLE, WHOLE]);
  });

  test("a moved window is never reused", async () => {
    const reads = recordReads();
    const cache = new OcrCache();
    const first = await captureOf();
    await ocrLines(first, cache);
    await ocrLines({ ...first, window: [20, 0, 1024, 512] }, cache);
    expect(reads).toHaveLength(2);
    expect(reads[1]).toEqual([24, 0, 2048, 1024]); // the moved window's own region, read whole
  });

  test("the rectangle grows past a line it would have cut in half", async () => {
    const reads = recordReads();
    const cache = new OcrCache();
    await ocrLines(await captureOf(), cache);
    cache.lines = [line("a headline running off to the right", 700, 300, 1400, 340)];
    await ocrLines(await captureOf([[300, 300, 400, 400]]), cache);
    expect(reads[1]).toEqual([0, 0, 1400, 768]); // widened to take the whole headline
  });

  test("a rectangle that grows past the threshold reads the whole region", async () => {
    const reads = recordReads();
    const cache = new OcrCache();
    await ocrLines(await captureOf(), cache);
    cache.lines = [line("edge to edge", 0, 300, 2048, 900)];
    const [, pct, rects] = await ocrLines(await captureOf([[300, 300, 400, 400]]), cache);
    expect(reads[1]).toEqual(WHOLE);
    expect([pct, rects]).toEqual([100, 0]);
  });

  test("two far apart changes are read as two crops", async () => {
    // The weakness a single union rectangle has: far apart changes would have spanned the capture.
    const reads = recordReads();
    const cache = new OcrCache();
    await ocrLines(await captureOf(), cache);
    const corners: Box[] = [
      [100, 100, 180, 180],
      [1900, 900, 1980, 980],
    ];
    const [lines, pct, rects] = await ocrLines(await captureOf(corners), cache);
    expect(reads.slice(1)).toEqual([
      [0, 0, 512, 512],
      [1536, 512, 2048, 1024],
    ]);
    expect([rects, pct]).toEqual([2, 25]); // both crops together, where one union rectangle would have been all of it
    expect(texts(lines)).toEqual(["read 2", "read 3"]);
  });

  test("rectangles whose areas add past the threshold read the whole region", async () => {
    // Neither rectangle is over the threshold on its own; together they are, so one read is cheaper.
    const reads = recordReads();
    const cache = new OcrCache();
    await ocrLines(await captureOf(), cache);
    const sides: Box[] = [
      [0, 0, 768, 1024],
      [1792, 0, 2048, 1024],
    ];
    const [, pct, rects] = await ocrLines(await captureOf(sides), cache);
    expect(reads[1]).toEqual(WHOLE);
    expect([pct, rects]).toEqual([100, 0]);
  });

  test("no cache always reads the region", async () => {
    const reads = recordReads();
    await ocrLines(await captureOf());
    await ocrLines(await captureOf());
    expect(reads).toEqual([WHOLE, WHOLE]);
  });
});
