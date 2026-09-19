// parts.tsx — what every scene shares: the frame (brand, section label, caption, sources, progress), icons, cards.
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { sentencesOf, words, type Icon as IconName, type Scene } from "../../script";
import { C, GRADIENT, MONO, SANS, enter, rise } from "./theme";

const PATHS: Record<IconName, string> = {
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z M5 11a7 7 0 0 0 14 0 M12 18v3",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  brain: "M12 4a4 4 0 0 0-4 4 4 4 0 0 0-2 7 4 4 0 0 0 6 3 4 4 0 0 0 6-3 4 4 0 0 0-2-7 4 4 0 0 0-4-4z M12 4v14 M8 11h2 M14 9h2 M14 14h2",
  window: "M3 5h18v14H3z M3 9h18 M6 7h.01 M9 7h.01",
  cursor: "M5 3l14 7-6 2-2 6z",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  layers: "M12 3l9 5-9 5-9-5z M3 12.5l9 5 9-5 M3 16.5l9 5 9-5",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2",
  check: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M8 12l3 3 5-6",
  mail: "M3 6h18v12H3z M3 7l9 6 9-6",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18",
  list: "M8 6h13 M8 12h13 M8 18h13 M3.5 6h.01 M3.5 12h.01 M3.5 18h.01",
  target: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 11.5a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1z",
  route: "M6 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M18 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M8 17h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7",
  lock: "M6 11h12v9H6z M8 11V8a4 4 0 0 1 8 0v3",
  code: "M8 7l-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16",
  chart: "M4 20V4 M4 20h16 M8 16v-5 M12 16V8 M16 16v-9",
  user: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M4 21a8 8 0 0 1 16 0",
  spark: "M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z",
};

export const Icon: React.FC<{ name?: string; size?: number; color?: string }> = ({ name, size = 40, color = C.text }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d={PATHS[(name ?? "spark") as IconName] ?? PATHS.spark} />
  </svg>
);

/** An icon on the brand's tile. `tone` tints it: a pain is red, a result is green. */
export const Tile: React.FC<{ icon?: string; size?: number; tone?: string }> = ({ icon, size = 84, tone }) => (
  <div style={{ width: size, height: size, borderRadius: size * 0.28, background: tone ? `${tone}22` : GRADIENT, border: tone ? `2px solid ${tone}66` : "none", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: tone ? "none" : "0 8px 20px rgba(79,140,255,0.30)" }}>
    <Icon name={icon} size={size * 0.54} color={tone ?? "#06122B"} />
  </div>
);

export const Panel: React.FC<{ style?: React.CSSProperties; children: React.ReactNode }> = ({ style, children }) => (
  <div style={{ background: C.panel, border: `1.5px solid ${C.panelEdge}`, borderRadius: 28, padding: 40, boxShadow: "0 12px 28px rgba(0,0,0,0.30)", ...style }}>{children}</div>
);

export const Mark: React.FC<{ size?: number }> = ({ size = 56 }) => (
  <div style={{ width: size, height: size, borderRadius: size * 0.3, background: GRADIENT, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 8px 20px rgba(61,220,151,0.30)" }}>
    <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="#06122B"><path d="M5 3l14 7-6 2-2 6z" /></svg>
  </div>
);

/** The narration, a sentence at a time, each on screen for its share of the words. */
const Caption: React.FC<{ narration: string; frames: number }> = ({ narration, frames }) => {
  const frame = useCurrentFrame();
  const parts = sentencesOf(narration), total = Math.max(1, words(narration));
  let from = 0, current = parts[0] ?? "", start = 0;
  for (const part of parts) { const len = (words(part) / total) * frames; if (frame >= from) { current = part; start = from; } from += len; }
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 64, display: "flex", justifyContent: "center", padding: "0 180px" }}>
      <div style={{ fontFamily: SANS, fontSize: current.length > 150 ? 30 : 36, lineHeight: 1.35, fontWeight: 500, color: C.text, textAlign: "center", background: "rgba(5,8,20,0.72)", border: `1px solid ${C.panelEdge}`, borderRadius: 18, padding: "16px 30px", opacity: enter(frame, start, 8), maxWidth: 1500 }}>{current}</div>
    </div>
  );
};

