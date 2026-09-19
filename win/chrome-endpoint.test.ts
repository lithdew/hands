import { describe, expect, test } from "bun:test";
import { chromeEndpoint, chromeRendezvousEndpoint, discoverChromeEndpoint, ownsChromeEndpoint, sameChromeOwner, type ChromeListener } from "./chrome-endpoint";
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

  test("two-line rendezvous metadata only constructs a socket on its uniquely owned listener", () => {
    for (const text of ["9222\n/devtools/browser/browser-fixture", "9222\n/devtools/browser/browser-fixture\n", "9222\r\n/devtools/browser/browser-fixture\r\n"]) {
      expect(chromeRendezvousEndpoint(native(), text)).toEqual({ ...listener, url });
    }
    expect(chromeRendezvousEndpoint(native([{ address: "::1", port: 9222 }]), "9222\n/devtools/browser/browser-fixture"))
      .toEqual({ address: "::1", port: 9222, url: "ws://[::1]:9222/devtools/browser/browser-fixture" });
    expect(chromeRendezvousEndpoint(native([]), "9222\n/devtools/browser/browser-fixture")).toBeUndefined();
    expect(chromeRendezvousEndpoint(native([{ address: "127.0.0.1", port: 9333 }]), "9222\n/devtools/browser/browser-fixture")).toBeUndefined();
    expect(chromeRendezvousEndpoint(native([listener, { address: "::1", port: 9222 }]), "9222\n/devtools/browser/browser-fixture")).toBeUndefined();
  });

  test("malformed, oversized or redirected rendezvous metadata cannot create an endpoint", () => {
    const path = "/devtools/browser/browser-fixture";
    for (const text of [
      "", "9222", path, `9222\n${path}\nextra`, `9222\n${url}`, `9222\n//127.0.0.1:9222${path}`, `9222\n/devtools/page/fixture`,
      `9222\n${path}?token=x`, `9222\n${path}#x`, `9222\n${path}/../other`, `9222\n/devtools/browser/%66ixture`,
      `9222\n/devtools/browser/${"x".repeat(129)}`, `9222\n${path}\0`, `9222\n${path}\n${"x".repeat(4096)}`,
      `0\n${path}`, `65536\n${path}`, `-9222\n${path}`, `9.222e3\n${path}`, `9222.0\n${path}`, `9333\n${path}`,
    ]) expect(chromeRendezvousEndpoint(native(), text)).toBeUndefined();
  });

  test("rendezvous fallback is opt-in and runs only after zero valid HTTP discoveries", async () => {
    const order: string[] = [];
    const endpoint = await discoverChromeEndpoint(native(), undefined, async seen => { order.push(`http:${seen.port}`); throw new Error("fixture HTTP 404"); },
      async () => { order.push("rendezvous"); return "9222\n/devtools/browser/browser-fixture\n"; });
    expect(endpoint).toEqual({ ...listener, url }); expect(order).toEqual(["http:9222", "rendezvous"]);
    let fileReads = 0;
    expect(await discoverChromeEndpoint(native(), undefined, async () => ({ webSocketDebuggerUrl: url }),
      async () => { fileReads++; return "9222\n/devtools/browser/other"; })).toEqual({ ...listener, url });
    expect(fileReads).toBe(0);
    await expect(discoverChromeEndpoint(native([listener, { address: "127.0.0.1", port: 9223 }]), undefined,
      async seen => ({ webSocketDebuggerUrl: `ws://${seen.address}:${seen.port}/devtools/browser/fixture` }),
      async () => { fileReads++; return "9222\n/devtools/browser/browser-fixture"; })).rejects.toThrow("Multiple");
    expect(fileReads).toBe(0);
    await expect(discoverChromeEndpoint(native(), undefined, async () => ({}))).rejects.toThrow("no available");
  });

  test("missing or stale rendezvous data and cancellation never return an unverified fallback", async () => {
    for (const contents of [undefined, "", "9333\n/devtools/browser/stale", "9222\n/devtools/page/not-browser"]) {
      await expect(discoverChromeEndpoint(native(), undefined, async () => ({}), async () => contents)).rejects.toThrow("no available");
    }
    let reads = 0; const before = new AbortController(); before.abort();
    await expect(discoverChromeEndpoint(native(), before.signal, async () => { reads++; return {}; }, async () => { reads++; return undefined; })).rejects.toThrow();
    expect(reads).toBe(0);
    const during = new AbortController();
    await expect(discoverChromeEndpoint(native(), during.signal, async () => ({}), async () => {
      during.abort(); return "9222\n/devtools/browser/browser-fixture";
    })).rejects.toThrow();
  });
});
