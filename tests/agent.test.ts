import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason, ToolResultMessage } from "@earendil-works/pi-ai";
import { ending, keptOpen, letGo, logTo, managed, pruneScreens, scrubbed, staleCount, systemPrompt } from "../src/agent.ts";
import type { Outcome } from "../src/tools.ts";

const STUB = "[an earlier screen; call `screen` for the current one]";

/** A tool result carrying a listing and a screenshot, as `screen` does when asked for the picture. */
const result = (toolName: string, n: number): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: `call-${n}`,
  toolName,
  content: [
    { type: "text", text: `${toolName} ${n}` },
    { type: "image", data: `shot-${n}`, mimeType: "image/jpeg" },
  ],
  isError: false,
  timestamp: n,
});

const screens = (count: number) => Array.from({ length: count }, (_, n) => result("screen", n));

/** Each screen result as what is left of it: a stub, its text alone, or all of it. */
const shapes = (messages: AgentMessage[]) =>
  messages.flatMap((m) => {
    if (m.role !== "toolResult" || m.toolName !== "screen") return [];
    const [first] = m.content;
    if (first?.type === "text" && first.text === STUB) return ["stub"];
    return [m.content.some((block) => block.type === "image") ? "full" : "text"];
  });

test("everything but the newest few is stale, a whole batch at a time", () => {
  expect([0, 3, 6, 7, 10, 11].map((count) => staleCount(count, 3))).toEqual([0, 0, 0, 4, 4, 8]);
  expect([1, 4, 5, 8, 9].map((count) => staleCount(count, 1))).toEqual([0, 0, 4, 4, 8]);
  expect(staleCount(6, 1, 2)).toBe(4);
});

test("listings and screenshots are cut in batches, never one a turn", () => {
  expect(shapes(pruneScreens(screens(4)))).toEqual(["full", "full", "full", "full"]);
  expect(shapes(pruneScreens(screens(5)))).toEqual(["text", "text", "text", "text", "full"]);
  expect(shapes(pruneScreens(screens(6)))).toEqual(["text", "text", "text", "text", "full", "full"]);
  expect(shapes(pruneScreens(screens(7)))).toEqual(["stub", "stub", "stub", "stub", "full", "full", "full"]);
});

test("stale listings become a stub and only the newest screenshot keeps its image", () => {
  const pruned = pruneScreens(screens(9));
  expect(shapes(pruned)).toEqual(["stub", "stub", "stub", "stub", "text", "text", "text", "text", "full"]);
  expect(pruned[0]).toEqual({ ...result("screen", 0), content: [{ type: "text", text: STUB }] });
  expect(pruned[4]).toEqual({ ...result("screen", 4), content: [{ type: "text", text: "screen 4" }] });
  expect(pruned[8]).toEqual(result("screen", 8));
});

test("other messages pass through untouched and the transcript given is not mutated", () => {
  const ask: AgentMessage = { role: "user", content: "what is on screen?", timestamp: 0 };
  const listing = result("bash", 100);
  const messages = [ask, ...screens(5), listing, ...screens(4).map((_, n) => result("screen", 5 + n))];
  const before = structuredClone(messages);
  const pruned = pruneScreens(messages);
  expect(messages).toEqual(before);
  expect(pruned).not.toBe(messages);
  expect(pruned).toHaveLength(messages.length);
  expect(pruned[0]).toBe(ask);
  expect(pruned[6]).toBe(listing);
  expect(pruned.at(-1)).toBe(messages.at(-1)!);
  expect(shapes(pruned)).toEqual(["stub", "stub", "stub", "stub", "text", "text", "text", "text", "full"]);
  expect(shapes(messages)).toEqual(Array(9).fill("full"));
});

test("an action that ends with a listing goes stale like a screen, and keeps what it said it did", () => {
  const opened: ToolResultMessage = {
    ...result("browser", 0),
    content: [
      { type: "text", text: "opened https://arxiv.org in a new tab" },
      { type: "text", text: "frontmost app: Google Chrome\nitems: ..." },
    ],
    details: { listing: true },
  };
  const tabs: ToolResultMessage = { ...result("browser", 1), details: undefined };
  const pruned = pruneScreens([opened, tabs, ...screens(6)]);
  expect(pruned[0]).toEqual({ ...opened, content: [{ type: "text", text: "opened https://arxiv.org in a new tab" }, { type: "text", text: STUB }] });
  expect(pruned[1]).toBe(tabs);
  expect(shapes(pruned)).toEqual(["stub", "stub", "stub", "full", "full", "full"]);
});

