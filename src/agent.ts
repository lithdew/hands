#!/usr/bin/env bun
/** `hands`: a pi agent that works this computer from behind the user's windows, with pi's coding tools and computer use side by side. */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { isRetryableAssistantError, type ThinkingLevel } from "@earendil-works/pi-ai";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { timestamp } from "./cli.ts";
import * as config from "./config.ts";
import { nowContext } from "./dates.ts";
import { hand, quote, tintOf } from "./hand.ts";
import { onPayload, resolveModel, runtime } from "./llm.ts";
import { onWindows, PERMISSION, platform as macos } from "./platform.ts";
import { computerTools, type Details, type Finish } from "./tools.ts";
import type { Status } from "./ui/state.ts";
import * as windows from "./windows.ts";

// A screen listing is a few thousand tokens and a screenshot far more, and only the latest few say
// anything true about the screen. Older ones are cut in batches rather than one a turn, so the
// request keeps a stable prefix for the provider's cache between cuts.
const KEEP_LISTINGS = 3;
const KEEP_SCREENSHOTS = 1;
const CUT_EVERY = 4;

/** How many of `count` results are stale: everything but the newest `keep`, rounded down to a batch. */
export const staleCount = (count: number, keep: number, batch = CUT_EVERY): number => Math.max(0, Math.floor((count - keep) / batch) * batch);

/** The transcript with stale screen listings reduced to a stub, and stale screenshots dropped. */
export function pruneScreens(messages: AgentMessage[]): AgentMessage[] {
  const isScreen = (m: AgentMessage) => m.role === "toolResult" && (m.toolName === "screen" || (m.details as Details)?.listing === true);
  const total = messages.filter(isScreen).length;
  const [staleListings, staleShots] = [staleCount(total, KEEP_LISTINGS), staleCount(total, KEEP_SCREENSHOTS)];
  let seen = 0;
  return messages.map((m) => {
    if (m.role !== "toolResult" || !isScreen(m)) return m;
    const position = seen++;
    // What an action reported about itself stays; only the listing under it goes.
    const lead = m.toolName === "screen" ? [] : m.content.slice(0, 1);
    if (position < staleListings) return { ...m, content: [...lead, { type: "text", text: "[an earlier screen; call `screen` for the current one]" }] };
    if (position < staleShots) return { ...m, content: m.content.filter((block) => block.type !== "image") };
    return m;
  });
}

// The Mac prompt says what the Mac does; these are the lines where the platforms differ.
const MACHINE = onWindows() ? "Windows PC" : "Mac";
const IN_THE_BROWSER = onWindows()
  ? "In the browser, pressing a link or a button shows the user no more than a flash of your window, and so does `browser` open, except that making the window the first time takes their keyboard for a fraction of a second before it is handed back. So move through a site"
  : "In the browser, pressing a link or a button is invisible to the user. `browser` open is too when the user has allowed JavaScript from Apple Events in their browser; when they have not, it takes the keyboard from whatever they are doing for about a fifth of a second before it is handed back. You cannot tell which, so move through a site";
const PRESSING = onWindows()
  ? "- `click` presses an item with a role (button, link, field, popup, tab, cell...) through accessibility. In a native app that is the sure way; on a web page, or in an app drawn like one (Claude, WhatsApp, Teams), it is a click at the item's centre, so check the next capture. When the thing you want shows up only as text, look for the control that carries it, often listed right beside it or in the off-screen list."
  : "- `click` presses an item with a role (button, link, field, popup, tab, cell...) through accessibility, which is the sure way: prefer it, and when the thing you want shows up only as text, look for the control that carries it, often listed right beside it or in the off-screen list.";
const MENUS = onWindows()
  ? "- Menus exist only in classic apps (Notepad, Paint, Explorer), where `menu` chooses a command by its path and the menu shows on screen for a moment. Office has a ribbon instead: its tabs (File, Home, Insert...) and its buttons are items in the listing, pressed with `click`, and File opens a page whose commands (New, Open, Save As) are items too. An app drawn like a web page has neither."
  : "- `menu` chooses a command from the app's menu bar by its path, without the menu ever opening. It is the way to make a new document or note, save, select all, change a view. Give a partial path to see what a menu holds before guessing a name.";
