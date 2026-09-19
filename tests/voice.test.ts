import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as macos from "../src/macos.ts";
import type { NativeStream } from "../src/macos.ts";
import { caption, connectTranscription, holdToSpeak, keyEvents, listen, type Recording, SAMPLE_RATE, startRecording } from "../src/voice.ts";
import * as windows from "../src/windows.ts";

afterEach(() => mock.restore());

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ------------------------------------------------------------------ fakes: no test opens a microphone or a socket

/** A recording whose start, transcript and failure a test decides. */
function fakeRecording(transcript = "open the calculator") {
  const failure = Promise.withResolvers<never>();
  void failure.promise.catch(() => {});
  const calls: string[] = [];
  const recording: Recording = {
    failed: failure.promise,
    stop: async () => (calls.push("stop"), transcript),
    cancel: () => void calls.push("cancel"),
  };
  return { recording, calls, fail: (message: string) => failure.reject(new Error(message)) };
}

/** A helper mode that stays running, as a stream a test writes to. */
function fakeStream() {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  const exited = Promise.withResolvers<number>();
  const calls: string[] = [];
  const finish = (code: number) => {
    try {
      out.close();
      err.close();
    } catch {
      /* already closed */
    }
    exited.resolve(code);
  };
  const stream: NativeStream = {
    stdout: new ReadableStream({ start: (c) => void (out = c) }),
    stderr: new ReadableStream({ start: (c) => void (err = c) }),
    exited: exited.promise,
    end: () => (calls.push("end"), finish(0)),
    kill: () => (calls.push("kill"), finish(1)),
  };
  return {
    stream,
    calls,
    write: (data: string | Uint8Array) => out.enqueue(typeof data === "string" ? new TextEncoder().encode(data) : data),
    complain: (line: string) => err.enqueue(new TextEncoder().encode(line)),
    exit: finish,
  };
}

/** The Realtime socket: what was sent, and a way to say what the server says. */
function fakeSocket() {
  const listeners: Record<string, ((event: { data?: string }) => void)[]> = {};
  const sent: any[] = [];
  let closed = false;
  const socket = {
    addEventListener: (type: string, listener: (event: { data?: string }) => void) => void (listeners[type] ??= []).push(listener),
    send: (data: string) => void sent.push(JSON.parse(data)),
    close: () => void (closed = true),
  } as unknown as WebSocket;
  const emit = (type: string, data?: unknown) => (listeners[type] ?? []).forEach((listener) => listener({ data: data === undefined ? undefined : JSON.stringify(data) }));
  let opened: { url: string; headers: Record<string, string> } | undefined;
  return {
    connect: (url: string, headers: Record<string, string>) => ((opened = { url, headers }), socket),
    opened: () => opened,
    sent,
    isClosed: () => closed,
    open: () => emit("open"),
    says: (message: unknown) => emit("message", message),
    drops: () => emit("close"),
  };
}

const pcm = (ms: number) => new Uint8Array((SAMPLE_RATE * 2 * ms) / 1000);

// ------------------------------------------------------------------ the hold

test("a hold is recorded while the key is down and becomes a transcript when it comes up", async () => {
  const { recording, calls } = fakeRecording("  open the calculator ");
  const heard: string[] = [];
  const hold = holdToSpeak({ startRecording: () => recording, onTranscript: (text) => void heard.push(text) });
  expect(hold.state()).toBe("idle");
  expect(hold.down()).toBe(true);
  expect(hold.state()).toBe("starting");
  await tick();
  expect(hold.state()).toBe("recording");
  expect(hold.up()).toBe(true);
  expect(hold.state()).toBe("transcribing");
  await hold.settled();
  expect(heard).toEqual(["open the calculator"]);
  expect(calls).toEqual(["stop"]);
  expect(hold.state()).toBe("idle");
});

test("a key that comes up before the microphone has started still sends what was said", async () => {
  const { recording } = fakeRecording();
  const starting = Promise.withResolvers<Recording>();
  const heard: string[] = [];
  const hold = holdToSpeak({ startRecording: () => starting.promise, onTranscript: (text) => void heard.push(text) });
  hold.down();
  expect(hold.up()).toBe(true);
  expect(hold.up()).toBe(false); // the second release of one hold is nothing
  starting.resolve(recording);
  await hold.settled();
  expect(heard).toEqual(["open the calculator"]);
});

