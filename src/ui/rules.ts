/**
 * The page's small decisions about what it is sent and what it is asked, made without a page, so they are tested
 * without one: what a card says, what the user can ask of its hand, which lines start a new hand under a name a card
 * still has, what becomes of a picture when its hand moves to another window, and which keys close a hand.
 */

import type { HandView, LogEntry, Status } from "./state.ts";
import { gist } from "./text.ts";

/** Starts with a capital, as a sentence does: "click “Search”" becomes "Click “Search”". */
export const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * What a card says under its picture: what came of the hand, or what it needs. Empty when the header and the picture
 * say it all: a hand at work says what it is doing on its picture, and one starting shows its task there.
 */
export function says(hand: Pick<HandView, "status" | "seat" | "seatWhy" | "answer" | "reason">): string {
  // Borrowing the seat: what for, and how to have it back, where the card is, not only in the dock.
  if (hand.seat === "holding") return `${hand.seatWhy ? `${sentence(hand.seatWhy)} with` : "Using"} your mouse and keyboard — move the mouse to take them back.`;
  if (hand.seat === "waiting") return `Waiting for you to pause a second${hand.seatWhy ? `, before ${hand.seatWhy}` : ""}.`;
  if (hand.status === "paused") return "Paused. Tell it what to change, or let it carry on.";
  if (hand.status === "needs_you") return gist(hand.answer) || "It needs you to do something in its window.";
  if (hand.status === "failed") return hand.reason || gist(hand.answer) || "It ran into an error and stopped.";
  if (hand.status === "working" || hand.status === "starting") return "";
  return gist(hand.answer); // done or stopped: the chip says which, and this says what came of it, if anything did
}

export const busy = (hand: Pick<HandView, "status">): boolean => hand.status === "working" || hand.status === "starting";

