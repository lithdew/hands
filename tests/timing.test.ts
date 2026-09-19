import { expect, test } from "bun:test";
import { formatTiming, ordered, phase, summarize, type Timing } from "../src/timing.ts";

test("phase records seconds and tolerates none", async () => {
  const timing: Timing = {};
  await phase(timing, "ocr", () => {});
  expect(timing.ocr).toBeGreaterThanOrEqual(0);
  await phase(null, "ocr", () => {});
});

test("phase records even when the block raises", async () => {
  const timing: Timing = {};
  const raising = phase(timing, "act", () => {
    throw new Error("boom");
  });
  await expect(raising).rejects.toThrow("boom");
  expect(timing).toHaveProperty("act");
});

test("ordered puts pipeline phases first then extras", () => {
  const timing = { total: 1.4, mystery: 0.1, ocr: 0.8, capture: 0.3 };
  expect(ordered(timing).map(([name]) => name)).toEqual(["capture", "ocr", "total", "mystery"]);
});

test("format line shows two decimals in pipeline order", () => {
  const line = formatTiming({ total: 1.45, ocr: 0.823, capture: 0.31, decide: 0.21, act: 0.05 });
  expect(line).toBe("  timing: capture 0.31s  ocr 0.82s  decide 0.21s  act 0.05s  total 1.45s");
});

test("format line shows the share of the screen that was ocred", () => {
  const line = formatTiming({ capture: 0.31, ocr: 0.31, ocr_region_pct: 22.4, ocr_rects: 0, total: 0.9 });
  expect(line).toBe("  timing: capture 0.31s  ocr 0.31s (22% of screen)  total 0.90s");
});

test("format line counts the rectangles when the read was split", () => {
  const line = formatTiming({ ocr: 0.31, ocr_region_pct: 22.4, ocr_rects: 2, total: 0.9 });
  expect(line).toBe("  timing: ocr 0.31s (22% of screen, 2 rects)  total 0.90s");
});

test("format line says one rect in the singular", () => {
  expect(formatTiming({ ocr: 0.31, ocr_region_pct: 8.0, ocr_rects: 1 })).toBe("  timing: ocr 0.31s (8% of screen, 1 rect)");
});

test("format line omits act when the step did not act", () => {
  expect(formatTiming({ capture: 0.3, ocr: 0.8, decide: 0.2, act: 0.0, total: 1.3 })).not.toContain("act");
});

test("summarize means and maxes each phase", () => {
  const got = summarize([
    { ocr: 0.8, total: 1.0 },
    { ocr: 0.4, total: 2.0 },
  ]);
  expect(got).toEqual({ steps_timed: 2, mean: { ocr: 0.6, total: 1.5 }, max: { ocr: 0.8, total: 2.0 } });
});

test("summarize averages a phase over the steps that recorded it", () => {
  const got = summarize([{ ocr: 0.8 }, { ocr: 0.4, url: 0.6 }]);
  expect(got.mean).toEqual({ ocr: 0.6, url: 0.6 });
  expect(got.max.url).toBe(0.6);
});

test("summarize of no steps", () => {
  expect(summarize([])).toEqual({ steps_timed: 0, mean: {}, max: {} });
});