test("a cancel while the microphone is still starting drops the recording once it arrives, and sends nothing", async () => {
  const { recording, calls } = fakeRecording();
  const starting = Promise.withResolvers<Recording>();
  const events: string[] = [];
  const hold = holdToSpeak({ startRecording: () => starting.promise, onTranscript: () => void events.push("transcript"), onCancel: () => void events.push("cancel") });
  hold.down();
  hold.cancel();
  expect(hold.state()).toBe("idle");
  starting.resolve(recording);
  await hold.settled();
  expect(calls).toEqual(["cancel"]);
  expect(events).toEqual(["cancel"]);
});

test("a second press is refused while the first transcript is on its way, and says why", async () => {
  const stopping = Promise.withResolvers<string>();
  const errors: string[] = [];
  const recording: Recording = { stop: () => stopping.promise, cancel: () => {} };
  const hold = holdToSpeak({ startRecording: () => recording, onTranscript: () => {}, onError: (message) => void errors.push(message) });
  hold.down();
  await tick();
  hold.up();
  expect(hold.down()).toBe(false);
  expect(errors).toEqual(["the last recording is still being transcribed"]);
  stopping.resolve("done");
  await hold.settled();
  expect(hold.down()).toBe(true);
  await hold.close();
});

test("the key works again while the task it started is still running", async () => {
  const task = Promise.withResolvers<void>();
  const hold = holdToSpeak({ startRecording: () => fakeRecording().recording, onTranscript: () => task.promise });
  hold.down();
  await tick();
  hold.up();
  await tick();
  await tick();
  expect(hold.state()).toBe("idle");
  expect(hold.down()).toBe(true); // a task takes minutes; the next hold does not wait for it
  task.resolve();
  await hold.close();
});

test("a key held too long is a stuck key: the recording is dropped and the hold is free again", async () => {
  const { recording, calls } = fakeRecording();
  const errors: string[] = [];
  const heard: string[] = [];
  const hold = holdToSpeak({ startRecording: () => recording, onTranscript: (text) => void heard.push(text), onError: (message) => void errors.push(message), maxHoldMs: 5 });
  hold.down();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await hold.settled();
  expect(errors).toEqual(["the key was held too long; the recording was dropped"]);
  expect(calls).toEqual(["cancel"]);
  expect(heard).toEqual([]);
  expect(hold.up()).toBe(false);
  expect(hold.state()).toBe("idle");
});

test("a recording that fails mid-hold ends the hold without waiting for the release", async () => {
  const { recording, calls, fail } = fakeRecording();
  const errors: string[] = [];
  const hold = holdToSpeak({ startRecording: () => recording, onTranscript: () => {}, onError: (message) => void errors.push(message) });
  hold.down();
  await tick();
  fail("no usable microphone");
  await hold.settled();
  expect(errors).toEqual(["no usable microphone"]);
  expect(calls).toEqual(["cancel"]);
  expect(hold.state()).toBe("idle");
});

test("a microphone that cannot start is reported, and the next hold is taken", async () => {
  const errors: string[] = [];
  let attempts = 0;
  const hold = holdToSpeak({
    startRecording: () => {
      if (attempts++ === 0) throw new Error("OPENAI_API_KEY is not set");
      return fakeRecording().recording;
    },
    onTranscript: () => {},
    onError: (message) => void errors.push(message),
  });
  hold.down();
  await hold.settled();
  expect(errors).toEqual(["OPENAI_API_KEY is not set"]);
  expect(hold.down()).toBe(true);
  await hold.close();
});

test("silence is a hold that came to nothing, not an empty task", async () => {
  const events: string[] = [];
  const hold = holdToSpeak({ startRecording: () => fakeRecording("   ").recording, onTranscript: () => void events.push("transcript"), onCancel: () => void events.push("cancel") });
  hold.down();
  await tick();
  hold.up();
  await hold.settled();
  expect(events).toEqual(["cancel"]);
});

