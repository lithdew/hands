/** Run the same Hands workflow used by /task, with reproducible acceptance briefs. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runArtifactWorkflow, type ArtifactInput } from "./run";
import { ArtifactPathSchema } from "./contracts";
import { inspectedRunEvidence } from "./evidence";

export async function caseInput(path: string): Promise<ArtifactInput> {
  const brief = JSON.parse(await readFile(path, "utf8"));
  const request = brief.task ?? brief.prompt ?? brief.request ?? brief.rawUserTask;
  if (typeof request !== "string" || !request.trim()) throw new Error("Case has no task request.");
  let packet: unknown;
  if (brief.sourcePacket) packet = JSON.parse(await readFile(resolve(brief.sourcePacket), "utf8"));
  const p = packet as { publicResearch?: {url:string;title?:string}[]; sources?: {url:string;title?:string}[] } | undefined;
  const sources = [...(brief.sources ?? []), ...(p?.sources ?? []), ...(p?.publicResearch ?? [])].filter(source => typeof source.url === "string");
  let context = JSON.stringify({ caseBrief: brief, sourcePacket: packet }, null, 2);
  // Only the case author's exact repository evidence allowlist is read. Never
  // follow generated paths or arbitrary files supplied by an external source.
  const repositorySources = new Set(["README.md", "docs/jev-evals.md", "docs/jev-evals-2026-09-19.json", "docs/mail-evals-2026-09-19.json", "docs/authorization-smoke-2026-09-19.json"]);
  for (const source of brief.sources ?? []) if (repositorySources.has(source.path)) {
    context += `\nRepository evidence ${source.path}:\n${(await readFile(source.path, "utf8")).slice(0, 16_000)}`;
  }
  const artifacts = brief.requiredArtifacts ?? [];
  const requiredFiles: string[] = brief.artifactContract?.requiredFiles ?? artifacts.map((artifact: any) => typeof artifact === "string" ? artifact : artifact.suggestedFilename ?? artifact.filename ?? artifact.path).filter(Boolean);
  const rubric = brief.rubric?.mustPass ?? (Array.isArray(brief.rubric) ? brief.rubric : []);
  const checks = rubric.map((item: unknown) => typeof item === "string" ? item : item && typeof item === "object" && "criterion" in item ? String(item.criterion) : item && typeof item === "object" && "check" in item ? String(item.check) : "").filter(Boolean);
  if (brief.qualityProfile !== undefined && !["standard", "creative"].includes(brief.qualityProfile)) throw new Error("Unknown artifact quality profile.");
  return { request, searchRequest:brief.rawUserTask ?? request, context, sources, qualityProfile: brief.qualityProfile, requiredFiles:requiredFiles.filter(path=>ArtifactPathSchema.safeParse(path).success), checks };
}

if (import.meta.main) {
  try {
    const path = process.argv[2]; if (!path) throw new Error("Usage: bun workflows/eval.ts evals/cases/<case>.json [--evidence previous-run-id ...]");
    const input = await caseInput(path);
    const resumeAt = process.argv.indexOf("--resume");
    if (resumeAt >= 0) input.resumeRunId = process.argv[resumeAt + 1];
    input.executeOnly=process.argv.includes("--execute-only");
    input.previewOnly=process.argv.includes("--preview-only");
    input.reuseMedia=process.argv.includes("--reuse-media");
    const evidenceAt = process.argv.indexOf("--evidence");
    if (evidenceAt >= 0) {
      const ids:string[]=[];
      for(const value of process.argv.slice(evidenceAt+1)){if(value.startsWith("--"))break;ids.push(value);}
      if(!ids.length)throw new Error("--evidence requires at least one inspected Hands run UUID.");
      const evidence=await inspectedRunEvidence(resolve("out/artifacts"),ids);
      input.evidenceAssets=evidence.assets;
      input.context = `Verified independently inspected Hands output evidence: ${JSON.stringify(evidence.records)}\n${input.context ?? ""}`;
    }
    const abort = new AbortController(); process.on("SIGINT", () => abort.abort()); input.signal = abort.signal;
    input.onEvent = event => console.log(JSON.stringify(event));
    input.onStatus = artifact => { if (artifact.phase === "routing") console.log(JSON.stringify({ runId: artifact.runId })); };
    const result = await runArtifactWorkflow(input);
    console.log(JSON.stringify({runId:result.runId,status:result.status,path:result.directory,elapsedMs:result.elapsedMs,checks:result.checks}));
    if (result.status !== "complete") process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : "Hands artifact evaluation failed"); process.exitCode = 1; }
}
