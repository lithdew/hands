// templates/typeset.tsx — the scenes that are typeset mathematics or words: a title, lines of LaTeX, a worked
// 2x2 inverse, a matrix product, a closing list. A faint number plane stays behind them, so the video never
// leaves the space it is about.
import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Reveal, SceneFrame } from "../Frame";
import { Plane } from "../Plane";
import { Fit, Rich, Tex } from "../Tex";
import { identity, product as times, steps2x2, tex, texMatrix, texTerm } from "../matrix";
import { matrixOf, stringsOf, type Scene } from "../script";
import { COLOR, IDENTITY, WIDTH, ease, lerpMatrix } from "../theme";
import { texColumns, type SceneProps } from "./plane";

const yellow = (latex: string) => `\\textcolor{${COLOR.vector}}{${latex}}`;

const Backdrop: React.FC<{ strength?: number; drift?: number }> = ({ strength = 0.2, drift = 0 }) => (
  <><Plane matrix={lerpMatrix(IDENTITY, [[1, 0.5], [0.25, 1]], drift)} strength={strength} basis={false} /><AbsoluteFill style={{ background: "radial-gradient(ellipse at center, rgba(10,10,12,0.78) 0%, rgba(10,10,12,0.35) 70%, rgba(10,10,12,0.1) 100%)" }} /></>
);

const Heading: React.FC<{ scene: Scene; t: number }> = ({ scene, t }) => typeof scene.heading === "string" && scene.heading
  ? <div style={{ position: "absolute", top: 64, left: 0, right: 0, textAlign: "center", fontSize: 52, color: COLOR.accent, opacity: ease(t, 0.01, 0.07) }}>{scene.heading}</div> : null;

/** The rows of a typeset scene, spread over the space between the heading and the captions. */
const Rows: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ position: "absolute", top: 150, bottom: 170, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "space-evenly" }}>{children}</div>
);

export const Title: React.FC<SceneProps> = ({ scene, frames }) => {
  const t = useCurrentFrame() / frames;
  return (
    <SceneFrame frames={frames} narration={scene.narration}>
      <Plane matrix={lerpMatrix(IDENTITY, [[1, 0.6], [0.3, 1.1]], ease(t, 0.05, 0.95))} strength={0.5} iLabel="\hat{\imath}" jLabel="\hat{\jmath}" />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, rgba(10,10,12,0.72) 0%, rgba(10,10,12,0.2) 75%)" }} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", paddingBottom: 120 }}>
        <Reveal t={t} at={0.04} over={0.1}><Fit width={WIDTH - 240}><div style={{ fontSize: 112, color: COLOR.text, letterSpacing: 1 }}>{String(scene.title ?? "")}</div></Fit></Reveal>
        {typeof scene.subtitle === "string" && <Reveal t={t} at={0.16} over={0.1} style={{ marginTop: 28 }}><Fit width={WIDTH - 360}><div style={{ fontSize: 50, color: COLOR.accent }}>{scene.subtitle}</div></Fit></Reveal>}
      </AbsoluteFill>
    </SceneFrame>
  );
};

export const Equation: React.FC<SceneProps> = ({ scene, frames }) => {
  const t = useCurrentFrame() / frames, lines = stringsOf(scene, "lines").map((line) => line.replace(/^\$+|\$+$/g, ""));
  return (
    <SceneFrame frames={frames} narration={scene.narration}>
      <Backdrop />
      <Heading scene={scene} t={t} />
      <Rows>{lines.map((line, i) => <Reveal key={i} t={t} at={0.06 + (i * 0.7) / lines.length}><Fit width={WIDTH - 280}><Tex latex={line} size={lines.length > 3 ? 58 : 70} /></Fit></Reveal>)}</Rows>
    </SceneFrame>
  );
};

