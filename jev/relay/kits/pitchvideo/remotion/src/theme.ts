// theme.ts — one brand for every scene: colours, type, and the two curves everything moves on.
import { Easing, interpolate } from "remotion";

export const C = {
  bg: "#070B18", bg2: "#0D1430", panel: "rgba(255,255,255,0.045)", panelEdge: "rgba(255,255,255,0.10)",
  text: "#F3F6FF", muted: "#9AA7C7", faint: "#5C6A8C",
  blue: "#4F8CFF", green: "#3DDC97", amber: "#FFB547", red: "#FF6B7A", violet: "#9B7BFF",
};
export const GRADIENT = `linear-gradient(100deg, ${C.blue} 0%, ${C.green} 100%)`;
export const SANS = `"Ubuntu Sans", "Ubuntu", "Inter", "Segoe UI", system-ui, sans-serif`;
export const MONO = `"Ubuntu Sans Mono", "Ubuntu Mono", "DejaVu Sans Mono", ui-monospace, monospace`;

const OUT = Easing.bezier(0.16, 1, 0.3, 1);
/** 0 -> 1 from `at` over `over` frames, eased out. Everything that enters uses it. */
export const enter = (frame: number, at: number, over = 18) => interpolate(frame, [at, at + over], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: OUT });
/** The usual entrance: fade, rise, settle. */
export const rise = (frame: number, at: number, by = 36, over = 20) => { const t = enter(frame, at, over); return { opacity: t, translate: `0px ${(1 - t) * by}px` }; };
/** Type that would overflow gets smaller instead: the script is data and its lengths vary. */
export const fit = (text: string, size: number, comfortable: number, min = 0.55) => Math.round(size * Math.max(min, Math.min(1, comfortable / Math.max(1, text.length))));
