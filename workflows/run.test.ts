import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleSchema, CreativeReviewSchema, creativeReviewPassed, looksLikeArtifactRequest } from "./contracts";
import { runArtifactWorkflow, storyboardCheck, videoPlayerNote } from "./run";
import type { Ask } from "../jev/jev";
import { citationAliases } from "./checkpoint";

const bundle = {title:"Generated report",summary:"A complete fixture report",entrypoint:"index.html",files:[{path:"index.html",content:"<!doctype html><title>Report</title><h1>Verified report</h1>"}],sources:[],limitations:[]};
const plan = {title:"Report",kind:"report",brief:"Make the requested report",sources:[],requiredFiles:["index.html"],checks:["Meaningful report"]};
const review = {passed:true,summary:"Checked the content",issues:[]};
const ask: Ask = async (_state, questions) => Object.fromEntries(Object.entries(questions).map(([key, q]) => [key,{type:"choice",choice:key==="kind"?"report":key==="model"?"gpt-5.6-luna":Object.keys((q as any).criteria)[0],confidence:1}])) as never;

test("creative acceptance cannot be granted by a positive summary with weak craft scores", () => {
  const good = {score:4,evidence:"Observed deliberate type scale and alignment"};
  const scored = CreativeReviewSchema.parse({...review,hierarchy:good,typography:good,composition:good,distinctiveness:good,briefFit:good});
  expect(creativeReviewPassed(scored)).toBe(true);
  expect(creativeReviewPassed({...scored,distinctiveness:{score:2,evidence:"Uniform generic cards"}})).toBe(false);
  expect(creativeReviewPassed({...scored,composition:{score:3,evidence:"Ordinary composition"}})).toBe(false);
  expect(creativeReviewPassed({...scored,issues:[{severity:"error",file:"index.html",detail:"Mobile action obscured"}]})).toBe(false);
});

