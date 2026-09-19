import { debugLog, getHand, listHands, rememberSecret, subprocessEnv, type Hand } from "./desktop";
import { z } from "zod";
import { createDesktopAgent, redact, ProviderSelectionSchema, TaskTextSchema, type ProviderSelection } from "./ai";
import { createJev, type Ask } from "./jev/jev";
import { createListener, type Listener } from "./jev/listen";
import type { HandState } from "./pip";

// Hold/release handling for Hyprland. HTTP handlers acknowledge immediately so
// a release can arrive while the microphone or WebSocket is still starting.

export type Recording = { stop(): Promise<string>; cancel(): void | Promise<void>; failed?: Promise<never> };
export type HotkeyOptions = {
  startRecording(onDelta: (text: string) => void): Recording | Promise<Recording>;
  onTranscript(text: string, signal: AbortSignal): void | Promise<void>;
  onStart?(signal: AbortSignal): void | Promise<void>;
  onPartial?(text: string): void;
  onCancel?(): void;
  maxHoldMs?: number;
  onError?(message: string): void;
};

export function createHotkeyController(opts: HotkeyOptions) {
  type Session = {
    released: boolean;
    cancelled: boolean;
    release: (commit: boolean) => void;
    abort: AbortController;
    accepted: boolean;
    recording?: Recording;
    cleanup?: Promise<void>;
    timer?: ReturnType<typeof setTimeout>;
  };
  let active: Session | undefined;
  let pending = Promise.resolve();
  const work = new Set<Promise<void>>();
  let state: "idle" | "starting" | "recording" | "transcribing" | "dispatching" = "idle";
  let lastTranscript = "";
  let partialTranscript = "";
  let lastError: string | null = null;
  let closed = false;

  function report(error: unknown) {
    lastError = redact(error instanceof Error ? error.message : "Voice capture failed.");
    opts.onError?.(lastError);
  }

  function cleanUp(session: Session) {
    if (!session.recording) return Promise.resolve();
    return session.cleanup ??= Promise.resolve().then(() => session.recording!.cancel());
  }

  function cancel(message?: string) {
    const session = active;
    if (!session) return;
    session.cancelled = true;
    session.abort.abort();
    session.released = true;
    clearTimeout(session.timer);
    session.release(false);
    if (session.accepted) opts.onCancel?.();
    void cleanUp(session).catch(() => {});
    active = undefined;
    state = "idle";
    if (message) report(new Error(message));
  }

  return {
    down(): boolean {
      if (active || closed) {
        if (active?.released) report(new Error("The previous recording is still finishing. Wait for it, or press Stop before speaking again."));
        return false;
      }
      let release!: Session["release"];
      const released = new Promise<boolean>((resolve) => { release = resolve; });
      const session: Session = { released: false, cancelled: false, release, abort: new AbortController(), accepted: false };
      active = session;
      state = "starting";
      lastError = null;
      partialTranscript = "";
      session.timer = setTimeout(() => cancel("Recording cancelled because the hotkey was held too long."), opts.maxHoldMs ?? 60_000);
      pending = (async () => {
        try {
          const starting = opts.onStart?.(session.abort.signal);
          if (starting) await starting;
          if (session.cancelled) return;
          session.accepted = true;
          const recording = await opts.startRecording((delta) => {
            if (active !== session || session.cancelled) return;
            partialTranscript = (partialTranscript + delta).slice(0, 16_000);
            opts.onPartial?.(partialTranscript);
          });
          session.recording = recording;
          if (session.cancelled) {
            await cleanUp(session);
            return;
          }
          if (!session.released) state = "recording";
          const committed = await (recording.failed ? Promise.race([released, recording.failed]) : released);
          if (!committed || session.cancelled) { await cleanUp(session); return; }
          state = "transcribing";
          const text = (await recording.stop()).trim();
          if (!session.cancelled && text) {
            lastTranscript = text;
            partialTranscript = text;
            state = "dispatching";
            await opts.onTranscript(text, session.abort.signal);
          } else if (!session.cancelled) opts.onCancel?.();
        } catch (error) {
          if (!session.cancelled && active === session) {
            report(error);
            if (session.accepted) opts.onCancel?.();
          }
          await cleanUp(session);
        } finally {
          clearTimeout(session.timer);
          if (active === session) { active = undefined; state = "idle"; }
        }
      })().catch((error) => { if (active === session && !session.cancelled) report(error); });
      const running = pending;
      work.add(running);
      void running.finally(() => work.delete(running));
      return true;
    },
    up(): boolean {
      if (!active || active.released) return false;
      active.released = true;
      state = "transcribing";
      clearTimeout(active.timer);
      active.release(true);
      return true;
    },
    cancel,
    clearError() { lastError = null; },
    status: () => ({ state, held: Boolean(active && !active.released), partialTranscript, lastTranscript, lastError }),
    settled: () => pending,
    async close() {
      closed = true;
      cancel();
      await Promise.all([...work]);
    },
  };
}

