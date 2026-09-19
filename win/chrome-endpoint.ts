import { request } from "node:http";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { NativeChromeMetadata } from "./chrome-native";

export type ChromeListener = { address: "127.0.0.1" | "::1"; port: number };
export type ChromeEndpoint = ChromeListener & { url: string };
const authority = (listener: ChromeListener) => `${listener.address === "::1" ? "[::1]" : listener.address}:${listener.port}`;
/** No proxy, redirect, arbitrary hostname, profile file, or non-owned port. */
export function readChromeVersion(listener: ChromeListener, signal?: AbortSignal): Promise<unknown> {
  if (!["127.0.0.1", "::1"].includes(listener.address) || !Number.isSafeInteger(listener.port) || listener.port < 1 || listener.port > 65535) throw new Error("Invalid Chrome listener.");
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = request({ hostname: listener.address, port: listener.port, path: "/json/version", method: "GET", signal,
      headers: { Host: authority(listener), Accept: "application/json" } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error("Chrome discovery did not return 200.")); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", chunk => { size += chunk.length; if (size > 65536) req.destroy(new Error("Chrome discovery exceeded its limit.")); else chunks.push(Buffer.from(chunk)); });
      res.on("error", reject);
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("Invalid Chrome discovery JSON.")); } });
    });
    const timer = setTimeout(() => req.destroy(new Error("Chrome discovery timed out.")), 1500);
    req.on("close", () => clearTimeout(timer)); req.on("error", reject); req.end();
  });
}
export function chromeEndpoint(listener: ChromeListener, value: unknown): ChromeEndpoint | undefined {
  if (!value || typeof value !== "object") return;
  const url = (value as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
  if (typeof url !== "string" || !url.startsWith(`ws://${authority(listener)}/devtools/browser/`)
    || !/^ws:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}\/devtools\/browser\/[A-Za-z0-9_-]{1,128}$/.test(url)) return;
  return { ...listener, url };
}
export function sameChromeOwner(a: NativeChromeMetadata, b: NativeChromeMetadata): boolean {
  return a.window_id === b.window_id && a.pid === b.pid && a.ownerNonce === b.ownerNonce && a.processStartTicks === b.processStartTicks;
}
export function ownsChromeEndpoint(native: NativeChromeMetadata, endpoint: ChromeEndpoint): boolean {
  return native.listeners.some(listener => listener.address === endpoint.address && listener.port === endpoint.port);
}
/** Chrome's consent-enabled server can intentionally omit /json/version.
 * Its documented rendezvous file contains only a port and browser socket path.
 * The file never establishes ownership: both values must match native evidence. */
export function chromeRendezvousEndpoint(native:NativeChromeMetadata, contents:string):ChromeEndpoint|undefined {
  if(contents.length>4096)return;
  const lines=contents.trim().split(/\r?\n/);
  if(lines.length!==2||!/^\d{1,5}$/.test(lines[0]!)||!/^\/devtools\/browser\/[A-Za-z0-9_-]{1,128}$/.test(lines[1]!))return;
  const listeners=native.listeners.filter(listener=>listener.port===Number(lines[0]));
  if(listeners.length!==1)return;
  const listener=listeners[0]!;
  return chromeEndpoint(listener,{webSocketDebuggerUrl:`ws://${authority(listener)}${lines[1]}`});
}
export async function readDefaultChromeRendezvous():Promise<string|undefined> {
  if(process.platform!=="win32"||!process.env.LOCALAPPDATA)return;
  // A single documented metadata file, not a profile/cookie search. A custom
  // profile without HTTP discovery is deliberately not guessed.
  const file=await open(join(process.env.LOCALAPPDATA,"Google","Chrome","User Data","DevToolsActivePort"),"r").catch(()=>undefined);
  if(!file)return;
  try {const stat=await file.stat();if(!stat.isFile()||stat.size>4096)return;const bytes=Buffer.alloc(4097);const {bytesRead}=await file.read(bytes,0,bytes.length,0);return bytesRead<=4096?bytes.toString("utf8",0,bytesRead):undefined;}
  finally {await file.close();}
}
export async function discoverChromeEndpoint(native: NativeChromeMetadata, signal?: AbortSignal,
  read: typeof readChromeVersion = readChromeVersion, rendezvous?:()=>Promise<string|undefined>): Promise<ChromeEndpoint> {
  signal?.throwIfAborted();
  if (native.listeners.length > 32) throw new Error("Too many Chrome listeners.");
  const replies = await Promise.allSettled(native.listeners.map(async listener => chromeEndpoint(listener, await read(listener, signal))));
  signal?.throwIfAborted();
  const endpoints = replies.flatMap(reply => reply.status === "fulfilled" && reply.value ? [reply.value] : []);
  if(!endpoints.length&&rendezvous){const contents=await rendezvous();signal?.throwIfAborted();const found=contents===undefined?undefined:chromeRendezvousEndpoint(native,contents);if(found)endpoints.push(found);}
  if (endpoints.length !== 1) throw new Error(endpoints.length ? "Multiple Chrome debugging endpoints match this process; refusing an ambiguous connection."
    : "Chrome has no available direct debugging endpoint. Enable remote debugging in chrome://inspect/#remote-debugging, then attach this window again. Hands will use Chrome's own connection approval.");
  return endpoints[0]!;
}
