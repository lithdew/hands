/** Match matrix_scene.py: 10% original hold, 30% forward transform,
 * 15% transformed hold, 30% inverse (or singular hold), 15% final hold. */
export function matrixPhaseLabel(frame: number, frames: number, invertible: boolean) {
  const fraction = frame / frames;
  if (fraction < .10) return "Original basis";
  if (fraction < .40) return "Apply A";
  if (!invertible) return "Area collapses · information is lost";
  if (fraction < .55) return "A applied · transformed basis";
  if (fraction < .85) return "Apply A⁻¹ · return to the original";
  return "Original basis restored";
}

/** Fit a measured block of copy into its lane as one unit. Below the legible
 * floor the render is refused instead of clipping or shrinking text that a
 * phone-sized player could no longer show. */
export function fitScale(requiredHeight: number, availableHeight: number, floor = .8, what = "Scene text") {
  if (!Number.isFinite(requiredHeight) || requiredHeight <= 0 || !Number.isFinite(availableHeight) || availableHeight <= 0) throw new Error(`${what} could not be measured`);
  const scale = Math.min(1, availableHeight / requiredHeight);
  if (scale < floor) throw new Error(`${what} exceeds its safe lane (needs ${Math.round(requiredHeight)}px, lane is ${Math.round(availableHeight)}px). Shorten the title, body or bullets before rendering.`);
  return scale;
}

/** Preserve a fixed caption lane. Refuse overloaded copy instead of clipping
 * it or shrinking the smallest matrix text below readable size. */
export function matrixTextScale(requiredHeight: number, availableHeight = 555) {
  return fitScale(requiredHeight, availableHeight, .76, "Matrix scene text");
}

export type InlineMatrix = { rows: string[][] };
const INLINE_MATRIX = /\[\[([^[\]]{1,40})\],\s*\[([^[\]]{1,40})\]\]/g;
/** Split copy so `[[a,b],[c,d]]` notation can be typeset as a two-row matrix
 * instead of nested brackets. Anything that is not exactly 2x2 stays literal. */
export function inlineMatrices(text: string): (string | InlineMatrix)[] {
  const parts: (string | InlineMatrix)[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_MATRIX)) {
    const rows = [match[1]!, match[2]!].map(row => row.split(",").map(cell => cell.trim()));
    if (rows.some(row => row.length !== 2 || row.some(cell => !cell))) continue;
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push({ rows });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** A matrix-scene body that only restates `A = [[…]]  A⁻¹ = [[…]]` duplicates
 * the trusted matrix panel, which already shows the computed values. */
export function bodyRepeatsMatrixPanel(body: string | undefined) {
  if (!body) return false;
  const parts = inlineMatrices(body);
  return parts.some(part => typeof part !== "string") && parts.filter((part): part is string => typeof part === "string").join("").replace(/[A-Z]⁻¹|[A-Z]|[=;,.·\s]/g, "") === "";
}

/** The letter the lesson copy uses for the animated matrix, so the trusted
 * matrix panel does not call a singular example S "A". */
export function matrixLetter(copy: (string | undefined)[], explicit?: string) {
  if (explicit) return explicit;
  const match = copy.filter(Boolean).join(" ").match(/\b([A-Z])\s*=\s*\[\[/);
  return match?.[1] ?? "A";
}
