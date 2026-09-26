/// <reference lib="dom" />
/**
 * A hand's card. Headed in its glove colour, with a glyph that is always that hand's own; under the header a
 * picture of the window it works in, with its hand drawn where the real one is; under that, what it is doing or
 * what came of it. Open, it has a sheet: what it was told, did and said, and a box to tell it something. All that
 * came from the hand, and so often from a web page, is set as text, never as HTML.
 */

import { finished } from "./fold.ts";
import { ms, settle } from "./motion.ts";
import { sight } from "./rules.ts";
import type { ClientMessage, HandView, LogEntry, Status } from "./state.ts";
import { blocks, gist } from "./text.ts";

/** Who each hand is, whatever pose it strikes out on the screen. */
const IDENTITY: Record<string, string> = { lefty: "👈", righty: "👉", thumbs: "👍", pinky: "👌", index: "☝️", palm: "🖐️", knuckles: "✊", digit: "✌️" };
export const identity = (name: string): string => IDENTITY[name.toLowerCase()] ?? "✋";

/** Where each pose's glyph touches what it points at, as a fraction of its box (hand.ts's POSES), so the marker's fingertip is on the control. */
const TOUCH: Record<string, [number, number]> = { "👋": [0.45, 0.75], "👆": [0.28, 0.11], "✍️": [0.02, 0.81], "👇": [0.48, 0.82], "✌️": [0.45, 0.13], "🖐️": [0.4, 0.47], "👉": [0.74, 0.42], "✋": [0.37, 0.47], "👍": [0.36, 0.44] };

/** The word in a card's header. A hand at work has none: the line moving under its name says it. */
const CHIP: Record<Status, string> = { starting: "starting", working: "", paused: "paused", needs_you: "needs you", done: "done", failed: "failed", stopped: "stopped" };

/** What each state lets the user do from the sheet. */
const CONTROLS: Record<Status, string[]> = { starting: ["stop"], working: ["pause", "stop", "show"], paused: ["resume", "stop", "show"], needs_you: ["show", "close"], done: ["show", "close"], failed: ["show", "close"], stopped: ["show", "close"] };

export const busy = (hand: Pick<HandView, "status">): boolean => hand.status === "working" || hand.status === "starting";

export interface Card {
  id: string;
  root: HTMLElement;
  view: HandView | null;
  frames: HTMLImageElement[]; // two: the one in front shows, the next frame is decoded in the other
  url: string; // what the image in front shows, to be let go of when the next frame comes
  frame: number; // counts frames, so a slow decode never covers a newer one
  ratio: number | null; // the picture's own width over its height, from the last frame
  of: number | null | undefined; // the window the picture is of: the one the state last said was drawing (see track)
  clock: string; // how long it has been at it, frozen when it stops
  leaving: boolean;
}

const template = document.getElementById("card") as HTMLTemplateElement;

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text) made.textContent = text;
  return made;
};
export const part = <T extends HTMLElement = HTMLElement>(card: Card, selector: string): T => card.root.querySelector(selector) as T;

/** Text set only when it changes, so a card updated many times a second does no work for nothing. Says whether it changed. */
const put = (target: HTMLElement, text: string): boolean => {
  if (target.textContent === text) return false;
  target.textContent = text;
  return true;
};

/** Starts with a capital, as a sentence does: "click “Search”" becomes "Click “Search”". */
const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export function build(id: string, act: (message: ClientMessage) => void, toggle: (id: string) => void, closeKey: string): Card {
  const root = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  const card: Card = { id, root, view: null, frames: [...root.querySelectorAll<HTMLImageElement>(".screen img")], url: "", frame: 0, ratio: null, of: undefined, clock: "", leaving: false };
  for (const selector of ["header", ".fold", ".tell"]) part(card, selector).addEventListener("click", () => toggle(id));
  part(card, ".close-key").textContent = closeKey;
  part<HTMLFormElement>(card, "form").addEventListener("submit", (event) => {
    event.preventDefault();
    const box = part<HTMLInputElement>(card, "input");
    const text = box.value.trim();
    // An empty line to a paused hand means: carry on.
    if (text) act({ cmd: "steer", hand: id, text });
    else if (card.view?.status === "paused") act({ cmd: "resume", hand: id });
    box.value = "";
  });
  for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-cmd]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation(); // the picture's Show is on the picture, which opens the sheet
      act({ cmd: button.dataset.cmd as "pause" | "resume" | "stop" | "show" | "close", hand: id });
    });
  }
  return card;
}

