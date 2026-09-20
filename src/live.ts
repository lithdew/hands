#!/usr/bin/env bun
/**
 * `hands live`: hold the right Option key, say what you want, let go. A voice (gpt-live-1) hears it and hands the
 * work to one hand or several, each a `hands --background --json` process of its own with its own hand on screen.
 * A panel in the corner shows a live picture of the window each hand is in; click one to read its transcript and
 * steer it, or say it to the voice, which can also stop hands and always knows what each of them is up to.
 *
 * Three things meet here: the hands (processes, spoken to in JSON lines), the voice (one Live session: audio both
 * ways, and a Responses backend that turns what was said into the four tool calls below), and the shell (the key,
 * the microphone, the speaker, the panel). This file is the wiring; none of the three knows about the others.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import OpenAI from "openai";
import { LiveWS } from "openai/resources/live/ws";
import type { Command } from "./agent.ts";
import { timestamp } from "./cli.ts";
import * as config from "./config.ts";
import { type Cue, POSES } from "./hand.ts";
import { onWindows, PERMISSION, platform as macos, startShell } from "./platform.ts";
import { cushion, type Shell, type Talk } from "./shell.ts";
import page from "./ui/index.html";
import type { ClientMessage, HandView, LogEntry, ServerMessage, Status, VoiceView } from "./ui/state.ts";

const MAX_HANDS = 8; // the whole cast. Each is a model, a browser window and a renderer of its own
const FRAME_MS = 160; // one hand's picture is refreshed each tick, turn and turn about
const IDLE_MS = 60_000; // an open session is sent audio all the time and costs by the minute: after this long with nothing said it is closed, and started again, from the conversation so far, when next needed
const NOTE_CHARS = 1500; // a note to the voice may be 500 tokens
const PROGRESS_MS = 20_000; // how often the voice is told how the hands are getting on, while they are
const RECENT = 6;
const CHUNK_MS = 40;

// A hand's name is how it is spoken of, and its colour is how it is told apart on the screen.
const CAST: [name: string, color: string][] = [
  ["Lefty", "4f8cff"], ["Righty", "ff8a3d"], ["Thumbs", "34c77b"], ["Pinky", "ff5ca8"], ["Index", "b07cff"], ["Palm", "29c5d6"], ["Knuckles", "9bd63a"], ["Digit", "ff6b5c"],
]; // prettier-ignore

// ------------------------------------------------------------------ the hands

interface Hand extends HandView {
  proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
  log: LogEntry[];
  recent: string[]; // its last few actions, for the voice
  window: number | null;
  closed: boolean;
}

const hands = new Map<string, Hand>();
const active = (hand: Hand) => hand.status === "starting" || hand.status === "working";

/** The hands a spoken name means: one by name, or every one for "all". */
export const named = <T extends { id: string }>(all: Iterable<T>, wanted: string[]): T[] => {
  const ids = wanted.map((name) => name.trim().toLowerCase());
  return [...all].filter((hand) => ids.includes("all") || ids.includes(hand.id));
};

/** The first of the cast not yet on stage. */
export const cast = (taken: Iterable<string>, names = new Set(taken)): [string, string] | null => CAST.find(([name]) => !names.has(name.toLowerCase())) ?? null; // read once: a map's keys can only be gone through once

/** What the voice is told about the hands: one line each, the newest actions last. */
export function snapshot(all: Iterable<Pick<Hand, "name" | "status" | "task" | "action" | "recent" | "answer" | "since">>, now = Date.now()): string {
  const lines = [...all].map((hand) => {
    const minutes = Math.max(0, Math.round((now - hand.since) / 60_000));
    const doing = hand.status === "working" ? `; now: ${hand.action || "thinking"}; lately: ${hand.recent.join(" > ") || "nothing yet"}` : "";
    const result = hand.answer ? `; it said: ${hand.answer}` : "";
    return `- ${hand.name} [${hand.status}, ${minutes} min] task: ${hand.task}${doing}${result}`;
  });
  return (lines.join("\n") || "No hands are out.").slice(0, NOTE_CHARS);
}

function tell(hand: Hand, command: Command): void {
  try {
    hand.proc.stdin.write(`${JSON.stringify(command)}\n`);
    hand.proc.stdin.flush();
  } catch {} // it has gone: its exit says so
}

