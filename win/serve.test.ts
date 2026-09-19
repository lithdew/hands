import { describe, expect, test } from "bun:test";
import { PANEL_CSP, coalesceLatest, panelResponse, previewLabel, previewResponse, previewTargetKey } from "./serve";
import type { BrowserTarget, RawWindow } from "./desktop";
import type { Hand } from "../desktop";

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
