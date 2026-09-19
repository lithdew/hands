import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_CSP, artifactResponse } from "./artifacts";
import { isLocalRequest } from "../hotkey";

const runId = "81d52de1-9fbc-4e46-8129-e9b98ce88d74";
let base: string, root: string, files: string;
const request = (path: string, init?: RequestInit) => new Request(`http://127.0.0.1:7777/artifacts/${runId}/${path}`, init);
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "puk-artifact-test-"));
  root = join(base, "artifacts"); files = join(root, runId, "files");
  await mkdir(join(files, "assets"), { recursive: true });
  await writeFile(join(files, "index.html"), '<h1>Saved report</h1><script>window.example = 1</script>');
  await writeFile(join(files, "assets", "example.mp4"), "0123456789");
  await writeFile(join(root, runId, "private.json"), '{"private":true}');
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

describe("isolated generated artifact files", () => {
  test("serves only regular files in the exact run's files subtree", async () => {
    const response = await artifactResponse(request("index.html"), root);
    expect(response?.status).toBe(200);
    expect(await response!.text()).toContain("Saved report");
    expect(response!.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response!.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response!.headers.get("Cache-Control")).toBe("no-store");
    expect((await artifactResponse(request("missing.html"), root))!.status).toBe(404);
    expect((await artifactResponse(request("assets"), root))!.status).toBe(415);
    expect((await artifactResponse(new Request("http://127.0.0.1:7777/status"), root))).toBeNull();
  });

  test("sandbox cannot acquire the panel origin or submit or fetch controls", async () => {
    const response = await artifactResponse(request("index.html"), root);
    expect(response!.headers.get("Content-Security-Policy")).toBe(ARTIFACT_CSP);
    expect(ARTIFACT_CSP).toContain("sandbox allow-scripts;");
    expect(ARTIFACT_CSP).not.toContain("allow-same-origin");
    for (const policy of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-src 'none'"]) expect(ARTIFACT_CSP).toContain(policy);
    expect(isLocalRequest(new Request("http://127.0.0.1:7777/task", { method: "POST", headers: { Origin: "null", "Sec-Fetch-Site": "cross-site" } }))).toBe(false);
    const asset = await artifactResponse(request("assets/example.mp4", { headers: { Origin: "null", "Sec-Fetch-Site": "cross-site" } }), root);
    expect(asset!.status).toBe(200);
    expect(asset!.headers.get("Access-Control-Allow-Origin")).toBe("null");
    await asset!.arrayBuffer();
    const video = await artifactResponse(request("assets/example.mp4", { headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "video", "Sec-Fetch-Mode": "no-cors" } }), root);
    expect(video!.status).toBe(200);
    await video!.arrayBuffer();
    expect((await artifactResponse(request("index.html", { headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate" } }), root))!.status).toBe(403);
  });

  test("supports video ranges and HEAD without exposing extra bytes", async () => {
    const partial = await artifactResponse(request("assets/example.mp4", { headers: { Range: "bytes=2-5" } }), root);
    expect(partial!.status).toBe(206);
    expect(partial!.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(await partial!.text()).toBe("2345");
    const suffix = await artifactResponse(request("assets/example.mp4", { headers: { Range: "bytes=-3" } }), root);
    expect(await suffix!.text()).toBe("789");
    const head = await artifactResponse(request("assets/example.mp4", { method: "HEAD" }), root);
    expect(head!.headers.get("Content-Length")).toBe("10");
    expect(await head!.text()).toBe("");
    for (const value of ["bytes=10-", "bytes=7-3", "bytes=-0", "bytes=0-1,4-5", "bytes=9007199254740992-"]) {
      expect((await artifactResponse(request("assets/example.mp4", { headers: { Range: value } }), root))!.status).toBe(416);
    }
  });

  test("rejects traversal, Windows path aliases, foreign origins and writes", async () => {
    for (const path of ["..%2fprivate.json", "%2e%2e%5cprivate.json", "%252e%252e/private.json", "assets%5cexample.mp4", "index.html%3asecret", "index.html.", "index.html%20", "CON.html", "%00.html", "%ZZ.html", "/index.html"]) {
      expect((await artifactResponse(request(path), root))!.status).toBe(400);
    }
    expect((await artifactResponse(new Request(`http://127.0.0.1:7777/artifacts/not-a-uuid/index.html`), root))!.status).toBe(400);
    expect((await artifactResponse(request("index.html", { method: "POST" }), root))!.status).toBe(405);
    expect((await artifactResponse(request("index.html", { headers: { Origin: "https://example.test" } }), root))!.status).toBe(403);
    expect((await artifactResponse(request("index.html", { headers: { "Sec-Fetch-Site": "cross-site" } }), root))!.status).toBe(403);
    expect((await artifactResponse(new Request(`http://evil.test/artifacts/${runId}/index.html`), root))!.status).toBe(403);
  });

  test("rejects linked directories, including a linked artifacts root", async () => {
    const outside = join(base, "outside"); await mkdir(outside);
    await writeFile(join(outside, "secret.html"), "must not serve");
    await symlink(outside, join(files, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect((await artifactResponse(request("linked/secret.html"), root))!.status).toBe(404);
    const alias = join(base, "alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    expect((await artifactResponse(request("index.html"), alias))!.status).toBe(404);
  });

  test.skipIf(process.platform === "win32")("rejects a linked leaf file", async () => {
    await symlink(join(root, runId, "private.json"), join(files, "linked.json"));
    expect((await artifactResponse(request("linked.json"), root))!.status).toBe(404);
  });
});