function record(hand: Hand, kind: LogEntry["kind"], text: string): void {
  const entry = { kind, text };
  hand.log.push(entry);
  publish({ type: "log", hand: hand.id, entries: [entry] });
}

function startHand(task: string, runs: string): Hand | null {
  const role = cast(hands.keys());
  if (!role || hands.size >= MAX_HANDS) return null;
  const [name, color] = role;
  const runDir = join(runs, name.toLowerCase());
  mkdirSync(runDir, { recursive: true });
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "agent.ts"), "--background", "--json", "--name", name, "--color", color, "--out", runDir], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, HANDS_SLOT: String(CAST.findIndex(([one]) => one === name)) }, // where on a HANDS_SCREEN stage its window goes
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore", // the hand keeps its own log in its run folder
  });
  const hand: Hand = { id: name.toLowerCase(), name, color, task, status: "starting", action: "", glyph: POSES.wave[0], at: null, size: null, viewing: false, answer: "", since: Date.now(), proc, log: [], recent: [], window: null, closed: false }; // prettier-ignore
  hands.set(hand.id, hand);
  record(hand, "task", task);
  console.log(`[${name}] ${task}`);
  void follow(hand);
  void proc.exited.then(() => {
    if (!hand.closed && active(hand)) settle(hand, "failed", `its process ended unexpectedly: see ${runDir}`);
  });
  changed();
  return hand;
}

/** Everything a hand says about itself, a JSON line at a time. */
async function follow(hand: Hand): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of hand.proc.stdout) {
    const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      try {
        heard(hand, JSON.parse(line));
      } catch (error) {
        console.error(`[${hand.name}] ${error}`);
      }
    }
  }
}

type HandEvent =
  | { type: "ready" | "clicked" }
  | { type: "status"; status: Status; answer?: string }
  | { type: "tool"; name: string; args: string }
  | { type: "result"; error: boolean; text: string }
  | { type: "say"; text: string }
  | ({ type: "cue" } & Cue);

function heard(hand: Hand, event: HandEvent): void {
  if (event.type === "ready") tell(hand, { type: "prompt", text: hand.task });
  else if (event.type === "tool") record(hand, "tool", `${event.name} ${event.args}`);
  else if (event.type === "result") record(hand, event.error ? "error" : "result", event.text);
  else if (event.type === "say") record(hand, "say", event.text);
  else if (event.type === "clicked") focus = hand.id; // the user clicked the hand itself: it has stopped where it was, and its card opens
  else if (event.type === "status") {
    if (event.status === "working") hand.status = "working";
    else settle(hand, event.status, event.answer ?? "");
  } else if (event.type === "cue") {
    if (event.subject) [hand.window, hand.size] = [event.subject.window ?? null, event.subject.window === undefined ? null : (event.size ?? null)];
    if (event.at) hand.at = event.at;
    if (event.pose) hand.glyph = POSES[event.pose][0];
    if (event.label && event.label !== hand.action && event.pose !== "think" && event.pose !== "look") hand.recent = [...hand.recent, event.label].slice(-RECENT);
    if (event.label !== undefined) hand.action = event.label;
  }
  changed();
}

/** A run has ended. The voice hears how, and says so if there is something to say. */
function settle(hand: Hand, status: Status, answer: string): void {
  hand.status = status;
  hand.answer = answer;
  record(hand, "status", status);
  console.log(`[${hand.name}] ${status}${answer ? `: ${answer}` : ""}`);
  if (status === "done") note(`${hand.name} has finished. Task: ${hand.task}\nWhat it reports: ${answer || "nothing"}`, true);
  else if (status === "failed") note(`${hand.name} could not finish its task (${hand.task}). ${answer}`, true);
  else note(`${hand.name} is now ${status}.`);
}

function close(hand: Hand): void {
  hand.closed = true;
  hand.proc.kill();
  hands.delete(hand.id);
  if (focus === hand.id) focus = null;
  console.log(`[${hand.name}] closed`);
  changed();
}

/** What the panel's buttons and the voice's tools both come down to. */
function steer(hand: Hand, text: string): void {
  record(hand, "steer", text);
  hand.answer = "";
  tell(hand, { type: "steer", text });
}

// ------------------------------------------------------------------ the voice

const MACHINE = onWindows() ? "Windows PC" : "Mac"; // the one word of these prompts that differs by platform

