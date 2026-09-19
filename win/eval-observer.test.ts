import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalProgress, recentEvals } from "./eval-observer";

const id = "afba8267-93c3-42b8-9b54-b16c482d1f11";
const progress = { runId: id, kind: "website", phase: "creating", model: "gpt-6-astra", request: "Build a local prototype", startedAt: "2026-09-20T12:00:00.000Z", updatedAt: "2026-09-20T12:00:15.000Z", elapsedMs: 15000, events: [], checks: [] };

describe("read-only evaluation observer", () => {
  test("keeps bounded runtime fields, accepts timestamps and strips unknown data", () => {
    const value = evalProgress({ ...progress, secret: "must not leave disk", events: Array.from({length:50}, (_,atMs)=>({atMs,event:"phase",phase:"creating",detail:"x".repeat(2000),privateField:"hidden"})), checks: [{name:"layout",passed:false,detail:"overflow"}] }, id)!;
    expect(value.updatedAt).toBe(Date.parse(progress.updatedAt));
    expect(value.events).toHaveLength(40);
    expect(value.events[0]?.atMs).toBe(10);
    expect(value.events[0]?.detail).toHaveLength(600);
    expect(JSON.stringify(value)).not.toContain("must not leave disk");
    expect(JSON.stringify(value)).not.toContain("privateField");
    expect(value.checks[0]?.passed).toBe(false);
    expect(evalProgress({...progress,runId:"another"},id)).toBeNull();
  });

  test("preview links are confined to this run and cannot target controls", () => {
    expect(evalProgress({...progress,previewUrl:`/artifacts/${id}/index.html`},id)?.previewUrl).toBe(`/artifacts/${id}/index.html`);
    for(const url of ["/stop", "https://example.test/", `/artifacts/${id}/../index.html`, `/artifacts/${id}/%2e%2e/index.html`, `/artifacts/${id}/index.html?task=send`, `/artifacts/${id}/file:stream`, `/artifacts/${id}/x\\index.html`]) {
      expect(evalProgress({...progress,previewUrl:url},id)?.previewUrl).toBeUndefined();
    }
  });

  test("creative check details expose the diagnosis rather than a truncated JSON blob", () => {
    const value=evalProgress({...progress,checks:[{name:"creative-review",passed:false,detail:JSON.stringify({passed:false,summary:"Mobile equation is too small.",issues:[{severity:"error",detail:"Move the readable equation beside the player."}],hidden:"not part of the diagnosis"})}]},id)!;
    expect(value.checks[0]?.detail).toBe("Mobile equation is too small. Move the readable equation beside the player.");
  });

  test("reads only valid progress files and tolerates an incomplete or oversized write", async () => {
    const root = await mkdtemp(join(tmpdir(),"hands-eval-observer-"));
    try {
      const other = "00000000-0000-0000-0000-000000000001", big = "00000000-0000-0000-0000-000000000002";
      for(const run of [id,other,big,"not-a-run"]) await mkdir(join(root,run));
      await writeFile(join(root,id,"progress.json"),JSON.stringify(progress));
      await writeFile(join(root,id,"private.json"),"private log");
      await writeFile(join(root,other,"progress.json"),"{");
      await writeFile(join(root,big,"progress.json")," ".repeat(256001));
      await writeFile(join(root,"not-a-run","progress.json"),JSON.stringify(progress));
      expect((await recentEvals(root)).map(run=>run.runId)).toEqual([id]);
    } finally { await rm(root,{recursive:true,force:true}); }
  });
});
