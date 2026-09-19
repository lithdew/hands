import { expect, test } from "bun:test";
import { type Item, item } from "../src/models.ts";
import { goalEchoes, isEcho, type Line, mergeBlocks, mergeSources, orderItems, toItems } from "../src/perception.ts";

const line = (text: string, x1: number, y1: number, x2: number, y2: number, conf = 1): Line => [text, conf, [x1, y1, x2, y2]];

test("merges stacked lines across columns", () => {
  const lines = [
    line("Kash Patel defends", 1080, 1531, 1300, 1561),
    line("Two House Democrats", 1400, 1531, 1600, 1561),
    line("removing bestiality as", 1075, 1571, 1300, 1601),
    line("defect again on key vote", 1400, 1571, 1600, 1601),
    line("FBI applicants", 1080, 1606, 1300, 1636),
  ];
  const texts = mergeBlocks(lines)
    .map(([text]) => text)
    .sort();
  expect(texts).toEqual(["Kash Patel defends removing bestiality as FBI applicants", "Two House Democrats defect again on key vote"]);
});

test("does not merge far or misaligned lines", () => {
  const lines = [line("Home", 100, 100, 200, 130), line("World", 400, 100, 500, 130), line("Footer", 100, 900, 200, 930)];
  expect(mergeBlocks(lines)).toHaveLength(3);
});

test("merged block keeps min confidence and union box", () => {
  const lines = [line("a", 100, 100, 200, 130, 1.0), line("b", 102, 140, 260, 170, 0.5)];
  expect(mergeBlocks(lines)).toEqual([["a b", 0.5, [100, 100, 260, 170]]]);
});

test("reading order rows then columns", () => {
  const lines = [line("right", 800, 100, 900, 130), line("left", 100, 105, 200, 135), line("below", 100, 300, 200, 330)];
  expect(toItems(lines, 255).map((it) => it.text)).toEqual(["left", "right", "below"]);
});

test("budget caps items", () => {
  const lines = Array.from({ length: 10 }, (_, i) => line(String(i), 100, 100 + 40 * i, 200, 130 + 40 * i));
  expect(toItems(lines, 3)).toHaveLength(3);
});

test("goal echo matches wrapped command lines", () => {
  const goal = "go to cnn and click onto something related to AI on the homepage";
  const echoes = goalEchoes(goal);
  expect(isEcho('clear && uv run clicker "go to cnn and click onto something', echoes)).toBe(true);
  expect(isEcho('related to AI on the homepage" --act', echoes)).toBe(true);
  expect(isEcho("Trending: Trump and AI warnings", echoes)).toBe(false);
});

test("an empty goal echoes nothing", () => {
  for (const goal of ["", "   \n\t"]) {
    const echoes = goalEchoes(goal);
    expect(echoes.size).toBe(0);
    expect(isEcho("Trending: Trump and AI warnings", echoes)).toBe(false);
    expect(isEcho("", echoes)).toBe(false);
  }
});

const ocrItem = (index: number, text: string, x1: number, y1: number, x2: number, y2: number, conf = 0.9): Item =>
  item(index, text, conf, [x1, y1, x2, y2]);

const axItem = (index: number, text: string, x1: number, y1: number, x2: number, y2: number, role = "button"): Item =>
  item(index, text, 1.0, [x1, y1, x2, y2], role, "ax");

const sources = (items: Item[]) => items.map((it) => it.source).sort();

test("merge folds an overlapping control onto the ocr block that names it", () => {
  const block = ocrItem(0, "Register Now", 100, 100, 300, 130);
  const control = axItem(0, "Register Now for Disrupt", 110, 102, 290, 128, "link");
  const merged = mergeSources([block], [control]);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({ source: "ax+ocr", role: "link" });
  expect(merged[0]?.text).toBe("Register Now for Disrupt"); // the longer of the two labels
  expect(merged[0]).toMatchObject({ x1: 100, y1: 100, x2: 300, y2: 130 }); // the OCR box
});

test("merge matches on shared words, not only containment", () => {
  const block = ocrItem(0, "Buy tickets now", 100, 100, 300, 130);
  const control = axItem(0, "Buy tickets", 100, 100, 300, 130);
  expect(mergeSources([block], [control]).map((it) => it.source)).toEqual(["ax+ocr"]);
});

test("merge keeps both when the boxes overlap but the text does not agree", () => {
  const block = ocrItem(0, "Search the docs", 100, 100, 300, 130);
  const control = axItem(0, "Clear input", 100, 100, 300, 130);
  expect(sources(mergeSources([block], [control]))).toEqual(["ax", "ocr"]);
});

test("merge keeps both when the text agrees but the boxes are apart", () => {
  const block = ocrItem(0, "Share", 100, 100, 200, 130);
  const control = axItem(0, "Share", 900, 600, 960, 630);
  expect(sources(mergeSources([block], [control]))).toEqual(["ax", "ocr"]);
});

test("merge consumes each ocr block at most once", () => {
  const block = ocrItem(0, "Send", 100, 100, 200, 130);
  const controls = [axItem(0, "Send", 100, 100, 200, 130), axItem(1, "Send", 104, 104, 196, 126)];
  expect(sources(mergeSources([block], controls))).toEqual(["ax", "ax+ocr"]);
});

test("merge numbers everything in reading order", () => {
  const blocks = [ocrItem(0, "below", 100, 300, 200, 330), ocrItem(1, "right", 800, 100, 900, 130)];
  const controls = [axItem(0, "left", 100, 105, 200, 135)];
  expect(mergeSources(blocks, controls).map((it) => [it.index, it.text])).toEqual([
    [0, "left"],
    [1, "right"],
    [2, "below"],
  ]);
});

test("budget drops the faintest ocr blocks before any control", () => {
  const blocks = [0, 1, 2].map((i) => ocrItem(i, `text ${i}`, 100, 100 + 40 * i, 200, 130 + 40 * i, 0.3 + 0.1 * i));
  const controls = [axItem(0, "Send", 800, 100, 900, 130)];
  const kept = mergeSources(blocks, controls, 2);
  expect(kept.map((it) => it.text).sort()).toEqual(["Send", "text 2"]);
});

test("budget falls back to dropping controls when only controls remain", () => {
  const controls = [0, 1, 2, 3].map((i) => axItem(i, `control ${i}`, 100, 100 + 40 * i, 200, 130 + 40 * i));
  expect(mergeSources([], controls, 2)).toHaveLength(2);
});

test("order items renumbers rows then columns", () => {
  const items = [ocrItem(7, "right", 800, 100, 900, 130), ocrItem(2, "left", 100, 105, 200, 135)];
  expect(orderItems(items).map((it) => [it.index, it.text])).toEqual([
    [0, "left"],
    [1, "right"],
  ]);
});
