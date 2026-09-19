// Root.tsx — one composition, "Main". Its length is whatever the script's scenes add up to.
import React from "react";
import { Composition } from "remotion";
import { Video } from "./Video";
import { FPS, framesOf, type Script } from "./script";
import { HEIGHT, WIDTH } from "./theme";

// Only so the composition opens without props: two scenes that exercise a typeset and a plane template.
const SAMPLE: Script = { title: "Sample", scenes: [
  { id: "sample_title", template: "title", seconds: 4, narration: "A sample title card for the templates.", title: "Templates", subtitle: "a sample" },
  { id: "sample_shear", template: "transform", seconds: 8, narration: "A shear moves the plane. The basis vectors land on the columns.", matrix: [[1, 1], [0, 1]] },
] };

export const Root: React.FC = () => (
  <Composition id="Main" component={Video} fps={FPS} width={WIDTH} height={HEIGHT} durationInFrames={360} defaultProps={{ script: SAMPLE }}
    calculateMetadata={({ props }) => ({ durationInFrames: Math.max(1, props.script.scenes.reduce((sum, scene) => sum + framesOf(scene), 0)) })} />
);
