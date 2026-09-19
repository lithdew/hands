import type {PreparedStoryboard} from "./storyboard";

export function musicVolumeAt(frame:number,storyboard:PreparedStoryboard) {
  const base=10**((storyboard.music?.gainDb??-3)/20);
  const scene=storyboard.scenes.find(s=>frame>=s.startFrame&&frame<s.startFrame+s.frames);
  if(!scene?.audioAsset)return base;
  const local=frame-scene.startFrame,fade=Math.min(1,local/8,(scene.frames-local)/12);
  return base*(1-.82*Math.max(0,fade));
}
export type AudioMeasurements={durationSeconds:number;sampleRate:number;channels:number;peakDbfs:number;rmsDbfs:number;firstQuarterSecondRmsDbfs:number;lastQuarterSecondRmsDbfs:number;clippedSamples:number;sha256:string};
export function verifyMusicMix(measured:AudioMeasurements,duration:number,hasNarration:boolean) {
  if(!Number.isFinite(measured.rmsDbfs)||!Number.isFinite(measured.peakDbfs)||measured.rmsDbfs < -48)throw new Error("Rendered music is missing or inaudible");
  if(measured.clippedSamples!==0||measured.peakDbfs>-.1)throw new Error("Rendered audio clips or lacks peak headroom");
  if(measured.channels!==2||measured.sampleRate!==48000||Math.abs(measured.durationSeconds-duration)>.15)throw new Error("Rendered music duration or stereo format does not match the movie");
  if(!hasNarration&&(measured.firstQuarterSecondRmsDbfs>measured.rmsDbfs-8||measured.lastQuarterSecondRmsDbfs>measured.rmsDbfs-8))throw new Error("Rendered music does not have the expected intro and outro fades");
  return {audible:true,nonClipping:true,fadesVerified:!hasNarration,...measured};
}