const KEYS = onWindows()
  ? "- `key` and `type` without an item go to your window, to wherever its own cursor is, the browser included, so make sure its cursor is where you mean (press the field, or make the new document) first. `type` with an item sets a field's value outright. A shortcut with ctrl, alt, shift or win cannot be sent to a window from behind, so `key` presses it with the user's keyboard for a moment: when a button or a ribbon item does the same, press that instead. A line break typed into a page would send what is written so far: write a message on one line. Do not walk a page from control to control with Tab: past the last one it reaches the browser's own toolbar, where the next Enter presses the browser's buttons (it once bookmarked a page in the user's profile). Click the field you want instead."
  : "- In an app, `key` and `type` without an item send keys to that app's process, to wherever its own cursor is, so make sure its cursor is where you mean (press the field, or make the new document) first. `type` with an item sets a field's value outright. The browser takes neither: its keys would land in whichever of its windows the user is in, so submit a web form with `type` submit=true or by pressing its button.";
const OPENING = onWindows()
  ? "`open_app` starts an app in a window of your own without bringing it forward, or opens a document in its app (file=...)"
  : "`open_app` starts an app without bringing it forward, and you work in its current window";
const OPEN_DOCUMENT = onWindows() ? "open it there with `open_app` file=..." : "open it there from the app's File menu";
const BORROWS = onWindows() ? "a shortcut, a drag in an app that is not a web page, typing into Office, a right click" : "a right click";
const SHELL = onWindows()
  ? "\n- The shell is Git Bash: use forward slashes in paths, and quote a path with spaces. There is no python or node. For a Windows task (a process, a file association, a setting to read), run `powershell.exe -NoProfile -Command \"...\"`."
  : "";

/** The one prompt: a hand works in windows of its own, behind the user's, and borrows their mouse and keyboard only for a moment. */
export function systemPrompt(cwd: string): string {
  const now = nowContext();
  const browser = config.browser();
  return `You are Hands, an agent working on the user's ${MACHINE} for them while they keep using it. You operate its apps and websites in windows of your own, behind the user's windows, and you also have a shell and file tools in ${cwd}.

Now: ${now.local_time} (${now.timezone}). Home: ${homedir()}. Browser: ${browser}.

# Your windows and the user's
- ${OPENING}. \`browser\` open gives you a ${browser} window of your own in the user's profile, behind their windows. Whichever you used last is the window you are working in, and \`screen\` reads it where it lies, or the dialog it has open.
- Work in your own windows. Act in a window or tab of the user's only when the task asks for exactly that ("close my Chrome windows", "reply in the chat I have open"), and only as far as it asks. When an app gives you only the user's own window, the listing says so: say so too, and do no more in it than the task needs.
- With nothing of yours open, \`screen\` shows the user's own screen, only to read: that is how to answer a question about what is on it.
- Keep pages the user should see open as tabs of your own window (\`browser\` open with new_tab=true), and say so at the end.
- Put files meant for the user in ${cwd}. When they ask for a document in an app (a spreadsheet in Excel, a letter in Word), make it in that app, or write the file and ${OPEN_DOCUMENT}: do not build it by script instead.

# Working the window
- When the user asks you to use an app or a site, operate it as they would and read results off it: do not substitute a shell command, an API, or your own knowledge or arithmetic for it. The shell and file tools are for local work around the task: writing and converting files, building a PDF, checking what exists.
${PRESSING} Anything else, a canvas, a toolbox with no labels, a bare x,y, gets a pointer of your own: \`click\` with x,y and \`drag\` send pointer events addressed to your window alone, so the user's cursor never moves. A browser only hands those to a page it thinks can be seen, so the first time you use them your browser window is slid until a strip of it shows at a screen edge. Use the screenshot to aim, and again to check what you drew.
${MENUS}
${KEYS}
- ${IN_THE_BROWSER} by pressing its links and controls, and keep \`browser\` open for getting to a site in the first place, or for a URL that saves many steps (search results, filters and dates usually live in the query string).
- A few things cannot be done from behind the user's windows (${BORROWS}). For those the tools borrow the user's real mouse and keyboard for a moment, once the user pauses, and give them back; the user sees it happen. When something you did from behind had no effect (a click that changed nothing, a drag the app ignored), do it once more with seat=true. Borrow for nothing else.
- The clipboard is the user's too: do not copy or paste through it. Put text in with \`type\`, and move files with the shell.
- Indexes only describe the capture they came from, so look again after anything that changes the window, and before you report what it shows. Ask for the screenshot when text is not enough.
- You may issue several tool calls in one turn when you already know the sequence; they run in order.${SHELL}

# Finishing
- Keep going until the task is actually done. A step that fails or a page that surprises you is a reason to look again (with the screenshot) and take another route.
- End every task by calling \`finish\`, then give a short plain answer: what you found or did, and where any file you made lives. done means you saw it done. When a step cannot be done, finish with needs_you and exactly what the user must do (a login, a payment, a CAPTCHA, a choice that is theirs), or with could_not and why: never with done for something that did not happen.
- Never say a message was sent, a booking made or a file saved unless you saw it: the message in the chat, the confirmation on the page, the file where it belongs.
- Never tell the user to restart you, to run you another way, or to change how you work: there is no other way. Say what stood in the way in plain words.

# Boundaries
- Never type, guess, or reveal passwords or payment details. If a login is required, finish with needs_you and say so.
- Do not send messages, make purchases, place bookings, or delete the user's data unless they asked for exactly that. Looking up availability is not booking.
- Do not change the user's settings or preferences, in an app or the system, to make a task easier. If a feature gets in the way (autocorrect, smart substitutions, a results popup), work around it, or finish and say what it did.`;
}

