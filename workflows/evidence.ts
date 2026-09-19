import { readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";

export async function inspectedRunEvidence(root:string,ids:string[]) {
  const assets:Record<string,string>={}, records:unknown[]=[];
  for(const id of [...new Set(ids)].slice(0,5)) {
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new Error("Evidence requires a Hands run UUID.");
    const directory=join(root,id),manifest=JSON.parse(await readFile(join(directory,"manifest.json"),"utf8"));
    const inspection=JSON.parse(await readFile(join(directory,"independent-inspection.json"),"utf8"));
    if(manifest.runId!==id||manifest.status!=="complete"||!manifest.checks?.every((check:any)=>check.passed)||!/^pass/.test(inspection.verdict??""))throw new Error(`Run ${id} has not passed artifact and independent inspection checks.`);
    const preview=await realpath(join(directory,"preview")),image=await realpath(manifest.screenshots[0]),path=relative(preview,image);
    if(!path||isAbsolute(path)||path.startsWith(`..${sep}`)||path===".."||!image.endsWith(".png"))throw new Error("Evidence image must belong to that run's actual preview.");
    const key=`artifact-${records.length+1}`;assets[key]=image;
    records.push({imageId:key,runId:id,kind:manifest.kind,summary:manifest.summary,elapsedMs:manifest.elapsedMs,checks:manifest.checks,inspection});
  }
  return{assets,records};
}