test("words arrive whole as they are said, and none after a cancel", async () => {
  let say!: (delta: string) => void;
  const partials: string[] = [];
  const hold = holdToSpeak({ startRecording: (onDelta) => ((say = onDelta), fakeRecording().recording), onTranscript: () => {}, onPartial: (text) => void partials.push(text) });
  hold.down();
  await tick();
  say("open ");
  say("the calc");
  hold.cancel();
  say("ulator");
  expect(partials).toEqual(["open ", "open the calc"]);
});

// ------------------------------------------------------------------ the transcript

test("audio said before the session is configured is kept, and the release commits it", async () => {
  const socket = fakeSocket();
  const deltas: string[] = [];
  const session = connectTranscription({ apiKey: "sk-test", model: "a-model", connect: socket.connect, onDelta: (text) => void deltas.push(text) });
  expect(socket.opened()).toEqual({ url: "wss://api.openai.com/v1/realtime?intent=transcription", headers: { Authorization: "Bearer sk-test" } });
  session.append(pcm(150));
  socket.open();
  expect(socket.sent.map((m) => m.type)).toEqual(["session.update"]);
  expect(socket.sent[0].session.audio.input).toEqual({ format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "a-model" }, turn_detection: null });
  socket.says({ type: "session.updated" });
  await session.ready;
  session.append(pcm(50));
  expect(socket.sent.map((m) => m.type)).toEqual(["session.update", "input_audio_buffer.append", "input_audio_buffer.append"]);
  expect(Buffer.from(socket.sent[1].audio, "base64").byteLength).toBe(pcm(150).byteLength);

  const transcript = session.finish();
  await tick();
  expect(socket.sent.at(-1)).toEqual({ type: "input_audio_buffer.commit" });
  socket.says({ type: "conversation.item.input_audio_transcription.delta", delta: "open the " });
  // The transcript can name the item before the commit does.
  socket.says({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: "open the calculator" });
  socket.says({ type: "input_audio_buffer.committed", item_id: "item_1" });
  expect(await transcript).toBe("open the calculator");
  expect(deltas).toEqual(["open the "]);
  expect(socket.isClosed()).toBe(true);
  expect(() => session.append(pcm(50))).toThrow("audio after the hold ended");
});

test("a tap of the key is not committed: under 100 ms is an empty transcript", async () => {
  const socket = fakeSocket();
  const session = connectTranscription({ apiKey: "sk-test", connect: socket.connect });
  socket.open();
  socket.says({ type: "session.updated" });
  session.append(pcm(50));
  expect(await session.finish()).toBe("");
  expect(socket.sent.some((m) => m.type === "input_audio_buffer.commit")).toBe(false);
  expect(socket.isClosed()).toBe(true);
});

test("a provider error shows its code and never its message, which can quote what was sent", async () => {
  const socket = fakeSocket();
  const session = connectTranscription({ apiKey: "sk-test", connect: socket.connect });
  socket.open();
  socket.says({ type: "error", error: { code: "invalid_api_key", message: "Incorrect API key provided: sk-test" } });
  await expect(session.failed).rejects.toThrow("transcription failed (invalid_api_key)");
  await expect(session.ready).rejects.toThrow("transcription failed (invalid_api_key)");
  expect(() => session.append(pcm(50))).toThrow("transcription failed (invalid_api_key)");
});

test("a socket that never answers, drops, or is given half a sample fails rather than hangs", async () => {
  const silent = fakeSocket();
  const timedOut = connectTranscription({ apiKey: "sk-test", connect: silent.connect, timeoutMs: 5 });
  await expect(timedOut.failed).rejects.toThrow("the transcription connection timed out");
  await new Promise((resolve) => setTimeout(resolve, 15));

  const dropped = fakeSocket();
  const session = connectTranscription({ apiKey: "sk-test", connect: dropped.connect });
  dropped.open();
  dropped.says({ type: "session.updated" });
  session.append(pcm(200));
  const transcript = session.finish();
  await tick();
  dropped.drops();
  await expect(transcript).rejects.toThrow("closed before the transcript came");

  const odd = connectTranscription({ apiKey: "sk-test", connect: fakeSocket().connect });
  expect(() => odd.append(new Uint8Array(3))).toThrow("whole 16-bit samples");
  odd.cancel();
});

test("without a key nothing is opened", () => {
  const before = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const socket = fakeSocket();
    expect(() => connectTranscription({ connect: socket.connect })).toThrow("OPENAI_API_KEY is not set");
    expect(socket.opened()).toBeUndefined();
  } finally {
    if (before !== undefined) process.env.OPENAI_API_KEY = before;
  }
});