export const FRONTEND = `Personality:
You are Hands, the voice of a small team of agents, called hands, that work the user's ${MACHINE} for them. The user holds a key, says what they want, and lets go. Be brief and warm, like a capable colleague: a few words, never a speech. Never read out URLs, ids, or long lists.

Backchannel policy:
The user speaks in short push-to-talk bursts. Make no listening sounds while they speak.

Interruption policy:
If the user starts talking while you are speaking, stop and listen.

Delegation policy:
Backend tools:
- Hands: start one hand or several on tasks, steer a hand that is working, stop or close hands, and look up how each hand is doing.

You cannot do, open, look up, work out, or check anything yourself, and you never answer from your own knowledge. When the user asks for something, a hand does it on their ${MACHINE}, and you report what the hand found. "Open the calculator and work out twelve times twelve" is work for a hand, not a sum for you to do.

Delegate to the backend when:
- The user asks for anything at all to be done, opened, found, worked out, written or checked, however small or easy it seems.
- The user corrects, redirects, pauses, resumes, stops or closes a hand, or changes a task in progress.
- The user asks how a hand is doing, and the notes you have been given do not already answer it.

Do not delegate to the backend when:
- The user greets you, thanks you, or asks you to repeat something you already said.
- You cannot tell what they want without a brief clarifying question.
- A note you were given already answers the question.

Delegate before giving an answer that depends on backend work. You do not know a result until a note tells you a hand has finished and what it reports. Until then say only that it is being done: never a number, an answer, or "done", not even one you could work out yourself, because the user asked for it to be done on their computer and is watching it happen.
After delegating, confirm in a few words ("On it." "Two hands on it."), once. What the backend then tells you it did is for you to know, not to announce again.
If the user cuts in with a correction or an addition, delegate it together with what it corrects, so the backend sees both.
You are given notes about what the hands are doing and what they found. When a hand finishes, tell the user what it found in a sentence or two.`;

export const BACKEND = `You dispatch work to hands: agents that each operate one ${MACHINE} app or one browser window at a time, in the background, by themselves. You do not do tasks yourself and you cannot see the screen. You only call tools.

Act on the user's latest words in the light of everything before them. A short turn such as "yes", "make it four" or "not that one" means what it means given what came before, and a turn that cut in on an earlier one adds to it or corrects it: steer the hand that is already on it rather than starting another. Do not redo what you have already done.

Every task is carried out by operating the user's ${MACHINE}, and that is the point: the user wants it done on their computer, in the app or on the site they named ("open the calculator and work out 12 times 12" is a task for the Calculator app, not arithmetic). Never tell a hand to avoid the computer, never water a request down, and add no restrictions the user did not ask for.

- start_hands: one task per hand. Use several hands only when the parts are independent (different apps, sites, or lookups); otherwise one. A hand knows nothing of this conversation, so each task must stand alone: put every detail it needs into it, as a plain instruction, and keep what the user said about how: the app or site they named, their numbers, names and wording. At most ${MAX_HANDS} hands can be out at once.
- Two hands must not work in the same app at the same time, except the browser, where each gets a window of its own.
- steer_hand: the user adds to, corrects, or redirects what a hand is doing, or gives a finished or stopped hand something new. Phrase it as an instruction to that hand. "Carry on" resumes a paused hand.
- stop_hands halts hands but keeps them, so they can still be asked about or steered. close_hands dismisses them for good.
- get_hands: read it before answering anything about progress or results.
Hands are referred to by name; "all" means every hand.

When the tools have returned, reply with one short sentence on what you did, for the voice to know. If the latest words needed nothing from you (thanks, small talk), call no tools and say so in three words. Never invent a result.`;

const WHICH = { type: "string", description: 'A hand\'s name, or "all".' };
const TOOLS = [
  { type: "function", name: "start_hands", strict: true, description: "Start one new hand per task.", parameters: { type: "object", additionalProperties: false, required: ["tasks"], properties: { tasks: { type: "array", items: { type: "string", description: "A task that stands alone, as an instruction." } } } } },
  { type: "function", name: "steer_hand", strict: true, description: "Tell a hand something: a correction, an addition, a new task, or to carry on.", parameters: { type: "object", additionalProperties: false, required: ["hand", "message"], properties: { hand: WHICH, message: { type: "string" } } } },
  { type: "function", name: "stop_hands", strict: true, description: "Halt hands where they are. They stay, and can be steered again.", parameters: { type: "object", additionalProperties: false, required: ["hands"], properties: { hands: { type: "array", items: WHICH } } } },
  { type: "function", name: "close_hands", strict: true, description: "Dismiss hands for good.", parameters: { type: "object", additionalProperties: false, required: ["hands"], properties: { hands: { type: "array", items: WHICH } } } },
  { type: "function", name: "get_hands", strict: true, description: "Every hand: its status, task, what it is doing, its last few actions, and what it reported.", parameters: { type: "object", additionalProperties: false, required: [], properties: {} } },
]; // prettier-ignore

