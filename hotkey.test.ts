import { describe, expect, test } from "bun:test";
import { createVoiceListener, createHotkeyController, handleHotkey, isLocalRequest, serveHotkeys, servePuk, connectTranscription, transcriptionSession, startRecording, type TranscriptionOptions, type Recording } from "./hotkey";
import type { InstalledApp } from "./desktop";
import { createDesktopAgent } from "./ai";
import { createEarlyLauncher } from "./evals";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { assertContract, type Ask } from "./jev/jev";

describe("push-to-talk lifecycle", () => {
  test("release during startup commits exactly once despite repeated key events", async () => {
    let finishStart!: (recording: Recording) => void;
    const started = new Promise<Recording>((resolve) => { finishStart = resolve; });
    const transcripts: string[] = [];
    let stops = 0;
    const controller = createHotkeyController({ startRecording: () => started, onTranscript: (text) => { transcripts.push(text); } });
    expect(controller.down()).toBe(true);
    expect(controller.down()).toBe(false);
    expect(controller.up()).toBe(true);
    expect(controller.up()).toBe(false);
    finishStart({ stop: async () => { stops++; return "  Read the page  "; }, cancel() {} });
    await controller.settled();
    expect(stops).toBe(1);
    expect(transcripts).toEqual(["Read the page"]);
    expect(controller.status().state).toBe("idle");
  });

  test("failed startup recovers for the next press", async () => {
    let starts = 0;
    const transcripts: string[] = [];
    const controller = createHotkeyController({
      startRecording: () => { if (++starts === 1) throw new Error("No microphone"); return { stop: async () => "Try again", cancel() {} }; },
      onTranscript: (text) => { transcripts.push(text); },
    });
    controller.down();
    await controller.settled();
    expect(controller.status().lastError).toBe("No microphone");
    expect(controller.down()).toBe(true);
    controller.up();
    await controller.settled();
    expect(transcripts).toEqual(["Try again"]);
  });

  test("cancellation while starting never submits a task", async () => {
    let finishStart!: (recording: Recording) => void;
    let cancelled = 0;
    let submitted = false;
    const controller = createHotkeyController({
      startRecording: () => new Promise((resolve) => { finishStart = resolve; }),
      onTranscript: () => { submitted = true; },
    });
    controller.down();
    controller.cancel();
    finishStart({ stop: async () => "Should not submit", cancel() { cancelled++; } });
    await controller.settled();
    expect(cancelled).toBe(1);
    expect(submitted).toBe(false);
  });

  test("empty transcripts do not create tasks", async () => {
    let submitted = false, cancelled = false;
    const controller = createHotkeyController({ startRecording: () => ({ stop: async () => "  ", cancel() {} }), onTranscript: () => { submitted = true; }, onCancel: () => { cancelled = true; } });
    controller.down();
    controller.up();
    await controller.settled();
    expect(submitted).toBe(false);
    expect(cancelled).toBe(true);
  });

  test("a rejected recording attempt cannot cancel an existing voice task", async () => {
    let cancelled = false;
    const controller = createHotkeyController({ onStart() { throw new Error("busy"); }, startRecording: () => { throw new Error("must not record"); }, onTranscript() {}, onCancel() { cancelled = true; } });
    controller.down();
    await controller.settled();
    expect(controller.status().lastError).toBe("busy");
    expect(cancelled).toBe(false);
  });

  test("Stop also cancels the handoff after final transcription has arrived", async () => {
    let finishHandoff!: () => void;
    let reachedHandoff = false, submitted = false;
    const controller = createHotkeyController({
      startRecording: () => ({ stop: async () => "Open my notes", cancel() {} }),
      async onTranscript(_text, signal) {
        reachedHandoff = true;
        await new Promise<void>((resolve) => { finishHandoff = resolve; });
        if (!signal.aborted) submitted = true;
      },
    });
    controller.down(); controller.up();
    await until(() => reachedHandoff);
    controller.cancel(); finishHandoff();
    await controller.settled();
    expect(submitted).toBe(false);
  });

  test("a missed release cancels the microphone at the hold limit", async () => {
    let cancelled = false;
    const controller = createHotkeyController({
      maxHoldMs: 10,
      startRecording: () => ({ stop: async () => "", cancel() { cancelled = true; } }),
      onTranscript() {},
    });
    controller.down();
    await controller.settled();
    expect(cancelled).toBe(true);
    expect(controller.status().lastError).toContain("held too long");
  });

  test("Stop allows another hold immediately and late old completion cannot reset it", async () => {
    const old = Promise.withResolvers<string>();
    const current = Promise.withResolvers<string>();
    const transcripts: string[] = [];
    let starts = 0, stopping = false;
    const controller = createHotkeyController({
      startRecording: () => {
        const first = ++starts === 1;
        return { stop: () => { stopping = true; return first ? old.promise : current.promise; }, cancel() {} };
      },
      onTranscript: (text) => { transcripts.push(text); },
    });
    controller.down(); controller.up();
    await until(() => stopping);
    controller.cancel();
    expect(controller.down()).toBe(true);
    await until(() => controller.status().state === "recording");
    old.resolve("Obsolete task");
    await Bun.sleep(5);
    expect(controller.status()).toMatchObject({ state: "recording", held: true, lastError: null });
    controller.up(); current.resolve("New task");
    await controller.settled();
    expect(transcripts).toEqual(["New task"]);
    await controller.close();
  });

  test("a new press during final transcription reports busy without dropping the existing turn", async () => {
    const final = Promise.withResolvers<string>();
    const transcripts: string[] = [];
    const controller = createHotkeyController({ startRecording: () => ({ stop: () => final.promise, cancel() {} }), onTranscript: (text) => { transcripts.push(text); } });
    controller.down(); controller.up();
    const response = handleHotkey(new Request("http://127.0.0.1:7777/hotkey/down", { method: "POST" }), controller)!;
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toContain("still finishing");
    final.resolve("Keep this task");
    await controller.settled();
    expect(transcripts).toEqual(["Keep this task"]);
  });
});

