import { describe, expect, test } from "bun:test";
import { checkAction, ComputerSchema, createDesktopAgent, providerModel, runBash, routeTask, routeCandidates, decideWithJev, EffortSchema, type RouteDecision, type Fetch, type GateContext, type GateResult } from "./ai";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { CuaConnection, Hand, InstalledApp } from "./desktop";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { planAppOpen } from "./evals";
import { tmpdir } from "node:os";

const context: GateContext = {
  task: "Read the documentation",
  observation: "The documentation is open in a browser.",
  action: { type: "scroll", x: 200, y: 200, dy: 5, description: "Scroll the page" },
};

function answer(noul: unknown, type = "noul"): Fetch {
  return async () => Response.json({ answers: { requires_approval: { type, noul }, contradicts_user: { type: "noul", noul: 0 } } });
}

describe("Jev action gate", () => {
  test("sends the actual action and context to the documented endpoint", async () => {
    let url: unknown;
    let request: RequestInit | undefined;
    const result = await checkAction(context, {
      apiKey: "test-key",
      fetch: async (input, init) => {
        url = input;
        request = init;
        return answer(0.01)(input, init);
      },
    });
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(request?.headers).get("Authorization")).toBe("Bearer test-key");
    expect(new Headers(request?.headers).get("Content-Type")).toBe("application/json");
    const body = JSON.parse(request!.body as string);
    expect(body.state).toEqual(context);
    expect(body.questions.requires_approval.type).toBe("noul");
    expect(result).toMatchObject({ decision: "allow", risk: 0.01 });
  });

  test("holds actions at or above the threshold for approval", async () => {
    for (const risk of [0.5, 0.99, 1]) {
      expect((await checkAction(context, { apiKey: "test", fetch: answer(risk) })).decision).toBe("approval");
    }
    expect((await checkAction(context, { apiKey: "test", fetch: answer(0.49) })).decision).toBe("allow");
  });

  test("cancellation blocks even when the proposed action has low side-effect risk", async () => {
    const verdict = await checkAction({ ...context, task: "Do not scroll" }, { apiKey: "test", fetch: async () => Response.json({ answers: { requires_approval: { type: "noul", noul: 0.01 }, contradicts_user: { type: "noul", noul: 0.99 } } }) });
    expect(verdict.decision).toBe("blocked");
  });

  test("malformed responses cannot clear an action", async () => {
    for (const risk of [null, undefined, "0.01", -1, 1.1]) {
      expect((await checkAction(context, { apiKey: "test", fetch: answer(risk) })).decision).toBe("blocked");
    }
    expect((await checkAction(context, { apiKey: "test", fetch: answer(0.01, "choice") })).decision).toBe("blocked");
  });

  test("missing credentials, context, and invalid thresholds fail closed", async () => {
    const unexpected: Fetch = async () => { throw new Error("must not call provider"); };
    expect((await checkAction(context, { apiKey: "", fetch: unexpected })).decision).toBe("blocked");
    expect((await checkAction({ ...context, observation: "" }, { apiKey: "test", fetch: unexpected })).decision).toBe("blocked");
    for (const threshold of [0, -1, 1.1, NaN]) {
      expect((await checkAction(context, { apiKey: "test", threshold, fetch: unexpected })).decision).toBe("blocked");
    }
  });

  test("timeouts and HTTP errors never expose credentials or execute an action", async () => {
    const secret = "private-test-credential";
    const http = await checkAction(context, { apiKey: secret, fetch: async () => new Response(secret, { status: 401 }) });
    const network = await checkAction(context, { apiKey: secret, fetch: async () => { throw new Error(secret); } });
    expect(http.decision).toBe("blocked");
    expect(http.reason).toContain("401");
    expect(network.decision).toBe("blocked");
    expect(JSON.stringify([http, network])).not.toContain(secret);
  });
});

const hand: Hand = { id: 99, pid: 99999, display: "wayland-test", width: 800, height: 600 };
const notes: InstalledApp = { id: "writer.desktop", name: "Local Writer", description: "Notes and Markdown", categories: ["Office"], argv: ["writer"], terminal: false };
const allow: GateResult = { decision: "allow", risk: 0.01, reason: "Allowed" };

function scriptedModel(calls: { name: string; arguments: Record<string, unknown> }[]): StreamFn {
  let turn = 0;
  return (model) => {
    const stream = createAssistantMessageEventStream();
    const call = calls[turn++];
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: call ? "toolUse" : "stop", content: call ? [{ type: "toolCall", id: `call-${turn}`, ...call }] : [{ type: "text", text: "Done." }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: message });
    if (!call) stream.push({ type: "text_delta", contentIndex: 0, delta: "Done.", partial: message });
    stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
    return stream;
  };
}