/** One tool call from the backend, done. What comes back is what the backend reads. */
export function dispatch(name: string, args: Record<string, unknown>, runs: string): unknown {
  const wanted = (key: string): Hand[] => named(hands.values(), [args[key]].flat().map(String));
  if (name === "start_hands") {
    return (args.tasks as string[]).map((task) => {
      const started = startHand(task, runs);
      return started ? { hand: started.name, task } : { task, error: `${MAX_HANDS} hands are already out: close one first` };
    });
  }
  if (name === "get_hands") return snapshot(hands.values());
  const found = wanted(name === "steer_hand" ? "hand" : "hands");
  if (!found.length) return { error: `no such hand. Out now: ${[...hands.values()].map((h) => h.name).join(", ") || "none"}` };
  for (const one of found) {
    if (name === "steer_hand") steer(one, String(args.message));
    else if (name === "stop_hands") tell(one, { type: "stop" });
    else if (name === "close_hands") close(one);
  }
  return { ok: found.map((one) => one.name) };
}

const voice: VoiceView = { state: "idle", heard: "", said: "" };
let live: LiveWS | null = null;
let started: Promise<void> | null = null;
let ready = false; // the session has started: audio may be sent
let spokenAt = Date.now(); // when anything last happened in the conversation: an open session costs by the minute
let quiet: ReturnType<typeof setTimeout> | undefined;

const sendLive = (event: object) => live?.send(event as never);

// The guide's loop, and nothing on top of it. "Supply a continuous microphone stream paced at its recorded sample rate":
// gpt-live-1 is full duplex and "manages when to listen and speak as audio streams continuously", so an open session is
// sent audio without a break: the microphone while the key is held, silence at the same pace while it is not. The key is
// this application's control of its own microphone. When the user has finished, what they want and whether to delegate
// it are all the model's to decide.
const SILENCE = Buffer.alloc((24000 * 2 * CHUNK_MS) / 1000).toString("base64");
const hear = (audio: string) => sendLive({ type: "session.input_audio.append", audio });

/**
 * Silence, for exactly as long as the clock says has passed. The voice speaks only as fast as it is sent audio: a chunk
 * per tick of a timer was 3% slow (measured), and so its speech arrived 3% slower than a speaker plays it.
 */
let due = 0;
function hum(): void {
  const now = performance.now();
  if (!ready || feed) return void (due = now); // the microphone keeps its own time
  for (due = Math.max(due, now - 1000); due <= now; due += CHUNK_MS) hear(SILENCE); // a Mac that slept does not owe the hours
}

/** Tell the voice something: `session.commentary.append` for it to say, `session.thinking.append` for it to know. A closed session is opened for it. */
function note(content: string, aloud = false): void {
  spokenAt = Date.now();
  void connect()
    .then(() => sendLive({ type: aloud ? "session.commentary.append" : "session.thinking.append", delegation_id: null, content: content.slice(0, NOTE_CHARS) }))
    .catch(() => {});
}

/** How the hands are getting on, for the voice to know: while they are working, when something has changed, and not while anyone is talking. */
let told = "";
function progress(): void {
  const now = snapshot(hands.values());
  if (!live || !ready || feed || voice.state !== "idle" || now === told || ![...hands.values()].some(active)) return;
  told = now;
  sendLive({ type: "session.thinking.append", delegation_id: null, content: `How the hands are getting on:\n${now}` });
}

function setVoice(state: VoiceView["state"]): void {
  if (voice.state === state) return;
  voice.state = state;
  changed();
}

