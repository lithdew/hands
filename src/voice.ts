/**
 * `hands --listen`: hold a key, speak, release, and what was said is the task.
 *
 * Three parts, each with its seam so a test never opens a microphone or a socket: the hold (a key going down
 * and coming up, with every order the two can arrive in), the recording (the platform's microphone streamed
 * to one OpenAI Realtime transcription session per hold), and the loop that hands a finished transcript to
 * the agent. The words arrive while they are being said: they go to the feed's card when there is one, to one
 * line of the terminal when there is not, and `onPartial` is where something that acts on half a sentence
 * would plug in.
 */

import type { Feed } from "./feed.ts";
import type { NativeStream } from "./macos.ts";
import * as config from "./config.ts";

// ------------------------------------------------------------------ the hold

export interface Recording {
  /** The hold is over: stop the microphone and wait for the whole transcript. */
  stop(): Promise<string>;
  cancel(): void | Promise<void>;
  /** Rejects if the microphone or the socket fails mid-hold, so a hold does not wait for a release that means nothing. */
  failed?: Promise<never>;
}

export interface HoldOptions {
  startRecording(onDelta: (text: string) => void): Recording | Promise<Recording>;
  /** The transcript so far, whole, each time a word lands. */
  onPartial?(text: string): void;
  onTranscript(text: string): void | Promise<void>;
  /** A hold that came to nothing: cancelled, silent, or failed. */
  onCancel?(): void;
  onError?(message: string): void;
  maxHoldMs?: number;
}

export type HoldState = "idle" | "starting" | "recording" | "transcribing";

interface Hold {
  released: boolean;
  cancelled: boolean;
  release: (commit: boolean) => void;
  recording?: Recording;
  cleanup?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * One hold at a time. The key can come up before the microphone has started, a second press can arrive while
 * the first transcript is still on its way, and a cancel can land at any point, so a hold is an object that
 * outlives the key: `up` only marks it released, and the hold finishes itself whenever the recording is ready.
 */
export function holdToSpeak(options: HoldOptions) {
  let active: Hold | undefined;
  let pending: Promise<void> = Promise.resolve();
  let state: HoldState = "idle";
  let closed = false;

  const report = (error: unknown) => options.onError?.(error instanceof Error ? error.message : "voice capture failed");
  // A recording is cancelled once, however many paths get there.
  const cleanUp = (hold: Hold): Promise<void> => (hold.recording ? (hold.cleanup ??= Promise.resolve().then(() => hold.recording!.cancel())) : Promise.resolve());

  function cancel(message?: string): void {
    const hold = active;
    if (!hold) return;
    hold.cancelled = hold.released = true;
    clearTimeout(hold.timer);
    hold.release(false);
    options.onCancel?.();
    void cleanUp(hold).catch(() => {});
    active = undefined;
    state = "idle";
    if (message) report(new Error(message));
  }

  return {
    /** False when it was refused: a hold is already under way, or its transcript still is. */
    down(): boolean {
      if (active || closed) {
        if (active?.released) report(new Error("the last recording is still being transcribed"));
        return false;
      }
      let release!: Hold["release"];
      const released = new Promise<boolean>((resolve) => (release = resolve));
      const hold: Hold = { released: false, cancelled: false, release };
      active = hold;
      state = "starting";
      // A key that never comes up is a stuck key or a lost `up` line, not a minute of speech.
      hold.timer = setTimeout(() => cancel("the key was held too long; the recording was dropped"), options.maxHoldMs ?? 60_000);
      pending = (async () => {
        let said = "";
        try {
          const recording = await options.startRecording((delta) => {
            if (active !== hold || hold.cancelled) return;
            said = (said + delta).slice(0, 16_000);
            options.onPartial?.(said);
          });
          hold.recording = recording;
          if (hold.cancelled) return void (await cleanUp(hold));
          if (!hold.released) state = "recording";
          const committed = await (recording.failed ? Promise.race([released, recording.failed]) : released);
          if (!committed || hold.cancelled) return void (await cleanUp(hold));
          state = "transcribing";
          const text = (await recording.stop()).trim();
          if (hold.cancelled) return;
          // The hold ends before the task starts: the next thing said must not wait for this one to be done.
          clearTimeout(hold.timer);
          active = undefined;
          state = "idle";
          if (text) await options.onTranscript(text);
          else options.onCancel?.();
        } catch (error) {
          if (!hold.cancelled) {
            report(error);
            if (active === hold) options.onCancel?.();
          }
          await cleanUp(hold).catch(() => {});
        } finally {
          clearTimeout(hold.timer);
          if (active === hold) {
            active = undefined;
            state = "idle";
          }
        }
      })().catch(report);
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
    state: (): HoldState => state,
    settled: (): Promise<void> => pending,
    async close(): Promise<void> {
      closed = true;
      cancel();
      await pending;
    },
  };
}

// ------------------------------------------------------------------ the transcript

// https://developers.openai.com/api/docs/guides/realtime-transcription
export const SAMPLE_RATE = 24_000;
const MIN_AUDIO_BYTES = (SAMPLE_RATE * 2) / 10; // Realtime refuses a commit under 100 ms
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 60;
const REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

export interface TranscriptionOptions {
  apiKey?: string;
  model?: string;
  onDelta?(text: string): void;
  timeoutMs?: number;
  /** A test's socket. Bun's WebSocket takes headers, which the browser's does not. */
  connect?: (url: string, headers: Record<string, string>) => WebSocket;
}

/** No turn detection: the hold is the turn, and only its release commits the audio. */
export const transcriptionSession = (model: string) => ({
  type: "session.update",
  session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: SAMPLE_RATE }, transcription: { model }, turn_detection: null } } },
});