const fixedRoute: typeof routeTask = async (_task, candidates) => ({ ...candidates.find((c) => c.difficulty === "standard")!, confidence: 1, latencyMs: 0, fallback: false, reason: "Test fixture" });
const fakeDesktop = { discover: async () => [notes], state: async () => ({ width: 800, height: 600, windows: [] }) };
function fakeCua(input: (name: string, args: Record<string, unknown>) => void | Promise<void> = () => {}): () => Promise<CuaConnection> {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20);
  return async () => ({
    async call(name, args = {}) {
      if (name === "get_desktop_state") return { content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }] };
      await input(name, args);
      return { content: [{ type: "text", text: "Input delivered" }] };
    },
    async close() {},
  });
}
async function until(check: () => boolean) {
  for (let i = 0; !check() && i < 200; i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

describe("Pi agent runtime", () => {
  test("screenshots do not consume the action budget and a click executes through the gate", async () => {
    const commands: { name: string; args: Record<string, unknown> }[] = [];
    const checked: GateContext[] = [];
    const calls = [
      ...Array.from({ length: 31 }, () => ({ name: "computer", arguments: { action: "screenshot" } })),
      { name: "computer", arguments: { action: "click", x: 150, y: 120, description: "Focus the empty document" } },
    ];
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
      desktop: { ...fakeDesktop, cua: fakeCua((name, args) => { commands.push({ name, args }); }) },
      gate: async (ctx) => { checked.push(ctx); return allow; }, streamFn: scriptedModel(calls),
    });
    await runtime.prompt("Inspect and focus the document.");
    expect(checked).toHaveLength(1);
    expect(commands).toEqual([{ name: "click", args: { target: { kind: "desktop", display_id: "primary" }, delivery_mode: "foreground", x: 150, y: 120, button: "left" } }]);
    expect(runtime.status().error).toBeNull();
  });

  test("a desktop resized while the gate runs rejects stale coordinates before input", async () => {
    let resized = false, inputs = 0;
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
      desktop: { ...fakeDesktop, cua: fakeCua(() => { inputs++; }), state: async () => ({ width: resized ? 1280 : 800, height: 600, windows: [] }) },
      gate: async () => { resized = true; return allow; },
      streamFn: scriptedModel([{ name: "computer", arguments: { action: "screenshot" } }, { name: "computer", arguments: { action: "click", x: 100, y: 100, description: "Focus document" } }]),
    });
    await runtime.prompt("Focus the document.");
    expect(inputs).toBe(0);
    expect(JSON.stringify(runtime.agent.state.messages)).toContain("fresh screenshot");
  });

  test("a long spoken turn preserves its final constraints without exceeding the task input limit", async () => {
    const goal = `Read ${"a".repeat(9000)}`;
    const utterance = `${goal}. Keep all existing notes unchanged.`;
    const checked: GateContext[] = [];
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
      desktop: { ...fakeDesktop, launch: async () => 123 },
      gate: async (context) => { checked.push(context); return allow; },
      streamFn: scriptedModel([{ name: "open_app", arguments: { id: notes.id } }]),
    });
    await runtime.prompt(goal, [], utterance);
    expect(runtime.status().error).toBeNull();
    expect(checked).toHaveLength(1);
    expect(checked[0]!.task).toContain("Complete only this task");
    expect(checked[0]!.task.endsWith(utterance)).toBe(true);
    expect(JSON.stringify(runtime.agent.state.messages)).toContain("Keep all existing notes unchanged.");
  });

  test("all three providers resolve to their native Pi transports", () => {
    expect(providerModel("openai")).toMatchObject({ id: "gpt-5.6-luna", api: "openai-responses", thinkingLevelMap: { low: "low", medium: "medium", high: "high" } });
    expect(providerModel("anthropic")).toMatchObject({ id: "claude-sonnet-5", api: "anthropic-messages", compat: { forceAdaptiveThinking: true } });
    expect(providerModel("gemini", "gemini-3.8-flash", "ai-studio").api).toBe("google-generative-ai");
    expect(providerModel("gemini", "gemini-3.8-flash", "vertex").api).toBe("google-vertex");
  });

  test("executes a real Bash tool and feeds its result into the Pi conversation", async () => {
    const checked: GateContext[] = [];
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute, desktop: fakeDesktop, gate: async (ctx) => { checked.push(ctx); return allow; }, streamFn: scriptedModel([{ name: "bash", arguments: { command: "printf PUK_BASH_OK" } }]) });
    await runtime.prompt("Check Bash with printf.");
    const results = runtime.agent.state.messages.filter((m) => m.role === "toolResult");
    expect(JSON.stringify(results)).toContain("PUK_BASH_OK");
    expect(checked[0]?.action).toMatchObject({ tool: "bash", args: { command: "printf PUK_BASH_OK" } });
    expect(runtime.status()).toMatchObject({ running: false, error: null });
    expect(runtime.status().text).toContain("Done.");
  });

  test("gate failures prevent execution and cannot be bypassed on another turn", async () => {
    let executed = false;
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute, desktop: { ...fakeDesktop, bash: async () => { executed = true; throw new Error("must not execute"); } }, gate: async () => ({ decision: "blocked", risk: null, reason: "Jev unavailable" }), streamFn: scriptedModel([{ name: "bash", arguments: { command: "echo should-not-run" } }]) });
    await runtime.prompt("A task");
    expect(executed).toBe(false);
    expect(runtime.status().error).toBe("Jev unavailable");
  });

  test("approval is tied to the exact pending tool and cancellation releases it", async () => {
    const opened: string[] = [];
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute, desktop: { ...fakeDesktop, launch: async (_hand, app) => { opened.push(app.id); return 123; } }, gate: async () => ({ decision: "approval", risk: 0.9, reason: "Review" }), streamFn: scriptedModel([{ name: "open_app", arguments: { id: notes.id } }]) });
    const pending = runtime.prompt("Open the writer");
    await until(() => Boolean(runtime.status().approval));
    const approval = runtime.status().approval!;
    expect(approval.args).toEqual({ id: notes.id });
    expect(runtime.approve("wrong-id", true)).toBe(false);
    expect(opened).toEqual([]);
    expect(runtime.approve(approval.id, true)).toBe(true);
    await pending;
    expect(opened).toEqual([notes.id]);
    expect(runtime.approve(approval.id, true)).toBe(false);

    const cancelled = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute, desktop: fakeDesktop, gate: async () => ({ decision: "approval", risk: 0.9, reason: "Review" }), streamFn: scriptedModel([{ name: "bash", arguments: { command: "echo never" } }]) });
    const running = cancelled.prompt("Another task");
    await until(() => Boolean(cancelled.status().approval));
    cancelled.stop();
    await running;
    expect(cancelled.status()).toMatchObject({ running: false, approval: null });
  });

  test("app launches include the discovered command in the gate and reject unknown ids", async () => {
    const checked: GateContext[] = [];
    let launched = 0;
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
      desktop: { ...fakeDesktop, launch: async () => ++launched }, gate: async (ctx) => { checked.push(ctx); return allow; },
      streamFn: scriptedModel([{ name: "open_app", arguments: { id: notes.id } }, { name: "open_app", arguments: { id: "invented.desktop" } }]),
    });
    await runtime.prompt("Open notes");
    expect(checked[0]?.action).toMatchObject({ installedApp: { argv: ["writer"] } });
    expect(launched).toBe(1);
    expect(JSON.stringify(runtime.agent.state.messages)).toContain("Unknown application");
  });

  test("a provider abort caused by Stop is not reported as a bad API key", async () => {
    let ready = false;
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute, desktop: fakeDesktop,
      streamFn: (model, _context, opts) => {
        const stream = createAssistantMessageEventStream();
        const aborted: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: "error", errorMessage: "Request aborted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        opts?.signal?.addEventListener("abort", () => stream.push({ type: "error", reason: "error", error: aborted }), { once: true });
        ready = true; return stream;
      },
    });
    const pending = runtime.prompt("Wait for a response");
    await until(() => ready); runtime.stop(); await pending;
    expect(runtime.status()).toMatchObject({ running: false, error: null });
  });
});