describe("local hotkey HTTP server", () => {
  test("acknowledges down/up while capture is starting", async () => {
    const transcripts: string[] = [];
    const app = serveHotkeys({ port: 0, startRecording: () => ({ stop: async () => "Open docs", cancel() {} }), onTranscript: (text) => { transcripts.push(text); } });
    try {
      expect((await fetch(new URL("/hotkey/down", app.server.url), { method: "POST" })).status).toBe(202);
      expect((await fetch(new URL("/hotkey/up", app.server.url), { method: "POST" })).status).toBe(202);
      await app.controller.settled();
      expect(transcripts).toEqual(["Open docs"]);
      expect((await fetch(new URL("/hotkey/down", app.server.url))).status).toBe(405);
    } finally { await app.close(); }
  });

  test("websites and rebound hostnames cannot trigger capture", () => {
    const controller = createHotkeyController({ startRecording: () => { throw new Error("must not record"); }, onTranscript() {} });
    expect(handleHotkey(new Request("http://127.0.0.1:7777/hotkey/down", { method: "POST", headers: { Origin: "https://untrusted.example" } }), controller)?.status).toBe(403);
    expect(isLocalRequest(new Request("http://attacker.example:7777/hotkey/down", { method: "POST" }))).toBe(false);
    expect(isLocalRequest(new Request("http://127.0.0.1:7777/status"))).toBe(true);
    expect(controller.status().state).toBe("idle");
  });
});


