// Root.tsx — one composition, whose length and content are the script's. The script arrives as input props.
import React from "react";
import { Composition, Sequence, registerRoot } from "remotion";
import { FPS, type Script } from "../../script";
import { Frame } from "./parts";
import { SCENES } from "./scenes";

export const framesOf = (script: Script) => script.scenes.map((s) => Math.max(FPS, Math.round((s.seconds ?? 6) * FPS)));

const Pitch: React.FC<{ script: Script }> = ({ script }) => {
  const frames = framesOf(script), total = frames.reduce((a, b) => a + b, 0);
  let from = 0;
  return (
    <>
      {script.scenes.map((scene, i) => {
        const start = from, Body = SCENES[scene.template];
        from += frames[i]!;
        return (
          <Sequence key={scene.id} from={start} durationInFrames={frames[i]!} name={scene.id}>
            <Frame title={script.title} scene={scene} index={i} count={script.scenes.length} frames={frames[i]!} progress={[start / total, (start + frames[i]!) / total]}>
              <Body scene={scene} title={script.title} frames={frames[i]!} />
            </Frame>
          </Sequence>
        );
      })}
    </>
  );
};

const EMPTY: Script = { title: "Pitch", scenes: [] };

const Root: React.FC = () => (
  <Composition id="Pitch" component={Pitch} width={1920} height={1080} fps={FPS} durationInFrames={FPS} defaultProps={{ script: EMPTY }}
    calculateMetadata={({ props }) => ({ durationInFrames: Math.max(FPS, framesOf(props.script).reduce((a, b) => a + b, 0)) })} />
);

registerRoot(Root);
