// Plane.tsx — manim's NumberPlane under a linear transformation: a static grey grid behind, a blue grid
// that moves with the matrix, the basis vectors î and ĵ, and whatever rides along (a square, a vector, dots).
import React from "react";
import { AbsoluteFill } from "remotion";
import { Tex } from "./Tex";
import { COLOR, HEIGHT, UNIT, WIDTH, applyM, px, type M2 } from "./theme";

const REACH = 24; // grid lines run this far in plane units: far enough that a sheared grid still fills the frame
const LINES = 16;

const Arrow: React.FC<{ to: [number, number]; color: string; width?: number; opacity?: number }> = ({ to, color, width = 9, opacity = 1 }) => {
  const [x0, y0] = px(0, 0), [x1, y1] = px(to[0], to[1]);
  const length = Math.hypot(x1 - x0, y1 - y0);
  if (length < 2) return <circle cx={x0} cy={y0} r={width} fill={color} opacity={opacity} />;
  const head = Math.min(34, length * 0.45), ux = (x1 - x0) / length, uy = (y1 - y0) / length;
  const bx = x1 - ux * head, by = y1 - uy * head, half = head * 0.42;
  return (
    <g opacity={opacity}>
      <line x1={x0} y1={y0} x2={bx + ux * 2} y2={by + uy * 2} stroke={color} strokeWidth={width} strokeLinecap="round" />
      <polygon points={`${x1},${y1} ${bx - uy * half},${by + ux * half} ${bx + uy * half},${by - ux * half}`} fill={color} />
    </g>
  );
};

export type Rider = { at: [number, number]; color: string; label?: string };

export const Plane: React.FC<{
  matrix: M2;
  /** 0..1: how visible the moving grid and vectors are (a title card keeps them faint). */
  strength?: number;
  basis?: boolean;
  /** Labels at the tips of î and ĵ: their names, or where they have landed. */
  iLabel?: string; jLabel?: string; labelOpacity?: number;
  square?: number;            // opacity of the unit square, carried by the matrix
  squareLabel?: string;
  vector?: { v: [number, number]; label?: string; opacity?: number };
  dots?: Rider[];             // points given in the ORIGINAL plane; drawn where the matrix carries them
}> = ({ matrix, strength = 1, basis = true, iLabel, jLabel, labelOpacity = 1, square = 0, squareLabel, vector, dots = [] }) => {
  const line = (x0: number, y0: number, x1: number, y1: number) => { const [a, b] = px(...applyM(matrix, x0, y0)), [c, d] = px(...applyM(matrix, x1, y1)); return { x1: a, y1: b, x2: c, y2: d }; };
  const ks = Array.from({ length: LINES * 2 + 1 }, (_, i) => i - LINES);
  const iTip = applyM(matrix, 1, 0), jTip = applyM(matrix, 0, 1);
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => px(...applyM(matrix, x!, y!)));
  const centre = px(...applyM(matrix, 0.5, 0.5));
  const tipLabel = (tip: [number, number], text: string | undefined, color: string, push: [number, number]) => {
    if (!text) return null;
    // A longer label (coordinates) stands further from the tip than a short one (a name), so neither covers the arrowhead.
    const norm = Math.hypot(tip[0], tip[1]) || 1, away = 0.36 + 0.075 * text.replace(/\\[a-zA-Z]+|[{}\\,\s]/g, "").length;
    const [x, y] = px(tip[0] + (tip[0] / norm) * away + push[0], tip[1] + (tip[1] / norm) * away + push[1]);
    return <div style={{ position: "absolute", left: x, top: y, transform: "translate(-50%, -50%)", opacity: labelOpacity, textShadow: `0 0 12px ${COLOR.background}, 0 0 6px ${COLOR.background}`, whiteSpace: "nowrap" }}><Tex latex={text} size={44} color={color} display={false} /></div>;
  };
  return (
    <AbsoluteFill style={{ backgroundColor: COLOR.background }}>
      <svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        {/* the plane as it was: a quiet grey grid that never moves */}
        <g stroke={COLOR.staticGrid} strokeWidth={2} opacity={0.9}>
          {ks.map((k) => <line key={`sv${k}`} x1={WIDTH / 2 + k * UNIT} y1={0} x2={WIDTH / 2 + k * UNIT} y2={HEIGHT} />)}
          {ks.map((k) => <line key={`sh${k}`} x1={0} y1={HEIGHT / 2 - k * UNIT} x2={WIDTH} y2={HEIGHT / 2 - k * UNIT} />)}
        </g>
        {/* the plane as the matrix moves it */}
        <g opacity={strength}>
          <g stroke={COLOR.gridFaint} strokeWidth={1.5} opacity={0.55}>
            {ks.map((k) => <line key={`hv${k}`} {...line(k + 0.5, -REACH, k + 0.5, REACH)} />)}
            {ks.map((k) => <line key={`hh${k}`} {...line(-REACH, k + 0.5, REACH, k + 0.5)} />)}
          </g>
          <g stroke={COLOR.grid} strokeWidth={3}>
            {ks.filter((k) => k !== 0).map((k) => <line key={`v${k}`} {...line(k, -REACH, k, REACH)} />)}
            {ks.filter((k) => k !== 0).map((k) => <line key={`h${k}`} {...line(-REACH, k, REACH, k)} />)}
          </g>
          <g stroke={COLOR.axis} strokeWidth={4}><line {...line(0, -REACH, 0, REACH)} /><line {...line(-REACH, 0, REACH, 0)} /></g>
          {square > 0 && <polygon points={corners.map((c) => c.join(",")).join(" ")} fill={COLOR.area} fillOpacity={0.34 * square} stroke={COLOR.area} strokeWidth={4} strokeOpacity={square} strokeLinejoin="round" />}
          {basis && <><Arrow to={iTip} color={COLOR.iHat} /><Arrow to={jTip} color={COLOR.jHat} /></>}
          {vector && <Arrow to={applyM(matrix, vector.v[0], vector.v[1])} color={COLOR.vector} width={8} opacity={vector.opacity ?? 1} />}
          {dots.map((dot, i) => { const [x, y] = px(...applyM(matrix, dot.at[0], dot.at[1])); return <circle key={i} cx={x} cy={y} r={13} fill={dot.color} stroke={COLOR.background} strokeWidth={3} />; })}
        </g>
      </svg>
      {basis && tipLabel(iTip, iLabel, COLOR.iHat, [0, -0.22])}
      {basis && tipLabel(jTip, jLabel, COLOR.jHat, [-0.22, 0])}
      {vector?.label && tipLabel(applyM(matrix, vector.v[0], vector.v[1]), vector.label, COLOR.vector, [0.1, 0.1])}
      {square > 0 && squareLabel && <div style={{ position: "absolute", left: centre[0], top: centre[1], transform: "translate(-50%, -50%)", opacity: square, textShadow: `0 0 10px ${COLOR.background}, 0 0 4px ${COLOR.background}`, whiteSpace: "nowrap" }}><Tex latex={squareLabel} size={36} color={COLOR.text} display={false} /></div>}
    </AbsoluteFill>
  );
};
