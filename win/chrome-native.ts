/** Native endpoint ownership only. The caller must authenticate the CDP peer,
 * correlate its window, and preserve Chrome's consent before sending input. */
export type ChromeNativeOwner = Readonly<{ window_id: number; pid: number; ownerNonce: string }>;
export type NativeChromeMetadata = ChromeNativeOwner & Readonly<{
  app: "chrome";
  title: string;
  processStartedAt: string;
  processStartTicks: string;
  focused: boolean;
  iconic: boolean;
  outerRect: readonly [number, number, number, number];
  dpi: number;
  dpiScale: number;
  listeners: readonly Readonly<{ address: "127.0.0.1" | "::1"; port: number }>[];
}>;
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function checkOwner(owner: ChromeNativeOwner): void {
  if (!integer(owner.window_id, 1) || !integer(owner.pid, 1, 0x7fffffff) || !/^[0-7][0-9a-f]{15}$/.test(owner.ownerNonce) || /^0+$/.test(owner.ownerNonce))
    throw new Error("Direct Chrome discovery requires an exact HWND, PID and window-lifetime nonce.");
}

export function parseChromeNativeMetadata(raw: string, expected: ChromeNativeOwner): NativeChromeMetadata {
  checkOwner(expected);
  if (typeof raw !== "string" || raw.length > 16384) throw new Error("Native Chrome metadata exceeded its bound.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Native Chrome metadata was not valid JSON."); }
  const invalid = () => new Error("Native Chrome metadata did not prove the exact bounded owner, geometry and loopback listeners.");
  if (!record(value) || value.window_id !== expected.window_id || value.pid !== expected.pid || value.ownerNonce !== expected.ownerNonce
    || value.app !== "chrome" || typeof value.title !== "string" || !value.title.length || value.title.length > 512
    || typeof value.focused !== "boolean" || typeof value.iconic !== "boolean"
    || !Array.isArray(value.outerRect) || value.outerRect.length !== 4
    || !value.outerRect.every((v, i) => integer(v, i < 2 ? -0x80000000 : 1, 0x7fffffff))
    || !integer(value.dpi, 1, 12288) || typeof value.dpiScale !== "number" || !Number.isFinite(value.dpiScale)
    || Math.abs(value.dpiScale - value.dpi / 96) > 1e-9
    || typeof value.processStartedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value.processStartedAt)
    || typeof value.processStartTicks !== "string" || !/^[1-9]\d{0,18}$/.test(value.processStartTicks)
    || !Array.isArray(value.listeners) || value.listeners.length > 32) throw invalid();
  const ticks = BigInt(value.processStartTicks), timestamp = Date.parse(value.processStartedAt);
  if (ticks > 3155378975999999999n || !Number.isFinite(timestamp) || Number((ticks - 621355968000000000n) / 10000n) !== timestamp) throw invalid();
  const seen = new Set<string>();
  const listeners = value.listeners.map(listener => {
    if (!record(listener) || (listener.address !== "127.0.0.1" && listener.address !== "::1") || !integer(listener.port, 1, 65535)) throw invalid();
    const key = `${listener.address}:${listener.port}`;
    if (seen.has(key)) throw invalid();
    seen.add(key);
    return Object.freeze({ address: listener.address, port: listener.port });
  });
  return Object.freeze({ ...expected, app: "chrome", title: value.title, processStartedAt: value.processStartedAt, processStartTicks: value.processStartTicks,
    focused: value.focused, iconic: value.iconic, outerRect: Object.freeze([...value.outerRect]) as NativeChromeMetadata["outerRect"],
    dpi: value.dpi, dpiScale: value.dpiScale, listeners: Object.freeze(listeners) });
}

/** Dependency injection avoids a desktop -> direct browser -> desktop import
 * cycle. This makes one passive helper request; it never attaches or restores. */
export async function probeChromeNative(ask: (request: string) => Promise<string>, hand: { display: string }, expected: ChromeNativeOwner, signal?: AbortSignal): Promise<NativeChromeMetadata> {
  signal?.throwIfAborted();
  checkOwner(expected);
  if (!hand.display || hand.display.length > 256 || /[\r\n|]/.test(hand.display)) throw new Error("An exact hand reservation is required for native Chrome discovery.");
  const owner = { ...expected };
  const raw = await ask(`external-cdp ${hand.display}|${owner.window_id}:${owner.pid}:${owner.ownerNonce}`);
  signal?.throwIfAborted();
  return parseChromeNativeMetadata(raw, owner);
}