function realtimeServer(opts: { error?: boolean; closeEarly?: boolean; silence?: boolean; delay?: number; liveDelta?: boolean } = {}) {
  const messages: Record<string, any>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("Upgrade required", { status: 400 }); },
    websocket: {
      async message(ws, raw) {
        const message = JSON.parse(String(raw));
        messages.push(message);
        if (opts.silence) return;
        if (message.type === "session.update") {
          if (opts.error) { ws.send(JSON.stringify({ type: "error", error: { code: "invalid_api_key", message: "SECRET" } })); return; }
          if (opts.closeEarly) { ws.close(); return; }
          if (opts.delay) await Bun.sleep(opts.delay);
          ws.send(JSON.stringify({ type: "session.updated", session: message.session }));
        }
        if (message.type === "input_audio_buffer.commit") {
          // A different item must not be mistaken for the committed turn.
          ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "unrelated", transcript: "Wrong task" }));
          ws.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "ours" }));
          ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", item_id: "ours", delta: "Open " }));
          ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "ours", transcript: "Open the documentation" }));
        }
        if (message.type === "input_audio_buffer.append" && opts.liveDelta) ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", item_id: "ours", delta: "Open my notes" }));
      },
    },
  });
  const connect: TranscriptionOptions["connect"] = () => new WebSocket(`ws://127.0.0.1:${server.port}`);
  return { messages, connect, close: () => server.stop(true) };
}

