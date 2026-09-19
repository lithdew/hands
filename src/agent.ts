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
import { drive, warm } from "./drive.ts";
import { openFeed, TILE_LINGER_MS } from "./feed.ts";
import { type Hand, openHand } from "./hand.ts";
import { onPayload, resolveModel, runtime } from "./llm.ts";
import { platform as macos } from "./platform.ts";
import { computerTools, type Details } from "./tools.ts";
import { listen, startRecording } from "./voice.ts";
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

/** What changes when the user keeps the seat: the agent works apps and a browser window of its own, from behind theirs. */
const backgroundPrompt = (browser: string) => `# Working in the background
The user is using this Mac right now and has asked you not to take their mouse, keyboard, or focus. So everything you do names its target, and nothing goes through the seat:
- \`open_app\` starts an app, or takes up a running one, without bringing it forward, and \`browser\` open gives you a ${browser} window of your own in their profile, behind their windows. Whichever you used last is the window you are working in. \`screen\` reads that window where it lies.
- \`click\` presses an item with a role (button, link, field, popup, tab, cell...) through accessibility, which is the sure way: prefer it, and when the thing you want shows up only as text, look for the control that carries it, often listed right beside it or in the off-screen list. Anything else, a canvas, a toolbox with no labels, a bare x,y, gets a pointer of your own: \`click\` with x,y and \`drag\` send pointer events addressed to your window alone, so the user's cursor never moves. A browser only hands those to a page it thinks can be seen, so the first time you use them your browser window is slid until a strip of it shows at a screen edge. Use the screenshot to aim, and again to check what you drew.
- \`menu\` chooses a command from the app's menu bar by its path, without the menu ever opening. It is the way to make a new document or note, save, select all, change a view. Give a partial path to see what a menu holds before guessing a name.
- In an app, \`key\` and \`type\` without an item send keys to that app's process, to wherever its own cursor is, so make sure its cursor is where you mean (press the field, or make the new document) first. \`type\` with an item sets a field's value outright. The browser takes neither: its keys would land in whichever of its windows the user is in, so submit a web form with \`type\` submit=true or by pressing its button.
- In the browser, pressing a link or a button is invisible to the user. \`browser\` open is too when the user has allowed JavaScript from Apple Events in their browser; when they have not, it takes the keyboard from whatever they are doing for about a fifth of a second before it is handed back. You cannot tell which, so move through a site by pressing its links and controls, and keep \`browser\` open for getting to a site in the first place, or for a URL that saves many steps (search results, filters and dates usually live in the query string). Keep pages the user should see open as tabs (\`browser\` open with new_tab=true), and say so at the end.
- The clipboard is the user's too: do not copy or paste through it. Put text in with \`type\`, and move files with the shell.
- If something truly cannot be done from here, do what you can and tell the user to run it again without --background.
`;