/** The Live session, as in the guide: `LiveWS`, `session.start`, and handlers for what comes back. Started at launch, and again after an idle one was closed. */
function connect(): Promise<void> {
  if (live && started) return started;
  const session = (live = new LiveWS(new OpenAI()));
  started = new Promise((resolveStarted, reject) => {
    session.on("session.started", () => {
      ready = true;
      resolveStarted();
    });
    session.on("close", () => {
      if (live === session) [live, started, ready] = [null, null, false];
      reject(new Error("the voice hung up"));
      setVoice("idle");
    });
  });
  started.catch(() => {});
  session.on("error", (error) => console.error(`[voice] ${error.message}`));
  session.on("session.closed", () => session.close()); // finalized: the socket can go
  if (process.env.HANDS_DEBUG) session.on("event", (event) => /audio|transcript/.test(event.type) || console.error(`[live] ${JSON.stringify(event).slice(0, 400)}`));

  // Captions: what it heard, and what it is saying.
  session.on("session.input_transcript.delta", ({ delta }) => ((voice.heard += delta), changed()));
  session.on("session.output_transcript.delta", ({ delta }) => {
    voice.said += delta;
    spokenAt = Date.now();
    if (voice.state !== "listening") setVoice("speaking");
    clearTimeout(quiet);
    quiet = setTimeout(() => {
      if (voice.state !== "speaking") return;
      console.log(`[voice] “${voice.said.trim()}”`);
      voice.said = "";
      setVoice("idle");
    }, 2000);
    changed();
  });

  // Its speech: "decode delta from each session.output_audio.delta event and queue the audio for playback in order".
  // Except while the key is held: the microphone is open, and the voice is stopping anyway now that it hears the user.
  session.on("session.output_audio.delta", ({ delta }) => {
    if (feed) return;
    const pcm = Buffer.from(delta, "base64");
    if (!quietly) shell?.speaker.play(pcm);
    keep("voice", pcm); // the tape has the voice even when the room does not
  });

  // The backend's tool calls, as nested Responses events. A call is whole at output_item.done and the response at
  // completed: then every call is carried out, answered with a function_call_output, and the response continued.
  const calls = new Map<string, { name: string; arguments: string }>();
  session.on("response.event", ({ event }) => {
    spokenAt = Date.now();
    const item = event.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
    if (event.type === "response.output_item.done" && item?.type === "function_call" && item.call_id) calls.set(item.call_id, { name: item.name ?? "", arguments: item.arguments ?? "{}" });
    if (event.type !== "response.completed" || !calls.size) return;
    for (const [call_id, call] of calls) {
      let output: unknown;
      try {
        output = dispatch(call.name, JSON.parse(call.arguments), runsDir);
      } catch (error) {
        output = { error: String(error) };
      }
      console.log(`[backend] ${call.name} ${call.arguments} -> ${JSON.stringify(output)}`);
      sendLive({ type: "response.item.create", item: { type: "function_call_output", call_id, output: JSON.stringify(output) } });
    }
    calls.clear();
    sendLive({ type: "response.create" });
  });

  sendLive({
    type: "session.start",
    session: {
      model: config.liveModel(),
      audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: config.liveVoice() } },
      instructions: FRONTEND,
      // A session started again, after an idle one was closed, is told how things stand; the hands outlive sessions.
      input: hands.size ? [{ type: "message", role: "developer", content: [{ type: "input_text", text: `How the hands are getting on:\n${snapshot(hands.values())}` }] }] : undefined,
      delegation: { type: "responses", responses: { model: config.liveBackend(), instructions: (toldBackend = backendPrompt()), tools: TOOLS, parallel_tool_calls: true, reasoning: { effort: "low" } } },
    },
  });
  return started;
}

/** The backend's standing picture of the hands: who is out and on what. What each is doing this minute it gets from get_hands. */
const backendPrompt = () => `${BACKEND}\n\nHands out right now:\n${[...hands.values()].map((one) => `- ${one.name} [${one.status}]: ${one.task}`).join("\n") || "none"}`;
let toldBackend = "";
let runsDir = "";

