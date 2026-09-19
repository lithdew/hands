// theme.ts — manim's palette and proportions, as 3Blue1Brown's linear algebra videos use them.
export const WIDTH = 1920, HEIGHT = 1080;
/** One unit of the number plane, in pixels; the origin sits at the centre of the frame. */
export const UNIT = 112;
export const COLOR = {
  background: "#0a0a0c",
  staticGrid: "#2a2d33",
  grid: "#29abca",      // BLUE_D: the grid that moves
  gridFaint: "#1c758a", // BLUE_E: its half-way lines
  axis: "#e8e8e8",
  iHat: "#83c167",      // GREEN_C
  jHat: "#fc6255",      // RED_C
  vector: "#ffff00",    // YELLOW
  area: "#ffff00",
  text: "#f2f2f2",
  dim: "#9aa3ad",
  accent: "#58c4dd",    // BLUE_C
  warn: "#fc6255",
} as const;
export const SERIF = "KaTeX_Main, 'CMU Serif', 'Latin Modern Roman', Georgia, serif";

/** manim's `smooth`: ease in and out. `t` is clamped to 0..1 between `from` and `to` (fractions of the scene). */
export function ease(at: number, from: number, to: number): number {
  const t = Math.min(1, Math.max(0, (at - from) / Math.max(1e-6, to - from)));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export type M2 = [[number, number], [number, number]];
export const IDENTITY: M2 = [[1, 0], [0, 1]];
/** Every point travels in a straight line, as manim's ApplyMatrix moves it. */
export const lerpMatrix = (a: M2, b: M2, t: number): M2 => [[a[0][0] + (b[0][0] - a[0][0]) * t, a[0][1] + (b[0][1] - a[0][1]) * t], [a[1][0] + (b[1][0] - a[1][0]) * t, a[1][1] + (b[1][1] - a[1][1]) * t]];
export const applyM = (m: M2, x: number, y: number): [number, number] => [m[0][0] * x + m[0][1] * y, m[1][0] * x + m[1][1] * y];
/** Plane coordinates to pixels. */
export const px = (x: number, y: number): [number, number] => [WIDTH / 2 + x * UNIT, HEIGHT / 2 - y * UNIT];
