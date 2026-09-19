import { describe, expect, test } from "bun:test";
import { chromeBoundsMatch, directChromeBrowser } from "./chrome-browser";
import type { ChromeCdp, ChromeCdpCallOptions, ChromeCdpEvent } from "./chrome-cdp";
import type { NativeChromeMetadata } from "./chrome-native";
import { collectorFunction, verifierFunction, verifyFocusFunction, type ChromeDocument, type ChromeObservation } from "./chrome-observation";
import type { ExistingBrowserWindow } from "./browser";

type Target = { targetId: string; type: string; title: string; url: string; windowId: number };
type Call = { method: string; params: Record<string, unknown>; sessionId?: string };
function deferred() {
  let resolve!: () => void, reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error("offline operation remained blocked by a dialog")), 250); })]); }
  finally { clearTimeout(timer); }
}
function fixture() {
  let window: ExistingBrowserWindow = { pid: 90, containerId: 1234, ownerNonce: "0000000000000123", title: "Inbox - Google Chrome", rect: [100, 100, 1200, 800] };
  let native: NativeChromeMetadata = { window_id: 1234, pid: 90, ownerNonce: "0000000000000123", app: "chrome", title: window.title,
    processStartedAt: "2026-09-20T00:00:00.0000000Z", processStartTicks: "639254016000000000", focused: true, iconic: false,
    outerRect: [100, 100, 1200, 800], dpi: 96, dpiScale: 1, listeners: [{ address: "127.0.0.1", port: 9222 }] };
  let targets: Target[] = [{ targetId: "page-A", type: "page", title: "Inbox", url: "https://mail.example.test/#inbox", windowId: 10 }];
  const bounds = new Map<number, Record<string, unknown>>([[10, { left: 100, top: 100, width: 1200, height: 800, windowState: "normal" }]]);
  let loader = "loader-A", frameId = "frame-A", collectorPatch: Partial<ChromeDocument> = {}, verificationFailure = "", focused = true;
  let targetInfoPatch: Partial<Target> = {}, protectedField = false, pixel = 0;
  let onCall: ((call: Call) => void | Promise<void>) | undefined;
  let onProbe: (() => void | Promise<void>) | undefined;
  const calls: Call[] = [], connections: MockCdp[] = [], discoveries: NativeChromeMetadata[] = [];
  const document = (target: Target): ChromeDocument => ({ url: target.url, urlTruncated: false, title: target.title, titleTruncated: false,
    visibility: "visible", hasFocus: true, viewport: { width: 1200, height: 700, devicePixelRatio: 1, scale: 1, offsetLeft: 0, offsetTop: 0 },
    scroll: { x: 0, y: 0 }, coordinateSpace: "css-viewport", ...collectorPatch });
  class MockCdp implements ChromeCdp {
    open = true; closeCount = 0; index = connections.length; sessionSequence = 0;
    sessions = new Map<string, string>(); events = new Set<(event: ChromeCdpEvent) => void>();
    isOpen() { return this.open; }
    close() { this.open = false; this.closeCount++; this.events.clear(); }
    onEvent(cb: (event: ChromeCdpEvent) => void) { this.events.add(cb); return () => this.events.delete(cb); }
    emit(event: ChromeCdpEvent) { for (const cb of [...this.events]) cb(event); }
    async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, options: ChromeCdpCallOptions = {}): Promise<T> {
      if (!this.open) throw new Error("fixture connection closed"); options.signal?.throwIfAborted();
      const call = { method, params, sessionId: options.sessionId }; calls.push(call); await onCall?.(call);
      const targetId = options.sessionId ? this.sessions.get(options.sessionId) : String(params.targetId ?? targets[0]?.targetId);
      if (options.sessionId && !targetId) throw new Error("fixture session belongs to another connection");
      const target = targets.find(t => t.targetId === targetId);
      let value: unknown;
      if (method === "Target.getTargets") value = { targetInfos: targets.map(({ windowId: _, ...t }) => ({ ...t })) };
      else if (method === "Browser.getWindowForTarget") {
        if (!target) throw new Error("No target with given id"); value = { windowId: target.windowId, bounds: bounds.get(target.windowId) };
      } else if (method === "Target.getTargetInfo") {
        if (!target) throw new Error("No target with given id"); value = { targetInfo: { ...target, ...targetInfoPatch } };
      } else if (method === "Target.attachToTarget") {
        if (!target) throw new Error("No target with given id"); const sessionId = `connection-${this.index}-session-${++this.sessionSequence}`;
        this.sessions.set(sessionId, target.targetId); value = { sessionId };
      } else if (method === "Target.detachFromTarget") { this.sessions.delete(String(params.sessionId)); value = {}; }
      else if (method === "Page.enable" || method === "Emulation.setFocusEmulationEnabled") value = {};
      else if (method === "Page.getFrameTree") value = { frameTree: { frame: { id: frameId, loaderId: loader, url: target!.url } } };
      else if (method === "Page.createIsolatedWorld") value = { executionContextId: 100 + this.index };
      else if (method === "Runtime.callFunctionOn") {
        const argument = (params.arguments as { value: { nonce: string; ref?: string; token?: string; checkFocus?: boolean } }[])[0]!.value;
        if (params.functionDeclaration === collectorFunction) {
          const observation: ChromeObservation = { nonce: argument.nonce, document: document(target!), texts: ["Fixture draft"],
            elements: [
              { ref: "ref-subject", role: "textbox", name: "Subject", nameTruncated: false, within: "Compose", rect: { x: 40, y: 80, width: 300, height: 30 },
                center: { x: 190, y: 95 }, focused, editable: !protectedField, protected: protectedField, type: "text", value: protectedField ? undefined : "Old subject", valueTruncated: false, actions: protectedField ? [] : ["click", "type", "key"] },
              { ref: "ref-send", role: "button", name: "Send", nameTruncated: false, within: "Compose", rect: { x: 40, y: 240, width: 80, height: 30 },
                center: { x: 80, y: 255 }, focused: false, editable: false, protected: false, type: "button", valueTruncated: false, actions: ["click"] },
            ], coverage: { elementsTruncated: false, textsTruncated: false, scannedControls: 2, returnedNodes: 2, framesOmitted: 0, shadowDOM: "not-traversed", hiddenDocument: false } };
          value = { result: { value: observation } };
        } else if (params.functionDeclaration === verifierFunction || params.functionDeclaration === verifyFocusFunction) {
          value = { result: { value: verificationFailure ? { ok: false, reason: verificationFailure } : { ok: true, nonce: argument.nonce, ref: argument.ref,
            token: "verified-fixture-token", document: document(target!), center: argument.ref === "ref-send" ? { x: 80, y: 255 } : { x: 190, y: 95 }, focused, editable: argument.ref === "ref-subject" } } };
        } else if (params.functionDeclaration === "function(){return document.visibilityState === 'visible'}") {
          value = { result: { value: document(target!).visibility === "visible" } };
        } else if (params.functionDeclaration === "function(){return {title:document.title,url:document.URL,visibility:document.visibilityState}}") {
          const observed = document(target!); value = { result: { value: {title:observed.title,url:observed.url,visibility:observed.visibility} } };
        } else throw new Error("unexpected observation function");
      } else if (method === "Page.captureScreenshot") {
        const png = Buffer.alloc(25); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(1200,16); png.writeUInt32BE(700,20); png[24] = pixel;
        value = { data: png.toString("base64") };
      } else if (method === "Page.getLayoutMetrics") value = { cssVisualViewport: { clientWidth: 1200, clientHeight: 700 } };
      else if (method.startsWith("Input.") || ["Page.navigate", "Page.handleJavaScriptDialog"].includes(method)) value = {};
      else throw new Error(`Unexpected direct CDP method ${method}`);
      return value as T;
    }
  }
  const input = directChromeBrowser({
    current: async () => ({ ...window, rect: [...window.rect] }),
    probe: async () => { await onProbe?.(); return { ...native, outerRect: [...native.outerRect], listeners: native.listeners.map(l => ({ ...l })) }; },
    discover: async metadata => { discoveries.push(metadata); return { address: "127.0.0.1", port: 9222, url: "ws://127.0.0.1:9222/devtools/browser/fixture" }; },
    connect: async () => { const connection = new MockCdp(); connections.push(connection); return connection; },
  });
  return { input, calls, connections, discoveries, native: () => native,
    minimize: () => { window = {...window,iconic:true,rect:[-32000,-32000,219,30]}; native = {...native,iconic:true,outerRect:[-32000,-32000,219,30]}; bounds.set(10,{windowState:"minimized"});collectorPatch={visibility:"hidden"}; },
    window: (change: Partial<ExistingBrowserWindow>) => { window = { ...window, ...change }; },
    metadata: (change: Partial<NativeChromeMetadata>) => { native = { ...native, ...change }; },
    targets: (value: Target[]) => { targets = value; }, bounds: (id: number, value: Record<string, unknown>) => bounds.set(id, value),
    loader: (value: string) => { loader = value; }, frame: (value: string) => { frameId = value; },
    document: (patch: Partial<ChromeDocument>) => { collectorPatch = patch; }, targetInfo: (patch: Partial<Target>) => { targetInfoPatch = patch; },
    pixel: (value: number) => { pixel = value; },
    verifierFailure: (reason: string) => { verificationFailure = reason; }, focused: (value: boolean) => { focused = value; },
    protected: () => { protectedField = true; }, onCall: (fn: typeof onCall) => { onCall = fn; }, onProbe: (fn: typeof onProbe) => { onProbe = fn; },
    inputs: () => calls.filter(c => c.method.startsWith("Input.") || ["Page.navigate", "Page.handleJavaScriptDialog"].includes(c.method)),
  };
}