function fakeCapture(exitCode = 1) {
  const exit = Promise.withResolvers<number>();
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const signals: (string | undefined)[] = [];
  const end = () => { if (!closed) { closed = true; out.close(); exit.resolve(exitCode); } };
  return {
    stdout: new ReadableStream<Uint8Array>({ start(controller) { out = controller; out.enqueue(new Uint8Array(4800)); } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    exited: exit.promise,
    kill(signal?: "SIGINT" | "SIGTERM" | "SIGKILL") { signals.push(signal); end(); },
    signals, end,
  };
}

describe("microphone recording lifecycle", () => {
  test("release finalizes live text when pw-record handles SIGINT with exit code 1", async () => {
    const fake = realtimeServer({ liveDelta: true });
    const capture = fakeCapture(1);
    const partials: string[] = [];
    const recording = startRecording({ apiKey: "test", connect: fake.connect, capture: () => capture, onDelta: (text) => partials.push(text) });
    try {
      await until(() => partials.length > 0);
      expect(await recording.stop()).toBe("Open the documentation");
      expect(capture.signals[0]).toBe("SIGINT");
      expect(fake.messages.filter((m) => m.type === "input_audio_buffer.commit")).toHaveLength(1);
    } finally { await recording.cancel(); fake.close(); }
  });

  test("auth failures retain their cause when capture is killed", async () => {
    const fake = realtimeServer({ error: true });
    const capture = fakeCapture();
    const recording = startRecording({ apiKey: "test", connect: fake.connect, capture: () => capture });
    try {
      await expect(recording.failed!).rejects.toThrow("OpenAI transcription failed (invalid_api_key)");
      await expect(recording.stop()).rejects.toThrow("OpenAI transcription failed (invalid_api_key)");
    } finally { await recording.cancel(); fake.close(); }
  });

  test("an unexpected recorder exit while held ends capture and never submits partial text", async () => {
    const fake = realtimeServer({ liveDelta: true });
    const capture = fakeCapture();
    const transcripts: string[] = [];
    const controller = createHotkeyController({ startRecording: (onDelta) => startRecording({ apiKey: "test", connect: fake.connect, capture: () => capture, onDelta }), onTranscript: (text) => { transcripts.push(text); } });
    try {
      controller.down();
      await until(() => Boolean(controller.status().partialTranscript));
      capture.end();
      await controller.settled();
      expect(controller.status()).toMatchObject({ state: "idle", held: false });
      expect(controller.status().lastError).toContain("Microphone capture stopped unexpectedly");
      expect(transcripts).toEqual([]);
    } finally { await controller.close(); fake.close(); }
  });
});

describe("Realtime transcription", () => {
  test("delivers live transcript deltas before the audio buffer is committed", async () => {
    const fake = realtimeServer({ liveDelta: true });
    const deltas: string[] = [];
    const session = connectTranscription({ apiKey: "test", connect: fake.connect, onDelta: (text) => deltas.push(text) });
    try {
      await session.ready;
      session.append(new Uint8Array(4800));
      await until(() => deltas.length > 0);
      expect(deltas).toEqual(["Open my notes"]);
      expect(fake.messages.some((m) => m.type === "input_audio_buffer.commit")).toBe(false);
    } finally { session.cancel(); fake.close(); }
  });
  test("buffers audio during setup and commits once on release", async () => {
    const fake = realtimeServer({ delay: 10 });
    const deltas: string[] = [];
    const session = connectTranscription({ apiKey: "test", connect: fake.connect, onDelta: (text) => deltas.push(text) });
    try {
      session.append(new Uint8Array(4_800));
      const result = session.finish();
      expect(session.finish()).toBe(result);
      expect(await result).toBe("Open the documentation");
      expect(fake.messages.map((m) => m.type)).toEqual(["session.update", "input_audio_buffer.append", "input_audio_buffer.commit"]);
      expect(fake.messages[0]).toEqual(transcriptionSession());
      expect(Buffer.from(fake.messages[1]!.audio, "base64").length).toBe(4_800);
      expect(deltas).toEqual(["Open "]);
      expect(() => session.append(new Uint8Array(2))).toThrow("ended");
    } finally { session.cancel(); fake.close(); }
  });

  test("a short accidental press does not send an empty commit", async () => {
    const fake = realtimeServer();
    const session = connectTranscription({ apiKey: "test", connect: fake.connect });
    try {
      session.append(new Uint8Array(100));
      expect(await session.finish()).toBe("");
      expect(fake.messages.some((m) => m.type === "input_audio_buffer.commit")).toBe(false);
    } finally { session.cancel(); fake.close(); }
  });

  test("provider errors, disconnects, and configuration timeouts reject cleanly", async () => {
    for (const opts of [{ error: true }, { closeEarly: true }, { silence: true }]) {
      const fake = realtimeServer(opts);
      const session = connectTranscription({ apiKey: "test", connect: fake.connect, timeoutMs: 30 });
      try {
        session.append(new Uint8Array(4_800));
        const error = await session.finish().catch((error: Error) => error);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain("SECRET");
      } finally { session.cancel(); fake.close(); }
    }
  });

  test("cancellation closes a session that is still connecting", async () => {
    const fake = realtimeServer({ silence: true });
    const session = connectTranscription({ apiKey: "test", connect: fake.connect });
    session.cancel();
    await expect(session.ready).rejects.toThrow("cancelled");
    fake.close();
  });

  test("rejects incomplete PCM samples and missing credentials", () => {
    expect(() => connectTranscription({ apiKey: "" })).toThrow("OPENAI_API_KEY");
    const fake = realtimeServer();
    const session = connectTranscription({ apiKey: "test", connect: fake.connect });
    expect(() => session.append(new Uint8Array(3))).toThrow("16-bit");
    session.cancel();
    fake.close();
  });
});

const writer: InstalledApp = { id: "writer.desktop", name: "Writer", description: "Notes", argv: ["writer"], categories: ["Office"], terminal: false };
async function until(check: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

describe("legacy app-opening eval baseline", () => {
  test("an incomplete English opening clause does not occupy the classifier", async () => {
    const planned: string[] = [];
    const early = createEarlyLauncher({ apps: () => [writer], intervalMs: 0, plan: async (text) => { planned.push(text); return null; }, launch: async () => false });
    early.begin();
    for (const text of ["Open", "Open my", "Can you open the"]) { early.update(text); await Bun.sleep(5); }
    expect(planned).toEqual([]);
    early.update("Open my notes"); await until(() => planned.length === 1);
    expect(planned).toEqual(["Open my notes"]);
    await early.finish();
  });
  test("opens once while the key is held, then carries the launch into the final task", async () => {
    let delta!: (text: string) => void;
    let opens = 0, stops = 0;
    let finalOpened: string[] = [];
    const early = createEarlyLauncher({ apps: () => [writer], intervalMs: 0, plan: async () => writer.id, launch: async () => { opens++; return true; } });
    const controller = createHotkeyController({
      onStart: () => early.begin(), onPartial: (text) => early.update(text), onCancel: () => early.cancel(),
      startRecording: (onDelta) => { delta = onDelta; return { stop: async () => { stops++; return "Open my notes and draft a plan"; }, cancel() {} }; },
      onTranscript: async () => { finalOpened = await early.finish(); },
    });
    controller.down();
    delta("Open my notes");
    await until(() => opens === 1);
    expect(stops).toBe(0);
    expect(controller.status().held).toBe(true);
    delta(" and draft a plan");
    await Bun.sleep(15);
    expect(opens).toBe(1);
    controller.up();
    await controller.settled();
    expect(finalOpened).toEqual([writer.id]);
    expect(stops).toBe(1);
  });

  test("cancelled and corrected transcripts cannot launch from a stale Jev result", async () => {
    for (const correction of [false, true]) {
      let resolve!: (id: string | null) => void;
      let launched = false;
      const early = createEarlyLauncher({ apps: () => [writer], intervalMs: 50, plan: () => new Promise((r) => { resolve = r; }), launch: async () => { launched = true; return true; } });
      early.begin(); early.update("Open my notes");
      await until(() => Boolean(resolve));
      if (correction) early.update("Open my notes, actually wait, cancel that");
      else early.cancel();
      resolve(writer.id);
      await early.finish();
      expect(launched).toBe(false);
    }
  });

  test("cancellation during the launch gate prevents the app starting", async () => {
    let started = false, aborted = false;
    const early = createEarlyLauncher({ apps: () => [writer], intervalMs: 0, plan: async () => writer.id, launch: async (_id, _text, signal) => {
      started = true;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      return false;
    } });
    early.begin(); early.update("Open my notes");
    await until(() => started);
    expect(await early.finish()).toEqual([]);
    expect(aborted).toBe(true);
  });

  test("new words in any language invalidate an in-flight launch check", async () => {
    let checking = false, aborted = false;
    const early = createEarlyLauncher({ apps: () => [writer], intervalMs: 50, plan: async () => writer.id, launch: async (_id, _text, signal) => {
      checking = true;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      return false;
    } });
    early.begin(); early.update("打开笔记");
    await until(() => checking);
    early.update("打开笔记，不，先不要");
    await until(() => aborted);
    expect(await early.finish()).toEqual([]);
  });
  test("cancelling after a completed reversible launch retains that app and prevents further work", async () => {
    let launches = 0;
    const early = createEarlyLauncher({ apps: () => [writer], intervalMs: 0, plan: async () => writer.id, launch: async () => { launches++; return true; } });
    early.begin(); early.update("Open notes");
    await until(() => launches === 1);
    early.cancel(); early.update("Actually cancel that");
    expect(await early.finish()).toEqual([writer.id]);
    expect(launches).toBe(1);
  });
});

function speechAsk(relation: (state: any) => string = (state) => state.tasks.length ? "refines" : "new_task"): Ask {
  return async (state, questions) => {
    const answers = Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, q.type === "noul"
      ? { type: "noul", noul: 0.99 }
      : { type: "choice", choice: name === "route" ? "llm" : name === "cut" ? "none" : relation(state), confidence: 0.99, probabilities: {} }]));
    assertContract(questions, answers);
    return answers as never;
  };
}

