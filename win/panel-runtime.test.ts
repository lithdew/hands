import { describe, expect, test } from "bun:test";

const html = await Bun.file(new URL("./panel.html", import.meta.url)).text();
const commandScript = html.slice(html.indexOf("function observeRuntime("), html.indexOf("/* ---------------------------------------------------------- hold to speak */"));
const stopScript = html.match(/\$\('stop'\)\.onclick = [^\n]+/)?.[0];
const firstId = "ba5f4140-f410-4c18-b637-c2e848c30f76";
const nextId = "241b1aae-d922-40f9-87c8-359990b8e66f";
type RequestRecord = { path: string; method: string; body?: string; cache?: string };

function fixture() {
  const nodes = new Map<string, any>();
  const $ = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", style: {}, scrollHeight: 40, disabled: id === "send" });
    return nodes.get(id);
  };
  let runtime: unknown = { instanceId: firstId };
  let requestHook: ((request: RequestRecord) => Promise<Response> | Response | undefined) | undefined;
  const requests: RequestRecord[] = [];
  const fetch = async (path: string, options: RequestInit & { cache?: string } = {}) => {
    const request = { path, method: options.method || "GET", ...(options.body ? { body: String(options.body) } : {}), ...(options.cache ? { cache: options.cache } : {}) };
    requests.push(request);
    const custom = await requestHook?.(request);
    return custom ?? (path === "/status" ? Response.json({ runtime }) : Response.json({ ok: true }));
  };
  let controls: any;
  // The real refresh catches errors and reads status; there is no DOM renderer
  // or external server in this fixture. All guarded submit/transport code is real.
  const refresh = async () => { try { await controls.readStatus(); } catch {} };
  controls = new Function("$", "fetch", "refresh", `
    let runtimeInstanceId = null, runtimeRevision = 0, taskSubmitting = false, taskError = '';
    let selectedHand = 1, held = false, stoppedAt = 0;
    ${commandScript}
    ${stopScript}
    return { observeRuntime, readStatus, invalidateRuntime,
      submit: () => $('task').onsubmit({ preventDefault() {} }),
      stop: () => $('stop').onclick(),
      state: () => ({ runtimeInstanceId, taskSubmitting, taskError }) };
  `)($, fetch, refresh);
  return { controls, requests, prompt: $("prompt"), send: $("send"), error: $("error"),
    runtime: (value: unknown) => { runtime = value; },
    onRequest: (hook: NonNullable<typeof requestHook>) => { requestHook = hook; },
    posts: () => requests.filter(request => request.method === "POST") };
}