/** One Realtime session for one hold. Audio that arrives before the session is configured is kept and sent after. */
export function connectTranscription(options: TranscriptionOptions = {}) {
  const key = options.apiKey ?? config.openaiKey();
  if (!key) throw new Error("OPENAI_API_KEY is not set: transcription needs it (put it in .env)");
  const connect = options.connect ?? ((url, headers) => new WebSocket(url, { headers }));
  const socket = connect(REALTIME_URL, { Authorization: `Bearer ${key}` });
  const ready = Promise.withResolvers<void>();
  const failure = Promise.withResolvers<never>();
  // Either may reject while nobody is waiting yet: the microphone can still be starting when the socket fails.
  void ready.promise.catch(() => {});
  void failure.promise.catch(() => {});
  let finish: PromiseWithResolvers<string> | undefined;
  let error: Error | undefined;
  let configured = false;
  let closed = false;
  let committing = false;
  let bytes = 0;
  let itemId: string | undefined;
  const completed = new Map<string, string>();
  const queued: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => fail("the transcription connection timed out"), options.timeoutMs ?? 10_000);

  function close(): void {
    closed = true;
    clearTimeout(timer);
    queued.length = 0;
    socket.close();
  }
  function fail(message: string): void {
    if (closed) return;
    error = new Error(message);
    failure.reject(error);
    ready.reject(error);
    finish?.reject(error);
    close();
  }
  function send(value: unknown): void {
    if (error) throw error;
    if (closed) throw new Error("the transcription session is closed");
    socket.send(JSON.stringify(value));
  }
  const append = (chunk: Uint8Array) => send({ type: "input_audio_buffer.append", audio: Buffer.from(chunk).toString("base64") });
  /** The commit names the item and the transcript names it again, in either order. */
  function complete(): void {
    if (!itemId || !completed.has(itemId) || !finish) return;
    finish.resolve(completed.get(itemId)!);
    close();
  }

  socket.addEventListener("open", () => {
    try {
      send(transcriptionSession(options.model ?? config.transcribeModel()));
    } catch {
      fail("the transcription session could not be configured");
    }
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (message.type === "session.updated") {
        configured = true;
        clearTimeout(timer);
        for (const chunk of queued) append(chunk);
        queued.length = 0;
        ready.resolve();
      } else if (message.type === "input_audio_buffer.committed" && committing && typeof message.item_id === "string") {
        itemId = message.item_id;
        complete();
      } else if (message.type === "conversation.item.input_audio_transcription.delta" && typeof message.delta === "string") {
        options.onDelta?.(message.delta);
      } else if (message.type === "conversation.item.input_audio_transcription.completed" && typeof message.item_id === "string" && typeof message.transcript === "string") {
        completed.set(message.item_id, message.transcript);
        complete();
      } else if (message.type === "error" || message.type === "conversation.item.input_audio_transcription.failed") {
        // The provider's message can quote what was sent. Only its code is shown, and only if it looks like one.
        const code = message.error?.code;
        fail(`transcription failed${typeof code === "string" && /^[a-z0-9_.-]{1,80}$/i.test(code) ? ` (${code})` : ""}`);
      }
    } catch {
      fail("the transcriber sent something that is not an event");
    }
  });
  socket.addEventListener("error", () => fail("could not connect to the transcriber"));
  socket.addEventListener("close", () => {
    if (!closed) fail("the transcription connection closed before the transcript came");
  });

  return {
    ready: ready.promise,
    failed: failure.promise,
    append(chunk: Uint8Array): void {
      if (error) throw error;
      if (committing || closed) throw new Error("audio after the hold ended");
      if (chunk.byteLength % 2) throw new Error("PCM chunks must hold whole 16-bit samples");
      bytes += chunk.byteLength;
      if (bytes > MAX_AUDIO_BYTES) {
        fail("the recording passed 60 seconds");
        throw error!;
      }
      if (!chunk.length) return;
      if (configured) append(chunk);
      else queued.push(chunk.slice());
    },
    finish(): Promise<string> {
      if (finish) return finish.promise;
      committing = true;
      const done = (finish = Promise.withResolvers<string>());
      void done.promise.catch(() => {});
      void (async () => {
        await ready.promise;
        // A tap of the key is not speech, and committing it is an error rather than an empty transcript.
        if (bytes < MIN_AUDIO_BYTES) return void (done.resolve(""), close());
        timer = setTimeout(() => fail("timed out waiting for the transcript"), options.timeoutMs ?? 15_000);
        send({ type: "input_audio_buffer.commit" });
      })().catch((reason) => done.reject(reason instanceof Error ? reason : new Error(String(reason))));
      return done.promise;
    },
    cancel: () => fail("transcription cancelled"),
  };
}

