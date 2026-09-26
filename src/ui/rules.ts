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
