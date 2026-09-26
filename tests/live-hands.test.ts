import { afterAll, afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as live from "../src/live.ts";
import type { Shell } from "../src/shell.ts";
import * as windows from "../src/windows.ts";

// The orchestrator with its outside replaced: each hand a scripted process (what it is told, what it says, when it
// goes), and the voice a scripted Live session. Nothing here starts a process or opens a socket.

const encoder = new TextEncoder();
const scratch = mkdtempSync(join(tmpdir(), "hands-live-"));
let runs: string;

interface Fake {
  proc: live.HandProcess;
  told: Record<string, unknown>[];
  killed: boolean;
  say(event: object): void;
  complain(line: string): void;
  finish(code: number): void;
}

/** A hand's process: it goes when its stdin ends, unless it is stubborn, and when it is killed. */
function fakeHand(stubborn: boolean): Fake {
  let [out, err] = [null, null] as unknown as [ReadableStreamDefaultController<Uint8Array>, ReadableStreamDefaultController<Uint8Array>];
  let exit: (code: number) => void = () => {};
  let over = false;
  const fake: Fake = {
    told: [],
    killed: false,
    say: (event) => out.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)),
    complain: (line) => err.enqueue(encoder.encode(`${line}\n`)),
    finish(code) {
      if (over) return;
      over = true;
      out.close();
      err.close();
      exit(code);
    },
    proc: {
      stdin: {
        write: (data: string) => void fake.told.push(...data.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line))),
        flush() {},
        end: () => void (stubborn || fake.finish(0)),
      },
      stdout: new ReadableStream({ start: (controller) => void (out = controller) }),
      stderr: new ReadableStream({ start: (controller) => void (err = controller) }),
      exited: new Promise<number>((resolve) => (exit = resolve)),
      kill: () => {
        fake.killed = true;
        fake.finish(1);
      },
    },
  };
  return fake;
}