/** The microphone starts at once and its audio queues while the socket connects, so the first word is not lost to the handshake. */
export function startRecording(options: TranscriptionOptions & { capture: () => NativeStream }): Recording {
  const session = connectTranscription(options);
  let mic: NativeStream;
  try {
    mic = options.capture();
  } catch (error) {
    session.cancel();
    throw error;
  }
  let stopping = false;
  let cancelled = false;
  let captureError: Error | undefined;
  const failure = Promise.withResolvers<never>();
  void failure.promise.catch(() => {});
  function fail(error: unknown): void {
    if (cancelled || captureError) return;
    captureError = error instanceof Error ? error : new Error("microphone capture failed");
    failure.reject(captureError);
    session.cancel();
    mic.kill();
  }
  // The helper says why on stderr (no microphone, privacy setting), which is the message worth showing.
  const complaint = new Response(mic.stderr).text().catch(() => "");
  const captured = (async () => {
    let carry = new Uint8Array(0);
    try {
      for await (const chunk of mic.stdout) {
        // A read can split a sample in two; the odd byte waits for the next one.
        const joined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const end = joined.length - (joined.length % 2);
        if (end && !cancelled) session.append(joined.subarray(0, end));
        carry = joined.subarray(end).slice();
      }
      await mic.exited;
      if (!stopping && !cancelled) throw new Error((await complaint).trim() || "the microphone stopped on its own");
    } catch (error) {
      fail(error);
    }
  })();
  // The first failure is the one reported: killing the microphone after the socket failed must not rename it.
  void session.failed.catch(fail);
  let stopped: Promise<string> | undefined;
  async function stopCapture(): Promise<void> {
    stopping = true;
    mic.end();
    const timer = setTimeout(() => mic.kill(), 2_000);
    try {
      await captured;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    failed: failure.promise,
    stop: () =>
      (stopped ??= (async () => {
        await stopCapture();
        if (captureError) throw captureError;
        return await session.finish();
      })()),
    async cancel() {
      if (cancelled) return;
      cancelled = true;
      session.cancel();
      await stopCapture();
    },
  };
}

// ------------------------------------------------------------------ the loop

export type KeyEvent = "down" | "up" | "cancel";

/** The held key's lines as events. Anything else on the stream is not one, and is skipped. */
export async function* keyEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<KeyEvent> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    for (let end: number; (end = buffered.indexOf("\n")) >= 0; buffered = buffered.slice(end + 1)) {
      const line = buffered.slice(0, end).trim();
      if (line === "down" || line === "up" || line === "cancel") yield line;
    }
  }
}

