import { test,expect } from "bun:test";
import { mkdtemp,mkdir,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
