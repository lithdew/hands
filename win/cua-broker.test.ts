import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BROKER_DIRECTORY_ACL_SCRIPT, brokerRequestAuthorized, createBrokerClient, createBrokerCore, UncertainCuaCall, validateBrokerState, type BrokerState } from "./cua-broker";
import { subprocessEnv, type CuaConnection } from "../desktop";

const id = () => crypto.randomUUID();
const reply = { content: [] } as Awaited<ReturnType<CuaConnection["call"]>>;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
};
function wireFor(core: ReturnType<typeof createBrokerCore>) {
  return async <T>(route: string, input: unknown, signal?: AbortSignal): Promise<T> => {
    const data = input as Record<string, any>;
    if (route === "/lease") return core.acquire(data.client) as T;
    if (route === "/heartbeat") return core.heartbeat(data.lease) as T;
    if (route === "/release") return core.release(data.lease) as T;
    if (route === "/session") return core.session(data.lease, data.hand) as T;
    if (route === "/cancel") return core.cancel(data.lease, data.hand, data.request) as T;
    if (route === "/call") return await core.call(data.lease, data.hand, data.request, data.name, data.args, signal) as T;
    throw new Error("Unexpected test route");
  };
}

describe("persistent Cua ownership", () => {
  test("Hands shutdown releases its lease but retains the exact MCP and public browser session", async () => {
    let connections = 0, closes = 0;
    const calls: { name: string; session: unknown }[] = [];
    const core = createBrokerCore(async () => {
      connections++;
      return { call: async (name, args) => { calls.push({ name, session: args?.session }); return reply; }, close: async () => { closes++; } };
    });
    const a = createBrokerClient(wireFor(core)); await a.connect();
    const first = a.hand(1, () => {}), session = await first.browserSession();
    await first.call("get_browser_state", { session });
    await first.close();
    expect(core.summary().leased).toBe(false);
    expect(closes).toBe(0);
    const b = createBrokerClient(wireFor(core)); await b.connect();
    const resumed = b.hand(1, () => {});
    expect(await resumed.browserSession()).toBe(session);
    await resumed.call("get_browser_state", { session });
    expect(connections).toBe(1);
    expect(calls).toEqual([{ name: "get_browser_state", session }, { name: "get_browser_state", session }]);
    await resumed.close(); await core.stop();
    expect(closes).toBe(1);
  });

  test("closing an idle client during a preview lets that read drain and preserves Chrome's session", async () => {
    const entered = deferred<void>(), preview = deferred<typeof reply>();
    let closes = 0, readSignal: AbortSignal | undefined;
    const core = createBrokerCore(async () => ({
      call: async (_name, _args, signal) => { readSignal = signal; entered.resolve(); return preview.promise; },
      close: async () => { closes++; },
    }));
    const first = createBrokerClient(wireFor(core)); await first.connect();
    const hand = first.hand(1, () => {}), session = await hand.browserSession();
    const pending = hand.call("get_window_state", {});
    await entered.promise;
    const stopped = pending.catch((error: unknown) => error);
    await hand.close();
    expect((await stopped as Error).message).toContain("cancelled");
    expect(readSignal).toBeUndefined();
    expect(core.summary().inFlight).toBe(1);
    expect(() => core.acquire(id())).toThrow("busy");
    preview.resolve(reply); await Bun.sleep(0);
    expect(closes).toBe(0);
    const second = createBrokerClient(wireFor(core)); await second.connect();
    const resumed = second.hand(1, () => {});
    expect(await resumed.browserSession()).toBe(session);
    await resumed.close(); await core.stop();
  });

  test("explicit detach ends and rotates only that hand's browser session", async () => {
    let closes = 0;
    const core = createBrokerCore(async () => ({ call: async () => reply, close: async () => { closes++; } }));
    const lease = core.acquire(id()).lease;
    const first = core.session(lease, 1), second = core.session(lease, 2);
    await core.call(lease, 1, id(), "end_session", { session: "some-native-session" });
    expect(core.session(lease, 1)).toBe(first);
    await core.call(lease, 1, id(), "end_session", { session: first });
    expect(core.session(lease, 1)).not.toBe(first);
    expect(core.session(lease, 2)).toBe(second);
    expect(closes).toBe(0);
    core.release(lease); await core.stop();
  });

  test("a second Hands server cannot race an active lease", async () => {
    const core = createBrokerCore(async () => ({ call: async () => reply, close: async () => {} }));
    const client = id(), lease = core.acquire(client).lease;
    expect(core.acquire(client).lease).toBe(lease);
    expect(() => core.acquire(id())).toThrow("another Hands server");
    core.release(lease);
    const next = core.acquire(id()).lease;
    await expect(core.call(lease, 1, id(), "browser_click", {})).rejects.toThrow("expired or disconnected");
    expect(next).not.toBe(lease);
    core.release(next); await core.stop();
  });

  test("lease expiry cancels input and a replacement waits for actual settlement", async () => {
    let now = 0, signal: AbortSignal | undefined;
    const entered = deferred<void>(), pending = deferred<typeof reply>();
    const core = createBrokerCore(async () => ({ call: async (_name, _args, inputSignal) => {
      signal = inputSignal; entered.resolve(); return pending.promise;
    }, close: async () => {} }), { now: () => now, leaseMs: 100 });
    const lease = core.acquire(id()).lease;
    const running = core.call(lease, 1, id(), "browser_click", {});
    await entered.promise;
    now = 101; core.expire();
    await expect(running).rejects.toThrow("cancelled");
    expect(signal?.aborted).toBe(true);
    expect(() => core.acquire(id())).toThrow("busy");
    pending.resolve(reply); await Bun.sleep(0);
    const next = core.acquire(id()).lease;
    core.release(next); await core.stop();
  });

  test("cancelled calls retain their hand lock, and independent hands can still read", async () => {
    const entered = deferred<void>(), pending = deferred<typeof reply>();
    const calls: number[] = [];
    const core = createBrokerCore(async (hand) => ({ call: async () => {
      calls.push(hand); if (hand === 1) { entered.resolve(); return pending.promise; } return reply;
    }, close: async () => {} }));
    const lease = core.acquire(id()).lease, request = id();
    const running = core.call(lease, 1, request, "browser_click", {});
    await entered.promise;
    core.cancel(lease, 1, request);
    await expect(running).rejects.toThrow("cancelled");
    await expect(core.call(lease, 1, id(), "browser_click", {})).rejects.toThrow("in flight");
    await core.call(lease, 2, id(), "get_window_state", {});
    expect(calls).toEqual([1, 2]);
    pending.resolve(reply); await Promise.resolve(); await Promise.resolve();
    core.release(lease); await core.stop();
  });

  test("timeout is bounded even if a driver ignores cancellation; no action is replayed", async () => {
    const pending = deferred<typeof reply>();
    let calls = 0;
    const core = createBrokerCore(async () => ({ call: async () => { calls++; return pending.promise; }, close: async () => {} }), { callMs: 5 });
    const lease = core.acquire(id()).lease, request = id();
    await expect(core.call(lease, 1, request, "browser_click", {})).rejects.toThrow("cancelled");
    await expect(core.call(lease, 1, request, "browser_click", {})).rejects.toThrow("Duplicate");
    expect(calls).toBe(1);
    pending.resolve(reply); await Promise.resolve(); await Promise.resolve();
    core.release(lease); await core.stop();
  });

  test("closed transports fail until an explicit new attachment obtains its session", async () => {
    let closed!: () => void, connections = 0;
    const core = createBrokerCore(async (_hand, onClosed) => { connections++; closed = onClosed; return { call: async () => reply, close: async () => {} }; });
    const lease = core.acquire(id()).lease, first = core.session(lease, 1);
    await core.call(lease, 1, id(), "get_browser_state", { session: first });
    closed();
    await expect(core.call(lease, 1, id(), "browser_click", { session: first })).rejects.toThrow("transport closed");
    expect(connections).toBe(1);
    const fresh = core.session(lease, 1);
    expect(fresh).not.toBe(first);
    await core.call(lease, 1, id(), "get_browser_state", { session: fresh });
    expect(connections).toBe(2);
    core.release(lease); await core.stop();
  });

  test("SDK immediate abort rejection keeps input quarantined until the owned process exits", async () => {
    const entered = deferred<void>(), exit = deferred<void>(), closing = deferred<void>();
    let actions = 0;
    const core = createBrokerCore(async () => ({
      call: async (_name, _args, signal) => {
        actions++; entered.resolve();
        return new Promise<typeof reply>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new UncertainCuaCall("SDK cancelled its promise")), { once: true }));
      },
      close: async () => { closing.resolve(); await exit.promise; },
    }));
    const lease = core.acquire(id()).lease, session = core.session(lease, 1), request = id();
    const running = core.call(lease, 1, request, "browser_click", { session });
    await entered.promise; core.cancel(lease, 1, request);
    await expect(running).rejects.toThrow("cancelled"); await closing.promise;
    expect(() => core.session(lease, 1)).toThrow("in flight");
    await expect(core.call(lease, 1, id(), "browser_click", {})).rejects.toThrow("in flight");
    core.release(lease);
    expect(() => core.acquire(id())).toThrow("busy");
    exit.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const next = core.acquire(id()).lease;
    await expect(core.call(next, 1, id(), "browser_click", { session })).rejects.toThrow("transport closed");
    expect(core.session(next, 1)).not.toBe(session);
    expect(actions).toBe(1);
    core.release(next); await core.stop();
  });

  test("SDK's own timeout quarantines input even before the broker cancellation timer", async () => {
    const exit = deferred<void>(), closing = deferred<void>();
    const core = createBrokerCore(async () => ({
      call: async () => { throw new UncertainCuaCall("SDK request timed out"); },
      close: async () => { closing.resolve(); await exit.promise; },
    }));
    const lease = core.acquire(id()).lease;
    const running = core.call(lease, 1, id(), "browser_click", {});
    await closing.promise;
    expect(() => core.session(lease, 1)).toThrow("in flight");
    await expect(core.call(lease, 1, id(), "browser_click", {})).rejects.toThrow("in flight");
    exit.resolve(); await expect(running).rejects.toThrow("SDK request timed out");
    await expect(core.call(lease, 1, id(), "browser_click", {})).rejects.toThrow("transport closed");
    core.release(lease); await core.stop();
  });

  test("unconfirmed shutdown retains quarantine instead of trusting a rejected SDK call", async () => {
    const core = createBrokerCore(async () => ({ call: async () => { throw new UncertainCuaCall("lost transport"); }, close: async () => { throw new Error("still alive"); } }));
    const lease = core.acquire(id()).lease;
    await expect(core.call(lease, 1, id(), "browser_click", {})).rejects.toThrow("quarantined");
    expect(() => core.session(lease, 1)).toThrow("in flight");
    core.release(lease);
    expect(() => core.acquire(id())).toThrow("busy");
    await expect(core.stop()).rejects.toThrow("cannot confirm");
  });
});