describe("panel task runtime guard", () => {
  test("new tasks use only the last verified instance path and clear only the accepted draft", async () => {
    const f = fixture(); f.prompt.value = "Draw a cat";
    await f.controls.readStatus(); await f.controls.submit();
    expect(f.posts()).toEqual([{ path: `/instances/${firstId}/task`, method: "POST", body: '{"text":"Draw a cat"}' }]);
    expect(f.prompt.value).toBe("");
    expect(f.requests.filter(request => request.path === "/status").every(request => request.cache === "no-store")).toBe(true);
    expect(html).not.toContain("post('/task'");
    expect(html).toContain("const s = await readStatus()");
    expect(html).toContain("browserChanging || taskSubmitting || !runtimeInstanceId");
    expect(html).toMatch(/<button[^>]+id="send"[^>]+disabled>/);
    expect(() => new Function(html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "")).not.toThrow();
  });

  test("missing or malformed runtime IDs block mutation and keep the draft while status recovers", async () => {
    for (const runtime of [null, {}, { instanceId: "../../task" }, { instanceId: firstId + "/task" }, { instanceId: 42 }]) {
      const f = fixture(); f.runtime(runtime); f.prompt.value = "Keep this draft";
      await f.controls.readStatus(); await f.controls.submit();
      expect(f.posts()).toEqual([]); expect(f.prompt.value).toBe("Keep this draft");
      expect(f.controls.state().runtimeInstanceId).toBeNull();
      expect(f.controls.state().taskError).toContain("verified Hands connection");
      f.runtime({ instanceId: nextId }); await f.controls.readStatus();
      expect(f.controls.state().runtimeInstanceId).toBe(nextId);
      expect(f.controls.state().taskError).toBe(""); expect(f.posts()).toEqual([]);
    }
  });

  test("a stale-instance rejection refreshes read-only, preserves the draft and requires another Send", async () => {
    const f = fixture(); f.prompt.value = "A task for the current hand"; await f.controls.readStatus();
    f.runtime({ instanceId: nextId });
    f.onRequest(request => request.path === `/instances/${firstId}/task`
      ? Response.json({ error: "Runtime instance changed. Read /status before submitting again." }, { status: 409 }) : undefined);
    await f.controls.submit();
    expect(f.posts().map(request => request.path)).toEqual([`/instances/${firstId}/task`]);
    expect(f.prompt.value).toBe("A task for the current hand");
    expect(f.controls.state()).toMatchObject({ runtimeInstanceId: nextId, taskSubmitting: false });
    expect(f.controls.state().taskError).toContain("restarted before accepting");
    await f.controls.readStatus(); expect(f.controls.state().taskError).toContain("draft is kept");
    await f.controls.submit();
    expect(f.posts().map(request => request.path)).toEqual([`/instances/${firstId}/task`, `/instances/${nextId}/task`]);
    expect(f.prompt.value).toBe("");
  });

  test("an older status response cannot re-arm the stale instance after a rejected submission", async () => {
    const f = fixture(), late = Promise.withResolvers<Response>(), entered = Promise.withResolvers<void>();
    f.prompt.value = "Preserve it"; f.controls.observeRuntime({ instanceId: firstId }); f.runtime({ instanceId: nextId });
    let firstRead = true;
    f.onRequest(request => {
      if (request.path === "/status" && firstRead) { firstRead = false; entered.resolve(); return late.promise; }
      if (request.method === "POST") return Response.json({ error: "Runtime instance changed." }, { status: 409 });
    });
    const pendingStatus = f.controls.readStatus(); await entered.promise; await f.controls.submit();
    late.resolve(Response.json({ runtime: { instanceId: firstId } }));
    expect(await pendingStatus).toBeNull(); expect(f.controls.state().runtimeInstanceId).toBe(nextId);
    expect(f.posts()).toHaveLength(1); expect(f.prompt.value).toBe("Preserve it");
  });

  test("legacy or rejected endpoints never fall back to /task or erase a draft", async () => {
    for (const status of [400, 403, 404, 405, 409, 500]) {
      const f = fixture(); f.prompt.value = "Keep on failure"; await f.controls.readStatus();
      f.onRequest(request => request.method === "POST" ? new Response("Unavailable", { status }) : undefined);
      await f.controls.submit();
      expect(f.posts().map(request => request.path)).toEqual([`/instances/${firstId}/task`]);
      expect(f.prompt.value).toBe("Keep on failure"); expect(f.controls.state().taskError).toContain("draft is kept");
      if (status === 404 || status === 405) expect(f.controls.state().taskError).toContain("guarded tasks");
    }
  });

  test("uncertain network outcomes preserve the draft without claiming the task was rejected or retrying", async () => {
    for (const failure of ["network", "bad-json"]) {
      const f = fixture(); f.prompt.value = "Maybe delivered"; await f.controls.readStatus();
      f.onRequest(request => {
        if (request.method !== "POST") return;
        if (failure === "network") throw new TypeError("Failed to fetch");
        return new Response("not JSON", { status: 200 });
      });
      await f.controls.submit();
      expect(f.posts()).toHaveLength(1); expect(f.prompt.value).toBe("Maybe delivered");
      expect(f.controls.state().taskError).toContain("Could not confirm task delivery");
    }
  });

  test("in-flight submissions cannot duplicate and Stop remains independent of runtime verification", async () => {
    const f = fixture(), accepted = Promise.withResolvers<Response>(), entered = Promise.withResolvers<void>();
    f.prompt.value = "First draft"; await f.controls.readStatus();
    f.onRequest(request => { if (request.path === `/instances/${firstId}/task`) { entered.resolve(); return accepted.promise; } });
    const submitting = f.controls.submit(); await entered.promise;
    expect(f.controls.state().taskSubmitting).toBe(true); expect(f.send.disabled).toBe(true);
    await f.controls.submit(); expect(f.posts()).toHaveLength(1);
    f.prompt.value = "A new draft typed during submission";
    f.controls.stop(); expect(f.posts().map(request => request.path)).toEqual([`/instances/${firstId}/task`, "/stop"]);
    accepted.resolve(Response.json({ ok: true })); await submitting;
    expect(f.prompt.value).toBe("A new draft typed during submission");
    f.controls.invalidateRuntime(); f.controls.stop();
    expect(f.posts().at(-1)?.path).toBe("/stop");
  });

  test("a server change during an accepted response keeps the draft and never resubmits", async () => {
    const f = fixture(), accepted = Promise.withResolvers<Response>(), entered = Promise.withResolvers<void>();
    f.prompt.value = "Task crossing a restart"; await f.controls.readStatus();
    f.onRequest(request => { if (request.method === "POST") { entered.resolve(); return accepted.promise; } });
    const submitting = f.controls.submit(); await entered.promise;
    f.runtime({ instanceId: nextId }); await f.controls.readStatus();
    accepted.resolve(Response.json({ ok: true })); await submitting;
    expect(f.posts()).toHaveLength(1); expect(f.prompt.value).toBe("Task crossing a restart");
    expect(f.controls.state().taskError).toContain("Could not confirm");
  });

  test("a failed status read revokes submission readiness without blocking Stop", async () => {
    const f = fixture(); f.prompt.value = "Disconnected draft"; await f.controls.readStatus();
    f.onRequest(request => request.path === "/status" ? new Response("offline", { status: 503 }) : undefined);
    await expect(f.controls.readStatus()).rejects.toThrow("unavailable");
    expect(f.controls.state().runtimeInstanceId).toBeNull(); expect(f.send.disabled).toBe(true);
    await f.controls.submit(); expect(f.posts()).toEqual([]);
    f.controls.stop(); expect(f.posts().map(request => request.path)).toEqual(["/stop"]);
    expect(f.prompt.value).toBe("Disconnected draft");
  });
});
