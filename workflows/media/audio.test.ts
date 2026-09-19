import {expect,test} from "bun:test";
import {musicVolumeAt,verifyMusicMix,type AudioMeasurements} from "./audio";
import {storyboardSchema,type PreparedStoryboard} from "./storyboard";
import {inferredLayout,rise} from "./motion";

const base={version:1,title:"Music and motion",kind:"pitch",sources:[],scenes:[{id:"intro",title:"Hands",visual:"title",durationSeconds:4},{id:"flow",title:"Jev → specialist → result",visual:"bullets",durationSeconds:6}]};
test("bounded art direction and music opt in without breaking old storyboards",()=>{
  expect(storyboardSchema.parse(base).music).toBeUndefined();
  const spec=storyboardSchema.parse({...base,design:{theme:"editorial-cobalt"},music:{style:"minimal-electronic"}});
  expect(spec.design?.motion).toBe("expressive");expect(spec.music?.tempoBpm).toBe(104);
  for(const music of [{style:"minimal-electronic",gainDb:5},{style:"minimal-electronic",tempoBpm:200},{style:"minimal-electronic",url:"https://example.test/song.mp3"}])expect(()=>storyboardSchema.parse({...base,music})).toThrow();
  expect(()=>storyboardSchema.parse({...base,scenes:[{...base.scenes[0],emphasis:"invented"},base.scenes[1]]})).toThrow("exact phrase");
  expect(()=>storyboardSchema.parse({...base,scenes:[{...base.scenes[0],layout:"artifact-stage"},base.scenes[1]]})).toThrow("trusted artifactImage");
});
test("motion settles deterministically and workflow/chips have concrete layouts",()=>{
  expect(rise(-1)).toBe(0);expect(rise(0)).toBe(0);expect(rise(22)).toBe(1);expect(rise(100)).toBe(1);
  const scene={id:"flow",title:"Jev → specialist → result",visual:"bullets" as const,durationSeconds:6,frames:144,startFrame:0};
  expect(inferredLayout(scene)).toBe("workflow");expect(inferredLayout({...scene,title:"The tasks",chips:["Website","Exam"]})).toBe("task-field");
});
test("narration ducks background score and restores gain at scene boundaries",()=>{
  const spec=storyboardSchema.parse({...base,music:{style:"warm-keys",gainDb:-3}});
  const prepared:PreparedStoryboard={...spec,durationInFrames:240,scenes:spec.scenes.map((s,i)=>({...s,startFrame:i?96:0,frames:i?144:96,...i?{audioAsset:"speech.wav"}:{}}))};
  expect(musicVolumeAt(30,prepared)).toBeCloseTo(10**(-3/20));expect(musicVolumeAt(120,prepared)).toBeLessThan(.15);expect(musicVolumeAt(96,prepared)).toBeCloseTo(musicVolumeAt(30,prepared));
});
test("audio verification rejects missing music, clipped samples and absent fades",()=>{
  const m:AudioMeasurements={durationSeconds:18.02,sampleRate:48000,channels:2,peakDbfs:-5,rmsDbfs:-20,firstQuarterSecondRmsDbfs:-51,lastQuarterSecondRmsDbfs:-60,clippedSamples:0,sha256:"fixture"};
  expect(verifyMusicMix(m,18,false)).toMatchObject({audible:true,nonClipping:true,fadesVerified:true});
  expect(()=>verifyMusicMix({...m,rmsDbfs:-90},18,false)).toThrow("inaudible");
  expect(()=>verifyMusicMix({...m,clippedSamples:1},18,false)).toThrow("clips");
  expect(()=>verifyMusicMix({...m,firstQuarterSecondRmsDbfs:-20},18,false)).toThrow("fades");
  expect(()=>verifyMusicMix({...m,durationSeconds:12},18,false)).toThrow("duration");
});