/** The frame every scene sits in. One brand, one grid, the narration as a caption, and where the scene's claims come from. */
export const Frame: React.FC<{ title: string; scene: Scene; index: number; count: number; frames: number; progress: [number, number]; children: React.ReactNode }> = ({ title, scene, index, count, frames, progress, children }) => {
  const frame = useCurrentFrame(), { width } = useVideoConfig();
  const sources = [...new Set(scene.claims.flatMap((c) => c.sources))].slice(0, 3);
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: SANS, color: C.text, overflow: "hidden" }}>
      {/* The backdrop never changes within a scene, so the compositor paints it once: software rendering makes every repainted pixel cost. */}
      <AbsoluteFill style={{ background: `radial-gradient(1100px 700px at ${18 + (index % 3) * 6}% ${12 + (index % 4) * 3}%, rgba(79,140,255,0.20), transparent 60%), radial-gradient(1000px 700px at ${88 - (index % 3) * 6}% 92%, rgba(61,220,151,0.13), transparent 60%), linear-gradient(180deg, ${C.bg} 0%, ${C.bg2} 100%)` }} />
      <AbsoluteFill style={{ backgroundImage: `linear-gradient(rgba(255,255,255,0.028) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.028) 1px, transparent 1px)`, backgroundSize: "64px 64px", maskImage: "radial-gradient(ellipse at center, black 30%, transparent 78%)" }} />
      <AbsoluteFill style={{ opacity: Math.min(enter(frame, 0, 10), 1 - enter(frame, frames - 8, 8)) }}>
        <div style={{ position: "absolute", top: 52, left: 80, display: "flex", alignItems: "center", gap: 18 }}>
          <Mark size={52} />
          <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: 0.4 }}>{title}</div>
        </div>
        {scene.kicker ? <div style={{ position: "absolute", top: 60, right: 80, fontFamily: MONO, fontSize: 24, letterSpacing: 4, textTransform: "uppercase", color: C.green, border: `1.5px solid ${C.green}55`, borderRadius: 999, padding: "8px 22px", ...rise(frame, 4, 12) }}>{scene.kicker}</div> : null}
        <div style={{ position: "absolute", top: 150, left: 80, right: 80, bottom: 220, display: "flex", flexDirection: "column" }}>{children}</div>
        {/* Where the scene's claims come from: under the caption, out of its way however many lines it takes. */}
        {sources.length ? <div style={{ position: "absolute", left: 80, bottom: 20, display: "flex", gap: 10, alignItems: "center", fontFamily: MONO, fontSize: 19, color: C.faint, opacity: enter(frame, 30, 10) }}>
          <span style={{ letterSpacing: 2 }}>SOURCE</span>
          {sources.map((s) => <span key={s} style={{ color: C.muted, background: "rgba(255,255,255,0.05)", border: `1px solid ${C.panelEdge}`, borderRadius: 8, padding: "3px 10px" }}>{s}</span>)}
        </div> : null}
        <Caption narration={scene.narration} frames={frames} />
      </AbsoluteFill>
      <div style={{ position: "absolute", left: 0, bottom: 0, height: 8, width, background: "rgba(255,255,255,0.06)" }} />
      <div style={{ position: "absolute", left: 0, bottom: 0, height: 8, width: width * interpolate(frame, [0, frames], progress), background: GRADIENT }} />
      <div style={{ position: "absolute", right: 80, bottom: 22, display: "flex", gap: 8 }}>{Array.from({ length: count }, (_, i) => <div key={i} style={{ width: i === index ? 28 : 8, height: 8, borderRadius: 8, background: i === index ? C.green : "rgba(255,255,255,0.18)" }} />)}</div>
    </AbsoluteFill>
  );
};

export const Headline: React.FC<{ text: string; size?: number; at?: number; style?: React.CSSProperties }> = ({ text, size = 76, at = 4, style }) => {
  const frame = useCurrentFrame();
  return <div style={{ fontSize: Math.round(size * Math.max(0.62, Math.min(1, 44 / Math.max(1, text.length)))), fontWeight: 800, lineHeight: 1.08, letterSpacing: -1.2, ...rise(frame, at), ...style }}>{text}</div>;
};
