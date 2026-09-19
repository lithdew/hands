import {expect, test} from "bun:test";
import {mkdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {renderStoryboard} from "./render";

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const root=path.join(repo,"out",`media-cancel-test-${crypto.randomUUID()}`);
const spec=path.join(root,"storyboard.json");
async function fixture() {
  await mkdir(root,{recursive:true});
  await Bun.write(spec,JSON.stringify({version:1,title:"Cancellation fixture",kind:"pitch",sources:[],scenes:[
    {id:"opening",title:"A small render",visual:"title",durationSeconds:3,caption:"Owned renderer fixture"},
    {id:"closing",title:"Complete or cancelled",visual:"closing",durationSeconds:3,caption:"No account browser involved"},
  ]}));
}

test("pre-cancelled render creates no worker or output",async()=>{
  const out=path.join(root,"pre-cancelled");
  await expect(renderStoryboard("must-not-read.json",out,{signal:AbortSignal.abort(new Error("task corrected"))})).rejects.toThrow("task corrected");
  expect(await Bun.file(path.join(out,"render-status.json")).exists()).toBe(false);
});

const integration=process.env.HANDS_MEDIA_INTEGRATION==="1";
for(const cancelPhase of ["bundle","render-progress","verify-decode"]) {
  test.skipIf(!integration)(`cancel during ${cancelPhase} leaves incomplete files and no success manifest`,async()=>{
    await fixture();const out=path.join(root,cancelPhase),abort=new AbortController();const phases:string[]=[];let cancelledAt=0;
    await expect(renderStoryboard(spec,out,{signal:abort.signal,onProgress:phase=>{
      phases.push(phase);if(phase===cancelPhase&&!abort.signal.aborted){cancelledAt=performance.now();abort.abort(new Error(`cancel at ${cancelPhase}`));}
    }})).rejects.toThrow(`cancel at ${cancelPhase}`);
    expect(cancelledAt).toBeGreaterThan(0);expect(performance.now()-cancelledAt).toBeLessThan(7500);
    const status=await Bun.file(path.join(out,"render-status.json")).json();
    expect(status).toMatchObject({status:"cancelled",complete:false});
    expect(await Bun.file(path.join(out,"render-manifest.json")).exists()).toBe(false);
    expect(phases).not.toContain("complete");
    if(cancelPhase!=="verify-decode")expect(phases).not.toContain("verify-decode");
    expect(await Bun.file(path.join(out,"storyboard.normalized.json")).exists()).toBe(true);
  },90000);
}

test.skipIf(!integration)("uncancelled worker renders and fully decodes a real playable movie",async()=>{
  await fixture();const out=path.join(root,"complete");
  const manifest=await renderStoryboard(spec,out);
  expect(manifest.fullDecodePassed).toBe(true);expect(manifest.frames).toBe(144);
  expect(manifest.durationSeconds).toBeGreaterThanOrEqual(6);
  expect(await Bun.file(path.join(out,"render-status.json")).json()).toMatchObject({status:"complete",complete:true});
  expect(await Bun.file(path.join(out,"render-manifest.json")).exists()).toBe(true);
  await expect(renderStoryboard(spec,out)).rejects.toThrow("EEXIST");
},90000);
