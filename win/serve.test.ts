import { describe, expect, spyOn, test } from "bun:test";
import { PANEL_CSP, coalesceLatest, instanceTaskResponse, panelResponse, previewLabel, previewResponse, previewTargetKey } from "./serve";
import type { BrowserTarget, RawWindow } from "./desktop";
import type { Hand } from "../desktop";
import { runtimeStartup } from "./runtime-identity";
import { isAbsolute, resolve } from "node:path";
import { servePuk } from "../hotkey";
import type { createDesktopAgent } from "../ai";
import { rememberSecret } from "../desktop";

describe("runtime identity and instance-scoped task submission", () => {
  const instanceId = "ba5f4140-f410-4c18-b637-c2e848c30f76";
  const staleId = "241b1aae-d922-40f9-87c8-359990b8e66f";
  const taskPath = `/instances/${instanceId}/task`;
  const request = (path = taskPath, init: RequestInit = {}) => new Request(`http://127.0.0.1:7788${path}`, { method: "POST", body: '{"text":"Fixture task"}', ...init });

  test("startup records a fresh immutable identity and verified local checkout metadata only", async () => {
    const root = resolve("."), commit = "a".repeat(40), calls: string[][] = [];
    const identity = await runtimeStartup(root, async (cwd, args) => {
      expect(cwd).toBe(root); calls.push(args);
      if (args.includes("--show-toplevel")) return root;
      if (args[0] === "symbolic-ref") return "desktop-pip";
      return commit;
    });
    expect(identity).toMatchObject({ pid: process.pid, workspaceRoot: root, git: { root, commit, branch: "desktop-pip" } });
    expect(identity.instanceId).toMatch(/^[a-f\d-]{36}$/);
    expect(isAbsolute(identity.workspaceRoot)).toBe(true);
    expect(Number.isFinite(Date.parse(identity.startedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(identity.git!.observedAt))).toBe(true);
    expect(Object.isFrozen(identity)).toBe(true); expect(Object.isFrozen(identity.git)).toBe(true);
    expect(calls).toHaveLength(5);
    expect(calls.every(args => ["rev-parse", "symbolic-ref"].includes(args[0]!))).toBe(true);
    const unknown = await runtimeStartup(root, async () => null);
    expect(unknown.git).toBeNull(); expect(unknown.instanceId).not.toBe(identity.instanceId);
    expect(Object.keys(unknown).sort()).toEqual(["git", "instanceId", "pid", "startedAt", "workspaceRoot"]);
  });

  test("detached HEAD is explicit and mixed or invalid Git metadata is not reported as verified", async () => {
    const root = resolve(".");
    const detached = await runtimeStartup(root, async (_cwd, args) => args.includes("--show-toplevel") ? root : args[0] === "symbolic-ref" ? null : "a".repeat(40));
    expect(detached.git).toMatchObject({ branch: null, commit: "a".repeat(40) });
    for (const invalid of ["changed-commit", "changed-branch", "unrelated-root", "invalid-commit", "read-error"] as const) {
      let commits = 0, branches = 0;
      const result = await runtimeStartup(root, async (_cwd, args) => {
        if (invalid === "read-error") throw new Error("Fixture Git unavailable");
        if (args.includes("--show-toplevel")) return invalid === "unrelated-root" ? resolve(root, "other-project") : root;
        if (args[0] === "symbolic-ref") return invalid === "changed-branch" && ++branches > 1 ? "other-branch" : "desktop-pip";
        return invalid === "invalid-commit" ? "not-a-commit" : invalid === "changed-commit" && ++commits > 1 ? "b".repeat(40) : "a".repeat(40);
      });
      expect(result.git).toBeNull();
    }
  });

  test("a stale instance is rejected before parsing a payload or reaching any backend", async () => {
    let forwarded = 0;
    const original = request(`/instances/${staleId}/task`, { body: "invalid JSON which must not be read" });
    const response = await instanceTaskResponse(original, { instanceId }, () => { forwarded++; return new Response("Should not run"); });
    expect(response?.status).toBe(409); expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(original.bodyUsed).toBe(false); expect(forwarded).toBe(0);
  });

  test("only the exact supported POST path forwards, retaining body, headers, query and backend response", async () => {
    const rejected = Response.json({ error: "Fixture backend is busy" }, { status: 409 });
    let forwarded = 0;
    const response = await instanceTaskResponse(request(`${taskPath}?hand=1`, { headers: { Origin: "http://127.0.0.1:7788", "Content-Type": "application/json", "X-Fixture": "preserved" } }), { instanceId }, async current => {
      forwarded++;
      expect(new URL(current.url).pathname).toBe("/task"); expect(new URL(current.url).search).toBe("?hand=1");
      expect(current.method).toBe("POST"); expect(current.headers.get("Origin")).toBe("http://127.0.0.1:7788");
      expect(current.headers.get("X-Fixture")).toBe("preserved"); expect(await current.json()).toEqual({ text: "Fixture task" });
      return rejected;
    });
    expect(response).toBe(rejected); expect(forwarded).toBe(1);
    for (const path of ["/instances", "/instances/garbage/task", `${taskPath}/`, `/instances/${instanceId}/stop`, `/instances/%62a5f4140-f410-4c18-b637-c2e848c30f76/task`])
      expect((await instanceTaskResponse(request(path), { instanceId }, () => { forwarded++; return rejected; }))?.status).toBe(404);
    const wrongMethod = await instanceTaskResponse(request(taskPath, { method: "GET", body: undefined }), { instanceId }, () => { forwarded++; return rejected; });
    expect(wrongMethod?.status).toBe(405); expect(wrongMethod?.headers.get("Allow")).toBe("POST");
    expect(await instanceTaskResponse(request("/task"), { instanceId }, () => { forwarded++; return rejected; })).toBeNull();
    expect(forwarded).toBe(1);
  });

  test("an instance ID never replaces the existing local-origin policy", async () => {
    let forwarded = 0;
    const attempts: Record<string, string>[] = [{ Origin: "https://external.example" }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }];
    for (const headers of attempts) {
      const response = await instanceTaskResponse(request(taskPath, { headers }), { instanceId }, () => { forwarded++; return new Response("No"); });
      expect(response?.status).toBe(403);
    }
    expect(forwarded).toBe(0);
  });

  test("the real shared task handler retains validation and busy checks; unsupported old-server paths return 404", async () => {
    const hand: Hand = { id: 1, pid: 1, display: "fixture", width: 800, height: 600 };
    const stopped = Promise.withResolvers<void>(), state = { running: false, task: "", error: null, approval: null };
    let prompts = 0;
    const app = await servePuk({ port: 0, dependencies: {
      hand: async () => hand, hands: async () => [hand], handState: async () => {},
      ask: async () => { throw new Error("No live model calls in fixture"); },
      agent: async () => ({ status: () => ({ ...state }),
        prompt: async (text: string) => { prompts++; state.running = true; state.task = text; await stopped.promise; state.running = false; },
        stop: () => { stopped.resolve(); state.running = false; }, idle: async () => { if (state.running) await stopped.promise; },
        close: async () => { stopped.resolve(); },
      } as unknown as Awaited<ReturnType<typeof createDesktopAgent>>),
    } });
    // Direct handler calls only: no network, native desktop, account or model.
    const backend = (current: Request) => app.server.fetch(current);
    try {
      expect((await backend(request())).status).toBe(404); expect(prompts).toBe(0);
      expect((await instanceTaskResponse(request(taskPath, { body: '{"text":""}' }), { instanceId }, backend))?.status).toBe(400);
      expect((await instanceTaskResponse(request(), { instanceId }, backend))?.status).toBe(202);
      for (let n = 0; !state.running && n < 100; n++) await Bun.sleep(1);
      expect(prompts).toBe(1); expect(state.running).toBe(true);
      expect((await instanceTaskResponse(request(), { instanceId }, backend))?.status).toBe(409);
      expect((await backend(request("/task"))).status).toBe(409); // Legacy path is unchanged.
      expect(prompts).toBe(1);
    } finally { stopped.resolve(); await app.close(); }
  });
});