const MAX_RETRIES = 4;

/**
 * One prompt, seen through. A dropped socket or an overloaded provider ends a run as a failed assistant
 * turn; that turn is taken back off the transcript and the run picked up where it was, as pi itself does.
 */
export async function ask(agent: Agent, prompt: string): Promise<void> {
  await agent.prompt(prompt);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const last = agent.state.messages.at(-1);
    if (last?.role !== "assistant" || !isRetryableAssistantError(last) || agent.signal?.aborted) return;
    const delay = 1000 * 2 ** (attempt - 1);
    console.error(`retrying in ${delay / 1000}s (${attempt}/${MAX_RETRIES}): ${last.errorMessage}`);
    agent.state.messages = agent.state.messages.slice(0, -1);
    await Bun.sleep(delay);
    await agent.continue();
  }
}

/** How a run ended, as the orchestrator hears it. */
export type Ended = { status: Exclude<Status, "starting" | "working">; answer: string; reason: string };

/** The model's own verdict on a run: its last `finish`, unless the user has said something since, which reopens the task. */
function verdict(run: AgentMessage[]): Finish | null {
  for (const m of [...run].reverse()) {
    if (m.role === "user") return null;
    if (m.role === "toolResult" && m.toolName === "finish" && !m.isError) return (m.details as Details)?.finish ?? null;
  }
  return null;
}

/**
 * How the run that began at message `from` ended. A pause or a stop the orchestrator asked for is that, whatever
 * the model did next: pi reports its abort as a failed turn. Then the model's `finish`: done, needs you, or could
 * not (a failure, with its summary as the reason). Without one, how its last turn stopped: an abort is a stop, an
 * error a failure. `failure` is a run that threw rather than ending.
 */
export function ending(messages: AgentMessage[], from: number, asked: "pause" | "stop" | null, failure: string | null = null): Ended {
  const last = messages.at(-1);
  const said = last?.role === "assistant" ? last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim() : "";
  if (asked === "stop") return { status: "stopped", answer: said, reason: "" };
  if (asked === "pause") return { status: "paused", answer: said, reason: "" };
  const finish = verdict(messages.slice(from));
  if (finish) {
    const answer = said || finish.summary;
    if (finish.outcome === "could_not") return { status: "failed", answer, reason: finish.summary };
    return { status: finish.outcome === "needs_you" ? "needs_you" : "done", answer, reason: "" };
  }
  if (failure !== null) return { status: "failed", answer: said, reason: failure };
  if (last?.role !== "assistant") return { status: "failed", answer: "", reason: "the run ended before the model answered" };
  if (last.stopReason === "aborted" || (last.stopReason === "error" && /\babort/i.test(last.errorMessage ?? ""))) return { status: "stopped", answer: said, reason: "" };
  if (last.stopReason === "error") return { status: "failed", answer: said, reason: last.errorMessage || "the model failed" };
  return { status: "done", answer: said, reason: "" };
}

/** The pose a hand ends a run in. */
const POSE_AT_END = { done: "done", needs_you: "wait", paused: "wait", failed: "stop", stopped: "stop" } as const;