describe("broker client cancellation", () => {
  test("correction while queued prevents old input from dispatching", async () => {
    const entered = deferred<void>(), pending = deferred<typeof reply>();
    const names: string[] = [];
    const core = createBrokerCore(async () => ({ call: async (name) => { names.push(name); entered.resolve(); return pending.promise; }, close: async () => {} }));
    const client = createBrokerClient(wireFor(core)); await client.connect();
    const hand = client.hand(1, () => {}), controller = new AbortController();
    const first = hand.call("get_browser_state", {}); await entered.promise;
    const stale = hand.call("browser_click", {}, controller.signal);
    controller.abort(); pending.resolve(reply);
    await first; await expect(stale).rejects.toThrow();
    expect(names).toEqual(["get_browser_state"]);
    await hand.close(); await core.stop();
  });

  test("lost responses are surfaced once, never resent or silently re-prepared", async () => {
    let actions = 0;
    const core = createBrokerCore(async () => ({ call: async () => { actions++; return reply; }, close: async () => {} }));
    const wire = wireFor(core);
    const client = createBrokerClient(async <T>(route: string, data: unknown, signal?: AbortSignal): Promise<T> => {
      const value = await wire<T>(route, data, signal);
      if (route === "/call") throw new Error("Response connection lost after dispatch");
      return value;
    });
    await client.connect(); const hand = client.hand(1, () => {});
    await expect(hand.call("browser_click", {})).rejects.toThrow("connection lost");
    expect(actions).toBe(1);
    await hand.close(); await core.stop();
  });
});

