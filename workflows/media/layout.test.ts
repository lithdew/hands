import {expect, test} from "bun:test";
import {matrixPhaseLabel, matrixTextScale} from "./layout";

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
  expect(matrixTextScale(620) * 620).toBeLessThanOrEqual(555);
  expect(() => matrixTextScale(900)).toThrow("Shorten");
  expect(() => matrixTextScale(0)).toThrow("measured");
});
