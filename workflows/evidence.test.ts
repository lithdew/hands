import { test,expect } from "bun:test";
import { mkdtemp,mkdir,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { inspectedRunEvidence } from "./evidence";
test("pitch evidence requires completed inspected runs and their own preview images",async()=>{
  const root=await mkdtemp(join(tmpdir(),"hands-evidence-")),id=crypto.randomUUID(),directory=join(root,id);
  try{
    await mkdir(join(directory,"preview"),{recursive:true});const png=join(directory,"preview","desktop.png");await writeFile(png,"fixture");
    const manifest={runId:id,status:"complete",kind:"website",summary:"Example",checks:[{passed:true}],screenshots:[png]};
    await writeFile(join(directory,"manifest.json"),JSON.stringify(manifest));await writeFile(join(directory,"independent-inspection.json"),JSON.stringify({verdict:"pass-with-advisories"}));
    expect(Object.keys((await inspectedRunEvidence(root,[id])).assets)).toEqual(["artifact-1"]);
    await writeFile(join(directory,"independent-inspection.json"),JSON.stringify({verdict:"failed"}));await expect(inspectedRunEvidence(root,[id])).rejects.toThrow("not passed");
    await writeFile(join(directory,"independent-inspection.json"),JSON.stringify({verdict:"pass"}));const outside=join(root,"unrelated.png");await writeFile(outside,"private");
    await writeFile(join(directory,"manifest.json"),JSON.stringify({...manifest,screenshots:[outside]}));await expect(inspectedRunEvidence(root,[id])).rejects.toThrow("belong");
    await expect(inspectedRunEvidence(root,["../../private"])).rejects.toThrow("UUID");
  }finally{await rm(root,{recursive:true,force:true});}
});

test("uses a hash-matched independently inspected preferred image and retains the original fallback",async()=>{
  const root=await mkdtemp(join(tmpdir(),"hands-evidence-")),id=crypto.randomUUID(),directory=join(root,id);
  try{
    await mkdir(join(directory,"preview"),{recursive:true});
    const png=join(directory,"preview","desktop.png"),focused=join(directory,"preview","question.png"),contents="actual focused capture";
    await writeFile(png,"original screenshot");await writeFile(focused,contents);
    const manifest={runId:id,status:"complete",kind:"report",summary:"Exam",checks:[{passed:true}],screenshots:[png]};
    const sha256=createHash("sha256").update(contents).digest("hex");
    const inspection={runId:id,verdict:"pass-with-advisories",passed:true,preferredImage:{path:"preview/question.png",sha256,description:"Actual Q5 question and solution, faithful cropped source screenshots."}};
    await writeFile(join(directory,"manifest.json"),JSON.stringify(manifest));await writeFile(join(directory,"independent-inspection.json"),JSON.stringify(inspection));
    const preferred=await inspectedRunEvidence(root,[id,id]);
    expect(preferred.assets).toEqual({"artifact-1":focused});
    expect(preferred.records).toHaveLength(1);
    expect((preferred.records[0] as any).image).toEqual({path:"preview/question.png",sha256,selection:"independently-inspected-preferred",description:inspection.preferredImage.description});
    await writeFile(focused,"changed after review");
    await expect(inspectedRunEvidence(root,[id])).rejects.toThrow("SHA256 does not match");
    await writeFile(join(directory,"independent-inspection.json"),JSON.stringify({verdict:"pass"}));
    const fallback=await inspectedRunEvidence(root,[id]);
    expect(fallback.assets).toEqual({"artifact-1":png});
    expect((fallback.records[0] as any).image.selection).toBe("original-preview");
  }finally{await rm(root,{recursive:true,force:true});}
});

test("rejects preferred path escapes and malformed inspection metadata without falling back",async()=>{
  const root=await mkdtemp(join(tmpdir(),"hands-evidence-")),id=crypto.randomUUID(),directory=join(root,id);
  try{
    await mkdir(join(directory,"preview"),{recursive:true});const png=join(directory,"preview","desktop.png");await writeFile(png,"fixture");
    const manifest={runId:id,status:"complete",checks:[{passed:true}],screenshots:[png]};
    await writeFile(join(directory,"manifest.json"),JSON.stringify(manifest));
    const image={path:"preview/desktop.png",sha256:createHash("sha256").update("fixture").digest("hex"),description:"Actual image"};
    for(const path of ["../private.png","preview/../private.png","preview//desktop.png","preview\\desktop.png",png,"preview/desktop.png:secret","preview/%2e%2e/private.png","files/image.png"]){
      await writeFile(join(directory,"independent-inspection.json"),JSON.stringify({verdict:"pass",preferredImage:{...image,path}}));
      await expect(inspectedRunEvidence(root,[id])).rejects.toThrow("relative PNG path");
    }
    for(const preferredImage of [{...image,sha256:"invalid"},{...image,description:""},null]){
      await writeFile(join(directory,"independent-inspection.json"),JSON.stringify({verdict:"pass",preferredImage}));
      await expect(inspectedRunEvidence(root,[id])).rejects.toThrow("requires a preview path");
    }
    for(const inspection of [{verdict:"pass-unreviewed"},{verdict:"pass",passed:false},{verdict:"pass",runId:crypto.randomUUID()}]){
      await writeFile(join(directory,"independent-inspection.json"),JSON.stringify(inspection));
      await expect(inspectedRunEvidence(root,[id])).rejects.toThrow("not passed");
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
