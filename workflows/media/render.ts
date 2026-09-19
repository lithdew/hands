import {bundle} from "@remotion/bundler";
import {getVideoMetadata, makeCancelSignal, openBrowser, renderMedia, renderStill, selectComposition} from "@remotion/renderer";
import {mkdir, copyFile, realpath, rename, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {storyboardSchema, determinant, inverse} from "./storyboard";
import type {PreparedScene, PreparedStoryboard} from "./storyboard";
import {runOwned} from "./process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const outputRoot = path.join(repo, "out");
function inside(root: string, target: string) { const r=path.relative(root,target); return !!r && !r.startsWith("..") && !path.isAbsolute(r); }
const hash = (b: Uint8Array|string) => createHash("sha256").update(b).digest("hex");
function subtitleTime(seconds:number) { const ms=Math.round(seconds*1000); return `${String(Math.floor(ms/3600000)).padStart(2,"0")}:${String(Math.floor(ms/60000)%60).padStart(2,"0")}:${String(Math.floor(ms/1000)%60).padStart(2,"0")},${String(ms%1000).padStart(3,"0")}`; }
function wavDuration(b: Uint8Array) {
  const v=new DataView(b.buffer,b.byteOffset,b.byteLength);
  let rate=0;let size=0;
  for(let p=12;p+8<=b.length;) {const id=String.fromCharCode(...b.slice(p,p+4));const n=v.getUint32(p+4,true);if(id==="fmt ")rate=v.getUint32(p+16,true);if(id==="data")size=n;p+=8+n+(n%2);}
  if(!rate||!size)throw new Error("Narrator produced an invalid/empty WAV");
  return size/rate;
}
export type RenderOptions={evidenceAssets?:Record<string,string>;pythonExecutable?:string;onProgress?:(phase:string,detail?:unknown)=>void;signal?:AbortSignal;timeoutMs?:number};
async function renderInWorker(specPath: string, outputDir: string, options: RenderOptions) {
  const started=performance.now();
  const check=()=>options.signal?.throwIfAborted();check();
  const report=(phase:string,detail?:unknown)=>{check();options.onProgress?.(phase,detail);check();};
  const run=(args:string[],cwd:string,env?:Record<string,string>,timeoutMs=180000)=>runOwned(args,cwd,{env,timeoutMs,signal:options.signal});
  const spec=storyboardSchema.parse(await Bun.file(specPath).json());
  const out=path.resolve(outputDir);
  if(!inside(outputRoot,out))throw new Error("Media output must be a new directory under repository out/");
  await mkdir(out,{recursive:true});
  if(!inside(await realpath(outputRoot),await realpath(out)))throw new Error("Media output resolves outside repository out/");
  if(await Bun.file(path.join(out,"video.mp4")).exists())throw new Error("Refusing to overwrite an existing rendered video");
  const publicDir=path.join(out,"assets");await mkdir(publicDir,{recursive:true});await mkdir(path.join(out,"frames"),{recursive:true});
  const python=options.pythonExecutable??path.join(repo,"out/media-python",process.platform==="win32"?"Scripts/python.exe":"bin/python");
  if(!await Bun.file(python).exists())throw new Error("Media Python environment missing; see workflows/media/README.md setup");
  const ffmpeg=(await run([python,"-c","import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"],out)).stdout.trim();
  const timings:Record<string,number>={};const manimAssets:unknown[]=[];const assets:unknown[]=[];
  const prepared:PreparedScene[]=[];let cursor=0;let narrationCount=0;
  for (const scene of spec.scenes) {
    check();
    const start=performance.now();
    const item:PreparedScene={...scene,frames:Math.round(scene.durationSeconds*spec.fps),startFrame:cursor};
    if(scene.narration) {
      if(process.platform!=="win32")throw new Error("Local SAPI narration currently requires Windows; omit narration for a silent subtitled video");
      const json=path.join(out,`narration-${scene.id}.json`);await Bun.write(json,JSON.stringify({text:scene.narration}));
      item.audioAsset=`narration-${scene.id}.wav`;
      const audio=path.join(publicDir,item.audioAsset);
      await run([path.join(process.env.SystemRoot??"C:/Windows","System32/WindowsPowerShell/v1.0/powershell.exe"),"-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",path.join(here,"narrate.ps1"),"-InputJson",json,"-OutputWav",audio],out);
      item.durationSeconds=Math.max(scene.durationSeconds,wavDuration(new Uint8Array(await Bun.file(audio).arrayBuffer()))+.5);
      if(item.durationSeconds>45)throw new Error(`Narration too long for scene ${scene.id}`);
      item.frames=Math.ceil(item.durationSeconds*spec.fps);narrationCount++;
    }
    if(scene.artifactImage) {
      const source=options.evidenceAssets?.[scene.artifactImage];
      if(!source)throw new Error(`Missing trusted evidence asset ${scene.artifactImage}`);
      const absolute=await realpath(path.resolve(source));
      if(!inside(await realpath(outputRoot),absolute))throw new Error("Evidence asset must resolve under repository out/");
      const bytes=new Uint8Array(await Bun.file(absolute).arrayBuffer());
      const png=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71;
      const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
      if(!png&&!jpeg)throw new Error("Evidence assets must be PNG/JPEG images");
      if(bytes.length>15000000)throw new Error("Evidence image exceeds 15MB");
      item.imageAsset=`evidence-${scene.id}.${png?"png":"jpg"}`;
      await copyFile(absolute,path.join(publicDir,item.imageAsset));assets.push({id:scene.artifactImage,source:absolute,sha256:hash(bytes)});
    }
    if(scene.matrix) {
      report("manim",{scene:scene.id});
      const config=path.join(out,`manim-${scene.id}.yml`);
      await Bun.write(config,`camera:\n  background_color: '#0b1422'\n  fps: ${spec.fps}\nfile_writer:\n  ffmpeg_bin: ${JSON.stringify(ffmpeg)}\ndirectories:\n  cache: ${JSON.stringify(path.join(out,"manim-cache"))}\n`);
      item.videoAsset=`matrix-${scene.id}.mp4`;
      // ManimGL 1.7.2 parses --fps as a string; keep the numeric value in YAML.
      const output=await run([python,"-m","manimlib",path.join(here,"matrix_scene.py"),"MatrixScene","-w","-q","--resolution","960x640","--video_dir",publicDir,"--file_name",`matrix-${scene.id}`,"--config_file",config],out,{HANDS_MATRIX_DATA:JSON.stringify({matrix:scene.matrix,durationSeconds:item.frames/spec.fps})});
      await Bun.write(path.join(out,`manim-${scene.id}.log`),output.stdout+output.stderr);
      if(!await Bun.file(path.join(publicDir,item.videoAsset)).exists())throw new Error(`Manim did not create ${item.videoAsset}`);
      manimAssets.push({scene:scene.id,engine:"3b1b/ManimGL",version:"1.7.2",matrix:scene.matrix,determinant:determinant(scene.matrix),inverse:inverse(scene.matrix),file:`assets/${item.videoAsset}`});
    }
    prepared.push(item);cursor+=item.frames;timings[`prepare-${scene.id}`]=Math.round(performance.now()-start);
  }
  if(cursor/spec.fps>300)throw new Error("Prepared narrated video exceeds five minutes");
  const storyboard:PreparedStoryboard={...spec,scenes:prepared,durationInFrames:cursor};
  await Bun.write(path.join(out,"storyboard.normalized.json"),JSON.stringify(storyboard,null,2));
  await Bun.write(path.join(out,"subtitles.srt"),prepared.map((s,i)=>`${i+1}\n${subtitleTime(s.startFrame/spec.fps)} --> ${subtitleTime((s.startFrame+s.frames)/spec.fps)}\n${s.narration??s.caption??[s.title,s.body,...s.bullets??[]].filter(Boolean).join(". ")}\n`).join("\n"));
  report("bundle");let start=performance.now();
  const serveUrl=await bundle({entryPoint:path.join(here,"composition.tsx"),publicDir,outDir:path.join(out,"remotion-bundle"),enableCaching:false,onProgress:()=>{}});
  check();timings.bundleMs=Math.round(performance.now()-start);
  const {cancelSignal,cancel}=makeCancelSignal();
  let browser:Awaited<ReturnType<typeof openBrowser>>|undefined,closing:Promise<void>|undefined;
  const close=()=>browser?(closing??=browser.close({silent:true}).catch(()=>{})):Promise.resolve();
  const abort=()=>{cancel();void close();};
  options.signal?.addEventListener("abort",abort,{once:true});
  const frames:{path:string;title:string;frame:number}[]=[];
  try {
    check();report("browser");browser=await openBrowser("chrome",{logLevel:"error"});check();
    const inputProps={storyboard};
    const composition=await selectComposition({serveUrl,id:"HandsStoryboard",inputProps,puppeteerInstance:browser,logLevel:"error",timeoutInMilliseconds:30000});
    report("render",{frames:cursor});start=performance.now();
    await renderMedia({composition,serveUrl,codec:"h264",outputLocation:path.join(out,"video.mp4"),inputProps,puppeteerInstance:browser,concurrency:2,crf:20,pixelFormat:"yuv420p",overwrite:false,logLevel:"error",cancelSignal,timeoutInMilliseconds:30000,onProgress:({progress})=>{if(!options.signal?.aborted)options.onProgress?.("render-progress",{progress});}});
    check();timings.renderMs=Math.round(performance.now()-start);
    start=performance.now();
    for(const scene of prepared) {
      check();
      const frame=scene.startFrame+Math.floor(scene.frames/2);const rel=`frames/${scene.id}.png`;
      await renderStill({composition,serveUrl,inputProps,puppeteerInstance:browser,frame,output:path.join(out,rel),imageFormat:"png",logLevel:"error",cancelSignal,timeoutInMilliseconds:30000});
      frames.push({path:rel,title:scene.title,frame});
    }
    timings.stillsMs=Math.round(performance.now()-start);
  } finally {options.signal?.removeEventListener("abort",abort);await close();}
  check();
  await Bun.write(path.join(out,"frames.json"),JSON.stringify(frames,null,2));
  await run([python,path.join(here,"contact_sheet.py"),out],out);
  const video=path.join(out,"video.mp4");
  const metadata=await getVideoMetadata(video);
  check();
  if(metadata.width!==spec.width||metadata.height!==spec.height||metadata.durationInSeconds===null||Math.abs(metadata.durationInSeconds-cursor/spec.fps)>1/spec.fps+.03)throw new Error("Rendered video metadata does not match storyboard");
  report("verify-decode");start=performance.now();await run([ffmpeg,"-v","error","-i",video,"-f","null","-"],out,undefined,180000);check();timings.fullDecodeMs=Math.round(performance.now()-start);
  const manifest={version:1,title:spec.title,kind:spec.kind,createdAt:new Date().toISOString(),engine:"Remotion",remotionVersion:"4.0.526",audio:narrationCount?"Windows SAPI synthesized narration":"none; silent with burned-in captions",width:metadata.width,height:metadata.height,fps:spec.fps,durationSeconds:metadata.durationInSeconds,frames:cursor,bytes:(await stat(video)).size,sha256:hash(new Uint8Array(await Bun.file(video).arrayBuffer())),fullDecodePassed:true,visualInspection:"pending: inspect contact sheet and movie",files:["video.mp4","contact-sheet.png","storyboard.normalized.json","subtitles.srt",...frames.map(x=>x.path)],manimAssets,evidenceAssets:assets,sources:spec.sources,timings:{...timings,totalMs:Math.round(performance.now()-started)}};
  check();await Bun.write(path.join(out,"render-manifest.pending.json"),JSON.stringify(manifest,null,2));check();
  return manifest;
}
type RenderManifest=Awaited<ReturnType<typeof renderInWorker>>;
export async function renderStoryboard(specPath:string,outputDir:string,options:RenderOptions={}):Promise<RenderManifest> {
  options.signal?.throwIfAborted();
  const timeoutMs=options.timeoutMs??900000;
  if(!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>1800000)throw new Error("Media timeout must be between 100ms and 30 minutes");
  const out=path.resolve(outputDir),spec=path.resolve(specPath);
  if(!inside(outputRoot,out))throw new Error("Media output must be a new directory under repository out/");
  // Validate before creating a worker. A fresh directory also prevents reuse of
  // old success manifests or attacker-supplied symlinks below this output.
  storyboardSchema.parse(await Bun.file(spec).json());options.signal?.throwIfAborted();
  await mkdir(path.dirname(out),{recursive:true});
  await mkdir(out); // EEXIST is intentional, including incomplete earlier runs.
  if(!inside(await realpath(outputRoot),await realpath(out)))throw new Error("Media output resolves outside repository out/");
  const python=options.pythonExecutable??path.join(repo,"out/media-python",process.platform==="win32"?"Scripts/python.exe":"bin/python");
  const request=path.join(out,"render-request.json"),abortFile=path.join(out,"render-abort"),statusFile=path.join(out,"render-status.json");
  const createdAt=new Date().toISOString();let phase="starting",pending="";
  const status=(state:string)=>writeFile(statusFile,JSON.stringify({version:1,status:state,complete:state==="complete",phase,createdAt,updatedAt:new Date().toISOString()},null,2));
  const progress=(chunk:string)=>{
    pending=(pending+chunk).slice(-65536);
    let end:number;while((end=pending.indexOf("\n"))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);
      try {const event=JSON.parse(line);if(event.type==="media-progress"&&typeof event.phase==="string") {phase=event.phase;if(!options.signal?.aborted)options.onProgress?.(phase,event.detail);}} catch {/* Non-protocol library logs stay bounded in runOwned. */}
    }
  };
  try {
    await status("running");
    await writeFile(request,JSON.stringify({spec,out,abortFile,options:{pythonExecutable:python,evidenceAssets:options.evidenceAssets}}),{flag:"wx"});
    await runOwned([python,path.join(here,"owned_process.py"),process.execPath,fileURLToPath(import.meta.url),"--worker",request],repo,
      {signal:options.signal,timeoutMs,supervisor:true,abortGraceMs:5000,onStdout:progress,onAbort:()=>writeFile(abortFile,"cancelled")});
    options.signal?.throwIfAborted();
    const manifest=await Bun.file(path.join(out,"render-manifest.pending.json")).json() as RenderManifest;
    options.signal?.throwIfAborted();
    await rename(path.join(out,"render-manifest.pending.json"),path.join(out,"render-manifest.json"));
    options.signal?.throwIfAborted();phase="complete";await status("complete");options.signal?.throwIfAborted();
    options.onProgress?.("complete",{video:path.join(out,"video.mp4"),durationSeconds:manifest.durationSeconds});
    options.signal?.throwIfAborted();return manifest;
  } catch(error) {
    // Preserve partial media for diagnosis, but never leave a success manifest
    // if cancellation raced with the final write. Retry uses a new directory.
    for(const name of ["render-manifest.json","render-manifest.pending.json"]){
      if(await Bun.file(path.join(out,name)).exists()) {
        const incomplete=await Bun.file(path.join(out,name)).json();
        await writeFile(path.join(out,name),JSON.stringify({...incomplete,fullDecodePassed:false,completionStatus:options.signal?.aborted?"cancelled":"failed",validationResultsDiscarded:true},null,2));
        await rename(path.join(out,name),path.join(out,`${name}.incomplete`));
      }
    }
    await status(options.signal?.aborted?"cancelled":error instanceof DOMException&&error.name==="TimeoutError"?"timed_out":"failed");throw error;
  }
}
if(import.meta.main) {
  const [spec,out,assetMap]=Bun.argv.slice(2);
  if(spec==="--worker") {
    const request=await Bun.file(out!).json(),controller=new AbortController();let polling=false;
    const poll=setInterval(async()=>{if(polling)return;polling=true;try{if(await Bun.file(request.abortFile).exists())controller.abort(new DOMException("Media render cancelled","AbortError"));}finally{polling=false;}},100);
    try {await renderInWorker(request.spec,request.out,{...request.options,signal:controller.signal,onProgress:(phase,detail)=>console.log(JSON.stringify({type:"media-progress",phase,detail}))});}
    catch(error){console.error(String(error));process.exitCode=1;}finally{clearInterval(poll);}
  } else {
    if(!spec||!out)throw new Error("Usage: bun workflows/media/render.ts storyboard.json out/media-run [trusted-evidence-assets.json]");
    const controller=new AbortController(),cancel=()=>controller.abort(new DOMException("Media render cancelled","AbortError"));
    process.once("SIGINT",cancel);process.once("SIGTERM",cancel);
    try {const manifest=await renderStoryboard(spec,out,{signal:controller.signal,evidenceAssets:assetMap?await Bun.file(assetMap).json():undefined,onProgress:(phase,detail)=>{if(phase!=="render-progress")console.log(JSON.stringify({phase,...typeof detail==="object"?detail:{}}));}});console.log(JSON.stringify(manifest));}
    finally{process.removeListener("SIGINT",cancel);process.removeListener("SIGTERM",cancel);}
  }
}
