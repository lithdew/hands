/** Owns Cua's stdio transports independently of the restartable Hands server.
 * No browser preparation happens here. Only an explicit attach may request it.
 */
import { spawn, execFile } from "node:child_process";
import { timingSafeEqual, createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv, AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { redact, rememberSecret, subprocessEnv, type CuaConnection } from "../desktop";

type Driver = { call: CuaConnection["call"]; close(): Promise<void> };
export type BrokerConnection = Driver & { browserSession(): Promise<string> };
type Reply = Awaited<ReturnType<Driver["call"]>>;
/** The MCP SDK can reject before the driver has finished the underlying input.
 * This differs from an actual tool reply that explicitly refuses an action. */
export class UncertainCuaCall extends Error {}
const PROTOCOL = 1;
const LEASE_MS = 20_000;
const CALL_MS = 35_000;
const MAX_BODY = 1_048_576;
const MAX_RESULT = 24 * 1_048_576;
const DRAINABLE_READS = new Set(["get_window_state", "get_desktop_state", "get_browser_state", "list_windows"]);
const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "win", "cua-broker.ts");
const DIRECTORY = join(ROOT, "out", "win", "cua-broker");
const STATE = join(DIRECTORY, "state.json");
const LOCK = join(DIRECTORY, "launch.lock");
const uuid = () => crypto.randomUUID();
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9-]{16,80}$/.test(id);
const validHand = (hand: unknown): hand is number => Number.isSafeInteger(hand) && Number(hand) > 0 && Number(hand) <= 64;
const abortError = () => new Error("Cua request cancelled. It may already have reached the application; observe before deciding the next action.");
const errorText = (error: unknown) => redact(error instanceof Error ? error.message : String(error)).slice(0, 16_000);

/** The state machine is transport-independent so cancellation and ownership can
 * be tested without starting Cua or connecting to a real browser. */