test("self-contained creative plans skip network research and publish real observable progress", async () => {
  const root=await mkdtemp(join(tmpdir(),"hands-no-research-"));let calls=0;
  try {
    const readyAsk:Ask=async(state,questions,options)=>{if((state as any).phase==="plan_returned"){expect((state as any).boundedLocalPlanValidated).toBe(true);expect(Object.keys((questions.action as any).criteria)).toEqual(["research"]);}return ask(state,questions,options);};
    const result=await runArtifactWorkflow({request:"Build a local prototype"},{outputRoot:root,ask:readyAsk,model:async()=>({text:JSON.stringify([plan,bundle,review][calls++]),model:"gpt-5.6-luna"}),gather:async()=>{throw new Error("Unexpected network research");},preview:async()=>({checks:[],screenshots:[]})});
    const progress=JSON.parse(await readFile(join(result.directory,"progress.json"),"utf8"));
    expect(progress.runId).toBe(result.runId);expect(progress.phase).toBe("complete");expect(progress.previewUrl).toBe(result.previewUrl);
    expect(progress.events.some((event:any)=>event.event==="jev_handoff")).toBe(true);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("checkpoint reuses complete model work but independently validates it before delivery", async()=>{
  const root=await mkdtemp(join(tmpdir(),"hands-checkpoint-")),id=crypto.randomUUID();let calls=0,retrievals=0;
  try{
    const directory=join(root,id);await mkdir(join(directory,"attempt-0"),{recursive:true});
    await writeFile(join(directory,"plan.json"),JSON.stringify(plan));
    await writeFile(join(directory,"sources.json"),JSON.stringify([{url:"https://arxiv.org/search",title:"Discovery",status:"ok",kind:"search",retrievedAt:"2026-09-19"}]));
    await writeFile(join(directory,"attempt-0","bundle.json"),JSON.stringify(bundle));
    const result=await runArtifactWorkflow({request:"Create a report",resumeRunId:id},{outputRoot:root,ask,model:async()=>{calls++;return{text:JSON.stringify(review),model:"gpt-6-astra"};},gather:async()=>{retrievals++;return[];},preview:async()=>({checks:[{name:"preview",passed:true,detail:"fixture"}],screenshots:[]})});
    expect(result.status).toBe("complete");expect(calls).toBe(1);expect(retrievals).toBe(0);
    expect(result.events.some(event=>event.event==="bundle_reused")).toBe(true);
    expect(result.events.filter(event=>event.event==="jev_decision")).toHaveLength(4);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("an independent failed inspection repairs the checkpoint before reviewing or rendering again", async()=>{
  const root=await mkdtemp(join(tmpdir(),"hands-inspected-repair-"));let calls=0;
  const base={outputRoot:root,ask,gather:async()=>[],preview:async()=>({checks:[],screenshots:[]})};
  try{
    const original=await runArtifactWorkflow({request:"Create a report"},{...base,model:async()=>({text:JSON.stringify([plan,bundle,review][calls++]),model:"gpt-6-astra"})});
    await writeFile(join(original.directory,"independent-inspection.json"),JSON.stringify({passed:false,defects:["The printed answer is missing"]}));
    const roles:string[]=[];
    const resumed=await runArtifactWorkflow({request:"Repair the observed report",resumeRunId:original.runId},{...base,model:async(prompt)=>{
      roles.push(prompt.includes("Repair contract overrides")?"repair":"review");
      if(roles.length===1){expect(prompt).toContain("The printed answer is missing");return{text:JSON.stringify({replacements:[{path:"index.html",content:"<!doctype html><title>Report</title><h1>Verified report</h1><p>Printed answer included.</p>"}]}),model:"gpt-6-astra"};}
      return{text:JSON.stringify(review),model:"gpt-6-astra"};
    }});
    expect(roles).toEqual(["repair","review"]);expect(resumed.status).toBe("complete");
    expect(await readFile(join(resumed.directory,"files","index.html"),"utf8")).toContain("Printed answer included.");
  }finally{await rm(root,{recursive:true,force:true});}
});

test("only real primary retrieval aliases authorize citations",()=>{
  const source={url:"https://arxiv.org/pdf/2601.00001",requestedUrl:"https://arxiv.org/abs/2601.00001",finalUrl:"https://arxiv.org/pdf/2601.00001",status:"ok" as const,title:"Paper",retrievedAt:"today"};
  expect(citationAliases(source)).toHaveLength(2);
  expect(citationAliases({...source,kind:"search"})).toEqual([]);
  expect(citationAliases({...source,status:"failed"})).toEqual([]);
});

test("execution-only recovery skips content regeneration only when saved hashes still match",async()=>{
  const root=await mkdtemp(join(tmpdir(),"hands-render-resume-"));let calls=0;
  const deps={outputRoot:root,ask,gather:async()=>[],model:async()=>({text:JSON.stringify([plan,bundle,review][calls++]),model:"gpt-6-astra"}),preview:async()=>({checks:[{name:"preview",passed:true,detail:"fixture"}],screenshots:[]})};
  try{
    const original=await runArtifactWorkflow({request:"Create a report"},deps);calls=0;
    const resumed=await runArtifactWorkflow({request:"Create a report",resumeRunId:original.runId,executeOnly:true},deps);
    expect(resumed.status).toBe("complete");expect(calls).toBe(0);
    await writeFile(join(original.directory,"attempt-0","bundle.json"),JSON.stringify({...bundle,summary:"changed",files:[{...bundle.files[0],content:"tampered"}]}));
    await expect(runArtifactWorkflow({request:"Create a report",resumeRunId:original.runId,executeOnly:true},deps)).rejects.toThrow("unchanged bundle");
  }finally{await rm(root,{recursive:true,force:true});}
});

test("video storyboards are validated against the renderer schema before review so overload is repaired, not rendered", () => {
  const scenes=[{id:"opening",title:"Why an inverse?",visual:"title",durationSeconds:4},{id:"example",title:"Undo A",visual:"matrix",durationSeconds:6,matrix:[[2,1],[1,1]]}];
  const storyboard=(extra:object)=>({...bundle,files:[...bundle.files,{path:"storyboard.json",content:JSON.stringify({version:1,title:"Lesson",kind:"matrix-inversion",sources:[],scenes,...extra})}]});
  expect(storyboardCheck(bundle)).toMatchObject({name:"storyboard-schema",passed:false,detail:expect.stringContaining("missing")});
  expect(storyboardCheck(storyboard({}))).toMatchObject({passed:true,detail:expect.stringContaining("2 scenes")});
  const overloaded=storyboardCheck(storyboard({scenes:[{...scenes[0],title:"A title that is far too long for a phone-sized player to show at readable size"},scenes[1]]}));
  expect(overloaded.passed).toBe(false);expect(overloaded.detail).toContain("scenes.0.title");
});

test("video page reviews judge controls from recorded probe facts, not auto-hidden browser chrome", () => {
  const desktop={label:"desktop",controls:true,progressed:true,pageControls:["Fullscreen"],captured:"mid-playback" as const};
  const note=videoPlayerNote([desktop]);
  for(const fact of ["controls attribute present","playback advanced","page affordances Fullscreen","captured mid-playback"])expect(note).toContain(fact);
  expect(note).toContain("not expected to be visible in a mid-playback capture");
  expect(note).toContain("Judge usable controls from the recorded facts");
  expect(note).toContain("controls absent both natively and on the page");
  expect(note).not.toMatch(/visible (?:native|play\/pause) controls (?:are|is) required/i);
  expect(videoPlayerNote([{...desktop,label:"mobile",controls:false,pageControls:[],captured:"paused"}])).toContain("controls attribute absent; playback advanced during the probe; page affordances none; captured paused");
  expect(videoPlayerNote([])).toBe("");
});

test("only concrete artifact requests use the specialist workflow", () => {
  expect(looksLikeArtifactRequest("Make a mock exam for calc 1 and calc 2")).toBe(true);
  expect(looksLikeArtifactRequest("Create a presentation video using Remotion")).toBe(true);
  expect(looksLikeArtifactRequest("Make a summary of frontier research in reinforcement learning")).toBe(true);
  expect(looksLikeArtifactRequest("Send my sister a test email")).toBe(false);
  expect(looksLikeArtifactRequest("Open this website")).toBe(false);
});

test("returned files cannot traverse, collide on Windows or substitute a missing entrypoint", () => {
  for(const path of ["../report.html","C:/index.html","nested//index.html","con.html",".env","script.ps1"])
    expect(BundleSchema.safeParse({...bundle,entrypoint:path,files:[{path,content:"x"}]}).success).toBe(false);
  expect(BundleSchema.safeParse({...bundle,files:[...bundle.files,{path:"INDEX.html",content:"overwrite"}]}).success).toBe(false);
  expect(BundleSchema.safeParse({...bundle,entrypoint:"missing.html"}).success).toBe(false);
});

test("specialist returns to live Jev decisions before save, preview and delivery", async () => {
  const directory=await mkdtemp(join(tmpdir(),"hands-workflow-"));
  let calls=0; const observed:string[]=[];
  try {
    const result=await runArtifactWorkflow({request:"Create a research report",onEvent:event=>observed.push(event.event)}, {
      outputRoot:directory,ask,model:async()=>({text:JSON.stringify([plan,bundle,review][calls++]),model:"gpt-5.6-luna"}),gather:async()=>[],
      preview:async input=>{expect(await readFile(join(input.directory,input.entrypoint),"utf8")).toContain("Verified report");return {checks:[{name:"render",passed:true,detail:"fixture"}],screenshots:[]};},
    });
    expect(result.status).toBe("complete");expect(calls).toBe(3);
    expect(observed.filter(name=>name==="agent_returned")).toHaveLength(3);
    expect(observed.filter(name=>name==="jev_decision")).toHaveLength(4);
    expect(observed.indexOf("jev_decision")).toBeGreaterThan(observed.indexOf("agent_returned"));
    expect(JSON.parse(await readFile(join(result.directory,"manifest.json"),"utf8")).status).toBe("complete");
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("malformed or cancelled agent output cannot reach file execution", async () => {
  for(const cancel of [false,true]){
    const directory=await mkdtemp(join(tmpdir(),"hands-abort-")),controller=new AbortController();let calls=0,previewed=false;
    try{
      const promise=runArtifactWorkflow({request:"Create a research report",signal:controller.signal},{outputRoot:directory,ask,gather:async()=>[],model:async()=>{calls++; if(calls===2&&cancel)controller.abort();return {text:calls===1?JSON.stringify(plan):"{malformed",model:"gpt-5.6-luna"};},preview:async()=>{previewed=true;return {checks:[],screenshots:[]};}});
      await expect(promise).rejects.toThrow();expect(previewed).toBe(false);
    }finally{await rm(directory,{recursive:true,force:true});}
  }
});

test("failed content checks return to the specialist without counting a completed task",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hands-repair-"));let calls=0;
  const badReview={passed:false,summary:"Missing a requested proof",issues:[{severity:"error",file:"index.html",detail:"Proof missing"}]};
  try{
    const result=await runArtifactWorkflow({request:"Create a mathematical research report"},{outputRoot:directory,ask,gather:async()=>[],model:async()=>({text:JSON.stringify([plan,bundle,badReview,{replacements:bundle.files},review][calls++]),model:"gpt-6-astra"}),preview:async()=>({checks:[{name:"render",passed:false,detail:"Observed horizontal overflow"}],screenshots:[]})});
    expect(calls).toBe(5);expect(result.status).toBe("needs-review");expect(result.events.some(event=>event.phase==="repair")).toBe(true);
  }finally{await rm(directory,{recursive:true,force:true});}
});