describe("direct signed-in Chrome adapter (offline)", () => {
  test("a captured fixture reference routes typing and clicking through the attested isolated document", async () => {
    const f = fixture(); await f.input.attach(); const page = await f.input.snapshot();
    expect(page.refs.find(r => r.ref === "ref-subject")?.value).toBe("Old subject");
    await f.input.act(page, { action: "type", text: "Fixture subject", replace: true }, "ref-subject");
    expect(f.inputs().map(c => c.method)).toEqual(["Input.dispatchKeyEvent", "Input.dispatchKeyEvent", "Input.insertText"]);
    expect(f.inputs().at(-1)?.params).toEqual({ text: "Fixture subject" });
    expect(new Set(f.inputs().map(c => c.sessionId))).toEqual(new Set(["connection-0-session-1"]));
    const next = await f.input.snapshot(); await f.input.act(next, { action: "click" }, "ref-send");
    expect(f.inputs().slice(-2).map(c => c.params)).toEqual([
      { type: "mousePressed", x: 80, y: 255, button: "left", clickCount: 1 },
      { type: "mouseReleased", x: 80, y: 255, button: "left", clickCount: 1 },
    ]);
    const functions = f.calls.filter(c => c.method === "Runtime.callFunctionOn");
    expect(functions.every(c => c.params.executionContextId === 100 && !Object.hasOwn(c.params, "objectId"))).toBe(true);
    expect(f.calls.every(c => /^[A-Z][A-Za-z]+\.[a-zA-Z]+$/.test(c.method))).toBe(true);
    await f.input.close();
  });

  test("geometry accepts a single physical or DPI-scaled native match and refuses ambiguous windows", async () => {
    const f = fixture();
    expect(chromeBoundsMatch(f.native(), { left: 100, top: 100, width: 1200, height: 800 })).toBe(true);
    expect(chromeBoundsMatch({ ...f.native(), dpi: 192, dpiScale: 2 }, { left: 50, top: 50, width: 600, height: 400 })).toBe(true);
    for (const bounds of [{ left: 110, top: 100, width: 1200, height: 800 }, { left: 100, top: 100, width: 1200, height: 800, windowState: "minimized" }, { width: 1200 }]) {
      expect(chromeBoundsMatch(f.native(), bounds)).toBe(false);
    }
    f.targets([{ targetId: "page-A", type: "page", title: "Inbox", url: "https://mail.example.test/#inbox", windowId: 10 },
      { targetId: "page-B", type: "page", title: "Other", url: "https://other.example.test/", windowId: 11 }]);
    f.bounds(11, { left: 100, top: 100, width: 1200, height: 800 });
    await expect(f.input.attach()).rejects.toThrow("ambiguous geometry"); expect(f.inputs()).toEqual([]); expect(f.input.healthy()).toBe(false);
  });

  test("same-title replacement targets, wrong response identities and changed document loaders cannot receive old input", async () => {
    for (const change of ["replacement", "response-target", "response-type", "loader", "frame"]) {
      const f = fixture(); await f.input.attach(); const page = await f.input.snapshot(); f.calls.length = 0;
      if (change === "replacement") f.targets([{ targetId: "page-B", type: "page", title: "Inbox", url: page.url, windowId: 10 }]);
      if (change === "response-target") f.targetInfo({ targetId: "page-B" });
      if (change === "response-type") f.targetInfo({ type: "service_worker" });
      if (change === "loader") f.loader("loader-B");
      if (change === "frame") f.frame("frame-B");
      await expect(f.input.act(page, { action: "click" }, "ref-send")).rejects.toThrow(); expect(f.inputs()).toEqual([]);
      const count = f.calls.length; await expect(f.input.act(page, { action: "click" }, "ref-send")).rejects.toThrow("expired"); expect(f.calls).toHaveLength(count);
      await f.input.close();
    }
  });

  test("unverified document URLs and truncated identity never mint actionable snapshot references", async () => {
    for (const patch of [{ url: "https://other.example.test/" }, { urlTruncated: true }, { titleTruncated: true }, { visibility: "hidden" as const }]) {
      const f = fixture(); await f.input.attach(); f.document(patch);
      await expect(f.input.snapshot()).rejects.toThrow(); expect(f.inputs()).toEqual([]); await f.input.close();
    }
  });

  test("a stale form or failed focus verifier sends no insertion and never retries a consumed reference", async () => {
    for (const failure of ["document changed", "form values changed", "reference detached"]) {
      const f = fixture(); await f.input.attach(); const page = await f.input.snapshot(); f.verifierFailure(failure);
      await expect(f.input.act(page, { action: "type", text: "fixture" }, "ref-subject")).rejects.toThrow(failure);
      expect(f.inputs()).toEqual([]);
      expect(f.input.healthy()).toBe(true); // A changed form does not end a valid browser attachment.
      await expect(f.input.act(page, { action: "type", text: "fixture" }, "ref-subject")).rejects.toThrow("expired"); await f.input.close();
    }
    const f = fixture(); await f.input.attach(); const page = await f.input.snapshot();
    f.onCall(c => { if (c.method === "Runtime.callFunctionOn" && c.params.functionDeclaration === verifyFocusFunction) f.verifierFailure("focus changed"); });
    await expect(f.input.act(page, { action: "type", text: "fixture" }, "ref-subject")).rejects.toThrow("focus changed");
    expect(f.inputs()).toEqual([]); await f.input.close();
  });

  test("the consumed form proof is checked after the final attestation awaits, before any click", async () => {
    const f = fixture(); await f.input.attach(); const page = await f.input.snapshot(); let attestations = 0;
    f.onCall(c => { if (c.method === "Target.getTargetInfo" && ++attestations === 2) f.verifierFailure("form changed during attestation"); });
    await expect(f.input.act(page, { action: "click" }, "ref-send")).rejects.toThrow("form changed during attestation");
    expect(f.inputs()).toEqual([]);
    const proof = f.calls.filter(c => c.method === "Runtime.callFunctionOn").at(-1)!;
    expect(proof.params.functionDeclaration).toBe(verifyFocusFunction);
    expect((proof.params.arguments as {value:unknown}[])[0]!.value).toMatchObject({ ref: "ref-send", token: "verified-fixture-token", checkFocus: false });
    await f.input.close();
  });

  test("successful actions are one-use and cancellation or a correction before dispatch sends no input", async () => {
    const f = fixture(); await f.input.attach(); const page = await f.input.snapshot(); await f.input.act(page, { action: "click" }, "ref-send");
    const count = f.calls.length; await expect(f.input.act(page, { action: "click" }, "ref-send")).rejects.toThrow("expired"); expect(f.calls).toHaveLength(count); await f.input.close();
    for (const stage of ["before", "verify", "correction"]) {
      const x = fixture(); await x.input.attach(); const observed = await x.input.snapshot(), controller = new AbortController(); x.calls.length = 0;
      if (stage === "before") controller.abort();
      if (stage === "verify") x.onCall(c => { if (c.method === "Runtime.callFunctionOn" && c.params.functionDeclaration === verifierFunction) controller.abort(); });
      await expect(x.input.act(observed, { action: "click" }, "ref-send", controller.signal, () => { if (stage === "correction") throw new Error("instruction revision changed"); })).rejects.toThrow();
      expect(x.inputs()).toEqual([]); await expect(x.input.act(observed, { action: "click" }, "ref-send")).rejects.toThrow("expired"); await x.input.close();
    }
  });

  test("semantic canvas capture keeps its exact capability identity and consumes it after one click", async () => {
    const f = fixture(); await f.input.attach(); const page = await f.input.snapshot(), image = await f.input.captureCanvas(page);
    await f.input.assertCanvasCurrent(image); expect(f.inputs()).toEqual([]);
    await f.input.canvasAct(image, { action: "canvas_click", delivery: "foreground", x: 20, y: 30 });
    expect(f.inputs().map(c => c.params.type)).toEqual(["mousePressed", "mouseReleased"]);
    await expect(f.input.canvasAct(image, { action: "canvas_click", delivery: "foreground", x: 20, y: 30 })).rejects.toThrow("stale"); await f.input.close();
  });

  test("changed pixels during final canvas preparation cannot receive an old approved coordinate", async () => {
    const f = fixture(); await f.input.attach(); const image = await f.input.captureVisual();
    f.onCall(c => { if (c.method === "Page.getLayoutMetrics") f.pixel(1); });
    await expect(f.input.canvasAct(image, { action: "canvas_click", delivery: "foreground", x: 20, y: 30 })).rejects.toThrow();
    expect(f.inputs()).toEqual([]);
    await expect(f.input.canvasAct(image, { action: "canvas_click", delivery: "foreground", x: 20, y: 30 })).rejects.toThrow("stale");
    await f.input.close();
  });

  test("new top-level document events revoke old refs while unrelated child or session events do not", async () => {
    for (const event of [
      { method: "Page.frameNavigated", params: { frame: { id: "frame-A" } }, sessionId: "connection-0-session-1" },
      { method: "Page.javascriptDialogOpening", params: { type: "alert" }, sessionId: "connection-0-session-1" },
    ]) {
      const f = fixture(); await f.input.attach(); const page = await f.input.snapshot(); f.connections[0]!.emit(event); f.calls.length = 0;
      await expect(f.input.act(page, { action: "click" }, "ref-send")).rejects.toThrow("expired"); expect(f.calls).toHaveLength(0); await f.input.close();
    }
    const f = fixture(); await f.input.attach(); const page = await f.input.snapshot();
    f.connections[0]!.emit({ method: "Page.frameNavigated", params: { frame: { id: "child", parentId: "frame-A" } }, sessionId: "connection-0-session-1" });
    f.connections[0]!.emit({ method: "Page.frameNavigated", params: { frame: { id: "other" } }, sessionId: "unrelated-session" });
    await f.input.act(page, { action: "click" }, "ref-send"); expect(f.inputs()).toHaveLength(2); await f.input.close();
  });

  test("explicit reattachment closes the old socket and creates a new session instead of reusing its capability", async () => {
    const f = fixture(); await f.input.attach(); const old = await f.input.snapshot(); await f.input.attach();
    expect(f.connections).toHaveLength(2); expect(f.connections[0]!.isOpen()).toBe(false); expect(f.connections[0]!.closeCount).toBe(1);
    expect(f.connections[1]!.sessions.has("connection-1-session-1")).toBe(true);
    await expect(f.input.act(old, { action: "click" }, "ref-send")).rejects.toThrow("expired");
    const page = await f.input.snapshot(); await f.input.act(page, { action: "click" }, "ref-send");
    expect(f.inputs().every(c => c.sessionId === "connection-1-session-1")).toBe(true); await f.input.close();
  });

  test("startup restoration cannot discover or open a socket without explicit attachment", async () => {
    const f = fixture();
    await expect(f.input.attach(undefined, { allowPrepare: false })).rejects.toThrow();
    expect(f.discoveries).toHaveLength(0); expect(f.connections).toHaveLength(0); expect(f.inputs()).toEqual([]);
    await f.input.attach(); expect(f.input.healthy()).toBe(true); await f.input.close();
  });

  test("an observed page dialog resolves once through its original session without paused DOM evaluation", async () => {
    const f = fixture(); await f.input.attach();
    f.connections[0]!.emit({ method: "Page.javascriptDialogOpening", params: { type: "alert" }, sessionId: "connection-0-session-1" });
    const observed = await f.input.inspectDialog(); expect(observed.present).toBe(true);
    if (!observed.present) throw new Error("fixture dialog missing");
    f.calls.length = 0;
    await f.input.resolveDialog(observed, "accept", observed.dialog_id);
    expect(f.inputs()).toEqual([{ method: "Page.handleJavaScriptDialog", params: { accept: true }, sessionId: "connection-0-session-1" }]);
    expect(f.calls.some(c => c.method === "Runtime.callFunctionOn")).toBe(false);
    await expect(f.input.resolveDialog(observed, "accept", observed.dialog_id)).rejects.toThrow();
    expect(f.inputs()).toHaveLength(1); await f.input.close();
  });

  test("a dialog event during initial Page.enable is retained before the first binding finishes", async () => {
    const f = fixture();
    f.onCall(c => { if (c.method === "Page.enable") f.connections[0]!.emit({ method: "Page.javascriptDialogOpening", params: { type: "alert" }, sessionId: c.sessionId }); });
    await f.input.attach();
    const dialog = await f.input.inspectDialog(); expect(dialog.present).toBe(true);
    await expect(f.input.snapshot()).rejects.toThrow("page dialog");
    expect(f.calls.some(c => c.method === "Runtime.callFunctionOn" && c.params.functionDeclaration === collectorFunction)).toBe(false);
    expect(f.inputs()).toEqual([]); await f.input.close();
  });

  test("a mouse-release confirm yields the operation, drains its original reply once, and never replays the click", async () => {
    const f = fixture(); await f.input.attach(); const page = await f.input.snapshot(), reply = deferred(); let opened = false;
    f.onCall(async c => {
      if (c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseReleased" && !opened) {
        opened = true; f.connections[0]!.emit({ method: "Page.javascriptDialogOpening", params: { type: "confirm" }, sessionId: c.sessionId });
        await reply.promise;
      }
      if (c.method === "Page.handleJavaScriptDialog") { f.connections[0]!.emit({ method: "Page.javascriptDialogClosed", params: {}, sessionId: c.sessionId }); reply.resolve(); }
    });
    try {
      await bounded(f.input.act(page, { action: "click" }, "ref-send"));
      expect(f.inputs().map(c => c.params.type)).toEqual(["mousePressed", "mouseReleased"]);
      expect(f.input.activity().active).toBeUndefined();
      const inspected = await bounded(f.input.inspectDialog()); expect(inspected.present).toBe(true);
      if (!inspected.present) throw new Error("missing fixture confirm"); expect(inspected.kind).toBe("confirm");
      await bounded(f.input.resolveDialog(inspected, "dismiss", inspected.dialog_id));
      expect(f.inputs().filter(c => c.method === "Page.handleJavaScriptDialog").map(c => c.params)).toEqual([{ accept: false }]);
      await expect(f.input.act(page, { action: "click" }, "ref-send")).rejects.toThrow("expired");
      expect(f.inputs().filter(c => c.method === "Input.dispatchMouseEvent")).toHaveLength(2);
      expect(f.input.healthy()).toBe(true);
      const after = await bounded(f.input.inspectDialog()); expect(after.present).toBe(false);
    } finally { reply.resolve(); await f.input.close(); }
  });

  test("a press-triggered dialog defers exactly one release until the original press acknowledgment completes", async () => {
    const f = fixture(); await f.input.attach(); const page = await f.input.snapshot(), reply = deferred(); let opened = false;
    f.onCall(async c => {
      if (c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed" && !opened) {
        opened = true; f.connections[0]!.emit({ method: "Page.javascriptDialogOpening", params: { type: "alert" }, sessionId: c.sessionId }); await reply.promise;
      }
      if (c.method === "Page.handleJavaScriptDialog") { f.connections[0]!.emit({ method: "Page.javascriptDialogClosed", params: {}, sessionId: c.sessionId }); reply.resolve(); }
    });
    try {
      await bounded(f.input.act(page, { action: "click" }, "ref-send"));
      expect(f.inputs().map(c => c.params.type)).toEqual(["mousePressed"]);
      const inspected = await f.input.inspectDialog(); if (!inspected.present) throw new Error("missing fixture alert");
      await bounded(f.input.resolveDialog(inspected, "accept", inspected.dialog_id));
      expect(f.inputs().map(c => c.method === "Input.dispatchMouseEvent" ? c.params.type : c.method)).toEqual(["mousePressed", "Page.handleJavaScriptDialog", "mouseReleased"]);
      const after = await f.input.inspectDialog(); expect(after.present).toBe(false); expect(f.input.healthy()).toBe(true);
    } finally { reply.resolve(); await f.input.close(); }
  });

  test("a late pending-release transport timeout marks the attachment unhealthy without replay or resolution input", async () => {
    const f = fixture(); await f.input.attach(); const page = await f.input.snapshot(), reply = deferred();
    f.onCall(async c => {
      if (c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseReleased") {
        f.connections[0]!.emit({ method: "Page.javascriptDialogOpening", params: { type: "confirm" }, sessionId: c.sessionId }); await reply.promise;
      }
    });
    await bounded(f.input.act(page, { action: "click" }, "ref-send"));
    const inspected = await f.input.inspectDialog(); if (!inspected.present) throw new Error("missing fixture confirm");
    // chrome-cdp.test.ts separately proves timeout closes the real transport.
    // Here emulate its delayed closed/rejected result after the public act returned.
    f.connections[0]!.close(); reply.reject(new Error("CDP request timed out after dispatch; command outcome is unknown"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.input.healthy()).toBe(false);
    await expect(f.input.resolveDialog(inspected, "accept", inspected.dialog_id)).rejects.toThrow();
    expect(f.inputs().map(c => c.params.type)).toEqual(["mousePressed", "mouseReleased"]);
    await f.input.close();
  });

  test("cancelling dialog resolution cannot accept a confirm or replay its pending click", async () => {
    const f = fixture(); await f.input.attach(); const page = await f.input.snapshot(), reply = deferred(); let opened = false;
    f.onCall(async c => {
      if (c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseReleased" && !opened) {
        opened = true; f.connections[0]!.emit({ method: "Page.javascriptDialogOpening", params: { type: "confirm" }, sessionId: c.sessionId }); await reply.promise;
      }
      if (c.method === "Page.handleJavaScriptDialog") { f.connections[0]!.emit({ method: "Page.javascriptDialogClosed", params: {}, sessionId: c.sessionId }); reply.resolve(); }
    });
    try {
      await bounded(f.input.act(page, { action: "click" }, "ref-send"));
      const inspected = await f.input.inspectDialog(); if (!inspected.present) throw new Error("missing fixture confirm");
      const controller = new AbortController(); controller.abort();
      await expect(f.input.resolveDialog(inspected, "accept", inspected.dialog_id, controller.signal)).rejects.toThrow();
      expect(f.inputs().filter(c => c.method === "Page.handleJavaScriptDialog")).toHaveLength(0);
      const fresh = await f.input.inspectDialog(); if (!fresh.present) throw new Error("fixture confirm disappeared");
      await bounded(f.input.resolveDialog(fresh, "dismiss", fresh.dialog_id));
      expect(f.inputs().filter(c => c.method === "Input.dispatchMouseEvent")).toHaveLength(2);
      expect(f.inputs().filter(c => c.method === "Page.handleJavaScriptDialog")).toHaveLength(1);
    } finally { reply.resolve(); await f.input.close(); }
  });

  test("a second synchronous confirm yields again while the same release acknowledgment remains pending", async () => {
    const f = fixture(); await f.input.attach(); const page = await f.input.snapshot(), reply = deferred(); let opened = false, resolutions = 0;
    f.onCall(async c => {
      if (c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseReleased" && !opened) {
        opened = true; f.connections[0]!.emit({ method: "Page.javascriptDialogOpening", params: { type: "confirm" }, sessionId: c.sessionId }); await reply.promise;
      }
      if (c.method === "Page.handleJavaScriptDialog") {
        f.connections[0]!.emit({ method: "Page.javascriptDialogClosed", params: {}, sessionId: c.sessionId });
        if (++resolutions === 1) f.connections[0]!.emit({ method: "Page.javascriptDialogOpening", params: { type: "confirm" }, sessionId: c.sessionId });
        else reply.resolve();
      }
    });
    try {
      await bounded(f.input.act(page, { action: "click" }, "ref-send"));
      const first = await f.input.inspectDialog(); if (!first.present) throw new Error("missing first fixture confirm");
      await bounded(f.input.resolveDialog(first, "accept", first.dialog_id));
      const second = await bounded(f.input.inspectDialog()); if (!second.present) throw new Error("missing second fixture confirm");
      expect(second.dialog_id).not.toBe(first.dialog_id);
      await bounded(f.input.resolveDialog(second, "dismiss", second.dialog_id));
      expect(f.inputs().filter(c => c.method === "Input.dispatchMouseEvent")).toHaveLength(2);
      expect(f.inputs().filter(c => c.method === "Page.handleJavaScriptDialog")).toHaveLength(2);
      expect(f.input.healthy()).toBe(true);
    } finally { reply.resolve(); await f.input.close(); }
  });

  test("a user-closed dialog clears the completed release acknowledgment without requiring a nonexistent resolution", async () => {
    for (const trigger of ["mousePressed", "mouseReleased"]) {
    const f = fixture(); await f.input.attach(); const page = await f.input.snapshot(), reply = deferred(); let opened = false;
    f.onCall(async c => {
      if (c.method === "Input.dispatchMouseEvent" && c.params.type === trigger && !opened) {
        opened = true; f.connections[0]!.emit({ method: "Page.javascriptDialogOpening", params: { type: "confirm" }, sessionId: c.sessionId }); await reply.promise;
      }
    });
    try {
      await bounded(f.input.act(page, { action: "click" }, "ref-send"));
      f.connections[0]!.emit({ method: "Page.javascriptDialogClosed", params: {}, sessionId: "connection-0-session-1" }); reply.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
      const after = await f.input.inspectDialog(); expect(after.present).toBe(false);
      const fresh = await f.input.snapshot(); await bounded(f.input.act(fresh, { action: "click" }, "ref-send"));
      expect(f.inputs().filter(c => c.method === "Input.dispatchMouseEvent").map(c => c.params.type)).toEqual(["mousePressed", "mouseReleased", "mousePressed", "mouseReleased"]);
      expect(f.inputs().some(c => c.method === "Page.handleJavaScriptDialog")).toBe(false);
    } finally { reply.resolve(); await f.input.close(); }
    }
  });

  test("native PID lifetime, HWND owner, endpoint, movement and minimized changes block old observations", async () => {
    for (const change of ["lifetime", "owner", "endpoint", "move", "minimized"]) {
      const f = fixture(); await f.input.attach(); const page = await f.input.snapshot();
      if (change === "lifetime") f.metadata({ processStartTicks: "639254016000000001" });
      if (change === "owner") { f.window({ ownerNonce: "0000000000000124" }); f.metadata({ ownerNonce: "0000000000000124" }); }
      if (change === "endpoint") f.metadata({ listeners: [] });
      if (change === "move") { f.window({ rect: [101, 100, 1200, 800] }); f.metadata({ outerRect: [101, 100, 1200, 800] }); }
      if (change === "minimized") f.minimize();
      await expect(f.input.act(page, { action: "click" }, "ref-send")).rejects.toThrow(); expect(f.inputs()).toEqual([]);
      if (change !== "move" && change !== "minimized") expect(f.input.healthy()).toBe(false);
      await f.input.close();
    }
  });

  test("preview preserves semantic and canvas capabilities and never binds, collects controls or dispatches input", async () => {
    for (const mode of ["semantic", "canvas"]) {
      const f=fixture();await f.input.attach();const page=await f.input.snapshot();
      const canvas=mode==="canvas"?await f.input.captureCanvas(page):undefined;f.calls.length=0;
      const preview=await f.input.preview!();
      expect(preview).toMatchObject({width:1200,height:700,window:{pid:90,containerId:1234,iconic:false},image:{mimeType:"image/png"}});
      expect(f.calls.some(c=>["Target.attachToTarget","Target.detachFromTarget","Page.createIsolatedWorld","Emulation.setFocusEmulationEnabled"].includes(c.method))).toBe(false);
      expect(f.calls.some(c=>c.params.functionDeclaration===collectorFunction)).toBe(false);expect(f.inputs()).toEqual([]);
      if(canvas)await f.input.canvasAct(canvas,{action:"canvas_click",delivery:"foreground",x:20,y:30});
      else await f.input.act(page,{action:"click"},"ref-send");
      expect(f.inputs()).toHaveLength(2);await f.input.close();
    }
  });

  test("minimized preview requires a prior exact bind and preserves actual viewport and native dimensions separately", async () => {
    const fresh=fixture();fresh.minimize();await expect(fresh.input.attach()).rejects.toThrow("first exact attachment");
    expect(fresh.connections).toHaveLength(0);expect(fresh.discoveries).toHaveLength(0);
    const f=fixture();await f.input.attach();f.minimize();
    const preview=await f.input.preview!();expect(preview.window.rect).toEqual([-32000,-32000,219,30]);
    expect(preview.window.iconic).toBe(true);expect([preview.width,preview.height]).toEqual([1200,700]);
    await f.input.attach();expect(f.connections).toHaveLength(1);expect(f.discoveries).toHaveLength(1);
    await expect(f.input.snapshot()).rejects.toThrow("Restore this Chrome window to resume input");
    expect(f.input.healthy()).toBe(true);expect(f.inputs()).toEqual([]);await f.input.preview!();await f.input.close();
  });

  test("DWM frame and native outer bounds are validated independently instead of being confused as the same coordinates", async () => {
    const f=fixture();f.window({rect:[108,100,1184,792]});await f.input.attach();
    expect((await f.input.preview!()).window.rect).toEqual([108,100,1184,792]);await f.input.snapshot();await f.input.close();
  });

  test("preview refuses replaced or ambiguous tabs, changed frames and lost endpoint ownership without input", async () => {
    for(const change of ["window","duplicate","replacement","frame","lifetime","endpoint"]){
      const f=fixture();await f.input.attach();f.minimize();
      if(change==="window")f.targets([{targetId:"page-A",type:"page",title:"Inbox",url:"https://mail.example.test/#inbox",windowId:11}]);
      if(change==="duplicate")f.targets([{targetId:"page-A",type:"page",title:"Inbox",url:"https://mail.example.test/#inbox",windowId:10},{targetId:"page-B",type:"page",title:"Inbox",url:"https://mail.example.test/#inbox",windowId:10}]);
      if(change==="replacement")f.targets([{targetId:"page-B",type:"page",title:"Inbox",url:"https://mail.example.test/#inbox",windowId:10}]);
      if(change==="frame")f.frame("new-frame");
      if(change==="lifetime")f.metadata({processStartTicks:"639254016000000001"});
      if(change==="endpoint")f.metadata({listeners:[]});
      await expect(f.input.preview!()).rejects.toThrow();expect(f.inputs()).toEqual([]);
      if(change==="lifetime"||change==="endpoint")expect(f.input.healthy()).toBe(false);
      await f.input.close();
    }
  });

  test("a busy, cancelled or failed preview never revokes a pending semantic action", async () => {
    for(const mode of ["busy","cancelled","capture-failed"]){
      const f=fixture();await f.input.attach();const page=await f.input.snapshot();
      if(mode==="busy"){
        const arrived=deferred(),release=deferred();f.onCall(async c=>{if(c.method==="Page.captureScreenshot"){arrived.resolve();await release.promise;}});
        const preview=f.input.preview!();await arrived.promise;const count=f.calls.length;
        await expect(f.input.preview!()).rejects.toThrow("busy");expect(f.calls).toHaveLength(count);release.resolve();await preview;
      }else if(mode==="cancelled"){
        const aborted=new AbortController();aborted.abort();await expect(f.input.preview!(aborted.signal)).rejects.toThrow();
      }else{
        f.onCall(c=>{if(c.method==="Page.captureScreenshot")throw new Error("fixture screenshot unavailable");});
        await expect(f.input.preview!()).rejects.toThrow("screenshot unavailable");
      }
      f.onCall(undefined);await f.input.act(page,{action:"click"},"ref-send");expect(f.inputs()).toHaveLength(2);await f.input.close();
    }
  });

  test("preview requires stable native state through capture and hidden preview is restricted to a verified iconic window", async () => {
    const f=fixture();await f.input.attach();f.document({visibility:"hidden"});await expect(f.input.preview!()).rejects.toThrow("no longer the selected tab");
    f.minimize();f.onCall(c=>{if(c.method==="Page.captureScreenshot"){f.window({iconic:false,rect:[100,100,1200,800]});f.metadata({iconic:false,outerRect:[100,100,1200,800]});}});
    await expect(f.input.preview!()).rejects.toThrow("changed after observation");expect(f.inputs()).toEqual([]);await f.input.close();
  });

  test("a task waits for one in-flight preview and wins priority over new previews without queueing other tasks", async () => {
    const f=fixture();await f.input.attach();const arrived=deferred(),release=deferred();
    f.onCall(async c=>{if(c.method==="Page.captureScreenshot"){arrived.resolve();await release.promise;}});
    const preview=f.input.preview!();await arrived.promise;const task=f.input.snapshot();
    await expect(f.input.snapshot()).rejects.toThrow("already in progress");
    await expect(f.input.preview!()).rejects.toThrow("busy");release.resolve();
    const [image,page]=await Promise.all([preview,task]);expect(image.width).toBe(1200);expect(page.refs).toHaveLength(2);
    f.onCall(undefined);await f.input.act(page,{action:"click"},"ref-send");expect(f.inputs()).toHaveLength(2);await f.input.close();
  });

  test("renderer focus emulation is scoped to the exact attached session and reset on detach and close without OS focus", async () => {
    const f=fixture();f.document({visibility:"hidden"});
    f.onCall(c=>{if(c.method==="Emulation.setFocusEmulationEnabled"&&c.params.enabled===true)f.document({visibility:"visible"});});
    await f.input.attach();await f.input.snapshot();
    expect(f.calls.filter(c=>c.method==="Emulation.setFocusEmulationEnabled").map(c=>c.params.enabled)).toEqual([true]);
    f.targets([{targetId:"page-B",type:"page",title:"Inbox",url:"https://mail.example.test/#inbox",windowId:10}]);await f.input.snapshot();
    const emulation=f.calls.filter(c=>c.method==="Emulation.setFocusEmulationEnabled");expect(emulation.map(c=>c.params.enabled)).toEqual([true,false,true]);
    expect(emulation[1]?.sessionId).toBe("connection-0-session-1");expect(emulation[2]?.sessionId).toBe("connection-0-session-2");
    expect(f.inputs()).toEqual([]);expect(f.calls.some(c=>c.method==="Page.bringToFront"||c.method==="Target.activateTarget")).toBe(false);
    await f.input.close();expect(f.calls.at(-1)?.params).toEqual({enabled:false});
  });

  test("focus emulation cannot make a same-title inactive target actionable and identity diagnostics contain no page content", async () => {
    const f=fixture();await f.input.attach();const page=await f.input.snapshot();
    f.targets([{targetId:"page-A",type:"page",title:"Inbox",url:page.url,windowId:10},{targetId:"page-B",type:"page",title:"Inbox",url:page.url,windowId:10}]);
    await expect(f.input.act(page,{action:"click"},"ref-send")).rejects.toThrow("uniquely identify");expect(f.inputs()).toEqual([]);await f.input.close();
    const x=fixture();await x.input.attach();x.document({visibility:"hidden"});
    await expect(x.input.snapshot()).rejects.toThrow("visibility=hidden, titleMatch=true, urlMatch=true, identityTruncated=false");await x.input.close();
  });
});
