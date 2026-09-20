#!/usr/bin/env bun
/** `hands`: a pi agent that drives this Mac, with pi's coding tools and the clicker's computer use side by side. */

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
import { computerTools, type Details } from "./tools.ts";
import { makeWriter } from "./writer.ts";

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

/** The Mac prompt is unchanged by the port; these are the two lines where the platforms differ. */
const MACHINE = onWindows() ? "Windows PC" : "Mac";
const OPEN_VISIBILITY = onWindows()
  ? "`browser` open in your own window is invisible to the user too, except that making the window the first time takes their keyboard for a fraction of a second before it is handed back. So move through a site"
  : "`browser` open is too when the user has allowed JavaScript from Apple Events in their browser; when they have not, it takes the keyboard from whatever they are doing for about a fifth of a second before it is handed back. You cannot tell which, so move through a site";

/** What changes when the user keeps the seat: the agent works apps and a browser window of its own, from behind theirs. */
const backgroundPrompt = (browser: string) => `# Working in the background
The user is using this ${MACHINE} right now and has asked you not to take their mouse, keyboard, or focus. So everything you do names its target, and nothing goes through the seat:
- \`open_app\` starts an app, or takes up a running one, without bringing it forward, and \`browser\` open gives you a ${browser} window of your own in their profile, behind their windows. Whichever you used last is the window you are working in. \`screen\` reads that window where it lies.
- \`click\` presses an item with a role (button, link, field, popup, tab, cell...) through accessibility, which is the sure way: prefer it, and when the thing you want shows up only as text, look for the control that carries it, often listed right beside it or in the off-screen list. Anything else, a canvas, a toolbox with no labels, a bare x,y, gets a pointer of your own: \`click\` with x,y and \`drag\` send pointer events addressed to your window alone, so the user's cursor never moves. A browser only hands those to a page it thinks can be seen, so the first time you use them your browser window is slid until a strip of it shows at a screen edge. Use the screenshot to aim, and again to check what you drew.
- \`menu\` chooses a command from the app's menu bar by its path, without the menu ever opening. It is the way to make a new document or note, save, select all, change a view. Give a partial path to see what a menu holds before guessing a name.
- In an app, \`key\` and \`type\` without an item send keys to that app's process, to wherever its own cursor is, so make sure its cursor is where you mean (press the field, or make the new document) first. \`type\` with an item sets a field's value outright. The browser takes neither: its keys would land in whichever of its windows the user is in, so submit a web form with \`type\` submit=true or by pressing its button.
- In the browser, pressing a link or a button is invisible to the user. ${OPEN_VISIBILITY} by pressing its links and controls, and keep \`browser\` open for getting to a site in the first place, or for a URL that saves many steps (search results, filters and dates usually live in the query string). Keep pages the user should see open as tabs (\`browser\` open with new_tab=true), and say so at the end.
- The clipboard is the user's too: do not copy or paste through it. Put text in with \`type\`, and move files with the shell.
- If something truly cannot be done from here, do what you can and tell the user to run it again without --background.
`;