const brief = (value: unknown, limit = 200): string => {
  const flat = (typeof value === "string" ? value : JSON.stringify(value)).replace(/\s+/g, " ");
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

export async function createAgent(options: { cwd: string; runDir: string; model?: string; thinking?: string }) {
  mkdirSync(options.cwd, { recursive: true });
  mkdirSync(options.runDir, { recursive: true });
  const models = await runtime();
  const agent: Agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt(options.cwd),
      model: await resolveModel(options.model ?? config.agentModel()),
      thinkingLevel: (options.thinking ?? config.thinking()) as ThinkingLevel,
      tools: [...createCodingTools(options.cwd), ...computerTools({ runDir: options.runDir, cwd: options.cwd, onAbort: () => agent.abort() })],
    },
    streamFn: models.streamSimple.bind(models),
    onPayload,
    transformContext: async (messages) => pruneScreens(messages),
    sessionId: crypto.randomUUID(),
  });
  return agent;
}

/** The run folder's log. Every line of a record starts with the time it was written, so any line of a listing can be placed. */
export function logTo(runDir: string): (record: string) => void {
  const file = join(runDir, "agent.log");
  return (record) => {
    const now = new Date().toISOString();
    appendFileSync(file, `${record.split("\n").map((line) => `${now} ${line}`).join("\n")}\n`);
  };
}

/**
 * Stream the agent's words and one line per tool call to the terminal, and everything in full to the log: what it
 * said, what each turn cost and took, each tool call and its result, and how long the tool took.
 */
function report(agent: Agent, record: (line: string) => void, terminal = true): void {
  const console = terminal ? globalThis.console : { log() {}, error() {} };
  const started = new Map<string, number>(); // when each tool call began, by its id
  let streaming = false;
  agent.subscribe((event) => {
    if (terminal && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
      streaming = true;
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      if (streaming) process.stdout.write("\n");
      streaming = false;
      const { content, stopReason, errorMessage, usage, timestamp: began } = event.message;
      for (const block of content) if (block.type === "text") record(`[assistant] ${block.text}`);
      if (stopReason === "error") console.error(`model error: ${errorMessage}`);
      if (stopReason === "error" || stopReason === "aborted") record(`[${stopReason}] ${errorMessage ?? ""}`);
      record(`[usage] in=${usage.input} out=${usage.output} cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite} turn_ms=${Date.now() - began}`);
    } else if (event.type === "tool_execution_start") {
      started.set(event.toolCallId, performance.now());
      console.log(`→ ${event.toolName} ${brief(event.args)}`);
      record(`[tool] ${event.toolName} ${JSON.stringify(event.args)}`);
    } else if (event.type === "tool_execution_end") {
      const took = Math.round(performance.now() - (started.get(event.toolCallId) ?? performance.now()));
      started.delete(event.toolCallId);
      const blocks: { type: string; text?: string }[] = event.result?.content ?? [];
      const text = blocks.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
      console.log(`  ${event.isError ? "✗" : "←"} ${brief(text)}`);
      record(`[${event.isError ? "error" : "result"}] took=${took}ms ${text}`);
    }
  });
}

/**
 * The run as the hand shows it. The computer tools pose for themselves, since only they know where on the
 * screen they act; this covers pi's own tools, and the thinking in between.
 */
function personify(agent: Agent): void {
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      const about = Object.values(event.args ?? {}).find((value) => typeof value === "string");
      void hand.cue(event.toolName === "write" || event.toolName === "edit" ? "write" : "think", `${event.toolName} ${about ? quote(about) : ""}`.trim());
    } else if (event.type === "tool_execution_end") hand.rest();
  });
}

/** What a managed hand is told, a JSON line at a time. A `prompt` to a hand at work is a `steer`. */
export type Command =
  | { type: "prompt" | "steer"; text: string }
  | { type: "pause" | "resume" | "stop" }
  | { type: "close"; keep?: boolean } // close: close the browser windows the hand opened (unless kept: `keep`, or else what its finish said), leave its other windows, then exit
  | { type: "show"; window: number }; // bring this window of the hand's to the user, from the process that knows where it is kept

/** Where a managed hand's words go: its event stream, its log, and its way out. */
export interface Managed {
  emit: (event: object) => void;
  record: (line: string) => void;
  /** Give back what the hand opened, and end the process. */
  close: (keep: boolean, why: string) => void;
}

/**
 * What a managed hand does with each command its orchestrator sends. A prompt starts a run, which ends in a status;
 * a prompt while one is under way is a steer. Returns the run a command started, for whoever wants to wait on it.
 */
