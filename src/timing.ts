/** Phase stopwatches: seconds per phase in a plain record. */

export type Timing = Record<string, number>;

export const PHASE_ORDER = ["capture", "screenshot", "app", "window", "field", "url", "ocr", "ax", "decide", "act", "total"];
// Neither of these is seconds: both print on the ocr phase rather than as phases of their own.
export const OCR_REGION_PCT = "ocr_region_pct"; // share of the capture handed to Vision
export const OCR_RECTS = "ocr_rects"; // how many rectangles it took, 0 for a full read or for nothing to read
export const EXTRAS = [OCR_REGION_PCT, OCR_RECTS];

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Record the seconds spent in `fn` under `name`. A null record makes this a plain call. */
export async function phase<T>(timing: Timing | null | undefined, name: string, fn: () => T | Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    if (timing) timing[name] = round3((performance.now() - started) / 1000);
  }
}

/** Known phases first, in pipeline order, then anything unexpected. */
export function ordered(timing: Timing): [string, number][] {
  const known = PHASE_ORDER.filter((name) => name in timing).map((name): [string, number] => [name, timing[name]!]);
  return [...known, ...Object.entries(timing).filter(([name]) => !PHASE_ORDER.includes(name))];
}

/**
 * One log line. A zero `act` means the step never acted, so it is left out.
 *
 * What Vision was given rides on the `ocr` phase: `ocr 0.31s (22% of screen, 2 rects)`. The rect
 * count is left off a full read and a step with nothing to re-read, where it says nothing.
 */
export function formatTiming(timing: Timing): string {
  const shown = ordered(timing).filter(([name, s]) => !EXTRAS.includes(name) && !(name === "act" && s === 0));
  const parts = shown.map(([name, seconds]) => `${name} ${seconds.toFixed(2)}s${name === "ocr" ? ocrNote(timing) : ""}`);
  return `  timing: ${parts.join("  ")}`;
}

/** What the ocr phase read, in parentheses, or nothing when the step did not record it. */
export function ocrNote(timing: Timing): string {
  const pct = timing[OCR_REGION_PCT];
  if (pct === undefined) return "";
  const rects = Math.trunc(timing[OCR_RECTS] ?? 0);
  return ` (${pct.toFixed(0)}% of screen${rects ? `, ${rects} rect${rects === 1 ? "" : "s"})` : ")"}`;
}

/** Mean and max per phase over the steps that recorded it. */
export function summarize(timings: Timing[]) {
  const names = ordered(Object.fromEntries(timings.flatMap((t) => Object.keys(t)).map((k) => [k, 0]))).map(([name]) => name);
  const mean: Timing = {};
  const max: Timing = {};
  for (const name of names) {
    const seen = timings.filter((t) => name in t).map((t) => t[name]!);
    mean[name] = round3(seen.reduce((a, b) => a + b, 0) / seen.length);
    max[name] = round3(Math.max(...seen));
  }
  return { steps_timed: timings.length, mean, max };
}