/** What a card says under its picture: what the hand is doing, or what came of it. Empty when the header says it all. */
export function says(hand: HandView): string {
  if (hand.seat === "holding") return hand.seatWhy ? `${sentence(hand.seatWhy)} with your mouse and keyboard.` : "Using your mouse and keyboard.";
  if (hand.seat === "waiting") return `Waiting for you to pause${hand.seatWhy ? `, before ${hand.seatWhy}` : ""}.`;
  if (hand.status === "working") return sentence(hand.action || "thinking");
  if (hand.status === "paused") return "Paused. Tell it what to change, or let it carry on.";
  if (hand.status === "needs_you") return gist(hand.answer) || "It needs you to do something in its window.";
  if (hand.status === "failed") return hand.reason || gist(hand.answer) || "It ran into an error and stopped.";
  if (hand.status === "starting") return ""; // the task stands where the picture will be
  return gist(hand.answer); // done or stopped: the chip says which, and this says what came of it, if anything did
}

/** The card brought up to date with its hand. `folded`, `bare` and `open` are the column's say (fold.ts). */
export function paint(card: Card, hand: HandView, place: { folded: boolean; bare: boolean; open: boolean }): void {
  const before = card.view;
  card.view = hand;
  const { root } = card;
  root.style.setProperty("--glove", `#${hand.color}`);
  root.dataset.status = hand.status;
  root.dataset.seat = hand.seat;
  root.dataset.picture = hand.picture;
  root.classList.toggle("strip", place.folded);
  root.classList.toggle("open", place.open);
  root.classList.toggle("viewed", hand.viewing && !place.open);
  if (busy(hand) || !card.clock) card.clock = elapsed(hand.since);

  put(part(card, ".who"), identity(hand.name));
  put(part(card, ".name"), hand.name);
  put(part(card, "time"), card.clock);
  put(part(card, ".doing"), hand.status === "working" ? hand.action || "thinking" : hand.status === "starting" ? hand.task : "");
  const chip = part(card, ".chip.state");
  const word = hand.seat === "holding" ? "using your mouse" : hand.seat === "waiting" ? "waiting for you" : CHIP[hand.status];
  if (put(chip, word) && before) settle(chip); // a status change, set down where the eye is
  chip.hidden = !word;

  const said = says(hand);
  put(part(card, ".said"), said);
  // Over, and unfolded: a receipt, its answer first and a small picture of its window beside it.
  const receipt = finished(hand.status) && !place.folded && !place.open;
  root.classList.toggle("receipt", receipt);
  root.classList.toggle("quiet", !(said || (receipt && shown(card))) || place.open || place.bare || (place.folded && busy(hand) && !hand.seat));
  put(part(card, ".brief"), hand.task);
  picture(card);
  mini(card);

  const allowed = CONTROLS[hand.status];
  for (const button of root.querySelectorAll<HTMLButtonElement>(".controls button[data-cmd]")) {
    const cmd = button.dataset.cmd!;
    button.hidden = !allowed.includes(cmd) || (cmd === "show" && !shown(card));
  }
  part(card, ".view .show").hidden = !shown(card);
  const box = part<HTMLInputElement>(card, "input");
  box.placeholder = busy(hand) ? `Tell ${hand.name} what to change` : hand.status === "paused" ? `Tell ${hand.name} what to change, or ↵ to carry on` : hand.status === "needs_you" ? `Answer ${hand.name}, or tell it what to do` : `Give ${hand.name} something else to do`;
  part(card, ".sheet").inert = !place.open;
}

/** Whether the card has a picture of its hand's window to show: the last good frame, even when the window has stopped drawing. */
const shown = (card: Card): boolean => card.url !== "";

/** A receipt's small picture: the frame in front, the same one the big picture shows. */
function mini(card: Card): void {
  const image = part<HTMLImageElement>(card, ".mini");
  const url = card.root.classList.contains("receipt") ? card.url : "";
  if (image.getAttribute("src") === (url || null)) return;
  if (url) image.src = url;
  else image.removeAttribute("src");
}

/** Keeps the picture honest about which window it is of (rules.ts, sight): a frame of a window the hand has left goes, and the task stands in its place. */
export function track(card: Card, hand: HandView): void {
  const next = sight(hand, card.of, shown(card));
  if (next === "of") card.of = hand.window;
  else if (next === "forget") forget(card);
}

/** The picture let go of: the card shows the task until the next frame comes. A frame still being decoded is of the old window too. */
function forget(card: Card): void {
  card.frame++;
  URL.revokeObjectURL(card.url);
  for (const image of card.frames) image.removeAttribute("src");
  card.url = "";
  card.ratio = null;
  card.of = undefined;
  mini(card);
}