function voiceHarness(over: Partial<Parameters<typeof createVoiceListener>[0]> = {}, run?: (text: string) => Promise<void>) {
  const prompts: { text: string; hand: number; utterance?: string }[] = [];
  const updates: { text: string; hand: number; utterance?: string }[] = [], stops: number[] = [];
  const runtimes = new Map<number, ReturnType<typeof makeRuntime>>();
  let active = 0, maxActive = 0;
  function makeRuntime(id: number) {
    let stopped = Promise.withResolvers<void>();
    let running = false;
    return {
      async prompt(text: string, _opened?: string[], utterance?: string, live?: { speechEnds(): Promise<void> | null }) {
        if (running) throw new Error("Overlapping work on one hand");
        running = true; stopped = Promise.withResolvers<void>();
        maxActive = Math.max(maxActive, ++active);
        prompts.push({ text, hand: id, utterance });
        try {
          await Promise.race([Promise.resolve(run?.(text)).then(() => live?.speechEnds()), stopped.promise]);
        } finally { running = false; active--; }
      },
      refine(text: string, utterance?: string) { updates.push({ text, hand: id, utterance }); },
      stop() { if (running) { stops.push(id); stopped.resolve(); } },
      status: () => ({ error: null }),
    };
  }
  const voice = createVoiceListener({
    hand: { id: 1, pid: 1, display: "test", width: 800, height: 600 }, ask: speechAsk(),
    runtime: (hand) => {
      if (!runtimes.has(hand.id)) runtimes.set(hand.id, makeRuntime(hand.id));
      return runtimes.get(hand.id)!;
    },
    ...over,
  });
  voice.begin();
  return { voice, prompts, updates, stops, maxActive: () => maxActive };
}