export function managed(agent: Agent, { emit, record, close }: Managed) {
  let working = false;
  let started = false; // a task has been taken on
  let cancelled = false; // stopped before it began: the prompt that follows is not started
  let asked: "pause" | "stop" | null = null; // what the orchestrator asked of the run under way

  const run = async (text: string) => {
    working = started = true;
    asked = null;
    macos.interrupt(false);
    record(`[prompt] ${text}`);
    emit({ type: "status", status: "working" });
    const from = agent.state.messages.length;
    let failure: string | null = null;
    try {
      await ask(agent, text);
      // A steer that came in as the run was ending is still queued, and pi only takes one while a run goes on.
      while (asked === null && agent.hasQueuedMessages()) await agent.continue();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    working = false;
    if (asked === "stop") agent.clearAllQueues(); // a steer for a task that was stopped is not for the next one
    const ended = ending(agent.state.messages, from, asked, failure);
    record(`[status] ${ended.status}${ended.reason ? `: ${ended.reason}` : ""}`);
    emit({ type: "status", ...ended });
    await hand.cue(POSE_AT_END[ended.status], ended.status.replace("_", " "));
  };
  const halt = (pause: boolean) => {
    if (!working) {
      if (!started && !pause) cancelled = true; // the orchestrator changed its mind before the task reached the hand
      return;
    }
    asked = pause ? "pause" : "stop";
    macos.interrupt();
    agent.abort();
  };
  const tell = (command: Command): Promise<void> | undefined => {
    if (command.type === "close") return void close(command.keep ?? false, "asked to");
    if (command.type === "pause" || command.type === "stop") return void halt(command.type === "pause");
    if (command.type === "resume") return working ? undefined : run("Carry on from where you were interrupted.");
    if (command.type !== "prompt" && command.type !== "steer") return;
    if (working) {
      record(`[steer] ${command.text}`);
      return void agent.steer({ role: "user", content: [{ type: "text", text: command.text }], timestamp: Date.now() });
    }
    if (!cancelled) return run(command.text);
    cancelled = false;
    record(`[prompt] not started, since it was stopped first: ${command.text}`);
    emit({ type: "status", status: "stopped", answer: "", reason: "" });
  };
  return { tell, halt };
}

/**
 * `--json`: the hand as a process that someone else runs, the orchestrator for one. Commands come in on stdin and
 * everything the hand does goes out on stdout, a JSON line each: what it is told and says, each tool call and
 * its result, every cue its on-screen hand is sent (so its picture can be drawn elsewhere), a click on that hand,
 * and its status, which ends a run as `done`, `needs_you`, `failed` (with a reason), `stopped`, or `paused`, with
 * the answer so far. A stop that comes before the first prompt means the task never starts. `close` ends the hand;
 * so does stdin closing, which keeps every window it opened.
 */
async function manage(agent: Agent, record: (line: string) => void): Promise<void> {
  const emit = (event: object) => process.stdout.write(`${JSON.stringify(event)}\n`);
  let lastPlace = 0;
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") emit({ type: "tool", name: event.toolName, args: brief(event.args, 300) });
    else if (event.type === "tool_execution_end") {
      const blocks: { type: string; text?: string }[] = event.result?.content ?? [];
      emit({ type: "result", error: event.isError, text: brief(blocks.map((block) => block.text ?? `[${block.type}]`).join(" "), 300) });
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      for (const block of event.message.content) if (block.type === "text" && block.text.trim()) emit({ type: "say", text: block.text });
    }
  });
  // A drag streams its position a hundred times a second: the picture elsewhere needs ten.
  hand.onCue = (cue) => {
    const placeOnly = cue.at && !cue.pose && !cue.subject;
    if (placeOnly && performance.now() - lastPlace < 100) return;
    if (placeOnly) lastPlace = performance.now();
    emit({ type: "cue", ...cue });
  };

  /**
   * On Windows its browser windows are closed unless kept, the rest left where the user can find them, and its desktop
   * taken down. An orchestrator that went away without a word keeps everything.
   */
  const close = (keep: boolean, why: string): never => {
    record(`[close] ${why}${keep ? ", keeping the browser" : ""}`);
    macos.interrupt();
    agent.abort();
    if (onWindows()) {
      try {
        windows.release(keep);
      } catch (error) {
        record(`[error] releasing the hand's windows: ${error}`);
      }
    }
    process.exit(0);
  };
  const { tell, halt } = managed(agent, { emit, record, close });
  hand.onClick = () => (emit({ type: "clicked" }), halt(true)); // a click on the hand stops it where it is
  // The orchestrator decides when a hand ends: a Ctrl+C in the console it runs in is for it, and it closes its hands
  // itself. A console that closes, or a Ctrl+Break, ends the hand as its orchestrator going away does.
  process.on("SIGINT", () => {});
  process.on("SIGHUP", () => close(true, "the console closed"));
  if (process.platform === "win32") process.on("SIGBREAK", () => close(true, "ctrl+break"));

  emit({ type: "ready" });
  for await (const line of console) if (line.trim()) void tell(JSON.parse(line) as Command);
  close(true, "its orchestrator went away");
}