describe("Cua held drawing strokes", () => {
  const window = { app: "paint", title: "Untitled — Paint", focused: true, pid: 12345, containerId: 7 };
  const native = { app_name: "paint", title: "Untitled — Paint [paint]", pid: null, window_id: 4278190080 };
  const state = () => ({ width: 800, height: 600, windows: [{ ...window }] });
  const target = { pid: 12345, window_id: 4278190080 };
  const strokes = [[{ x: 100, y: 100 }, { x: 200, y: 160 }, { x: 220, y: 80 }], [{ x: 300, y: 250 }, { x: 330, y: 260 }]];
  const calls = [
    { name: "computer", arguments: { action: "screenshot" } },
    { name: "computer", arguments: { action: "draw", strokes, description: "Draw two pencil strokes in the blank Paint canvas." } },
  ];
  function drawingCua(input: Parameters<typeof fakeCua>[0], windows = [native], close = async () => {}) {
    return async (): Promise<CuaConnection> => {
      const driver = await fakeCua(input)();
      return { ...driver, close, call: async (name, args, signal) => name === "list_windows"
        ? { content: [], structuredContent: { windows } }
        : driver.call(name, args, signal) };
    };
  }
  const desktop = { ...fakeDesktop, state: async () => state() };

  test("one exact Jev check executes multiple continuous paths without model turns between points", async () => {
    const checked: GateContext[] = [], input: { name: string; args: Record<string, unknown> }[] = [];
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
      desktop: { ...desktop, cua: drawingCua((name, args) => { input.push({ name, args }); }) },
      gate: async (context) => { checked.push(context); return allow; }, streamFn: scriptedModel(calls),
    });
    await runtime.prompt("Draw two lines freehand in Paint.");
    expect(checked).toHaveLength(1);
    expect(checked[0]!.action).toMatchObject({ tool: "computer", args: { action: "draw", strokes } });
    expect(input.map((c) => c.name)).toEqual(["mouse_button_down", "mouse_drag", "mouse_drag", "mouse_button_up", "mouse_button_down", "mouse_drag", "mouse_button_up"]);
    expect(input[0]!.args).toEqual({ ...target, x: 100, y: 100, button: "left" });
    expect(input[1]!.args).toMatchObject({ ...target, x: 200, y: 160 });
    expect(input[3]!.args).toEqual(target);
    expect(runtime.agent.state.messages.filter((m) => m.role === "assistant")).toHaveLength(3);
    expect(runtime.status().error).toBeNull();
  });

  test("blocked plans do not press the pointer", async () => {
    const input: string[] = [];
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
      desktop: { ...desktop, cua: drawingCua((name) => { input.push(name); }) },
      gate: async () => ({ decision: "blocked", risk: 1, reason: "Drawing was cancelled." }), streamFn: scriptedModel(calls),
    });
    await runtime.prompt("Do not draw.");
    expect(input).toEqual([]);
    expect(runtime.status().error).toBe("Drawing was cancelled.");
  });

  test("rejects out-of-frame coordinates and ambiguous native windows before pressing", async () => {
    for (const ambiguous of [false, true]) {
      const input: string[] = [];
      const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
        desktop: { ...desktop, cua: drawingCua((name) => { input.push(name); }, ambiguous ? [native, { ...native, window_id: 123 }] : [native]) },
        gate: async () => allow,
        streamFn: scriptedModel([calls[0]!, { name: "computer", arguments: { action: "draw", strokes: ambiguous ? strokes : [[{ x: 100, y: 100 }, { x: 800, y: 120 }]] } }]),
      });
      await runtime.prompt("Draw in the canvas.");
      expect(input).toEqual([]);
      expect(JSON.stringify(runtime.agent.state.messages)).toContain(ambiguous ? "unambiguously" : "inside the current screenshot");
    }
  });

  test("Zod bounds the batch, stroke lengths, and coordinates", () => {
    for (const value of [
      { strokes: Array.from({ length: 9 }, () => strokes[0]) },
      { strokes: [Array.from({ length: 33 }, () => ({ x: 100, y: 100 }))] },
      { strokes: [[{ x: 1, y: 2 }]] },
      { strokes: [[{ x: 1, y: 2 }, { x: -1, y: 20 }]] },
      { strokes: [[{ x: 1, y: 2 }, { x: NaN, y: 20 }]] },
    ]) expect(ComputerSchema.safeParse({ action: "draw", ...value }).success).toBe(false);
    expect(ComputerSchema.safeParse({ action: "draw", strokes }).success).toBe(true);
  });

  test("releases immediately and skips remaining points after Stop, refinement, or resize", async () => {
    for (const change of ["stop", "refine", "resize"] as const) {
      const input: string[] = [];
      let resized = false;
      const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
        desktop: { ...desktop, state: async () => ({ ...state(), width: resized ? 900 : 800 }),
          cua: drawingCua((name) => {
            input.push(name);
            if (name === "mouse_drag") {
              if (change === "stop") runtime.stop();
              else if (change === "refine") runtime.refine("Stop drawing and just inspect the canvas");
              else resized = true;
            }
          }),
        }, gate: async () => allow, streamFn: scriptedModel(calls),
      });
      await runtime.prompt("Draw in the canvas.");
      expect(input).toEqual(["mouse_button_down", "mouse_drag", "mouse_button_up"]);
      expect(runtime.status().running).toBe(false);
    }
  });

  test("releases after a failed movement and closes Cua if release cannot be confirmed", async () => {
    for (const releaseFails of [false, true]) {
      const input: string[] = [];
      let closed = 0;
      const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
        desktop: { ...desktop, cua: drawingCua((name) => {
          input.push(name);
          if (name === "mouse_drag" || (name === "mouse_button_up" && releaseFails)) throw new Error("Fixture input error");
        }, [native], async () => { closed++; }) }, gate: async () => allow, streamFn: scriptedModel(calls),
      });
      await runtime.prompt("Draw in the canvas.");
      expect(input).toEqual(["mouse_button_down", "mouse_drag", "mouse_button_up"]);
      expect(closed).toBe(releaseFails ? 1 : 0);
      expect(JSON.stringify(runtime.agent.state.messages)).toContain(releaseFails ? "connection was closed" : "Fixture input error");
    }
  });
});