export function createBrokerCore(connect: (hand: number, closed: () => void) => Promise<Driver>, options: {
  now?: () => number; leaseMs?: number; callMs?: number;
} = {}) {
  const now = options.now ?? Date.now, leaseMs = options.leaseMs ?? LEASE_MS;
  type Busy = { id: string; lease: string; abort: AbortController };
  type HandState = { session: string; driver?: Promise<Driver>; generation: number; broken: boolean; busy?: Busy };
  const hands = new Map<number, HandState>();
  let owner: { client: string; lease: string; until: number; used: Set<string> } | undefined;
  let stopped = false;
  const handOf = (id: number) => {
    if (!validHand(id)) throw new Error("Invalid Cua broker hand.");
    let hand = hands.get(id);
    if (!hand) { hand = { session: `puk-browser-${id}-${uuid()}`, generation: 0, broken: false }; hands.set(id, hand); }
    return hand;
  };
  const cancelOwner = () => {
    const lease = owner?.lease;
    owner = undefined;
    for (const hand of hands.values()) { const busy = hand.busy; if (busy && busy.lease === lease) busy.abort.abort(abortError()); }
  };
  const expire = () => { if (owner && now() >= owner.until) cancelOwner(); };
  const check = (lease: string) => {
    expire();
    if (stopped || !owner || owner.lease !== lease) throw new Error("Cua broker lease expired or disconnected. Reconnect Hands before acting.");
    return owner;
  };
  const driverOf = (id: number, hand: HandState) => {
    if (hand.broken) throw new Error("This hand's Cua transport closed. Explicitly attach again; no input was retried.");
    if (!hand.driver) {
      const generation = ++hand.generation;
      hand.driver = connect(id, () => { if (hand.generation === generation) hand.broken = true; });
      hand.driver.catch(() => { if (hand.generation === generation) hand.broken = true; });
    }
    return hand.driver;
  };
  return {
    acquire(client: string) {
      expire();
      if (stopped || !validId(client)) throw new Error("Invalid or stopped Cua broker client.");
      if (owner?.client === client) { owner.until = now() + leaseMs; return { lease: owner.lease, leaseMs }; }
      if (owner || [...hands.values()].some((hand) => hand.busy)) throw new Error("Cua broker is busy with another Hands server. Stop that server before reconnecting.");
      owner = { client, lease: uuid(), until: now() + leaseMs, used: new Set() };
      return { lease: owner.lease, leaseMs };
    },
    heartbeat(lease: string) { check(lease).until = now() + leaseMs; },
    release(lease: string) { check(lease); cancelOwner(); },
    expire,
    session(lease: string, id: number) {
      check(lease);
      const hand = handOf(id);
      if (hand.busy) throw new Error("This hand still has Cua input in flight. Wait for it to settle before attaching.");
      // Called only when the app explicitly constructs a browser attachment.
      if (hand.broken) { hand.driver = undefined; hand.generation++; hand.broken = false; hand.session = `puk-browser-${id}-${uuid()}`; }
      return hand.session;
    },
    cancel(lease: string, id: number, request: string) {
      check(lease);
      const busy = hands.get(id)?.busy;
      if (busy?.lease === lease && busy.id === request) busy.abort.abort(abortError());
    },
    async call(lease: string, id: number, request: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Reply> {
      const current = check(lease), hand = handOf(id);
      if (!validId(request) || typeof name !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(name) || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid Cua broker request.");
      if (current.used.has(request)) throw new Error("Duplicate Cua request refused. A lost response is never replayed.");
      if (current.used.size >= 4096) throw new Error("Cua broker lease request limit reached. Reconnect Hands.");
      if (hand.busy) throw new Error("This hand has a Cua request in flight. No second request was dispatched.");
      signal?.throwIfAborted();
      current.used.add(request);
      const busy: Busy = { id: request, lease, abort: new AbortController() };
      hand.busy = busy;
      const stop = () => busy.abort.abort(abortError());
      signal?.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, options.callMs ?? CALL_MS);
      let rejectCancelled!: (error: unknown) => void;
      const cancelled = new Promise<never>((_done, reject) => { rejectCancelled = reject; });
      const onAbort = () => rejectCancelled(abortError());
      busy.abort.signal.addEventListener("abort", onAbort, { once: true });
      const endingBrowser = name === "end_session" && args.session === hand.session;
      const work = (async () => {
        let driver: Driver | undefined, dispatched = false, quarantined = false, completed = false;
        const drainRead = DRAINABLE_READS.has(name);
        try {
          driver = await driverOf(id, hand);
          check(lease); busy.abort.signal.throwIfAborted();
          dispatched = true;
          // An idle server can close while a preview read is running. Let
          // known read-only RPCs drain; cancelling the SDK promise would hide
          // their completion and unnecessarily discard a healthy Chrome grant.
          const result = await driver.call(name, args, drainRead ? undefined : busy.abort.signal);
          completed = true;
          check(lease); busy.abort.signal.throwIfAborted();
          return result;
        } catch (error) {
          if (dispatched && !completed && (error instanceof UncertainCuaCall || busy.abort.signal.aborted && !drainRead)) {
            hand.broken = true;
            // SDK cancellation/timeout only settles the client promise. End
            // this owned transport and prove child exit before admitting input
            // from another task/client. This deliberately sacrifices its grant.
            try { await driver!.close(); }
            catch {
              quarantined = true;
              throw new Error("Cua shutdown could not be confirmed after interrupted input. This hand is quarantined; no further input can run.");
            }
          }
          throw error;
        } finally {
          // Retain the lock until the underlying call actually settles, even
          // when its caller has already received a cancellation response.
          if (endingBrowser) hand.session = `puk-browser-${id}-${uuid()}`;
          if (!quarantined && hand.busy === busy) hand.busy = undefined;
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          busy.abort.signal.removeEventListener("abort", onAbort);
        }
      })();
      return Promise.race([work, cancelled]);
    },
    async stop() {
      stopped = true; cancelOwner();
      const results = await Promise.allSettled([...hands.values()].map(async (hand) => (await hand.driver)?.close()));
      if (results.some((result) => result.status === "rejected")) throw new Error("Cua broker cannot confirm all owned drivers exited. It remains closed to input until shutdown is confirmed.");
      hands.clear();
    },
    canStop() { expire(); return !owner; },
    summary() { expire(); return { hands: hands.size, leased: Boolean(owner), inFlight: [...hands.values()].filter((hand) => hand.busy).length }; },
  };
}

type Identity = { root: string; runtime: string; script: string; source: string; driver: string };
export type BrokerState = { protocol: number; pid: number; port: number; boot: string; token: string; identity: Identity };
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
export function validateBrokerState(value: unknown, expected: Identity): BrokerState {
  const state = value as BrokerState;
  if (!state || state.protocol !== PROTOCOL || !Number.isSafeInteger(state.pid) || state.pid <= 0 || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535
    || !validId(state.boot) || typeof state.token !== "string" || !/^[a-f0-9]{64}$/.test(state.token) || !state.identity
    || !["root", "runtime", "script", "driver"].every((key) => typeof state.identity[key as keyof Identity] === "string" && samePath(state.identity[key as keyof Identity], expected[key as keyof Identity]))
    || state.identity.source !== expected.source) throw new Error("Cua broker identity does not match this checkout/runtime. Stop the old broker explicitly before reconnecting.");
  return state;
}
const equalSecret = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
export function brokerRequestAuthorized(request: Request, state: Pick<BrokerState, "port" | "token" | "boot">) {
  const url = new URL(request.url);
  return url.hostname === "127.0.0.1" && Number(url.port) === state.port && request.headers.get("host") === `127.0.0.1:${state.port}`
    && !request.headers.has("origin") && !request.headers.has("sec-fetch-site")
    && equalSecret(request.headers.get("authorization") ?? "", `Bearer ${state.token}`)
    && equalSecret(request.headers.get("x-puk-broker") ?? "", state.boot);
}

async function identity(driver: string): Promise<Identity> {
  const [root, runtime, script, executable] = await Promise.all([realpath(ROOT), realpath(process.execPath), realpath(SCRIPT), realpath(driver)]);
  if (!/^bun(?:\.exe)?$/i.test(basename(runtime)) || !samePath(script, join(root, "win", "cua-broker.ts")) || !/^cua-driver(?:\.exe)?$/i.test(basename(executable))) {
    throw new Error("Cua broker requires this checkout's script, Bun runtime and Cua Driver executable.");
  }
  return { root, runtime, script, driver: executable, source: createHash("sha256").update(await readFile(script)).digest("hex") };
}

async function protectDirectory() {
  await mkdir(DIRECTORY, { recursive: true, mode: 0o700 });
  if (!samePath(await realpath(DIRECTORY), join(await realpath(ROOT), "out", "win", "cua-broker"))) throw new Error("Cua broker state must stay inside this checkout's output directory.");
  if (process.platform === "win32") {
    // Only this user's SID and SYSTEM can read the secret. The path is passed as
    // data, never interpolated into PowerShell source or a process argument.
    const command = "$ErrorActionPreference='Stop'; $p=$env:PUK_BROKER_PRIVATE_DIR; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); foreach($s in @($sid,(New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'))){$r=New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($r)}; Set-Acl -LiteralPath $p -AclObject $acl";
    const ps = join(process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await promisify(execFile)(ps, ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 10_000, env: { ...subprocessEnv(), PUK_BROKER_PRIVATE_DIR: DIRECTORY } });
  } else await chmod(DIRECTORY, 0o700);
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
const readState = async () => { try { return JSON.parse(await readFile(STATE, "utf8")) as unknown; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Cua broker state is unreadable; no replacement process was started."); } };
const headers = (state: BrokerState) => ({ authorization: `Bearer ${state.token}`, "x-puk-broker": state.boot, "content-type": "application/json" });

/** No retry here: a transport error may occur after input reached Chrome. */
async function request<T>(state: BrokerState, route: string, data: unknown, signal?: AbortSignal, timeout = CALL_MS + 2000): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${state.port}${route}`, {
    method: "POST", headers: headers(state), body: JSON.stringify(data), redirect: "error", proxy: "",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Cua broker returned an empty response.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_RESULT) throw new Error("Cua broker response exceeds its output limit.");
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { value: T; error?: string };
  if (!response.ok || result.error) throw new Error(result.error ?? "Cua broker refused the request.");
  return result.value;
}

async function locate(driver: string): Promise<BrokerState> {
  const expected = await identity(driver);
  await protectDirectory();
  const verify = async (value: unknown) => {
    const state = validateBrokerState(value, expected);
    rememberSecret(state.token);
    const health = await request<{ boot: string; pid: number; identity: Identity }>(state, "/health", {}, undefined, 1500);
    if (health.boot !== state.boot || health.pid !== state.pid || JSON.stringify(health.identity) !== JSON.stringify(state.identity)) throw new Error("Cua broker process identity changed. No input was dispatched.");
    return state;
  };
  const saved = await readState();
  if (saved !== undefined) {
    const state = validateBrokerState(saved, expected);
    if (alive(state.pid)) return verify(state); // Refuse an unresponsive live owner; never spawn a competing broker.
  }
  let lock;
  try { lock = await open(LOCK, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    for (let attempt = 0; attempt < 60; attempt++) {
      await Bun.sleep(100);
      const ready = await readState();
      if (ready !== undefined && alive(validateBrokerState(ready, expected).pid)) return verify(ready);
    }
    throw new Error("Another Cua broker launch did not finish. Inspect its launch.lock before restarting; no duplicate was launched.");
  }
  let safeToUnlock = true;
  try {
    await lock.writeFile(String(process.pid));
    const again = await readState();
    if (again !== undefined && alive(validateBrokerState(again, expected).pid)) return verify(again);
    const child = spawn(expected.runtime, ["--no-env-file", expected.script, "--serve", expected.driver], {
      cwd: expected.root, env: { ...subprocessEnv(), PUK_DEBUG: "0" }, detached: true, windowsHide: true, stdio: "ignore",
    });
    let launchFailed = false;
    child.on("error", () => { launchFailed = true; });
    child.unref();
    safeToUnlock = false;
    await lock.truncate(); await lock.write(JSON.stringify({ launcher: process.pid, child: child.pid }), 0, "utf8");
    for (let attempt = 0; attempt < 80; attempt++) {
      if (launchFailed || child.exitCode !== null) { safeToUnlock = true; throw new Error("The Cua broker could not start. No browser preparation was attempted."); }
      await Bun.sleep(100);
      const value = await readState();
      if (value !== undefined && (value as BrokerState).pid === child.pid) { const ready = await verify(value); safeToUnlock = true; return ready; }
    }
    throw new Error("Cua broker startup timed out. Inspect its process before retrying; no browser preparation was attempted.");
  } finally { await lock.close(); if (safeToUnlock) await unlink(LOCK).catch(() => {}); }
}

/** Injectable wire keeps these tests entirely offline. */
export function createBrokerClient(wire: <T>(route: string, data: unknown, signal?: AbortSignal) => Promise<T>, onEmpty: () => void = () => {}) {
  const client = uuid();
  let lease: string | undefined, timer: ReturnType<typeof setInterval> | undefined, heartbeatPending = false;
  let ended = false;
  const connections = new Map<number, { closed: () => void; queue: Promise<unknown>; pending: number }>();
  const active = new Map<string, { hand: number; abort: AbortController }>();
  const fail = () => {
    if (ended) return;
    ended = true; clearInterval(timer);
    for (const task of active.values()) task.abort.abort(abortError());
    for (const connection of connections.values()) connection.closed();
    connections.clear(); onEmpty();
  };
  const check = () => { if (ended || !lease) throw new Error("The persistent Cua connection is disconnected. Reconnect before acting."); return lease; };
  return {
    async connect() {
      const grant = await wire<{ lease: string; leaseMs: number }>("/lease", { client });
      if (!validId(grant.lease) || grant.leaseMs < 1000) throw new Error("Cua broker returned an invalid lease.");
      lease = grant.lease;
      timer = setInterval(() => {
        if (heartbeatPending || ended) return;
        heartbeatPending = true;
        wire("/heartbeat", { lease }).catch(fail).finally(() => { heartbeatPending = false; });
      }, Math.min(5000, grant.leaseMs / 3));
      timer.unref();
    },
    hand(id: number, closed: () => void): BrokerConnection {
      check();
      if (!validHand(id) || connections.has(id)) throw new Error("Duplicate or invalid local Cua hand.");
      const connection = { closed, queue: Promise.resolve() as Promise<unknown>, pending: 0 };
      connections.set(id, connection);
      let released = false;
      const attached = () => { if (released || connections.get(id) !== connection) throw new Error("This Cua hand was disconnected."); return check(); };
      return {
        browserSession: () => wire<string>("/session", { lease: attached(), hand: id }),
        call(name, args = {}, signal) {
          if (connection.pending >= 4) return Promise.reject(new Error("This hand's Cua queue is full. No input was dispatched."));
          connection.pending++;
          const work = connection.queue.then(async () => {
            const heldLease = attached(); signal?.throwIfAborted();
            const requestId = uuid(), abort = new AbortController();
            const cancel = () => {
              abort.abort(abortError());
              void wire("/cancel", { lease: heldLease, hand: id, request: requestId }).catch(() => {});
            };
            signal?.addEventListener("abort", cancel, { once: true });
            active.set(requestId, { hand: id, abort });
            try {
              const result = await wire<Reply>("/call", { lease: heldLease, hand: id, request: requestId, name, args }, abort.signal);
              attached(); signal?.throwIfAborted();
              return result;
            } catch (error) {
              // The request may have executed. Never reconnect and replay it.
              throw error;
            } finally { signal?.removeEventListener("abort", cancel); active.delete(requestId); }
          }).finally(() => { connection.pending--; });
          connection.queue = work.catch(() => {});
          return work;
        },
        async close() {
          if (released) return;
          released = true; connections.delete(id); closed();
          for (const [requestId, task] of active) if (task.hand === id) {
            task.abort.abort(abortError());
            await wire("/cancel", { lease, hand: id, request: requestId }).catch(() => {});
          }
          if (!connections.size && !ended) {
            const heldLease = lease; fail();
            await wire("/release", { lease: heldLease }).catch(() => {});
          }
        },
      };
    },
  };
}

let shared: Promise<ReturnType<typeof createBrokerClient>> | undefined;
export async function connectBrokerHand(hand: number, driver: string, closed: () => void): Promise<BrokerConnection> {
  if (!shared) {
    const pending = (async () => {
      const state = await locate(driver);
      const client = createBrokerClient((route, data, signal) => request(state, route, data, signal, route === "/call" ? CALL_MS + 2000 : 3000), () => { if (shared === pending) shared = undefined; });
      await client.connect();
      return client;
    })();
    shared = pending;
    pending.catch(() => { if (shared === pending) shared = undefined; });
  }
  return (await shared).hand(hand, closed);
}

async function mcpDriver(driver: string, closed: () => void): Promise<Driver> {
  const client = new Client({ name: "puk-broker", version: "1" }, { jsonSchemaValidator: new AjvJsonSchemaValidator(new Ajv({ strict: false, logger: false })) });
  client.onclose = closed;
  const transport = new StdioClientTransport({ command: driver, args: ["mcp", "--grant", "existing-profile"], stderr: "ignore",
    env: { ...subprocessEnv(), CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" } });
  // StdioClientTransport.close() can return immediately after SIGKILL, before
  // its child exits. Its onclose is the actual child-process close event; the
  // Protocol client preserves this preinstalled hook when connecting.
  let exited = false, pid: number | null = null, closing: Promise<void> | undefined;
  transport.onclose = () => { exited = true; };
  const close = () => closing ??= (async () => {
    const capturedPid = pid ?? transport.pid;
    await client.close();
    for (let attempt = 0; !exited && capturedPid !== null && alive(capturedPid) && attempt < 100; attempt++) await Bun.sleep(50);
    if (!exited && capturedPid !== null && alive(capturedPid)) throw new Error("The owned Cua driver did not confirm exit.");
  })().catch((error) => { closing = undefined; throw error; });
  try { await client.connect(transport, { timeout: 15_000 }); await client.listTools(undefined, { timeout: 15_000 }); }
  catch (error) { await close().catch(() => {}); throw error; }
  pid = transport.pid;
  return {
    async call(name, args = {}, signal) {
      signal?.throwIfAborted();
      let response: Reply;
      try { response = await client.callTool({ name, arguments: args }, { signal, timeout: 30_000 }); }
      catch (error) { throw new UncertainCuaCall(errorText(error)); }
      if (response.isError) throw new Error(errorText(response.content.filter((content) => content.type === "text").map((content) => content.text).join("\n")));
      return response;
    },
    close,
  };
}

async function serve(driver: string) {
  const expected = await identity(driver);
  await protectDirectory();
  const old = await readState();
  if (old !== undefined && alive(validateBrokerState(old, expected).pid)) throw new Error("A Cua broker already owns this checkout.");
  const state: BrokerState = { protocol: PROTOCOL, identity: expected, pid: process.pid, port: 0, boot: uuid(), token: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex") };
  rememberSecret(state.token);
  const core = createBrokerCore((_hand, closed) => mcpDriver(expected.driver, closed));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true; clearInterval(sweep);
    try { await core.stop(); }
    catch { stopping = false; return; } // Keep authenticated ownership/state while any child might still deliver input.
    server.stop(true);
    const saved = await readState();
    if ((saved as BrokerState | undefined)?.boot === state.boot) await unlink(STATE).catch(() => {});
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: MAX_BODY, idleTimeout: 60,
    async fetch(req) {
      const reply = (value: unknown, status = 200) => Response.json({ value }, { status, headers: { "cache-control": "no-store" } });
      if (!brokerRequestAuthorized(req, state) || req.method !== "POST") return reply(null, 403);
      try {
        const body = await req.text();
        if (body.length > MAX_BODY) throw new Error("Cua broker request exceeds its size limit.");
        const data = JSON.parse(body) as Record<string, any>, route = new URL(req.url).pathname;
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid Cua broker message.");
        let value: unknown;
        if (route === "/health") value = { boot: state.boot, pid: state.pid, identity: state.identity, ...core.summary() };
        else if (route === "/lease") value = core.acquire(data.client);
        else if (route === "/heartbeat") core.heartbeat(data.lease);
        else if (route === "/release") core.release(data.lease);
        else if (route === "/session") value = core.session(data.lease, data.hand);
        else if (route === "/cancel") core.cancel(data.lease, data.hand, data.request);
        else if (route === "/call") value = await core.call(data.lease, data.hand, data.request, data.name, data.args, req.signal);
        else if (route === "/stop") {
          if (!core.canStop()) throw new Error("Stop Hands before stopping its Cua broker.");
          setTimeout(() => { void shutdown(); }, 20);
        } else return reply(null, 404);
        const serialized = JSON.stringify({ value: value ?? null });
        if (Buffer.byteLength(serialized) > MAX_RESULT) throw new Error("Cua result exceeds the broker output limit. No input will be replayed.");
        return new Response(serialized, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      } catch (error) { return Response.json({ error: errorText(error) }, { status: 409, headers: { "cache-control": "no-store" } }); }
    },
  });
  state.port = server.port!;
  const temporary = join(DIRECTORY, `${state.boot}.tmp`);
  await Bun.write(temporary, JSON.stringify(state));
  if (process.platform !== "win32") await chmod(temporary, 0o600);
  await rename(temporary, STATE);
  const sweep = setInterval(() => core.expire(), 1000);
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "--serve" && process.argv[3]) await serve(process.argv[3]);
    else if (["stop", "status"].includes(process.argv[2] ?? "")) {
      const value = await readState();
      if (!value) console.log("No Cua broker state exists.");
      else {
        const supplied = value as BrokerState;
        // Stop also works after a broker source update, but still verifies paths,
        // driver/runtime and the authenticated, exact recorded boot identity.
        const expected = await identity(supplied.identity.driver);
        const state = validateBrokerState(value, { ...expected, source: supplied.identity.source });
        rememberSecret(state.token);
        if (!alive(state.pid)) { await unlink(STATE); console.log("Removed stopped Cua broker state."); }
        else {
          const health = await request<{ boot: string; pid: number; hands: number; leased: boolean }>(state, "/health", {}, undefined, 2000);
          if (health.boot !== state.boot || health.pid !== state.pid) throw new Error("Cua broker identity changed.");
          if (process.argv[2] === "stop") { await request(state, "/stop", {}, undefined, 2000); console.log("Cua broker stopping; its browser sessions will end."); }
          else console.log(JSON.stringify({ pid: health.pid, hands: health.hands, leased: health.leased }));
        }
      }
    } else throw new Error("Usage: bun win/cua-broker.ts status|stop");
  } catch (error) { console.error(errorText(error)); process.exitCode = 1; }
}
