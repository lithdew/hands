// kits/pitchvideo.ts — a hackathon pitch video for Hands, rendered with Remotion, every claim traceable.
import type { Kit } from "../relay";

export const pitchvideo: Kit = {
  name: "pitchvideo",
  brief: "The deliverables are video/script.json ({ scenes: [{ id, seconds, narration, ... }] }), video/claims.md (every number or capability claimed, with the file in this repository it comes from), a rendered video/out.mp4, and stills in video/stills/*.png. How the scenes become a Remotion composition, and how it is rendered, is this kit's build.",
};
