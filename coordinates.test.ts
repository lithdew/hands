import { expect, test } from "bun:test";
import { pixelInput, pixelPoint } from "./coordinates";

const frame = { width: 1342, height: 891 };

test("declared normalized points scale both axes using the captured image", () => {
  expect(pixelPoint({ x: 310, y: 80 }, frame, "normalized_1000")).toEqual({ x: 416, y: 71 });
  expect(pixelPoint({ x: 310.5, y: 81.9 }, frame, "normalized_1000")).toEqual({ x: 417, y: 73 });
  expect(pixelPoint({ x: 0, y: 1000 }, frame, "normalized_1000")).toEqual({ x: 0, y: 890 });
  expect(pixelPoint({ x: 1000, y: 1000 }, { width: 1, height: 1 }, "normalized_1000")).toEqual({ x: 0, y: 0 });
});

test("pixel input stays literal regardless of the model and is never inferred from its range", () => {
  expect(pixelPoint({ x: 310, y: 80 }, frame)).toEqual({ x: 310, y: 80 });
  expect(pixelInput({ action: "click", x: 310, y: 80 }, frame)).toEqual({ action: "click", x: 310, y: 80, coordinate_space: "pixels" });
});

test("normalized batch points and paths share one declaration without mutating the proposal", () => {
  const batch = { action: "batch", coordinate_space: "normalized_1000" as const, actions: [
    { action: "click", x: 310, y: 80 }, { action: "type", text: "cat" }, { action: "scroll", x: 500, y: 500, dy: 2 },
  ] };
  const before = structuredClone(batch);
  expect(pixelInput(batch, frame).actions).toEqual([
    { action: "click", x: 416, y: 71 }, { action: "type", text: "cat" }, { action: "scroll", x: 671, y: 446, dy: 2 },
  ]);
  expect(batch).toEqual(before);
  expect(pixelInput({ action: "draw", coordinate_space: "normalized_1000", strokes: [[{ x: 310, y: 80 }, { x: 500, y: 500 }], [{ x: 0, y: 0 }, { x: 1000, y: 1000 }]] }, frame).strokes)
    .toEqual([[{ x: 416, y: 71 }, { x: 671, y: 446 }], [{ x: 0, y: 0 }, { x: 1341, y: 890 }]]);
});

test("invalid later points reject the whole batch and out-of-range values never clamp to a target", () => {
  for (const x of [-1, 1000.1, Infinity, NaN]) expect(() => pixelPoint({ x, y: 0 }, frame, "normalized_1000")).toThrow();
  for (const x of [-1, 0.5, 1342, Infinity, NaN]) expect(() => pixelPoint({ x, y: 0 }, frame)).toThrow();
  expect(() => pixelPoint({ x: 0, y: 891 }, frame)).toThrow();
  expect(() => pixelInput({ action: "batch", coordinate_space: "normalized_1000", actions: [{ action: "click", x: 310, y: 80 }, { action: "move", x: 1001, y: 1 }] }, frame)).toThrow("between 0 and 1000");
  expect(() => pixelInput({ action: "draw", strokes: [[{ x: 1, y: 1 }, { x: 1342, y: 1 }]] }, frame)).toThrow("inside");
  expect(() => pixelInput({ action: "click", x: 1 }, frame)).toThrow("both");
});