test("an explicit preview cannot race global hand selection or silently fall back", async () => {
  const requested = { id: 1 } as Hand, other = { id: 2 } as Hand;
  let selectedCalls = 0;
  const deps = {
    selected: async () => { selectedCalls++; return other; },
    lookup: async (id: number) => id === 1 ? requested : null,
    capture: async (hand: Hand) => ({ data: Buffer.from(`hand ${hand.id}`).toString("base64"), window: null }),
  };
  const response = await previewResponse(new Request("http://localhost/desktop.png?hand=1"), deps);
  expect(response.headers.get("X-Puk-Hand")).toBe("1");
  expect(await response.text()).toBe("hand 1");
  expect(selectedCalls).toBe(0);
  expect((await previewResponse(new Request("http://localhost/desktop.png?hand=3"), deps)).status).toBe(404);
  expect((await previewResponse(new Request("http://localhost/desktop.png?hand=oops"), deps)).status).toBe(400);
  expect(selectedCalls).toBe(0);
});

test("an in-flight image cannot relabel a changed browser target on the same hand", async () => {
  const hand = { id: 1 } as Hand;
  const existing: BrowserTarget = { mode: "existing", pid: 9, window_id: 17, ownerNonce: "0000000000000001", title: "Inbox", ready: true };
  let current: BrowserTarget = { mode: "private" }, calls = 0;
  const deps = {
    selected: async () => hand, lookup: async () => hand, target: () => current,
    capture: async () => { calls++; current = existing; return { data: Buffer.from("old sandbox").toString("base64"), window: null }; },
  };
  const request = () => new Request(`http://localhost/desktop.png?hand=1&target=${encodeURIComponent(previewTargetKey(1, { mode: "private" }))}`);
  expect((await previewResponse(request(), deps)).status).toBe(409);
  expect((await previewResponse(request(), deps)).status).toBe(409);
  expect(calls).toBe(1); // Known stale requests do not capture at all.
  const window: RawWindow = { app: "chrome", title: "Inbox", pid: 9, containerId: 17, ownerNonce: "0000000000000001", focused: true, rect: [0, 0, 1200, 800] };
  const existingRequest = () => new Request(`http://localhost/desktop.png?hand=1&target=${encodeURIComponent(previewTargetKey(1, existing))}`);
  const correct = await previewResponse(existingRequest(), { ...deps, capture: async () => ({ data: "YWJj", window }) });
  expect(correct.status).toBe(200);
  expect(correct.headers.get("X-Puk-Window")).toBe("17");
  expect(correct.headers.get("X-Puk-Pid")).toBe("9");
  expect(correct.headers.get("X-Puk-Owner-Nonce")).toBe(window.ownerNonce!);
  for (const change of [{ pid: 99 }, { containerId: 18 }, { ownerNonce: "0000000000000002" }]) {
    expect((await previewResponse(existingRequest(), { ...deps, capture: async () => ({ data: "YWJj", window: { ...window, ...change } }) })).status).toBe(503);
  }
});

