// Tex.tsx — mathematics typeset by KaTeX (LaTeX's own fonts and brackets), and text that may hold $...$.
import katex from "katex";
import "katex/dist/katex.min.css";
import "./style.css";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { continueRender, delayRender } from "remotion";
import { COLOR, SERIF } from "./theme";

// The repository is type-checked without the DOM library; this is all of the page these components touch.
const page = globalThis as unknown as { document: { fonts: { load(face: string): Promise<unknown> } } };
const FACES = ["400 1em KaTeX_Main", "700 1em KaTeX_Main", "italic 400 1em KaTeX_Main", "italic 400 1em KaTeX_Math", "400 1em KaTeX_Size1", "400 1em KaTeX_Size2", "400 1em KaTeX_Size3", "400 1em KaTeX_Size4", "400 1em KaTeX_AMS"];

/** Nothing is drawn, and no frame is captured, before KaTeX's fonts are in: widths are measured from them. */
export const FontGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [ready, setReady] = useState(false);
  const [handle] = useState(() => delayRender("KaTeX fonts"));
  useEffect(() => {
    Promise.all(FACES.map((face) => page.document.fonts.load(face))).catch(() => []).then(() => { setReady(true); continueRender(handle); });
  }, [handle]);
  return ready ? <>{children}</> : null;
};

export const html = (latex: string, display = true): string => katex.renderToString(latex, { displayMode: display, throwOnError: false, strict: "ignore", trust: false, output: "html" });

export const Tex: React.FC<{ latex: string; size?: number; color?: string; display?: boolean; style?: React.CSSProperties }> = ({ latex, size = 56, color = COLOR.text, display = true, style }) => (
  <span style={{ fontSize: size, color, display: display ? "block" : "inline-block", lineHeight: 1.2, ...style }} dangerouslySetInnerHTML={{ __html: html(latex, display) }} />
);

/** Text in LaTeX's roman face; parts between $ signs are typeset as mathematics. */
export const Rich: React.FC<{ text: string; size?: number; color?: string; style?: React.CSSProperties }> = ({ text, size = 44, color = COLOR.text, style }) => (
  <span style={{ fontFamily: SERIF, fontSize: size, color, lineHeight: 1.3, ...style }}>
    {text.split(/(\$[^$]*\$)/g).filter(Boolean).map((part, i) => part.startsWith("$") && part.endsWith("$") && part.length > 1
      ? <span key={i} dangerouslySetInnerHTML={{ __html: html(part.slice(1, -1), false) }} />
      : <span key={i}>{part}</span>)}
  </span>
);

/** Shrinks its content to fit `width` (never enlarges): a long line of mathematics stays on the screen. */
export const Fit: React.FC<{ width: number; children: React.ReactNode; origin?: string }> = ({ width, children, origin = "center top" }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => { const natural = (ref.current as unknown as { scrollWidth: number } | null)?.scrollWidth ?? 0; setScale(natural > width ? width / natural : 1); }, [width, children]);
  return <div style={{ width, display: "flex", justifyContent: origin.startsWith("left") ? "flex-start" : "center" }}><div ref={ref} style={{ transform: `scale(${scale})`, transformOrigin: origin, whiteSpace: "nowrap", width: "max-content" }}>{children}</div></div>;
};