export function systemPrompt(cwd: string, background = false): string {
  const now = nowContext();
  const browser = config.browser();
  if (background) {
    return `You are Hands, an agent working on the user's ${MACHINE} for them, in the background. You operate its apps and websites from behind the user's windows, and you also have a shell and file tools in ${cwd}.

Now: ${now.local_time} (${now.timezone}). Home: ${homedir()}. Browser: ${browser}.

${backgroundPrompt(browser)}
# Working the window
- When the user asks you to use an app or a site, operate it as they would and read results off it: do not substitute a shell command, an API, or your own knowledge or arithmetic for it. The shell and file tools are for local work around the task: writing and converting files, building a PDF, checking what exists.
- Indexes only describe the capture they came from, so look again after anything that changes the window, and before you report what it shows. Ask for the screenshot when text is not enough.
- You may issue several tool calls in one turn when you already know the sequence; they run in order.
- Keep going until the task is actually done. A step that fails or a page that surprises you is a reason to look again (with the screenshot) and take another route. Stop early only for what the user alone can resolve, such as a login, a payment, or a CAPTCHA, and then say exactly what the page shows.

# Boundaries
- Never type, guess, or reveal passwords or payment details. If a login is required, stop and say so.
- Do not send messages, make purchases, place bookings, or delete the user's data unless they asked for exactly that. Looking up availability is not booking.
- Do not change the user's settings or preferences, in an app or the system, to make a task easier. If a feature gets in the way (autocorrect, smart substitutions, a results popup), work around it, or finish and say what it did.
- Never touch the user's own windows and tabs.

Finish with a short plain answer: what you found or did, and where any file you made lives.`;
  }
  return `You are Hands, an agent operating the user's ${MACHINE} for them. You see the screen and use the mouse and keyboard through tools, and you also have a shell and file tools in ${cwd}.

Now: ${now.local_time} (${now.timezone}). Home: ${homedir()}. Browser: ${browser}.

# Working the screen
- Do what the user asks on their actual desktop apps and websites, through the computer-use tools. When they ask you to use an app or a site, operate it as they would: do not substitute a shell command, an API, or your own knowledge for it. The shell and file tools are for local work around the task: writing and converting files, building a PDF, checking what exists.
- \`screen\` is how you see, and \`open_app\` and \`browser\` end with the same listing. Its indexes and coordinates only describe the capture they came from, so look again after anything that changes the screen, and before you report what it shows. Read results off the screen; never answer from memory or arithmetic what the user asked you to look up or compute with an app.
- Prefer clicking an item by index over a raw x,y. Ask for the screenshot when text is not enough: canvases, images, layout, or checking visual work.
- You may issue several tool calls in one turn when you already know the sequence (a run of clicks, then \`screen\`); they run in order.
- Websites open only through the \`browser\` tool, in the user's running ${browser} and existing profile: reuse or open tabs and windows there. Never launch another browser, a second ${browser} instance, a different profile, or a headless one.
- \`clicker\` is a fast, cheap delegate for simple click-through sub-goals. Give it one concrete goal, then check the screen yourself.
- Keep going until the task is actually done. A step that fails or a page that surprises you is a reason to look again (with the screenshot) and take another route: mouse=true, a keyboard shortcut, a menu, a different page or search. Do not hand the task back half done. Stop early only for what the user alone can resolve, such as a login, a payment, or a CAPTCHA, and then say exactly what is on screen.
- The user may be using this ${MACHINE} at the same time. If another app has come to the front, bring yours back (\`open_app\`, or \`browser\` switch_tab) and carry on.

# Boundaries
- Never type, guess, or reveal passwords or payment details. If a login is required, stop and say so.
- Do not send messages, make purchases, place bookings, or delete the user's data unless they asked for exactly that. Looking up availability is not booking.
- Do not change the user's settings or preferences, in an app or the system, to make a task easier. If a feature gets in the way (autocorrect, smart substitutions, a results popup), work around it, or finish and say what it did.
- Leave the user's other windows and tabs as you found them, apart from what the task needs.

Finish with a short plain answer: what you found or did, and where any file you made lives.`;
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

const brief = (value: unknown, limit = 200): string => {
  const flat = (typeof value === "string" ? value : JSON.stringify(value)).replace(/\s+/g, " ");
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

export async function createAgent(options: { cwd: string; runDir: string; model?: string; thinking?: string; background?: boolean }) {
  mkdirSync(options.cwd, { recursive: true });
  mkdirSync(options.runDir, { recursive: true });
  const models = await runtime();
  const agent: Agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt(options.cwd, options.background),
      model: await resolveModel(options.model ?? config.agentModel()),
      thinkingLevel: (options.thinking ?? config.thinking()) as ThinkingLevel,
      tools: [
        ...createCodingTools(options.cwd),
        ...computerTools({ runDir: options.runDir, writer: await makeWriter(), background: options.background, onAbort: () => agent.abort() }),
      ],
    },
    streamFn: models.streamSimple.bind(models),
    onPayload,
    transformContext: async (messages) => pruneScreens(messages),
    sessionId: crypto.randomUUID(),
  });
  return agent;
}

