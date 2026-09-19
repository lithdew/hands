import { describe, expect, test } from "bun:test";
import { addressToUrl, browserInput, existingBrowserInput, keyEvent, toCss, type Ask, type ExistingBrowserTiming, type ExistingBrowserWindow } from "./browser";
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
  function fixture(diagnostics: Parameters<typeof existingBrowserInput>[4] = {}, canFocus = true) {
    let window: ExistingBrowserWindow = { pid: 90, containerId: 1234, ownerNonce: "0000000000000123", title: "Inbox - Google Chrome", rect: [1, 1, 1000, 800] };
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let bind = 0, tabGeneration = 0, exact = true, setup = false, denied = false;
    const tabCapabilities = new Map<string, { targetId: string; generation: number }>();
    let tabs = [{ title: "Inbox", url: "https://mail.example/", active: true as boolean | null }];
    let pageOverride: { title: string; url: string } | undefined;
    let outcome: Record<string, unknown> = { status: "ok" };
    let outcomeError = false;
    let dialog: Record<string, unknown> = { present: false };
    let onCall: ((name: string, args: Record<string, unknown>) => void | Promise<void>) | undefined;
    let onFocus: (() => void | Promise<void>) | undefined;
    let nativeSize=[1000,800],nativePixel=0,focusedEditable=false;
    let nativeOutcome: Record<string, unknown> = {}, nativeError = false;
    let scopeOverride: Record<string, unknown> = {};
    let snapshotOverride: Record<string, unknown> = {};
    let continuationOverride: Record<string, unknown> = {};
    let sessionReply = response({ session: "account-test", implicit: false, state: "active", idle_seconds: 120, expires_in_seconds: 180 });
    let sizeReply = response({ width: 1920, height: 1080, scale_factor: 1 });
    const call: CuaConnection["call"] = async (name, args = {}) => {
      calls.push({ name, args }); await onCall?.(name, args);
      if (denied) throw new Error("browser_consent_required: user denied this request");
      if (name === "get_session") return sessionReply;
      if (name === "get_screen_size") return sizeReply;
      if (name === "get_browser_state" && args.pid) {
        if (setup) throw new Error("browser_requires_setup: use browser_prepare");
        bind++;
        tabs.forEach((_, i) => tabCapabilities.set(`tab-${bind}-${i}`, { targetId: `target-${bind}`, generation: tabGeneration }));
        return response({ status: "ok", mode: "bind", target_id: `target-${bind}`, binding_quality: exact ? "exact" : "heuristic", mutation_allowed: exact,
          tabs: tabs.map((tab, i) => ({ ...tab, tab_id: `tab-${bind}-${i}` })) });
      }
      if (name === "get_browser_state" && args.scope_ref) return response({ status: "ok", mode: "snapshot", target_id: args.target_id, tab_id: args.tab_id,
        snapshot: { id: "p18", format: "semantic_v2", scope: "subtree", complete: true, selected_nodes: 1, total_nodes: 1, omitted: { css_hidden: 0, page_occluded: 0 } },
        page: pageOverride ?? { title: tabs[0]!.title, url: tabs[0]!.url }, content_refs: [],
        refs: [{ ref: "p18:0", role: "textbox", name: "Subject", actions: ["type"], states: { focused: focusedEditable } }], ...scopeOverride });
      if (name === "get_browser_state" && args.continuation) return response({ status: "ok", mode: "snapshot", target_id: args.target_id, tab_id: args.tab_id,
        page: pageOverride ?? { title: tabs[0]!.title, url: tabs[0]!.url }, ...continuationOverride });
      if (name === "get_browser_state") return response({ status: "ok", mode: "snapshot", target_id: args.target_id, tab_id: args.tab_id,
        snapshot: { id: "p17", format: "semantic_v2" }, page: pageOverride ?? { title: tabs[0]!.title, url: tabs[0]!.url }, outline: "Inbox\nCompose\nDraft saved",
        refs: [{ ref: "p17:1", role: "button", name: "Compose", actions: ["click"] }, { ref: "p17:2", role: "textbox", name: "Subject", actions: ["type"],states:{focused:focusedEditable} },
          { ref: "p17:3", role: "generic", name: null, actions: ["scroll", "pointer"] }], ...snapshotOverride });
      if(name==="get_window_state") {const png=Buffer.alloc(25);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(nativeSize[0]!,16);png.writeUInt32BE(nativeSize[1]!,20);png[24]=nativePixel;return {content:[{type:"image",mimeType:"image/png",data:png.toString("base64")}],structuredContent:{screenshot_width:nativeSize[0],screenshot_height:nativeSize[1],...nativeOutcome},isError:nativeError};}
      if (name === "browser_prepare") { setup = false; return response({ status: "ok", prepared: true }); }
      if (name === "browser_dialog") {
        const original = tabCapabilities.get(String(args.tab_id));
        if (!original || original.targetId !== args.target_id || original.generation !== tabGeneration) {
          return response({ status: "refused", code: "browser_tab_not_found", message: "The original capability no longer has a live CDP page target" });
        }
        return response({ status: "ok", target_id: args.target_id, tab_id: args.tab_id,
          ...dialog, ...(args.action === "inspect" ? {} : { action: args.action }) });
      }
      return { ...response(outcome), isError: outcomeError };
    };
    const input = existingBrowserInput(call, async () => window, "account-test", canFocus ? async (observed) => {
      calls.push({ name: "focus_existing", args: { pid: observed.pid, window_id: observed.containerId, ownerNonce: observed.ownerNonce } });
      await onFocus?.();
    } : undefined, { ...diagnostics, maintenance: { schedule: () => () => {}, ...diagnostics.maintenance } });
    return { input, calls, mutateWindow: (change: Partial<ExistingBrowserWindow>) => { window = { ...window, ...change }; },
      tabs: (value: typeof tabs) => { tabs = value; }, setup: () => { setup = true; }, heuristic: () => { exact = false; }, deny: () => { denied = true; },
      page: (value: typeof pageOverride) => { pageOverride = value; },
      outcome: (value: typeof outcome, isError = false) => { outcome = value; outcomeError = isError; },
      dialog: (value: typeof dialog) => { dialog = value; },
      closeAndReopenTab: () => { tabGeneration++; },
      onCall: (fn: NonNullable<typeof onCall>) => { onCall = fn; },
      nativeSize:(width:number,height:number)=>{nativeSize=[width,height];}, focusedEditable:(value=true)=>{focusedEditable=value;},
      nativePixel:(value:number)=>{nativePixel=value;},
      nativeOutcome:(value:typeof nativeOutcome,isError=false)=>{nativeOutcome=value;nativeError=isError;},
      scope:(value:typeof scopeOverride)=>{scopeOverride=value;},
      snapshotState:(value:typeof snapshotOverride)=>{snapshotOverride=value;},
      continuationState:(value:typeof continuationOverride)=>{continuationOverride=value;},
      sessionReply: (state: Record<string, unknown>, isError = false) => { sessionReply = { ...response(state), isError }; },
      sizeReply: (state: Record<string, unknown>, isError = false) => { sizeReply = { ...response(state), isError }; },
      onFocus: (fn: NonNullable<typeof onFocus>) => { onFocus = fn; } };
  }
  const mutations = (f: ReturnType<typeof fixture>) => f.calls.filter((call) => !["get_browser_state", "get_window_state", "get_session", "get_screen_size", "end_session", "focus_existing"].includes(call.name)
    && !(call.name === "browser_dialog" && call.args.action === "inspect"));
  const dialogFixture = () => { const f = fixture(); f.dialog({ present: true, dialog_id: "dialog-7", kind: "alert" }); return f; };

  function truncatedFixture() {
    const f = fixture();
    const first = { snapshot: { id: "p17", format: "semantic_v2", scope: "viewport", complete: false, selected_nodes: 300, total_nodes: 303,
      node_budget: 300, omitted: { budget: 3, unprovable_frame: 0 }, continuation: "bc-first" }, content_refs: [],
      refs: Array.from({ length: 300 }, (_, i) => ({ ref: `p17:${i}`, role: "button", name: `Row ${i}`, actions: ["click"], visibility: "in_viewport" })) };
    const more = { snapshot: { id: "p17", format: "semantic_v2", scope: "continuation", complete: true, selected_nodes: 3, total_nodes: 303,
      node_budget: 300, omitted: { budget: 0, unprovable_frame: 0 }, continuation: null },
      refs: [{ ref: "p17:300", role: "textbox", name: "Message body", value: "Exact body", actions: ["type"], visibility: "in_viewport" }],
      content_refs: [{ ref: "p17:301", role: "statictext", name: "recipient@example.test", actions: [], visibility: "in_viewport" },
        { ref: "p17:302", role: "statictext", name: "Draft saved", actions: [], visibility: "in_viewport" }], outline: "Message body\nDraft saved" };
    f.snapshotState(first); f.continuationState(more);
    return { ...f, first, more };
  }

  test("one cached continuation retains a real late body ref and readonly content without repeating DOM extraction", async () => {
    const f = truncatedFixture(), observed = await f.input.snapshot(undefined, { query: "Body" });
    const reads = f.calls.filter(call => call.name === "get_browser_state" && call.args.target_id);
    expect(reads).toHaveLength(2);
    expect(reads[0]?.args).toMatchObject({ query: "Body", snapshot_format: "semantic_v2" });
    expect(reads[1]?.args).toEqual({ target_id: observed.target_id, tab_id: observed.tab_id, snapshot_format: "semantic_v2", continuation: "bc-first", include_screenshot: false, session: "account-test" });
    expect(observed.coverage).toEqual({ complete: true, selectedNodes: 303, totalNodes: 303, omitted: { budget: 0, unprovable_frame: 0 }, continuation: "used" });
    expect(observed.refs).toHaveLength(301);
    expect(observed.refs.at(-1)).toMatchObject({ ref: "p17:300", name: "Message body", value: "Exact body", actions: ["type"] });
    expect(observed.content).toEqual([{ role: "statictext", name: "recipient@example.test", value: undefined, visibility: "in_viewport" },
      { role: "statictext", name: "Draft saved", value: undefined, visibility: "in_viewport" }]);
    expect(JSON.stringify(observed.content)).not.toMatch(/p17:|actions/);
    await expect(f.input.act(observed, { action: "click" }, "p17:301")).rejects.toThrow("not observed");
    await f.input.act(observed, { action: "type", text: "Updated body" }, "p17:300");
    expect(mutations(f).map(call => call.name)).toEqual(["browser_type"]);
  });

  test("continuation is capped at one and missing handles stay explicitly incomplete", async () => {
    for (const available of [false, true]) {
      const f = truncatedFixture();
      if (!available) f.snapshotState({ ...f.first, snapshot: { ...f.first.snapshot, continuation: null } });
      else {
        f.snapshotState({ ...f.first, snapshot: { ...f.first.snapshot, total_nodes: 307, omitted: { budget: 7 } } });
        f.continuationState({ ...f.more, snapshot: { ...f.more.snapshot, complete: false, total_nodes: 307, omitted: { budget: 4 }, continuation: "bc-more" } });
      }
      const observed = await f.input.snapshot();
      expect(observed.coverage?.complete).toBe(false);
      expect(observed.coverage?.continuation).toBe(available ? "limit-reached" : "unavailable");
      expect(f.calls.filter(call => call.args.continuation)).toHaveLength(available ? 1 : 0);
      expect(f.calls.filter(call => call.args.target_id && !call.args.continuation)).toHaveLength(1);
      expect(mutations(f)).toEqual([]);
    }
  });

  test("identical repeated continuation references are deduplicated without inventing another input alias", async () => {
    const f = truncatedFixture(); f.continuationState({ ...f.more, refs: [f.first.refs[0]] });
    const observed = await f.input.snapshot();
    expect(observed.refs).toHaveLength(300);
    expect(observed.refs.filter(ref => ref.ref === "p17:0")).toHaveLength(1);
    expect(observed.content).toHaveLength(2); expect(mutations(f)).toEqual([]);
  });

  test("stale, refused, conflicting or foreign continuation data invalidates all earlier refs without full-read retry", async () => {
    for (const change of ["target", "tab", "snapshot", "scope", "page", "duplicate", "content-action", "stale", "oversized"]) {
      const f = truncatedFixture(); f.snapshotState({}); const old = await f.input.snapshot(); f.snapshotState(f.first); f.calls.length = 0;
      if (change === "target") f.continuationState({ ...f.more, target_id: "wrong" });
      if (change === "tab") f.continuationState({ ...f.more, tab_id: "wrong" });
      if (change === "snapshot") f.continuationState({ ...f.more, snapshot: { ...f.more.snapshot, id: "p18" } });
      if (change === "scope") f.continuationState({ ...f.more, snapshot: { ...f.more.snapshot, scope: "viewport" } });
      if (change === "page") f.continuationState({ ...f.more, page: { title: "Inbox", url: "https://other.test/" } });
      if (change === "duplicate") f.continuationState({ ...f.more, refs: [{ ...f.more.refs[0], ref: "p17:0" }] });
      if (change === "content-action") f.continuationState({ ...f.more, content_refs: [{ ...f.more.content_refs[0], actions: ["click"] }] });
      if (change === "stale") f.continuationState({ status: "refused", code: "browser_ref_stale", message: "page navigated" });
      if (change === "oversized") f.continuationState({ ...f.more, refs: Array.from({ length: 301 }, (_, i) => ({ ...f.more.refs[0], ref: `p17:${300 + i}` })) });
      await expect(f.input.snapshot()).rejects.toThrow();
      await expect(f.input.act(old, { action: "click" }, "p17:1")).rejects.toThrow("stale");
      expect(f.calls.filter(call => call.args.target_id && !call.args.continuation)).toHaveLength(1);
      expect(f.calls.filter(call => call.args.continuation)).toHaveLength(1);
      expect(mutations(f)).toEqual([]);
    }
  });

  test("continuation completion rechecks native ownership, full geometry, cancellation and observation generation", async () => {
    for (const change of ["owner", "move", "resize", "title", "cancel", "new-observation"]) {
      const f = truncatedFixture(), abort = new AbortController(); let replacement: Awaited<ReturnType<typeof f.input.snapshot>> | undefined;
      f.onCall(async (name, args) => {
        if (name !== "get_browser_state" || !args.continuation) return;
        if (change === "owner") f.mutateWindow({ ownerNonce: "0000000000009999" });
        if (change === "move") f.mutateWindow({ rect: [2, 1, 1000, 800] });
        if (change === "resize") f.mutateWindow({ rect: [1, 1, 1100, 800] });
        if (change === "title") f.mutateWindow({ title: "Changed - Google Chrome" });
        if (change === "cancel") abort.abort();
        if (change === "new-observation") { f.snapshotState({}); replacement = await f.input.snapshot(); }
      });
      await expect(f.input.snapshot(abort.signal)).rejects.toThrow();
      expect(mutations(f)).toEqual([]);
      expect(f.calls.filter(call => call.args.target_id && !call.args.continuation)).toHaveLength(change === "new-observation" ? 2 : 1);
      if (replacement) await f.input.act(replacement, { action: "click" }, "p17:1");
    }
  });

  function maintenanceClock() {
    let time = 0, current: (() => Promise<void>) | undefined;
    const scheduled: { tick: () => Promise<void>; intervalMs: number }[] = [];
    const maintenance = { now: () => time, schedule: (tick: () => Promise<void>, intervalMs: number) => {
      scheduled.push({ tick, intervalMs }); current = tick;
      return () => { if (current === tick) current = undefined; };
    } };
    return { maintenance, scheduled, advance: (ms: number) => { time += ms; }, active: () => Boolean(current), fire: async () => { await current?.(); } };
  }

  test("idle maintenance starts only after successful attach and touches only its verified named session", async () => {
    const clock = maintenanceClock(), f = fixture({ maintenance: clock.maintenance });
    await f.input.snapshot(); clock.advance(120_000); await clock.fire();
    expect(clock.scheduled).toHaveLength(0);
    await f.input.attach(); f.calls.length = 0;
    expect(clock.scheduled.map(item => item.intervalMs)).toEqual([60_000]);
    clock.advance(119_999); await clock.fire(); expect(f.calls).toEqual([]);
    clock.advance(1); await clock.fire();
    expect(f.calls).toEqual([{ name: "get_session", args: { session: "account-test" } }, { name: "get_screen_size", args: { session: "account-test" } }]);
    expect(f.input.healthy()).toBe(true); expect(mutations(f)).toEqual([]);
    f.calls.length = 0; clock.advance(60_000); await clock.fire(); expect(f.calls).toEqual([]);
    await f.input.close(); expect(clock.active()).toBe(false);
    const failedClock = maintenanceClock(), failed = fixture({ maintenance: failedClock.maintenance }); failed.deny();
    await expect(failed.input.attach()).rejects.toThrow("denied");
    expect(failedClock.scheduled).toHaveLength(0);
  });

  test("successful maintenance does not manufacture or consume browser capabilities", async () => {
    for (const visual of [false, true]) {
      const clock = maintenanceClock(), f = fixture({ maintenance: clock.maintenance }); await f.input.attach();
      if (visual) {
        const capture = await f.input.captureVisual(); clock.advance(120_000); await clock.fire();
        await f.input.canvasAct(capture, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 });
        await expect(f.input.canvasAct(capture, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 })).rejects.toThrow("stale");
      } else {
        const observed = await f.input.snapshot(); clock.advance(120_000); await clock.fire();
        await f.input.act(observed, { action: "click" }, "p17:1");
        await expect(f.input.act(observed, { action: "click" }, "p17:1")).rejects.toThrow("stale");
      }
      expect(mutations(f).map(call => call.name)).toEqual([visual ? "click" : "browser_click"]);
      await f.input.close();
    }
  });

  test("ordinary activity postpones idle maintenance and long normal operations are never interrupted by it", async () => {
    const clock = maintenanceClock(), f = fixture({ maintenance: clock.maintenance }); await f.input.attach();
    clock.advance(60_000); await f.input.snapshot(); f.calls.length = 0;
    clock.advance(60_000); await clock.fire(); expect(f.calls).toEqual([]);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.onCall(async name => { if (name === "get_browser_state") { entered.resolve(); await release.promise; } });
    const pending = f.input.snapshot(); await entered.promise;
    clock.advance(180_000); await clock.fire();
    expect(f.calls.filter(call => ["get_session", "get_screen_size"].includes(call.name))).toEqual([]);
    release.resolve(); await pending; f.onCall(() => {}); f.calls.length = 0;
    await clock.fire(); expect(f.calls).toEqual([]);
    clock.advance(120_000); await clock.fire();
    expect(f.calls.map(call => call.name)).toEqual(["get_session", "get_screen_size"]);
    await f.input.close();
  });

  test("pending session inspection cannot queue a touch after normal work begins", async () => {
    const clock = maintenanceClock(), f = fixture({ maintenance: clock.maintenance }); await f.input.attach();
    const observed = await f.input.snapshot(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.onCall(async name => { if (name === "get_session") { entered.resolve(); await release.promise; } });
    clock.advance(120_000); const pending = clock.fire(); await entered.promise;
    await clock.fire(); // A second tick must not overlap this one.
    await f.input.act(observed, { action: "click" }, "p17:1");
    release.resolve(); await pending;
    expect(f.calls.filter(call => call.name === "get_session")).toHaveLength(1);
    expect(f.calls.some(call => call.name === "get_screen_size")).toBe(false);
    expect(mutations(f).map(call => call.name)).toEqual(["browser_click"]);
    expect(f.input.healthy()).toBe(true); await f.input.close();
  });

  test("detach stops scheduled and in-flight maintenance without reviving its session", async () => {
    const clock = maintenanceClock(), f = fixture({ maintenance: clock.maintenance }); await f.input.attach();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.onCall(async name => { if (name === "get_session") { entered.resolve(); await release.promise; } });
    clock.advance(120_000); const pending = clock.fire(); await entered.promise;
    await f.input.close(); release.resolve(); await pending;
    clock.advance(600_000); await clock.scheduled[0]!.tick();
    expect(clock.active()).toBe(false); expect(f.input.healthy()).toBe(false);
    expect(f.calls.filter(call => ["get_session", "get_screen_size", "end_session", "start_session", "browser_prepare"].includes(call.name)).map(call => call.name)).toEqual(["get_session", "end_session"]);
  });

  test("known expiry, refusal and lost lease stop maintenance and revoke every observation without reattachment", async () => {
    for (const failure of ["missing", "missing-text", "ending", "ended", "consent", "lease", "refused-status", "refused-size", "permission-size", "permission-text"]) {
      const clock = maintenanceClock(), f = fixture({ maintenance: clock.maintenance }); await f.input.attach();
      const observed = await f.input.snapshot(), capture = await f.input.captureCanvas(observed); f.calls.length = 0;
      if (failure === "missing") f.sessionReply({ code: "session_not_started" }, true);
      if (failure === "ending" || failure === "ended") f.sessionReply({ session: "account-test", implicit: false, state: failure });
      if (failure === "refused-status") f.sessionReply({ status: "refused" });
      if (failure === "refused-size") f.sizeReply({ status: "refused" });
      if (failure === "permission-size") f.sizeReply({ code: "permission_required" }, true);
      f.onCall(name => { if (name !== "get_session") return;
        if (failure === "consent") throw new Error("browser_consent_required: user denied this request");
        if (failure === "lease") throw new Error("Cua broker lease expired or disconnected.");
        if (failure === "missing-text") throw new Error("session is not visible to this transport");
        if (failure === "permission-text") throw new Error("permission_required: this read was refused");
      });
      clock.advance(120_000); await clock.fire();
      expect(f.input.healthy()).toBe(false); expect(clock.active()).toBe(false);
      await expect(f.input.act(observed, { action: "click" }, "p17:1")).rejects.toThrow("stale");
      await expect(f.input.canvasAct(capture, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 })).rejects.toThrow("stale");
      const count = f.calls.length; clock.advance(600_000); await clock.scheduled[0]!.tick();
      expect(f.calls).toHaveLength(count); expect(mutations(f)).toEqual([]);
    }
    const clock = maintenanceClock(), f = fixture({ maintenance: clock.maintenance }); await f.input.attach();
    f.dialog({ present: true, dialog_id: "dialog-7", kind: "alert" }); const dialog = await f.input.inspectDialog();
    f.sessionReply({ code: "session_not_started" }, true); clock.advance(120_000); await clock.fire();
    await expect(f.input.resolveDialog(dialog, "accept", "dialog-7")).rejects.toThrow("stale");
  });

  test("unknown timeouts revoke stale observations and back off without claiming expiry or reconnecting", async () => {
    const clock = maintenanceClock(), f = fixture({ maintenance: clock.maintenance }); await f.input.attach();
    const observed = await f.input.snapshot(); f.calls.length = 0;
    f.onCall(name => { if (name === "get_session") throw new Error("Cua request timed out"); });
    clock.advance(120_000); await clock.fire();
    expect(f.input.healthy()).toBe(true); expect(clock.active()).toBe(true);
    await expect(f.input.act(observed, { action: "click" }, "p17:1")).rejects.toThrow("stale");
    clock.advance(119_999); await clock.fire(); expect(f.calls).toHaveLength(1);
    clock.advance(1); await clock.fire(); expect(f.calls).toHaveLength(2);
    expect(clock.active()).toBe(false); expect(f.input.healthy()).toBe(true);
    clock.advance(600_000); await clock.scheduled[0]!.tick(); expect(f.calls).toHaveLength(2);
    expect(f.calls.map(call => call.name)).toEqual(["get_session", "get_session"]);
  });

  test("missing or mismatched session proof never touches an implicit or alternate session", async () => {
    for (const state of [{}, { session: "other", implicit: false, state: "active" }, { session: "account-test", implicit: true, state: "active" }]) {
      const clock = maintenanceClock(), f = fixture({ maintenance: clock.maintenance }); await f.input.attach(); f.calls.length = 0;
      f.sessionReply(state); clock.advance(120_000); await clock.fire();
      expect(f.calls).toEqual([{ name: "get_session", args: { session: "account-test" } }]);
      expect(f.input.healthy()).toBe(true); await f.input.close();
    }
  });

  test("maintenance inspects lifecycle before every touch and cannot revive a session that ends between reads", async () => {
    const clock = maintenanceClock(), f = fixture({ maintenance: clock.maintenance }); await f.input.attach(); f.calls.length = 0;
    clock.advance(120_000); await clock.fire();
    f.onCall(name => { if (name === "get_screen_size") throw new Error("this session has ended; call start_session explicitly to reuse its label"); });
    clock.advance(120_000); await clock.fire();
    expect(f.calls.map(call => call.name)).toEqual(["get_session", "get_screen_size", "get_session", "get_screen_size"]);
    expect(f.input.healthy()).toBe(false); expect(clock.active()).toBe(false);
  });

  test("broker disconnection immediately stops maintenance and invalidates capabilities without ending or reconnecting", async () => {
    const clock = maintenanceClock(), disconnected = new AbortController();
    const f = fixture({ maintenance: { ...clock.maintenance, disconnected: disconnected.signal } }); await f.input.attach();
    const capture = await f.input.captureVisual(); f.calls.length = 0;
    disconnected.abort();
    expect(f.input.healthy()).toBe(false); expect(clock.active()).toBe(false);
    clock.advance(600_000); await clock.scheduled[0]!.tick();
    await expect(f.input.canvasAct(capture, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 })).rejects.toThrow("stale");
    await expect(f.input.snapshot()).rejects.toThrow("released");
    expect(f.calls).toEqual([]);
  });

  test("transport loss during an idle read prevents its next RPC and cannot revive readiness on completion", async () => {
    const clock = maintenanceClock(), disconnected = new AbortController();
    const f = fixture({ maintenance: { ...clock.maintenance, disconnected: disconnected.signal } }); await f.input.attach(); f.calls.length = 0;
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.onCall(async name => { if (name === "get_session") { entered.resolve(); await release.promise; } });
    clock.advance(120_000); const pending = clock.fire(); await entered.promise; disconnected.abort();
    expect(clock.active()).toBe(false); expect(f.input.healthy()).toBe(false);
    release.resolve(); await pending;
    expect(f.calls).toEqual([{ name: "get_session", args: { session: "account-test" } }]);
    expect(f.input.healthy()).toBe(false);
  });

  test("a connection already lost before construction never attaches or starts maintenance", async () => {
    const clock = maintenanceClock(), disconnected = new AbortController(); disconnected.abort();
    const f = fixture({ maintenance: { ...clock.maintenance, disconnected: disconnected.signal } });
    await expect(f.input.attach()).rejects.toThrow("released");
    expect(f.input.healthy()).toBe(false); expect(clock.scheduled).toEqual([]); expect(f.calls).toEqual([]);
  });

  test("idle maintenance skips foreground preparation gaps before a targeted input", async () => {
    const clock = maintenanceClock(), f = fixture({ maintenance: clock.maintenance }); await f.input.attach();
    const capture = await f.input.captureVisual(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.onFocus(async () => { entered.resolve(); await release.promise; });
    const pending = f.input.canvasAct(capture, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 });
    await entered.promise; clock.advance(600_000); await clock.fire();
    expect(f.calls.some(call => ["get_session", "get_screen_size"].includes(call.name))).toBe(false);
    release.resolve(); await pending;
    expect(mutations(f).map(call => call.name)).toEqual(["click"]);
    await f.input.close();
  });

  test("a late unverified maintenance failure cannot erase a newer normal observation", async () => {
    const clock = maintenanceClock(), f = fixture({ maintenance: clock.maintenance }); await f.input.attach();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.onCall(async name => { if (name === "get_session") { entered.resolve(); await release.promise; throw new Error("Cua request timed out"); } });
    clock.advance(120_000); const pending = clock.fire(); await entered.promise;
    const observed = await f.input.snapshot(); release.resolve(); await pending;
    await f.input.act(observed, { action: "click" }, "p17:1");
    expect(mutations(f).map(call => call.name)).toEqual(["browser_click"]);
    expect(f.input.healthy()).toBe(true); await f.input.close();
  });

  test("a refused maintenance result still revokes readiness when normal activity started during the read", async () => {
    const clock = maintenanceClock(), f = fixture({ maintenance: clock.maintenance }); await f.input.attach();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.sessionReply({ status: "refused" });
    f.onCall(async name => { if (name === "get_session") { entered.resolve(); await release.promise; } });
    clock.advance(120_000); const pending = clock.fire(); await entered.promise;
    const observed = await f.input.snapshot(); release.resolve(); await pending;
    expect(f.input.healthy()).toBe(false); expect(clock.active()).toBe(false);
    await expect(f.input.act(observed, { action: "click" }, "p17:1")).rejects.toThrow("stale");
    expect(mutations(f)).toEqual([]);
  });

  test("visual canvas capture reads only exact bindings and native pixels, and revokes old DOM refs", async () => {
    const events:ExistingBrowserTiming[]=[],f=fixture({timing:event=>events.push(event)}),page=await f.input.snapshot();
    f.calls.length=0;events.length=0;
    const capture=await f.input.captureVisual();
    expect(capture.page).toBeUndefined();expect(capture).not.toHaveProperty("refs");expect(capture).not.toHaveProperty("snapshot_id");
    expect(f.calls.map(call=>call.name)).toEqual(["get_browser_state","get_window_state","get_browser_state","browser_dialog"]);
    expect(f.calls.at(-1)?.args).toMatchObject({target_id:capture.binding.target_id,tab_id:capture.binding.tab.tab_id,action:"inspect"});
    expect(f.calls.filter(call=>call.name==="get_browser_state").every(call=>call.args.pid===90&&call.args.target_id===undefined&&call.args.snapshot_format===undefined)).toBe(true);
    expect(events.filter(event=>event.phase==="capture_rpc").map(event=>event.event)).toEqual(["start","end"]);
    await expect(f.input.act(page,{action:"click"},"p17:1")).rejects.toThrow("stale");
    await f.input.canvasAct(capture,{action:"canvas_click",delivery:"foreground",x:30,y:40});
    expect(mutations(f).map(call=>call.name)).toEqual(["click"]);
    await expect(f.input.canvasAct(capture,{action:"canvas_click",delivery:"foreground",x:30,y:40})).rejects.toThrow("stale");
  });

  test("visual captures dispatch one explicit foreground key with current exact binding and no DOM traversal", async () => {
    for(const [key,name,args] of [["f","press_key",{key:"f"}],["ctrl+1","hotkey",{keys:["ctrl","1"]}]] as const){
      const f=fixture(),capture=await f.input.captureVisual();f.calls.length=0;
      await f.input.canvasAct(capture,{action:"key",delivery:"foreground",key});
      expect(mutations(f)).toEqual([{name,args:{pid:90,window_id:1234,session:"account-test",delivery_mode:"foreground",...args}}]);
      expect(f.calls.some(call=>call.name==="get_browser_state"&&(call.args.target_id||call.args.snapshot_format))).toBe(false);
      expect(f.calls.find(call=>call.name==="browser_dialog")?.args).toMatchObject({target_id:capture.binding.target_id,tab_id:capture.binding.tab.tab_id,action:"inspect"});
      await expect(f.input.canvasAct(capture,{action:"key",delivery:"foreground",key})).rejects.toThrow("stale");
    }
    const f=fixture(),capture=await f.input.captureVisual();
    await expect(f.input.canvasAct(capture,{action:"focused_text",delivery:"foreground",text:"unsafe"},"old-ref")).rejects.toThrow("include_refs:true");
    expect(mutations(f)).toEqual([]);
  });

  test("read-only canvas verification preserves the original capability only for identical fresh PNG bytes", async () => {
    for (const includeRefs of [false, true]) {
      const f = fixture(), capture = includeRefs ? await f.input.captureCanvas(await f.input.snapshot()) : await f.input.captureVisual();
      const original = structuredClone(capture); f.calls.length = 0;
      await f.input.assertCanvasCurrent(capture);
      expect(capture).toEqual(original);
      expect(f.calls.map(call => call.name)).toEqual(["get_window_state", "get_browser_state", "browser_dialog"]);
      expect(f.calls.at(-1)?.args).toMatchObject({ action: "inspect", target_id: original.binding.target_id, tab_id: original.binding.tab.tab_id });
      expect(mutations(f)).toEqual([]);
      await f.input.canvasAct(capture, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 });
      expect(mutations(f).map(call => call.name)).toEqual(["click"]);
      await expect(f.input.canvasAct(capture, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 })).rejects.toThrow("stale");
    }
  });

  test("changed PNG bytes or image dimensions revoke an approval even with unchanged URL, title and window", async () => {
    for (const changed of ["pixels", "dimensions"]) {
      const f = fixture(), capture = await f.input.captureVisual(); f.calls.length = 0;
      if (changed === "pixels") f.nativePixel(1); else f.nativeSize(900, 700);
      await expect(f.input.assertCanvasCurrent(capture)).rejects.toThrow("canvas pixels changed");
      expect(mutations(f)).toEqual([]);
      f.nativePixel(0); f.nativeSize(1000, 800);
      await expect(f.input.assertCanvasCurrent(capture)).rejects.toThrow("stale");
      await expect(f.input.canvasAct(capture, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 })).rejects.toThrow("stale");
      expect(mutations(f)).toEqual([]);
    }
  });

  test("canvas verification retains exact owner, frame, original tab, lifecycle and cancellation guards", async () => {
    for (const change of ["pid", "nonce", "move", "resize", "title", "url", "reopened-tab", "cancel", "capture-refused", "dialog"]) {
      const f = fixture(), capture = await f.input.captureVisual(), abort = new AbortController(); f.calls.length = 0;
      f.onCall(name => {
        if (name !== "get_window_state") return;
        if (change === "pid") f.mutateWindow({ pid: 91 });
        if (change === "nonce") f.mutateWindow({ ownerNonce: "0000000000009999" });
        if (change === "move") f.mutateWindow({ rect: [20, 1, 1000, 800] });
        if (change === "resize") f.mutateWindow({ rect: [1, 1, 900, 700] });
        if (change === "title") f.mutateWindow({ title: "Different - Google Chrome" });
        if (change === "url") f.tabs([{ title: "Inbox", url: "https://other.test/", active: true }]);
        if (change === "reopened-tab") f.closeAndReopenTab();
        if (change === "cancel") abort.abort();
        if (change === "capture-refused") f.nativeOutcome({ status: "refused" });
        if (change === "dialog") f.dialog({ present: true, dialog_id: "new-dialog", kind: "confirm" });
      });
      await expect(f.input.assertCanvasCurrent(capture, abort.signal)).rejects.toThrow();
      await expect(f.input.canvasAct(capture, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 })).rejects.toThrow("stale");
      expect(mutations(f)).toEqual([]);
    }
  });

  test("superseded canvas verification cannot restore its old capability or erase a newer capture", async () => {
    const f = fixture(), old = await f.input.captureVisual(); let newer: typeof old | undefined, replacing = false;
    f.onCall(async name => {
      if (name === "get_window_state" && !replacing) { replacing = true; newer = await f.input.captureVisual(); }
    });
    await expect(f.input.assertCanvasCurrent(old)).rejects.toThrow("changed");
    await expect(f.input.canvasAct(old, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 })).rejects.toThrow("stale");
    expect(mutations(f)).toEqual([]);
    expect(newer).toBeDefined();
    await f.input.canvasAct(newer!, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 });
    expect(mutations(f).map(call => call.name)).toEqual(["click"]);
  });

  test("a visual key timeout consumes its capture without declaring grant expiry or replaying input", async () => {
    const f=fixture(),capture=await f.input.captureVisual();f.calls.length=0;
    f.onCall(name=>{if(name==="hotkey")throw new Error("Request timed out");});
    await expect(f.input.canvasAct(capture,{action:"key",delivery:"foreground",key:"ctrl+1"})).rejects.toThrow("timed out");
    expect(f.input.healthy()).toBe(true);
    expect(mutations(f).map(call=>call.name)).toEqual(["hotkey"]);
    await expect(f.input.canvasAct(capture,{action:"key",delivery:"foreground",key:"ctrl+1"})).rejects.toThrow("stale");
    expect(f.calls.some(call=>["start_session","browser_prepare"].includes(call.name))).toBe(false);
  });

  test("visual captures reject changing ownership, frame, page or generation during capture and input", async () => {
    for(const stage of ["capture","input"]){
      for(const change of ["pid","nonce","move","resize","title","url","tab","generation","cancel","correction"]){
        const f=fixture(),abort=new AbortController();let revise=false;
        const capture=stage==="input"?await f.input.captureVisual():undefined;
        const mutate=async()=>{
          if(change==="pid")f.mutateWindow({pid:91});
          if(change==="nonce")f.mutateWindow({ownerNonce:"0000000000009999"});
          if(change==="move")f.mutateWindow({rect:[20,1,1000,800]});
          if(change==="resize")f.mutateWindow({rect:[1,1,900,700]});
          if(change==="title")f.mutateWindow({title:"Changed - Google Chrome"});
          if(change==="url")f.tabs([{title:"Inbox",url:"https://other.test/",active:true}]);
          if(change==="tab")f.tabs([{title:"Other",url:"https://mail.example/",active:true}]);
          if(change==="generation")await f.input.snapshot();
          if(change==="cancel")abort.abort();
          if(change==="correction")revise=true;
        };
        if(stage==="capture"){
          if(change==="correction")continue; // Input revisions gate mutations, not read-only capture.
          f.onCall(async name=>{if(name==="get_window_state")await mutate();});
          await expect(f.input.captureVisual(abort.signal)).rejects.toThrow();
        }else{
          f.onFocus(mutate);
          await expect(f.input.canvasAct(capture!,{action:"key",delivery:"foreground",key:"f"},undefined,abort.signal,()=>{if(revise)throw new Error("task revised");})).rejects.toThrow();
          await expect(f.input.canvasAct(capture!,{action:"key",delivery:"foreground",key:"f"})).rejects.toThrow("stale");
        }
        expect(mutations(f)).toEqual([]);
      }
    }
  });

  test("canvas re-attestation rejects a closed and reopened tab with the identical title and URL", async () => {
    for (const includeRefs of [false, true]) for (const stage of ["capture", "input"]) {
      const f = fixture(), page = includeRefs ? await f.input.snapshot() : undefined;
      const capture = stage === "input" ? page ? await f.input.captureCanvas(page) : await f.input.captureVisual() : undefined;
      f.calls.length = 0;
      f.onCall((name, args) => {
        if (stage === "capture" && name === "get_window_state" || stage === "input" && name === "get_browser_state" && args.pid) f.closeAndReopenTab();
      });
      if (stage === "capture") await expect(page ? f.input.captureCanvas(page) : f.input.captureVisual()).rejects.toThrow("browser_tab_not_found");
      else {
        await expect(f.input.canvasAct(capture!, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 })).rejects.toThrow("browser_tab_not_found");
        await expect(f.input.canvasAct(capture!, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 })).rejects.toThrow("stale");
      }
      expect(f.calls.filter(call => call.name === "browser_dialog")).toHaveLength(1);
      expect(mutations(f)).toEqual([]);
    }
  });

  test("canvas attestation retains the original capability despite fresh bind IDs and rejects wrong response IDs", async () => {
    for (const change of [{ target_id: "replacement" }, { tab_id: "replacement" }, { present: undefined }]) {
      const f = fixture(), capture = await f.input.captureVisual(); f.calls.length = 0;
      f.dialog({ present: false, ...change });
      await expect(f.input.canvasAct(capture, { action: "key", delivery: "foreground", key: "f" })).rejects.toThrow("original canvas tab");
      const inspect = f.calls.find(call => call.name === "browser_dialog")!;
      expect(inspect.args).toMatchObject({ target_id: capture.binding.target_id, tab_id: capture.binding.tab.tab_id, action: "inspect" });
      expect(mutations(f)).toEqual([]);
    }
    const f = fixture(), capture = await f.input.captureVisual(); f.calls.length = 0;
    await f.input.canvasAct(capture, { action: "key", delivery: "foreground", key: "f" });
    expect(f.calls.find(call => call.name === "browser_dialog")?.args).toMatchObject({ target_id: "target-1", tab_id: "tab-1-0" });
    expect(mutations(f).map(call => call.name)).toEqual(["press_key"]);
  });

  test("a dialog discovered by canvas attestation requires normal inspection and never receives canvas input", async () => {
    for (const stage of ["capture", "input"]) for (const kind of ["alert", "confirm", "prompt"]) {
      const f = fixture(), capture = stage === "input" ? await f.input.captureVisual() : undefined;
      f.dialog({ present: true, dialog_id: "dialog-7", kind }); f.calls.length = 0;
      if (stage === "capture") await expect(f.input.captureVisual()).rejects.toThrow("browser dialog inspect");
      else await expect(f.input.canvasAct(capture!, { action: "key", delivery: "foreground", key: "Enter" })).rejects.toThrow("browser dialog inspect");
      expect(f.calls.filter(call => call.name === "browser_dialog").map(call => call.args.action)).toEqual(["inspect"]);
      expect(mutations(f)).toEqual([]);
      expect(await f.input.inspectDialog()).toMatchObject({ present: true, kind, dialog_id: "dialog-7" });
      expect(mutations(f)).toEqual([]);
    }
  });

  test("a cancellation, correction or new observation during original-tab attestation prevents canvas input", async () => {
    for (const change of ["cancel", "correction", "observation", "blocked-attestation"]) {
      const f = fixture(), capture = await f.input.captureVisual(), abort = new AbortController(); let corrected = false;
      f.onCall(async (name) => {
        if (name !== "browser_dialog") return;
        if (change === "cancel") abort.abort();
        if (change === "correction") corrected = true;
        if (change === "observation") await f.input.snapshot();
        if (change === "blocked-attestation") throw new Error("Page.getFrameTree timed out");
      });
      await expect(f.input.canvasAct(capture, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 }, undefined, abort.signal,
        () => { if (corrected) throw new Error("instruction changed"); })).rejects.toThrow();
      await expect(f.input.canvasAct(capture, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 })).rejects.toThrow("stale");
      expect(mutations(f)).toEqual([]);
    }
  });

  test("activity reports bounded fixed metadata and an older completion cannot erase overlapping capture", async () => {
    let epoch=1000,tick=0,count=0;
    const first=Promise.withResolvers<void>(),second=Promise.withResolvers<void>(),started1=Promise.withResolvers<void>(),started2=Promise.withResolvers<void>();
    const f=fixture({epochNow:()=>++epoch,now:()=>++tick});
    f.onCall(async name=>{if(name!=="get_window_state")return;if(++count===1){started1.resolve();await first.promise;}else{started2.resolve();await second.promise;}});
    const one=f.input.captureVisual().then(()=>null,error=>error);await started1.promise;
    const older=f.input.activity().active!;expect(older).toMatchObject({phase:"capture_rpc",startedAt:expect.any(Number)});
    const two=f.input.captureVisual();await started2.promise;
    const newer=f.input.activity().active!;expect(newer.sequence).toBeGreaterThan(older.sequence);
    first.resolve();expect(String(await one)).toContain("changed");
    expect(f.input.activity().active).toEqual(newer);
    second.resolve();await two;
    const done=f.input.activity();expect(done.active).toBeUndefined();expect(done.last).toMatchObject({durationMs:expect.any(Number),outcome:"ok"});
    expect(JSON.stringify(done)).not.toMatch(/Inbox|mail\.example|target-|tab-|ref|screenshot/);
    done.last!.phase="prepare_rpc";expect(f.input.activity().last?.phase).not.toBe("prepare_rpc");
  });

  test("single-token queries reach Cua without entering bind or input arguments", async () => {
    const f = fixture();
    const first = await f.input.snapshot(undefined, { query: "Subject" });
    const current = await f.input.snapshot(undefined, { query: "  Body  " });
    expect(f.calls.filter(call => call.args.snapshot_format === "semantic_v2").map(call => call.args)).toEqual([
      { target_id: first.target_id, tab_id: first.tab_id, snapshot_format: "semantic_v2", include_screenshot: false, query: "Subject", session: "account-test" },
      { target_id: current.target_id, tab_id: current.tab_id, snapshot_format: "semantic_v2", include_screenshot: false, query: "Body", session: "account-test" },
    ]);
    expect(f.calls.filter(call => call.args.pid).every(call => !("query" in call.args))).toBe(true);
    await expect(f.input.act(first, { action: "type", text: "stale" }, "p17:2")).rejects.toThrow("stale");
    await f.input.act(current, { action: "type", text: "current" }, "p17:2");
    expect(mutations(f)).toEqual([{ name: "browser_type", args: { target_id: current.target_id, tab_id: current.tab_id, ref: "p17:2", text: "current", replace: true, session: "account-test" } }]);
    const unfiltered = await f.input.snapshot();
    expect(f.calls.findLast(call => call.args.target_id === unfiltered.target_id)?.args).not.toHaveProperty("query");
  });

  test("multiword and empty queries keep a full Cua snapshot for local alternative matching", async () => {
    for (const query of ["recipient subject message body send", "Message Body", "Subject\tBody", "Subject\nBody", "Subject\u00a0Body", "", " \t "]) {
      const f = fixture(), observed = await f.input.snapshot(undefined, { query });
      const rpc = f.calls.find(call => call.args.snapshot_format);
      expect(rpc?.args).not.toHaveProperty("query");
      expect(rpc?.args).toMatchObject({ target_id: observed.target_id, tab_id: observed.tab_id, snapshot_format: "semantic_v2", include_screenshot: false });
      expect(observed.refs.map(ref => ref.ref)).toEqual(["p17:1", "p17:2", "p17:3"]);
      expect(mutations(f)).toEqual([]);
    }
  });

  test("queried observations still reject wrong targets and expire all earlier references", async () => {
    for (const mismatch of [{ target_id: "wrong-target" }, { tab_id: "wrong-tab" }]) {
      const f = fixture(), old = await f.input.snapshot(); f.calls.length = 0;
      f.snapshotState(mismatch);
      await expect(f.input.snapshot(undefined, { query: "Subject" })).rejects.toThrow("Browser snapshot metadata");
      expect(f.calls.filter(call => call.args.snapshot_format).map(call => call.args.query)).toEqual(["Subject"]);
      await expect(f.input.act(old, { action: "click" }, "p17:1")).rejects.toThrow("stale");
      expect(mutations(f)).toEqual([]);
    }
    const f = fixture(), old = await f.input.snapshot();
    f.onCall((name, args) => { if (name === "get_browser_state" && args.snapshot_format) f.mutateWindow({ ownerNonce: "replacement-owner" }); });
    await expect(f.input.snapshot(undefined, { query: "Subject" })).rejects.toThrow("window changed");
    await expect(f.input.act(old, { action: "click" }, "p17:1")).rejects.toThrow("stale");
    expect(mutations(f)).toEqual([]);
  });

  test("one read-only retry preserves the query and cannot accept changed page identity", async () => {
    const f = fixture(), old = await f.input.snapshot(); f.calls.length = 0;
    f.page({ title: "Another page", url: "https://other.example/" });
    await expect(f.input.snapshot(undefined, { query: "Subject" })).rejects.toThrow("changed while observing");
    expect(f.calls.filter(call => call.args.snapshot_format).map(call => call.args.query)).toEqual(["Subject", "Subject"]);
    await expect(f.input.act(old, { action: "click" }, "p17:1")).rejects.toThrow("stale");
    expect(mutations(f)).toEqual([]);
  });

  test("an overlong query is rejected before any RPC and invalidates prior references", async () => {
    const f = fixture(), old = await f.input.snapshot(); f.calls.length = 0;
    await expect(f.input.snapshot(undefined, { query: "x".repeat(201) })).rejects.toThrow("at most 200");
    await expect(f.input.act(old, { action: "click" }, "p17:1")).rejects.toThrow("stale");
    expect(f.calls).toEqual([]);
    await f.input.snapshot(undefined, { query: "x".repeat(200) });
    expect(f.calls.find(call => call.args.snapshot_format)?.args.query).toBe("x".repeat(200));
  });

  test("canvas capture uses the native Cua screenshot pixel space and one explicit targeted foreground click",async()=>{
    const f=fixture(),page=await f.input.snapshot(),capture=await f.input.captureCanvas(page);
    expect(capture).toMatchObject({width:1000,height:800});
    expect(f.calls.find(c=>c.name==="get_window_state")?.args).toEqual({pid:90,window_id:1234,session:"account-test",include_screenshot:true,include_accessibility_tree:false,max_dimension:1280});
    await f.input.canvasAct(capture,{action:"canvas_click",delivery:"foreground",x:345,y:240});
    expect(mutations(f)).toEqual([{name:"click",args:{pid:90,window_id:1234,session:"account-test",delivery_mode:"foreground",button:"left",x:345,y:240}}]);
    await expect(f.input.canvasAct(capture,{action:"canvas_click",delivery:"foreground",x:345,y:240})).rejects.toThrow("stale");
  });

  test("canvas geometry, screenshot generation, tab, identity and revisions fail closed without any input",async()=>{
    for(const change of ["bounds","move","resize","nonce","tab","snapshot","correction","cancel","focus-tab"]){
      const f=fixture(),page=await f.input.snapshot(),capture=await f.input.captureCanvas(page),abort=new AbortController();let correction=false;
      if(change==="move")f.mutateWindow({rect:[20,1,1000,800]});
      if(change==="resize")f.mutateWindow({rect:[1,1,800,600]});
      if(change==="nonce")f.mutateWindow({ownerNonce:"0000000000009999"});
      if(change==="tab")f.tabs([{title:"Different",url:"https://other.test/",active:true}]);
      if(change==="snapshot")await f.input.snapshot();
      if(change==="cancel")abort.abort();
      if(change==="correction")f.onCall(name=>{if(name==="get_browser_state")correction=true;});
      if(change==="focus-tab")f.onFocus(()=>f.tabs([{title:"Different",url:"https://other.test/",active:true}]));
      await expect(f.input.canvasAct(capture,{action:"canvas_click",delivery:"foreground",x:change==="bounds"?1000:30,y:40},undefined,abort.signal,()=>{if(correction)throw new Error("task revised");})).rejects.toThrow();
      expect(mutations(f)).toEqual([]);
    }
  });

  test("canvas drag dispatches once, and failed or ambiguous native results consume the capture",async()=>{
    for(const fail of [false,true]){
      const f=fixture(),capture=await f.input.captureCanvas(await f.input.snapshot());
      if(fail)f.outcome({effect:"partial",delivery:{mode:"foreground"}});
      const promise=f.input.canvasAct(capture,{action:"canvas_drag",delivery:"foreground",x:30,y:40,to_x:240,to_y:300});
      if(fail)await expect(promise).rejects.toThrow("do not replay");else await promise;
      expect(mutations(f)).toEqual([{name:"drag",args:{pid:90,window_id:1234,session:"account-test",delivery_mode:"foreground",from_x:30,from_y:40,to_x:240,to_y:300,steps:16,duration_ms:320}}]);
      await expect(f.input.canvasAct(capture,{action:"canvas_drag",delivery:"foreground",x:30,y:40,to_x:240,to_y:300})).rejects.toThrow("stale");
    }
  });

  test("focused native text requires the actual focused editable ref, not a model assertion",async()=>{
    const f=fixture();let capture=await f.input.captureCanvas(await f.input.snapshot());
    await expect(f.input.canvasAct(capture,{action:"focused_text",delivery:"foreground",text:"Draft title"},"p17:2")).rejects.toThrow("currently focused");
    expect(mutations(f)).toEqual([]);f.focusedEditable();capture=await f.input.captureCanvas(await f.input.snapshot());
    await f.input.canvasAct(capture,{action:"focused_text",delivery:"foreground",text:"Draft title"},"p17:2");
    expect(mutations(f)).toEqual([{name:"type_text",args:{pid:90,window_id:1234,session:"account-test",delivery_mode:"foreground",text:"Draft title"}}]);
    expect(f.calls.at(-2)).toEqual({name:"get_browser_state",args:{target_id:capture.page.target_id,tab_id:capture.page.tab_id,session:"account-test",snapshot_format:"semantic_v2",scope_ref:"p17:2",include_screenshot:false}});
  });

  test("native text re-proves the exact scoped field after foreground focus and rejects ambiguous descendants", async () => {
    for (const change of ["focus", "name-duplicate", "hidden-root", "wrong-scope", "incomplete", "wrong-page", "correction"]) {
      const f = fixture(); f.focusedEditable();
      const capture = await f.input.captureCanvas(await f.input.snapshot()); let revised = false;
      f.onFocus(() => {
        if (change === "focus") f.focusedEditable(false);
        if (change === "name-duplicate") f.scope({ refs: [0, 1].map(i => ({ ref: `p18:${i}`, role: "textbox", name: "Subject", actions: ["type"], states: { focused: i === 1 } })) });
        if (["hidden-root", "wrong-scope", "incomplete"].includes(change)) f.scope({ snapshot: { id: "p18", format: "semantic_v2", scope: change === "wrong-scope" ? "viewport" : "subtree",
          complete: change !== "incomplete", selected_nodes: 1, total_nodes: 1, omitted: { css_hidden: change === "hidden-root" ? 1 : 0, page_occluded: 0 } } });
        if (change === "wrong-page") f.scope({ page: { title: "Inbox", url: "https://mail.example/different" } });
      });
      if (change === "correction") f.onCall((name, args) => { if (name === "get_browser_state" && args.scope_ref) revised = true; });
      await expect(f.input.canvasAct(capture, { action: "focused_text", delivery: "foreground", text: "Do not type" }, "p17:2", undefined,
        () => { if (revised) throw new Error("task revised"); })).rejects.toThrow();
      expect(mutations(f)).toEqual([]);
      await expect(f.input.canvasAct(capture, { action: "focused_text", delivery: "foreground", text: "Do not type" }, "p17:2")).rejects.toThrow("stale");
    }
  });

  test("native canvas refuses unknown capture geometry and a navigation race during capture",async()=>{
    for(const changed of [false,true]){
      const f=fixture(),page=await f.input.snapshot();
      if(changed)f.onCall(name=>{if(name==="get_window_state")f.tabs([{title:"Other",url:"https://other.test/",active:true}]);});else f.nativeSize(2560,1600);
      await expect(f.input.captureCanvas(page)).rejects.toThrow();expect(mutations(f)).toEqual([]);
    }
  });

  test("a PNG never authorizes canvas input when its native reply reports failure", async () => {
    for (const [state, isError] of [
      [{ status: "failed" }, false], [{ status: "pending" }, false], [{ effect: "refused" }, false],
      [{ status: "ok", effect: "partial" }, false], [{ effect: "suspected_noop" }, false], [{}, true],
    ] as [Record<string, unknown>, boolean][]) {
      const f = fixture(), page = await f.input.snapshot(), old = await f.input.captureCanvas(page);
      f.calls.length = 0; f.nativeOutcome(state, isError);
      await expect(f.input.captureCanvas(page)).rejects.toThrow("refused");
      await expect(f.input.canvasAct(old, { action: "canvas_click", delivery: "foreground", x: 20, y: 40 })).rejects.toThrow("stale");
      expect(f.calls.map(call => call.name)).toEqual(["get_window_state"]);
      expect(f.input.healthy()).toBe(true); // Ordinary failure is not an expired grant.
    }
  });

  test("native screenshot, pointer, text and key expiry invalidate bindings without retry or preparation", async () => {
    for (const method of ["get_window_state", "click", "drag", "type_text", "press_key", "hotkey"]) {
      for (const failure of [
        { message: "browser_consent_required: use browser_prepare", structured: false },
        { message: "Cua transport closed", structured: false },
        { message: "This Cua hand was disconnected", structured: false },
        { message: "Cua broker lease expired or disconnected", structured: false },
        { message: "confirmation provider failed: CDP window no longer has an exact geometry or singleton-cardinality correlation with the native window — refusing to mutate it", structured: false },
        { message: "browser_wrong_target_refused", structured: true },
        { message: "this session has ended; call start_session explicitly", structured: false },
        { message: "browser_requires_setup", structured: true },
        { message: "Cua transport closed", structured: true },
      ]) {
        const f = fixture(); f.focusedEditable();
        const page = await f.input.snapshot(), capture = await f.input.captureCanvas(page);
        f.calls.length = 0;
        if (failure.structured) {
          const state = { status: "failed", effect: "refused", code: failure.message };
          if (method === "get_window_state") f.nativeOutcome(state); else f.outcome(state);
        } else f.onCall(name => { if (name === method) throw new Error(failure.message); });
        const run = method === "get_window_state" ? () => f.input.captureCanvas(page)
          : method === "press_key" || method === "hotkey" ? () => f.input.act(page, { action: "key", key: method === "hotkey" ? "ctrl+a" : "enter", delivery: "foreground" })
          : () => f.input.canvasAct(capture, { action: method === "click" ? "canvas_click" : method === "drag" ? "canvas_drag" : "focused_text",
            delivery: "foreground", x: 30, y: 40, to_x: 200, to_y: 300, text: "Draft text" }, method === "type_text" ? "p17:2" : undefined);
        await expect(run()).rejects.toThrow();
        expect(f.input.healthy()).toBe(false);
        expect(f.calls.filter(call => call.name === method)).toHaveLength(1);
        expect(f.calls.some(call => ["start_session", "browser_prepare"].includes(call.name))).toBe(false);
        const count = f.calls.length;
        await expect(f.input.act(page, { action: "click" }, "p17:1")).rejects.toThrow("stale");
        await expect(f.input.canvasAct(capture, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 })).rejects.toThrow("stale");
        expect(f.calls).toHaveLength(count);
        f.onCall(() => {}); f.outcome({ status: "ok" }); f.nativeOutcome({});
        await f.input.attach();
        expect(f.input.healthy()).toBe(true);
      }
    }
  });

  test("a read racing navigation retries once without reconnecting or retaining old refs",async()=>{
    const f=fixture(),old=await f.input.snapshot();let reads=0;
    f.onCall((name,args)=>{if(name==="get_browser_state"&&args.target_id&&++reads===1){f.tabs([{title:"Sent Mail",url:"https://mail.google.com/#sent",active:true}]);f.mutateWindow({title:"Sent Mail - Google Chrome"});}});
    const fresh=await f.input.snapshot();expect(fresh.title).toBe("Sent Mail");expect(reads).toBe(2);expect(mutations(f)).toEqual([]);
    await expect(f.input.act(old,{action:"click"},"p17:1")).rejects.toThrow("stale");
  });

  test("a continuously changing page stops after two reads and never replays input",async()=>{
    const f=fixture();let reads=0;
    f.onCall((name,args)=>{if(name==="get_browser_state"&&args.target_id){reads++;f.tabs([{title:`Page ${reads}`,url:`https://example.com/${reads}`,active:true}]);}});
    await expect(f.input.snapshot()).rejects.toThrow("changed while observing");expect(reads).toBe(2);expect(mutations(f)).toEqual([]);
  });

  test("a dialog can be inspected after a timed-out input without repeating input or blocked DOM reads", async () => {
    const f = dialogFixture(), snapshot = await f.input.snapshot();
    f.onCall(name => { if (name === "browser_click") throw new Error("Runtime.callFunctionOn timed out after 20s"); });
    await expect(f.input.act(snapshot, { action: "click" }, "p17:1")).rejects.toThrow("timed out");
    const callsBefore = f.calls.length, observed = await f.input.inspectDialog();
    expect(observed).toMatchObject({ present: true, dialog_id: "dialog-7", kind: "alert", window: snapshot.window });
    expect(f.calls.slice(callsBefore)).toEqual([{ name: "browser_dialog", args: { target_id: "target-2", tab_id: "tab-2-0", action: "inspect", delivery_mode: "background", session: "account-test" } }]);
    await expect(f.input.act(snapshot, { action: "click" }, "p17:1")).rejects.toThrow("stale");
    expect(mutations(f).map(call => call.name)).toEqual(["browser_click"]);
  });

  test("dialog resolution re-attests the active tab and uses the exact inspected capability once", async () => {
    const f = dialogFixture(), snapshot = await f.input.snapshot(), observed = await f.input.inspectDialog();
    await expect(f.input.act(snapshot, { action: "click" }, "p17:1")).rejects.toThrow("stale");
    await f.input.resolveDialog(observed, "accept", "dialog-7");
    expect(mutations(f)).toEqual([{ name: "browser_dialog", args: { target_id: observed.target_id, tab_id: observed.tab_id, action: "accept", dialog_id: "dialog-7", delivery_mode: "background", session: "account-test" } }]);
    expect(f.calls.filter(call => call.name === "get_browser_state" && call.args.pid)).toHaveLength(2);
    await expect(f.input.resolveDialog(observed, "accept", "dialog-7")).rejects.toThrow("stale");
    expect(mutations(f)).toHaveLength(1);
    const refreshed = await f.input.snapshot();
    await f.input.act(refreshed, { action: "click" }, "p17:1");
  });

  test("inspection never automatically resolves any dialog kind", async () => {
    for (const kind of ["alert", "confirm", "prompt", "beforeunload", "other"]) {
      const f = dialogFixture(); f.dialog({ present: true, dialog_id: "dialog-7", kind });
      expect(await f.input.inspectDialog()).toMatchObject({ present: true, kind });
      expect(mutations(f)).toEqual([]);
    }
  });

  test("absent, stale, replaced or malformed dialog capabilities cannot be resolved", async () => {
    const f = dialogFixture(), old = await f.input.inspectDialog();
    await expect(f.input.resolveDialog(old, "dismiss", "wrong-id")).rejects.toThrow("id does not match");
    const fresh = await f.input.inspectDialog();
    await expect(f.input.resolveDialog(old, "dismiss", "dialog-7")).rejects.toThrow("stale");
    await f.input.snapshot();
    await expect(f.input.resolveDialog(fresh, "dismiss", "dialog-7")).rejects.toThrow("stale");
    f.dialog({ present: false }); const absent = await f.input.inspectDialog();
    await expect(f.input.resolveDialog(absent, "dismiss", "dialog-7")).rejects.toThrow("stale");
    for (const malformed of [{ present: true, kind: "alert" }, { present: true, kind: "permission", dialog_id: "dialog-7" },
      { present: true, kind: "alert", dialog_id: "dialog-7", tab_id: "another-tab" }, { present: "true", kind: "alert", dialog_id: "dialog-7" }]) {
      f.dialog(malformed); await expect(f.input.inspectDialog()).rejects.toThrow("exact bound tab");
    }
    expect(mutations(f)).toEqual([]);
  });

  test("dialog resolution rejects a changed native window, frame or active page before input", async () => {
    for (const change of [{ ownerNonce: "0000000000009999" }, { pid: 91 }, { title: "Another tab - Google Chrome" }, { rect: [1, 1, 1100, 800] as [number, number, number, number] }]) {
      const f = dialogFixture(), observed = await f.input.inspectDialog(); f.mutateWindow(change);
      await expect(f.input.resolveDialog(observed, "accept", "dialog-7")).rejects.toThrow("window changed");
      expect(mutations(f)).toEqual([]);
    }
    const f = dialogFixture(), observed = await f.input.inspectDialog();
    f.tabs([{ title: "Inbox", url: "https://other.example/", active: true }]);
    await expect(f.input.resolveDialog(observed, "dismiss", "dialog-7")).rejects.toThrow("active Chrome tab changed");
    expect(mutations(f)).toEqual([]);
  });

  test("cancellation or a correction during dialog revalidation consumes the inspection without input", async () => {
    const f = dialogFixture(), observed = await f.input.inspectDialog(), abort = new AbortController();
    f.onCall(name => { if (name === "get_browser_state") abort.abort(); });
    await expect(f.input.resolveDialog(observed, "dismiss", "dialog-7", abort.signal)).rejects.toThrow();
    expect(mutations(f)).toEqual([]);
    await expect(f.input.resolveDialog(observed, "dismiss", "dialog-7")).rejects.toThrow("stale");
    const g = dialogFixture(), dialog = await g.input.inspectDialog(); let checks = 0;
    await expect(g.input.resolveDialog(dialog, "accept", "dialog-7", undefined, () => { if (++checks === 2) throw new Error("instruction changed"); })).rejects.toThrow("instruction changed");
    expect(mutations(g)).toEqual([]);
  });

  test("dialog attestation failure has no raw-input fallback and failed resolution cannot replay", async () => {
    const f = dialogFixture(); await f.input.attach();
    f.onCall(name => { if (name === "browser_dialog") throw new Error("Page.getFrameTree timed out after 20s"); });
    await expect(f.input.inspectDialog()).rejects.toThrow("Exact-tab/URL attestation must succeed");
    expect(mutations(f)).toEqual([]);
    const g = dialogFixture(), observed = await g.input.inspectDialog();
    g.onCall((name, args) => { if (name === "browser_dialog" && args.action !== "inspect") throw new Error("resolution response lost"); });
    await expect(g.input.resolveDialog(observed, "accept", "dialog-7")).rejects.toThrow("response lost");
    await expect(g.input.resolveDialog(observed, "accept", "dialog-7")).rejects.toThrow("stale");
    expect(mutations(g).map(call => call.name)).toEqual(["browser_dialog"]);
  });

  test("mismatched dialog resolution response cannot authorize later actions", async () => {
    const f = dialogFixture(), observed = await f.input.inspectDialog();
    f.dialog({ present: true, dialog_id: "different-dialog", kind: "alert" });
    await expect(f.input.resolveDialog(observed, "accept", "dialog-7")).rejects.toThrow("did not confirm");
    await expect(f.input.resolveDialog(observed, "accept", "dialog-7")).rejects.toThrow("stale");
    expect(mutations(f)).toHaveLength(1);
  });

  test("phase timings distinguish native checks, bind, snapshot and input without retaining page data", async () => {
    const events: ExistingBrowserTiming[] = []; let clock = 0;
    const f = fixture({ timing: event => events.push(event), now: () => clock += 7 });
    f.tabs([{ title: "PRIVATE_TITLE", url: "https://example.test/?token=PRIVATE_URL", active: true }]);
    const snapshot = await f.input.snapshot();
    await f.input.act(snapshot, { action: "type", text: "PRIVATE_BODY" }, "p17:2");
    const completed = events.filter(event => event.event === "end");
    expect(new Set(completed.map(event => event.phase))).toEqual(new Set(["native_check", "bind_rpc", "snapshot_rpc", "action_rpc"]));
    expect(completed.every(event => event.durationMs === 7 && event.outcome === "ok")).toBe(true);
    expect(events.length).toBe(completed.length * 2);
    expect(events.filter(event => event.event === "start").map(event => event.sequence)).toEqual(completed.map(event => event.sequence));
    const serialized = JSON.stringify(events);
    for (const secret of ["PRIVATE", "example.test", "account-test", "p17:", "target-", "tab-"]) expect(serialized).not.toContain(secret);
    expect(Object.keys(completed[0]!).sort()).toEqual(["durationMs", "event", "outcome", "phase", "sequence"]);
  });

  test("failed and cancelled RPC timings contain no error text and do not replace the error", async () => {
    const events: ExistingBrowserTiming[] = [];
    const f = fixture({ timing: event => events.push(event) });
    f.onCall(() => { throw new Error("PRIVATE_ERROR_TEXT"); });
    await expect(f.input.snapshot()).rejects.toThrow("PRIVATE_ERROR_TEXT");
    expect(events.findLast(event => event.phase === "bind_rpc")?.outcome).toBe("failed");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_ERROR_TEXT");
    const abort = new AbortController(); const g = fixture({ timing: event => events.push(event) });
    g.onCall(() => abort.abort());
    await expect(g.input.snapshot(abort.signal)).rejects.toThrow();
    expect(events.findLast(event => event.phase === "bind_rpc")?.outcome).toBe("cancelled");
  });

  test("a failing timing consumer cannot prevent a verified input", async () => {
    const f = fixture({ timing: () => { throw new Error("diagnostic sink unavailable"); } });
    const snapshot = await f.input.snapshot();
    await f.input.act(snapshot, { action: "click" }, "p17:1");
    expect(mutations(f).map(call => call.name)).toEqual(["browser_click"]);
  });

  test("ended sessions become unhealthy without reviving or replaying input", async () => {
    const f = fixture();
    expect(f.input.healthy()).toBe(true);
    f.onCall(() => { throw new Error("this session has ended; call start_session explicitly to reuse its label"); });
    await expect(f.input.snapshot()).rejects.toThrow("session has ended");
    expect(f.input.healthy()).toBe(false);
    expect(f.calls.map(call => call.name)).toEqual(["get_browser_state"]);
  });

  test("definitive exact-binding loss clears readiness and capabilities without retry or preparation", async () => {
    const correlation = "confirmation provider failed: CDP window no longer has an exact geometry or singleton-cardinality correlation with the native window — refusing to mutate it";
    for (const failure of [correlation, "browser_binding_stale", "browser_wrong_target_refused", "browser_tab_not_found"]) {
      for (const envelope of ["throw", "structured"]) {
        const f = fixture(), page = await f.input.snapshot(), canvas = await f.input.captureCanvas(page);
        f.calls.length = 0;
        if (envelope === "throw") f.onCall(name => { if (name === "get_browser_state") throw new Error(failure); });
        else f.snapshotState({ status: "refused", code: failure });
        await expect(f.input.snapshot()).rejects.toThrow("binding is no longer exact");
        expect(f.input.healthy()).toBe(false);
        expect(f.calls.filter(call => call.name === "get_browser_state")).toHaveLength(envelope === "throw" ? 1 : 2);
        expect(mutations(f)).toEqual([]);
        const count = f.calls.length;
        await expect(f.input.act(page, { action: "click" }, "p17:1")).rejects.toThrow("stale");
        await expect(f.input.canvasAct(canvas, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 })).rejects.toThrow("stale");
        expect(f.calls).toHaveLength(count);
        f.onCall(() => {}); f.snapshotState({});
        await f.input.attach(undefined, { allowPrepare: false });
        expect(f.input.healthy()).toBe(true);
        expect(mutations(f)).toEqual([]);
      }
    }
  });

  test("binding-loss diagnostics report minimized only from native iconic metadata, not tiny dimensions", async () => {
    for (const iconic of [true, false, undefined]) {
      const f = fixture();
      f.mutateWindow({ iconic, rect: [0, 0, 219, 30] });
      f.onCall(() => { throw new Error("confirmation provider failed: CDP window no longer has an exact geometry or singleton-cardinality correlation with the native window — refusing to mutate it"); });
      let message = "";
      try { await f.input.snapshot(); } catch (error) { message = String(error); }
      expect(message.includes("this window is minimized")).toBe(iconic === true);
      expect(f.input.healthy()).toBe(false);
      expect(f.calls.map(call => call.name)).toEqual(["get_browser_state"]);
      expect(mutations(f)).toEqual([]);
    }
  });

  test("ordinary snapshot timeout and stale element refusal do not claim the connection or exact binding ended", async () => {
    for (const failure of ["CDP response timed out after 20s", "browser_ref_stale: the node disappeared"]) {
      const f = fixture(); await f.input.attach(); f.calls.length = 0;
      f.onCall((name, args) => { if (name === "get_browser_state" && args.target_id) throw new Error(failure); });
      await expect(f.input.snapshot()).rejects.toThrow(failure);
      expect(f.input.healthy()).toBe(true);
      expect(f.calls.map(call => call.name)).toEqual(["get_browser_state", "get_browser_state"]);
      expect(mutations(f)).toEqual([]);
    }
  });

  test("a later ambiguous bind or lost native owner invalidates a formerly ready connection", async () => {
    for (const failure of ["heuristic", "active-tab", "native-owner"]) {
      const f = fixture(); await f.input.attach();
      const page = await f.input.snapshot(), canvas = await f.input.captureCanvas(page); f.calls.length = 0;
      if (failure === "heuristic") f.heuristic();
      if (failure === "active-tab") f.tabs([{ title: "Inbox", url: "https://mail.example/", active: null }]);
      if (failure === "native-owner") f.mutateWindow({ ownerNonce: undefined });
      await expect(f.input.snapshot()).rejects.toThrow();
      expect(f.input.healthy()).toBe(false);
      const count = f.calls.length;
      await expect(f.input.act(page, { action: "click" }, "p17:1")).rejects.toThrow("stale");
      await expect(f.input.canvasAct(canvas, { action: "canvas_click", delivery: "foreground", x: 30, y: 40 })).rejects.toThrow("stale");
      expect(f.calls).toHaveLength(count); expect(mutations(f)).toEqual([]);
    }
  });

  test("expired browser consent invalidates ready state and only explicit attach restores it", async () => {
    const f = fixture(), before = await f.input.snapshot();
    f.outcome({status:"refused",code:"browser_consent_required",next_action:"browser_prepare"});
    await expect(f.input.act(before,{action:"click"},"p17:1")).rejects.toThrow("browser_consent_required");
    expect(f.input.healthy()).toBe(false);
    expect(f.calls.some(call=>call.name==="browser_prepare")).toBe(false);
    await expect(f.input.act(before,{action:"click"},"p17:1")).rejects.toThrow("stale");
    f.setup();f.outcome({status:"ok"});await f.input.attach();
    expect(f.input.healthy()).toBe(true);
    expect(f.calls.filter(call=>call.name==="browser_prepare")).toHaveLength(1);
  });

  test("only explicit attachment restarts a known-ended label and rebinds", async () => {
    const f = fixture(); let ended = true;
    f.onCall(name => {
      if (name === "start_session") ended = false;
      else if (ended) throw new Error("this session has ended; call start_session explicitly to reuse its label");
    });
    await expect(f.input.attach(undefined, { allowPrepare: false })).rejects.toThrow("session has ended");
    expect(f.calls.map(call => call.name)).toEqual(["get_browser_state"]);
    await f.input.attach();
    expect(f.calls.map(call => call.name)).toEqual(["get_browser_state", "get_browser_state", "start_session", "get_browser_state"]);
    expect(f.input.healthy()).toBe(true);
    expect(f.calls.some(call => call.name === "browser_prepare")).toBe(false);
  });

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

  test("attach retries one settling title or size read without preparing, focusing or retaining old refs", async () => {
    for (const allowPrepare of [false, true]) {
      for (const change of [{ title: "Inbox (1) - Google Chrome" }, { rect: [1, 1, 1100, 800] as [number, number, number, number] }]) {
        const f = fixture(), old = await f.input.snapshot(); let binds = 0;
        f.calls.length = 0;
        f.onCall((name, args) => { if (name === "get_browser_state" && args.pid && ++binds === 1) f.mutateWindow(change); });
        await f.input.attach(undefined, { allowPrepare });
        expect(f.calls.map(call => call.name)).toEqual(["get_browser_state", "get_browser_state"]);
        expect(f.calls.every(call => call.args.pid === 90 && call.args.window_id === 1234)).toBe(true);
        await expect(f.input.act(old, { action: "key", key: "Enter" })).rejects.toThrow("stale");
        expect(mutations(f)).toEqual([]);
      }
    }
  });

  test("attach stops after two unstable reads and never retries a lost owner or cancellation", async () => {
    const unstable = fixture(); let binds = 0;
    unstable.onCall((name, args) => { if (name === "get_browser_state" && args.pid) unstable.mutateWindow({ title: `Page ${++binds}` }); });
    await expect(unstable.input.attach()).rejects.toThrow("changed title or size");
    expect(unstable.calls.map(call => call.name)).toEqual(["get_browser_state", "get_browser_state"]);
    for (const change of [{ ownerNonce: "0000000000009999" }, { pid: 91 }, { containerId: 4567 }]) {
      const f = fixture();
      f.onCall(() => f.mutateWindow(change));
      await expect(f.input.attach()).rejects.toThrow("window changed");
      expect(f.calls.map(call => call.name)).toEqual(["get_browser_state"]);
    }
    const cancelled = fixture(), controller = new AbortController();
    cancelled.onCall(() => { cancelled.mutateWindow({ title: "New title" }); controller.abort(); });
    await expect(cancelled.input.attach(controller.signal)).rejects.toThrow();
    expect(cancelled.calls.map(call => call.name)).toEqual(["get_browser_state"]);
  });

  test("the attach retry cannot adopt a replacement owner between read attempts", async () => {
    for (const change of [{ ownerNonce: "0000000000009999" }, { pid: 91 }, { containerId: 4567 }]) {
      const f = fixture({ timing: event => {
        if (event.phase === "native_check" && event.event === "end" && event.outcome === "failed") f.mutateWindow(change);
      } });
      let binds = 0;
      f.onCall((name, args) => { if (name === "get_browser_state" && args.pid && ++binds === 1) f.mutateWindow({ title: "Inbox (1) - Google Chrome" }); });
      await expect(f.input.attach()).rejects.toThrow("window changed");
      expect(f.calls.map(call => call.name)).toEqual(["get_browser_state"]);
    }
  });

  test("a changed frame while validating a mutation never takes the attach retry path", async () => {
    const f = fixture(), observed = await f.input.snapshot(); f.calls.length = 0;
    f.onCall((name, args) => { if (name === "get_browser_state" && args.pid) f.mutateWindow({ title: "Changed during revalidation" }); });
    await expect(f.input.act(observed, { action: "click" }, "p17:1")).rejects.toThrow("changed title or size");
    expect(f.calls.map(call => call.name)).toEqual(["get_browser_state"]);
    expect(mutations(f)).toEqual([]);
  });

  test("foreground keys reveal only the observed owner and re-attest its tab before one exact-window dispatch", async () => {
    for (const [key, method, argument] of [[" Enter ", "press_key", { key: "enter" }], [" CTRL + L ", "hotkey", { keys: ["ctrl", "l"] }]] as const) {
      const f = fixture(), observed = await f.input.snapshot(); f.calls.length = 0;
      await f.input.act(observed, { action: "key", key, delivery: "foreground" });
      expect(f.calls.map(call => call.name)).toEqual(["get_browser_state", "focus_existing", "get_browser_state", method]);
      expect(f.calls[1]).toEqual({ name: "focus_existing", args: { pid: 90, window_id: 1234, ownerNonce: "0000000000000123" } });
      expect(mutations(f)).toEqual([{ name: method, args: { pid: 90, window_id: 1234, session: "account-test", delivery_mode: "foreground", ...argument } }]);
      await expect(f.input.act(observed, { action: "key", key, delivery: "foreground" })).rejects.toThrow("stale");
      expect(mutations(f)).toHaveLength(1);
    }
  });

  test("default and explicit background keys never focus or fall back after a refusal", async () => {
    for (const delivery of [undefined, "background"] as const) {
      const f = fixture(), observed = await f.input.snapshot(); f.calls.length = 0;
      f.onCall(name => { if (name === "hotkey") throw new Error('background_unavailable: use delivery_mode: "foreground"'); });
      await expect(f.input.act(observed, { action: "key", key: "Ctrl+P", delivery })).rejects.toThrow("background_unavailable");
      expect(f.calls.map(call => call.name)).toEqual(["get_browser_state", "hotkey"]);
      expect(mutations(f)).toEqual([{ name: "hotkey", args: { pid: 90, window_id: 1234, session: "account-test", keys: ["ctrl", "p"] } }]);
      await expect(f.input.act(observed, { action: "key", key: "Ctrl+P", delivery: "foreground" })).rejects.toThrow("stale");
      expect(mutations(f)).toHaveLength(1);
    }
  });

  test("foreground refuses tab or native-owner changes during focus without sending a key", async () => {
    for (const change of ["url", "title", "nonce", "pid", "window", "frame"]) {
      const f = fixture(), observed = await f.input.snapshot();
      f.onFocus(() => {
        if (change === "url" || change === "title") f.tabs([{ title: change === "title" ? "Different" : "Inbox", url: change === "url" ? "https://mail.example/#sent" : "https://mail.example/", active: true }]);
        if (change === "nonce") f.mutateWindow({ ownerNonce: "0000000000009999" });
        if (change === "pid") f.mutateWindow({ pid: 91 });
        if (change === "window") f.mutateWindow({ containerId: 4567 });
        if (change === "frame") f.mutateWindow({ rect: [1, 1, 1100, 800] });
      });
      await expect(f.input.act(observed, { action: "key", key: "Ctrl+P", delivery: "foreground" })).rejects.toThrow("changed");
      expect(mutations(f)).toEqual([]);
      await expect(f.input.act(observed, { action: "key", key: "Ctrl+P", delivery: "foreground" })).rejects.toThrow("stale");
      expect(f.calls.filter(call => call.name === "focus_existing")).toHaveLength(1);
    }
  });

  test("foreground rebind cannot replace the original owner after the post-focus native check", async () => {
    for (const change of [{ ownerNonce: "0000000000009999" }, { title: "New native title" }, { rect: [1, 1, 1100, 800] as [number, number, number, number] }]) {
      let focused = false, checks = 0;
      const f = fixture({ timing: event => {
        if (focused && event.phase === "native_check" && event.event === "end" && ++checks === 1) f.mutateWindow(change);
      } }), observed = await f.input.snapshot();
      f.onFocus(() => { focused = true; });
      await expect(f.input.act(observed, { action: "key", key: "Ctrl+P", delivery: "foreground" })).rejects.toThrow("changed");
      expect(mutations(f)).toEqual([]);
    }
  });

  test("correction, cancellation, or a newer observation during foreground focus cancels the pending key", async () => {
    for (const change of ["correction", "cancel", "observation"]) {
      const f = fixture(), observed = await f.input.snapshot(), abort = new AbortController(); let revised = false;
      f.onFocus(async () => {
        if (change === "cancel") abort.abort();
        if (change === "correction") revised = true;
        if (change === "observation") await f.input.snapshot();
      });
      await expect(f.input.act(observed, { action: "key", key: "Ctrl+P", delivery: "foreground" }, undefined, abort.signal,
        () => { if (revised) throw new Error("instruction changed"); })).rejects.toThrow();
      expect(mutations(f)).toEqual([]);
      await expect(f.input.act(observed, { action: "key", key: "Ctrl+P", delivery: "foreground" })).rejects.toThrow("stale");
    }
  });

  test("foreground input never dispatches without its reveal hook or replays a failed key", async () => {
    const unavailable = fixture({}, false), observed = await unavailable.input.snapshot();
    await expect(unavailable.input.act(observed, { action: "key", key: "Enter", delivery: "foreground" })).rejects.toThrow("unavailable");
    expect(mutations(unavailable)).toEqual([]);
    for (const failure of ["error-result", "timeout"]) {
      const f = fixture(), snapshot = await f.input.snapshot();
      if (failure === "error-result") f.outcome({ status: "refused" }, true);
      else f.onCall(name => { if (name === "press_key") throw new Error("key response timed out"); });
      await expect(f.input.act(snapshot, { action: "key", key: "Enter", delivery: "foreground" })).rejects.toThrow();
      await expect(f.input.act(snapshot, { action: "key", key: "Enter", delivery: "foreground" })).rejects.toThrow("stale");
      expect(mutations(f).map(call => call.name)).toEqual(["press_key"]);
      expect(f.calls.filter(call => call.name === "focus_existing")).toHaveLength(1);
    }
  });

  test("native keyboard structured failures cannot count as success even when isError is false", async () => {
    for (const delivery of ["background", "foreground"] as const) {
      for (const outcome of [
        { status: "refused" }, { status: "failed" },
        ...["refused", "failed", "partial", "suspected_noop", "unknown"].map(effect => ({ status: "ok", effect })),
        { effect: "confirmed", delivery: { mode: delivery === "foreground" ? "background" : "foreground" } },
      ]) {
        const f = fixture(), observed = await f.input.snapshot(); f.outcome(outcome);
        await expect(f.input.act(observed, { action: "key", key: "Enter", delivery })).rejects.toThrow("keyboard input");
        await expect(f.input.act(observed, { action: "key", key: "Enter", delivery })).rejects.toThrow("stale");
        expect(mutations(f).map(call => call.name)).toEqual(["press_key"]);
        expect(f.calls.filter(call => call.name === "focus_existing")).toHaveLength(delivery === "foreground" ? 1 : 0);
      }
      for (const effect of ["confirmed", "unverifiable"]) {
        const f = fixture(), observed = await f.input.snapshot(); f.outcome({ effect, delivery: { mode: delivery } });
        await f.input.act(observed, { action: "key", key: "Enter", delivery });
        expect(mutations(f).map(call => call.name)).toEqual(["press_key"]);
      }
    }
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
