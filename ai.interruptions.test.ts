import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createDesktopAgent, type GateContext, type GateResult, type routeTask } from "./ai";
import { createSemanticComputer, type Snapshot } from "./semantic-computer";
import type { Hand } from "./desktop";

const hand = { id: 77, pid: 7777, display: "test", width: 800, height: 600 } as Hand;
const allow: GateResult = { decision: "allow", risk: 0.01, reason: "Fixture allow" };
const route: typeof routeTask = async (_task, candidates) => ({ ...candidates.find(candidate => candidate.difficulty === "standard")!, confidence: 1, latencyMs: 0, fallback: false, reason: "Fixture route" });
function script(calls: { name: string; arguments: Record<string, unknown> }[]): StreamFn {
  let step = 0;
  return model => {
    const call = calls[step++], stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: call ? "toolUse" : "stop",
      content: call ? [{ type: "toolCall", id: `call-${step}`, ...call }] : [{ type: "text", text: "Finished inspecting." }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: call ? "toolUse" : "stop", message }); return stream;
  };
}
const snapshot = { name: "computer_browser", arguments: { action: "snapshot" } };
const click = (ref: string, extra = {}) => ({ name: "computer_browser", arguments: { action: "click", ref, ...extra } });
const challenge = (): Snapshot => ({ kind: "browser", identity: "pid1:window2:nonce3:https://example.test", title: "Verify", binding: { window: "pid1:window2:nonce3" },
  texts: ["Select all images containing buses"], elements: [
    { key: "captcha", role: "checkbox", name: "I'm not a robot", visible: true, address: {} },
    { key: "verify", role: "button", name: "Verify", visible: true, address: {} },
    { key: "tile", role: "button", name: "Image tile", visible: true, address: {} },
  ] });

test("actual agent semantic results cap submitted CAPTCHA attempts while tile selection remains progress", async () => {
  let inputs = 0;
  const contexts: GateContext[] = [], raw = "Read the requested article; you may try its visible CAPTCHA normally.";
  const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: route, narrate: false,
    desktop: { discover: async () => [], state: async () => ({ width: 800, height: 600, windows: [] }),
      semantic: (_hand, guard) => createSemanticComputer({ windows: async () => [], observe: async () => challenge(), act: async () => { inputs++; } }, guard) },
    gate: async context => { contexts.push(context); return allow; },
    streamFn: script([snapshot, click("p1:2"), click("p2:2"), click("p3:2"), click("p4:1"), click("p5:2"), click("p6:1"), click("p7:1")]),
  });
  try {
    await runtime.prompt(raw);
    expect(inputs).toBe(6); expect(contexts).toHaveLength(6);
    expect(contexts.every(context => context.authorization === raw)).toBe(true);
    expect(contexts[0]!.action.browserInterruption).toMatchObject({ kind: "captcha", action: "attempt_challenge" });
    const status = runtime.status();
    expect(status.interruption).toMatchObject({ action: "user_takeover", kind: "captcha", challengeAttemptsRemaining: 0, checkpoint: { targetKey: "pid1:window2:nonce3" } });
    expect(status.error).toContain("Two submitted CAPTCHA attempts");
    expect(status.running).toBe(false);
  } finally { await runtime.close(); }
});

test("a successful challenge clears the interruption and resumes the original task", async () => {
  let inputs = 0;
  const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: route, narrate: false,
    desktop: { discover: async () => [], state: async () => ({ width: 800, height: 600, windows: [] }),
      semantic: (_hand, guard) => createSemanticComputer({ windows: async () => [], observe: async () => inputs ? { ...challenge(), title: "Article", texts: ["Research content"], elements: [] } : challenge(), act: async () => { inputs++; } }, guard) },
    gate: async () => allow, streamFn: script([snapshot, click("p1:1")]),
  });
  try { await runtime.prompt("Read this article and try the visible CAPTCHA if needed."); expect(inputs).toBe(1); expect(runtime.status().interruption).toBeUndefined(); expect(runtime.status().error).toBeNull(); }
  finally { await runtime.close(); }
});

test.each([false, true])("cached queries cannot clear an observed challenge or reset its attempt budget (rejected query: %s)", async rejected => {
  let reads = 0, inputs = 0, gates = 0;
  const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: route, narrate: false,
    desktop: { discover: async () => [], state: async () => ({ width: 800, height: 600, windows: [] }),
      semantic: (_hand, guard) => createSemanticComputer({ windows: async () => [],
        observe: async () => { reads++; return challenge(); }, act: async () => { inputs++; } }, guard) },
    gate: async () => { gates++; return allow; },
    streamFn: script([snapshot, ...(rejected ? [{ name: "computer_browser", arguments: { action: "query", query: "Verify", screenshot: true } }] : []),
      { name: "computer_browser", arguments: { action: "query", query: "unmatched article" } },
      { name: "computer_browser", arguments: { action: "query", query: "Verify" } }]),
  });
  try {
    await runtime.prompt("Inspect the captured challenge controls without submitting it.");
    expect(reads).toBe(1); expect(inputs).toBe(0); expect(gates).toBe(0);
    expect(runtime.status().interruption).toMatchObject({ kind: "captcha", challengeAttemptsRemaining: 2 });
    expect(JSON.stringify(runtime.agent.state.messages)).toContain("cached projection does not establish that it cleared");
    if (rejected) expect(JSON.stringify(runtime.agent.state.messages)).toContain("rejected cached query does not establish that it cleared");
  } finally { await runtime.close(); }
});