export type HotkeyController = ReturnType<typeof createHotkeyController>;

/** Reject cross-site requests and DNS rebinding before any microphone/action routes. */
export function isLocalRequest(request: Request): boolean {
  const url = new URL(request.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return false;
  return !["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "");
}

export function handleHotkey(request: Request, controller: HotkeyController): Response | null {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/hotkey/")) return null;
  if (!isLocalRequest(request)) return new Response("Local requests only", { status: 403 });
  if (!["/hotkey/down", "/hotkey/up", "/hotkey/cancel"].includes(path)) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Use POST", { status: 405, headers: { Allow: "POST" } });
  const changed = path === "/hotkey/down" ? controller.down()
    : path === "/hotkey/up" ? controller.up()
    : (controller.cancel(), true);
  const status = controller.status();
  if (path === "/hotkey/down" && !changed && !status.held) return Response.json({ changed, ...status, error: status.lastError ?? "Voice capture is not ready." }, { status: 409 });
  return Response.json({ changed, ...status }, { status: 202 });
}

export function serveHotkeys(opts: HotkeyOptions & { port?: number; extraStatus?(): Record<string, unknown>; route?(request: Request, controller: HotkeyController): Promise<Response | null> | Response | null }) {
  const controller = createHotkeyController(opts);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 7777,
    maxRequestBodySize: 20_000,
    async fetch(request) {
      if (!isLocalRequest(request)) return new Response("Local requests only", { status: 403 });
      const response = handleHotkey(request, controller);
      if (response) return response;
      if (request.method === "GET" && new URL(request.url).pathname === "/status") {
        return Response.json({ ...controller.status(), ...opts.extraStatus?.() }, { headers: { "Cache-Control": "no-store" } });
      }
      const custom = await opts.route?.(request, controller);
      if (custom) return custom;
      return new Response("Not found", { status: 404 });
    },
  });
  return { server, controller, async close() { server.stop(true); await controller.close(); } };
}

type VoiceRuntime = Pick<Awaited<ReturnType<typeof createDesktopAgent>>, "prompt" | "refine" | "stop"> & { status(): { error: string | null } };

/** Jev owns live task boundaries. Each free hand runs one cancellable Pi worker;
 * refinements steer that worker, and extra tasks queue until a hand is free. */