// ------------------------------------------------------------------ how a run ends

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const asked = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 0 });
const said = (text: string, stopReason: StopReason = "stop", errorMessage?: string): AssistantMessage => ({
  role: "assistant", content: text ? [{ type: "text", text }] : [], api: "openai-responses", provider: "openai", model: "m", usage, stopReason, errorMessage, timestamp: 0,
}); // prettier-ignore
const finished = (outcome: Outcome, summary: string): ToolResultMessage => ({
  role: "toolResult", toolCallId: "finish-1", toolName: "finish", content: [{ type: "text", text: `recorded: ${outcome}` }], details: { finish: { outcome, summary } }, isError: false, timestamp: 0,
}); // prettier-ignore

test("a run ends as its finish says: done, needs you, or could not, which is a failure with the summary as its reason", () => {
  const run = (outcome: Outcome, answer = "The answer.") => ending([asked("do it"), finished(outcome, "One line."), said(answer)], 0, null);
  expect(run("done")).toEqual({ status: "done", answer: "The answer.", reason: "" });
  expect(run("needs_you")).toEqual({ status: "needs_you", answer: "The answer.", reason: "" });
  expect(run("could_not")).toEqual({ status: "failed", answer: "The answer.", reason: "One line." });
  expect(run("done", "")).toEqual({ status: "done", answer: "One line.", reason: "" }); // no words after the finish: its summary is the answer
});

test("a finish from an earlier task, or one the user has spoken after, does not decide this one", () => {
  const earlier = [asked("first"), finished("could_not", "No."), said("No.")];
  expect(ending([...earlier, asked("second"), said("Done now.")], earlier.length, null).status).toBe("done");
  expect(ending([asked("do it"), finished("done", "Did it."), asked("and also this"), said("Here.")], 0, null).status).toBe("done");
  expect(ending([asked("do it"), finished("needs_you", "Log in."), asked("I logged in"), said("Still stuck.", "error", "socket hang up")], 0, null)).toEqual({
    status: "failed",
    answer: "Still stuck.",
    reason: "socket hang up",
  });
});

test("a stop the orchestrator asked for is a stop, however the model's turn came back", () => {
  const aborted = [asked("do it"), said("", "error", "The operation was aborted")];
  expect(ending(aborted, 0, "stop")).toEqual({ status: "stopped", answer: "", reason: "" });
  expect(ending([asked("do it"), finished("done", "Did it."), said("Did it.")], 0, "stop").status).toBe("stopped");
  expect(ending([asked("do it"), said("Halfway.", "aborted")], 0, "pause")).toEqual({ status: "paused", answer: "Halfway.", reason: "" });
  expect(ending(aborted, 0, null).status).toBe("stopped"); // the user's own stop: the mouse in a corner
});

test("without a finish, the last turn decides: a model error fails with its message, and anything else is done", () => {
  expect(ending([asked("do it"), said("", "error", "429 Too Many Requests")], 0, null)).toEqual({ status: "failed", answer: "", reason: "429 Too Many Requests" });
  expect(ending([asked("do it"), said("It is 144.")], 0, null)).toEqual({ status: "done", answer: "It is 144.", reason: "" });
  expect(ending([asked("do it")], 0, null, "Agent is already processing").reason).toBe("Agent is already processing");
  expect(ending([asked("do it")], 0, null).status).toBe("failed");
});

// ------------------------------------------------------------------ a managed hand

/** Just enough of pi's Agent for a managed hand: a transcript, a steering queue, and turns that answer as the test says. */
class Scripted {
  state = { messages: [] as AgentMessage[] };
  queue: AgentMessage[] = [];
  aborted = 0;
  signal = undefined;
  constructor(private turn: (heard: string) => Promise<AgentMessage[]>) {}
  async prompt(text: string) {
    this.state.messages.push(asked(text));
    this.state.messages.push(...(await this.turn(text)));
  }
  async continue() {
    const steers = this.queue.splice(0);
    this.state.messages.push(...steers);
    this.state.messages.push(...(await this.turn(steers.map((m) => (m.role === "user" ? JSON.stringify(m.content) : "")).join(" "))));
  }
  steer(message: AgentMessage) {
    this.queue.push(message);
  }
  hasQueuedMessages() {
    return this.queue.length > 0;
  }
  clearAllQueues() {
    this.queue = [];
  }
  abort() {
    this.aborted++;
  }
}