/** The picture, or the task where it will be; a quiet word over the last good frame when the window is not drawing; and the hand, where it is. */
function picture(card: Card): void {
  const hand = card.view!;
  const has = shown(card);
  part(card, ".screen").hidden = !has;
  part(card, ".brief").hidden = has;
  // The word is about the frame under it, stepped back: with no frame yet, the task shows, and nothing covers it.
  const caption = part(card, ".caption");
  caption.hidden = !has || (hand.picture !== "blank" && hand.picture !== "minimized");
  put(caption, hand.picture === "minimized" ? "Minimized" : "Not drawing while out of sight");
  if (!card.ratio && hand.size) card.root.style.setProperty("--ratio", String(hand.size[0] / hand.size[1])); // until the first frame says otherwise
  const marker = part(card, ".marker");
  // The hand is placed in its window's own points: over another window's picture, it would point at nothing there.
  marker.hidden = !(has && hand.at && hand.size) || card.of !== hand.window;
  if (!hand.at || !hand.size) return;
  put(marker, hand.glyph);
  const [x, y] = TOUCH[hand.glyph] ?? [0.3, 0.1];
  marker.style.left = `${(100 * hand.at[0]) / hand.size[0]}%`;
  marker.style.top = `${(100 * hand.at[1]) / hand.size[1]}%`;
  marker.style.translate = `${-100 * x}% ${-100 * y}%`;
}

/**
 * A frame of the hand's window. It is decoded out of sight and then laid over the last one, fading in over it,
 * so the picture is never half drawn and never goes dark between frames. A window that changes shape snaps to
 * its new one. Resolves true when the picture's shape changed, which can change what fits in the column.
 */
export async function frame(card: Card, jpeg: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const count = ++card.frame;
  const url = URL.createObjectURL(new Blob([jpeg], { type: "image/jpeg" }));
  const [front, back] = card.frames as [HTMLImageElement, HTMLImageElement];
  back.src = url;
  try {
    await back.decode();
  } catch {
    URL.revokeObjectURL(url); // not a picture: the last one stays
    return false;
  }
  if (count !== card.frame || card.leaving) {
    URL.revokeObjectURL(url);
    return false;
  }
  const ratio = back.naturalWidth / back.naturalHeight;
  const reshaped = !card.ratio || Math.abs(ratio / card.ratio - 1) > 0.01;
  const first = !shown(card);
  card.ratio = ratio;
  if (reshaped) {
    card.root.style.setProperty("--shape", `${back.naturalWidth} / ${back.naturalHeight}`);
    card.root.style.setProperty("--ratio", String(ratio));
  }
  back.classList.add("front");
  front.classList.remove("front");
  const old = card.url;
  card.frames = [back, front];
  card.url = url;
  mini(card); // before the last frame is let go of
  if (first && card.view) picture(card);
  if (!reshaped) await back.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms(120), easing: "linear" }).finished.catch(() => {});
  URL.revokeObjectURL(old);
  return reshaped;
}

export const elapsed = (since: number, now = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** How a run's end reads in the transcript. */
const MARK: Record<Status, string> = { starting: "getting ready", working: "working", paused: "paused", needs_you: "needs you", done: "done", failed: "couldn’t finish", stopped: "stopped" };

/** What the hand said, as it would read: paragraphs, bullets and bold, built from text alone. */
function spoken(markdown: string): HTMLElement {
  const item = element("li", "said");
  for (const block of blocks(markdown)) {
    const line = element("p", block.kind === "p" ? "" : block.kind);
    if (block.marker) line.append(element("span", "bullet", block.marker));
    for (const run of block.runs) line.append(run.bold ? element("b", "", run.text) : document.createTextNode(run.text));
    item.append(line);
  }
  return item;
}

/** One line of a hand's sheet. A tool call reads as a verb and what it was done to, not as JSON. */
export function line(entry: LogEntry): HTMLElement {
  if (entry.kind === "task" || entry.kind === "steer") return element("li", "asked", entry.text);
  if (entry.kind === "say") return spoken(entry.text);
  if (entry.kind === "status") return element("li", "mark", MARK[entry.text as Status] ?? entry.text);
  if (entry.kind !== "tool") return element("li", entry.kind === "error" ? "got error" : "got", entry.text);
  const [verb = "", ...rest] = entry.text.split(" ");
  let detail = rest.join(" ");
  try {
    detail = Object.entries(JSON.parse(detail) as Record<string, unknown>).map(([key, value]) => (typeof value === "string" ? value : `${key} ${JSON.stringify(value)}`)).join("  "); // prettier-ignore
  } catch {} // cut short, or not JSON: as it came
  const made = element("li", "did");
  made.append(element("span", "verb", verb.replace(/_/g, " ")), detail);
  return made;
}

/** New lines on the sheet; a transcript scrolled to its end stays at its end. */
export function write(card: Card, entries: LogEntry[], reset = false): void {
  const log = part(card, ".log");
  const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  if (reset) log.replaceChildren();
  log.append(...entries.map(line));
  if (pinned) log.scrollTop = log.scrollHeight;
}

