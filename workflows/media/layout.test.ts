import {expect, test} from "bun:test";
import {bodyRepeatsMatrixPanel, fitScale, inlineMatrices, matrixLetter, matrixPhaseLabel, matrixTextScale} from "./layout";

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

test("scene copy fits its lane as one unit and is refused below the legible floor", () => {
  expect(fitScale(400, 505)).toBe(1);
  expect(fitScale(560, 505) * 560).toBeLessThanOrEqual(505);
  expect(() => fitScale(700, 505, .8, "Scene \"formula\" text")).toThrow("formula");
  expect(() => fitScale(NaN, 505)).toThrow("measured");
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
