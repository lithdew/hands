import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";

type PreferredImage = { path: string; sha256: string; description: string };
function preferredImage(value: unknown): PreferredImage | undefined {
  if (value === undefined) return undefined;
  const candidate = value as PreferredImage | null;
  if (!candidate || typeof candidate.path !== "string" || typeof candidate.sha256 !== "string"
    || !/^[a-f0-9]{64}$/i.test(candidate.sha256) || typeof candidate.description !== "string" || !candidate.description.trim() || candidate.description.length > 2000) {
    throw new Error("Preferred evidence image requires a preview path, SHA256 and independent inspection description.");
  }
  const parts = candidate.path.split("/");
  if (parts.length < 2 || parts[0] !== "preview" || !candidate.path.toLowerCase().endsWith(".png")
    || parts.some(part => !part || part === "." || part === ".." || /[\\:%\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part))) {
    throw new Error("Preferred evidence image must be a relative PNG path under that run's preview directory.");
  }
  return candidate;
}

export async function inspectedRunEvidence(root:string,ids:string[]) {
  const assets:Record<string,string>={}, records:unknown[]=[];
  for(const id of [...new Set(ids)].slice(0,5)) {
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new Error("Evidence requires a Hands run UUID.");
    const directory=join(root,id),manifest=JSON.parse(await readFile(join(directory,"manifest.json"),"utf8"));
    const inspection=JSON.parse(await readFile(join(directory,"independent-inspection.json"),"utf8"));
    if(manifest.runId!==id||manifest.status!=="complete"||!Array.isArray(manifest.checks)||!manifest.checks.length||!manifest.checks.every((check:any)=>check.passed)
      || !["pass","pass-with-advisories"].includes(inspection.verdict) || inspection.passed===false || (inspection.runId !== undefined && inspection.runId !== id))throw new Error(`Run ${id} has not passed artifact and independent inspection checks.`);
    const preferred=preferredImage(inspection.preferredImage),previewDirectory=join(directory,"preview");
    const previewStat=await lstat(previewDirectory);
    if(!previewStat.isDirectory()||previewStat.isSymbolicLink())throw new Error("Evidence preview directory cannot be a link.");
    const selected=preferred?join(directory,preferred.path):manifest.screenshots?.[0];
    if(typeof selected!=="string")throw new Error("Evidence requires an actual preview screenshot.");
    const preview=await realpath(previewDirectory),image=await realpath(selected),path=relative(preview,image);
    if(!path||isAbsolute(path)||path.startsWith(`..${sep}`)||path===".."||!image.toLowerCase().endsWith(".png"))throw new Error("Evidence image must belong to that run's actual preview.");
    const stat=await lstat(selected);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error("Evidence image must be a regular preview file, not a link.");
    const sha256=createHash("sha256").update(await readFile(image)).digest("hex");
    if(preferred&&sha256!==preferred.sha256.toLowerCase())throw new Error("Preferred evidence image SHA256 does not match its independent inspection.");
    const key=`artifact-${records.length+1}`;assets[key]=image;
    records.push({imageId:key,runId:id,kind:manifest.kind,summary:manifest.summary,elapsedMs:manifest.elapsedMs,checks:manifest.checks,
      image:{path:`preview/${path.split(sep).join("/")}`,sha256,selection:preferred?"independently-inspected-preferred":"original-preview",description:preferred?.description},inspection});
  }
  return{assets,records};
}
