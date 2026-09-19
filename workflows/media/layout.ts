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

/** Frame lanes (1280x720). Copy lives in one panel above a reserved caption
 * band; the band ends above desktop player controls so screenshots stay legible. */
export const PANEL_TOP = 70;
export const CAPTION_TOP = 548;
export const MATRIX_TEXT_HEIGHT = CAPTION_TOP - PANEL_TOP - 16;
export const CAPTION_MAX_HEIGHT = 70;

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
export function matrixTextScale(requiredHeight: number, availableHeight = MATRIX_TEXT_HEIGHT) {
  return fitScale(requiredHeight, availableHeight, .76, "Matrix scene text");
}

export function assertCaptionHeight(requiredHeight: number) {
  if (!Number.isFinite(requiredHeight) || requiredHeight <= 0 || requiredHeight > CAPTION_MAX_HEIGHT) throw new Error("Caption exceeds two readable lines. Shorten the caption before rendering.");
}

/** Keep the scene midpoint on the actual artifact, then give its supplied
 * evidence a separate readable panel rather than shrinking both side by side. */
export function evidencePhase(frame: number, frames: number, hasDetails: boolean) {
  return hasDetails && frame / frames >= .62 ? "details" : "artifact";
}

export function evidenceTextScale(requiredHeight: number, availableHeight: number) {
  if (!Number.isFinite(requiredHeight) || requiredHeight <= 0 || !Number.isFinite(availableHeight) || availableHeight <= 0) throw new Error("Evidence text could not be measured");
  const scale = Math.min(1, availableHeight / requiredHeight);
  if (scale < .85) throw new Error("Evidence scene text exceeds its readable panel. Shorten the title, body, bullets or evidence before rendering.");
  return scale;
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

/** Workflow node labels are set at 39px only when they fit their box on one
 * line; otherwise 30px, whose two lines (66px) still fit the 67px label box.
 * A 4-node layout has 196px of label width, so a 13-character label at 39px
 * (about 0.56em per character) would wrap into 86px and be refused at render. */
export function workflowLabelSize(label: string, boxWidth: number, large = 39, small = 30, emPerChar = .56) {
  return label.length * emPerChar * large <= boxWidth ? large : small;
}

/** Task-field items (motion.tsx Tasks) sit in boxes that narrow along the
 * diagonal path and shrink past four items. Step the type down the ladder
 * until the wrapped lines fit the box, so copy the storyboard schema accepted
 * is never refused at render; null means no rung fits and the schema rejects it. */
export const TASK_SIZES = [52, 44, 38, 33, 28] as const;
export function taskBox(count: number, index: number) {
  return { width: 1195 - (555 + (index % 3) * 48) - 30, height: count > 4 ? 49 : 69 };
}
export function taskLabelSize(task: string, count: number, index: number, emPerChar = .58): number | null {
  const { width, height } = taskBox(count, index);
  for (const size of TASK_SIZES) {
    if (count > 4 && size > 33) continue;
    const lines = Math.ceil(task.length * emPerChar * size / width);
    if (lines * size * 1.06 <= height) return size;
  }
  return null;
}

/** The letter the lesson copy uses for the animated matrix, so the trusted
 * matrix panel does not call a singular example S "A". */
export function matrixLetter(copy: (string | undefined)[], explicit?: string) {
  if (explicit) return explicit;
  const match = copy.filter(Boolean).join(" ").match(/\b([A-Z])\s*=\s*\[\[/);
  return match?.[1] ?? "A";
}
