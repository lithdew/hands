import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BundleSchema, PlanSchema, parseJson, type ArtifactBundle } from "./contracts";
import type { SourceRecord } from "./sources";

export async function loadCheckpoint(root: string, id: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error("Resume requires a saved Hands run UUID.");
  const directory = join(root, id);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid checkpoint directory.");
  const plan = PlanSchema.parse(JSON.parse(await readFile(join(directory, "plan.json"), "utf8")));
  const sources: SourceRecord[] = JSON.parse(await readFile(join(directory, "sources.json"), "utf8"));
  if (!Array.isArray(sources) || sources.length > 32) throw new Error("Invalid checkpoint sources.");
  const names = await readdir(directory);
  let bundle: ArtifactBundle | undefined;
  const attempts = names.filter(n => /^attempt-\d+$/.test(n)).sort((a,b) => Number(b.slice(8)) - Number(a.slice(8)));
  for (const attempt of attempts) {
    try { bundle = parseJson(await readFile(join(directory, attempt, "bundle.json"), "utf8"), BundleSchema); break; } catch {}
  }
  if (!bundle) for (const name of names.filter(n => /^(creating|repair)-\d+\.json$/.test(n)).sort((a,b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))) {
    try { bundle = parseJson(JSON.parse(await readFile(join(directory, name), "utf8")).text, BundleSchema); break; } catch {}
  }
  let previousInspection: unknown, previousManifest: unknown;
  try { previousInspection=JSON.parse(await readFile(join(directory,"independent-inspection.json"),"utf8")); } catch {}
  try { previousManifest=JSON.parse(await readFile(join(directory,"manifest.json"),"utf8")); } catch {}
  return { plan, sources, bundle, fromRunId: id, previousInspection, previousManifest };
}

export function citationAliases(source: SourceRecord, includeDiscovery = false): string[] {
  if (source.status !== "ok" || source.kind === "search" && !includeDiscovery) return [];
  const urls = [source.url, source.requestedUrl, source.finalUrl].filter((url): url is string => !!url);
  for (const value of [...urls]) {
    const url = new URL(value);
    if (url.searchParams.get("error") === "cookies_not_supported") {
      url.searchParams.delete("error"); urls.push(url.href);
    }
  }
  return [...new Set(urls)];
}

export function needsSourceRefresh(source: SourceRecord) {
  return source.status !== "ok" || /arxiv\.org\/(?:abs|pdf)\//.test(source.requestedUrl ?? source.url) && source.evidenceExtent !== "fulltext-excerpt";
}
