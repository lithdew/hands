// templates/plane.tsx — the scenes that happen ON the number plane: a matrix as a motion of space.
// Each takes its numbers from the scene's parameters, recomputed exactly (matrix.ts); none knows the topic.
import React from "react";
import { useCurrentFrame } from "remotion";
import { Panel, Reveal, SceneFrame } from "../Frame";
import { Plane, type Rider } from "../Plane";
import { Fit, Tex } from "../Tex";
import { apply, identity, isZero, numbers, steps2x2, tex, texRows, texTerm, toNumber, type Matrix } from "../matrix";
import { matrixOf, vectorOf, type Scene } from "../script";
import { COLOR, IDENTITY, applyM, ease, lerpMatrix, type M2 } from "../theme";

export type SceneProps = { scene: Scene; frames: number };

const m2 = (m: Matrix): M2 => numbers(m) as M2;
const colour = (latex: string, hex: string) => `\\textcolor{${hex}}{${latex}}`;
/** A matrix with its first column in î's green and its second in ĵ's red: the columns ARE where they land. */
export const texColumns = (m: Matrix): string => `\\begin{bmatrix} ${m.map((row) => row.map((x, j) => colour(tex(x), j === 0 ? COLOR.iHat : COLOR.jHat)).join(" & ")).join(texRows(m))} \\end{bmatrix}`;
const texPoint = (x: string, y: string) => `(${x},\\,${y})`;
const detLine = (m: Matrix): string => { const s = steps2x2(m); return `\\det(A) = ${texTerm(s.a)}\\cdot${texTerm(s.d)} - ${texTerm(s.b)}\\cdot${texTerm(s.c)} = ${colour(tex(s.det), COLOR.vector)}`; };

export const Transform: React.FC<SceneProps> = ({ scene, frames }) => {
  const t = useCurrentFrame() / frames, A = matrixOf(scene, "matrix") ?? identity(2), s = steps2x2(A), v = vectorOf(scene, "vector");
  const k = ease(t, 0.2, 0.6), landed = t > 0.6;
  const labelOpacity = landed ? ease(t, 0.62, 0.68) : 1 - ease(t, 0.18, 0.24);
  return (
    <SceneFrame frames={frames} narration={scene.narration}>
      <Plane matrix={lerpMatrix(IDENTITY, m2(A), k)} labelOpacity={labelOpacity}
        iLabel={landed ? texPoint(tex(s.a), tex(s.c)) : "\\hat{\\imath}"} jLabel={landed ? texPoint(tex(s.b), tex(s.d)) : "\\hat{\\jmath}"}
        vector={v ? { v: [toNumber(v[0]!), toNumber(v[1]!)], label: landed ? texPoint(...(apply(A, v).map(tex) as [string, string])) : `\\vec{v} = ${texPoint(tex(v[0]!), tex(v[1]!))}` } : undefined} />
      <Panel heading={scene.heading} opacity={ease(t, 0.03, 0.1)}>
        <Fit width={572} origin="left top"><Tex latex={`A = ${texColumns(A)}`} size={58} /></Fit>
        <Reveal t={t} at={0.64}><Fit width={572} origin="left top"><Tex size={40} latex={`${colour("\\hat{\\imath}", COLOR.iHat)} \\to ${colour(`\\begin{bmatrix} ${tex(s.a)} \\\\ ${tex(s.c)} \\end{bmatrix}`, COLOR.iHat)} \\qquad ${colour("\\hat{\\jmath}", COLOR.jHat)} \\to ${colour(`\\begin{bmatrix} ${tex(s.b)} \\\\ ${tex(s.d)} \\end{bmatrix}`, COLOR.jHat)}`} /></Fit></Reveal>
      </Panel>
    </SceneFrame>
  );
};

export const Undo: React.FC<SceneProps> = ({ scene, frames }) => {
  const t = useCurrentFrame() / frames, A = matrixOf(scene, "matrix") ?? identity(2), s = steps2x2(A), inv = s.inverse ?? identity(2);
  const k = ease(t, 0.1, 0.38) - ease(t, 0.58, 0.86);
  return (
    <SceneFrame frames={frames} narration={scene.narration}>
      <Plane matrix={lerpMatrix(IDENTITY, m2(A), k)} iLabel="\hat{\imath}" jLabel="\hat{\jmath}" />
      <Panel heading={scene.heading} opacity={ease(t, 0.02, 0.08)}>
        <Fit width={572} origin="left top"><Tex latex={`A = ${texColumns(A)}`} size={54} /></Fit>
        <Reveal t={t} at={0.42}><Fit width={572} origin="left top"><Tex latex={`A^{-1} = ${texColumns(inv)}`} size={54} /></Fit></Reveal>
        <Reveal t={t} at={0.87}><Fit width={572} origin="left top"><Tex latex={`A^{-1}A = \\begin{bmatrix} 1 & 0 \\\\ 0 & 1 \\end{bmatrix} = I`} size={48} color={COLOR.vector} /></Fit></Reveal>
      </Panel>
    </SceneFrame>
  );
};