/** A clock's "m:ss". */
export const elapsed = (since: number, now = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/**
 * How long a hand has been at it, `was` being what its card last said and `before` the state it was last drawn in.
 * The clock runs while the hand works, and stops when the hand does: at the time the state says it stopped (`until`),
 * or else when the page saw it stop. A card first drawn after its hand stopped (the page was loaded again) cannot
 * tell without that time, and says nothing rather than the time since the hand started.
 */
export function clock(was: string, hand: Pick<HandView, "status" | "since" | "until">, before: Pick<HandView, "status"> | null, now = Date.now()): string {
  if (busy(hand)) return elapsed(hand.since, now);
  if (hand.until) return elapsed(hand.since, hand.until);
  return before && busy(before) ? elapsed(hand.since, now) : was;
}

/** What the user can ask of a hand from its card: the sheet's buttons, the tools on its picture, and Ctrl+. */
export type Control = "pause" | "resume" | "stop" | "show" | "close";

/** What each state lets the user do. */
const CONTROLS: Record<Status, Control[]> = { starting: ["stop"], working: ["pause", "stop", "show"], paused: ["resume", "stop", "show"], needs_you: ["show", "close"], done: ["show", "close"], failed: ["show", "close"], stopped: ["show", "close"] };

/** What the user can ask of a hand now. A lookup has no window, and is not paused. (Show wants a picture as well: card.ts.) */
export function controls(hand: Pick<HandView, "status" | "kind">): Control[] {
  return CONTROLS[hand.status].filter((control) => hand.kind !== "lookup" || (control !== "pause" && control !== "resume"));
}

/** What Ctrl+. in a sheet asks: a hand at work pauses, a paused one carries on, and one that offers neither is left as it is. */
export function hold(hand: Pick<HandView, "status" | "kind">): "pause" | "resume" | null {
  const can = controls(hand);
  return can.includes("pause") ? "pause" : can.includes("resume") ? "resume" : null;
}

/**
 * A tool call, as the ticks along a card's header show it: done (true), gone wrong (false), or still running (null).
 * A call of the clicker's is Jev's, and counts Jev's own moves while it runs (see `moved`). `call` is the call's id,
 * when the transcript gives one.
 */
export interface Step {
  ok: boolean | null;
  jev: boolean;
  moves: number;
  call?: string;
}

/**
 * The steps these lines add to `into`: a step for each tool call, settled by its result. A result that names its
 * call settles that one. One that does not settles the oldest still running, which is its own when calls run one at
 * a time (the computer tools, the clicker among them, always do); in a batch run at once, results come as the calls
 * finish, so there the ticks may change places, though not their number. A clicker call that returns with its goal
 * not achieved went wrong, whatever else it says, and its result's count of Jev's moves, when it has one, is the count.
 */
export function steps(entries: LogEntry[], into: Step[] = []): Step[] {
  for (const entry of entries) {
    if (entry.kind === "tool") into.push({ ok: null, jev: entry.text.startsWith("clicker "), moves: 0, ...(entry.call ? { call: entry.call } : {}) });
    else if (entry.kind === "result" || entry.kind === "error") {
      const running = (entry.call ? into.find((step) => step.ok === null && step.call === entry.call) : undefined) ?? into.find((step) => step.ok === null);
      if (!running) continue;
      running.ok = entry.kind === "result" && !(running.jev && /"goal_achieved": ?false/.test(entry.text));
      if (running.jev && entry.moves !== undefined) running.moves = entry.moves;
    }
  }
  return into;
}

/**
 * The steps of a transcript sent again from its start (on connecting afresh), keeping the moves of Jev's the page
 * counted before: the transcript has its calls but not always the moves made in them. The same calls come in the
 * same order, so a step keeps the count of the one in its place, when that was Jev's too.
 */
export function recount(before: Step[], after: Step[]): Step[] {
  for (const [index, step] of after.entries()) {
    const was = before[index];
    if (step.jev && was?.jev && !step.moves) step.moves = was.moves;
  }
  return after;
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

/** How sure Jev must be, reading a done hand's last screen, that it shows the answer is so, for the receipt to say it saw it. */
export const SEEN = 0.8;

/** Whether a done hand's receipt says Jev saw its answer on its last screen: only when Jev was sure; below that, nothing is said. */
export const seen = (hand: Pick<HandView, "status" | "checked">): boolean => hand.status === "done" && (hand.checked ?? 0) >= SEEN;

/** How long the dock shows what came of a typed line: long enough to read it, and a few seconds for a few words. */
export const lingers = (said: string): number => Math.min(10_000, Math.max(3000, 1500 + 60 * said.length));

/**
 * What a lookup is searching for, from its action ("searching “ramen near King's Cross”"), as its card says it: a
 * search still going ends in "…". Only a quoted query is a query: "searching the web" is not a search for "the web".
 */
export function searching(action: string): string {
  const said = action.trim();
  if (!said) return "Searching the web…";
  const query = /^searching\s+['"‘“](.+?)['"’”]?$/i.exec(said)?.[1]?.trim();
  if (query) return `Searching “${query}”…`;
  return /^searching\b/i.test(said) ? `${sentence(said)}…` : sentence(said);
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

/** What the keyboard does in a sheet, besides typing: the next or the previous hand's sheet, and pause or carry on. */
export type Shortcut = "next" | "previous" | "hold";

/** Ctrl (⌘ on the Mac) with ↓ or ↑ moves between the hands' sheets, and with . pauses the hand or lets it carry on. */
export function shortcut(press: Press, windows: boolean): Shortcut | null {
  if (!(windows ? press.ctrlKey : press.metaKey) || press.altKey) return null;
  if (press.key === "ArrowDown") return "next";
  if (press.key === "ArrowUp") return "previous";
  if (press.key === "." || press.code === "Period") return "hold";
  return null;
}

/** The hand `by` places from `from` in the column, stopping at either end; null when there is none but it. */
export function neighbour(ids: string[], from: string, by: 1 | -1): string | null {
  const at = ids.indexOf(from);
  const to = at < 0 ? -1 : Math.max(0, Math.min(ids.length - 1, at + by));
  return to < 0 || to === at ? null : ids[to]!;
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