/** The key: this application's control of its microphone. Down, the voice hears the room; up, it hears silence again. */
function talk(phase: Talk): void {
  if (!shell) return;
  spokenAt = Date.now();
  if (phase === "down") {
    shell.speaker.hush(); // talking over it stops it, here at once and there as soon as it hears the user
    [voice.heard, voice.said] = ["", ""];
    const waiting: string[] = []; // what is said while a session is still being started: "buffer the opening speech through connection setup"
    let open = false;
    connect()
      .then(() => {
        for (const audio of waiting.splice(0)) hear(audio);
        open = true;
      })
      .catch((error) => (console.error(`[voice] ${error.message}`), setVoice("idle")));
    setVoice("listening");
    announce(); // at once: the panel's answer to the key is what makes it feel held
    fromFile = speaking;
    if (!fromFile) console.log("[key] listening…");
    let chunks = 0;
    feed = (pcm) => {
      keep("you", pcm);
      const audio = Buffer.from(pcm).toString("base64");
      if (open) hear(audio);
      else waiting.push(audio);
      if (chunks++ % 2) return; // the panel's fingers move with the voice: a dozen times a second is plenty
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
      let peak = 0;
      for (let at = 0; at < samples.length; at += 4) peak = Math.max(peak, Math.abs(samples[at]!));
      publish({ type: "level", value: Math.min(1, Math.sqrt(peak / 12000)) });
    };
    if (!speaking) shell.mic.listen((pcm) => feed?.(pcm)); // beginning with what the microphone remembered from just before the key went down
    return;
  }
  feed = null;
  shell.mic.rest(warm);
  setVoice(phase === "up" ? "thinking" : "idle");
  announce();
  if (phase !== "up") return void (fromFile || console.log("[key] let go too soon, or a key was typed with it: ignored"));
  if (!fromFile) setTimeout(() => console.log(`[you] ${voice.heard.trim() || "(nothing was heard)"}`), 2000); // the transcript trails the speech
  setTimeout(() => voice.state === "thinking" && setVoice("idle"), 12_000);
}

let feed: ((pcm: Uint8Array) => void) | null = null;

// ------------------------------------------------------------------ the tape

/**
 * `HANDS_TAPE=take.wav`: both sides of the conversation on one track, as they were heard, to lay under a screen
 * recording (which can only hear the room, and hears nothing of the voice through headphones).
 * ponytail: held in memory until Ctrl-C, 3 MB a minute of talk. Stream it to disk if a take ever runs for hours.
 */
const tape = { from: performance.now(), startedAt: Date.now(), until: { you: 0, voice: 0 }, tracks: { you: [] as [number, Int16Array][], voice: [] as [number, Int16Array][] } };
function keep(who: "you" | "voice", pcm: Uint8Array): void {
  if (!process.env.HANDS_TAPE) return;
  const [now, samples] = [performance.now() - tape.from, new Int16Array(new Uint8Array(pcm).buffer, 0, pcm.length >> 1)]; // a copy: the microphone's buffer is used again
  // The voice is laid down by the speaker's own rule, so the tape has what was heard. The microphone's chunks follow one another unless a pause parts them.
  const pad = who === "voice" ? cushion(Math.max(0, tape.until.voice - now), samples.every((sample) => Math.abs(sample) < 100)) : now - tape.until.you > 100 ? now - tape.until.you : 0;
  if (pad === null) return;
  const at = Math.max(tape.until[who], who === "voice" ? now : 0) + pad;
  tape.tracks[who].push([at, samples]);
  tape.until[who] = at + samples.length / 24;
}
function writeTape(path: string): void {
  const mix = new Float32Array(Math.ceil(Math.max(tape.until.you, tape.until.voice) * 24) + 1);
  for (const chunks of Object.values(tape.tracks)) {
    let peak = 1;
    for (const [, samples] of chunks) for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    const gain = Math.min(12, 23000 / peak); // each side as loud as the other
    for (const [at, samples] of chunks) for (let i = 0, to = Math.round(at * 24); i < samples.length; i++) mix[to + i]! += samples[i]! * gain;
  }
  const wav = Buffer.alloc(44 + mix.length * 2);
  wav.write("RIFF", 0), wav.writeUInt32LE(36 + mix.length * 2, 4), wav.write("WAVEfmt ", 8), wav.writeUInt32LE(16, 16), wav.writeUInt16LE(1, 20), wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24), wav.writeUInt32LE(48000, 28), wav.writeUInt16LE(2, 32), wav.writeUInt16LE(16, 34), wav.write("data", 36), wav.writeUInt32LE(mix.length * 2, 40);
  mix.forEach((sample, i) => wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), 44 + i * 2));
  writeFileSync(path, wav);
  writeFileSync(`${path}.json`, JSON.stringify({ startedAt: tape.startedAt }));
}
let quietly = false; // `--quiet`: the voice is read off the panel, not heard
let warm = true; // the microphone stays open between presses, remembering its last third of a second (`--cold-mic` turns that off)
let speaking = false; // `--say`: the words come from a file, not the microphone
let fromFile = false; // and so did the turn being taken