test("the microphone streams into the session, a sample split across two reads included, and is ended rather than killed", async () => {
  const socket = fakeSocket();
  const mic = fakeStream();
  const recording = startRecording({ apiKey: "sk-test", connect: socket.connect, capture: () => mic.stream });
  socket.open();
  socket.says({ type: "session.updated" });
  mic.write(new Uint8Array(4801)); // 100 ms and half a sample
  mic.write(new Uint8Array(4799)); // the other half, and 100 ms less a sample
  await tick();
  await tick();
  const appended = socket.sent.filter((m) => m.type === "input_audio_buffer.append").map((m) => Buffer.from(m.audio, "base64").byteLength);
  expect(appended).toEqual([4800, 4800]);

  const transcript = recording.stop();
  await tick();
  await tick();
  // Closing its stdin is how the helper is asked to finish: a signal does not cross WSL interop.
  expect(mic.calls).toEqual(["end"]);
  socket.says({ type: "input_audio_buffer.committed", item_id: "item_1" });
  socket.says({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: "what is on my screen" });
  expect(await transcript).toBe("what is on my screen");
});

test("a microphone that stops on its own fails the hold with what the helper said", async () => {
  const socket = fakeSocket();
  const mic = fakeStream();
  const recording = startRecording({ apiKey: "sk-test", connect: socket.connect, capture: () => mic.stream });
  mic.complain("no usable microphone (waveInOpen 2): check Settings > Privacy & security > Microphone\n");
  mic.exit(1);
  await expect(recording.failed).rejects.toThrow("no usable microphone (waveInOpen 2)");
  await tick();
  await tick();
  expect(socket.isClosed()).toBe(true);
});

test("a microphone that cannot be started closes the socket it would have fed", () => {
  const socket = fakeSocket();
  expect(() =>
    startRecording({
      apiKey: "sk-test",
      connect: socket.connect,
      capture: () => {
        throw new Error("windows.cs did not build");
      },
    }),
  ).toThrow("windows.cs did not build");
  expect(socket.isClosed()).toBe(true);
});

// ------------------------------------------------------------------ the key, and the platform under it

test("the held key's lines are events, however the stream cuts them", async () => {
  const keys = fakeStream();
  keys.write("do");
  keys.write("wn\r\nup\n\nnoise\ncan");
  keys.write("cel\ndown"); // no newline yet: not an event until the line ends
  keys.exit(0);
  const events: string[] = [];
  for await (const event of keyEvents(keys.stream.stdout)) events.push(event);
  expect(events).toEqual(["down", "up", "cancel"]);
});

test("on Windows the two ears are modes of the helper that stay running", () => {
  const mic = fakeStream().stream;
  const stream = spyOn(windows.native, "stream").mockImplementation(() => mic);
  expect(windows.microphone()).toBe(mic);
  expect(stream.mock.calls.at(-1)).toEqual(["mic"]);
  windows.heldKey("F8");
  expect(stream.mock.calls.at(-1)).toEqual(["hotkey", 0x77]);
  windows.heldKey("f12");
  expect(stream.mock.calls.at(-1)).toEqual(["hotkey", 0x7b]);
  expect(() => windows.heldKey("hyper")).toThrow('unknown key "hyper"');
});

test("on the Mac --listen says it is not there yet, in one line", () => {
  expect(() => macos.heldKey("F8")).toThrow("--listen runs on Windows only so far");
  expect(() => macos.microphone()).toThrow("--listen runs on Windows only so far");
});

test("what is being said fits one line of the terminal, and it is the end that shows", () => {
  expect(caption("open the\n calculator")).toBe("… open the calculator");
  const long = caption("one two three four five six seven eight nine ten", 24);
  expect(long).toBe("… …even eight nine ten");
  expect(long.length).toBeLessThanOrEqual(24);
});

// ------------------------------------------------------------------ the loop