export function createVoiceListener(opts: {
  hand: Hand;
  hands?(): Promise<Hand[]>;
  unavailable?(hand: Hand): boolean;
  runtime(hand: Hand): VoiceRuntime | Promise<VoiceRuntime>;
  ask?: Ask;
  log?(message: string): void;
}) {
  type Session = { listener: Listener; text: string; closing: boolean; finishing: boolean; cancelled: boolean; workers: Set<VoiceRuntime>; error: string | null };
  let current: Session | undefined;
  const busy = () => Boolean(current && !current.cancelled && (current.finishing || current.workers.size || current.listener.tasks.some((t) => t.status === "waiting" || t.status === "running")));
  function cancel(session = current) {
    if (!session || session.cancelled) return;
    session.cancelled = true;
    session.listener.cancel();
  }
  function cancelRecording(session = current) {
    if (!session || session.cancelled || session.closing && !session.finishing) return;
    session.closing = true;
    session.listener.cancelUtterance();
  }
  function begin(speaking = true) {
      if (current && !current.cancelled) {
        if (!current.closing || current.finishing) throw new Error("The previous recording is still finishing.");
        // A later hold can correct an active hand or continue a failed/completed
        // task. The listener distinguishes those from a fresh independent job.
        current.text = "";
        current.closing = !speaking;
        current.error = null;
        if (speaking) current.listener.warm();
        return;
      }
      let session: Session;
      const listener = createListener({
        ask: opts.ask ?? createJev({ timeout: 5_000 }),
        buildIntent: (request) => ({ goal: TaskTextSchema.parse(request), launcher: "none", url: null, inputs: {}, doneWhen: "The user's request is visibly complete.", avoid: [] }),
        hands: opts.hands ?? (async () => [opts.hand]),
        unavailable: opts.unavailable,
        log: (message) => opts.log?.(redact(message)),
        async work(hand, job) {
          let runtime: VoiceRuntime | undefined, unsubscribe: (() => void) | undefined;
          const stop = () => runtime?.stop();
          try {
            const worker = await opts.runtime(hand);
            runtime = worker;
            if (job.signal.aborted || session.cancelled) return { status: "cancelled", reason: "Voice task cancelled", steps: [] };
            let assigned = job.intent().goal, context = job.transcript();
            unsubscribe = job.onUpdate?.((intent) => {
              // Other tasks remain context for the gate. Only Jev's assigned
              // goal can steer this worker, including when speech finishes.
              const latestContext = job.transcript();
              if (intent.goal !== assigned || latestContext !== context) {
                assigned = intent.goal;
                context = latestContext;
                worker.refine(assigned, context);
              }
            });
            session.workers.add(worker);
            job.signal.addEventListener("abort", stop, { once: true });
            await worker.prompt(assigned, [], context, { speechEnds: job.speechEnds, transcript: job.transcript });
            const error = worker.status().error;
            return { status: job.signal.aborted ? "cancelled" : error ? "gave_up" : "done", reason: error ?? "Voice task finished", steps: [] };
          } catch (error) {
            if (!job.signal.aborted) session.error = redact(error instanceof Error ? error.message : "Voice task failed.");
            throw error;
          } finally {
            unsubscribe?.();
            job.signal.removeEventListener("abort", stop);
            if (runtime) session.workers.delete(runtime);
          }
        },
      });
      session = { listener, text: "", closing: !speaking, finishing: false, cancelled: false, workers: new Set(), error: null };
      current = session;
      if (speaking) listener.warm();
  }
  return {
    begin: () => begin(),
    async submit(text: string) {
      text = TaskTextSchema.parse(text);
      begin(false);
      const session = current!;
      session.text = text; session.finishing = true;
      try { await session.listener.submit(text); }
      catch (error) { session.error = redact(error instanceof Error ? error.message : "Could not start the typed task."); throw error; }
      finally { session.finishing = false; }
    },
    recordCorrection: async (hand: number, text: string) => !current?.cancelled && await current?.listener.recordCorrection(hand, TaskTextSchema.parse(text)) || false,
    hear(text: string) {
      if (!current || current.closing || current.cancelled) return;
      current.text = z.string().max(16_000).parse(text).trim();
      current.listener.hear(current.text);
    },
    async finish(text: string, signal?: AbortSignal) {
      const session = current;
      if (!session || session.cancelled) return;
      const stop = () => cancelRecording(session);
      signal?.addEventListener("abort", stop, { once: true });
      session.closing = session.finishing = true;
      try {
        if (signal?.aborted || !text.trim()) return cancelRecording(session);
        session.text = TaskTextSchema.parse(text);
        await session.listener.finish(session.text);
      } catch (error) {
        if (!session.cancelled) {
          session.error = redact(error instanceof Error ? error.message : "Could not finish the voice task.");
          cancelRecording(session);
          throw new Error(session.error);
        }
      } finally {
        session.finishing = false;
        signal?.removeEventListener("abort", stop);
      }
    },
    cancel: () => cancel(),
    cancelRecording: () => cancelRecording(),
    schedule: async () => { await current?.listener.schedule(); },
    clearError() { if (current) current.error = null; },
    idle: async () => { await current?.listener.idle(); },
    status: () => ({
      busy: busy(), error: current?.error ?? null,
      tasks: current?.listener.tasks.map(({ id, request, route, status, hand }) => ({ id, request, route, status, hand })) ?? [],
    }),
  };
}

