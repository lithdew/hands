import { expect, test } from "bun:test";
import { blocks, gist, inline, text, words } from "../src/ui/text.ts";

const WIKI = "Read [Wikipedia’s circuit breaker page](https://en.wikipedia.org/wiki/Circuit_breaker_design_pattern) and left it open.\n\n### Key points\n- **Closed**: calls pass through\n- **Open**: calls fail fast\n- **Half-open**: a trial call decides";

test("a card shows the first paragraph, with links as their words", () => {
  expect(gist(WIKI)).toBe("Read Wikipedia’s circuit breaker page and left it open.");
});

test("the sheet gets every block: a heading, and list items with their bold kept apart", () => {
  const read = blocks(WIKI);
  expect(read.map((block) => block.kind)).toEqual(["p", "h", "li", "li", "li"]);
  expect(words(read[1]!)).toBe("Key points");
  expect(read[2]!.marker).toBe("•");
  expect(read[2]!.runs).toEqual([
    { text: "Closed", bold: true },
    { text: ": calls pass through", bold: false },
  ]);
});

test("a paragraph that ends in a colon brings its list to the card, as bullets", () => {
  expect(gist("Created the formula-driven workbook:\n- Inputs sheet\n- Model sheet\n\nSaved it to Documents.")).toBe("Created the formula-driven workbook:\n• Inputs sheet\n• Model sheet");
  expect(gist("**Options**\n* Kayak\n* Skyscanner")).toBe("Options\n• Kayak\n• Skyscanner");
  expect(gist("It is done.\n- a stray list")).toBe("It is done.");
});

test("a heading leads in, and numbered lists keep their numbers", () => {
  expect(gist("## Lunch pick\nDishoom, King's Cross: **£28** for two.\n\nBooked for 1pm.")).toBe("Lunch pick\nDishoom, King's Cross: £28 for two.");
  expect(gist("1. Opened Kayak\n2) Searched HKG to SFO\n\nCheapest: US$2,378.")).toBe("1. Opened Kayak\n2. Searched HKG to SFO");
  expect(gist("Summary\n=======\nAll good.")).toBe("Summary\nAll good.");
});

test("a table becomes its header row and a line per row", () => {
  const table = "| Airline | Price | Stops |\n|:--|--:|---|\n| STARLUX | US$2,378 | 1 |\n| Cathay Pacific | US$3,440 | 0 |";
  expect(text(table)).toBe("Airline · Price · Stops\n• STARLUX · US$2,378 · 1\n• Cathay Pacific · US$3,440 · 0");
  expect(gist(table)).toBe("Airline · Price · Stops\n• STARLUX · US$2,378 · 1\n• Cathay Pacific · US$3,440 · 0");
});

test("a line break inside a paragraph is kept; spaces are made single", () => {
  expect(text("Price:   $10\nAirline: STARLUX  ")).toBe("Price: $10\nAirline: STARLUX");
  expect(blocks("one\ntwo\n\nthree")).toHaveLength(2);
});

test("emphasis goes, but never from inside a word or a sum", () => {
  expect(text("*Note*: _this_ matters")).toBe("Note: this matters");
  expect(text("Saved report_final_v2.xlsx, and 2*3*4 = 24")).toBe("Saved report_final_v2.xlsx, and 2*3*4 = 24");
  expect(text("~~old~~ new")).toBe("old new");
});

test("code comes through as it was written", () => {
  expect(text("Run `bun test` and `**not bold**`")).toBe("Run bun test and **not bold**");
  expect(text("```\nconst a = **b**;\n```")).toBe("const a = **b**;");
});

test("escapes, entities and simple tags", () => {
  expect(text("1\\. not a list, \\*not emphasis\\*")).toBe("1. not a list, *not emphasis*");
  expect(text("Tom &amp; Jerry&#39;s<br>next line &#x2014; <b>bold</b>")).toBe("Tom & Jerry's\nnext line — bold");
  expect(text("> quoted, and ## not a heading")).toBe("quoted, and ## not a heading");
});

test("a tag it does not know is left as text, to be shown and never run", () => {
  expect(text('<script>alert("x")</script> <img src=x onerror=alert(1)>')).toBe('<script>alert("x")</script> <img src=x onerror=alert(1)>');
});

test("addresses: a link's words, an image's description, a bare address made short", () => {
  expect(text("[Circuit breaker](https://en.wikipedia.org/wiki/Circuit_(design)) and ![a chart](chart.png)")).toBe("Circuit breaker and a chart");
  expect(text("See https://www.example.com/flights.")).toBe("See example.com/flights.");
  expect(text("At <https://example.com/a/very/long/path/that/goes/on/and/on?query=1>")).toBe(`At ${"example.com/a/very/long/path/that/goes/on/and/on?query=1".slice(0, 39)}…`);
});

test("rules, blank lines and empty items leave nothing behind", () => {
  expect(blocks("")).toEqual([]);
  expect(gist("")).toBe("");
  expect(text("one\n\n---\n\n-   \n\ntwo")).toBe("one\ntwo");
});

test("inline pieces are runs, bold or not", () => {
  expect(inline("a **b** c __d__")).toEqual([
    { text: "a ", bold: false },
    { text: "b", bold: true },
    { text: " c ", bold: false },
    { text: "d", bold: true },
  ]);
});