/** Stream the agent's words and one line per tool call to the terminal, and everything in full to the run folder. */
function report(agent: Agent, runDir: string, terminal = true): void {
  const file = join(runDir, "agent.log");
  const record = (line: string) => appendFileSync(file, `${line}\n`);
  const console = terminal ? globalThis.console : { log() {}, error() {} };
  let streaming = false;
  agent.subscribe((event) => {
    if (terminal && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
      streaming = true;
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      if (streaming) process.stdout.write("\n");
      streaming = false;
      const { content, stopReason, errorMessage } = event.message;
      for (const block of content) if (block.type === "text") record(`[assistant] ${block.text}`);
      if (stopReason === "error") console.error(`model error: ${errorMessage}`);
      if (stopReason === "error" || stopReason === "aborted") record(`[${stopReason}] ${errorMessage ?? ""}`);
    } else if (event.type === "tool_execution_start") {
      console.log(`→ ${event.toolName} ${brief(event.args)}`);
      record(`[tool] ${event.toolName} ${JSON.stringify(event.args)}`);
    } else if (event.type === "tool_execution_end") {
      const blocks: { type: string; text?: string }[] = event.result?.content ?? [];
      const text = blocks.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
      console.log(`  ${event.isError ? "✗" : "←"} ${brief(text)}`);
      record(`[${event.isError ? "error" : "result"}] ${text}`);
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
export type Command = { type: "prompt" | "steer"; text: string } | { type: "pause" | "resume" | "stop" };

/**
 * `--json`: the hand as a process that someone else runs, the orchestrator for one. Commands come in on stdin and
 * everything the hand does goes out on stdout, a JSON line each: what it is told and says, each tool call and
 * its result, every cue its on-screen hand is sent (so its picture can be drawn elsewhere), a click on that hand,
 * and its status, which ends a run as `done`, `failed`, `stopped`, or `paused` with the answer so far.
 */
async function manage(agent: Agent): Promise<void> {
  const emit = (event: object) => process.stdout.write(`${JSON.stringify(event)}\n`);
  let working = false;
  let pausing = false;
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

  const run = async (text: string) => {
    working = true;
    pausing = false;
    macos.interrupt(false);
    emit({ type: "status", status: "working" });
    await ask(agent, text).catch((error) => emit({ type: "say", text: `failed: ${error}` }));
    working = false;
    const ended = agent.state.messages.at(-1);
    const reason = ended?.role === "assistant" ? ended.stopReason : "error";
    const answer = ended?.role === "assistant" ? ended.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n") : "";
    const status = pausing ? "paused" : reason === "aborted" ? "stopped" : reason === "error" ? "failed" : "done";
    emit({ type: "status", status, answer });
    await hand.cue(status === "done" ? "done" : status === "paused" ? "wait" : "stop", status);
  };
  const halt = (pause: boolean) => {
    if (!working) return;
    pausing = pause;
    macos.interrupt();
    agent.abort();
  };
  hand.onClick = () => (emit({ type: "clicked" }), halt(true)); // a click on the hand stops it where it is

  emit({ type: "ready" });
  for await (const line of console) {
    if (!line.trim()) continue;
    const command = JSON.parse(line) as Command;
    if (command.type === "pause" || command.type === "stop") halt(command.type === "pause");
    else if (command.type === "resume") void (working || run("Carry on from where you were interrupted."));
    else if (command.type !== "prompt" && command.type !== "steer") continue;
    else if (working) agent.steer({ role: "user", content: [{ type: "text", text: command.text }], timestamp: Date.now() });
    else void run(command.text);
  }
}

const USAGE = `usage: hands [prompt] [--background] [--name NAME] [--color HEX] [--no-hand] [--cwd DIR] [--out DIR] [--model provider/model] [--thinking LEVEL]

An agent that drives this ${MACHINE}: ${config.DEFAULT_MODEL} at ${config.DEFAULT_THINKING} effort, with read, bash, edit, write and computer use.
With no prompt it reads one per line until EOF. Abort: Ctrl-C, or slam the mouse into a screen's top-left corner.

  --background   keep working while it works: apps are started without coming forward, the browser gets a window
                 of its own behind yours, and clicks, drags and keys are addressed to its windows rather than
                 sent through your mouse and keyboard.
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
      background: { type: "boolean", default: false },
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
  if (!process.env.TYPESAFE_API_KEY) console.log("TYPESAFE_API_KEY is not set: the clicker tool will fail until it is (put it in .env)");
  if (onWindows()) process.env.HANDS_NAME = values.name; // the hand's own virtual desktop is named after it (src/windows.ts)
  if (!macos.accessibilityTrusted()) {
    console.error(PERMISSION);
    process.exit(1);
  }
  const runDir = resolve(values.out);
  const agent = await createAgent({ cwd: resolve(values.cwd), runDir, model: values.model, thinking: values.thinking, background: values.background });
  report(agent, runDir, !values.json);
  if (!values["no-hand"]) {
    hand.start(values.name, tint);
    personify(agent);
  }
  if (values.json) return manage(agent);
  console.log(`run folder: ${runDir}\nabort: Ctrl-C, or slam the mouse into a screen's top-left corner.`);
  if (values.background) console.log("background: working behind your windows. Your mouse, keyboard and focus stay yours.");

  let interrupts = 0;
  process.on("SIGINT", () => {
    if (++interrupts > 1) process.exit(130);
    macos.interrupt();
    agent.abort();
  });
  const run = async (prompt: string) => {
    interrupts = 0;
    macos.interrupt(false);
    void hand.cue("wave", quote(prompt));
    await ask(agent, prompt);
    const ended = agent.state.messages.at(-1);
    const stopped = ended?.role === "assistant" && (ended.stopReason === "aborted" || ended.stopReason === "error");
    await hand.cue(stopped ? "stop" : "done", stopped ? "stopped" : "done");
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
