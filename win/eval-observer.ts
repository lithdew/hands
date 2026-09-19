import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_ROOT } from "./artifacts";

const RUN_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const timestamp = (value: unknown) => typeof value === "number" ? number(value) : typeof value === "string" ? number(Date.parse(value)) : 0;
export type EvalProgress = {
  runId: string; kind: string; phase: string; model: string; request: string;
  updatedAt: number; startedAt: number; elapsedMs: number; parentRunId?: string; previewUrl?: string;
  events: { atMs: number; event: string; phase: string; model?: string; durationMs?: number; count?: number; detail?: string }[];
  checks: { name: string; passed: boolean; detail: string }[];
};

/** Progress is an observation of the runtime, never permission to call a control route. */
export function evalProgress(value: unknown, runId: string): EvalProgress | null {
  if (!value || typeof value !== "object" || !RUN_ID.test(runId)) return null;
  const source = value as Record<string, unknown>;
  if (source.runId !== runId || !["report", "website", "video"].includes(String(source.kind))) return null;
  const result: EvalProgress = {
    runId, kind: String(source.kind), phase: text(source.phase, 80), model: text(source.model, 120), request: text(source.request, 2400),
    updatedAt: timestamp(source.updatedAt), startedAt: timestamp(source.startedAt), elapsedMs: number(source.elapsedMs),
    events: [], checks: [],
  };
  if (!result.phase || !result.updatedAt) return null;
  if (typeof source.parentRunId === "string" && RUN_ID.test(source.parentRunId)) result.parentRunId = source.parentRunId;
  const prefix = `/artifacts/${runId}/`;
  if (typeof source.previewUrl === "string" && source.previewUrl.startsWith(prefix)) {
    const tail = source.previewUrl.slice(prefix.length);
    if (tail && tail.split("/").every(part => part && part !== "." && part !== ".." && !/[\\:%?#\x00-\x1f\x7f]/.test(part) && !/[. ]$/.test(part))) result.previewUrl = source.previewUrl;
  }
  if (Array.isArray(source.events)) result.events = source.events.slice(-40).filter(item => item && typeof item === "object").map(item => ({
    atMs: number(item.atMs), event: text(item.event, 80), phase: text(item.phase, 80),
    ...(typeof item.model === "string" ? { model: text(item.model, 120) } : {}),
    ...(typeof item.durationMs === "number" ? { durationMs: number(item.durationMs) } : {}),
    ...(typeof item.count === "number" ? { count: number(item.count) } : {}),
    ...(typeof item.detail === "string" ? { detail: text(item.detail, 600) } : {}),
  }));
  if (Array.isArray(source.checks)) result.checks = source.checks.slice(-80).filter(item => item && typeof item === "object" && typeof item.passed === "boolean").map(item => ({ name: text(item.name, 160), passed: item.passed, detail: text(item.detail, 600) }));
  return result;
}

/** Only bounded regular progress files are read; generated bundles and private run logs are not served. */
export async function recentEvals(root = ARTIFACT_ROOT): Promise<EvalProgress[]> {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
    const entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && RUN_ID.test(entry.name));
    const dated = await Promise.all(entries.map(async entry => ({ id: entry.name, updated: (await lstat(join(root, entry.name))).mtimeMs })));
    const selected = dated.sort((a, b) => b.updated - a.updated).slice(0, 64);
    const runs = await Promise.all(selected.map(async ({ id }) => {
      try {
        const path = join(root, id, "progress.json"), stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000) return null;
        return evalProgress(JSON.parse(await readFile(path, "utf8")), id);
      } catch { return null; }
    }));
    return runs.filter((run): run is EvalProgress => run !== null).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
  } catch { return []; }
}

let cached: { at: number; runs: EvalProgress[] } | undefined;
let reading: Promise<EvalProgress[]> | undefined;
export async function evalsResponse(request: Request): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/evals") return null;
  if (request.method !== "GET") return new Response("Use GET", { status: 405, headers: { Allow: "GET" } });
  if (!cached || Date.now() - cached.at >= 1000) {
    reading ??= recentEvals().then(runs => { cached = { at: Date.now(), runs }; return runs; }).finally(() => { reading = undefined; });
    await reading;
  }
  return Response.json({ runs: cached?.runs ?? [], observedAt: Date.now() }, { headers: { "Cache-Control": "no-store" } });
}