describe("Cua input batches", () => {
  const window = { app: "paint", title: "Paint colors", focused: true, pid: 12345, containerId: 7 };
  const state = () => ({ width: 800, height: 600, windows: [{ ...window }] });
  const desktop = { ...fakeDesktop, state: async () => state() };
  const steps = [
    { action: "click", x: 140, y: 160 },
    { action: "key", key: "ctrl+a" },
    { action: "type", text: "140" },
    { action: "key", key: "tab" },
    { action: "type", text: "0" },
  ];
  const calls = (actions = steps) => [
    { name: "computer", arguments: { action: "screenshot" } },
    { name: "computer", arguments: { action: "batch", actions, description: "Fill the already visible color fields." } },
  ];

  test("one gate checks the exact batch, executes inputs in order, and returns one final screenshot", async () => {
    const checked: GateContext[] = [], inputs: { name: string; args: Record<string, unknown> }[] = [];
    let screenshots = 0;
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
      desktop: { ...desktop, cua: async () => {
        const driver = await fakeCua((name, args) => { inputs.push({ name, args }); })();
        return { ...driver, call: async (name, args, signal) => { if (name === "get_desktop_state") screenshots++; return driver.call(name, args, signal); } };
      } }, gate: async (ctx) => { checked.push(ctx); return allow; }, streamFn: scriptedModel(calls()),
    });
    await runtime.prompt("Set the color fields.");
    expect(checked).toHaveLength(1);
    expect(checked[0]!.action).toMatchObject({ tool: "computer", args: { action: "batch", actions: steps } });
    expect(inputs.map((c) => c.name)).toEqual(["click", "hotkey", "type_text", "press_key", "type_text"]);
    expect(inputs[0]!.args).toEqual({ target: { kind: "desktop", display_id: "primary" }, delivery_mode: "foreground", x: 140, y: 160, button: "left" });
    expect(inputs[1]!.args.keys).toEqual(["ctrl", "a"]);
    expect(inputs[2]!.args.text).toBe("140");
    expect(inputs[3]!.args.key).toBe("tab");
    expect(inputs[4]!.args.text).toBe("0");
    expect(screenshots).toBe(2);
    expect(runtime.agent.state.messages.filter((m) => m.role === "assistant")).toHaveLength(3);
    expect(runtime.status().events.some((e) => e.text === "Running computer: batch (5 steps)")).toBe(true);
  });

  test("an invalid later step rejects the whole batch before its first effect", async () => {
    const invalid = [
      { action: "click", x: 800, y: 120 },
      { action: "click", x: 0, y: 0 },
      { action: "click", x: 5 },
      { action: "key", key: "ctrl+" },
      { action: "scroll", x: 10, y: 10, dy: 0 },
      { action: "type" },
      { action: "batch", actions: steps },
      { action: "draw", strokes: [[{ x: 10, y: 10 }, { x: 20, y: 20 }]] },
      { action: "bash", command: "true" },
    ];
    for (const step of invalid) {
      const input: string[] = [];
      const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
        desktop: { ...desktop, cua: fakeCua((name) => { input.push(name); }) }, gate: async () => allow,
        streamFn: scriptedModel([calls()[0]!, { name: "computer", arguments: { action: "batch", actions: [steps[0], step] } }]),
      });
      await runtime.prompt("Set the color fields.");
      expect(input).toEqual([]);
    }
    expect(ComputerSchema.safeParse({ action: "batch", actions: Array.from({ length: 9 }, () => steps[0]) }).success).toBe(false);
    expect(ComputerSchema.safeParse({ action: "batch", actions: [] }).success).toBe(false);
  });

  test("single clicks also reject the native zero-coordinate trap", async () => {
    const input: Record<string, unknown>[] = [];
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
      desktop: { ...desktop, cua: fakeCua((_name, args) => { input.push(args); }) }, gate: async () => allow,
      streamFn: scriptedModel([calls()[0]!, { name: "computer", arguments: { action: "click", x: 0, y: 0 } }, { name: "computer", arguments: { action: "click", x: 0, y: 1 } }]),
    });
    await runtime.prompt("Click the top left control.");
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ x: 0, y: 1 });
    expect(JSON.stringify(runtime.agent.state.messages)).toContain("maps click (0,0) to the screen center");
  });

  test("stops remaining steps on cancellation, refinement, resize, or focus change and invalidates stale input", async () => {
    for (const change of ["stop", "refine", "resize", "focus"] as const) {
      const input: string[] = [];
      let changed = false;
      const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
        desktop: { ...desktop, state: async () => ({ ...state(), width: changed && change === "resize" ? 900 : 800,
          windows: [{ ...window, containerId: changed && change === "focus" ? 8 : 7 }] }),
          cua: fakeCua((name) => {
            input.push(name);
            changed = true;
            if (change === "stop") runtime.stop();
            if (change === "refine") runtime.refine("Stop changing colors; inspect the existing drawing.");
          }),
        }, gate: async () => allow,
        streamFn: scriptedModel([...calls(), { name: "computer", arguments: { action: "type", text: "must not run without a new screenshot" } }]),
      });
      await runtime.prompt("Set the color fields.");
      expect(input).toEqual(["click"]);
      expect(runtime.status().running).toBe(false);
      if (change !== "stop") expect(JSON.stringify(runtime.agent.state.messages)).toContain("Batch stopped after 1/5 steps");
    }
  });

  test("a failed step preserves the completed prefix and does not attempt later inputs", async () => {
    const input: string[] = [];
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
      desktop: { ...desktop, cua: fakeCua((name) => { input.push(name); if (name === "hotkey") throw new Error("Fixture keyboard failed"); }) },
      gate: async () => allow, streamFn: scriptedModel(calls()),
    });
    await runtime.prompt("Set the color fields.");
    expect(input).toEqual(["click", "hotkey"]);
    expect(JSON.stringify(runtime.agent.state.messages)).toContain("Batch stopped after 1/5 steps");
  });

  test("a gate block prevents every step", async () => {
    const input: string[] = [];
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
      desktop: { ...desktop, cua: fakeCua((name) => { input.push(name); }) },
      gate: async () => ({ decision: "blocked", risk: 1, reason: "The user cancelled this batch." }), streamFn: scriptedModel(calls()),
    });
    await runtime.prompt("Leave the colors alone.");
    expect(input).toEqual([]);
    expect(runtime.status().error).toBe("The user cancelled this batch.");
  });
});