/** The samples in a WAV file: the body of its `data` chunk, wherever the other chunks have put it. */
export function samplesOf(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  for (let at = 12; at + 8 <= wav.length; ) {
    const size = view.getUint32(at + 4, true);
    if (String.fromCharCode(...wav.subarray(at, at + 4)) === "data") return wav.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  throw new Error("no samples in that WAV");
}

/** Say something to the voice without a microphone: the words are synthesized, and the key is held for as long as they last. */
async function say(text: string, runs: string): Promise<void> {
  const [aiff, wav] = [join(runs, "say.aiff"), join(runs, "say.wav")];
  if (onWindows()) {
    // System.Speech writes the 24 kHz mono 16-bit WAV directly; the text goes in as a base64 argument so no quoting can break it.
    const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav.replaceAll("'", "''")}', (New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono))); $s.Speak([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text, "utf8").toString("base64")}'))); $s.Dispose()`;
    await Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script]).exited;
  } else {
    await Bun.spawn(["say", "-o", aiff, text]).exited;
    await Bun.spawn(["afconvert", "-f", "WAVE", "-d", "LEI16@24000", "-c", "1", aiff, wav]).exited;
  }
  const pcm = samplesOf(new Uint8Array(await Bun.file(wav).arrayBuffer()));
  console.log(`[you] ${text}`);
  speaking = true;
  shell?.holdKey(true);
  await Bun.sleep(300);
  const chunk = (24000 * 2 * CHUNK_MS) / 1000;
  for (let at = 0, next = performance.now(); at < pcm.length; at += chunk, next += CHUNK_MS, await Bun.sleep(Math.max(0, next - performance.now()))) feed?.(pcm.subarray(at, at + chunk));
  shell?.holdKey(false);
  speaking = false;
}

// ------------------------------------------------------------------ the panel

let shell: Shell | null = null;
let focus: string | null = null;
const viewers = new Set<Bun.ServerWebSocket<unknown>>();
let dirty = false;

const publish = (message: ServerMessage) => {
  for (const viewer of viewers) viewer.send(JSON.stringify(message));
};

/** Something changed: the panel is told shortly, and the backend's picture of the hands is brought up to date. */
function changed(): void {
  if (dirty) return;
  dirty = true;
  setTimeout(announce, 60);
}

/** The state of things, to the panel, now. */
function announce(): void {
  {
    dirty = false;
    const views = [...hands.values()].map(({ proc, log, recent, window, closed, ...view }): HandView => view);
    publish({ type: "state", hands: views, voice, focus, room: shell?.panel.room() ?? 800 });
    if (focus) shell?.panel.focus(true);
    focus = null; // said once: the card opens, and is the page's from then on
    if (live && ready && toldBackend !== (toldBackend = backendPrompt())) sendLive({ type: "session.update", session: { delegation: { type: "responses", responses: { instructions: toldBackend } } } });
  }
}

function command(message: ClientMessage): void {
  if (process.env.HANDS_DEBUG) console.error(`[panel] ${JSON.stringify(message)}`);
  if (message.cmd === "size") return shell?.panel.fit(message.width, message.height);
  if (message.cmd === "focus") return shell?.panel.focus(message.on);
  const target = hands.get(message.hand);
  if (!target) return;
  if (message.cmd === "steer") steer(target, message.text);
  else if (message.cmd === "close") close(target);
  else tell(target, { type: message.cmd });
}

function serve(key: string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: { "/": page },
    // Anything on this machine can reach a local port, a web page included, and this socket steers agents that work
    // the Mac: it opens only to whoever holds the key the panel was started with.
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname !== "/ws" || url.searchParams.get("key") !== key) return new Response("not found", { status: 404 });
      return server.upgrade(request) ? undefined : new Response("expected a websocket", { status: 400 });
    },
    websocket: {
      open(viewer) {
        viewers.add(viewer);
        if (process.env.HANDS_DEBUG) console.error("[panel] connected");
        for (const one of hands.values()) viewer.send(JSON.stringify({ type: "log", hand: one.id, entries: one.log, reset: true } satisfies ServerMessage));
        changed();
      },
      close: (viewer) => void viewers.delete(viewer),
      message: (_viewer, message) => command(JSON.parse(String(message))),
    },
  });
}

/** Turn and turn about: one hand's window is photographed each tick, unless the user is looking at the window itself. */
function film(): void {
  let turn = 0;
  setInterval(() => {
    const front = shell?.frontWindow() ?? null;
    const filmed = [...hands.values()].filter((one) => one.window !== null);
    for (const one of filmed) {
      if (one.viewing === (one.window === front)) continue;
      one.viewing = one.window === front;
      changed();
    }
    const one = filmed[turn++ % Math.max(1, filmed.length)];
    if (!one || one.viewing || !viewers.size) return;
    const jpeg = shell?.thumbnail(one.window!);
    if (!jpeg) return;
    const id = new TextEncoder().encode(one.id);
    const frame = new Uint8Array(1 + id.length + jpeg.length);
    frame.set([id.length]);
    frame.set(id, 1);
    frame.set(jpeg, 1 + id.length);
    for (const viewer of viewers) viewer.send(frame);
  }, FRAME_MS);
}

// ------------------------------------------------------------------ main

const TALK_KEY = onWindows() ? "left Ctrl key" : "right Option key";

const USAGE = `usage: bun live [--quiet] [--say "words"]... [--every SECONDS] [--out DIR]

