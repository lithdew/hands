/**
 * The page's small decisions about what it is sent and what it is asked, made without a page, so they are tested
 * without one: what a card says, which lines start a new hand under a name a card still has, what becomes of a
 * picture when its hand moves to another window, and which keys close a hand.
 */

import type { HandView, LogEntry } from "./state.ts";
import { gist } from "./text.ts";

/** Starts with a capital, as a sentence does: "click “Search”" becomes "Click “Search”". */
export const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * What a card says under its picture: what came of the hand, or what it needs. Empty when the header and the picture
 * say it all: a hand at work says what it is doing on its picture, and one starting shows its task there.
 */
export function says(hand: Pick<HandView, "status" | "seat" | "seatWhy" | "answer" | "reason">): string {
  if (hand.seat === "holding") return hand.seatWhy ? `${sentence(hand.seatWhy)} with your mouse and keyboard.` : "Using your mouse and keyboard.";
  if (hand.seat === "waiting") return `Waiting for you to pause${hand.seatWhy ? `, before ${hand.seatWhy}` : ""}.`;
  if (hand.status === "paused") return "Paused. Tell it what to change, or let it carry on.";
  if (hand.status === "needs_you") return gist(hand.answer) || "It needs you to do something in its window.";
  if (hand.status === "failed") return hand.reason || gist(hand.answer) || "It ran into an error and stopped.";
  if (hand.status === "working" || hand.status === "starting") return "";
  return gist(hand.answer); // done or stopped: the chip says which, and this says what came of it, if anything did
}

/**
 * A tool call, as the ticks along a card's header show it: done (true), gone wrong (false), or still running (null).
 * A call of the clicker's is Jev's, and counts Jev's own moves while it runs (see `moved`).
 */
export interface Step {
  ok: boolean | null;
  jev: boolean;
  moves: number;
}

/**
 * The steps these lines add to `into`: a step for each tool call, settled by its result. A clicker call that
 * returns with its goal not achieved went wrong, whatever else it says.
 */
export function steps(entries: LogEntry[], into: Step[] = []): Step[] {
  for (const entry of entries) {
    if (entry.kind === "tool") into.push({ ok: null, jev: entry.text.startsWith("clicker "), moves: 0 });
    else if (entry.kind === "result" || entry.kind === "error") {
      const running = into.find((step) => step.ok === null); // results come in the order their calls did
      if (running) running.ok = entry.kind === "result" && !(running.jev && /"goal_achieved": ?false/.test(entry.text));
    }
  }
  return into;
}

/** How a finished hand's receipt counts its work: "12 steps · 5 by Jev · 0:52". A clicker call is as many steps as Jev's moves in it. */
export function tally(all: Step[], clock: string): string {
  const jev = all.reduce((sum, step) => sum + (step.jev ? Math.max(1, step.moves) : 0), 0);
  const total = all.filter((step) => !step.jev).length + jev;
  return [total ? `${total} step${total === 1 ? "" : "s"}` : "", jev ? `${jev} by Jev` : "", clock].filter(Boolean).join(" · ");
}

/** What goes before each action of Jev's while it drives, in a hand's tag and so in its action: "Jev › click “Next”". */
const JEV = /^Jev\s*[›>]\s*/;

/** An action as the card shows it, without Jev's name before it, and whether it had it. */
export function driver(action: string): { jev: boolean; label: string } {
  const named = JEV.exec(action);
  return named ? { jev: true, label: action.slice(named[0].length) } : { jev: false, label: action };
}

/** What a hand says between its moves: resting, looking, waiting, or the clicker taking a goal. */
const RESTING = /^(thinking|looking|waiting\b|clicker:)/;

/** Whether an action that changed from `before` to `after` is a move: new words, and ones that act. */
export function moved(before: string, after: string): boolean {
  const next = driver(after).label;
  return next !== "" && next !== driver(before).label && !RESTING.test(next);
}

/** How long a picture may go without a new frame before it says it is not live: frames come once a second at the least. */
export const STALE_MS = 3000;

/** What a live picture's dot says of the last frame: nothing while frames come, and how long ago once they stop. */
export function stale(now: number, shotAt: number): string {
  const seconds = Math.floor((now - shotAt) / 1000);
  if (now - shotAt <= STALE_MS) return "";
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}

/** What a lookup is searching for, from its action ("searching 'ramen near King's Cross'"), as its card says it. */
export function searching(action: string): string {
  const query = /^searching\s+(.+)$/i.exec(action.trim())?.[1]?.trim();
  if (!query) return action.trim() ? sentence(action.trim()) : "Searching the web";
  return `Searching “${query.replace(/^['"‘“]+|['"’”]+$/g, "")}”`;
}

/** Second-level names under which a country's sites sit: bbc.co.uk is "bbc", not "co". */
const UNDER = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"]);

/** A source's chip: its site as a reader names it (no www), and the letter that stands for it. */
export function site(url: string): { letter: string; name: string } {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { letter: "?", name: url.slice(0, 24) };
  }
  host = host.replace(/^www\d?\./, "");
  const labels = host.split(".");
  const [second = "", top = ""] = labels.slice(-2);
  const main = labels.length >= 3 && top.length === 2 && UNDER.has(second) ? labels[labels.length - 3]! : labels.length >= 2 ? second : host;
  return { letter: (main.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase(), name: host.length > 26 ? `${host.slice(0, 25)}…` : host };
}

/**
 * Whether these lines start a hand's transcript. A task is its first line and comes at no other time, so lines that
 * bring one for a card still out are a new hand's: one that took a closed hand's name before the page heard that the
 * closed one had gone. A transcript sent afresh (on connecting) starts with the task too, and is not a new hand.
 */
export const anew = (entries: LogEntry[], reset = false): boolean => !reset && entries.some((entry) => entry.kind === "task");

/**
 * What a card does with the picture it has when the state comes. The camera sends a window's frame before the state
 * that says the window is drawing, so a "live" state names the window the frames come from ("of"). A hand that has
 * moved to another window keeps the last one's frame for the moment it takes to film the new one; but when the new one
 * turns out to have nothing to show (it is not drawing, or it is minimized), that frame goes ("forget"), rather than
 * another window's picture passing for this one's. `of` is the window the picture was last said to be of.
 */
export function sight(hand: Pick<HandView, "picture" | "window">, of: number | null | undefined, has: boolean): "of" | "forget" | "keep" {
  if (hand.picture === "live") return "of";
  return has && of !== hand.window && hand.picture !== "none" ? "forget" : "keep";
}

/** What of a key press (a KeyboardEvent) says which key it was. */
export interface Press {
  key: string;
  code: string;
  keyCode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * Whether a key press is the one that closes a hand: Ctrl+W on Windows, ⌘W on the Mac, matched as the systems match
 * their own shortcuts. A layout's W is its W, wherever it is. A layout that types no Latin letter on that key (Russian,
 * Greek, Hebrew) has none, and there the key in W's place on a US keyboard is W: Windows says so with its virtual key,
 * which such layouts keep there, and the Mac falls back to that place for its ⌘ shortcuts. A Latin letter in W's place
 * is never W: on AZERTY that is Z, and Ctrl+Z is undo.
 */
export function closes(press: Press, windows: boolean): boolean {
  if (!(windows ? press.ctrlKey : press.metaKey) || press.altKey) return false;
  if (press.key.toLowerCase() === "w") return true;
  if (/^[a-z]$/i.test(press.key)) return false;
  return windows ? press.keyCode === 87 : press.code === "KeyW";
}
