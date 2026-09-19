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

/** Preserve a fixed caption lane. Refuse overloaded copy instead of clipping
 * it or shrinking the smallest matrix text below readable size. */
export const CAPTION_TOP = 560;
export const MATRIX_TEXT_HEIGHT = CAPTION_TOP - 69 - 18;
export function matrixTextScale(requiredHeight: number, availableHeight = MATRIX_TEXT_HEIGHT) {
  if (!Number.isFinite(requiredHeight) || requiredHeight <= 0) throw new Error("Matrix text could not be measured");
  const scale = Math.min(1, availableHeight / requiredHeight);
  if (scale < .76) throw new Error("Matrix scene text exceeds its safe caption margin. Shorten the title, body or bullets before rendering.");
  return scale;
}

export function assertCaptionHeight(requiredHeight: number) {
  if (!Number.isFinite(requiredHeight) || requiredHeight <= 0 || requiredHeight > 54) throw new Error("Caption exceeds two readable lines. Shorten the caption before rendering.");
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