describe("broker authentication and process identity", () => {
  test.skipIf(process.platform !== "win32")("Windows directory ACL setup works without WRITE_OWNER or module autoload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puk-broker-acl-"));
    try {
      const ps = join(process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      // The workspace grants Modify to this directory's owner, unlike a normal
      // temporary directory's FullControl. Setting its owner again requires
      // WRITE_OWNER; replacing just its DACL is allowed to the existing owner.
      const limited = "$p=$env:PUK_BROKER_PRIVATE_DIR; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $limited=[System.Security.AccessControl.DirectorySecurity]::new(); $limited.SetAccessRuleProtection($true,$false); $limited.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','ContainerInherit,ObjectInherit','None','Allow')); $limited.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl','ContainerInherit,ObjectInherit','None','Allow')); [System.IO.Directory]::SetAccessControl($p,$limited)";
      const inspect = "$actual=[System.IO.Directory]::GetAccessControl($p); if(!$actual.AreAccessRulesProtected){throw 'Inherited access was retained'}; if($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Wrong directory owner'}; $rules=$actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); if($rules.Count -ne 2){throw 'Unexpected directory access rules'}; foreach($rule in $rules){if($rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18') -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl'){throw 'Unexpected directory access'}}; [Console]::WriteLine('private-acl-ok')";
      const result = await promisify(execFile)(ps, ["-NoProfile", "-NonInteractive", "-Command", `$PSModuleAutoloadingPreference='None'; $ErrorActionPreference='Stop'; ${limited}; ${BROKER_DIRECTORY_ACL_SCRIPT}; ${BROKER_DIRECTORY_ACL_SCRIPT}; ${inspect}`], {
        windowsHide: true, timeout: 10_000, env: { ...subprocessEnv(), PUK_BROKER_PRIVATE_DIR: directory },
      });
      expect(result.stdout.trim()).toBe("private-acl-ok");
      expect(result.stderr).toBe("");
    } finally { await rmdir(directory); }
  }, 15_000);

  const identity = { root: "D:\\projects\\puk", runtime: "D:\\tools\\bun.exe", script: "D:\\projects\\puk\\win\\cua-broker.ts", source: "source-digest", driver: "C:\\Tools\\cua-driver.exe" };
  const state: BrokerState = { protocol: 1, port: 43123, pid: 123, boot: "12345678-abcd-abcd-abcd-123456789000", token: "a".repeat(64), identity };
  const request = (extra: Record<string, string> = {}, url = `http://127.0.0.1:${state.port}/call`) => new Request(url, { method: "POST", headers: {
    host: `127.0.0.1:${state.port}`, authorization: `Bearer ${state.token}`, "x-puk-broker": state.boot, ...extra,
  } });

  test("only authenticated loopback calls from the matching boot are accepted", () => {
    expect(brokerRequestAuthorized(request(), state)).toBe(true);
    const invalid: Record<string, string>[] = [{ authorization: "" }, { authorization: `Bearer ${"é".repeat(64)}` }, { "x-puk-broker": id() },
      { origin: "http://127.0.0.1:7777" }, { "sec-fetch-site": "same-site" }, { host: "localhost:43123" }];
    for (const extra of invalid) {
      expect(brokerRequestAuthorized(request(extra), state)).toBe(false);
    }
    expect(brokerRequestAuthorized(request({}, "http://example.test:43123/call"), state)).toBe(false);
  });

  test("state cannot redirect to a different checkout, driver, runtime or broker version", () => {
    expect(validateBrokerState(state, identity)).toBe(state);
    for (const key of ["root", "runtime", "script", "source", "driver"] as const) {
      expect(() => validateBrokerState({ ...state, identity: { ...identity, [key]: "wrong" } }, identity)).toThrow("identity");
    }
    for (const value of [{ ...state, protocol: 2 }, { ...state, port: 0 }, { ...state, pid: -1 }, { ...state, token: "short" }]) {
      expect(() => validateBrokerState(value, identity)).toThrow("identity");
    }
  });
});