/** `hands --listen` with every part faked: the key stream, the recording, and the agent. */
function listening(transcripts: string[], withFeed = false) {
  const keys = fakeStream();
  const log: string[] = [];
  const tasks: PromiseWithResolvers<void>[] = [];
  const partials: string[] = [];
  let say: ((delta: string) => void) | undefined;
  const done = listen({
    keys: keys.stream,
    record: (onDelta) => ((say = onDelta), fakeRecording(transcripts.shift() ?? "").recording),
    run: (text) => {
      log.push(`run ${text}`);
      const task = Promise.withResolvers<void>();
      tasks.push(task);
      return task.promise;
    },
    queue: (text) => void log.push(`queue ${text}`),
    stop: () => void log.push("stop"),
    print: (line) => void log.push(`print ${line}`),
    live: (line) => void log.push(`live ${line}`),
    onPartial: (text) => void partials.push(text),
    feed: withFeed ? { listening: () => void log.push("feed listening"), transcript: (text) => void log.push(`feed transcript ${text}`), finishing: () => void log.push("feed finishing") } : undefined,
  });
  const press = async (...lines: string[]) => {
    for (const line of lines) {
      keys.write(`${line}\n`);
      for (let i = 0; i < 6; i++) await tick();
    }
  };
  return { keys, log, tasks, partials, done, press, say: (delta: string) => say?.(delta) };
}

test("a spoken task runs, and what is said while it runs is queued behind it rather than refused", async () => {
  const l = listening(["open the calculator", "then multiply it by two", "what is on my screen"]);
  await l.press("down");
  l.say("open the");
  await l.press("up");
  expect(l.log).toEqual(["live … listening", "live … open the", "live ", "print > open the calculator", "run open the calculator"]);
  expect(l.partials).toEqual(["open the"]); // where something that acts on half a sentence would plug in

  l.log.length = 0;
  await l.press("down", "up");
  expect(l.log).toEqual(["live … listening", "live ", "print queued: then multiply it by two", "queue then multiply it by two"]);

  // Once the agent is idle, the next thing said is a task of its own, in the same conversation.
  l.tasks[0]!.resolve();
  await tick();
  l.log.length = 0;
  await l.press("down", "up");
  expect(l.log).toEqual(["live … listening", "live ", "print > what is on my screen", "run what is on my screen"]);
  l.tasks[1]!.resolve();
  l.keys.exit(0);
  await l.done;
});

test("with a feed the words go to its card, whole each time, and the terminal's one line is left alone", async () => {
  const l = listening(["open the calculator", "", "never sent"], true);
  await l.press("down");
  l.say("open ");
  l.say("the calc");
  await l.press("up");
  expect(l.log).toEqual(["feed listening", "feed transcript open ", "feed transcript open the calc", "feed finishing", "print > open the calculator", "run open the calculator"]);
  expect(l.partials).toEqual(["open ", "open the calc"]);

  // Silence and a cancel both end the card's listening: a hold that came to nothing must not leave it up.
  l.log.length = 0;
  await l.press("down", "up");
  expect(l.log).toEqual(["feed listening", "feed finishing", "feed finishing"]);
  l.log.length = 0;
  await l.press("down", "cancel");
  expect(l.log).toEqual(["feed listening", "feed finishing", "print stopping", "stop"]);
  l.tasks[0]!.resolve();
  l.keys.exit(0);
  await l.done;
});

test("Ctrl+Alt+Esc drops a hold, and stops the task only if one is running", async () => {
  const l = listening(["dropped with the hold", "open the calculator", "never sent"]);
  await l.press("down", "cancel");
  expect(l.log).toEqual(["live … listening", "live "]); // nothing was running: nothing to stop

  l.log.length = 0;
  await l.press("down", "up");
  expect(l.log.at(-1)).toBe("run open the calculator");
  l.log.length = 0;
  await l.press("down", "cancel");
  expect(l.log).toEqual(["live … listening", "live ", "print stopping", "stop"]);
  l.tasks[0]!.resolve();
  l.keys.exit(0);
  await l.done;
});

test("a task that fails is said, and the key goes on working", async () => {
  const l = listening(["open the calculator", "try again"]);
  await l.press("down", "up");
  l.tasks[0]!.reject(new Error("model error"));
  await tick();
  expect(l.log.at(-1)).toBe("print task failed: model error");
  await l.press("down", "up");
  expect(l.log.at(-1)).toBe("run try again");
  l.tasks[1]!.resolve();
  l.keys.exit(0);
  await l.done;
});