export function systemPrompt(cwd: string, background = false): string {
  const now = nowContext();
  const browser = config.browser();
  if (background) {
    return `You are Hands, an agent working on the user's Mac for them, in the background. You operate its apps and websites from behind the user's windows, and you also have a shell and file tools in ${cwd}.

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
  return `You are Hands, an agent operating the user's Mac for them. You see the screen and use the mouse and keyboard through tools, and you also have a shell and file tools in ${cwd}.

Now: ${now.local_time} (${now.timezone}). Home: ${homedir()}. Browser: ${browser}.

# Working the screen
- Do what the user asks on their actual desktop apps and websites, through the computer-use tools. When they ask you to use an app or a site, operate it as they would: do not substitute a shell command, an API, or your own knowledge for it. The shell and file tools are for local work around the task: writing and converting files, building a PDF, checking what exists.
- \`screen\` is how you see, and \`open_app\` and \`browser\` end with the same listing. Its indexes and coordinates only describe the capture they came from, so look again after anything that changes the screen, and before you report what it shows. Read results off the screen; never answer from memory or arithmetic what the user asked you to look up or compute with an app.
- Prefer clicking an item by index over a raw x,y. Ask for the screenshot when text is not enough: canvases, images, layout, or checking visual work.
- You may issue several tool calls in one turn when you already know the sequence (a run of clicks, then \`screen\`); they run in order.
- Websites open only through the \`browser\` tool, in the user's running ${browser} and existing profile: reuse or open tabs and windows there. Never launch another browser, a second ${browser} instance, a different profile, or a headless one.
- \`clicker\` is a fast, cheap delegate for simple click-through sub-goals. Give it one concrete goal, then check the screen yourself.
- Keep going until the task is actually done. A step that fails or a page that surprises you is a reason to look again (with the screenshot) and take another route: mouse=true, a keyboard shortcut, a menu, a different page or search. Do not hand the task back half done. Stop early only for what the user alone can resolve, such as a login, a payment, or a CAPTCHA, and then say exactly what is on screen.
- The user may be using this Mac at the same time. If another app has come to the front, bring yours back (\`open_app\`, or \`browser\` switch_tab) and carry on.

# Boundaries
- Never type, guess, or reveal passwords or payment details. If a login is required, stop and say so.
- Do not send messages, make purchases, place bookings, or delete the user's data unless they asked for exactly that. Looking up availability is not booking.
- Do not change the user's settings or preferences, in an app or the system, to make a task easier. If a feature gets in the way (autocorrect, smart substitutions, a results popup), work around it, or finish and say what it did.
- Leave the user's other windows and tabs as you found them, apart from what the task needs.

Finish with a short plain answer: what you found or did, and where any file you made lives.`;
}

const MAX_RETRIES = 4;
/** One hand for now; the feed and the card are already keyed by it. */
const HAND = 1;

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
function report(agent: Agent, runDir: string): void {
  const file = join(runDir, "agent.log");
  const record = (line: string) => appendFileSync(file, `${line}\n`);
  let streaming = false;
  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
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

const USAGE = `usage: hands [prompt] [--background] [--listen] [--cwd DIR] [--out DIR] [--model provider/model] [--thinking LEVEL]

An agent that drives this Mac: ${config.DEFAULT_MODEL} at ${config.DEFAULT_THINKING} effort, with read, bash, edit, write and computer use.
With no prompt it reads one per line until EOF. Abort: Ctrl-C, or slam the mouse into a screen's top-left corner.
Off the Mac, Jev's loop works a task first, in the background, and this agent takes over what Jev gives up on once
\`pi\` is signed in (HANDS_DRIVER=jev: never, HANDS_DRIVER=pi: this agent alone).

  --background   keep working while it works: apps are started without coming forward, the browser gets a window
                 of its own behind yours, and clicks, drags and keys are addressed to its windows rather than
                 sent through your mouse and keyboard.
  --listen       take tasks by voice: hold ${config.hotkey()} (HANDS_HOTKEY), speak, release. It works in the background, what
                 you say next follows on in the same conversation, and Ctrl+Alt+Esc drops a hold or stops the task.`;

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
      listen: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return void console.log(USAGE);
  // Jev's loop drives (drive.ts), and the pi agent is only made when a task is handed to it: it needs a `pi` sign-in that Jev does not.
  const jev = config.driver() === "jev";
  if (jev && !process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set: Jev drives every task with it (put it in .env, or set HANDS_DRIVER=pi)");
    process.exit(1);
  }
  if (!process.env.TYPESAFE_API_KEY) console.log("TYPESAFE_API_KEY is not set: the clicker tool will fail until it is (put it in .env)");
  if (!macos.accessibilityTrusted()) {
    console.error("this terminal lacks Accessibility permission; grant it in System Settings > Privacy & Security");
    process.exit(1);
  }
  // Someone speaking to it is at the machine, so a spoken task never takes the seat. Nor does a hand of Jev's, ever.
  const background = values.background || values.listen || jev;
  let keys: macos.NativeStream | undefined;
  if (values.listen) {
    try {
      if (!config.openaiKey()) throw new Error("OPENAI_API_KEY is not set: --listen transcribes with it (put it in .env)");
      keys = macos.heldKey(config.hotkey());
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
  const runDir = resolve(values.out);
  let agent: Agent | undefined;
  const pi = async (): Promise<Agent> => {
    if (agent) return agent;
    agent = await createAgent({ cwd: resolve(values.cwd), runDir, model: values.model, thinking: values.thinking, background });
    report(agent, runDir);
    return agent;
  };
  if (!jev) await pi();
  // Jev's loop never reads the pointer (on Windows that is a process start), so the corner only stops the pi agent.
  console.log(`run folder: ${runDir}\nabort: Ctrl-C${jev ? "" : ", or slam the mouse into a screen's top-left corner"}.`);
  if (background) console.log("background: working behind your windows. Your mouse, keyboard and focus stay yours.");

  const feed = jev ? openFeed() : undefined;
  if (jev) warm();
  const learning: Promise<void>[] = [];
  const queued: string[] = [];
  let hand: Hand | undefined;
  let task: AbortController | undefined;
  const stop = () => {
    queued.length = 0;
    task?.abort();
    agent?.clearAllQueues();
    macos.interrupt();
    agent?.abort();
  };

  let [interrupts, busy] = [0, false];
  let leaving: Promise<void> | undefined;
  process.on("SIGINT", () => {
    // With no task to stop, Ctrl-C is goodbye: what the hand opened is closed on the way out. Twice is at once.
    if (feed && !busy) return leaving ? process.exit(130) : void leave().finally(() => process.exit(130));
    if (++interrupts > 1) process.exit(130);
    macos.interrupt();
    task?.abort();
    agent?.abort();
  });
  /** One prompt through the pi agent. False when its turn ended in an error or was stopped. */
  const prompt = async (text: string): Promise<boolean> => {
    const it = await pi();
    await ask(it, text);
    const last = it.state.messages.at(-1);
    return last?.role === "assistant" && last.stopReason !== "error" && last.stopReason !== "aborted";
  };
  const run = async (text: string) => {
    interrupts = 0;
    macos.interrupt(false);
    if (!feed) return void (await prompt(text));
    mkdirSync(runDir, { recursive: true });
    [task, busy] = [new AbortController(), true];
    try {
      hand ??= await openHand({ id: HAND });
      const log = (line: string) => appendFileSync(join(runDir, "jev.log"), `${line}\n`);
      learning.push((await drive(text, { hand, feed, signal: task.signal, model: values.model, fallback: prompt, log })).learning);
    } finally {
      busy = false;
    }
  };
  /** What a hand has open is closed the way its own close button closes it, and a recipe being learned is written first. The browser stays, for the next run. */
  const leave = (): Promise<void> =>
    (leaving ??= (async () => {
      await Promise.all(learning);
      await hand?.close().catch(() => {});
      await feed?.close();
    })());
  /** A one-shot run ends with its task, and the tile with it: the result stays up for the look it gets between tasks, and the app it is in stays open under it. */
  const linger = async () => {
    if (!config.feedWanted() || !hand?.window() || task?.signal.aborted) return;
    console.log(`the result stays on the feed for ${TILE_LINGER_MS / 1000} s. Ctrl-C leaves now.`);
    await Bun.sleep(TILE_LINGER_MS);
  };

  if (keys) {
    console.log(`listening: hold ${config.hotkey()} to speak, release to send. Ctrl+Alt+Esc drops a hold or stops the task.`);
    await listen({
      keys,
      feed,
      record: (onDelta) => startRecording({ onDelta, capture: macos.microphone }),
      // Something queued in the moment the agent was stopping would wait for the next task; it is run now.
      run: async (text) => {
        await run(text);
        while (agent?.hasQueuedMessages()) await agent.continue();
        // Jev has no conversation to follow up in: what was said meanwhile is the next task, in the order it was said.
        for (let next = queued.shift(); next !== undefined; next = queued.shift()) await run(next);
      },
      // The card's rows are keyed by hand, so a queued task is not put on it: it would replace the row of the one running.
      queue: (text) => (feed ? void queued.push(text) : (agent as Agent).followUp({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() })),
      stop,
      // With a feed the words are on its card (or on its own terminal line when HANDS_FEED=off).
      live: feed ? undefined : (line) => void process.stdout.write(`\r\x1b[2K${line}`),
    });
    return leave();
  }
  if (positionals.length) return run(positionals.join(" ")).then(linger).finally(leave);
  process.stdout.write("> ");
  for await (const line of console) {
    if (line.trim()) await run(line).catch((error) => console.error(`task failed: ${error instanceof Error ? error.message : String(error)}`));
    process.stdout.write("> ");
  }
  await leave();
}

if (import.meta.main) {
  await main(process.argv.slice(2));
  process.exit(0); // the model runtime keeps a socket open
}