/** What is being said, on one line of the terminal: the end of it, since that is the part still changing. */
export function caption(text: string, columns = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const room = Math.max(8, columns - 4);
  return `… ${flat.length > room ? `…${flat.slice(flat.length - room + 1)}` : flat}`;
}

export interface ListenOptions {
  keys: NativeStream;
  record(onDelta: (text: string) => void): Recording | Promise<Recording>;
  /** Give the agent a task and see it through. Only called while it is idle. */
  run(text: string): Promise<void>;
  /** The agent is working: leave this for when it would otherwise stop. */
  queue(text: string): void;
  /** Ctrl+Alt+Esc: stop the running task and drop what is queued. */
  stop(): void;
  print?(line: string): void;
  /** The line rewritten in place while the key is held. Given "" when the hold ends. */
  live?(line: string): void;
  onPartial?(text: string): void;
  /** Where the words show instead of the terminal's one line: the card hears the key go down, every word so far, and the key come up. */
  feed?: Pick<Feed, "listening" | "transcript" | "finishing">;
}

/**
 * Until the key stream ends. One agent, one conversation: what is said next is a follow-up to what was said
 * before, as a line typed at the `hands` prompt is, and something said while the agent is still working is
 * queued behind the task rather than refused or barged in, because half a task is worse than a late one.
 */
export async function listen(options: ListenOptions): Promise<void> {
  const print = options.print ?? console.log;
  const feed = options.feed;
  // With a feed the words are on its card and never in the terminal, where the next thing printed would write over them.
  const live = feed ? () => {} : (options.live ?? (() => {}));
  let working: Promise<void> | undefined;

  const hold = holdToSpeak({
    startRecording: options.record,
    onPartial(text) {
      live(caption(text, process.stdout.columns));
      feed?.transcript(text);
      options.onPartial?.(text);
    },
    // A hold that came to nothing is over too: the card must not go on listening.
    onCancel: () => (live(""), feed?.finishing()),
    onError: (message) => (live(""), print(`voice: ${message}`)),
    // Not awaited by the hold: a task takes minutes, and the key has to keep working meanwhile.
    onTranscript(text) {
      live("");
      if (working) {
        print(`queued: ${text}`);
        return options.queue(text);
      }
      print(`> ${text}`);
      working = options
        .run(text)
        .catch((error) => print(`task failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => (working = undefined));
    },
  });

  for await (const event of keyEvents(options.keys.stdout)) {
    if (event === "down") {
      if (hold.down()) (live("… listening"), feed?.listening());
    } else if (event === "up") {
      if (hold.up()) feed?.finishing();
    } else {
      hold.cancel();
      if (!working) continue;
      print("stopping");
      options.stop();
    }
  }
  await hold.close();
  await working;
}