/** A Live session: what it was sent, and a start that comes at once unless it is not answering. */
class FakeSession {
  sent: { type: string; [key: string]: any }[] = [];
  private handlers = new Map<string, ((event: any) => void)[]>();
  private over = false;
  constructor(private readonly answers: boolean) {}
  on(type: string, handler: (event: any) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  send(event: { type: string }): void {
    this.sent.push(event);
    if (event.type === "session.start" && this.answers) queueMicrotask(() => this.emit("session.started", {}));
  }
  close(): void {
    if (this.over) return;
    this.over = true;
    this.emit("close", {});
  }
  emit(type: string, event: object): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
  notes(type: "session.commentary.append" | "session.thinking.append"): string[] {
    return this.sent.filter((event) => event.type === type).map((event) => event.content);
  }
}

let hands: Fake[];
let commands: string[][];
let sessions: FakeSession[];
let answering: boolean;
let stubborn: boolean;

/** Let the hands' lines be read, and what they set off happen. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const known = () => live.dispatch("get_hands", {}, runs) as live.Brief[];

beforeEach(() => {
  [hands, commands, sessions, answering, stubborn] = [[], [], [], true, false];
  runs = mkdtempSync(join(scratch, "runs-"));
  process.env.HANDS_WORK = join(scratch, "Documents", "Hands");
  process.env.HANDS_PROFILE = join(scratch, "profile.md");
  spyOn(live.outside, "spawn").mockImplementation((command) => {
    const fake = fakeHand(stubborn);
    hands.push(fake);
    commands.push(command);
    return fake.proc;
  });
  spyOn(live.outside, "voice").mockImplementation(() => {
    const session = new FakeSession(answering);
    sessions.push(session);
    return session as never;
  });
});

afterEach(async () => {
  jest.useRealTimers();
  live.dispatch("close_hands", { hands: ["all"] }, runs);
  await Bun.sleep(10);
  live.hangUp();
  mock.restore();
  delete process.env.HANDS_WORK;
  delete process.env.HANDS_PROFILE;
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("a hand is told its task the moment it is started, works in the hands' folder, and has a run folder no other hand had", async () => {
  expect(live.dispatch("start_hands", { tasks: ["Open the calculator and work out 12 times 12"] }, runs)).toEqual([{ hand: "Lefty", state: "started", result: "pending" }]);
  expect(hands[0]!.told).toEqual([{ type: "prompt", text: "Open the calculator and work out 12 times 12" }]); // before it has said a word
  const command = commands[0]!;
  expect(command).not.toContain("--background");
  expect(command.slice(command.indexOf("--json"))).toEqual(["--json", "--name", "Lefty", "--color", "4f8cff", "--cwd", process.env.HANDS_WORK!, "--out", join(runs, "lefty")]);
  expect(existsSync(process.env.HANDS_WORK!)).toBe(true);
  hands[0]!.say({ type: "ready" }); // only a status now
  await Bun.sleep(5);
  expect(hands[0]!.told.length).toBe(1);

  live.dispatch("close_hands", { hands: ["Lefty"] }, runs);
  await Bun.sleep(5);
  live.dispatch("start_hands", { tasks: ["Open Notepad"] }, runs);
  expect(commands[1]!.at(-1)).toBe(join(runs, "lefty-2"));
});

test("a task a hand is already on gives that hand back, not a second hand", () => {
  live.dispatch("start_hands", { tasks: ["Find the cheapest flight from Hong Kong to Tokyo"] }, runs);
  expect(live.dispatch("start_hands", { tasks: ["find the cheapest flights from Hong Kong to Tokyo"] }, runs)).toEqual([{ hand: "Lefty", state: "already on it", result: "pending" }]);
  expect(live.dispatch("start_hands", { tasks: ["Find the cheapest flight from Hong Kong to Paris"] }, runs)).toEqual([{ hand: "Righty", state: "started", result: "pending" }]);
  expect(hands.length).toBe(2);
});

test("a steer is delivered, not done; to a hand at work it is the latest word on its task, to a finished one a new task", async () => {
  live.dispatch("start_hands", { tasks: ["find flights to Tokyo"] }, runs);
  expect(live.dispatch("steer_hand", { hand: "lefty", message: "only direct ones" }, runs)).toEqual({ hand: "Lefty", state: "instruction delivered", result: "pending" });
  expect(hands[0]!.told.at(-1)).toEqual({ type: "steer", text: "only direct ones" });
  expect(known()[0]!.task).toBe("find flights to Tokyo → now: only direct ones");
  hands[0]!.say({ type: "status", status: "working" });
  hands[0]!.say({ type: "status", status: "done", answer: "Two direct flights." });
  await Bun.sleep(5);
  live.dispatch("steer_hand", { hand: "Lefty", message: "book a table at Yashima" }, runs);
  expect(known()[0]).toMatchObject({ task: "book a table at Yashima", status: "done" });
  expect(known()[0]!.answer).toBeUndefined();
});

test("a stop is asked for, not done, and only of a hand at work", async () => {
  live.dispatch("start_hands", { tasks: ["watch YouTube Shorts"] }, runs);
  expect(live.dispatch("stop_hands", { hands: ["Lefty"] }, runs)).toEqual({ hand: "Lefty", state: "stop requested", result: "pending" });
  expect(hands[0]!.told.at(-1)).toEqual({ type: "stop" });
  hands[0]!.say({ type: "status", status: "stopped" });
  await Bun.sleep(5);
  expect(live.dispatch("stop_hands", { hands: ["Lefty"] }, runs)).toEqual({ hand: "Lefty", state: "not working: stopped" });
});

test("a hand whose process ends without being dismissed has failed, whatever it was doing, and its stderr says why", async () => {
  live.dispatch("start_hands", { tasks: ["open Excel"] }, runs);
  const lefty = hands[0]!;
  lefty.complain("TYPESAFE_API_KEY is not set");
  lefty.complain("error: the Windows helper went away (write error 232)");
  lefty.finish(1);
  await Bun.sleep(20);
  expect(known()[0]).toMatchObject({ hand: "Lefty", status: "failed" });
  expect(known()[0]!.reason).toContain("the Windows helper went away (write error 232)");
  expect(readFileSync(join(runs, "lefty", "stderr.log"), "utf8")).toContain("write error 232");
  expect(live.dispatch("steer_hand", { hand: "Lefty", message: "try again" }, runs)).toEqual({ hand: "Lefty", error: "Lefty has gone: its process ended. Start a new hand if its task is still wanted." });
  expect(sessions.at(-1)!.notes("session.commentary.append")).toEqual(["Lefty couldn't finish: TYPESAFE_API_KEY is not set / error: the Windows helper went away (write error 232)"]);
});

test("a hand that never says it is ready is ended after 30 s, and has failed", async () => {
  jest.useFakeTimers();
  live.dispatch("start_hands", { tasks: ["open Paint"] }, runs);
  jest.advanceTimersByTime(29_000);
  expect(hands[0]!.killed).toBe(false);
  jest.advanceTimersByTime(1_000);
  expect(hands[0]!.killed).toBe(true);
  jest.useRealTimers();
  await Bun.sleep(20);
  expect(known()[0]).toMatchObject({ status: "failed", reason: "it did not start within 30 s" });
});

test("a dismissed hand leaves the card and the voice's list at once, is asked to close, and is ended if it has not gone in 2 s", async () => {
  live.dispatch("start_hands", { tasks: ["open Notepad"] }, runs);
  expect(live.dispatch("close_hands", { hands: ["Lefty"] }, runs)).toEqual({ hand: "Lefty", state: "dismissed" });
  expect(hands[0]!.told.at(-1)).toEqual({ type: "close" });
  await Bun.sleep(5);
  expect(hands[0]!.killed).toBe(false); // it went when asked

  stubborn = true;
  live.dispatch("start_hands", { tasks: ["open Paint"] }, runs);
  jest.useFakeTimers();
  live.dispatch("close_hands", { hands: ["Lefty"] }, runs);
  expect(live.dispatch("get_hands", {}, runs)).toBe("No hands are out.");
  jest.advanceTimersByTime(1900);
  await settle();
  expect(hands[1]!.killed).toBe(false);
  jest.advanceTimersByTime(200);
  await settle();
  expect(hands[1]!.killed).toBe(true);
});

test("when all eight are out, the oldest finished hand makes way, its windows kept; with none finished, a ninth is refused", async () => {
  const tasks = ["open Paint", "open Notepad", "open the calculator", "open Excel", "open Word", "open Outlook", "open Teams", "open Spotify"];
  live.dispatch("start_hands", { tasks }, runs);
  expect(live.dispatch("start_hands", { tasks: ["open Maps"] }, runs)).toEqual([{ task: "open Maps", error: "8 hands are out and none has finished: stop or close one first" }]);
  hands[1]!.say({ type: "status", status: "done", answer: "Notepad is open." });
  hands[0]!.say({ type: "status", status: "done", answer: "Paint is open." });
  await Bun.sleep(5);
  expect(live.dispatch("start_hands", { tasks: ["open the Clock app"] }, runs)).toEqual([{ hand: "Lefty", state: "started", result: "pending" }]);
  expect(hands[0]!.told.at(-1)).toEqual({ type: "close", keep: true }); // Lefty came first, whatever finished first
  expect(hands[1]!.told.at(-1)).toEqual({ type: "prompt", text: "open Notepad" });
  expect(commands[8]!.at(-1)).toBe(join(runs, "lefty-2"));
});

test("the voice is to say a hand's outcome once, from a short plain summary; a stop or a dismissal it only knows", async () => {
  live.dispatch("start_hands", { tasks: ["find lunch nearby"] }, runs);
  const lefty = hands[0]!;
  lefty.say({ type: "status", status: "working" });
  lefty.say({ type: "status", status: "done", answer: "## Lunch\n\n**Yashima** has [an omakase](https://yashima.hk) at 12:30.\n\nIt is 6 minutes away on foot." });
  await Bun.sleep(5);
  const session = sessions.at(-1)!;
  expect(session.notes("session.commentary.append")).toEqual(["Lefty has finished: Yashima has an omakase at 12:30. It is 6 minutes away on foot. (Its task: find lunch nearby)"]);
  expect(known()[0]).toMatchObject({ reported: true });

  live.dispatch("steer_hand", { hand: "Lefty", message: "book it for two" }, runs);
  lefty.say({ type: "status", status: "working" });
  lefty.say({ type: "status", status: "needs_you", answer: "The booking site wants you to sign in to Google." });
  await Bun.sleep(5);
  expect(session.notes("session.commentary.append").at(-1)).toBe("Lefty needs you: The booking site wants you to sign in to Google.");

  lefty.say({ type: "status", status: "stopped" });
  await Bun.sleep(5);
  live.dispatch("close_hands", { hands: ["Lefty"] }, runs);
  expect(session.notes("session.thinking.append").slice(-2)).toEqual(["For you to know, not to say: Lefty is now stopped.", "For you to know, not to say: Lefty was dismissed."]);
  expect(session.notes("session.commentary.append").length).toBe(2);
});

test("while the voice is speaking, what it is to say next waits until it has finished", async () => {
  live.dispatch("start_hands", { tasks: ["open Paint", "open Notepad"] }, runs);
  hands[0]!.say({ type: "status", status: "done", answer: "Paint is open." });
  await Bun.sleep(5);
  const session = sessions.at(-1)!;
  jest.useFakeTimers();
  session.emit("session.output_transcript.delta", { delta: "Lefty opened Paint.", start_ms: 1000, end_ms: 1800 });
  expect(live.voice.state).toBe("speaking");
  hands[1]!.say({ type: "status", status: "done", answer: "Notepad is open." });
  await settle();
  expect(session.notes("session.commentary.append").length).toBe(1);
  jest.advanceTimersByTime(2000);
  expect(live.voice.state).toBe("idle");
  expect(session.notes("session.commentary.append").at(-1)).toContain("Righty has finished: Notepad is open.");
});

test("the key: what the voice is to say waits while it is held, a silent microphone says so, and the last syllable is heard out", async () => {
  const listening: ((pcm: Uint8Array) => void)[] = [];
  const rested: boolean[] = [];
  const body = {
    mic: { warm() {}, listen: (onChunk: (pcm: Uint8Array) => void) => void listening.push(onChunk), rest: (warm: boolean) => void rested.push(warm) },
    speaker: { play() {}, hush() {} },
    panel: { fit() {}, room: () => 800, focus() {} },
    thumbnail: () => null,
    holdKey() {},
    frontWindow: () => null,
  } as unknown as Shell;
  live.dispatch("start_hands", { tasks: ["open Paint", "open Notepad"] }, runs);
  hands[0]!.say({ type: "status", status: "done", answer: "Paint is open." });
  await Bun.sleep(5);
  const session = sessions.at(-1)!;
  jest.useFakeTimers();
  try {
    live.talk("down", body);
    expect(live.voice.state).toBe("listening");
    listening[0]!(new Uint8Array(3840)); // 80 ms of a microphone that gives nothing
    await settle();
    expect(session.sent.filter((event) => event.type === "session.input_audio.append").length).toBe(1);
    hands[1]!.say({ type: "status", status: "done", answer: "Notepad is open." });
    await settle();
    expect(session.notes("session.commentary.append").length).toBe(1); // not while the user is talking
    live.talk("up", body);
    expect(live.voice).toMatchObject({ state: "thinking", notice: "Your microphone is silent: check System Settings > Privacy & Security > Microphone" });
    jest.advanceTimersByTime(250);
    expect(rested).toEqual([]); // still listening: the key comes up before the word is out
    jest.advanceTimersByTime(50);
    expect(rested).toEqual([true]);
    jest.advanceTimersByTime(12_000); // no reply came
    expect(live.voice.state).toBe("idle");
    expect(session.notes("session.commentary.append").at(-1)).toContain("Righty has finished: Notepad is open.");
  } finally {
    live.talk("cancel", body);
  }
});

test("a session nobody has talked in for a minute is closed, but not before it has had time to say what it was just given", async () => {
  jest.useFakeTimers();
  live.dispatch("start_hands", { tasks: ["open Paint"] }, runs);
  hands[0]!.say({ type: "ready" });
  await settle();
  jest.advanceTimersByTime(61_000); // nobody talking, and nothing coming from the hands: their news does not count as talk
  hands[0]!.say({ type: "status", status: "done", answer: "Paint is open." });
  await settle();
  const session = sessions.at(-1)!;
  expect(session.notes("session.commentary.append").length).toBe(1);
  jest.advanceTimersByTime(1000);
  live.closeIdle();
  expect(session.sent.some((event) => event.type === "session.close")).toBe(false); // it has not begun to say it
  jest.advanceTimersByTime(15_000);
  live.closeIdle();
  expect(session.sent.at(-1)).toEqual({ type: "session.close" });
});

test("a voice that does not answer in 8 s is offline, the dock says so, and a later try gets the note through", async () => {
  answering = false;
  jest.useFakeTimers();
  live.dispatch("start_hands", { tasks: ["open Paint"] }, runs);
  hands[0]!.say({ type: "status", status: "done", answer: "Paint is open." });
  await settle();
  expect(sessions.length).toBe(1);
  jest.advanceTimersByTime(8000);
  expect(live.voice).toMatchObject({ state: "offline", notice: "Can't reach the voice. Retrying…" });
  answering = true;
  jest.advanceTimersByTime(2000); // the first retry
  expect(sessions.length).toBe(2);
  await settle();
  expect(live.voice).toMatchObject({ state: "idle", notice: "" });
  expect(sessions[1]!.notes("session.commentary.append")).toEqual(["Lefty has finished: Paint is open. (Its task: open Paint)"]);
});

test("a new session is told the conversation so far: the tool calls, what the voice said, and the hands", async () => {
  live.dispatch("start_hands", { tasks: ["open Paint", "open Notepad"] }, runs);
  hands[0]!.say({ type: "status", status: "done", answer: "Paint is open." });
  await Bun.sleep(5);
  const first = sessions.at(-1)!;
  first.emit("response.event", { event: { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "stop_hands", arguments: JSON.stringify({ hands: ["Righty"] }) } } });
  first.emit("response.event", { event: { type: "response.completed" } });
  expect(first.sent.find((event) => event.type === "response.item.create")?.item.output).toBe(JSON.stringify({ hand: "Righty", state: "stop requested", result: "pending" }));
  first.emit("session.output_transcript.delta", { delta: "Stopping it.", start_ms: 0, end_ms: 400 });
  first.emit("session.output_transcript.delta", { delta: "Righty is stopping.", start_ms: 2000, end_ms: 2600 }); // another reply: the first is logged
  first.emit("session.closed", {});
  hands[1]!.say({ type: "status", status: "done", answer: "Notepad is open." });
  await Bun.sleep(5);
  const second = sessions.at(-1)!;
  expect(second).not.toBe(first);
  const told = second.sent[0]!.session.input[0].content[0].text as string;
  expect(told).toContain('Backend: stop_hands {"hands":["Righty"]} -> {"hand":"Righty","state":"stop requested","result":"pending"}');
  expect(told).toContain("You: Stopping it.");
  expect(told).toContain("- Righty [done] task: open Notepad");
});

test("a fact the backend remembers goes in the user's profile, and every later session is told it", async () => {
  expect(live.dispatch("remember", { fact: "Kartikay (not Kartike) is a colleague." }, runs)).toEqual({ state: "remembered" });
  expect(readFileSync(process.env.HANDS_PROFILE!, "utf8")).toContain("- Kartikay (not Kartike) is a colleague.\n");
  live.dispatch("start_hands", { tasks: ["open Paint"] }, runs);
  hands[0]!.say({ type: "status", status: "done", answer: "Paint is open." });
  await Bun.sleep(5);
  const start = sessions.at(-1)!.sent[0]!.session;
  expect(start.instructions).toContain("Kartikay (not Kartike) is a colleague.");
  expect(start.delegation.responses.instructions).toContain("Kartikay (not Kartike) is a colleague.");
});

test("Show is carried out by the hand, which knows where it keeps its window; a hand whose process has gone is shown from here; on the Mac it is nothing", async () => {
  const present = spyOn(windows, "present").mockImplementation(() => true);
  live.dispatch("start_hands", { tasks: ["find flights to Tokyo", "open Notepad"] }, runs);
  hands[0]!.say({ type: "cue", subject: { window: 4242, origin: [0, 0] }, size: [1280, 800] });
  hands[1]!.say({ type: "cue", subject: { window: 99, origin: [0, 0] }, size: [800, 600] });
  await Bun.sleep(5);
  live.command({ cmd: "show", hand: "lefty" }); // the Mac's panel offers no Show, and one that comes anyway does nothing
  expect(hands[0]!.told.at(-1)).toEqual({ type: "prompt", text: "find flights to Tokyo" });
  process.env.HANDS_PLATFORM = "windows";
  try {
    live.command({ cmd: "show", hand: "lefty" });
    expect(hands[0]!.told.at(-1)).toEqual({ type: "show", window: 4242 }); // parked off the screens, it is the hand that knows where to
    expect(present).not.toHaveBeenCalled();
    hands[1]!.finish(1);
    await Bun.sleep(20);
    live.command({ cmd: "show", hand: "righty" });
    expect(present).toHaveBeenCalledWith(99);
  } finally {
    delete process.env.HANDS_PLATFORM;
  }
});
