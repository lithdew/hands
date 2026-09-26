/**
 * The page's small decisions about what it is sent and what it is asked, made without a page, so they are tested
 * without one: which lines start a new hand under a name a card still has, what becomes of a picture when its hand
 * moves to another window, and which keys close a hand.
 */

import type { HandView, LogEntry } from "./state.ts";

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