describe("Pi work during live speech", () => {
  function speech() {
    let speaking = true;
    const ended = Promise.withResolvers<void>();
    return { live: { speechEnds: () => speaking ? ended.promise : null, transcript: () => "Open notes" },
      end() { speaking = false; ended.resolve(); } };
  }

  test("runs reversible work before release, then stays available for refinements", async () => {
    const speaking = speech();
    let opened = 0;
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
      desktop: { ...fakeDesktop, launch: async () => ++opened }, gate: async () => allow,
      streamFn: scriptedModel([{ name: "open_app", arguments: { id: notes.id } }]),
    });
    const pending = runtime.prompt("Open notes", [], "Open notes", speaking.live);
    await until(() => opened === 1 && runtime.agent.state.isStreaming === false);
    expect(runtime.status().running).toBe(true);
    runtime.refine("Open notes and draft a plan", "Open notes and draft a plan");
    await until(() => JSON.stringify(runtime.agent.state.messages).includes("draft a plan"));
    speaking.end(); await pending;
    expect(opened).toBe(1);
    expect(runtime.status()).toMatchObject({ running: false, error: null });
  });

  test("an update while the initial model is being selected replaces its first instruction", async () => {
    const routed = Promise.withResolvers<void>(), speaking = speech();
    let context = "";
    const model = scriptedModel([]);
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test",
      router: async (...args) => { await routed.promise; return fixedRoute(...args); }, desktop: fakeDesktop,
      streamFn: (...args) => { context = JSON.stringify(args[1]); return model(...args); },
    });
    const pending = runtime.prompt("Open notes", [], "Open notes", speaking.live);
    runtime.refine("Open files instead", "Open files instead");
    routed.resolve(); speaking.end(); await pending;
    expect(context).toContain("Open files instead");
    expect(context).not.toContain('"text":"Open notes"');
    expect(runtime.status().error).toBeNull();
  });

  test("Jev can raise the model and effort when a live task becomes harder", async () => {
    const speaking = speech();
    const seen: { model: string; effort: unknown }[] = [];
    const model = scriptedModel([]);
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", desktop: fakeDesktop,
      router: async (text, candidates) => ({ ...candidates.find((c) => c.difficulty === (text.includes("debug") ? "complex" : "routine"))!, confidence: 1, latencyMs: 0, fallback: false, reason: "Fixture" }),
      streamFn: (selected, context, options) => { seen.push({ model: selected.id, effort: options?.reasoning }); return model(selected, context, options); },
    });
    const pending = runtime.prompt("Open notes", [], "Open notes", speaking.live);
    await until(() => seen.length === 1);
    runtime.refine("Open notes and debug the subtle concurrency bug described there");
    await until(() => seen.length === 2);
    expect(seen).toEqual([{ model: "gpt-5.6-luna", effort: "low" }, { model: "gpt-6-astra", effort: "high" }]);
    speaking.end(); await pending;
    expect(runtime.status()).toMatchObject({ model: "gpt-6-astra", effort: "high", error: null });
  });

  test("an obsolete action cannot execute after an update arrives during its gate", async () => {
    const speaking = speech(), verdict = Promise.withResolvers<GateResult>();
    const files = { ...notes, id: "files.desktop", name: "Files" };
    let checking = false;
    const launched: string[] = [];
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
      desktop: { ...fakeDesktop, discover: async () => [notes, files], launch: async (_hand, app) => { launched.push(app.id); return 1; } },
      gate: async () => { if (!checking) { checking = true; return verdict.promise; } return allow; },
      streamFn: scriptedModel([{ name: "open_app", arguments: { id: notes.id } }, { name: "open_app", arguments: { id: files.id } }]),
    });
    const pending = runtime.prompt("Open notes", [], "Open notes", speaking.live);
    await until(() => checking); runtime.refine("Open files instead"); verdict.resolve(allow);
    await until(() => launched.length === 1);
    expect(launched).toEqual([files.id]);
    speaking.end(); await pending;
    expect(runtime.status().error).toBeNull();
  });

  test("a consequential action waits for release, is rechecked and requires its exact approval", async () => {
    const speaking = speech();
    const thresholds: (number | undefined)[] = [];
    let executed = 0;
    const review: GateResult = { decision: "approval", risk: 0.9, reason: "Review action" };
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
      desktop: { ...fakeDesktop, launch: async () => ++executed },
      gate: async (_ctx, options) => { thresholds.push(options.threshold); return review; },
      streamFn: scriptedModel([{ name: "open_app", arguments: { id: notes.id } }]),
    });
    const pending = runtime.prompt("Open notes", [], "Open notes", speaking.live);
    await until(() => runtime.status().currentTool === "Waiting for the completed instruction");
    expect(runtime.status().approval).toBeNull(); expect(executed).toBe(0);
    speaking.end(); await until(() => Boolean(runtime.status().approval));
    expect(thresholds).toEqual([0.25, undefined]);
    const id = runtime.status().approval!.id;
    expect(runtime.approve(id, true)).toBe(true); await pending;
    expect(executed).toBe(1); expect(runtime.approve(id, true)).toBe(false);
  });

  test("a revision expires an existing approval and Stop releases a worker waiting for speech", async () => {
    const speaking = speech();
    let opened = 0;
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute,
      desktop: { ...fakeDesktop, launch: async () => ++opened },
      gate: async () => ({ decision: "approval", risk: 0.9, reason: "Review" }),
      streamFn: scriptedModel([{ name: "open_app", arguments: { id: notes.id } }]),
    });
    const pending = runtime.prompt("Open notes", [], "Open notes", speaking.live);
    await until(() => runtime.status().currentTool === "Waiting for the completed instruction");
    runtime.refine("Just describe the notes app; do not open it");
    await until(() => JSON.stringify(runtime.agent.state.messages).includes("Just describe"));
    expect(opened).toBe(0); expect(runtime.status().approval).toBeNull();
    runtime.stop(); await pending; await runtime.close();
    expect(runtime.status()).toMatchObject({ running: false, error: null });
  });
});

