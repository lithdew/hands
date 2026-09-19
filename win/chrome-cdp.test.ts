import { describe, expect, test } from "bun:test";
import { CHROME_CDP_LIMITS, ChromeCdpCommandError, connectChromeCdp, type ChromeCdpSocket } from "./chrome-cdp";

const endpoint = "ws://127.0.0.1:9222/devtools/browser/00000000-0000-0000-0000-000000000001";
class FakeSocket extends EventTarget implements ChromeCdpSocket {
  readyState = 0;
  closeCount = 0;
  sent: Record<string, unknown>[] = [];
  sendHook?: (message: Record<string, unknown>) => void;
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  send(data: string) { const message = JSON.parse(data); this.sent.push(message); this.sendHook?.(message); }
  close() { this.closeCount++; this.readyState = 3; this.dispatchEvent(new Event("close")); }
  remoteClose() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  fail() { this.dispatchEvent(new Event("error")); }
  receive(message: unknown) { this.raw(JSON.stringify(message)); }
  raw(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
  reply(index: number, result: Record<string, unknown> = {}) {
    const request = this.sent[index]!;
    this.receive({ id: request.id, ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }), result });
  }
}
async function fixture() {
  const socket = new FakeSocket();
  const opening = connectChromeCdp(endpoint, { socketFactory: () => socket });
  socket.open();
  return { socket, client: await opening };
}

