// Frame.tsx — what every scene shares: the fade in and out, the narration as captions (there is no voice
// track, so the words are on screen, one sentence at a time), and the dark panel that carries typeset
// mathematics over a moving plane, the way 3Blue1Brown backs a formula with a black rectangle.
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { COLOR, SERIF, WIDTH } from "./theme";

/** The narration in sentences, each with the share of the scene its length earns. */
export function captions(narration: string): { text: string; from: number; to: number }[] {
  const sentences = narration.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [narration];
  const merged: string[] = [];
  for (const s of sentences) { const last = merged[merged.length - 1]; if (last !== undefined && (last.split(/\s+/).length < 4 || s.split(/\s+/).length < 3)) merged[merged.length - 1] = `${last} ${s}`; else merged.push(s); }
  const total = merged.reduce((sum, s) => sum + s.split(/\s+/).length + 2, 0);
  let at = 0;
  return merged.map((text) => { const from = at; at += (text.split(/\s+/).length + 2) / total; return { text, from, to: at }; });
}

export const SceneFrame: React.FC<{ frames: number; narration: string; children: React.ReactNode }> = ({ frames, narration, children }) => {
  const frame = useCurrentFrame(), t = frame / Math.max(1, frames);
  const opacity = interpolate(frame, [0, 9, frames - 8, frames - 1], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const line = captions(narration).find((c) => t >= c.from && t < c.to);
  return (
    <AbsoluteFill style={{ backgroundColor: COLOR.background, fontFamily: SERIF }}>
      <AbsoluteFill style={{ opacity }}>
        {children}
        {line && (
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "26px 0 34px", display: "flex", justifyContent: "center", background: "linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.82) 70%, rgba(0,0,0,0) 100%)" }}>
            <div style={{ maxWidth: WIDTH - 360, textAlign: "center", fontSize: 38, lineHeight: 1.32, color: COLOR.text, opacity: 0.94 }}>{line.text}</div>
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Typeset mathematics over the plane, top left, on a near-black panel. */
export const Panel: React.FC<{ heading?: string; opacity?: number; children: React.ReactNode; width?: number }> = ({ heading, opacity = 1, children, width = 640 }) => (
  <div style={{ position: "absolute", left: 56, top: 48, width, padding: "26px 34px 30px", background: "rgba(5,5,8,0.88)", border: `1.5px solid rgba(255,255,255,0.10)`, borderRadius: 14, opacity, display: "flex", flexDirection: "column", gap: 18 }}>
    {heading && <div style={{ fontSize: 40, color: COLOR.accent, lineHeight: 1.2 }}>{heading}</div>}
    {children}
  </div>
);

/** Appears between two fractions of the scene, rising slightly, as manim's FadeIn(shift=UP). */
export const Reveal: React.FC<{ t: number; at: number; over?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ t, at, over = 0.05, children, style }) => {
  const k = Math.min(1, Math.max(0, (t - at) / over)), e = 1 - (1 - k) * (1 - k);
  return <div style={{ opacity: e, transform: `translateY(${(1 - e) * 22}px)`, ...style }}>{children}</div>;
};