Hold the ${TALK_KEY}, say what you want done, and let go. ${config.liveModel()} hears it and sends out hands:
one, or several at once. The corner of the screen shows each hand's window; click a card for its transcript and
to steer it, or click the hand itself to stop it where it is. Tell the voice to steer, stop or close hands too.

  --quiet        the voice does not speak: what it says shows in the panel only.
  --cold-mic     open the microphone only while the key is held. By default it stays open and remembers its last third
                 of a second (in memory only: nothing is sent until the key is held), so that a press never clips the
                 start of a sentence; the price is the system's microphone light staying on. Cold, about a tenth of
                 a second at the start of each press is lost.
  --say WORDS    say this to the voice instead of holding the key (synthesized speech): for trying it without a
                 microphone. Give it several times to say several things, --every SECONDS apart (default 30).`;

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { quiet: { type: "boolean", default: false }, "cold-mic": { type: "boolean", default: false }, say: { type: "string", multiple: true }, every: { type: "string", default: "30" }, out: { type: "string", default: join("runs", `live-${timestamp()}`) }, help: { type: "boolean", short: "h", default: false } },
  });
  if (values.help) return void console.log(USAGE);
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set (put it in .env): the voice is OpenAI's");
  if (!macos.accessibilityTrusted()) throw new Error(PERMISSION);
  const runs = resolve(values.out);
  mkdirSync(runs, { recursive: true });
  quietly = values.quiet;
  warm = !values["cold-mic"] && !values.say?.length;

  const key = crypto.randomUUID();
  const server = serve(key);
  runsDir = runs;
  shell = startShell({ url: `http://127.0.0.1:${server.port}/?key=${key}`, onTalk: talk });
  film();
  // Ready before the first press: the session already started, the microphone already open and remembering.
  void connect().catch(() => {});
  if (warm) shell.mic.warm();
  // The stream never stops while a session is open: whenever the microphone has not just spoken, silence does, at the same pace.
  setInterval(hum, CHUNK_MS / 2);
  setInterval(progress, PROGRESS_MS);
  // And a session nobody has said anything in for a while is closed the way the guide closes one: asked to, and let finish.
  setInterval(() => live && ready && !feed && voice.state === "idle" && Date.now() - spokenAt > IDLE_MS && sendLive({ type: "session.close" }), 5000);
  if (process.env.HANDS_DEBUG && process.platform !== "win32") process.on("SIGUSR2", () => live?.close()); // hang up on the voice, to see it call back
  if (process.env.HANDS_SAY && process.platform !== "win32") process.on("SIGUSR1", () => void say(readFileSync(process.env.HANDS_SAY!, "utf8").trim(), runs)); // a line said on cue: a take directed from outside
  process.on("SIGINT", () => {
    for (const one of [...hands.values()]) close(one);
    live?.close();
    if (process.env.HANDS_TAPE) writeTape(process.env.HANDS_TAPE);
    process.exit(130);
  });
  console.log(`run folder: ${runs}\nhold the ${TALK_KEY} and say what you want done. Ctrl-C to quit.`);

  for (const words of values.say ?? []) {
    await say(words, runs);
    await Bun.sleep(Number(values.every) * 1000);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
