import {expect, test} from "bun:test";
import {assertCaptionHeight, CAPTION_TOP, evidencePhase, evidenceTextScale, MATRIX_TEXT_HEIGHT, matrixPhaseLabel, matrixTextScale} from "./layout";

test("matrix overlays follow the actual forward, hold, inverse and final phases", () => {
  expect(matrixPhaseLabel(0, 1000, true)).toBe("Original basis");
  expect(matrixPhaseLabel(100, 1000, true)).toBe("Apply A");
  expect(matrixPhaseLabel(400, 1000, true)).toBe("A applied · transformed basis");
  expect(matrixPhaseLabel(450, 1000, true)).not.toContain("A⁻¹");
  expect(matrixPhaseLabel(549, 1000, true)).not.toContain("A⁻¹");
  expect(matrixPhaseLabel(550, 1000, true)).toContain("Apply A⁻¹");
  expect(matrixPhaseLabel(850, 1000, true)).toBe("Original basis restored");
  for (const frame of [400, 450, 550, 850, 999]) expect(matrixPhaseLabel(frame, 1000, false)).toBe("Area collapses · information is lost");
});

test("matrix text fitting protects the caption lane and refuses unreadable overload", () => {
  expect(matrixTextScale(450)).toBe(1);
  expect(matrixTextScale(600) * 600).toBeLessThanOrEqual(MATRIX_TEXT_HEIGHT);
  expect(() => matrixTextScale(900)).toThrow("Shorten");
  expect(() => matrixTextScale(0)).toThrow("measured");
});

test("caption text stays above playback controls and matrix copy stays above captions", () => {
  expect(CAPTION_TOP + 15 + 54).toBeLessThanOrEqual(630);
  expect(69 + MATRIX_TEXT_HEIGHT).toBeLessThan(CAPTION_TOP);
  expect(() => assertCaptionHeight(53)).not.toThrow();
  expect(() => assertCaptionHeight(79)).toThrow("two readable lines");
});

test("evidence screenshots get the full scene midpoint and retain a separate attribution phase", () => {
  expect(evidencePhase(0, 1000, true)).toBe("artifact");
  expect(evidencePhase(500, 1000, true)).toBe("artifact");
  expect(evidencePhase(619, 1000, true)).toBe("artifact");
  expect(evidencePhase(620, 1000, true)).toBe("details");
  expect(evidencePhase(999, 1000, false)).toBe("artifact");
  expect(evidenceTextScale(400, 450)).toBe(1);
  expect(evidenceTextScale(500, 450) * 500).toBeLessThanOrEqual(450);
  expect(() => evidenceTextScale(600, 450)).toThrow("Shorten");
  expect(() => evidenceTextScale(NaN, 450)).toThrow("measured");
});
