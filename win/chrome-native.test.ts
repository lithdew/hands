import { describe, expect, test } from "bun:test";
import { parseChromeNativeMetadata, probeChromeNative, type ChromeNativeOwner } from "./chrome-native";

const owner: ChromeNativeOwner = { window_id: 901, pid: 82, ownerNonce: "0000000000000901" };
const started = "2026-09-20T00:00:00.0000000Z";
const metadata = () => ({ ...owner, app: "chrome" as const, title: "Fixture - Google Chrome", focused: false, iconic: false,
  processStartedAt: started, processStartTicks: String(BigInt(Date.parse(started)) * 10000n + 621355968000000000n),
  outerRect: [-8, -8, 2576, 1616] as [number, number, number, number], dpi: 144, dpiScale: 1.5,
  listeners: [{ address: "127.0.0.1" as const, port: 9222 }, { address: "::1" as const, port: 9222 }] });

describe("native Chrome endpoint metadata", () => {
  test("preserves real outer geometry, process identity, native focus and both exact loopback addresses", () => {
    const source = metadata(), result = parseChromeNativeMetadata(JSON.stringify(source), owner);
    expect(result).toEqual(source);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.outerRect)).toBe(true);
    expect(Object.isFrozen(result.listeners)).toBe(true);
    expect(Object.isFrozen(result.listeners[0])).toBe(true);
    source.outerRect[2] = 219;
    expect(result.outerRect[2]).toBe(2576);
    const noListener = { ...metadata(), listeners: [], iconic: true, outerRect: [-32000, -32000, 219, 30] as [number, number, number, number] };
    expect(parseChromeNativeMetadata(JSON.stringify(noListener), owner)).toEqual(noListener);
  });

  test("rejects changed HWND/PID/nonce, wrong process and malformed native geometry or process time", () => {
    for (const change of [
      { window_id: 902 }, { pid: 83 }, { ownerNonce: "0000000000000001" }, { app: "msedge" }, { title: "" }, { title: "x".repeat(513) },
      { focused: "true" }, { iconic: undefined }, { outerRect: [0, 0, 0, 200] }, { outerRect: [0, 0, 219] },
      { outerRect: [0, 0, 200.5, 200] }, { outerRect: [Number.MAX_SAFE_INTEGER, 0, 200, 200] },
      { dpi: 0 }, { dpiScale: 1 }, { processStartedAt: "2026-09-20T00:00:00Z" }, { processStartedAt: "2026-13-20T00:00:00.0000000Z" },
      { processStartTicks: "1" }, { processStartTicks: 638939232000000000 }, { processStartTicks: "9999999999999999999" },
    ]) expect(() => parseChromeNativeMetadata(JSON.stringify({ ...metadata(), ...change }), owner)).toThrow();
    expect(() => parseChromeNativeMetadata("null", owner)).toThrow();
    expect(() => parseChromeNativeMetadata("not JSON", owner)).toThrow();
    expect(() => parseChromeNativeMetadata(" ".repeat(16385), owner)).toThrow("bound");
  });

  test("rejects wildcard/remote/mapped listeners, invalid ports, duplicates and unbounded lists", () => {
    for (const listeners of [
      [{ address: "0.0.0.0", port: 9222 }], [{ address: "::", port: 9222 }], [{ address: "::ffff:127.0.0.1", port: 9222 }],
      [{ address: "127.0.0.2", port: 9222 }], [{ address: "localhost", port: 9222 }], [{ address: "192.168.1.1", port: 9222 }],
      [{ address: "127.0.0.1", port: 0 }], [{ address: "127.0.0.1", port: 65536 }], [{ address: "127.0.0.1", port: "9222" }],
      [{ address: "127.0.0.1", port: 9222 }, { address: "127.0.0.1", port: 9222 }],
      Array.from({ length: 33 }, (_, i) => ({ address: "127.0.0.1", port: 9000 + i })), null,
    ]) expect(() => parseChromeNativeMetadata(JSON.stringify({ ...metadata(), listeners }), owner)).toThrow();
  });

  test("one passive probe addresses the exact reservation and cannot relabel an in-flight reply", async () => {
    const requests: string[] = [], pending = Promise.withResolvers<string>();
    const selected = { ...owner };
    const result = probeChromeNative(async request => { requests.push(request); return pending.promise; }, { display: "Puk hand 1" }, selected);
    selected.window_id = 902;
    pending.resolve(JSON.stringify(metadata()));
    expect(await result).toMatchObject(owner);
    expect(requests).toEqual(["external-cdp Puk hand 1|901:82:0000000000000901"]);
  });

  test("invalid identity or reservation syntax and cancellation cannot start or publish a probe", async () => {
    let calls = 0;
    const ask = async () => { calls++; return JSON.stringify(metadata()); };
    for (const invalid of [{ ...owner, pid: 0 }, { ...owner, window_id: 0 }, { ...owner, ownerNonce: "0000000000000000" }, { ...owner, ownerNonce: "bad" }])
      await expect(probeChromeNative(ask, { display: "Puk hand 1" }, invalid)).rejects.toThrow();
    for (const display of ["", "hand|other", "hand\nexternal-focus", "x".repeat(257)])
      await expect(probeChromeNative(ask, { display }, owner)).rejects.toThrow();
    const cancelled = AbortSignal.abort();
    await expect(probeChromeNative(ask, { display: "Puk hand 1" }, owner, cancelled)).rejects.toThrow();
    expect(calls).toBe(0);
    const controller = new AbortController(), pending = Promise.withResolvers<string>();
    const running = probeChromeNative(async () => { calls++; return pending.promise; }, { display: "Puk hand 1" }, owner, controller.signal);
    controller.abort(); pending.resolve(JSON.stringify(metadata()));
    await expect(running).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
