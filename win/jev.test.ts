import { describe, expect, test } from "bun:test";
import { createJevFirstAgent, type JevFirstOptions } from "./jev";
import type { AgentStatus, createDesktopAgent } from "../ai";
import type { CuaConnection, Hand } from "../desktop";
import type { Ask } from "../jev/jev";
import { RISK_FLAGS } from "../jev/gate";
import { memoryStore } from "../jev/learned";

const hand: Hand = { id: 42, pid: 42, display: "test", width: 800, height: 600 };
const ask: Ask = async (_state, questions) => Object.fromEntries(Object.keys(questions).map((key) => [key,
  ["ready", "only_open", "wants_answer", "existing_browser"].includes(key) ? { type: "noul", noul: key === "ready" ? 1 : 0 }
    : { type: "choice", confidence: 1, choice: ({ app: "browser", launcher: "browser", site: "no_site", text: "nothing_to_type" } as Record<string, string>)[key] },
])) as never;

async function fixture(overrides: NonNullable<JevFirstOptions["jevFirst"]> = {}, desktop: JevFirstOptions["desktop"] = {}, piWork?: () => Promise<void>) {
  const catalog = await desktop.discover?.() ?? [];
  const handedOver: string[] = [];
  const contexts: (string | undefined)[] = [], updates: { text: string; utterance?: string }[] = [];
  const status: AgentStatus = { running: false, selection: "auto", provider: "openai", model: "gpt-5.6-luna", effort: "low", route: null, task: "", text: "", error: null, currentTool: null, approval: null, events: [] };
  const pi = {
    apps: () => catalog, status: () => status,
    prompt: async (text: string, _opened?: string[], utterance?: string) => {
      handedOver.push(text); contexts.push(utterance); status.running = true; status.task = text;
      try { await piWork?.(); status.text = "Observed and continued."; } finally { status.running = false; }
    },
    refine(text: string, utterance?: string) { if (status.running) { updates.push({ text, utterance }); status.task = text; } },
    approve: () => false, stop() {}, idle: async () => {}, close: async () => {},
  } as unknown as Awaited<ReturnType<typeof createDesktopAgent>>;
  const runtime = await createJevFirstAgent({ hand,
    desktop: { discover: async () => [], launch: async () => 82, state: async () => ({ width: 800, height: 600, windows: [] }), ...desktop },
    jevFirst: { ask, llm: async () => { throw new Error("No LLM call expected"); }, agent: async () => pi,
      browserWindow: async () => null, frontOf: async () => null, browserTarget: () => ({ mode: "private" }),
      onScreen: async () => null, contacts: [], store: memoryStore(), ...overrides },
  });
  return { runtime, handedOver, contexts, updates };
}