// One OpenAI Realtime transcription session per hotkey hold. Audio stays in
// memory, in mono 24 kHz signed 16-bit PCM; only release commits the turn.
// https://developers.openai.com/api/docs/guides/realtime-transcription
export const SAMPLE_RATE = 24_000;
const MIN_AUDIO_BYTES = SAMPLE_RATE * 2 / 10; // Realtime requires >= 100 ms.
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 60;

export function openaiApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY?.trim() || process.env.OAI?.trim();
}

export type TranscriptionOptions = {
  apiKey?: string;
  model?: string;
  languages?: string[];
  onDelta?(text: string): void;
  timeoutMs?: number;
  /** Test seam; production always connects to OpenAI. */
  connect?: (url: string, headers: Record<string, string>) => WebSocket;
};

export function transcriptionSession(model = "gpt-live-transcribe", languages?: string[]) {
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: SAMPLE_RATE },
          transcription: { model, ...(languages?.length ? { languages } : {}) },
          turn_detection: null,
        },
      },
    },
  };
}

export function connectTranscription(opts: TranscriptionOptions = {}) {
  const key = (opts.apiKey ?? openaiApiKey())?.trim();
  rememberSecret(key);
  if (!key) throw new Error("Set OPENAI_API_KEY (or OAI) in .env to enable transcription.");
  const connect = opts.connect ?? ((url, headers) => new WebSocket(url, { headers }));
  const ws = connect("wss://api.openai.com/v1/realtime?intent=transcription", { Authorization: `Bearer ${key}` });
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const failure = Promise.withResolvers<never>();
  void failure.promise.catch(() => {});
  // Audio capture may still be starting when the connection fails.
  void ready.catch(() => {});
  let finishResolve: ((text: string) => void) | undefined;
  let finishReject: ((error: Error) => void) | undefined;
  let finished: Promise<string> | undefined;
  let error: Error | undefined;
  let configured = false;
  let closed = false;
  let committing = false;
  let bytes = 0;
  let itemId: string | undefined;
  const completed = new Map<string, string>();
  const pending: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => fail("OpenAI transcription connection timed out."), opts.timeoutMs ?? 10_000);

  function close() {
    closed = true;
    clearTimeout(timer);
    pending.length = 0;
    completed.clear();
    ws.close();
  }

  function fail(message: string) {
    if (closed) return;
    error = new Error(message);
    debugLog("voice.transcription.error", { message });
    failure.reject(error);
    readyReject(error);
    finishReject?.(error);
    close();
  }

  function send(value: unknown) {
    if (error) throw error;
    if (closed) throw new Error("Transcription session is closed.");
    ws.send(JSON.stringify(value));
  }

  function appendNow(chunk: Uint8Array) {
    send({ type: "input_audio_buffer.append", audio: Buffer.from(chunk).toString("base64") });
  }

  function complete() {
    if (!itemId || !completed.has(itemId) || !finishResolve) return;
    const text = completed.get(itemId)!;
    finishResolve(text);
    close();
  }

  ws.addEventListener("open", () => {
    try { send(transcriptionSession(opts.model ?? process.env.TRANSCRIBE_MODEL ?? "gpt-live-transcribe", opts.languages)); }
    catch { fail("Unable to configure OpenAI transcription."); }
  });
  ws.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (message.type === "session.updated") {
        configured = true;
        clearTimeout(timer);
        for (const chunk of pending) appendNow(chunk);
        pending.length = 0;
        readyResolve();
      } else if (message.type === "input_audio_buffer.committed" && committing && typeof message.item_id === "string") {
        itemId = message.item_id;
        complete();
      } else if (message.type === "conversation.item.input_audio_transcription.delta" && typeof message.delta === "string") {
        opts.onDelta?.(message.delta);
      } else if (message.type === "conversation.item.input_audio_transcription.completed" && typeof message.item_id === "string" && typeof message.transcript === "string") {
        completed.set(message.item_id, message.transcript);
        complete();
      } else if (message.type === "error" || message.type === "conversation.item.input_audio_transcription.failed") {
        // Provider error messages may contain submitted data. Expose only a bounded code.
        const code = message.error?.code;
        const suffix = typeof code === "string" && /^[a-z0-9_.-]{1,80}$/i.test(code) ? ` (${code})` : "";
        fail(`OpenAI transcription failed${suffix}.`);
      }
    } catch { fail("OpenAI returned an invalid transcription event."); }
  });
  ws.addEventListener("error", () => fail("Unable to connect to OpenAI transcription."));
  ws.addEventListener("close", () => { if (!closed) fail("OpenAI transcription connection closed before completion."); });

  return {
    ready,
    failed: failure.promise,
    append(chunk: Uint8Array) {
      if (error) throw error;
      if (committing || closed) throw new Error("Cannot append audio after the turn has ended.");
      if (chunk.byteLength % 2) throw new Error("PCM chunks must contain complete 16-bit samples.");
      bytes += chunk.byteLength;
      if (bytes > MAX_AUDIO_BYTES) { fail("Recording exceeded the 60-second audio limit."); throw error!; }
      if (!chunk.length) return;
      if (configured) appendNow(chunk);
      else pending.push(chunk.slice());
    },
    finish(): Promise<string> {
      if (finished) return finished;
      committing = true;
      finished = (async () => {
        await ready;
        if (error) throw error;
        if (bytes < MIN_AUDIO_BYTES) { close(); return ""; }
        return await new Promise<string>((resolve, reject) => {
          finishResolve = resolve;
          finishReject = reject;
          timer = setTimeout(() => fail("Timed out waiting for the final transcript."), opts.timeoutMs ?? 15_000);
          try { send({ type: "input_audio_buffer.commit" }); }
          catch { fail("Unable to commit the recorded audio."); }
        });
      })();
      void finished.catch(() => {});
      return finished;
    },
    cancel() { fail("Transcription cancelled."); },
  };
}