describe("Bash lifetime and output", () => {
  test("strips provider keys and sets the nested desktop environment", async () => {
    const result = await runBash(hand, 'printf "%s|%s|%s|%s" "${OAI-unset}" "$WAYLAND_DISPLAY" "$SWAYSOCK" "$XDG_CURRENT_DESKTOP"');
    expect(result.stdout).toContain("unset|wayland-test|");
    expect(result.stdout).toContain("99999.sock");
    expect(result.stdout.endsWith("|sway")).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("bounds noisy output and terminates timed out descendants", async () => {
    const noisy = await runBash(hand, "head -c 100000 /dev/zero | tr '\\0' x");
    expect(noisy.stdout.length).toBeLessThan(33_000);
    expect(noisy.stdout).toContain("truncated");
    const dir = await mkdtemp(join(tmpdir(), "puk-bash-test-"));
    try {
      const result = await runBash(hand, "sleep 30 & echo $! > child; wait", { cwd: dir, timeoutMs: 80 });
      expect(result.timedOut).toBe(true);
      const pid = Number(await Bun.file(join(dir, "child")).text());
      await Bun.sleep(30);
      const stat = await Bun.file(`/proc/${pid}/stat`).text().catch(() => "");
      expect(!stat || stat.split(") ")[1]?.startsWith("Z")).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("abort stops Bash and does not require waiting for its timeout", async () => {
    const abort = new AbortController();
    const start = Date.now();
    const pending = runBash(hand, "sleep 30", { signal: abort.signal });
    abort.abort();
    expect((await pending).cancelled).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("a daemonized descendant holding stdout cannot outlive the tool deadline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "puk-bash-daemon-"));
    let pid = 0;
    try {
      const start = Date.now();
      const result = await runBash(hand, "setsid bash -c 'echo $$ > daemon; sleep 30' &", { cwd: dir, timeoutMs: 150 });
      pid = Number(await Bun.file(join(dir, "daemon")).text());
      expect(result.timedOut).toBe(true);
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      if (!pid) pid = Number(await Bun.file(join(dir, "daemon")).text().catch(() => "0"));
      if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("Jev selects a discovered app only with validated confidence", async () => {
  const response = (choice: string, confidence = 1): Fetch => async () => Response.json({ answers: { app: { type: "choice", choice, confidence, probabilities: { [choice]: 0.99 } }, ready: { type: "noul", noul: 0.99 } } });
  expect(await planAppOpen("Open my notes", [notes], [], { apiKey: "test", fetch: response("app_0") })).toBe(notes.id);
  expect(await planAppOpen("Open my notes", [notes], [], { apiKey: "test", fetch: response("none") })).toBe(null);
  for (const choice of ["invented", "__proto__"]) await expect(planAppOpen("Open my notes", [notes], [], { apiKey: "test", fetch: response(choice) })).rejects.toThrow("not one of the offered labels");
  expect(await planAppOpen("Open my notes", [notes], [], { apiKey: "test", fetch: response("app_0", 0.5) })).toBe(null);
  expect(await planAppOpen("Open my notes", [notes], [notes.id], { apiKey: "test", fetch: response("app_0") })).toBe(null);
});

describe("model and effort routing", () => {
  const candidates = routeCandidates("openai", { keyAvailable: () => true });
  const routingAnswer = (choice: string, confidence = 0.99): Fetch => async () => Response.json({ answers: { route: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } } });
  test("a missing optional complex model falls back without hiding invalid explicit overrides", () => {
    const before = { base: process.env.OPENAI_MODEL, complex: process.env.OPENAI_COMPLEX_MODEL };
    delete process.env.OPENAI_MODEL;
    delete process.env.OPENAI_COMPLEX_MODEL;
    const resolveModel: typeof providerModel = (provider, id) => {
      if (id === "gpt-6-astra" || id === "not-a-model") throw new Error("Model is absent from catalog");
      return providerModel(provider, id);
    };
    try {
      expect(routeCandidates("openai", { keyAvailable: () => true, resolveModel }).find((c) => c.difficulty === "complex"))
        .toMatchObject({ model: "gpt-5.6-luna", effort: "high" });
      process.env.OPENAI_COMPLEX_MODEL = "not-a-model";
      expect(() => routeCandidates("openai", { keyAvailable: () => true, resolveModel })).toThrow("absent from catalog");
    } finally {
      if (before.base === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = before.base;
      if (before.complex === undefined) delete process.env.OPENAI_COMPLEX_MODEL; else process.env.OPENAI_COMPLEX_MODEL = before.complex;
    }
  });
  test("low is the minimum effort across every configured provider", () => {
    for (const invalid of ["off", "none", "minimal"]) expect(EffortSchema.safeParse(invalid).success).toBe(false);
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      expect(routeCandidates(provider, { keyAvailable: () => true }).map((c) => c.effort)).toEqual(["low", "medium", "high"]);
    }
  });
  test("selects only configured model/effort pairs and honors a pinned model", async () => {
    const route = await routeTask("Fix a subtle concurrent queue bug", candidates, { apiKey: "test", fetch: routingAnswer("openai_complex") });
    expect(route).toMatchObject({ provider: "openai", difficulty: "complex", effort: "high", fallback: false });
    expect(candidates.every((c) => c.provider === "openai")).toBe(true);
    expect(routeCandidates("openai", { model: "gpt-5.6-luna", keyAvailable: () => true }).every((c) => c.model === "gpt-5.6-luna")).toBe(true);
    expect(routeCandidates("anthropic", { keyAvailable: () => true }).every((c) => c.model === "claude-sonnet-5")).toBe(true);
  });
  test("unknown choices, low confidence, and outages use a known fallback", async () => {
    for (const fetch of [routingAnswer("made-up-model"), routingAnswer("openai_routine", 0.1), async () => new Response("unavailable", { status: 503 })]) {
      expect(await routeTask("A task", candidates, { apiKey: "test", fetch })).toMatchObject({ id: "openai_standard", fallback: true });
    }
  });
  test("votes split across equivalent providers do not increase effort", async () => {
    const candidates = (["openai", "anthropic", "gemini"] as const).flatMap((provider) => routeCandidates(provider, { keyAvailable: () => true }));
    const route = await routeTask("Open notes", candidates, { apiKey: "test", fetch: async () => Response.json({ answers: { route: { type: "choice", choice: "openai_routine", confidence: 0.3, probabilities: { openai_routine: 0.5, gemini_routine: 0.45, anthropic_routine: 0.05 } } } }) });
    expect(route).toMatchObject({ difficulty: "routine", effort: "low", fallback: false });
  });

  test("automatic routing offers one model per difficulty, with low as the floor", () => {
    const candidates = routeCandidates("auto", { keyAvailable: () => true });
    expect(candidates.map((c) => [c.difficulty, c.model, c.effort])).toEqual([
      ["routine", "gpt-5.6-luna", "low"], ["standard", "claude-sonnet-5", "medium"], ["complex", "gpt-6-astra", "high"],
    ]);
  });
  test("Stop while routing never starts the LLM or an action", async () => {
    let routing = false, requested = false;
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", desktop: fakeDesktop,
      router: async (_task, _candidates, opts) => { routing = true; await new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); throw new Error("unreachable"); },
      streamFn: (...args) => { requested = true; return scriptedModel([])(...args); },
    });
    const pending = runtime.prompt("Open notes");
    await until(() => routing); runtime.stop(); await pending;
    expect(requested).toBe(false);
    expect(runtime.status()).toMatchObject({ running: false, error: null });
  });
  test("applies the selected model and effort to the actual Pi request", async () => {
    let selected: { model: string; effort: unknown } | undefined;
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", desktop: fakeDesktop,
      router: async (_task, options) => ({ ...options.find((c) => c.difficulty === "routine")!, confidence: 1, latencyMs: 1, fallback: false, reason: "Simple" }),
      streamFn: (model, context, opts) => { selected = { model: model.id, effort: opts?.reasoning }; return scriptedModel([])(model, context, opts); },
    });
    await runtime.prompt("Say hello");
    expect(selected).toEqual({ model: "gpt-5.6-luna", effort: "low" });
    expect(runtime.status()).toMatchObject({ effort: "low", route: { difficulty: "routine" } });
  });
});

describe("LLM Jev tool", () => {
  const input = { context: "One note and one URL", questions: [{ id: "target", question: "Which app fits the note?", choices: [{ id: "notes", description: "Notes" }, { id: "browser", description: "Browser" }] }] };
  test("rejects malformed or duplicate choices before making a request", async () => {
    let requested = false;
    const fetch: Fetch = async () => { requested = true; return new Response(); };
    await expect(decideWithJev({ ...input, questions: [...input.questions, ...input.questions] }, { apiKey: "test", fetch })).rejects.toThrow("unique");
    await expect(decideWithJev({ ...input, questions: [{ ...input.questions[0]!, choices: [{ id: "notes", description: "Notes" }] }] }, { apiKey: "test", fetch })).rejects.toThrow();
    expect(requested).toBe(false);
  });
  test("shared choices are expanded once for all requested decisions", async () => {
    let requests = 0;
    await decideWithJev({ context: input.context, choices: input.questions[0]!.choices, questions: [{ id: "first", question: "Choose an app" }, { id: "second", question: "Choose another app" }] }, { apiKey: "test", fetch: async (_url, options) => {
      requests++; const body = JSON.parse(options!.body as string);
      expect(body.questions.first.criteria).toEqual({ notes: "Notes", browser: "Browser" });
      expect(body.questions.second.criteria).toEqual(body.questions.first.criteria);
      return Response.json({ answers: Object.fromEntries(["first", "second"].map((id) => [id, { type: "choice", choice: "notes", confidence: 1, probabilities: { notes: 1, browser: 0 } }])) });
    } });
    expect(requests).toBe(1);
  });
  test("classification is read-only and cannot bypass the next action gate", async () => {
    const gates: string[] = [];
    let decisions = 0, executed = false;
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: fixedRoute, desktop: { ...fakeDesktop, bash: async () => { executed = true; throw new Error("must not execute"); } },
      jev: async () => { decisions++; return { target: { type: "choice", choice: "notes", confidence: 1, probabilities: { notes: 1, browser: 0 } } }; },
      gate: async (ctx) => { gates.push(String(ctx.action.tool)); return { decision: "blocked", risk: null, reason: "Blocked" }; },
      streamFn: scriptedModel([{ name: "jev", arguments: input }, { name: "bash", arguments: { command: "echo must-not-run", cwd: null } }]),
    });
    await runtime.prompt("Make a decision, then a command");
    expect(decisions).toBe(1); expect(gates).toEqual(["bash"]); expect(executed).toBe(false);
  });
});