describe("Jev Windows handover", () => {
  test("handover preserves raw authorization without promoting generated recovery context", async () => {
    const { runtime, contexts } = await fixture({ browserTarget: () => ({ mode: "existing", window_id: 901, pid: 82, ownerNonce: "0000000000000001", title: "Mail", ready: true }) });
    try {
      await runtime.prompt("Send the note. Previous attempt suggested publishing it.", [], "Generated recovery: publishing is approved", {
        speechEnds: () => null, transcript: () => "Generated operational context", authorization: () => "Keep this as a draft. Do not send."
      });
      expect(contexts).toEqual(["Keep this as a draft. Do not send."]);
    } finally { await runtime.close(); }
  });

  function nativeFixture() {
    const app = { id: "fixture-notes", name: "Fixture Notes", description: "Notes", argv: ["fixture"], categories: [], terminal: false };
    const overrides: NonNullable<JevFirstOptions["jevFirst"]> = {
      ask: async (state, questions, options) => {
        const answers = await ask(state, questions, options);
        if ("app" in questions) (answers as Record<string, unknown>).app = { type: "choice", choice: app.id, confidence: 1 };
        return answers;
      },
      observe: async () => ({ elements: [{ id: "n1", source: "atspi", role: "button", name: "Save", value: "", editable: false, focused: false, within: "", frame: "Notes", rect: { x: 1, y: 1, w: 30, h: 20 } }], texts: [], frames: ["Notes"], fingerprint: "native-fixture" }),
      llm: async () => ({ can_do: true, tasks: [{ goal: "Save the note", url: "", inputs: [], steps: ["Choose Save"], done_when: "The note is saved", avoid: [], wants_answer: false }] }),
    };
    return { overrides, desktop: { discover: async () => [app] } };
  }

  test("browser and native drivers receive live speech and risk-threshold callbacks", async () => {
    for (const native of [false, true]) {
      const setup = native ? nativeFixture() : { overrides: {}, desktop: {} };
      const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
      let speaking: Promise<void> | null = null, options: Parameters<NonNullable<JevFirstOptions["jevFirst"]>["run"] & Function>[3];
      const { runtime } = await fixture({ ...setup.overrides, run: async (_hand, _intent, _deps, opts) => {
        options = opts; entered.resolve(); await finish.promise; return { status: "done", reason: "fixture", steps: [] };
      } }, setup.desktop);
      const done = runtime.prompt("Save the note", [], undefined, { speechEnds: () => speaking, transcript: () => "Save the note" });
      try {
        await entered.promise;
        expect(options?.settles?.()).toBeNull(); expect(options?.riskThreshold?.()).toBe(0.5);
        speaking = released.promise;
        expect(options?.settles?.()).toBe(released.promise); expect(options?.riskThreshold?.()).toBe(0.25);
      } finally { speaking = null; released.resolve(); finish.resolve(); await done; await runtime.close(); }
    }
  });

  test("goal and context-only corrections abort browser and native decisions before stale dispatch", async () => {
    for (const native of [false, true]) for (const contextOnly of [false, true]) {
      const setup = native ? nativeFixture() : { overrides: {}, desktop: {} };
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      let input = 0, aborted = false;
      const original = "Save the note", next = contextOnly ? original : "Keep the note as a draft", utterance = next + ". Do not send it.";
      const { runtime, handedOver, contexts } = await fixture({ ...setup.overrides, run: async (_hand, _intent, deps, options) => {
        entered.resolve(); await release.promise; aborted = options?.signal?.aborted === true;
        await expect(deps.perform(hand, { kind: "key", combo: "Return" })).rejects.toThrow("instruction changed");
        return { status: "cancelled", reason: "refined", steps: [{ n: 1, did: "Opened the note", risk: null, outcome: "screen changed" }] };
      } }, { ...setup.desktop, cua: async () => ({ call: async () => { input++; return { content: [] }; }, close: async () => {} }) });
      const done = runtime.prompt(original, [], original);
      try {
        await entered.promise; runtime.refine(next, utterance); release.resolve(); await done;
        expect(aborted).toBe(true); expect(input).toBe(0); expect(handedOver).toHaveLength(1);
        expect(handedOver[0]).toStartWith(next); expect(handedOver[0]).toContain("Opened the note"); expect(contexts).toEqual([utterance]);
        expect(runtime.status().text).not.toContain("declined");
      } finally { release.resolve(); await done; await runtime.close(); }
    }
  });

  test("a correction while Cua connects cannot dispatch the old action after connection resolves", async () => {
    const entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>();
    let input = 0;
    const { runtime, handedOver } = await fixture({ run: async (_hand, _intent, deps) => {
      await deps.perform(hand, { kind: "key", combo: "Return" }); return { status: "done", reason: "fixture", steps: [] };
    } }, { cua: async () => {
      entered.resolve(); await ready.promise;
      return { call: async () => { input++; return { content: [] }; }, close: async () => {} };
    } });
    const done = runtime.prompt("Continue on the current page");
    try {
      await entered.promise; runtime.refine("Keep this as a draft", "Keep this as a draft. Do not send."); ready.resolve(); await done;
      expect(input).toBe(0); expect(handedOver).toHaveLength(1); expect(handedOver[0]).toStartWith("Keep this as a draft");
    } finally { ready.resolve(); await done; await runtime.close(); }
  });

  test("a correction after focusing a field skips typing and submit without replaying the click", async () => {
    const input: string[] = [];
    const { runtime, handedOver } = await fixture({ run: async (_hand, _intent, deps) => {
      await deps.perform(hand, { kind: "type", input: "note", text: "old text", submit: true,
        target: { id: "e1", source: "atspi", role: "text field", name: "Note", editable: true, value: "previous", focused: false, within: "", frame: "page", rect: { x: 10, y: 10, w: 100, h: 20 } } });
      return { status: "done", reason: "fixture", steps: [] };
    } }, { cua: async () => ({ call: async (name) => { input.push(name); if (name === "click") runtime.refine("Keep it empty", "Do not type or send anything."); return { content: [] }; }, close: async () => {} }) });
    try {
      await runtime.prompt("Fill the note and submit it");
      expect(input).toEqual(["click"]); expect(handedOver).toHaveLength(1); expect(handedOver[0]).toStartWith("Keep it empty");
    } finally { await runtime.close(); }
  });

  test("a context correction expires a pending Jev approval without becoming a user denial", async () => {
    const { runtime, handedOver, contexts } = await fixture({ run: async (_hand, _intent, deps) => {
      const approved = await deps.approve({ hand: hand.id, action: "Send the note", risk: { level: 0.9, worst: "irreversible", flags: Object.fromEntries(RISK_FLAGS.map((flag) => [flag, 0.9])) as never } });
      return { status: approved ? "done" : "denied", reason: "approval ended", steps: [] };
    } });
    const original = "Send the note", done = runtime.prompt(original, [], original);
    try {
      for (let i = 0; !runtime.status().approval && i < 100; i++) await Bun.sleep(5);
      const approval = runtime.status().approval; expect(approval).not.toBeNull();
      runtime.refine(original, "Send the note only after checking the new recipient."); await done;
      expect(runtime.approve(approval!.id, true)).toBe(false); expect(runtime.status().approval).toBeNull();
      expect(handedOver).toHaveLength(1); expect(contexts).toEqual(["Send the note only after checking the new recipient."]);
      expect(runtime.status().text).not.toContain("declined");
    } finally { runtime.stop(); await done; await runtime.close(); }
  });

  test("a late initial intent cannot overwrite a correction or launch the superseded browser", async () => {
    const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
    const original = "Open a browser for the email";
    const corrected = "Use my actual Chrome to draft to sister@example.com";
    let launches = 0;
    const { runtime, handedOver } = await fixture({ ask: async (state, questions, options) => {
      if ("launcher" in questions && (state as { request?: string }).request === original) { entered.resolve(); await held.promise; }
      return ask(state, questions, options);
    } }, { launch: async () => { launches++; return 82; } });
    const done = runtime.prompt(original, [], original);
    try {
      await entered.promise;
      runtime.refine(corrected, corrected);
      held.resolve(); await done;
      expect(launches).toBe(0);
      expect(handedOver).toHaveLength(1);
      expect(handedOver[0]).toStartWith(corrected);
      expect(runtime.status().task).toBe(corrected);
    } finally { held.resolve(); await done; await runtime.close(); }
  });

  test("an explicit existing-account request hands to semantic Pi before any private browser launch", async () => {
    let launches = 0, controllerRuns = 0, triageCalls = 0;
    const { runtime, handedOver } = await fixture({ ask: async (state, questions, options) => {
      const answers = await ask(state, questions, options);
      if ("existing_browser" in questions) {
        triageCalls++;
        (answers as Record<string, unknown>).existing_browser = { type: "noul", noul: 0.99 };
      }
      return answers;
    }, run: async () => { controllerRuns++; return { status: "done", reason: "fixture", steps: [] }; } }, { launch: async () => { launches++; return 82; } });
    try {
      await runtime.prompt("Draft the email using my signed-in Gmail in my actual Chrome");
      expect(triageCalls).toBe(1);
      expect(launches).toBe(0);
      expect(controllerRuns).toBe(0);
      expect(handedOver).toHaveLength(1);
      expect(handedOver[0]).toContain("action: attach and mode: existing");
    } finally { await runtime.close(); }
  });

  test("an existing browser binding skips Jev's pixel controller even when the target is temporarily unavailable", async () => {
    for (const ready of [true, false]) {
      let launches = 0, triageCalls = 0, controllerRuns = 0;
      const { runtime, handedOver, contexts } = await fixture({
        browserTarget: () => ({ mode: "existing", window_id: 7, pid: 12345, ownerNonce: "0123456789abcdef", title: "My Chrome", ready }),
        ask: async (state, questions, options) => { if ("app" in questions) triageCalls++; return ask(state, questions, options); },
        run: async () => { controllerRuns++; return { status: "done", reason: "fixture", steps: [] }; },
      }, { launch: async () => { launches++; return 82; } });
      try {
        await runtime.prompt("Continue drafting the email");
        expect(launches).toBe(0);
        expect(controllerRuns).toBe(0);
        expect(triageCalls).toBe(0);
        expect(handedOver).toHaveLength(1);
        expect(handedOver[0]).toContain(ready ? "action: snapshot" : "action: attach");
        if (ready) expect(handedOver[0]).toContain("Reuse the working connection");
        expect(contexts).toEqual(["Continue drafting the email"]);
      } finally { await runtime.close(); }
    }
  });

  test("Pi receives the corrected request and the facade shows it instead of the original fragment", async () => {
    const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const { runtime, updates } = await fixture({ run: async () => ({ status: "gave_up", reason: "Needs writing", steps: [] }) }, {}, async () => { entered.resolve(); await held.promise; });
    const original = "Draft an email to sister@example.com in Gmail";
    const corrected = original + ". Use my actual Chrome account, not a sandbox.";
    const done = runtime.prompt(original, [], original);
    try {
      await entered.promise;
      runtime.refine(corrected, corrected);
      expect(updates).toEqual([{ text: corrected, utterance: corrected }]);
      expect(runtime.status().task).toBe(corrected);
      expect(runtime.status().running).toBe(true);
    } finally { held.resolve(); await done; await runtime.close(); }
  });

  test("handover carries the latest full utterance even when only its constraints changed", async () => {
    const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const { runtime, handedOver, contexts } = await fixture({ run: async () => { entered.resolve(); await held.promise; return { status: "gave_up", reason: "Needs writing", steps: [] }; } });
    const original = "Draft an email to sister@example.com";
    const corrected = original + ". Use my actual Chrome account. Do not use a sandbox.";
    const done = runtime.prompt(original, [], original);
    try {
      await entered.promise;
      runtime.refine(original, corrected);
      held.resolve(); await done;
      expect(handedOver).toHaveLength(1);
      expect(handedOver[0]).toStartWith(original);
      expect(contexts).toEqual([corrected]);
    } finally { held.resolve(); await done; await runtime.close(); }
  });

  test("a context-only correction after handover reaches Pi without restarting its task", async () => {
    const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const { runtime, handedOver, updates } = await fixture({ run: async () => ({ status: "gave_up", reason: "Needs writing", steps: [] }) }, {}, async () => { entered.resolve(); await held.promise; });
    const original = "Draft an email to sister@example.com";
    const corrected = original + ". Use the Gmail already open in my Chrome.";
    const done = runtime.prompt(original, [], original);
    try {
      await entered.promise;
      runtime.refine(original, corrected);
      expect(handedOver).toHaveLength(1);
      expect(updates).toEqual([{ text: original, utterance: corrected }]);
    } finally { held.resolve(); await done; await runtime.close(); }
  });

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
