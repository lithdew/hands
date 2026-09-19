import { describe, expect, test } from "bun:test";
import { addressToUrl, browserInput, existingBrowserInput, keyEvent, toCss, type Ask, type ExistingBrowserWindow } from "./browser";
import type { CuaConnection } from "../desktop";

/** A scripted helper: records every request line and answers the DevTools ones. */
function fakeHelper(opts: { page?: [number, number, number, number]; cssWidth?: number; title?: string; onCall?: (method: string, params: any) => void } = {}) {
  const sent: { method: string; params: any }[] = [];
  const ask: Ask = async (line) => {
    if (line.startsWith("http ")) return JSON.stringify([
      { type: "service_worker", title: "sw", url: "https://x/sw.js", webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/page/SW" },
      { type: "page", title: "Other tab", url: "https://other.example", webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/page/OTHER" },
      { type: "page", title: opts.title ?? "Capybara - Wikipedia", url: "https://en.wikipedia.org", webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/page/WIKI" },
    ]);
    if (line.startsWith("viewport ")) return JSON.stringify(opts.page ?? [1, 86, 1344, 805]);
    const [, ws, id, json] = /^cdp (\S+) (\d+) (.*)$/.exec(line)!;
    const message = JSON.parse(json!);
    expect(message.id).toBe(Number(id));
    sent.push({ method: `${ws!.split("/").pop()}:${message.method}`, params: message.params });
    opts.onCall?.(message.method, message.params);
    return JSON.stringify({ id: message.id, result: message.method === "Page.getLayoutMetrics" ? { cssVisualViewport: { clientWidth: opts.cssWidth ?? 1344 } } : {} });
  };
  const input = browserInput(ask, async () => 9);
  const window = { containerId: 42, title: "Capybara - Wikipedia - Google Chrome" };
  const acts = () => sent.filter((s) => !/getLayoutMetrics|setFocusEmulation/.test(s.method));
  return { input, window, sent, acts };
}

describe("keyEvent", () => {
  test("Enter carries the carriage return Chromium needs to submit a form", () => {
    expect(keyEvent(["Return"])).toEqual({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r" });
  });
  test("ctrl+a names the editing command and sends no text", () => {
    expect(keyEvent(["ctrl", "a"])).toEqual({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] });
  });
  test("shift keeps the text, function keys map to their virtual keys", () => {
    expect(keyEvent(["shift", "x"]).text).toBe("x");
    expect(keyEvent(["F5"]).windowsVirtualKeyCode).toBe(116);
  });
  test("rejects names it cannot deliver instead of sending a wrong key", () => {
    expect(() => keyEvent(["ctrl"])).toThrow("besides its modifiers");
    expect(() => keyEvent(["hyperspace"])).toThrow("Unknown key");
  });
});

test("private navigation, scripts and input recheck corrections after awaiting page lookup", async () => {
  for (const operation of ["navigate", "evaluate", "handle"]) {
    let revised = false;
    const f = fakeHelper({ onCall: (method) => { if (method === "Page.getLayoutMetrics") revised = true; } });
    const guard = () => { if (revised) throw new Error("instruction changed"); };
    const pending = operation === "navigate" ? f.input.navigate(f.window, "https://example.org", guard)
      : operation === "evaluate" ? f.input.evaluate(f.window, "fixtureMutation()", guard)
      : f.input.handle("type_text", { text: "old text" }, f.window, guard);
    await expect(pending).rejects.toThrow("instruction changed"); expect(f.acts()).toEqual([]);
  }
});

test("private pointer dispatch rechecks a correction between move and press", async () => {
  let revised = false;
  const f = fakeHelper({ onCall: (_method, params) => { if (params.type === "mouseMoved") revised = true; } });
  await expect(f.input.handle("click", { x: 30, y: 100 }, f.window, () => { if (revised) throw new Error("instruction changed"); })).rejects.toThrow("instruction changed");
  expect(f.acts().map((action) => action.params.type)).toEqual(["mouseMoved"]);
});

test("a correction after a pointer or key press still permits its matching release", async () => {
  for (const key of [false, true]) {
    let revised = false;
    const f = fakeHelper({ onCall: (_method, params) => { if (["mousePressed", "keyDown", "rawKeyDown"].includes(params.type)) revised = true; } });
    const guard = () => { if (revised) throw new Error("instruction changed"); };
    await f.input.handle(key ? "press_key" : "click", key ? { key: "Return" } : { x: 30, y: 100 }, f.window, guard);
    expect(f.acts().at(-1)!.params.type).toBe(key ? "keyUp" : "mouseReleased");
  }
});

describe("existing Chrome binding", () => {
  const response = (state: Record<string, unknown>) => ({ content: [], structuredContent: state }) as unknown as Awaited<ReturnType<CuaConnection["call"]>>;
  function fixture() {
    let window: ExistingBrowserWindow = { pid: 90, containerId: 1234, ownerNonce: "0000000000000123", title: "Inbox - Google Chrome", rect: [1, 1, 1000, 800] };
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let bind = 0, exact = true, setup = false, denied = false;
    let tabs = [{ title: "Inbox", url: "https://mail.example/", active: true as boolean | null }];
    let pageOverride: { title: string; url: string } | undefined;
    let outcome: Record<string, unknown> = { status: "ok" };
    let onCall: ((name: string, args: Record<string, unknown>) => void) | undefined;
    const call: CuaConnection["call"] = async (name, args = {}) => {
      calls.push({ name, args }); onCall?.(name, args);
      if (denied) throw new Error("browser_consent_required: user denied this request");
      if (name === "get_browser_state" && args.pid) {
        if (setup) throw new Error("browser_requires_setup: use browser_prepare");
        bind++;
        return response({ status: "ok", mode: "bind", target_id: `target-${bind}`, binding_quality: exact ? "exact" : "heuristic", mutation_allowed: exact,
          tabs: tabs.map((tab, i) => ({ ...tab, tab_id: `tab-${bind}-${i}` })) });
      }
      if (name === "get_browser_state") return response({ status: "ok", mode: "snapshot", target_id: args.target_id, tab_id: args.tab_id,
        snapshot: { id: "p17", format: "semantic_v2" }, page: pageOverride ?? { title: tabs[0]!.title, url: tabs[0]!.url }, outline: "Inbox\nCompose\nDraft saved",
        refs: [{ ref: "p17:1", role: "button", name: "Compose", actions: ["click"] }, { ref: "p17:2", role: "textbox", name: "Subject", actions: ["type"] },
          { ref: "p17:3", role: "generic", name: null, actions: ["scroll", "pointer"] }] });
      if (name === "browser_prepare") { setup = false; return response({ status: "ok", prepared: true }); }
      return response(outcome);
    };
    const input = existingBrowserInput(call, async () => window, "account-test", async (observed) => {
      calls.push({ name: "focus_existing", args: { pid: observed.pid, window_id: observed.containerId, ownerNonce: observed.ownerNonce } });
    });
    return { input, calls, mutateWindow: (change: Partial<ExistingBrowserWindow>) => { window = { ...window, ...change }; },
      tabs: (value: typeof tabs) => { tabs = value; }, setup: () => { setup = true; }, heuristic: () => { exact = false; }, deny: () => { denied = true; },
      page: (value: typeof pageOverride) => { pageOverride = value; },
      outcome: (value: typeof outcome) => { outcome = value; },
      onCall: (fn: NonNullable<typeof onCall>) => { onCall = fn; } };
  }
  const mutations = (f: ReturnType<typeof fixture>) => f.calls.filter((call) => !["get_browser_state", "end_session", "focus_existing"].includes(call.name));

  test("prepares only an explicitly requested exact existing profile, without launching a browser", async () => {
    const f = fixture(); f.setup();
    await f.input.attach();
    expect(mutations(f)).toEqual([{ name: "browser_prepare", args: { session: "account-test", pid: 90, window_id: 1234, strategy: { kind: "existing_profile" }, allow_launch: false } }]);
    expect(f.calls.slice(0, 3).map((call) => call.name)).toEqual(["get_browser_state", "focus_existing", "browser_prepare"]);
    expect(f.calls.filter((call) => call.name === "focus_existing")).toEqual([{ name: "focus_existing", args: { pid: 90, window_id: 1234, ownerNonce: "0000000000000123" } }]);
    const shot = await f.input.snapshot();
    expect(shot.refs.find((ref) => ref.ref === "p17:3")?.name).toBe("");
    expect(f.calls.filter((call) => call.name !== "focus_existing").every((call) => call.args.session === "account-test")).toBe(true);
    expect(f.calls.some((call) => call.args.include_screenshot === false && call.args.snapshot_format === "semantic_v2")).toBe(true);
  });

  test("automatic restart binding never opens preparation or consent UI", async () => {
    const f = fixture(); f.setup();
    await expect(f.input.attach(undefined, { allowPrepare: false })).rejects.toThrow("browser_requires_setup");
    expect(f.calls.map(call => call.name)).toEqual(["get_browser_state"]);
    const alreadyApproved = fixture();
    await alreadyApproved.input.attach(undefined, { allowPrepare: false });
    expect(alreadyApproved.calls.map(call => call.name)).toEqual(["get_browser_state"]);
  });

  test("denial, heuristic binding, missing active tab and duplicate titles never prepare or choose another tab", async () => {
    for (const arrange of [(f: ReturnType<typeof fixture>) => f.deny(), (f: ReturnType<typeof fixture>) => f.heuristic(),
      (f: ReturnType<typeof fixture>) => f.tabs([{ title: "Inbox", url: "https://mail.example/", active: null }]),
      (f: ReturnType<typeof fixture>) => f.tabs([{ title: "Inbox", url: "https://mail.example/", active: true }, { title: "Inbox", url: "https://other.example/", active: false }])]) {
      const f = fixture(); arrange(f);
      await expect(f.input.attach()).rejects.toThrow();
      expect(mutations(f)).toEqual([]);
      expect(f.calls.some((call) => call.name === "focus_existing")).toBe(false);
    }
  });

  test("snapshot mismatch metadata diagnoses aliases without exposing refs, page text or URL credentials", async () => {
    const f = fixture();
    f.page({ title: "New document", url: "https://person:secret@mail.example/?token=private-token#private-fragment" });
    let message = "";
    try { await f.input.snapshot(); } catch (error) { message = String(error); }
    expect(message).toContain('"mode":"snapshot"');
    expect(message).toContain('"target_matches":true');
    expect(message).toContain('"format":"semantic_v2"');
    expect(message).toContain('"page_title":"New document"');
    expect(message).toContain('"urls_match":false');
    for (const hidden of ["p17:1", "Compose", "Draft saved", "person", "secret", "private-token", "private-fragment"]) expect(message).not.toContain(hidden);
  });

  test("Chrome's New Tab document alias stays bound through snapshot and navigation", async () => {
    for (const [tabUrl, pageUrl] of [["chrome://newtab/", "chrome://new-tab-page/"], ["chrome://new-tab-page/", "chrome://newtab/"]]) {
      const f = fixture();
      f.mutateWindow({ title: "New Tab - Google Chrome" });
      f.tabs([{ title: "New Tab", url: tabUrl!, active: true }]);
      f.page({ title: "New Tab", url: pageUrl! });
      const snapshot = await f.input.snapshot();
      expect(snapshot.url).toBe(pageUrl!);
      await f.input.act(snapshot, { action: "navigate", url: "https://mail.example/" });
      expect(mutations(f).map((call) => call.name)).toEqual(["browser_navigate"]);
    }
  });

  test("internal aliases never relax http URLs, different Chrome pages or modified New Tab URLs", async () => {
    for (const [tabUrl, pageUrl] of [
      ["https://mail.example/#inbox", "https://mail.example/#sent"],
      ["https://mail.example/?account=1", "https://mail.example/?account=2"],
      ["chrome://newtab/", "chrome://settings/"],
      ["chrome://newtab/", "chrome://new-tab-page/?override=1"],
      ["chrome://newtab/", "chrome-extension://new-tab-page/"],
    ]) {
      const f = fixture(); f.tabs([{ title: "Inbox", url: tabUrl!, active: true }]); f.page({ title: "Inbox", url: pageUrl! });
      await expect(f.input.snapshot()).rejects.toThrow("Browser snapshot metadata");
      expect(mutations(f)).toEqual([]);
    }
  });

  test("re-attests the visible tab, then uses the old IDs that actually own the observed reference", async () => {
    const f = fixture(); await f.input.attach(); const snapshot = await f.input.snapshot();
    await f.input.act(snapshot, { action: "click" }, "p17:1");
    expect(mutations(f)).toEqual([{ name: "browser_click", args: { session: "account-test", target_id: snapshot.target_id, tab_id: snapshot.tab_id, ref: "p17:1", input_route: "dom_event" } }]);
    await expect(f.input.act(snapshot, { action: "click" }, "p17:1")).rejects.toThrow("stale");
    expect(mutations(f)).toHaveLength(1);
    expect(f.calls.some((call) => call.name === "focus_existing")).toBe(false);
  });

  test("an active tab changed after approval cannot receive a previously approved action", async () => {
    const f = fixture(), snapshot = await f.input.snapshot();
    f.tabs([{ title: "Inbox", url: "https://different.example/", active: true }]);
    await expect(f.input.act(snapshot, { action: "click" }, "p17:1")).rejects.toThrow("after observation or approval");
    expect(mutations(f)).toEqual([]);
  });

  test("public Cua action outcomes confirm dispatch and invalidate refs without asserting task success", async () => {
    for (const effect of ["confirmed", "unverifiable"]) {
      const f = fixture(), snapshot = await f.input.snapshot();
      f.outcome({ effect, route: "dom", delivery: { mode: "background" } });
      await f.input.act(snapshot, { action: "click" }, "p17:1");
      await expect(f.input.act(snapshot, { action: "click" }, "p17:1")).rejects.toThrow("stale");
      expect(mutations(f)).toHaveLength(1);
    }
  });

  test("failed, partial, unknown or wrong-route action outcomes cannot be accepted or replayed", async () => {
    for (const outcome of [
      ...["refused", "failed", "partial", "suspected_noop", "unknown"].map((effect) => ({ effect, route: "dom", delivery: { mode: "background" } })),
      { effect: "confirmed", route: "global_input", delivery: { mode: "foreground" } },
      { effect: "unverifiable", route: "dom" },
      { status: "ok", effect: "failed" },
    ]) {
      const f = fixture(), snapshot = await f.input.snapshot(); f.outcome(outcome);
      await expect(f.input.act(snapshot, { action: "click" }, "p17:1")).rejects.toThrow();
      await expect(f.input.act(snapshot, { action: "click" }, "p17:1")).rejects.toThrow("stale");
      expect(mutations(f)).toHaveLength(1);
    }
  });

  test("changed window nonce or frame rejects old references before input", async () => {
    for (const change of [{ ownerNonce: "0000000000009999" }, { pid: 91 }, { title: "Another tab - Google Chrome" }, { rect: [1, 1, 1100, 800] as [number, number, number, number] }]) {
      const f = fixture(), snapshot = await f.input.snapshot(); f.mutateWindow(change);
      await expect(f.input.act(snapshot, { action: "type", text: "hello" }, "p17:2")).rejects.toThrow("window changed");
      expect(mutations(f)).toEqual([]);
    }
  });

  test("cancellation and changed approval revision during revalidation prevent all input", async () => {
    const f = fixture(), snapshot = await f.input.snapshot(), abort = new AbortController();
    f.onCall((name, args) => { if (name === "get_browser_state" && args.pid) abort.abort(); });
    await expect(f.input.act(snapshot, { action: "click" }, "p17:1", abort.signal)).rejects.toThrow();
    expect(mutations(f)).toEqual([]);
    const g = fixture(), second = await g.input.snapshot(); let checks = 0;
    await expect(g.input.act(second, { action: "click" }, "p17:1", undefined, () => { if (++checks === 2) throw new Error("instruction changed"); })).rejects.toThrow("instruction changed");
    expect(mutations(g)).toEqual([]);
  });

  test("typing and scrolling use real Cua refs; a new observation invalidates earlier refs", async () => {
    const f = fixture(), stale = await f.input.snapshot(), fresh = await f.input.snapshot();
    await expect(f.input.act(stale, { action: "click" }, "p17:1")).rejects.toThrow("stale");
    await f.input.act(fresh, { action: "type", text: "Subject", replace: true }, "p17:2");
    const scroll = await f.input.snapshot();
    await f.input.act(scroll, { action: "scroll", amount: 5 });
    expect(mutations(f).map((entry) => [entry.name, entry.args.ref, entry.args.replace, entry.args.delta_y])).toEqual([
      ["browser_type", "p17:2", true, undefined], ["browser_pointer", "p17:3", undefined, 200],
    ]);
  });

  test("release ends only the Cua session and forbids subsequent actions", async () => {
    const f = fixture(), snapshot = await f.input.snapshot();
    await f.input.close();
    await expect(f.input.act(snapshot, { action: "click" }, "p17:1")).rejects.toThrow("stale");
    expect(f.calls.at(-1)).toEqual({ name: "end_session", args: { session: "account-test" } });
    expect(mutations(f)).toEqual([]);
  });
});

describe("addressToUrl", () => {
  test("hosts become https, words become a search", () => {
    expect(addressToUrl("en.wikipedia.org/wiki/Capybara")).toBe("https://en.wikipedia.org/wiki/Capybara");
    expect(addressToUrl(" https://jspaint.app ")).toBe("https://jspaint.app");
    expect(addressToUrl("localhost:7777/status")).toBe("http://localhost:7777/status");
    expect(addressToUrl("weather in tokyo")).toBe("https://www.google.com/search?q=weather%20in%20tokyo");
    expect(addressToUrl("水豚")).toBe(`https://www.google.com/search?q=${encodeURIComponent("水豚")}`);
  });
});

describe("toCss", () => {
  test("outside the page area is not the page's business", () => {
    expect(toCss(500, 40, [1, 86, 1344, 805], 1344)).toBeNull();
    expect(toCss(1345, 400, [1, 86, 1344, 805], 1344)).toBeNull();
  });
  test("subtracts the toolbar and applies the display scale", () => {
    expect(toCss(471, 205, [1, 86, 1344, 805], 1344)).toEqual({ x: 470, y: 119 });
    expect(toCss(561, 180, [0, 140, 1340, 749], 820)).toEqual({ x: 343.3, y: 24.48 });
  });
});

describe("browserInput", () => {
  test("an unmatched or duplicate tab title never falls back to an arbitrary page", async () => {
    const mismatch = fakeHelper({ title: "A different document" });
    expect(await mismatch.input.handle("click", { x: 100, y: 200 }, mismatch.window)).toBe(false);
    expect(mismatch.acts()).toHaveLength(0);
    const duplicate = browserInput(async (line) => {
      if (line.startsWith("http ")) return JSON.stringify(["a", "b"].map((id) => ({ type: "page", title: "Same", url: "https://example.test/", webSocketDebuggerUrl: `ws://127.0.0.1/${id}` })));
      throw new Error("No input may be sent");
    }, async () => 9);
    expect(await duplicate.handle("type_text", { text: "hello" }, { containerId: 42, title: "Same - Google Chrome" })).toBe(false);
  });
  test("a click in the page is a trusted press and release on the tab the window shows", async () => {
    const { input, window, sent, acts } = fakeHelper();
    expect(await input.handle("click", { x: 471, y: 205, button: "left" }, window)).toBe(true);
    expect(sent[0]!.method).toBe("WIKI:Emulation.setFocusEmulationEnabled");
    expect(acts().map((s) => [s.method, s.params.type, s.params.x, s.params.y])).toEqual([
      ["WIKI:Input.dispatchMouseEvent", "mouseMoved", 470, 119],
      ["WIKI:Input.dispatchMouseEvent", "mousePressed", 470, 119],
      ["WIKI:Input.dispatchMouseEvent", "mouseReleased", 470, 119],
    ]);
  });

  test("toolbar clicks go to Cua, and what is typed next navigates", async () => {
    const { input, window, acts } = fakeHelper();
    expect(await input.handle("click", { x: 500, y: 60 }, window)).toBe(false);
    expect(await input.handle("type_text", { text: "jspaint.app" }, window)).toBe(true);
    expect(await input.handle("press_key", { key: "Return" }, window)).toBe(true);
    expect(acts()).toEqual([{ method: "WIKI:Runtime.evaluate", params: { expression: 'location.assign("https://jspaint.app")' } }]);
  });

  test("ctrl+l then text navigates once; the following Enter is spent, the one after is real", async () => {
    const { input, window, acts } = fakeHelper();
    await input.handle("hotkey", { keys: ["ctrl", "l"] }, window);
    await input.handle("type_text", { text: "capybara facts" }, window);
    await input.handle("press_key", { key: "enter" }, window);
    await input.handle("press_key", { key: "enter" }, window);
    expect(acts().map((s) => s.method.split(":")[1])).toEqual(["Runtime.evaluate", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent"]);
    expect(acts()[0]!.params.expression).toBe('location.assign("https://www.google.com/search?q=capybara%20facts")');
  });

  test("text after a page click is inserted, not navigated", async () => {
    const { input, window, acts } = fakeHelper();
    await input.handle("click", { x: 471, y: 205 }, window);
    await input.handle("type_text", { text: "水豚" }, window);
    expect(acts().at(-1)).toEqual({ method: "WIKI:Input.insertText", params: { text: "水豚" } });
  });

  test("a stroke is one held press, and lifts where it ended because ai.ts releases without a point", async () => {
    const { input, window, acts } = fakeHelper();
    await input.handle("mouse_button_down", { x: 301, y: 486, button: "left" }, window);
    await input.handle("mouse_drag", { x: 421, y: 386, steps: 2 }, window);
    expect(await input.handle("mouse_button_up", {}, window)).toBe(true);
    expect(acts().map((s) => [s.params.type, s.params.x, s.params.y, s.params.buttons])).toEqual([
      ["mouseMoved", 300, 400, undefined], ["mousePressed", 300, 400, 1],
      ["mouseMoved", 360, 350, 1], ["mouseMoved", 420, 300, 1],
      ["mouseReleased", 420, 300, undefined],
    ]);
  });

  test("a press on the toolbar, or a browser that is not running, is left to Cua", async () => {
    const { input, window } = fakeHelper();
    expect(await input.handle("mouse_button_down", { x: 300, y: 20 }, window)).toBe(false);
    expect(await input.handle("mouse_button_up", {}, window)).toBe(false);
    const gone = browserInput(async () => { throw new Error("no helper"); }, async () => null);
    expect(await gone.handle("click", { x: 10, y: 200 }, window)).toBe(false);
  });
});
