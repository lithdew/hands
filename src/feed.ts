/**
 * What the user sees while hands work: a tile per hand with its pointer, the words as they are said, how each
 * task is going, and the question before anything sensitive.
 *
 * The windows are feed.cs, one helper process that stays up and only draws. Everything it is told comes from
 * here: a driver's steps (steps.ts) become pointer events, timeline.ts animates them, paint.ts turns each
 * moment into primitives, and this file sends them, about thirty times a second and only while something is
 * moving. A still feed costs nothing.
 *
 * Nothing here can hold a hand up. `step` returns at once, a write to a helper that has gone is swallowed, and
 * with HANDS_FEED=off, or where there are no windows to open, the same calls print to the terminal instead.
 * Only `approve` is awaited, and that is its point.
 */

import { createInterface } from "node:readline/promises";
import { feedWanted, narratorModel } from "./config.ts";
import { type FrameSize, isCursorEvent, short, type StateKind } from "./cursor.ts";
import { fitContain } from "./fit.ts";
import type { NativeSession } from "./macos.ts";
import { createNarrator, type Narrator, type Summarize } from "./narrate.ts";
import { paint } from "./paint.ts";
import { platform } from "./platform.ts";
import { type Step, stepLabel, stepLine, toCursorEvent } from "./steps.ts";
import { Timeline } from "./timeline.ts";
import { caption } from "./voice.ts";

export const TICK_MS = 33;
export const APPROVAL_TIMEOUT_MS = 30_000;
/** A finished hand's tile stays for a look at the result, then leaves the corner to the user. */
export const TILE_LINGER_MS = 20_000;
const CARD_LINGER_MS = 4_000;

export type TaskStatus = "running" | "queued" | "done" | "failed" | "stopped";

export interface ApprovalRequest {
  hand: number;
  /** What the hand is about to do, as the user should read it: "send the email to Dana". */
  what: string;
  /** The control, page or recipient it would be done to. */
  target?: string;
  timeoutMs?: number;
}

export interface Feed {
  /** A driver's step, just before it acts. Returns at once. */
  step(step: Step): void;
  /** Ask before a sensitive action. Resolves false when declined, when nobody answers, and when the feed has gone. */
  approve(request: ApprovalRequest): Promise<boolean>;
  /** A hand's task as a row on the card. `running` starts the narrator on it; anything final stops it. */
  task(hand: number, status: TaskStatus, request: string): void;
  /** The key is down, the words so far, the key is up. */
  listening(): void;
  transcript(text: string): void;
  finishing(): void;
  close(): Promise<void>;
}

export interface FeedOptions {
  /** The helper's `feed` mode. A test passes a fake; the default asks the platform. */
  open?: () => NativeSession;
  print?(line: string): void;
  /** With no windows: the one line of the terminal the words are rewritten on. Given "" to clear it. */
  live?(line: string): void;
  summarize?: Summarize;
  narrateEveryMs?: number;
  /** How long the card and a finished hand's tile stay. A test shortens them. */
  cardLingerMs?: number;
  tileLingerMs?: number;
  now?: () => number;
  /** The terminal's y/n, for a feed with no windows. A test replaces it. */
  askTerminal?(question: string, timeoutMs: number): Promise<boolean>;
}

const oneLine = (text: string, max = 600): string => text.replace(/\s+/g, " ").trim().slice(0, max);
const base64 = (text: string): string => (text ? Buffer.from(text, "utf8").toString("base64") : "-");
const FINAL: TaskStatus[] = ["done", "failed", "stopped"];
const STATE_LABEL: Partial<Record<StateKind, string>> = { blocked: "blocked", done: "done", error: "error", idle: "idle" };

async function terminalAnswer(question: string, timeoutMs: number): Promise<boolean> {
  if (!process.stdin.isTTY) return false; // nobody to ask is a no
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await lines.question(`${question} [y/N] `, { signal: AbortSignal.timeout(timeoutMs) });
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    lines.close();
  }
}