test("preview capture failures log a bounded redacted cause privately but keep the response generic", async () => {
  const previousDebug = process.env.PUK_DEBUG, secret = "preview-fixture-hidden-key";
  rememberSecret(secret); process.env.PUK_DEBUG = "1";
  const logged = spyOn(console, "error").mockImplementation(() => {}), hand = { id: 2 } as Hand;
  try {
    const response = await previewResponse(new Request("http://127.0.0.1:7788/desktop.png?hand=2"), {
      selected: async () => hand, lookup: async () => hand,
      capture: async () => { throw new Error(`Fixture capture ${secret}: ${"x".repeat(800)}`); },
    });
    expect(response.status).toBe(503); expect(await response.text()).toBe("Desktop unavailable");
    expect(logged).toHaveBeenCalledTimes(1);
    const event = JSON.parse(String(logged.mock.calls[0]![0]));
    expect(event.scope).toBe("win.preview.capture"); expect(event.detail.hand).toBe(2);
    expect(event.detail.message).toContain("[redacted]"); expect(event.detail.message).not.toContain(secret);
    expect(event.detail.message.length).toBeLessThanOrEqual(500);
    expect(Object.keys(event.detail).sort()).toEqual(["hand", "message"]);
  } finally {
    logged.mockRestore();
    if (previousDebug === undefined) delete process.env.PUK_DEBUG; else process.env.PUK_DEBUG = previousDebug;
  }
});