test("a visual-only capture cannot clear an observed challenge or reset its attempt budget", async () => {
  let inputs = 0, gates = 0;
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20);
  const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: route, narrate: false,
    desktop: { discover: async () => [], state: async () => ({ width: 800, height: 600, windows: [] }),
      semantic: (_hand, guard) => createSemanticComputer({ windows: async () => [], observe: async options => options.nativeCanvas
        ? { ...challenge(), visualOnly: true, elements: [], texts: [], image: { type: "image", mimeType: "image/png", data: png.toString("base64") }, canvasCoordinates: { width: 800, height: 600 }, binding: { ...challenge().binding, canvas: {} } }
        : challenge(), act: async () => { inputs++; } }, guard) },
    gate: async () => { gates++; return allow; }, streamFn: script([snapshot, { name: "computer_browser", arguments: { action: "canvas_snapshot" } }]),
  });
  try {
    await runtime.prompt("Inspect the visible article challenge without submitting it.");
    expect(inputs).toBe(0); expect(gates).toBe(0);
    expect(runtime.status().interruption).toMatchObject({ kind: "captcha", challengeAttemptsRemaining: 2 });
    expect(JSON.stringify(runtime.agent.state.messages)).toContain("visual-only capture does not establish that it cleared");
  } finally { await runtime.close(); }
});

test("a visible challenge uses Astra then returns to the original fast model without another router call", async () => {
  let inputs = 0, routes = 0;
  const models: string[] = [], png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20);
  const data = png.toString("base64");
  const modelScript = script([snapshot, click("p1:1")]);
  const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", narrate: false,
    router: async (...args) => { routes++; return route(...args); },
    desktop: { discover: async () => [], state: async () => ({ width: 800, height: 600, windows: [] }),
      semantic: (_hand, guard) => createSemanticComputer({ windows: async () => [], observe: async () => inputs
        ? { ...challenge(), title: "Article", texts: ["Requested content"], elements: [] }
        : { ...challenge(), image: { type: "image", mimeType: "image/png", data }, capture: { window: null, width: 800, height: 600, digest: Bun.hash(data).toString(16) } },
        act: async () => { inputs++; } }, guard) },
    gate: async () => allow,
    streamFn: (model, context, options) => { models.push(model.id); return modelScript(model, context, options); },
  });
  try {
    await runtime.prompt("Read the article and try the visible challenge if needed.");
    expect(models).toEqual(["gpt-5.6-luna", "gpt-6-astra", "gpt-5.6-luna"]);
    expect(routes).toBe(1); expect(inputs).toBe(1);
    expect(runtime.status().interruption).toBeUndefined(); expect(runtime.status().error).toBeNull();
  } finally { await runtime.close(); }
});

test("visible login pauses before credential input but article CAPTCHA mentions remain ordinary data", async () => {
  for (const login of [true, false]) {
    let inputs = 0, gates = 0;
    const page: Snapshot = login ? { ...challenge(), title: "Sign in — Example", texts: ["Enter your password"], elements: [
      { key: "password", role: "textbox", type: "password", name: "Password", visible: true, address: {} }, { key: "sign-in", role: "button", name: "Sign in", visible: true, address: {} },
    ] } : { ...challenge(), title: "CAPTCHA research", texts: ["This article discusses CAPTCHA attacks and password logins."], elements: [{ ...challenge().elements[0]!, visible: false }] };
    const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: route, narrate: false,
      desktop: { discover: async () => [], state: async () => ({ width: 800, height: 600, windows: [] }),
        semantic: (_hand, guard) => createSemanticComputer({ windows: async () => [], observe: async () => page, act: async () => { inputs++; } }, guard) },
      gate: async () => { gates++; return allow; }, streamFn: script(login ? [snapshot, click("p1:1")] : [snapshot]),
    });
    try {
      await runtime.prompt("Read the current article."); expect(inputs).toBe(0); expect(gates).toBe(0);
      if (login) expect(runtime.status().interruption).toMatchObject({ kind: "login", action: "user_takeover" });
      else { expect(runtime.status().interruption).toBeUndefined(); expect(runtime.status().error).toBeNull(); }
    } finally { await runtime.close(); }
  }
});

test("CAPTCHA recovery never bypasses a blocked exact-action gate", async () => {
  let inputs = 0;
  const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: route, narrate: false,
    desktop: { discover: async () => [], state: async () => ({ width: 800, height: 600, windows: [] }), semantic: (_hand, guard) => createSemanticComputer({ windows: async () => [], observe: async () => challenge(), act: async () => { inputs++; } }, guard) },
    gate: async () => ({ decision: "blocked", risk: 0.99, reason: "Fixture scoped denial" }), streamFn: script([snapshot, click("p1:1", { challenge_submit: true })]),
  });
  try { await runtime.prompt("Read the article after its challenge."); expect(inputs).toBe(0); expect(runtime.status().error).toBe("Fixture scoped denial"); }
  finally { await runtime.close(); }
});

test("an initial verified-target URL restriction stops without another browser tool", async () => {
  let reads = 0;
  const runtime = await createDesktopAgent({ hand, provider: "openai", apiKey: "test", router: route, narrate: false,
    desktop: { discover: async () => [], state: async () => ({ width: 800, height: 600, windows: [{ app: "chrome", title: "Page", pid: 1, containerId: 2, ownerNonce: "0000000000000003", focused: true }] }),
      semantic: (_hand, guard) => createSemanticComputer({ windows: async () => [], observe: async () => { reads++; throw new Error("Computer Use could not verify whether the current browser URL is allowed."); }, act: async () => {} }, guard) },
    gate: async () => allow, streamFn: script([snapshot, snapshot, snapshot]),
  });
  try { await runtime.prompt("Read this page."); expect(reads).toBe(1); expect(runtime.status().interruption).toMatchObject({ kind: "verification_blocked", action: "user_takeover" }); }
  finally { await runtime.close(); }
});