/** A managed hand over a scripted agent, and everything it emitted, logged, closed with, and showed. */
function managedHand(turn: (heard: string) => Promise<AgentMessage[]>) {
  const agent = new Scripted(turn);
  const events: { type: string; status?: string; answer?: string; reason?: string }[] = [];
  const log: string[] = [];
  const closed: [boolean, string][] = [];
  const shown: number[] = [];
  const hand = managed(agent as unknown as Agent, {
    emit: (event) => void events.push(event as (typeof events)[number]),
    record: (line) => void log.push(line),
    close: (keep, why) => void closed.push([keep, why]),
    show: (window) => void shown.push(window),
  });
  const statuses = () => events.filter((event) => event.type === "status").map(({ status, answer, reason }) => ({ status, answer, reason }));
  return { agent, hand, statuses, log, closed, shown };
}

test("a managed run ends with the model's finish, and says so with its answer", async () => {
  const { hand, statuses, log } = managedHand(async () => [finished("needs_you", "Sign in to WhatsApp."), said("Please sign in to WhatsApp on your phone.")]);
  await hand.tell({ type: "prompt", text: "message Julia" });
  expect(statuses()).toEqual([
    { status: "working", answer: undefined, reason: undefined },
    { status: "needs_you", answer: "Please sign in to WhatsApp on your phone.", reason: "" },
  ]);
  expect(log).toEqual(["[prompt] message Julia", "[status] needs_you"]);
});

test("a stop before the first prompt means the task never starts", async () => {
  const { agent, hand, statuses, log } = managedHand(async () => [said("should not run")]);
  hand.tell({ type: "stop" });
  expect(hand.tell({ type: "prompt", text: "book a table" })).toBeUndefined();
  expect(agent.state.messages).toEqual([]);
  expect(statuses()).toEqual([{ status: "stopped", answer: "", reason: "" }]);
  expect(log).toEqual(["[prompt] not started, since it was stopped first: book a table"]);
  await hand.tell({ type: "prompt", text: "then this instead" }); // only the one prompt is dropped
  expect(statuses().at(-1)?.status).toBe("done");
});

test("a stop mid-run is a stop, though pi hands the abort back as a failed turn", async () => {
  let release: (() => void) | undefined;
  const { agent, hand, statuses } = managedHand(async () => {
    await new Promise<void>((resolve) => (release = resolve));
    return [said("", "error", "The operation was aborted")];
  });
  const run = hand.tell({ type: "prompt", text: "find flights" })!;
  await Bun.sleep(0);
  hand.tell({ type: "steer", text: "only direct ones" }); // queued, then dropped with the task it was for
  hand.tell({ type: "stop" });
  release!();
  await run;
  expect(agent.aborted).toBe(1);
  expect(agent.queue).toEqual([]);
  expect(statuses().at(-1)).toEqual({ status: "stopped", answer: "", reason: "" });
});

test("a steer that arrives as the run is ending is still taken, and the run ends after it", async () => {
  const { agent, hand, statuses, log } = managedHand(async (heard) => {
    if (heard === "open the report") {
      hand.tell({ type: "steer", text: "and print it" }); // the model is finishing its last turn
      return [finished("done", "Opened it."), said("The report is open.")];
    }
    return [finished("done", "Printed it."), said("It is printing.")];
  });
  await hand.tell({ type: "prompt", text: "open the report" });
  expect(agent.state.messages.filter((m) => m.role === "user")).toHaveLength(2);
  expect(statuses().at(-1)).toEqual({ status: "done", answer: "It is printing.", reason: "" });
  expect(log).toContain("[steer] and print it");
});