const USAGE = `usage: hands [prompt] [--name NAME] [--color HEX] [--no-hand] [--cwd DIR] [--out DIR] [--model provider/model] [--thinking LEVEL]

An agent that works this ${MACHINE} for you while you keep using it: ${config.DEFAULT_MODEL} at ${config.DEFAULT_THINKING} effort, with read,
bash, edit, write and computer use. It works in windows of its own, behind yours, and borrows your mouse and keyboard only
for a moment, once you pause, for the little that cannot be done from behind.
With no prompt it reads one per line until EOF. Abort: Ctrl-C, or slam the mouse into a screen's top-left corner.

  --name NAME    what the hand on screen is called (default ${config.handName()}). The hand rides on the window being
                 worked in and shows each action as it happens; --no-hand runs without it.
  --color HEX    the hand's colour, as 4f8cff or '#4f8cff' (default: the emoji's own yellow).`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: "string", default: "workspace" },
      out: { type: "string", default: join("runs", timestamp()) },
      model: { type: "string" },
      thinking: { type: "string" },
      background: { type: "boolean", default: false }, // the one mode is always this now: taken, and ignored, for whoever still passes it
      name: { type: "string", default: config.handName() },
      color: { type: "string", default: config.handColor() },
      "no-hand": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return void console.log(USAGE);
  if (values.json) console.log = console.error; // stdout is the event stream: nothing else may write a line to it
  const tint = values.color === undefined ? undefined : tintOf(values.color);
  if (tint === null) {
    console.error(`--color wants a hex colour such as 4f8cff, not ${JSON.stringify(values.color)}`);
    process.exit(2);
  }
  if (onWindows()) process.env.HANDS_NAME = values.name; // the hand's own virtual desktop, when there is one, is named after it (src/windows.ts)
  if (!macos.accessibilityTrusted()) {
    console.error(PERMISSION);
    process.exit(1);
  }
  const runDir = resolve(values.out);
  const agent = await createAgent({ cwd: resolve(values.cwd), runDir, model: values.model, thinking: values.thinking });
  const record = logTo(runDir);
  report(agent, record, !values.json);
  if (!values["no-hand"]) {
    hand.start(values.name, tint);
    personify(agent);
  }
  if (values.json) return manage(agent, record);
  console.log(`run folder: ${runDir}\nabort: Ctrl-C, or slam the mouse into a screen's top-left corner.`);

  let interrupts = 0;
  let stopping = false;
  process.on("SIGINT", () => {
    if (++interrupts > 1) process.exit(130);
    stopping = true;
    macos.interrupt();
    agent.abort();
  });
  const run = async (prompt: string) => {
    interrupts = 0;
    stopping = false;
    macos.interrupt(false);
    record(`[prompt] ${prompt}`);
    void hand.cue("wave", quote(prompt));
    const from = agent.state.messages.length;
    await ask(agent, prompt);
    const ended = ending(agent.state.messages, from, stopping ? "stop" : null);
    record(`[status] ${ended.status}${ended.reason ? `: ${ended.reason}` : ""}`);
    if (ended.status !== "done") console.log(`(${ended.status.replace("_", " ")}${ended.reason ? `: ${ended.reason}` : ""})`);
    await hand.cue(POSE_AT_END[ended.status], ended.status.replace("_", " "));
  };

  if (positionals.length) return run(positionals.join(" "));
  process.stdout.write("> ");
  for await (const line of console) {
    if (line.trim()) await run(line);
    process.stdout.write("> ");
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
  process.exit(0); // the model runtime keeps a socket open
}
