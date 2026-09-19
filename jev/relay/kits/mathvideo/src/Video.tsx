// Video.tsx — a script (data) becomes a video: one Sequence per scene, each drawn by the template it names.
import React from "react";
import { AbsoluteFill, Series } from "remotion";
import { FontGate } from "./Tex";
import { TEMPLATE_NAMES, framesOf, type Script, type TemplateName } from "./script";
import { Area, Collapse, Transform, Undo, type SceneProps } from "./templates/plane";
import { Equation, Product, Recap, Title, WorkedInverse } from "./templates/typeset";
import { COLOR } from "./theme";

const DRAW: Record<TemplateName, React.FC<SceneProps>> = { title: Title, transform: Transform, undo: Undo, area: Area, collapse: Collapse, equation: Equation, worked_inverse: WorkedInverse, product: Product, recap: Recap };

export const Video: React.FC<{ script: Script }> = ({ script }) => (
  <AbsoluteFill style={{ backgroundColor: COLOR.background }}>
    <FontGate>
      <Series>
        {script.scenes.filter((scene) => TEMPLATE_NAMES.includes(scene.template)).map((scene) => {
          const Draw = DRAW[scene.template], frames = framesOf(scene);
          return <Series.Sequence key={scene.id} durationInFrames={frames}><Draw scene={scene} frames={frames} /></Series.Sequence>;
        })}
      </Series>
    </FontGate>
  </AbsoluteFill>
);