test("close gives back what the hand opened, keeping the browser only when asked", () => {
  const { hand, closed } = managedHand(async () => []);
  hand.tell({ type: "close" });
  hand.tell({ type: "close", keep: true });
  expect(closed).toEqual([
    [false, "asked to"],
    [true, "asked to"],
  ]);
});

const finishedKeeping = (keep_open: boolean): ToolResultMessage => ({ ...finished("done", "Left the flights open."), details: { finish: { outcome: "done", summary: "Left the flights open.", keep_open } } });

test("a close that does not say keeps the browser exactly when the hand's last finish said it left pages open, and one that says decides", async () => {
  const { hand, closed } = managedHand(async (heard) => [heard === "find flights" ? finishedKeeping(true) : finishedKeeping(false), said("Done.")]);
  await hand.tell({ type: "prompt", text: "find flights" });
  hand.tell({ type: "close" });
  hand.tell({ type: "close", keep: false }); // the orchestrator's word goes
  await hand.tell({ type: "prompt", text: "and close them" });
  hand.tell({ type: "close" });
  hand.tell({ type: "close", keep: true });
  expect(closed.map(([keep]) => keep)).toEqual([true, false, false, true]);
  expect(keptOpen([asked("do it"), finished("done", "Did it.")])).toBe(false); // a finish that says nothing keeps nothing
  expect(keptOpen([finishedKeeping(true), asked("thanks"), said("You're welcome.")])).toBe(true); // the last finish, whatever came after
});

test("show brings the window forward from the hand, and leaves the run as it was", async () => {
  let release: (() => void) | undefined;
  const { hand, statuses, shown, agent } = managedHand(async () => {
    await new Promise<void>((resolve) => (release = resolve));
    return [finished("done", "Did it."), said("Did it.")];
  });
  const run = hand.tell({ type: "prompt", text: "look it up" })!;
  await Bun.sleep(0);
  expect(hand.tell({ type: "show", window: 4242 })).toBeUndefined();
  expect(shown).toEqual([4242]);
  expect(agent.aborted).toBe(0);
  release!();
  await run;
  expect(statuses().map(({ status }) => status)).toEqual(["working", "done"]);
});

test("a stop for a paused hand ends its task as stopped, which it says; for a finished one, nothing", async () => {
  let release: (() => void) | undefined;
  const { agent, hand, statuses, log } = managedHand(async (heard) => {
    if (heard !== "find flights") return [finished("done", "Did it."), said("Did it.")];
    await new Promise<void>((resolve) => (release = resolve));
    return [said("Halfway.", "aborted")];
  });
  const run = hand.tell({ type: "prompt", text: "find flights" })!;
  await Bun.sleep(0);
  hand.tell({ type: "pause" });
  release!();
  await run;
  expect(statuses().at(-1)?.status).toBe("paused");
  agent.steer(asked("only direct ones")); // a word for the paused task still queued, which the stop drops with it
  hand.tell({ type: "stop" });
  expect(statuses().at(-1)).toEqual({ status: "stopped", answer: "", reason: "" });
  expect(agent.queue).toEqual([]);
  expect(log.at(-1)).toBe("[status] stopped");
  hand.tell({ type: "stop" }); // stopped already: nothing more
  await hand.tell({ type: "prompt", text: "then book the cheapest" });
  const count = statuses().length;
  hand.tell({ type: "stop" }); // done: a stop has nothing to end
  expect(statuses()).toHaveLength(count);
  expect(statuses().at(-1)?.status).toBe("done");
});

test("a stop that comes while a failed turn waits to be tried again ends the run there", async () => {
  let turns = 0;
  const { hand, statuses } = managedHand(async () => {
    turns++;
    return [said("", "error", "503 Service Unavailable")];
  });
  const retrying = spyOn(console, "error").mockImplementation(() => {});
  // The orchestrator's stop, between the tries, where there is no run for it to abort.
  const slept = spyOn(Bun, "sleep").mockImplementation(async () => void hand.tell({ type: "stop" }));
  try {
    await hand.tell({ type: "prompt", text: "find flights" });
  } finally {
    retrying.mockRestore();
    slept.mockRestore();
  }
  expect(turns).toBe(1); // not picked up again
  expect(statuses().at(-1)?.status).toBe("stopped");
});