type AudioCapture = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: "SIGINT" | "SIGTERM" | "SIGKILL"): void;
};

/** Start the microphone immediately; queue audio while the WebSocket connects. */
export function startRecording(opts: TranscriptionOptions & { target?: string; capture?: () => AudioCapture } = {}): Recording {
  if (!(opts.apiKey ?? openaiApiKey())?.trim()) throw new Error("Set OPENAI_API_KEY (or OAI) in .env to enable transcription.");
  if (!opts.capture && !Bun.which("pw-record")) throw new Error("pw-record is required for microphone capture (PipeWire).");
  const session = connectTranscription(opts);
  let proc: AudioCapture;
  try {
    const target = opts.target ?? process.env.PUK_MICROPHONE;
    proc = opts.capture?.() ?? Bun.spawn([
      "pw-record", "--raw", "--rate", String(SAMPLE_RATE), "--channels", "1", "--format", "s16", "--latency", "50ms",
      ...(target ? ["--target", target] : []), "-",
    ], { env: subprocessEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    session.cancel();
    throw new Error("Unable to start the microphone recorder.");
  }
  let stopping = false;
  let cancelled = false;
  let captureError: Error | undefined;
  const failure = Promise.withResolvers<never>();
  void failure.promise.catch(() => {});
  function fail(error: unknown) {
    if (cancelled || captureError) return;
    captureError = error instanceof Error ? error : new Error("Microphone capture failed.");
    failure.reject(captureError);
    session.cancel();
    proc.kill();
  }
  // Drain stderr without logging or retaining audio-device information indefinitely.
  const stderr = (async () => { for await (const _ of proc.stderr) { /* drain */ } })();
  const captured = (async () => {
    let carry = new Uint8Array(0);
    try {
      for await (const chunk of proc.stdout) {
        const joined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const end = joined.length - joined.length % 2;
        if (end && !cancelled) session.append(joined.subarray(0, end));
        carry = joined.subarray(end).slice();
      }
      const exitCode = await proc.exited;
      debugLog("voice.capture.exit", { exitCode, stopping, cancelled });
      // pw-record may handle SIGINT and exit nonzero without a signalCode.
      // A requested stop is normal; Realtime still finalizes the captured audio.
      if (!stopping && !cancelled) {
        throw new Error("Microphone capture stopped unexpectedly. Check the PipeWire input device.");
      }
    } catch (err) { fail(err); }
  })();
  // Preserve the first error. Killing capture after a WebSocket failure must
  // not replace an auth/connection error with a generic microphone message.
  void session.failed.catch(fail);
  let stopped: Promise<string> | undefined;
  async function stopCapture() {
    stopping = true;
    proc.kill("SIGINT");
    const timer = setTimeout(() => proc.kill("SIGKILL"), 2_000);
    try { await captured; await stderr; }
    finally { clearTimeout(timer); }
  }
  return {
    failed: failure.promise,
    stop() {
      return stopped ??= (async () => {
        await stopCapture();
        if (captureError) throw captureError;
        return await session.finish();
      })();
    },
    async cancel() {
      if (cancelled) return;
      cancelled = true;
      session.cancel();
      await stopCapture();
    },
  };
}

// The control page is a plain HTML file; the server only adds headers and origin checks.
const CONTROL_PAGE = Bun.file(new URL("./panel.html", import.meta.url));

export async function servePuk(opts: {
  port?: number; handId?: number; provider?: ProviderSelection;
  dependencies?: { hand?: typeof getHand; hands?: typeof listHands; agent?: typeof createDesktopAgent; record?: typeof startRecording; ask?: Ask; handState?: (hand: Hand, state: HandState) => Promise<unknown> };
} = {}) {
  const lookup = opts.dependencies?.hand ?? getHand;
  const availableHands = opts.dependencies?.hands ?? listHands;
  const createAgent = opts.dependencies?.agent ?? createDesktopAgent;
  const initialHand = await lookup(opts.handId ?? Number(process.env.PUK_HAND ?? 1));
  if (!initialHand) throw new Error("Start a desktop first: bun desktop.ts up 1");
  type Runtime = Awaited<ReturnType<typeof createDesktopAgent>>;
  type Worker = { hand: Hand; runtime: Runtime };
  const workers = new Map<number, Worker>();
  const starting = new Map<number, Promise<Runtime>>();
  let selection = opts.provider;
  let selected = initialHand.id;
  let changingProvider = false, closed = false;
  let stopping: Promise<void> | undefined;

  async function runtimeFor(hand: Hand): Promise<Runtime> {
    const existing = workers.get(hand.id);
    if (existing?.hand.pid === hand.pid) return existing.runtime;
    const pending = starting.get(hand.id);
    if (pending) return pending;
    const creating = (async () => {
      if (existing) await existing.runtime.close();
      const runtime = await createAgent({ hand, provider: selection });
      if (closed) { await runtime.close(); throw new Error("Puk has stopped."); }
      workers.set(hand.id, { hand, runtime });
      return runtime;
    })();
    starting.set(hand.id, creating);
    try { return await creating; }
    finally { if (starting.get(hand.id) === creating) starting.delete(hand.id); }
  }
  await runtimeFor(initialHand);
  const active = () => workers.get(selected)!;
  const busy = () => changingProvider || starting.size > 0 || [...workers.values()].some((w) => w.runtime.status().running);

  // Reconcile all hands, including desktops that have not received a task yet.
  // Serial updates also catch a manually opened desktop returning to an idle preview.
  const handState = (agent: ReturnType<Runtime["status"]>): HandState => agent.approval ? "review" : agent.running ? "working" : agent.error ? "error" : "idle";
  const paintHand = opts.dependencies?.handState ?? (async (hand, state) => (await import("./pip")).setHandState(hand, state));
  let painting: Promise<void> | undefined;
  const paintHands = () => painting ??= (async () => {
    try {
      for (const hand of await availableHands()) {
        if (closed) break;
        const worker = workers.get(hand.id);
        const state = worker?.hand.pid === hand.pid ? handState(worker.runtime.status()) : "idle";
        await paintHand(hand, state).catch((error) => debugLog("pip", { hand: hand.id, state, error: error instanceof Error ? error.message : String(error) }));
      }
    } catch (error) { debugLog("pip", { error: error instanceof Error ? error.message : String(error) }); }
  })().finally(() => { painting = undefined; });
  const paintTimer = setInterval(() => { void paintHands(); }, 1000);
  paintTimer.unref();
  void paintHands();
  const stopWorkers = () => { for (const { runtime } of workers.values()) runtime.stop(); };
  const voice = createVoiceListener({
    hand: initialHand, runtime: runtimeFor, ask: opts.dependencies?.ask,
    hands: async () => (await availableHands()).sort((a, b) => Number(b.id === selected) - Number(a.id === selected)),
    unavailable: (hand) => starting.has(hand.id) || Boolean(workers.get(hand.id)?.runtime.status().running),
    log: (message) => debugLog("listener", { message }),
  });
  const app = serveHotkeys({
    port: opts.port ?? Number(process.env.PUK_PORT ?? 7777),
    startRecording: (onDelta) => (opts.dependencies?.record ?? startRecording)({ onDelta }),
    onStart(signal) {
      const begin = () => {
        signal.throwIfAborted();
        if (changingProvider) throw new Error("Wait for the model change before recording another task.");
        // Recording must remain available to correct or cancel occupied hands.
        // The listener queues independent tasks until a hand becomes available.
        voice.begin();
      };
      return stopping ? stopping.then(begin) : begin();
    },
    onPartial: voice.hear, onCancel: voice.cancelRecording, onTranscript: voice.finish,
    extraStatus: () => {
      const all = [...workers.values()].map(({ hand, runtime }) => ({ hand: hand.id, agent: runtime.status() }));
      return {
        hand: selected, agent: active().runtime.status(), busy: busy() || Boolean(stopping), listener: voice.status(), workers: all,
        approvals: all.flatMap(({ hand, agent }) => agent.approval ? [{ hand, ...agent.approval }] : []),
      };
    },
    async route(request, controller) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/") return new Response(await CONTROL_PAGE.text(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'" } });
      if (request.method === "GET" && path === "/desktop.png") {
        try { const { previewScreenshot } = await import("./pip"); return new Response(await previewScreenshot(active().hand), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } }); }
        catch { return new Response("Desktop unavailable", { status: 503 }); }
      }
      if (!["/task", "/refine", "/stop", "/approve", "/provider", "/hand", "/desktop/enter", "/desktop/back", "/desktop/layout"].includes(path)) return null;
      if (request.method !== "POST") return new Response("Use POST", { status: 405, headers: { Allow: "POST" } });
      try {
        if (path === "/stop") {
          controller.cancel(); voice.cancel(); stopWorkers();
          const cleanup = Promise.all([controller.settled(), voice.idle(), ...[...workers.values()].map((w) => w.runtime.idle())]).then(() => {});
          stopping = cleanup;
          void cleanup.finally(() => { if (stopping === cleanup) stopping = undefined; });
          return Response.json({ stopped: true });
        }
        if (path.startsWith("/desktop/")) {
          const pip = await import("./pip");
          if (path === "/desktop/enter") await pip.runPip("swap", selected);
          else await pip.runPip(path === "/desktop/layout" ? "layout" : "back");
          return Response.json({ ok: true });
        }
        const bodyText = await request.text();
        if (bodyText.length > 20_000) return Response.json({ error: "Request is too large." }, { status: 413 });
        const body = JSON.parse(bodyText);
        if (path === "/approve") {
          const approval = z.object({ id: z.string().uuid(), approved: z.boolean() }).safeParse(body);
          const owner = approval.success && [...workers.values()].find((w) => w.runtime.status().approval?.id === approval.data.id);
          if (!owner || !approval.success || !owner.runtime.approve(approval.data.id, approval.data.approved)) return Response.json({ error: "That action is no longer awaiting approval." }, { status: 409 });
          return Response.json({ ok: true });
        }
        if (path === "/hand") {
          const view = z.object({ hand: z.int().positive() }).safeParse(body);
          const hand = view.success ? await lookup(view.data.hand) : null;
          if (!hand) return Response.json({ error: "That desktop is unavailable." }, { status: 404 });
          await runtimeFor(hand);
          selected = hand.id;
          return Response.json({ ok: true });
        }
        if (path === "/refine") {
          const parsed = z.object({ hand: z.int().positive().optional(), text: TaskTextSchema }).safeParse(body);
          if (!parsed.success) return Response.json({ error: "Choose a hand and enter a correction of at most 16000 characters." }, { status: 400 });
          const worker = workers.get(parsed.data.hand ?? selected);
          if (!worker) return Response.json({ error: "That hand has no active worker." }, { status: 404 });
          const current = worker.runtime.status();
          if (!current.running || changingProvider || stopping) return Response.json({ error: "That hand is not running a task to correct." }, { status: 409 });
          const revised = TaskTextSchema.safeParse(`${current.task}\nCorrection: ${parsed.data.text}`);
          if (!revised.success) return Response.json({ error: "The task and correction exceed 16000 characters." }, { status: 400 });
          if (!await voice.recordCorrection(worker.hand.id, parsed.data.text)) {
            if (!worker.runtime.status().running) return Response.json({ error: "That hand finished before the correction arrived." }, { status: 409 });
            worker.runtime.refine(revised.data);
          }
          voice.clearError(); controller.clearError();
          return Response.json({ ok: true, hand: worker.hand.id }, { status: 202 });
        }
        if (busy() || stopping || voice.status().busy || controller.status().state !== "idle") return Response.json({ error: "A task or recording is active. Stop it first." }, { status: 409 });
        if (path === "/provider") {
          const parsed = z.object({ provider: ProviderSelectionSchema }).safeParse(body);
          if (!parsed.success) return Response.json({ error: "Unknown provider." }, { status: 400 });
          changingProvider = true;
          try {
            const hand = active().hand;
            const replacement = await createAgent({ hand, provider: parsed.data.provider });
            await Promise.all([...workers.values()].map((w) => w.runtime.close()));
            workers.clear();
            workers.set(hand.id, { hand, runtime: replacement });
            selection = parsed.data.provider;
          } finally { changingProvider = false; }
        } else {
          const task = z.object({ text: TaskTextSchema }).safeParse(body);
          if (!task.success) return Response.json({ error: "Enter a task of at most 16000 characters." }, { status: 400 });
          voice.clearError(); controller.clearError();
          await voice.submit(task.data.text);
        }
        return Response.json({ ok: true }, { status: 202 });
      } catch (error) { return Response.json({ error: redact(error instanceof Error ? error.message : "Request failed.") }, { status: 400 }); }
    },
  });
  return {
    ...app, runtime: () => active().runtime,
    async close() {
      closed = true; clearInterval(paintTimer); voice.cancel(); stopWorkers();
      await app.close(); await voice.idle();
      await Promise.allSettled([...starting.values()]);
      await Promise.all([...workers.values()].map((w) => w.runtime.close()));
      await painting;
      await Promise.allSettled([...workers.values()].map(({ hand }) => paintHand(hand, "idle")));
    },
  };
}

if (import.meta.main) {
  if (process.argv[2] === "transcribe") {
    let session: ReturnType<typeof connectTranscription> | undefined;
    try {
      if (!process.argv[3]) throw new Error("usage: bun hotkey.ts transcribe <mono-24khz-s16le.pcm>");
      const pcm = new Uint8Array(await Bun.file(process.argv[3]).arrayBuffer());
      session = connectTranscription();
      await session.ready;
      for (let i = 0; i < pcm.length; i += 4_800) session.append(pcm.subarray(i, i + 4_800));
      console.log(await session.finish());
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Transcription failed.");
      process.exitCode = 1;
    } finally { session?.cancel(); }
  } else {
    try {
      const app = await servePuk();
      console.log(`Puk is ready at ${app.server.url} (hold F8 to speak, release to send).`);
      const shutdown = async () => { await app.close(); process.exit(); };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (error) { console.error(error instanceof Error ? error.message : "Puk could not start."); process.exitCode = 1; }
  }
}