export const WorkedInverse: React.FC<SceneProps> = ({ scene, frames }) => {
  const t = useCurrentFrame() / frames, A = matrixOf(scene, "matrix") ?? identity(2), s = steps2x2(A), inv = s.inverse;
  const rows = [
    `A = ${texColumns(A)} \\qquad \\det(A) = ad - bc = ${texTerm(s.a)}\\cdot${texTerm(s.d)} - ${texTerm(s.b)}\\cdot${texTerm(s.c)} = ${tex(s.ad)} - ${texTerm(s.bc)} = ${yellow(tex(s.det))}`,
    `\\text{swap } a \\text{ and } d,\\ \\text{negate } b \\text{ and } c:\\quad \\begin{bmatrix} d & -b \\\\ -c & a \\end{bmatrix} = ${texMatrix(s.adjugate)}`,
    inv ? `A^{-1} = \\frac{1}{\\det(A)} ${texMatrix(s.adjugate)} = \\frac{1}{${yellow(tex(s.det))}} ${texMatrix(s.adjugate)} = ${texMatrix(inv)}` : `\\det(A) = 0:\\ A^{-1} \\text{ does not exist}`,
    ...(inv ? [`\\text{check:}\\quad A\\,A^{-1} = ${texMatrix(A)} ${texMatrix(inv)} = ${texMatrix(times(A, inv))} = I \\;\\checkmark`] : []),
  ];
  return (
    <SceneFrame frames={frames} narration={scene.narration}>
      <Backdrop />
      <Heading scene={scene} t={t} />
      <Rows>{rows.map((row, i) => <Reveal key={i} t={t} at={0.05 + i * 0.22}><Fit width={WIDTH - 240}><Tex latex={row} size={46} /></Fit></Reveal>)}</Rows>
    </SceneFrame>
  );
};

export const Product: React.FC<SceneProps> = ({ scene, frames }) => {
  const t = useCurrentFrame() / frames, L = matrixOf(scene, "left") ?? identity(2), R = matrixOf(scene, "right") ?? identity(2), result = times(L, R);
  const entry = (i: number, j: number) => `${texTerm(L[i]![0]!)}\\cdot${texTerm(R[0]![j]!)} + ${texTerm(L[i]![1]!)}\\cdot${texTerm(R[1]![j]!)}`;
  const rows = [
    `${texMatrix(L)} ${texMatrix(R)}`,
    `= \\begin{bmatrix} ${entry(0, 0)} & ${entry(0, 1)} \\\\ ${entry(1, 0)} & ${entry(1, 1)} \\end{bmatrix}`,
    `= ${yellow(texMatrix(result))}`,
  ];
  return (
    <SceneFrame frames={frames} narration={scene.narration}>
      <Backdrop />
      <Heading scene={scene} t={t} />
      <Rows>{rows.map((row, i) => <Reveal key={i} t={t} at={0.06 + i * 0.27}><Fit width={WIDTH - 280}><Tex latex={row} size={64} /></Fit></Reveal>)}</Rows>
    </SceneFrame>
  );
};

export const Recap: React.FC<SceneProps> = ({ scene, frames }) => {
  const t = useCurrentFrame() / frames, points = stringsOf(scene, "points");
  return (
    <SceneFrame frames={frames} narration={scene.narration}>
      <Backdrop strength={0.28} drift={ease(t, 0, 1) * 0.6} />
      <Heading scene={scene} t={t} />
      <div style={{ position: "absolute", top: 170, bottom: 190, left: 220, right: 220, display: "flex", flexDirection: "column", justifyContent: "space-evenly" }}>
        {points.map((text, i) => (
          <Reveal key={i} t={t} at={0.06 + (i * 0.72) / points.length}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 26 }}><span style={{ color: COLOR.accent, fontSize: 40 }}>▸</span><Fit width={WIDTH - 520} origin="left top"><Rich text={text} size={50} /></Fit></div>
          </Reveal>
        ))}
      </div>
    </SceneFrame>
  );
};