describe("Live Jev listener with Pi workers", () => {
  test("starts Pi before release and steers the same worker as speech grows", async () => {
    const { voice, prompts, updates } = voiceHarness();
    voice.hear("Open my notes");
    await until(() => prompts.length === 1);
    expect(prompts[0]!.text).toBe("Open my notes");
    expect(voice.status().tasks[0]!.status).toBe("running");
    voice.hear("Open my notes and draft a short plan");
    await until(() => updates.some((u) => u.text.endsWith("draft a short plan")));
    await voice.finish("Open my notes and draft a short plan");
    await voice.idle();
    expect(prompts).toHaveLength(1);
    expect(updates.at(-1)!.utterance).toBe("Open my notes and draft a short plan");
    expect(voice.status().busy).toBe(false);
    expect(voice.status().tasks.map((t) => t.status)).toEqual(["done"]);
  });

  test("a rewritten final transcript stops the old worker and starts the corrected task", async () => {
    const { voice, prompts, stops } = voiceHarness();
    voice.hear("Open my notes");
    await until(() => prompts.length === 1);
    await voice.finish("Open my files");
    await voice.idle();
    expect(prompts.map((p) => p.text)).toEqual(["Open my notes", "Open my files"]);
    expect(stops).toEqual([1]);
    expect(voice.status().tasks.map((t) => t.status)).toEqual(["cancelled", "done"]);
  });

  test("spoken cancellation stops the running worker before release", async () => {
    const { voice, prompts, stops } = voiceHarness({ ask: speechAsk((state) => state.new_words.includes("never mind") ? "retracts" : "new_task") });
    voice.hear("Open my notes");
    await until(() => prompts.length === 1);
    voice.hear("Open my notes never mind");
    await until(() => stops.length === 1);
    await voice.finish("Open my notes never mind");
    await voice.idle();
    expect(prompts).toHaveLength(1);
    expect(voice.status().tasks.map((t) => t.status)).toEqual(["cancelled"]);
  });

  test("Stop during listener classification discards a late result", async () => {
    const pending = Promise.withResolvers<void>();
    let classifying = false;
    const answer = speechAsk();
    const { voice, prompts } = voiceHarness({ ask: async (state, questions) => {
      if ("relation" in questions) { classifying = true; await pending.promise; }
      return answer(state, questions);
    } });
    voice.hear("Open my notes");
    await until(() => classifying);
    voice.cancel(); pending.resolve();
    await voice.finish("Open my notes");
    await Bun.sleep(5);
    expect(prompts).toEqual([]);
    expect(voice.status().tasks).toEqual([]);
  });

  test("a failed final decision cancels the live worker and surfaces the error", async () => {
    const answer = speechAsk();
    const { voice, prompts, stops } = voiceHarness({ ask: async (state, questions) => {
      if (typeof state === "object" && state !== null && "speaker_has_finished" in state && state.speaker_has_finished) throw new Error("listener unavailable");
      return answer(state, questions);
    } });
    voice.hear("Open my notes");
    await until(() => prompts.length === 1);
    await expect(voice.finish("Open my notes and make a plan")).rejects.toThrow("listener unavailable");
    await voice.idle();
    expect(stops).toEqual([1]);
    expect(voice.status().error).toBe("listener unavailable");
  });

  test("extra tasks queue when the only hand is occupied", async () => {
    const held = Promise.withResolvers<void>();
    const { voice, prompts, maxActive } = voiceHarness({ ask: speechAsk(() => "new_task") }, async () => { await held.promise; });
    voice.hear("Read my notes");
    await until(() => prompts.length === 1);
    voice.hear("Read my notes and list my files");
    await until(() => voice.status().tasks.length === 2);
    await voice.finish("Read my notes and list my files");
    expect(voice.status().tasks.map((t) => t.status)).toEqual(["running", "waiting"]);
    held.resolve(); await voice.idle();
    expect(prompts).toHaveLength(2);
    expect(maxActive()).toBe(1);
    expect(prompts[1]!.text).toBe("and list my files");
    expect(prompts[1]!.utterance).toBe("Read my notes and list my files");
    expect(voice.status().tasks.every((t) => t.status === "done")).toBe(true);
  });

  test("two hands start independent workers during speech and a third task waits", async () => {
    const hands = [1, 2].map((id) => ({ id, pid: id, display: `test-${id}`, width: 800, height: 600 }));
    const { voice, prompts, updates, maxActive } = voiceHarness({ hands: async () => hands, ask: speechAsk(() => "new_task") });
    voice.hear("Open notes"); await until(() => prompts.length === 1);
    voice.hear("Open notes and open calculator"); await until(() => prompts.length === 2);
    voice.hear("Open notes and open calculator and list files");
    await until(() => voice.status().tasks.length === 3);
    expect(prompts.map((p) => p.hand)).toEqual([1, 2]);
    expect(voice.status().tasks.map((t) => t.status)).toEqual(["running", "running", "waiting"]);
    await voice.finish("Open notes and open calculator and list files"); await voice.idle();
    expect(prompts).toHaveLength(3);
    expect(maxActive()).toBe(2);
    expect(updates).toEqual([]); // Independent tasks never steer each other.
    expect(voice.status().tasks.every((t) => t.status === "done")).toBe(true);
  });

  test("failure to create a worker is visible and does not leave the listener busy", async () => {
    const { voice } = voiceHarness({ runtime: async () => { throw new Error("worker unavailable"); } });
    voice.hear("Open notes");
    await until(() => voice.status().tasks[0]?.status === "failed");
    await voice.finish("Open notes"); await voice.idle();
    expect(voice.status()).toMatchObject({ error: "worker unavailable", busy: false });
  });

  test("Stop cancels active and queued tasks, then a new hold can start", async () => {
    const { voice, prompts, stops } = voiceHarness({ ask: speechAsk(() => "new_task") });
    voice.hear("Read my notes"); await until(() => prompts.length === 1);
    voice.hear("Read my notes and list my files"); await until(() => voice.status().tasks.length === 2);
    voice.cancel(); await voice.idle();
    expect(stops).toEqual([1]);
    expect(prompts).toHaveLength(1);
    expect(voice.status().tasks.every((t) => t.status === "cancelled")).toBe(true);
    voice.begin(); await voice.finish("Say hello"); await voice.idle();
    expect(prompts).toHaveLength(2);
  });
});