test("overlapping native preview polls share one observation and publish the newest status", async () => {
  let release!: () => void, calls = 0;
  const rendered: string[] = [];
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const paint = coalesceLatest<string>(async (latest) => { calls++; await blocked; rendered.push(latest()); });
  const first = paint("working"), second = paint("review"), third = paint("idle");
  expect(first).toBe(second); expect(second).toBe(third); expect(calls).toBe(1);
  release(); await Promise.all([first, second, third]);
  expect(rendered).toEqual(["idle"]);
  await paint("working");
  expect(calls).toBe(2);
});

describe("Windows panel route", () => {
  const get = (path: string) => panelResponse(new Request(`http://127.0.0.1:7777${path}`));

  test("serves the Windows page at / and /index.html with hotkey.ts's CSP", async () => {
    for (const path of ["/", "/index.html"]) {
      const response = await get(path);
      expect(response?.status).toBe(200);
      expect(response?.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(response?.headers.get("Cache-Control")).toBe("no-store");
      expect(response?.headers.get("Content-Security-Policy")).toBe(PANEL_CSP);
    }
    expect(PANEL_CSP).toBe("default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  });
  test("everything else falls through to the panel server", async () => {
    expect(await get("/status")).toBeNull();
    expect(await get("/desktop.png")).toBeNull();
    expect(await panelResponse(new Request("http://127.0.0.1:7777/", { method: "POST" }))).toBeNull();
  });
  test("the page fetches nothing external and carries Windows hints only", async () => {
    const html = await (await get("/"))!.text();
    expect(html).toContain("<kbd>F8</kbd>");
    expect(html).toContain("Ctrl</kbd><kbd>Alt</kbd><kbd>Esc</kbd>");
    for (const forbidden of ["googleapis", "gstatic", "<link", "Super", "Ctrl+Alt+1", "Reset previews", "/desktop/layout"]) expect(html).not.toContain(forbidden);
    // Every id the script reads must exist in the markup.
    const ids = new Set([...html.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]!));
    for (const id of ids) expect(html).toContain(`id="${id}"`);
    expect(ids.size).toBeGreaterThan(10);
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });
});

describe("previewLabel", () => {
  test("joins task and title with one middle dot and drops it when a half is empty", () => {
    expect(previewLabel("open paint", "Untitled - Paint")).toBe("open paint · Untitled - Paint");
    expect(previewLabel("", "Untitled - Paint")).toBe("Untitled - Paint");
    expect(previewLabel("open paint", "")).toBe("open paint");
    expect(previewLabel("", "")).toBe("");
  });
  test("a dot inside either half cannot be mistaken for the separator", () => {
    expect(previewLabel("email · Sam", "Inbox · Mail")).toBe("email - Sam · Inbox - Mail");
  });
  test("collapses whitespace and caps the caption", () => {
    expect(previewLabel("a\n\nb", "  c\t d ")).toBe("a b · c d");
    expect(previewLabel("x".repeat(200), "y")).toHaveLength(120);
  });
});
