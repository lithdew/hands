import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute, resolve, sep } from "node:path";

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

/** The shared composition shows an evidence image in a 1164x448 panel of the
 * 1280x720 frame. A 1440x900 desktop capture fitted into it shrinks to half
 * size between empty gutters and its page copy becomes unreadable. */
export const EVIDENCE_PANEL = { width: 1164, height: 448 };
export type EvidenceCrop = { left: number; top: number; width: number; height: number };
export type CropImage = (source: string, destination: string, crop: EvidenceCrop) => Promise<void>;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value) || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** The top region at the panel's aspect ratio: the pixels a visitor sees first,
 * unchanged. Captures already close to the panel shape are shown whole. */
export function focusedCrop(width: number, height: number, panel = EVIDENCE_PANEL): EvidenceCrop | undefined {
  const targetHeight = Math.round(width * panel.height / panel.width);
  if (!Number.isFinite(targetHeight) || targetHeight < 1 || height <= targetHeight * 1.15) return undefined;
  return { left: 0, top: 0, width, height: targetHeight };
}

/** Pixel-exact crop through the media Python environment (Pillow), the same
 * toolchain the renderer already relies on for its contact sheet. */
export const cropWithPillow: CropImage = async (source, destination, crop) => {
  const python = join(resolve(import.meta.dir, ".."), "out/media-python", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!await Bun.file(python).exists()) throw new Error("Media Python environment missing; see workflows/media/README.md setup");
  const process_ = Bun.spawn([python, join(import.meta.dir, "evidence_crop.py"), source, destination, ...[crop.left, crop.top, crop.width, crop.height].map(String)], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([process_.exited, new Response(process_.stderr).text()]);
  if (code !== 0) throw new Error(`Evidence crop failed: ${stderr.trim().slice(0, 400)}`);
};

type ImageRecord = { path: string; sha256: string; selection: string; description?: string; crop?: EvidenceCrop; sourcePath?: string; sourceSha256?: string; sourceSize?: { width: number; height: number }; note?: string };
async function focusedEvidence(directory: string, previewPath: string, image: string, bytes: Uint8Array, kind: unknown, crop: CropImage): Promise<{ image: string; record: ImageRecord } | undefined> {
  const size = pngDimensions(bytes), box = size && focusedCrop(size.width, size.height);
  if (!size || !box) return undefined;
  const name = `evidence-top-${box.width}x${box.height}.png`, derived = join(directory, "preview", name), sidecar = `${derived}.provenance.json`;
  const sourceSha256 = sha(bytes), sourcePath = `preview/${previewPath}`;
  const description = `Top ${box.height}px of the ${size.width}x${size.height} ${typeof kind === "string" ? kind : "artifact"} desktop preview, pixels unchanged; the region a visitor sees first, shaped for the video's wide evidence panel so on-page text stays legible.`;
  const record = (sha256: string): ImageRecord => ({ path: `preview/${name}`, sha256, selection: "top-region-crop", crop: box, sourcePath, sourceSha256, sourceSize: size, description });
  try {
    const saved = JSON.parse(await readFile(sidecar, "utf8")), existing = await readFile(derived);
    if (saved.sourceSha256 === sourceSha256 && saved.sha256 === sha(existing) && JSON.stringify(saved.crop) === JSON.stringify(box)) return { image: derived, record: record(saved.sha256) };
  } catch { /* No reusable crop yet. */ }
  const temporary = `${derived}.${process.pid}.tmp.png`;
  await crop(image, temporary, box);
  const sha256 = sha(await readFile(temporary));
  await writeFile(sidecar, JSON.stringify({ runId: directory.split(/[\\/]/).at(-1), createdAt: new Date().toISOString(), method: "Pixel-exact top-region crop of the unchanged inspected preview screenshot (workflows/evidence_crop.py); no resizing, redrawing or annotation.", sourcePath, sourceSha256, sourceSize: size, crop: box, sha256 }, null, 2));
  await rm(derived, { force: true }); await rename(temporary, derived);
  return { image: derived, record: record(sha256) };
}

export async function inspectedRunEvidence(root:string,ids:string[],options:{crop?:CropImage|null}={}) {
  const assets:Record<string,string>={}, records:unknown[]=[];
  const crop = options.crop === undefined ? cropWithPillow : options.crop;
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
    const bytes=await readFile(image),sha256=sha(bytes),previewPath=path.split(sep).join("/");
    if(preferred&&sha256!==preferred.sha256.toLowerCase())throw new Error("Preferred evidence image SHA256 does not match its independent inspection.");
    let chosen=image, imageRecord:ImageRecord={path:`preview/${previewPath}`,sha256,selection:preferred?"independently-inspected-preferred":"original-preview",description:preferred?.description};
    // An inspector-chosen image is already focused. Otherwise offer the top
    // region of the tall desktop capture; a failed crop keeps the original
    // and says so rather than blocking the pitch.
    if(!preferred&&crop){
      try{const focused=await focusedEvidence(directory,previewPath,image,bytes,manifest.kind,crop);if(focused){chosen=focused.image;imageRecord=focused.record;}}
      catch(error){imageRecord.note=`Focused crop unavailable, original preview used: ${String(error instanceof Error?error.message:error).slice(0,300)}`;}
    }
    const key=`artifact-${records.length+1}`;assets[key]=chosen;
    records.push({imageId:key,runId:id,kind:manifest.kind,summary:manifest.summary,elapsedMs:manifest.elapsedMs,checks:manifest.checks,image:imageRecord,inspection});
  }
  return{assets,records};
}
