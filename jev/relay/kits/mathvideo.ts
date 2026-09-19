// kits/mathvideo.ts — an explainer video in 3Blue1Brown's style, rendered with Remotion.
import type { Kit } from "../relay";

export const mathvideo: Kit = {
  name: "mathvideo",
  brief: "The deliverables are video/script.json ({ scenes: [{ id, seconds, narration, ... }] }), a rendered video/out.mp4, and stills in video/stills/*.png. How the scenes become a Remotion composition, and how it is rendered, is this kit's build.",
};
