export type CoordinateSpace = "pixels" | "normalized_1000";
type Point = { x: number; y: number };
type Size = { width: number; height: number };
type Input = {
  action: string; coordinate_space?: CoordinateSpace; x?: number; y?: number;
  actions?: Input[]; strokes?: Point[][];
};

/** Convert only explicitly declared normalized coordinates, against the exact
 * screenshot bound to the action. Legacy inputs remain screenshot pixels. */
export function pixelPoint(point: Point, size: Size, space: CoordinateSpace = "pixels"): Point {
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1) throw new Error("A valid screenshot size is required.");
  const axis = (value: number, extent: number) => {
    if (!Number.isFinite(value) || value < 0) throw new Error("Coordinates must be finite and nonnegative.");
    if (space === "normalized_1000") {
      if (value > 1000) throw new Error("Normalized coordinates must be between 0 and 1000.");
      return Math.min(extent - 1, Math.round(value / 1000 * extent));
    }
    if (!Number.isInteger(value) || value >= extent) throw new Error("Pixel coordinates must be integers inside the current screenshot.");
    return value;
  };
  return { x: axis(point.x, size.width), y: axis(point.y, size.height) };
}

/** Validate the entire batch before returning any executable input. One unit
 * declaration covers every point, including all strokes and batch members. */
export function pixelInput<T extends Input>(input: T, size: Size): Omit<T, "coordinate_space"> & { coordinate_space: "pixels" } {
  const space = input.coordinate_space ?? "pixels";
  const convert = (step: Input): Input => {
    if (["click", "move", "scroll"].includes(step.action)) {
      if (step.x === undefined || step.y === undefined) throw new Error("This action needs both x and y coordinates.");
      return { ...step, ...pixelPoint({ x: step.x, y: step.y }, size, space) };
    }
    return step;
  };
  const resolved = convert(input);
  return { ...resolved, coordinate_space: "pixels",
    ...(input.action === "batch" && input.actions ? { actions: input.actions.map(convert) } : {}),
    ...(input.action === "draw" && input.strokes ? { strokes: input.strokes.map((stroke) => stroke.map((point) => pixelPoint(point, size, space))) } : {}),
  } as Omit<T, "coordinate_space"> & { coordinate_space: "pixels" };
}