describe("direct Chrome CDP transport", () => {
  test("only literal loopback browser endpoints reach the socket factory", async () => {
    for (const url of [
      "ws://localhost:9222/devtools/browser/a", "ws://127.1:9222/devtools/browser/a", "ws://2130706433:9222/devtools/browser/a",
      "ws://0177.0.0.1:9222/devtools/browser/a", "ws://127.0.0.2:9222/devtools/browser/a", "ws://[::ffff:127.0.0.1]:9222/devtools/browser/a",
      "wss://127.0.0.1:9222/devtools/browser/a", "ws://user@127.0.0.1:9222/devtools/browser/a", `${endpoint}?token=x`, `${endpoint}#x`,
      "ws://127.0.0.1:9222/devtools/page/a", "ws://127.0.0.1:9222/devtools/browser/../a", "ws://127.0.0.1:9222/devtools/browser/%61",
      "ws://127.0.0.1/devtools/browser/a", "ws://127.0.0.1:0/devtools/browser/a", "ws://127.0.0.1:65536/devtools/browser/a", `${endpoint}\n`,
    ]) {
      let created = 0;
      await expect(connectChromeCdp(url, { socketFactory: () => { created++; return new FakeSocket(); } })).rejects.toThrow("literal loopback");
      expect(created).toBe(0);
    }
    for (const url of [endpoint, "ws://[::1]:49152/devtools/browser/a_B-9"]) {
      const socket = new FakeSocket(); socket.readyState = 1;
      const client = await connectChromeCdp(url, { socketFactory: received => { expect(received).toBe(url); return socket; } });
      expect(client.isOpen()).toBe(true); client.close();
    }
  });

  test("multiplexes out-of-order responses and keeps session-tagged events independent", async () => {
    const { socket, client } = await fixture(), events: unknown[] = [];
    const remove = client.onEvent(event => events.push(event));
    const root = client.call<{ targetInfos: unknown[] }>("Target.getTargets");
    const child = client.call<{ nodes: unknown[] }>("Accessibility.getFullAXTree", {}, { sessionId: "frame-A" });
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1]).toMatchObject({ method: "Accessibility.getFullAXTree", params: {}, sessionId: "frame-A" });
    socket.receive({ method: "Page.frameNavigated", params: { frame: { id: "frame-B" } }, sessionId: "frame-B" });
    socket.reply(1, { nodes: [] }); expect(await child).toEqual({ nodes: [] });
    socket.reply(0, { targetInfos: [] }); expect(await root).toEqual({ targetInfos: [] });
    expect(events).toEqual([{ method: "Page.frameNavigated", params: { frame: { id: "frame-B" } }, sessionId: "frame-B" }]);
    remove(); socket.receive({ method: "Target.targetCreated", params: {} }); expect(events).toHaveLength(1);
    client.close();
  });

  test("a wrong-session response closes the connection and rejects every pending call", async () => {
    for (const sessionId of [undefined, "other-session"]) {
      const { socket, client } = await fixture();
      const a = client.call("DOM.getDocument", {}, { sessionId: "expected-session" });
      const b = client.call("Target.getTargets");
      const rejected = Promise.allSettled([a, b]);
      socket.receive({ id: socket.sent[0]!.id, ...(sessionId ? { sessionId } : {}), result: {} });
      expect((await rejected).every(result => result.status === "rejected")).toBe(true);
      expect(client.isOpen()).toBe(false); expect(socket.closeCount).toBe(1);
      await expect(client.call("Target.getTargets")).rejects.toThrow("not open"); expect(socket.sent).toHaveLength(2);
    }
  });

  test("CDP command errors reject only their matching call and preserve useful error codes", async () => {
    const { socket, client } = await fixture();
    const failed = client.call("DOM.resolveNode", { backendNodeId: 44 }, { sessionId: "page-A" });
    socket.receive({ id: socket.sent[0]!.id, sessionId: "page-A", error: { code: -32000, message: "Node is no longer attached", data: "not copied into error" } });
    try { await failed; throw new Error("expected failure"); } catch (error) {
      expect(error).toBeInstanceOf(ChromeCdpCommandError); expect((error as ChromeCdpCommandError).code).toBe(-32000);
      expect(String(error)).not.toContain("not copied");
    }
    expect(client.isOpen()).toBe(true);
    const next = client.call("Target.getTargets"); socket.reply(1); await next; client.close();
  });

  test("invalid and duplicate protocol messages fail closed without delivering content", async () => {
    for (const bad of [
      "{", "null", "[]", JSON.stringify({ id: 0, result: {} }), JSON.stringify({ id: "1", result: {} }),
      JSON.stringify({ id: 9007199254740991, result: {} }), JSON.stringify({ method: "Page.frameNavigated", params: [] }),
      JSON.stringify({ method: "Page.frameNavigated", params: {}, sessionId: 123 }), new Uint8Array([123, 125]),
    ]) {
      const { socket, client } = await fixture(); let delivered = 0; client.onEvent(() => delivered++);
      const request = client.call("Target.getTargets"); const settled = Promise.allSettled([request]);
      socket.raw(bad); expect((await settled)[0]?.status).toBe("rejected");
      expect(client.isOpen()).toBe(false); expect(delivered).toBe(0); expect(socket.closeCount).toBe(1);
    }
    for (const change of ["both", "neither", "bad-result", "bad-error", "method"]) {
      const { socket, client } = await fixture(); const request = client.call("Target.getTargets"); const settled = Promise.allSettled([request]);
      socket.receive({ id: socket.sent[0]!.id, ...(change === "both" ? { result: {}, error: { code: 1, message: "x" } }
        : change === "bad-result" ? { result: [] } : change === "bad-error" ? { error: { code: "x", message: "x" } }
        : change === "method" ? { method: "Page.frameNavigated", result: {} } : {}) });
      expect((await settled)[0]?.status).toBe("rejected"); expect(client.isOpen()).toBe(false);
    }
    const { socket, client } = await fixture(); const request = client.call("Target.getTargets"); socket.reply(0); await request;
    socket.reply(0); expect(client.isOpen()).toBe(false);
  });

  test("abort before dispatch sends nothing while abort after dispatch closes all pending work", async () => {
    const { socket, client } = await fixture(), before = new AbortController(); before.abort();
    await expect(client.call("Target.getTargets", {}, { signal: before.signal })).rejects.toThrow();
    expect(socket.sent).toHaveLength(0); expect(client.isOpen()).toBe(true);
    const after = new AbortController();
    const results = Promise.allSettled([client.call("Input.insertText", { text: "fixture only" }, { sessionId: "page-A", signal: after.signal }), client.call("Target.getTargets")]);
    after.abort();
    expect((await results).every(result => result.status === "rejected")).toBe(true);
    expect(socket.sent).toHaveLength(2); expect(socket.closeCount).toBe(1); expect(client.isOpen()).toBe(false);
    socket.reply(0); socket.reply(1); expect(socket.sent).toHaveLength(2);
  });

  test("a dispatched timeout closes instead of retrying and ignores late replies", async () => {
    const { socket, client } = await fixture();
    const results = await Promise.allSettled([client.call("Input.insertText", {}, { timeoutMs: 5 }), client.call("Target.getTargets")]);
    expect(results.every(result => result.status === "rejected" && String(result.reason).includes("outcome is unknown"))).toBe(true);
    expect(client.isOpen()).toBe(false); expect(socket.sent).toHaveLength(2); expect(socket.closeCount).toBe(1);
    socket.reply(0); expect(client.isOpen()).toBe(false);
  });

  test("connection timeout, cancellation, factory failure and early close settle without reconnect", async () => {
    const timeoutSocket = new FakeSocket();
    await expect(connectChromeCdp(endpoint, { timeoutMs: 5, socketFactory: () => timeoutSocket })).rejects.toThrow("before opening");
    expect(timeoutSocket.closeCount).toBe(1); expect(timeoutSocket.sent).toHaveLength(0);
    const controller = new AbortController(), socket = new FakeSocket();
    const opening = connectChromeCdp(endpoint, { signal: controller.signal, socketFactory: () => socket }); controller.abort();
    await expect(opening).rejects.toThrow("cancelled"); expect(socket.closeCount).toBe(1);
    let created = 0;
    await expect(connectChromeCdp(endpoint, { signal: controller.signal, socketFactory: () => { created++; return socket; } })).rejects.toThrow();
    expect(created).toBe(0);
    await expect(connectChromeCdp(endpoint, { socketFactory: () => { throw new Error("private endpoint detail"); } })).rejects.toThrow("creation failed");
    const early = new FakeSocket(); const waiting = connectChromeCdp(endpoint, { socketFactory: () => early }); early.remoteClose();
    await expect(waiting).rejects.toThrow("closed");
  });

  test("socket errors, send exceptions and owner close reject pending calls once", async () => {
    for (const kind of ["error", "remote-close", "send-throw", "owner-close"]) {
      const { socket, client } = await fixture();
      if (kind === "send-throw") socket.sendHook = () => { throw new Error("socket failed"); };
      const request = client.call("Target.getTargets"); const settled = Promise.allSettled([request]);
      if (kind === "error") socket.fail();
      if (kind === "remote-close") socket.remoteClose();
      if (kind === "owner-close") client.close();
      expect((await settled)[0]?.status).toBe("rejected"); client.close(); socket.fail();
      expect(socket.closeCount).toBe(1); expect(client.isOpen()).toBe(false); expect(socket.sent).toHaveLength(1);
    }
  });

  test("bounds reject excessive pending work and bytes without overflowing retained state", async () => {
    const { socket, client } = await fixture();
    const requests = Array.from({ length: CHROME_CDP_LIMITS.pendingCalls }, () => client.call("Target.getTargets"));
    const settled = Promise.allSettled(requests);
    await expect(client.call("Target.getTargets")).rejects.toThrow("pending request limit");
    expect(socket.sent).toHaveLength(CHROME_CDP_LIMITS.pendingCalls); expect(client.isOpen()).toBe(true);
    socket.sent.forEach((_, index) => socket.reply(index)); expect((await settled).every(result => result.status === "fulfilled")).toBe(true);
    await expect(client.call("Input.insertText", { text: "x".repeat(CHROME_CDP_LIMITS.requestBytes) })).rejects.toThrow("byte limit");
    const pending = client.call("Target.getTargets"), rejected = Promise.allSettled([pending]);
    socket.raw(" ".repeat(CHROME_CDP_LIMITS.messageBytes + 1)); expect((await rejected)[0]?.status).toBe("rejected");
    expect(client.isOpen()).toBe(false);
  });

  test("subscriber limits, removal and callback failures do not corrupt response routing", async () => {
    const { socket, client } = await fixture(); let events = 0;
    const removers = Array.from({ length: CHROME_CDP_LIMITS.eventListeners }, (_, index) => client.onEvent(() => { events++; if (index === 0) throw new Error("subscriber"); }));
    expect(() => client.onEvent(() => {})).toThrow("subscriber limit");
    socket.receive({ method: "Target.targetCreated" }); expect(events).toBe(CHROME_CDP_LIMITS.eventListeners);
    removers[0]!(); const remove = client.onEvent(() => {}); remove();
    const request = client.call("Target.getTargets"); socket.reply(0); await request; client.close();
    socket.receive({ method: "Target.targetCreated" }); expect(events).toBe(CHROME_CDP_LIMITS.eventListeners);
  });

  test("request IDs never repeat across errors or replacement connections and immediate replies are safe", async () => {
    const first = await fixture(); first.socket.sendHook = message => first.socket.receive({ id: message.id, result: {} });
    await first.client.call("Target.getTargets"); await first.client.call("Target.getTargets"); first.client.close();
    const second = await fixture(); second.socket.sendHook = message => second.socket.receive({ id: message.id, result: {} });
    await second.client.call("Target.getTargets"); second.client.close();
    const ids = [...first.socket.sent, ...second.socket.sent].map(message => message.id as number);
    expect(ids[0]! < ids[1]! && ids[1]! < ids[2]!).toBe(true); expect(new Set(ids).size).toBe(3);
  });

  test("invalid calls never dispatch and connecting cancellation does not become a lifetime signal", async () => {
    const socket = new FakeSocket(), connectionSignal = new AbortController();
    const opening = connectChromeCdp(endpoint, { signal: connectionSignal.signal, socketFactory: () => socket }); socket.open();
    const client = await opening; connectionSignal.abort(); expect(client.isOpen()).toBe(true);
    for (const timeoutMs of [0, -1, 1.5, Infinity, CHROME_CDP_LIMITS.maxTimeoutMs + 1]) {
      await expect(client.call("Target.getTargets", {}, { timeoutMs })).rejects.toThrow("timeout");
    }
    await expect(client.call("Target getTargets")).rejects.toThrow("Invalid");
    await expect(client.call("Target.getTargets", {}, { sessionId: "" })).rejects.toThrow("Invalid");
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    await expect(client.call("Target.getTargets", cycle)).rejects.toThrow("serializable");
    expect(socket.sent).toHaveLength(0); expect(client.isOpen()).toBe(true); client.close();
  });

  test("caller serializers cannot bypass cancellation, lifecycle, request shape or pending bounds", async () => {
    for (const kind of ["abort", "close", "shape"]) {
      const { socket, client } = await fixture(), controller = new AbortController();
      const params = { toJSON() {
        if (kind === "abort") controller.abort();
        if (kind === "close") client.close();
        return kind === "shape" ? [] : {};
      } };
      await expect(client.call("Target.getTargets", params, { signal: controller.signal })).rejects.toThrow();
      expect(socket.sent).toHaveLength(0); client.close();
    }
    const { socket, client } = await fixture(); let nested: Promise<unknown>[] = [];
    await expect(client.call("Target.getTargets", { toJSON() {
      nested = Array.from({ length: CHROME_CDP_LIMITS.pendingCalls }, () => client.call("Target.getTargets"));
      return {};
    } })).rejects.toThrow("pending request limit");
    const settled = Promise.allSettled(nested); expect(socket.sent).toHaveLength(CHROME_CDP_LIMITS.pendingCalls);
    socket.sent.forEach((_, index) => socket.reply(index)); await settled; client.close();
  });
});
