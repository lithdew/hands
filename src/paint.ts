/**
 * Poses as a picture: the primitives feed.cs draws, in the pixels of a tile's well.
 *
 * feed.cs knows how to draw a pointer, a ring, a rectangle, a line, a tag; it does not know why. Everything a
 * person would call the design is here, where it is tested with no window: how far a ripple has spread, that a
 * right click is dashed, that a control pressed in place flashes its rectangle and has no ripple, that going
 * somewhere is a chip along the bottom edge and moves no pointer.
 *
 * Positions come from the frame through the fit. Sizes do not: the pointer is 18 px and its tag 10 px in a small
 * tile and on a whole screen alike. feed.cs puts a dark stroke under every coloured one and a white edge on the
 * pointer, so a pastel reads on a white page and on a black one.
 */
import type { XY } from "./cursor.ts";
import { partToPixels, type PixelRect, sayAddress, toPixels } from "./fit.ts";
import { easeOut, type Effect, type Pose } from "./timeline.ts";

const CHIP_HEIGHT = 18;
const HALO_RADIUS = 13;

const n = (value: number): string => String(Math.round(value * 10) / 10);
const a = (value: number): string => String(Math.round(Math.min(1, Math.max(0, value)) * 100) / 100);
const hex = (color: string): string => color.replace(/^#/, "");
/** Words cross the pipe as base64: a line is split on spaces and semicolons, and what a user types has both. */
const words = (text: string): string => (text ? Buffer.from(text, "utf8").toString("base64") : "-");
const points = (path: XY[]): string => path.map((p) => `${n(p.x)},${n(p.y)}`).join(" ");

/** The whole picture of one tile at one moment, as one `draw` argument. Empty when there is nothing to show. */
export function paint(poses: Pose[], fit: PixelRect, options: { reducedMotion?: boolean } = {}): string {
  const reduced = Boolean(options.reducedMotion);
  const out: string[] = [];
  // Under the pointers: what happened to the page. Over them: nothing, so a pointer is never hidden by another hand's ripple.
  let chips = 0;
  for (const pose of poses) for (const effect of pose.effects) out.push(...(effect.kind === "chip" ? chip(pose, effect, fit, chips++) : effects(pose, effect, fit, reduced)));
  for (const pose of poses) if (pose.opacity > 0) out.push(...pointer(pose, fit));
  return out.join(";");
}

function effects(pose: Pose, effect: Effect, fit: PixelRect, reduced: boolean): string[] {
  const p = effect.progress;
  const color = hex(pose.color);
  if (effect.kind === "ripple" && effect.x !== undefined && effect.y !== undefined) {
    const at = toPixels({ x: effect.x, y: effect.y }, fit);
    const radius = 5 + 17 * (reduced ? 1 : easeOut(p));
    return [`disc ${n(at.x)} ${n(at.y)} ${n(radius)} ${a(0.22 * (1 - p))} ${color}`, `ring ${n(at.x)} ${n(at.y)} ${n(radius)} 2 ${a(1 - p)} ${color} ${effect.button === "right" ? 1 : 0}`];
  }
  if (effect.kind === "rect" && effect.rect) {
    const r = partToPixels(effect.rect, fit);
    const grown = { x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 };
    const alpha = Math.min(1, p / 0.08) * Math.min(1, (1 - p) / 0.3);
    // A control operated by pattern flashes once: that is the whole action. A field being typed into keeps a soft light.
    const fill = effect.tone === "control" ? 0.3 * Math.max(0, 1 - p / 0.45) : 0.1 * alpha;
    return [`rect ${n(grown.x)} ${n(grown.y)} ${n(grown.w)} ${n(grown.h)} ${a(alpha)} ${a(fill)} ${color}`];
  }
  if (effect.kind === "trail" && effect.path && effect.path.length >= 2) {
    const path = effect.path.map((point) => toPixels(point, fit));
    const spans = path.slice(1).map((point, i) => Math.hypot(point.x - path[i]!.x, point.y - path[i]!.y));
    let left = spans.reduce((sum, d) => sum + d, 0) * (effect.drawn ?? 1);
    const shown: XY[] = [path[0]!];
    for (let i = 0; i < spans.length && left > 0; i++) {
      const k = Math.min(1, left / (spans[i]! || 1));
      shown.push({ x: path[i]!.x + (path[i + 1]!.x - path[i]!.x) * k, y: path[i]!.y + (path[i + 1]!.y - path[i]!.y) * k });
      left -= spans[i]!;
    }
    return shown.length >= 2 ? [`line ${a(1 - p)} 2.5 ${color} ${points(shown)}`] : [];
  }
  if (effect.kind === "scroll" && effect.x !== undefined && effect.y !== undefined) {
    // Three chevrons beside the pointer, drifting the way the content was asked to go.
    const at = toPixels({ x: effect.x, y: effect.y }, fit);
    const [dx, dy] = ({ up: [0, -1], left: [-1, 0], right: [1, 0] } as Record<string, [number, number]>)[effect.text ?? ""] ?? [0, 1];
    const drift = (reduced ? 0.5 : easeOut(p)) * 16;
    const cx = at.x + 28 * (dx === 0 ? 1 : 0);
    const cy = at.y + 28 * (dy === 0 ? 1 : 0);
    return [0, 1, 2].map((i) => {
      const k = drift + (i - 1) * 8;
      const x = cx + dx * k;
      const y = cy + dy * k;
      const chevron = [{ x: x - 6 * dy - 3 * dx, y: y - 6 * dx - 3 * dy }, { x: x + 3 * dx, y: y + 3 * dy }, { x: x + 6 * dy - 3 * dx, y: y + 6 * dx - 3 * dy }]; // prettier-ignore
      return `line ${a((1 - p) * (0.45 + 0.27 * i))} 2 ${color} ${points(chevron)}`;
    });
  }
  if (effect.kind === "scan") {
    // A model is given the picture: a band of the hand's colour passes down it once.
    const y = fit.y + fit.h * (reduced ? 0.5 : p);
    const top = Math.max(fit.y, y - Math.min(34, fit.h / 4));
    const alpha = Math.min(1, p / 0.1) * Math.min(1, (1 - p) / 0.2);
    return y - top >= 1 ? [`band ${n(fit.x)} ${n(y)} ${n(fit.w)} ${n(y - top)} ${a(alpha)} ${color}`] : [];
  }
  return [];
}

/** Going somewhere is not pointing at something: no pointer moves, a chip says where. Along the bottom edge, since a page keeps what matters at its top. */
function chip(pose: Pose, effect: Effect, fit: PixelRect, index: number): string[] {
  const p = effect.progress;
  const alpha = Math.min(1, p / 0.08) * Math.min(1, (1 - p) / 0.2);
  const slide = (1 - Math.min(1, p / 0.08)) * -6;
  const label = `${pose.label} ${effect.tone === "open" ? "opens" : effect.tone === "menu" ? "≡" : "→"}`;
  const said = effect.tone === "navigate" ? sayAddress(effect.text ?? "") : (effect.text ?? "");
  const bottom = fit.y + fit.h - 6 - slide - index * (CHIP_HEIGHT + 4);
  return [`chip ${n(fit.x + fit.w / 2)} ${n(bottom)} ${n(Math.min(260, fit.w - 28))} ${a(alpha)} ${hex(pose.color)} ${effect.tone === "navigate" ? "middle" : "start"} ${words(label)} ${words(said)}`];
}

function pointer(pose: Pose, fit: PixelRect): string[] {
  const tip = toPixels(pose, fit);
  const color = hex(pose.color);
  const out: string[] = [];
  // The ring is the state: it breathes while the hand thinks, holds amber while it needs the user. The body never changes colour.
  if (pose.halo > 0) {
    out.push(`disc ${n(tip.x + 3)} ${n(tip.y + 5)} ${HALO_RADIUS} ${a(pose.opacity * 0.16 * pose.halo)} ${hex(pose.accent)}`);
    out.push(`ring ${n(tip.x + 3)} ${n(tip.y + 5)} ${HALO_RADIUS} 1.6 ${a(pose.opacity * Math.min(1, pose.halo))} ${hex(pose.accent)} 0`);
  }
  if (pose.spin !== null) out.push(`arc ${n(tip.x + 3)} ${n(tip.y + 5)} ${HALO_RADIUS} ${n(pose.spin * 360)} 234 2 ${a(pose.opacity)} ${color}`);
  out.push(`pointer ${n(tip.x)} ${n(tip.y)} ${a(pose.opacity)} ${a(pose.scale)} ${pose.shape} ${color}`);
  // The tag: who, and for a moment what. Text being typed keeps its end in view, a caption its start.
  out.push(`tag ${n(tip.x)} ${n(tip.y)} ${a(pose.opacity)} ${color} ${hex(pose.accent)} ${a(pose.noteOpacity)} ${pose.caret ? 1 : 0} ${pose.caret ? "end" : "start"} ${words(pose.label)} ${words(pose.noteOpacity > 0 ? pose.note : "")}`);
  return out;
}
