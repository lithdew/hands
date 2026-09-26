import { expect, test } from "bun:test";
import { type Item, item } from "../src/models.ts";
import { goalEchoes, isEcho, type Line, mergeBlocks, mergeSources, onCapture, orderItems, pageTop, stillAs, type Thumb, toAxItems, toItems } from "../src/perception.ts";
import { screen } from "./helpers.ts";

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

test("where OCR is noisy, a control keeps its own label and a glyph read off its icon is dropped", () => {
  const blocks = [ocrItem(0, "Ifi Home", 100, 100, 300, 130), ocrItem(1, "x", 905, 102, 915, 128), ocrItem(2, "OK", 600, 400, 640, 430)];
  const controls = [axItem(0, "Home", 110, 102, 290, 128, "tab"), axItem(1, "Close", 900, 100, 930, 130)];
  const noisy = mergeSources(blocks, controls, 255, { noisyOcr: true }).map((it) => [it.text, it.source]);
  expect(noisy).toEqual([["Home", "ax+ocr"], ["Close", "ax"], ["OK", "ocr"]]); // a short word off every control stays
  const clean = mergeSources(blocks, controls, 255, { noisyOcr: false }).map((it) => it.text);
  expect(clean).toEqual(["Ifi Home", "Close", "x", "OK"]); // the Mac: the longer label, and every block
});

test("where OCR is noisy, short text inside a big control is real and stays: a count in a row, a line in a document", () => {
  const blocks = [ocrItem(0, "5", 560, 210, 572, 234), ocrItem(1, "42", 60, 300, 84, 324), ocrItem(2, "c", 1004, 12, 1016, 30)];
  const controls = [axItem(0, "Inbox", 40, 200, 600, 244, "row"), axItem(1, "Text editor", 40, 120, 1200, 900, "textarea"), axItem(2, "Reload", 995, 5, 1025, 37)];
  const kept = mergeSources(blocks, controls, 255, { noisyOcr: true }).map((it) => [it.text, it.source]);
  expect(kept).toContainEqual(["5", "ocr"]);
  expect(kept).toContainEqual(["42", "ocr"]);
  expect(kept).not.toContainEqual(["c", "ocr"]); // the glyph read off the Reload icon still goes
});

test("a field's value survives the merge", () => {
  const control = { ...axItem(0, "Search", 100, 100, 300, 130, "field"), value: "cheap flights" };
  expect(mergeSources([ocrItem(0, "Search", 100, 100, 300, 130)], [control])[0]).toMatchObject({ text: "Search", value: "cheap flights" });
  const node = { role: "AXTextField", label: "To", x: 10, y: 20, w: 100, h: 20, pressable: true, value: "Julia" };
  expect(toAxItems([node], 2)[0]).toMatchObject({ text: "To", role: "field", value: "Julia" });
});

test("a browser's page begins under its toolbar, and under its bookmarks bar when it shows one", () => {
  const address = axItem(0, "Address and search bar", 200, 80, 900, 110, "field");
  const toolbar = [axItem(1, "Back", 20, 80, 60, 110), address, axItem(2, "Extensions", 1000, 80, 1040, 110)];
  const bookmarks = [axItem(3, "Unnamed bookmark for https://github.com", 20, 125, 60, 155), axItem(4, "All Bookmarks", 1000, 125, 1100, 155)];
  const page = [axItem(5, "Sign in", 900, 200, 980, 230), axItem(6, "Bookmarks", 20, 130, 120, 150, "link")];
  expect(pageTop([...toolbar, ...bookmarks, ...page])).toBe(155);
  expect(pageTop([...toolbar, page[0]!, page[1]!])).toBe(110); // a page's own "Bookmarks" link is not the bar
  expect(pageTop(page)).toBeNull(); // no address bar: nothing is taken for the browser's own
});

test("an item whose centre lies off the capture is not on it", () => {
  const live = screen(); // 2000x1200
  expect(onCapture(live, ocrItem(0, "in", 10, 10, 50, 30))).toBe(true);
  expect(onCapture(live, ocrItem(0, "above", 10, -80, 50, -40))).toBe(false);
  expect(onCapture(live, ocrItem(0, "right", 1990, 10, 2100, 30))).toBe(false);
});

test("two glances are alike unless a patch of them changed", () => {
  const grey = (width: number, height: number, value = 128): Thumb => ({ data: new Uint8Array(width * height).fill(value), width, height });
  const [before, after] = [grey(64, 64), grey(64, 64)];
  expect(stillAs(after, before)).toBe(true);
  after.data.fill(255, 0, 64 * 8); // the top rows lit: a banner came down
  expect(stillAs(after, before)).toBe(false);
  expect(stillAs(grey(64, 32), before)).toBe(false); // the window was resized
});

test("order items renumbers rows then columns", () => {
  const items = [ocrItem(7, "right", 800, 100, 900, 130), ocrItem(2, "left", 100, 105, 200, 135)];
  expect(orderItems(items).map((it) => [it.index, it.text])).toEqual([
    [0, "left"],
    [1, "right"],
  ]);
});
