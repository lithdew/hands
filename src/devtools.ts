/**
 * The browser's DevTools protocol, the same way from WSL and from Windows.
 *
 * WSL has a loopback of its own, so Chrome's port on the Windows side is out of its reach. The helper is on that
 * side either way, so it holds the one socket (`devtools <port>` in windows.cs) and this file talks to it in lines:
 * a line down its stdin is one message to Chrome, a line up its stdout is one message from Chrome. The helper only
 * carries; every message is composed and read here. The socket is the BROWSER's, and a page is a flattened session
 * on it (`attachPage`), so one process start pays for every tab a hand ever works.
 */

import type { NativeSession } from "./macos.ts";
import { native } from "./windows.ts";

export const DEVTOOLS_PORT = Number(process.env.HANDS_DEVTOOLS_PORT ?? 9333);
/** A call into a page that is navigating away may never be answered, and `Page.navigate` answers only once the site has. */
const CALL_TIMEOUT_MS = 30_000;
/** The helper says within its own 3 s whether anything listens; past this it is the helper that is stuck. */
const CONNECT_TIMEOUT_MS = 15_000;

export interface CdpEvent {
  method: string;
  params: any;
  sessionId?: string;
}

export interface Cdp {
  /** Rejects with Chrome's error message. */
  send<T = any>(method: string, params?: object, sessionId?: string): Promise<T>;
  /** Returns the unsubscribe. */
  on(handler: (event: CdpEvent) => void): () => void;
  close(): void;
  /** Resolves when the relay or Chrome goes. */
  closed: Promise<void>;
}

export interface PageSession {
  targetId: string;
  sessionId: string;
  send<T = any>(method: string, params?: object): Promise<T>;
  /** Runtime.evaluate, returnByValue, awaitPromise; throws on exception. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** This page's events only. */
  on(handler: (event: CdpEvent) => void): () => void;
}

interface Pending {
  method: string;
  resolve(result: any): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** stdout as whole lines. A message can be megabytes and arrives in pieces, so pieces are kept apart until their newline. */
async function* lines(stdout: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let parts: string[] = [];
  for await (const chunk of stdout) {
    let text = decoder.decode(chunk, { stream: true });
    for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n")) {
      parts.push(text.slice(0, end));
      yield parts.join("");
      parts = [];
      text = text.slice(end + 1);
    }
    if (text) parts.push(text);
  }
  if (parts.length) yield parts.join("");
}

/** One helper `devtools <port>` session to the BROWSER endpoint. Rejects once, no retries, when nothing listens. */
export async function connectCdp(options: { port?: number; open?: () => NativeSession; timeoutMs?: number } = {}): Promise<Cdp> {
  const port = options.port ?? DEVTOOLS_PORT;
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
  const session = (options.open ?? (() => native.session("devtools", port)))();
  const pending = new Map<number, Pending>();
  const handlers = new Set<(event: CdpEvent) => void>();
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let nextId = 1;
  let over: string | undefined;

  const finish = (why: string) => {
    if (over !== undefined) return;
    over = why;
    ready.reject(new Error(why));
    for (const call of pending.values()) (clearTimeout(call.timer), call.reject(new Error(`${call.method} was not answered: ${why}`)));
    pending.clear();
    handlers.clear();
    try {
      session.end(); // WSL keeps a Windows program open while its stdin is
    } catch {
      // already gone
    }
    closed.resolve();
  };

  const take = (line: string) => {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return; // not ours: the helper writes whole messages or nothing
    }
    // The helper's own words are an `error` that is text; Chrome's is an object, and comes with the id it answers.
    if (typeof message.error === "string") return finish(message.error);
    if (typeof message.id === "number") {
      const call = pending.get(message.id);
      if (!call) return; // timed out already
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}${message.error.data ? ` (${message.error.data})` : ""}`));
      else call.resolve(message.result);
    } else if (typeof message.method === "string") {
      for (const handler of [...handlers]) {
        try {
          handler({ method: message.method, params: message.params ?? {}, ...(message.sessionId ? { sessionId: message.sessionId } : {}) });
        } catch {
          // one listener's trouble is not the next one's
        }
      }
    } else ready.resolve(); // the first line: Chrome's own /json/version, once the socket is open
  };

  void (async () => {
    for await (const line of lines(session.stdout)) if (line.trim()) take(line);
    finish("the DevTools relay ended");
  })().catch((error) => finish(`the DevTools relay ended: ${error instanceof Error ? error.message : error}`));
  void session.exited.then(() => Bun.sleep(50)).then(() => finish("the DevTools relay ended")); // after its last words are read

  const cdp: Cdp = {
    send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
      if (over !== undefined) return Promise.reject(new Error(`${method} was not sent: ${over}`));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => (pending.delete(id), reject(new Error(`${method} was not answered in ${timeoutMs / 1000} s`))), timeoutMs);
        pending.set(id, { method, resolve, reject, timer });
        try {
          session.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\n`);
        } catch (error) {
          finish(`the DevTools relay is gone: ${error instanceof Error ? error.message : error}`);
        }
      });
    },
    on(handler) {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    close: () => finish("the DevTools connection was closed"),
    closed: closed.promise,
  };

  const late = setTimeout(() => finish(`nothing answered on DevTools port ${port}`), CONNECT_TIMEOUT_MS);
  try {
    await ready.promise;
  } finally {
    clearTimeout(late);
  }
  return cdp;
}

/** Attach (flatten: true) to `targetId`, or to the first page target when none is given. */
export async function attachPage(cdp: Cdp, targetId?: string): Promise<PageSession> {
  const target = targetId ?? (await pageTargets(cdp))[0]?.targetId;
  if (!target) throw new Error("the browser has no page to attach to");
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target, flatten: true });
  const send = <T = any>(method: string, params?: object) => cdp.send<T>(method, params, sessionId);
  return {
    targetId: target,
    sessionId,
    send,
    async evaluate<T>(expression: string): Promise<T> {
      const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description?.split("\n")[0] ?? reply.exceptionDetails.text ?? "the page threw");
      return reply.result?.value as T;
    },
    on: (handler) => cdp.on((event) => void (event.sessionId === sessionId && handler(event))),
  };
}

export interface PageTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

/** The browser's tabs, in Chrome's order: no DevTools windows, workers or extension pages. */
export const pageTargets = async (cdp: Cdp): Promise<PageTarget[]> =>
  (await cdp.send<{ targetInfos: PageTarget[] }>("Target.getTargets")).targetInfos.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