describe("Puk multi-worker HTTP panel", () => {
  test("live speech starts two workers and the panel can view and approve either one", async () => {
    const hands = [1, 2].map((id) => ({ id, pid: id, display: `test-${id}`, width: 800, height: 600 }));
    const runtimes = new Map<number, Awaited<ReturnType<typeof createDesktopAgent>>>();
    const opened: number[] = [];
    const previewStates = new Map<number, string>();
    let delta: ((text: string) => void) | undefined;
    const app = await servePuk({ port: 0, provider: "openai", dependencies: {
      hand: async (id) => hands.find((h) => h.id === id) ?? null, hands: async () => hands,
      handState: async (hand, state) => { previewStates.set(hand.id, state); },
      ask: speechAsk(() => "new_task"),
      record: (options) => { delta = options?.onDelta; return { stop: async () => "Open my notes and open calculator", cancel() {} }; },
      agent: async (opts) => {
        let turn = 0;
        const runtime = await createDesktopAgent({ ...opts, apiKey: "test", desktop: {
          discover: async () => [writer], state: async () => ({ width: 800, height: 600, windows: [] }),
          launch: async (hand) => { opened.push(hand.id); return hand.id; },
        },
        router: async (_task, candidates) => ({ ...candidates[0]!, confidence: 1, latencyMs: 0, fallback: false, reason: "Fixture" }),
        gate: async () => ({ decision: "approval", risk: 0.9, reason: "Review fixture" }),
        streamFn: (model, context) => {
          const stream = createAssistantMessageEventStream();
          const last = context.messages.findLast((message) => message.role === "toolResult");
          const useTool = !last || last.isError;
          turn++;
          if (turn > 10) throw new Error("The fixture model could not finish its tool loop");
          const message: AssistantMessage = {
            role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
            stopReason: useTool ? "toolUse" : "stop",
            content: useTool ? [{ type: "toolCall", id: `call-${turn}`, name: "open_app", arguments: { id: writer.id } }] : [{ type: "text", text: "Done" }],
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: useTool ? "toolUse" : "stop", message }); return stream;
        } });
        runtimes.set(opts.hand.id, runtime); return runtime;
      },
    } });
    const post = (path: string, body = {}) => fetch(new URL(path, app.server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const state = async () => await (await fetch(new URL("/status", app.server.url))).json() as any;
    try {
      await until(() => previewStates.get(1) === "idle" && previewStates.get(2) === "idle");
      expect(runtimes.has(2)).toBe(false);
      expect((await post("/hand", { hand: 2 })).status).toBe(200);
      expect((await state()).hand).toBe(2);
      expect(runtimes.get(2)!.status().running).toBe(false);
      expect((await post("/hand", { hand: 1 })).status).toBe(200);
      expect((await post("/hotkey/down")).status).toBe(202);
      await until(() => Boolean(delta)); delta!("Open my notes");
      await until(() => runtimes.get(1)?.status().currentTool === "Waiting for the completed instruction");
      delta!(" and open calculator");
      await until(() => runtimes.get(2)?.status().currentTool === "Waiting for the completed instruction");
      expect((await state()).workers.filter((w: any) => w.agent.running)).toHaveLength(2);
      expect((await state()).held).toBe(true);
      await until(() => previewStates.get(1) === "working" && previewStates.get(2) === "working", 2000);
      expect(opened).toEqual([]);
      expect((await post("/task", { text: "Another task" })).status).toBe(409);
      expect((await post("/provider", { provider: "anthropic" })).status).toBe(409);
      expect((await post("/hotkey/up")).status).toBe(202);
      await app.controller.settled();
      await until(() => [...runtimes.values()].filter((r) => r.status().approval).length === 2);
      const approvals = (await state()).approvals;
      await until(() => previewStates.get(1) === "review" && previewStates.get(2) === "review", 2000);
      expect(approvals.map((a: any) => a.hand).sort()).toEqual([1, 2]);
      const second = approvals.find((a: any) => a.hand === 2);
      expect((await post("/approve", { id: second.id, approved: true })).status).toBe(200);
      await runtimes.get(2)!.idle();
      expect(opened).toEqual([2]);
      expect((await post("/approve", { id: second.id, approved: true })).status).toBe(409);
      expect((await state()).state).toBe("idle");
      expect((await post("/hand", { hand: 2 })).status).toBe(200);
      expect((await state()).hand).toBe(2);
      expect((await post("/hand", { hand: 42 })).status).toBe(404);
      expect((await post("/approve", { id: crypto.randomUUID(), approved: true })).status).toBe(409);
      expect((await post("/stop")).status).toBe(200);
      await until(() => [...runtimes.values()].every((r) => !r.status().running));
      await until(() => previewStates.get(1) === "idle" && previewStates.get(2) === "idle", 2000);
      expect((await state()).approvals).toEqual([]);
      const blocked = await fetch(new URL("/task", app.server.url), { method: "POST", headers: { Origin: "https://elsewhere.example" }, body: '{"text":"Do something"}' });
      expect(blocked.status).toBe(403);
    } finally { await app.close(); }
  });
});