test("a hand gives the seat back before its windows, and a failure in either stops neither", () => {
  const done: string[] = [];
  const log: string[] = [];
  letGo(false, (line) => void log.push(line), { abandonSeat: () => void done.push("seat"), release: (keep) => void done.push(`release keep=${keep}`) });
  expect(done).toEqual(["seat", "release keep=false"]);
  letGo(true, (line) => void log.push(line), {
    abandonSeat: () => {
      throw new Error("the helper went away");
    },
    release: (keep) => void done.push(`release keep=${keep}`),
  });
  expect(done.at(-1)).toBe("release keep=true");
  expect(log).toEqual(["[error] giving the seat back: Error: the helper went away"]);
  letGo(true, () => {}, { release: () => void done.push("no seat to give") }); // a platform with no seat to give back yet
  expect(done.at(-1)).toBe("no seat to give");
});

test("the hand's shell runs without the secrets in its environment", () => {
  const env = { PATH: "/bin", HOME: "/home/u", OPENAI_API_KEY: "sk-1", TYPESAFE_API_KEY: "t-1", GITHUB_TOKEN: "g", AWS_SECRET_ACCESS_KEY: "a", DB_PASSWORD: "p", MONKEY: "banana", KEYBOARD: "us" };
  expect(Object.keys(scrubbed(env)).sort()).toEqual(["HOME", "KEYBOARD", "MONKEY", "PATH"]);
});

test("every line of the log starts with the time it was written", () => {
  const folder = mkdtempSync(join(tmpdir(), "hands-log-"));
  try {
    const record = logTo(folder);
    record("[prompt] open the calculator");
    record("[result] took=812ms Calculator, the window you are working in\n0 button 'Seven' @40,300");
    const lines = readFileSync(join(folder, "agent.log"), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /);
    expect(lines[2]).toEndWith(" 0 button 'Seven' @40,300");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the prompt is one prompt: no modes, no flags, and every task ends with finish", () => {
  const prompt = systemPrompt("/work");
  for (const gone of ["--background", "in the background", "run it again", "foreground"]) expect(prompt).not.toContain(gone);
  expect(prompt).toContain("End every task by calling `finish`");
  expect(prompt).toContain("finish with keep_open=true");
  expect(prompt).toContain("Never tell the user to restart you");
  expect(prompt).toContain("Never open, read, print, copy or type the contents of .env files");
  expect(prompt).toContain("Never press a second time a button that sends");
});

test("the Mac prompt says what the Mac does: no borrowing of the seat, no right click, and the app's window may be the user's", () => {
  const prompt = systemPrompt("/work"); // under bun test the platform is the Mac
  expect(prompt).not.toContain("seat=true");
  expect(prompt).not.toContain("once the user pauses");
  expect(prompt).not.toContain("a right click");
  expect(prompt).toContain("nothing here borrows their mouse and keyboard");
  expect(prompt).toContain("which is the user's own document when the app was open already");
  expect(prompt).toContain("slid until a strip of it shows");
});

test("the Windows prompt says what Windows does", () => {
  // The platform's words are fixed as agent.ts loads, so it is loaded afresh, in a process that is Windows.
  const agentPath = JSON.stringify(join(import.meta.dir, "..", "src", "agent.ts"));
  const loaded = Bun.spawnSync([process.execPath, "-e", `const { systemPrompt } = await import(${agentPath}); process.stdout.write(systemPrompt("/work"));`], {
    env: { ...process.env, HANDS_PLATFORM: "windows" },
  });
  const prompt = loaded.stdout.toString();
  expect(prompt).toContain("the user's Windows PC");
  expect(prompt).toContain("do it once more with seat=true");
  expect(prompt).toContain("Borrow only when a tool's error suggests it");
  expect(prompt).not.toContain("Borrow for nothing else");
  expect(prompt).toContain("There is no right click");
  expect(prompt).not.toContain("typing into Office, a right click");
  expect(prompt).toContain("The Windows key is never pressed");
  expect(prompt).not.toContain("ctrl, alt, shift or win");
  expect(prompt).toContain("Tab is not pressed in your browser window");
  expect(prompt).toContain("They reach your window wherever it lies");
  expect(prompt).not.toContain("slid until a strip of it shows");
  expect(prompt).toContain("Never press a second time a button that sends");
});
