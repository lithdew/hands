import { describe, expect, test } from "bun:test";
import { chromeEndpoint, discoverChromeEndpoint, ownsChromeEndpoint, sameChromeOwner, type ChromeListener } from "./chrome-endpoint";
import type { NativeChromeMetadata } from "./chrome-native";

const listener: ChromeListener = { address: "127.0.0.1", port: 9222 };
const url = "ws://127.0.0.1:9222/devtools/browser/browser-fixture";
function native(listeners: NativeChromeMetadata["listeners"] = [listener]): NativeChromeMetadata {
  return { window_id: 1234, pid: 90, ownerNonce: "0000000000000123", app: "chrome", title: "Fixture - Google Chrome",
    processStartedAt: "2026-09-20T00:00:00.0000000Z", processStartTicks: "639254016000000000", focused: true, iconic: false,
    outerRect: [100, 100, 1200, 800], dpi: 144, dpiScale: 1.5, listeners };
}

describe("OS-owned Chrome endpoint discovery", () => {
  test("only the exact listener's browser socket is accepted", () => {
    expect(chromeEndpoint(listener, { webSocketDebuggerUrl: url })).toEqual({ ...listener, url });
    const ipv6: ChromeListener = { address: "::1", port: 9223 }, ipv6Url = "ws://[::1]:9223/devtools/browser/browser-fixture";
    expect(chromeEndpoint(ipv6, { webSocketDebuggerUrl: ipv6Url })).toEqual({ ...ipv6, url: ipv6Url });
    for (const candidate of [
      url.replace("9222", "9223"), url.replace("127.0.0.1", "localhost"), url.replace("127.0.0.1", "127.1"),
      url.replace("127.0.0.1", "192.168.1.2"), url.replace("ws:", "wss:"), url.replace("/browser/", "/page/"),
      url.replace("ws://", "ws://person@"), `${url}?token=private`, `${url}#fragment`, `${url}/../another`, `${url}%2f`,
    ]) expect(chromeEndpoint(listener, { webSocketDebuggerUrl: candidate })).toBeUndefined();
    for (const value of [undefined, null, [], {}, { webSocketDebuggerUrl: 5 }]) expect(chromeEndpoint(listener, value)).toBeUndefined();
  });

  test("discovery reads only observed process listeners and selects one verified endpoint", async () => {
    const listeners: ChromeListener[] = [listener, { address: "::1", port: 9223 }, { address: "127.0.0.1", port: 9000 }];
    const calls: ChromeListener[] = [];
    const endpoint = await discoverChromeEndpoint(native(listeners), undefined, async seen => {
      calls.push(seen);
      if (seen.port === 9000) throw new Error("not an HTTP service");
      return seen.port === 9222 ? { webSocketDebuggerUrl: url } : { webSocketDebuggerUrl: url.replace("9222", "9333") };
    });
    expect(endpoint).toEqual({ ...listener, url }); expect(calls).toEqual(listeners);
    expect(ownsChromeEndpoint(native(), endpoint)).toBe(true);
    expect(ownsChromeEndpoint(native([]), endpoint)).toBe(false);
    expect(ownsChromeEndpoint(native([{ address: "::1", port: 9222 }]), endpoint)).toBe(false);
  });

  test("zero or multiple available debugging endpoints fail without guessing or opening setup", async () => {
    let calls = 0;
    await expect(discoverChromeEndpoint(native([]), undefined, async () => { calls++; return {}; })).rejects.toThrow("no available");
    expect(calls).toBe(0);
    await expect(discoverChromeEndpoint(native(), undefined, async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/not-browser" }))).rejects.toThrow("no available");
    const two: ChromeListener[] = [listener, { address: "127.0.0.1", port: 9223 }];
    await expect(discoverChromeEndpoint(native(two), undefined, async seen => ({ webSocketDebuggerUrl: `ws://${seen.address}:${seen.port}/devtools/browser/fixture` }))).rejects.toThrow("Multiple");
  });

  test("listener count and cancellation are bounded before returning any endpoint", async () => {
    let calls = 0;
    await expect(discoverChromeEndpoint(native(Array.from({ length: 33 }, (_, i) => ({ address: "127.0.0.1", port: 10000+i }))), undefined,
      async () => { calls++; return {}; })).rejects.toThrow("Too many");
    expect(calls).toBe(0);
    const controller = new AbortController(); controller.abort();
    await expect(discoverChromeEndpoint(native(), controller.signal, async () => { calls++; return { webSocketDebuggerUrl: url }; })).rejects.toThrow();
    expect(calls).toBe(0);
    const during = new AbortController();
    await expect(discoverChromeEndpoint(native(), during.signal, async (_seen, signal) => {
      expect(signal).toBe(during.signal); during.abort(); return { webSocketDebuggerUrl: url };
    })).rejects.toThrow();
  });

  test("owner identity includes process lifetime and HWND lifetime, not title or geometry guesses", () => {
    const before = native();
    expect(sameChromeOwner(before, { ...before, title: "A renamed tab", outerRect: [0, 0, 1600, 900] })).toBe(true);
    for (const change of [{ pid: 91 }, { window_id: 1235 }, { ownerNonce: "0000000000000124" }, { processStartTicks: "639254016000000001" }]) {
      expect(sameChromeOwner(before, { ...before, ...change })).toBe(false);
    }
  });
});