/** The feed, or its terminal-only stand-in when it is switched off or cannot start. Never throws. */
export function openFeed(options: FeedOptions = {}): Feed {
  const now = options.now ?? (() => performance.now());
  const askTerminal = options.askTerminal ?? terminalAnswer;
  const timeline = new Timeline();
  const tiles = new Map<number, { hwnd?: number; well?: { w: number; h: number }; source?: FrameSize; drawn: string; leave?: ReturnType<typeof setTimeout> }>();
  const frames = new Map<number, FrameSize>();
  const narrators = new Map<number, Narrator>();
  const rows = new Map<number, TaskStatus>();
  const waiting = new Map<string, (answer: boolean) => void>();
  const hwnds = new Map<number, number>();
  let session: NativeSession | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let cardTimer: ReturnType<typeof setTimeout> | undefined;
  let asked = 0;
  let asking: Promise<void> = Promise.resolve();
  let speaking = false;
  let closed = false;
  let words = "";

  // With no windows the words are one line of the terminal, and whatever is printed meanwhile goes above it, not over it.
  const live = options.live ?? ((line: string) => void (process.stdout.isTTY && process.stdout.write(`\r\x1b[2K${line}`)));
  const say = (line: string): void => void (session || (!words && !line) || live((words = line)));
  function print(line: string): void {
    if (words) live("");
    (options.print ?? console.log)(line);
    if (words) live(words);
  }

  if (feedWanted()) {
    try {
      session = (options.open ?? platform.feed)();
      void listenTo(session);
    } catch (error) {
      print(`feed: ${error instanceof Error ? error.message : String(error)}; progress stays in this terminal`);
    }
  }

  /** One command. The helper may have gone (closed by the user's session ending, killed): that is never the hand's trouble. */
  function send(line: string): void {
    try {
      session?.write(`${line}\n`);
    } catch {
      session = undefined;
    }
  }

  async function listenTo(from: NativeSession): Promise<void> {
    let rest = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of from.stdout) {
        const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
        rest = lines.pop()!;
        for (const line of lines) heard(line.trim().split(" "));
      }
    } catch {
      // A broken pipe is the same news as a closed one.
    }
    if (session === from) session = undefined;
    // Nobody can answer a question on a card that is gone.
    for (const settle of [...waiting.values()]) settle(false);
  }

  function heard(words: string[]): void {
    if (words[0] === "tile" && words.length >= 6) {
      const [hand, w, h, sw, sh] = words.slice(1).map(Number) as [number, number, number, number, number];
      const tile = tiles.get(hand);
      if (!tile) return;
      tile.well = { w, h };
      tile.source = sw > 0 && sh > 0 ? [sw, sh] : undefined;
      tile.drawn = ""; // the letterbox moved, so the same poses are a different picture
      wake();
    } else if (words[0] === "answer" && words.length >= 3) waiting.get(words[1]!)?.(words[2] === "yes");
  }

  function tileFor(hand: number) {
    let tile = tiles.get(hand);
    if (!tile) tiles.set(hand, (tile = { drawn: "" }));
    clearTimeout(tile.leave);
    tile.leave = undefined;
    return tile;
  }

  function watch(hand: number, hwnd: number): void {
    const tile = tileFor(hand);
    hwnds.set(hand, hwnd);
    if (tile.hwnd === hwnd) return;
    tile.hwnd = hwnd;
    send(`pip ${hand} ${hwnd}`);
  }

  function frame(): void {
    const at = now();
    const poses = timeline.poses(at);
    for (const [hand, tile] of tiles) {
      if (!tile.well) continue;
      const picture = paint(poses.filter((pose) => pose.hand === hand), fitContain(tile.source ?? frames.get(hand), tile.well)); // prettier-ignore
      if (picture === tile.drawn) continue;
      tile.drawn = picture;
      send(`draw ${hand} ${picture}`);
    }
    if (!timeline.animating(at)) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }

  function wake(): void {
    if (!session || ticker) return;
    ticker = setInterval(frame, TICK_MS);
    ticker.unref?.();
    frame();
  }

  /** The words leave the card a moment after the key comes up, and the card leaves with the last task. Never while the key is held. */
  function settleCard(): void {
    clearTimeout(cardTimer);
    if (speaking) return;
    cardTimer = setTimeout(() => {
      if (![...rows.values()].every((status) => FINAL.includes(status))) return send("rows");
      rows.clear();
      send("hide");
    }, options.cardLingerMs ?? CARD_LINGER_MS);
    cardTimer.unref?.();
  }

  function narratorFor(hand: number): Narrator {
    let narrator = narrators.get(hand);
    if (!narrator) {
      const onUpdate = (text: string) => (send(`progress ${hand} ${oneLine(text)}`), print(`H${hand}: ${text}`));
      narrators.set(hand, (narrator = createNarrator({ onUpdate, summarize: options.summarize, intervalMs: options.narrateEveryMs })));
    }
    return narrator;
  }

  function state(hand: number, kind: StateKind, caption?: string): void {
    timeline.push({ hand, kind, t: Date.now(), ...(caption ? { caption: short(caption) } : {}) }, now());
    wake();
  }

  /** The question on the card. Its hand holds amber until the chord, the clock, or the helper going answers it. */
  async function ask(request: ApprovalRequest, question: string, timeoutMs: number): Promise<boolean> {
    const id = String(++asked);
    print(`${question}. Ctrl+Alt+Y allows it, Ctrl+Alt+N declines; no answer in ${Math.round(timeoutMs / 1000)} s declines.`);
    state(request.hand, "blocked", "needs you");
    send(`label ${request.hand} blocked ${oneLine(request.what, 120)}`);
    send(`ask ${id} ${request.hand} ${Math.round(timeoutMs / 1000)} ${base64(oneLine(request.what, 300))} ${base64(oneLine(request.target ?? "", 200))}`);
    const answer = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      waiting.set(id, (yes) => (clearTimeout(timer), resolve(yes)));
    });
    waiting.delete(id);
    send(`answered ${id}`);
    print(answer ? "allowed" : "declined");
    state(request.hand, "think", answer ? "allowed" : "declined");
    return answer;
  }

  return {
    step(step) {
      try {
        if (step.frame) frames.set(step.hand, step.frame);
        if (step.hwnd !== undefined) watch(step.hand, step.hwnd);
        const event = toCursorEvent(step, frames.get(step.hand));
        if (!isCursorEvent(event)) return;
        timeline.push(event, now());
        send(`label ${step.hand} ${STATE_LABEL[step.kind as StateKind] ?? "working"} ${oneLine(stepLabel(step), 120)}`);
        if (narratorModel() !== "off") narratorFor(step.hand).step(stepLine(step));
        wake();
      } catch {
        // Drawing a pointer is never a reason for an action to fail.
      }
    },

    async approve(request) {
      const timeoutMs = request.timeoutMs ?? APPROVAL_TIMEOUT_MS;
      const question = `H${request.hand} wants to ${oneLine(request.what, 300)}${request.target ? ` (${oneLine(request.target, 200)})` : ""}`;
      // One question at a time, as the card holds one: a second hand's waits its turn, and its clock starts when it is shown.
      const turn = asking;
      const { promise, resolve: next } = Promise.withResolvers<void>();
      asking = promise;
      await turn;
      try {
        if (closed) return false;
        if (!session) return await askTerminal(question, timeoutMs);
        return await ask(request, question, timeoutMs);
      } finally {
        next();
      }
    },

    task(hand, status, request) {
      rows.set(hand, status);
      clearTimeout(cardTimer);
      send(`task ${hand} ${status} ${oneLine(request, 300)}`);
      if (status === "running") {
        // A tile that left after the last task comes back on the window it showed, before the first step says where.
        if (tileFor(hand).hwnd === undefined && hwnds.has(hand)) watch(hand, hwnds.get(hand)!);
        if (narratorModel() !== "off") narratorFor(hand).start(request);
        state(hand, "think");
        return;
      }
      if (!FINAL.includes(status)) return;
      narrators.get(hand)?.stop();
      state(hand, status === "done" ? "done" : status === "failed" ? "error" : "idle");
      send(`label ${hand} ${status === "done" ? "done" : status === "failed" ? "error" : "idle"} ${status}`);
      const tile = tiles.get(hand);
      if (tile) {
        clearTimeout(tile.leave);
        tile.leave = setTimeout(() => (tiles.delete(hand), send(`pip ${hand} off`)), options.tileLingerMs ?? TILE_LINGER_MS);
        tile.leave.unref?.();
      }
      settleCard();
    },

    listening() {
      speaking = true;
      clearTimeout(cardTimer);
      send("listening");
      say("… listening");
    },
    transcript(text) {
      send(`transcript ${oneLine(text, 2000)}`);
      say(caption(text, process.stdout.columns));
    },
    finishing() {
      speaking = false;
      send("finishing");
      say("");
      settleCard();
    },

    async close() {
      closed = true;
      say("");
      clearInterval(ticker);
      clearTimeout(cardTimer);
      for (const tile of tiles.values()) clearTimeout(tile.leave);
      for (const narrator of narrators.values()) narrator.stop();
      for (const settle of [...waiting.values()]) settle(false);
      const open = session;
      session = undefined;
      if (!open) return;
      const timer = setTimeout(() => open.kill(), 2_000);
      try {
        open.end(); // closing its stdin is what ends it: a signal does not cross WSL interop
      } catch {
        open.kill();
      }
      await open.exited.catch(() => {});
      clearTimeout(timer);
    },
  };
}
