import { describe, expect, test } from "bun:test";
import { createJevFirstAgent, type JevFirstOptions } from "./jev";
import type { AgentStatus, createDesktopAgent } from "../ai";
import type { CuaConnection, Hand } from "../desktop";
import type { Ask } from "../jev/jev";
import { RISK_FLAGS } from "../jev/gate";

const hand: Hand = { id: 42, pid: 42, display: "test", width: 800, height: 600 };
const ask: Ask = async (_state, questions) => Object.fromEntries(Object.keys(questions).map((key) => [key,
  ["ready", "only_open", "wants_answer"].includes(key) ? { type: "noul", noul: key === "ready" ? 1 : 0 }
    : { type: "choice", confidence: 1, choice: ({ app: "browser", launcher: "browser", site: "no_site", text: "nothing_to_type" } as Record<string, string>)[key] },
])) as never;

async function fixture(overrides: NonNullable<JevFirstOptions["jevFirst"]> = {}, desktop: JevFirstOptions["desktop"] = {}) {
  const handedOver: string[] = [];
  const status: AgentStatus = { running: false, selection: "auto", provider: "openai", model: "gpt-5.6-luna", effort: "low", route: null, task: "", text: "", error: null, currentTool: null, approval: null, events: [] };
  const pi = {
    apps: () => [], status: () => status,
    prompt: async (text: string) => { handedOver.push(text); status.text = "Observed and continued."; },
    refine() {}, approve: () => false, stop() {}, idle: async () => {}, close: async () => {},
  } as unknown as Awaited<ReturnType<typeof createDesktopAgent>>;
  const runtime = await createJevFirstAgent({ hand,
    desktop: { discover: async () => [], launch: async () => 82, state: async () => ({ width: 800, height: 600, windows: [] }), ...desktop },
    jevFirst: { ask, llm: async () => { throw new Error("No LLM call expected"); }, agent: async () => pi,
      browserWindow: async () => null, frontOf: async () => null, ...overrides },
  });
  return { runtime, handedOver };
}

describe("Jev Windows handover", () => {
  test("unexpected browser and controller errors hand off with a fresh-observation instruction", async () => {
    for (const failure of ["browser", "controller"]) {
      const { runtime, handedOver } = await fixture(failure === "browser"
        ? { browserWindow: async () => { throw new Error("DevTools disconnected"); } }
        : { run: async () => { throw new Error("Unexpected Jev contract"); } });
      await runtime.prompt("Continue on the current page");
      expect(handedOver).toHaveLength(1);
      expect(handedOver[0]).toContain("controller error:");
      expect(handedOver[0]).toContain("fresh compact observation");
      expect(handedOver[0]).toContain("inspect its result before retrying");
      expect(runtime.status().error).toBeNull();
      await runtime.close();
    }
  });

  test("denied and cancelled results stop without asking Pi to try again", async () => {
    for (const status of ["denied", "cancelled"] as const) {
      const { runtime, handedOver } = await fixture({ run: async () => ({ status, reason: "Stopped", steps: [] }) });
      await runtime.prompt("Continue on the current page");
      expect(handedOver).toHaveLength(0);
      if (status === "denied") expect(runtime.status().text).toContain("declined");
      await runtime.close();
    }
  });

  test("declining a pending approval blocks fallback even if the controller then throws", async () => {
    const { runtime, handedOver } = await fixture({ run: async (_hand, _intent, deps) => {
      await deps.approve({ hand: hand.id, action: "Confirm the action", risk: { level: 0.9, worst: "irreversible", flags: Object.fromEntries(RISK_FLAGS.map((flag) => [flag, 0.9])) as never } });
      throw new Error("controller error after denial");
    } });
    const done = runtime.prompt("Continue on the current page");
    for (let i = 0; !runtime.status().approval && i < 100; i++) await Bun.sleep(5);
    const approval = runtime.status().approval;
    expect(approval).not.toBeNull();
    runtime.approve(approval!.id, false);
    await done;
    expect(handedOver).toHaveLength(0);
    expect(runtime.status().text).toContain("declined");
    await runtime.close();
  });

  test("stopping a running controller preserves cancellation when its in-flight operation fails", async () => {
    const entered = Promise.withResolvers<void>(), pending = Promise.withResolvers<never>();
    const { runtime, handedOver } = await fixture({ run: async () => { entered.resolve(); return pending.promise; } });
    const done = runtime.prompt("Continue on the current page");
    await entered.promise;
    runtime.stop(); pending.reject(new Error("connection closed"));
    await done;
    expect(handedOver).toHaveLength(0);
    expect(runtime.status().error).toBeNull();
    await runtime.close();
  });

  test("Jev discards a rejected facade promise before the next attempted input", async () => {
    let attempts = 0;
    const failures: string[] = [];
    const { runtime } = await fixture({ run: async (_hand, _intent, deps) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await deps.perform!(hand, { kind: "key", combo: "Return" }); }
        catch (error) { failures.push((error as Error).message); }
      }
      return { status: "done", reason: "fixture complete", steps: [] };
    } }, { cua: async () => {
      if (++attempts === 1) throw new Error("connect failed");
      return { call: async () => { throw new Error("new connection reached"); }, close: async () => {} } as CuaConnection;
    } });
    await runtime.prompt("Continue on the current page");
    expect(attempts).toBe(2);
    expect(failures).toEqual(["connect failed", "new connection reached"]);
    await runtime.close();
  });
});
