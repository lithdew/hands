import {expect, test} from "bun:test";
import {assertCaptionHeight, bodyRepeatsMatrixPanel, CAPTION_TOP, evidencePhase, evidenceTextScale, fitScale, inlineMatrices, MATRIX_TEXT_HEIGHT, matrixLetter, matrixPhaseLabel, matrixTextScale, PANEL_TOP} from "./layout";

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

test("caption text stays above playback controls and scene copy stays above captions", () => {
  expect(CAPTION_TOP + 15 + 54).toBeLessThanOrEqual(630);
  expect(PANEL_TOP + MATRIX_TEXT_HEIGHT).toBeLessThan(CAPTION_TOP);
  expect(() => assertCaptionHeight(53)).not.toThrow();
  expect(() => assertCaptionHeight(79)).toThrow("two readable lines");
});

test("scene copy fits its lane as one unit and is refused below the legible floor", () => {
  expect(fitScale(400, 462)).toBe(1);
  expect(fitScale(520, 462) * 520).toBeLessThanOrEqual(462);
  expect(() => fitScale(700, 462, .8, "Scene \"formula\" text")).toThrow("formula");
  expect(() => fitScale(NaN, 462)).toThrow("measured");
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

test("inline [[a,b],[c,d]] notation is typeset as a matrix while other brackets stay literal", () => {
  expect(inlineMatrices("A = [[2,1],[1,1]]; det(A) = 1")).toEqual(["A = ", {rows: [["2", "1"], ["1", "1"]]}, "; det(A) = 1"]);
  expect(inlineMatrices("A⁻¹ = (1 / det(A)) [[d,−b],[−c,a]]")).toEqual(["A⁻¹ = (1 / det(A)) ", {rows: [["d", "−b"], ["−c", "a"]]}]);
  expect(inlineMatrices("AA⁻¹ = [[2−1, −2+2],[1−1, −1+2]] = I")).toEqual(["AA⁻¹ = ", {rows: [["2−1", "−2+2"], ["1−1", "−1+2"]]}, " = I"]);
  expect(inlineMatrices("x = (1,2)ᵀ and [[1,2,3],[4,5,6]] stays")).toEqual(["x = (1,2)ᵀ and [[1,2,3],[4,5,6]] stays"]);
});

test("a body that only restates the trusted matrix panel is dropped beside the animation", () => {
  expect(bodyRepeatsMatrixPanel("A = [[2,1],[1,1]]    A⁻¹ = [[1,−1],[−1,2]]")).toBe(true);
  expect(bodyRepeatsMatrixPanel("S = [[1,2],[2,4]]; det(S) = 0. The columns are dependent.")).toBe(false);
  expect(bodyRepeatsMatrixPanel("Apply A, then undo it.")).toBe(false);
  expect(bodyRepeatsMatrixPanel(undefined)).toBe(false);
});

test("the trusted matrix panel is named after the letter the lesson copy uses", () => {
  expect(matrixLetter(["S = [[1,2],[2,4]]; det(S) = 0"])).toBe("S");
  expect(matrixLetter(["A = [[2,1],[1,1]]    A⁻¹ = [[1,−1],[−1,2]]"])).toBe("A");
  expect(matrixLetter(["Apply the map, then undo it"])).toBe("A");
  expect(matrixLetter(["S = [[1,2],[2,4]]"], "M")).toBe("M");
});
