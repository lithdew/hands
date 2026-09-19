/** Persistent CDP transport for an endpoint whose OS ownership the caller has
 * already proved. This module neither discovers Chrome nor grants attachment. */
export type ChromeCdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string };
export type ChromeCdpCallOptions = { sessionId?: string; signal?: AbortSignal; timeoutMs?: number };
export interface ChromeCdp {
  call<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, options?: ChromeCdpCallOptions): Promise<T>;
  onEvent(cb: (event: ChromeCdpEvent) => void): () => void;
  isOpen(): boolean;
  close(): void;
}
/** The standard WebSocket subset also permits fully offline protocol tests. */
export interface ChromeCdpSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, callback: (event: Event) => void): void;
  removeEventListener(type: string, callback: (event: Event) => void): void;
}
export type ChromeCdpConnectOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  socketFactory?: (url: string) => ChromeCdpSocket;
};
export const CHROME_CDP_LIMITS = Object.freeze({
  messageBytes: 32 * 1024 * 1024, requestBytes: 1024 * 1024,
  pendingCalls: 64, eventListeners: 64, callsPerConnection: 100_000,
  connectTimeoutMs: 5_000, callTimeoutMs: 15_000, maxTimeoutMs: 60_000,
});

export class ChromeCdpCommandError extends Error {
  constructor(readonly code: number, message: string) {
    super(`CDP command failed (${code}): ${message.slice(0, 1_000)}`);
    this.name = "ChromeCdpCommandError";
  }
}

// IDs remain unique across connections in this process, including failed sends.
let nextRequestId = 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validMethod = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{0,79}\.[A-Za-z][A-Za-z0-9]{0,79}$/.test(value);
const validSession = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
function timeout(value: number | undefined, fallback: number): number {
  const milliseconds = value ?? fallback;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > CHROME_CDP_LIMITS.maxTimeoutMs) {
    throw new Error(`CDP timeout must be an integer from 1 to ${CHROME_CDP_LIMITS.maxTimeoutMs} milliseconds.`);
  }
  return milliseconds;
}
function validateEndpoint(url: string): void {
  // Validate the literal spelling before URL parsing can normalize 127.1,
  // numeric/octal hosts, escaped path components or other alternate origins.
  const match = typeof url === "string" && /^ws:\/\/(?:127\.0\.0\.1|\[::1\]):([0-9]{1,5})\/devtools\/browser\/[A-Za-z0-9_-]{1,128}$/.exec(url);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65_535) {
    throw new Error("CDP requires a literal loopback ws browser endpoint with an explicit port; credentials, queries and fragments are forbidden.");
  }
}