export const Area: React.FC<SceneProps> = ({ scene, frames }) => {
  const t = useCurrentFrame() / frames, A = matrixOf(scene, "matrix") ?? identity(2), s = steps2x2(A);
  const k = ease(t, 0.22, 0.6), areaTex = tex({ n: Math.abs(s.det.n), d: s.det.d });
  return (
    <SceneFrame frames={frames} narration={scene.narration}>
      <Plane matrix={lerpMatrix(IDENTITY, m2(A), k)} square={ease(t, 0.02, 0.1)} squareLabel={k < 0.5 ? (k < 0.02 ? "\\text{area } 1" : undefined) : (k > 0.98 ? `\\text{area } ${areaTex}` : undefined)} />
      <Panel heading={scene.heading} opacity={ease(t, 0.03, 0.1)}>
        <Fit width={572} origin="left top"><Tex latex={`A = ${texColumns(A)}`} size={54} /></Fit>
        <Reveal t={t} at={0.64}><Fit width={572} origin="left top"><Tex latex={detLine(A)} size={42} /></Fit></Reveal>
        {s.det.n < 0 && <Reveal t={t} at={0.74}><div style={{ fontSize: 32, color: COLOR.dim }}>negative: the plane has been flipped over</div></Reveal>}
      </Panel>
    </SceneFrame>
  );
};

export const Collapse: React.FC<SceneProps> = ({ scene, frames }) => {
  const t = useCurrentFrame() / frames, A = matrixOf(scene, "matrix") ?? identity(2), s = steps2x2(A);
  const k = ease(t, 0.2, 0.62);
  // A direction the matrix sends to zero: points that differ by it land on the SAME point, which is why nothing can undo this.
  const n = numbers(A), kernel: [number, number] = Math.hypot(n[0]![0]!, n[0]![1]!) > 1e-9 ? [-n[0]![1]!, n[0]![0]!] : [-n[1]![1]!, n[1]![0]!];
  const length = Math.hypot(...kernel) || 1, step = 1.3 / length, M = m2(A);
  // Start the three points where their shared landing point stays in view, clear of the panel and the captions.
  const starts: [number, number][] = [[1.5, 1], [1, 1], [1, -1], [2, 1], [1, 2], [-1, 1], [0.5, 1], [1, 0.5], [2, -1], [-1, 2]];
  const lands = (at: [number, number]) => applyM(M, at[0], at[1]), fits = (at: [number, number]) => { const [x, y] = lands(at); return x > -1.5 && x < 7 && y > -2.8 && y < 4 && Math.hypot(x, y) > 0.9; };
  const base = starts.find(fits) ?? starts[0]!;
  const dots: Rider[] = isZero(s.det) ? [-1, 0, 1].map((j, i) => ({ at: [base[0] + kernel[0] * step * j, base[1] + kernel[1] * step * j] as [number, number], color: [COLOR.accent, COLOR.vector, COLOR.text][i]! })) : [];
  return (
    <SceneFrame frames={frames} narration={scene.narration}>
      <Plane matrix={lerpMatrix(IDENTITY, m2(A), k)} square={ease(t, 0.02, 0.1)} squareLabel={k < 0.02 ? "\\text{area } 1" : undefined} dots={dots} />
      <Panel heading={scene.heading} opacity={ease(t, 0.03, 0.1)}>
        <Fit width={572} origin="left top"><Tex latex={`A = ${texColumns(A)}`} size={54} /></Fit>
        <Reveal t={t} at={0.66}><Fit width={572} origin="left top"><Tex latex={detLine(A)} size={42} /></Fit></Reveal>
        <Reveal t={t} at={0.78}><Fit width={572} origin="left top"><Tex latex={isZero(s.det) ? `\\text{area } 0 \\;\\Rightarrow\\; A^{-1} \\text{ does not exist}` : `\\det(A) \\neq 0`} size={40} color={COLOR.warn} /></Fit></Reveal>
      </Panel>
    </SceneFrame>
  );
};