export async function connectChromeCdp(url: string, options: ChromeCdpConnectOptions = {}): Promise<ChromeCdp> {
  validateEndpoint(url);
  const connectTimeout = timeout(options.timeoutMs, CHROME_CDP_LIMITS.connectTimeoutMs);
  options.signal?.throwIfAborted();
  return new Promise<ChromeCdp>((resolve, reject) => {
    let socket: ChromeCdpSocket;
    try { socket = (options.socketFactory ?? ((endpoint) => new WebSocket(endpoint)))(url); }
    catch { reject(new Error("CDP WebSocket creation failed.")); return; }
    let connected = false, closed = false, dispatched = 0;
    type Pending = { sessionId?: string; resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void };
    const pending = new Map<number, Pending>();
    const listeners = new Set<(event: ChromeCdpEvent) => void>();
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanConnect = () => { clearTimeout(connectTimer); options.signal?.removeEventListener("abort", onConnectAbort); };
    const finish = (error: Error) => {
      if (closed) return;
      closed = true;
      cleanConnect();
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      for (const request of pending.values()) { request.cleanup(); request.reject(error); }
      pending.clear(); listeners.clear();
      if (!connected) reject(error);
      try { socket.close(); } catch { /* Local closure already prevents any reuse. */ }
    };
    const protocolFailure = () => finish(new Error("CDP returned an invalid, oversized, unknown-request or wrong-session message; the connection was closed."));
    const onConnectAbort = () => finish(new Error("CDP connection was cancelled before it opened."));
    const onClose = () => finish(new Error("CDP connection closed; pending command outcomes are unknown. No command was retried."));
    const onError = () => finish(new Error("CDP connection failed; pending command outcomes are unknown. No command was retried."));
    const onMessage = (event: Event) => {
      if (closed) return;
      const data: unknown = (event as MessageEvent).data;
      if (!connected || typeof data !== "string" || data.length > CHROME_CDP_LIMITS.messageBytes || Buffer.byteLength(data, "utf8") > CHROME_CDP_LIMITS.messageBytes) {
        protocolFailure(); return;
      }
      let message: unknown;
      try { message = JSON.parse(data); } catch { protocolFailure(); return; }
      if (!record(message) || message.sessionId !== undefined && !validSession(message.sessionId)) { protocolFailure(); return; }
      if (Object.hasOwn(message, "id")) {
        if (!Number.isSafeInteger(message.id) || Number(message.id) < 1 || Object.hasOwn(message, "method")) { protocolFailure(); return; }
        const request = pending.get(message.id as number);
        if (!request || request.sessionId !== message.sessionId) { protocolFailure(); return; }
        const hasResult = Object.hasOwn(message, "result"), hasError = Object.hasOwn(message, "error");
        if (hasResult === hasError || hasResult && !record(message.result)
          || hasError && (!record(message.error) || !Number.isSafeInteger(message.error.code) || typeof message.error.message !== "string")) {
          protocolFailure(); return;
        }
        pending.delete(message.id as number); request.cleanup();
        if (hasError) {
          const error = message.error as { code: number; message: string };
          request.reject(new ChromeCdpCommandError(error.code, error.message));
        } else request.resolve(message.result);
        return;
      }
      if (!validMethod(message.method) || message.params !== undefined && !record(message.params)
        || Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) { protocolFailure(); return; }
      const delivered: ChromeCdpEvent = { method: message.method, params: message.params as Record<string, unknown> ?? {},
        ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId as string }) };
      // No event backlog or page-data logging. Subscriber failures cannot break
      // response dispatch, and closing from a subscriber stops further delivery.
      for (const listener of [...listeners]) {
        if (closed) break;
        try { listener(delivered); } catch { /* Observers are independent. */ }
      }
    };
    const api: ChromeCdp = {
      async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, callOptions: ChromeCdpCallOptions = {}): Promise<T> {
        if (closed || !connected || socket.readyState !== 1) throw new Error("CDP connection is not open. Commands are never reconnected or replayed automatically.");
        if (!validMethod(method) || !record(params) || callOptions.sessionId !== undefined && !validSession(callOptions.sessionId)) throw new Error("Invalid CDP method, parameters or session ID.");
        const callTimeout = timeout(callOptions.timeoutMs, CHROME_CDP_LIMITS.callTimeoutMs);
        callOptions.signal?.throwIfAborted();
        if (pending.size >= CHROME_CDP_LIMITS.pendingCalls) throw new Error("CDP pending request limit reached; no command was sent.");
        if (dispatched >= CHROME_CDP_LIMITS.callsPerConnection || nextRequestId >= Number.MAX_SAFE_INTEGER) throw new Error("CDP request ID budget exhausted; no command was sent.");
        const id = ++nextRequestId, sessionId = callOptions.sessionId;
        let encoded: string;
        try { encoded = JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }); }
        catch { throw new Error("CDP parameters are not JSON serializable; no command was sent."); }
        if (Buffer.byteLength(encoded, "utf8") > CHROME_CDP_LIMITS.requestBytes) throw new Error("CDP request exceeds its byte limit; no command was sent.");
        const serialized: unknown = JSON.parse(encoded);
        if (!record(serialized) || serialized.id !== id || serialized.method !== method || serialized.sessionId !== sessionId || !record(serialized.params)) {
          throw new Error("CDP serialization changed its request envelope; no command was sent.");
        }
        // A custom serializer can run caller code. Recheck cancellation and
        // lifecycle immediately before registering/sending the command.
        callOptions.signal?.throwIfAborted();
        if (closed || socket.readyState !== 1) throw new Error("CDP closed before dispatch; no command was sent.");
        if (pending.size >= CHROME_CDP_LIMITS.pendingCalls) throw new Error("CDP pending request limit reached; no command was sent.");
        if (dispatched >= CHROME_CDP_LIMITS.callsPerConnection) throw new Error("CDP request ID budget exhausted; no command was sent.");
        return new Promise<T>((resolveCall, rejectCall) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const onAbort = () => finish(new Error("CDP request was cancelled after dispatch; command outcome is unknown and the connection was closed. No command was retried."));
          const cleanup = () => { clearTimeout(timer); callOptions.signal?.removeEventListener("abort", onAbort); };
          pending.set(id, { sessionId, resolve: value => resolveCall(value as T), reject: rejectCall, cleanup });
          callOptions.signal?.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(() => finish(new Error("CDP request timed out after dispatch; command outcome is unknown and the connection was closed. No command was retried.")), callTimeout);
          dispatched++;
          try { socket.send(encoded); }
          catch { finish(new Error("CDP send failed; command outcome is unknown and the connection was closed. No command was retried.")); }
        });
      },
      onEvent(cb) {
        if (closed || !connected) throw new Error("CDP connection is not open.");
        if (typeof cb !== "function") throw new Error("CDP event subscriber must be a function.");
        if (!listeners.has(cb) && listeners.size >= CHROME_CDP_LIMITS.eventListeners) throw new Error("CDP event subscriber limit reached.");
        listeners.add(cb); return () => { listeners.delete(cb); };
      },
      isOpen: () => connected && !closed && socket.readyState === 1,
      close: () => finish(new Error("CDP connection was closed by its owner; pending command outcomes are unknown. No command was retried.")),
    };
    const onOpen = () => {
      if (closed || connected) return;
      if (socket.readyState !== 1) { protocolFailure(); return; }
      connected = true; cleanConnect(); resolve(api);
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    options.signal?.addEventListener("abort", onConnectAbort, { once: true });
    connectTimer = setTimeout(() => finish(new Error("CDP WebSocket connection timed out before opening.")), connectTimeout);
    if (options.signal?.aborted) onConnectAbort();
    else if (socket.readyState === 1) onOpen();
    else if (socket.readyState !== 0) onClose();
  });
}
