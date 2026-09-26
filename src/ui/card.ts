/// <reference lib="dom" />
/**
 * A hand's card. Headed in its glove colour, with a glyph that is always that hand's own; under the header a
 * picture of the window it works in, with its hand drawn where the real one is and what it is doing as a subtitle;
 * under that, what came of it, or what it needs. Open, it has a sheet: what it was told, did and said, and a box to
 * tell it something. All that came from the hand, and so often from a web page, is set as text, never as HTML.
 */

import { finished } from "./fold.ts";
import { EASE_OUT, ms, settle, still } from "./motion.ts";
import { driver, moved, says, searching, sentence, type Step, sight, site, stale, steps, tally } from "./rules.ts";
import type { ClientMessage, HandView, LogEntry, Status } from "./state.ts";
import { blocks } from "./text.ts";

/** Who each hand is, whatever pose it strikes out on the screen. */
const IDENTITY: Record<string, string> = { lefty: "👈", righty: "👉", thumbs: "👍", pinky: "👌", index: "☝️", palm: "🖐️", knuckles: "✊", digit: "✌️" };
export const identity = (name: string): string => IDENTITY[name.toLowerCase()] ?? "✋";

/** Where each pose's glyph touches what it points at, as a fraction of its box (hand.ts's POSES), so the marker's fingertip is on the control. */
const TOUCH: Record<string, [number, number]> = { "👋": [0.45, 0.75], "👆": [0.28, 0.11], "✍️": [0.02, 0.81], "👇": [0.48, 0.82], "✌️": [0.45, 0.13], "🖐️": [0.4, 0.47], "👉": [0.74, 0.42], "✋": [0.37, 0.47], "👍": [0.36, 0.44] };

/** The word in a card's header. A hand at work has none: the ticks along the header, and its picture's subtitle, say it. */
const CHIP: Record<Status, string> = { starting: "starting", working: "", paused: "paused", needs_you: "needs you", done: "done", failed: "failed", stopped: "stopped" };

/** How the glyph in the header takes a change of state. It stays the hand's own glyph: only its motion says it. */
const REACT: Partial<Record<Status, Keyframe[]>> = {
  working: [{ rotate: "0deg" }, { rotate: "-14deg" }, { rotate: "10deg" }, { rotate: "0deg" }],
  done: [{ translate: "0 0" }, { translate: "0 -4px" }, { translate: "0 0" }, { translate: "0 -2px" }, { translate: "0 0" }],
  needs_you: [{ scale: 1 }, { scale: 1.18 }, { scale: 1 }],
  failed: [{ translate: "0 0" }, { translate: "-3px 0" }, { translate: "3px 0" }, { translate: "0 0" }],
};

/** What each state lets the user do, from the sheet and from the tools on the picture. */
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
  steps: Step[]; // its tool calls, from its transcript, as the header's ticks show them
  act: string; // the action it was last painted with, so each of Jev's moves is counted once
  taps: number | null; // how many presses its hand had made when last painted: each new one ripples (null: not painted yet)
  shotAt: number; // when the last frame came, on the page's clock: a picture that has not changed for a while says so
}

const TICKS = 24; // the most steps the header shows: the latest
const DOTS = ["4f8cff", "ff8a3d", "34c77b", "ff5ca8", "b07cff", "29c5d6", "9bd63a", "ff6b5c"]; // a source's letter sits on one of the cast's colours

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

/** The sheet's keys as the system names them: Ctrl on Windows, ⌘ on the Mac. */
export interface Keys {
  close: string;
  mod: string;
}

/** What a click on a card asks of the column: its sheet out or away, or its picture watched big or not. */
export interface Asks {
  toggle(id: string): void;
  watch(id: string): void;
}

export function build(id: string, act: (message: ClientMessage) => void, asks: Asks, keys: Keys): Card {
  const root = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  root.dataset.id = id;
  const card: Card = { id, root, view: null, frames: [...root.querySelectorAll<HTMLImageElement>(".screen img")], url: "", frame: 0, ratio: null, of: undefined, clock: "", leaving: false, steps: [], act: "", taps: null, shotAt: 0 };
  // The header and the words open the sheet; the picture is watched big, and its small copy on a receipt too.
  for (const selector of ["header", ".tell"]) part(card, selector).addEventListener("click", () => asks.toggle(id));
  part(card, ".fold").addEventListener("click", () => (shown(card) && card.view?.kind !== "lookup" ? asks.watch(id) : asks.toggle(id)));
  part(card, ".mini").addEventListener("click", (event) => {
    event.stopPropagation();
    asks.watch(id);
  });
  part(card, ".close-key").textContent = keys.close;
  part(card, ".move-key").textContent = `${keys.mod} ↑↓`;
  part(card, ".hold-key").textContent = `${keys.mod} .`;
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
      event.stopPropagation(); // the picture's tools are on the picture, which has a click of its own
      const cmd = button.dataset.cmd as "pause" | "resume" | "stop" | "show" | "close";
      act({ cmd, hand: id });
      if (cmd === "show" && !card.root.classList.contains("open")) brought(card);
    });
  }
  // A lookup's source opens in the user's own browser; the orchestrator opens only an address some card lists.
  part(card, ".sources").addEventListener("click", (event) => {
    const source = (event.target as Element).closest<HTMLButtonElement>("button[data-url]");
    if (!source) return;
    event.stopPropagation();
    act({ cmd: "open", url: source.dataset.url! });
  });
  // A hand that needs you is answered from its card: what the button says is said to it, as the box would.
  for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-say]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      act({ cmd: "steer", hand: id, text: button.dataset.say! });
    });
  }
  return card;
}

/** Show was pressed on the card: the picture nods, and a word on it says where the window went. */
function brought(card: Card): void {
  part(card, ".screen").animate([{ scale: 1 }, { scale: 1.03 }, { scale: 1 }], { duration: ms(220), easing: EASE_OUT });
  // A word, not a motion: it shows with reduced motion too. It fades inside the opaque picture, never at an edge.
  part(card, ".flash").animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: 1500 });
}

/** The card brought up to date with its hand. `folded`, `bare`, `open` and `theater` (watched big) are the column's say (fold.ts). */
export function paint(card: Card, hand: HandView, place: { folded: boolean; bare: boolean; open: boolean; theater: boolean }): void {
  const before = card.view;
  card.view = hand;
  const { root } = card;
  root.style.setProperty("--glove", `#${hand.color}`);
  root.dataset.status = hand.status;
  root.dataset.seat = hand.seat;
  root.dataset.picture = hand.picture;
  root.dataset.kind = hand.kind ?? "hand";
  root.classList.toggle("strip", place.folded);
  root.classList.toggle("open", place.open);
  root.classList.toggle("theater", place.theater);
  root.classList.toggle("viewed", hand.viewing && !place.open);
  if (busy(hand) || !card.clock) card.clock = elapsed(hand.since);

  // Jev drives while the clicker runs (a clicker call without its result), or while the action has Jev's name before it.
  const running = card.steps.at(-1);
  const clicking = running?.jev && running.ok === null ? running : undefined;
  const { jev: named, label } = driver(hand.action);
  const jev = hand.status === "working" && (named || !!clicking);
  if (jev && clicking && moved(card.act, hand.action)) {
    clicking.moves++;
    ticks(card);
  }
  card.act = hand.action;
  root.classList.toggle("jev", jev);
  part(card, ".chip.jev").hidden = !jev;
  put(part(card, ".chip.jev b"), clicking?.moves ? `· ${clicking.moves}` : "");

  put(part(card, ".who"), identity(hand.name));
  put(part(card, ".name"), hand.name);
  put(part(card, "time"), card.clock);
  put(part(card, ".doing"), hand.status === "working" ? (hand.kind === "lookup" ? searching(hand.action) : label || "thinking") : hand.status === "starting" ? hand.task : "");
  const chip = part(card, ".chip.state");
  const word = hand.seat === "holding" ? "using your mouse" : hand.seat === "waiting" ? "waiting for you" : CHIP[hand.status];
  if (put(chip, word) && before) settle(chip); // a status change, set down where the eye is
  chip.hidden = !word;
  // And the hand's own glyph reacts to it, once: hello to work, a nod when done, a start when it needs you.
  const react = before && before.status !== hand.status ? REACT[hand.status] : undefined;
  if (react) part(card, ".who").animate(react, { duration: ms(520), easing: EASE_OUT });

  const said = says(hand);
  put(part(card, ".said"), said);
  // Over, and unfolded: a receipt, its answer first and a small picture of its window beside it.
  const receipt = finished(hand.status) && !place.folded && !place.open && !place.theater;
  root.classList.toggle("receipt", receipt);
  root.classList.toggle("quiet", !(said || (receipt && (shown(card) || card.steps.length > 0))) || place.open || place.bare || (place.folded && busy(hand) && !hand.seat));
  put(part(card, ".tally"), card.steps.length ? tally(card.steps, card.clock) : "");
  sources(card, hand);
  put(part(card, ".brief"), hand.task);
  picture(card);
  mini(card);

  // The same table decides the sheet's buttons and the picture's tools. A lookup has no window, and is not paused.
  const allowed = CONTROLS[hand.status];
  for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-cmd]")) {
    const cmd = button.dataset.cmd!;
    button.hidden = !allowed.includes(cmd) || (cmd === "show" && !shown(card)) || (hand.kind === "lookup" && (cmd === "pause" || cmd === "resume"));
  }
  const box = part<HTMLInputElement>(card, "input");
  box.placeholder = busy(hand) ? `Tell ${hand.name} what to change` : hand.status === "paused" ? `Tell ${hand.name} what to change, or ↵ to carry on` : hand.status === "needs_you" ? `Answer ${hand.name}, or tell it what to do` : `Give ${hand.name} something else to do`;
  part(card, ".sheet").inert = !place.open;
}

/**
 * A finished lookup's sources, a chip for each site: its letter and its name, the page's title on hover. A site it
 * read more than one page of has one chip, which opens the first, and says how many more there were.
 */
function sources(card: Card, hand: HandView): void {
  const row = part(card, ".sources");
  const list = hand.kind === "lookup" && finished(hand.status) ? (hand.sources ?? []) : [];
  const said = list.map((source) => source.url).join(" ");
  if (row.dataset.said === said) return;
  row.dataset.said = said;
  const sites = new Map<string, { url: string; title: string; letter: string; more: number }>();
  for (const source of list) {
    const { letter, name } = site(source.url);
    const seen = sites.get(name);
    if (seen) seen.more++;
    else sites.set(name, { url: source.url, title: source.title || source.url, letter, more: 0 });
  }
  row.replaceChildren(
    ...[...sites].map(([name, { url, title, letter, more }]) => {
      const chip = element("button", "source");
      chip.type = "button";
      chip.dataset.url = url;
      chip.title = title;
      chip.style.setProperty("--dot", `#${DOTS[letter.charCodeAt(0) % DOTS.length]}`);
      chip.append(element("i", "", letter), element("span", "", more ? `${name} +${more}` : name));
      return chip;
    }),
  );
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
  for (const crumb of card.root.querySelectorAll<HTMLElement>(".crumb")) {
    crumb.hidden = true; // where it clicked in the last window says nothing of the next
    crumb.style.left = crumb.style.top = "";
  }
  mini(card);
}

/** The picture, or the task where it will be; a quiet word over the last good frame when the window is not drawing; and the hand, where it is. */
function picture(card: Card): void {
  const hand = card.view!;
  const has = shown(card);
  card.root.classList.toggle("pictured", has);
  part(card, ".screen").hidden = !has;
  part(card, ".brief").hidden = has;
  // The word is about the frame under it, stepped back: with no frame yet, the task shows, and nothing covers it.
  const caption = part(card, ".caption");
  caption.hidden = !has || (hand.picture !== "blank" && hand.picture !== "minimized");
  put(caption, hand.picture === "minimized" ? "Minimized" : "Not drawing while out of sight");
  // What it is doing, as a subtitle on the picture, or under the task until the picture comes; a lookup, which has
  // no picture, says what it is searching for.
  const subtitle = part(card, ".subtitle");
  subtitle.hidden = hand.status !== "working";
  subtitle.dataset.glyph = hand.glyph;
  const doing = hand.kind === "lookup" ? searching(hand.action) : sentence(driver(hand.action).label || "thinking");
  if (put(subtitle, doing) && !subtitle.hidden) settle(subtitle);
  if (!card.ratio && hand.size) card.root.style.setProperty("--ratio", String(hand.size[0] / hand.size[1])); // until the first frame says otherwise
  // A beating dot while frames come; with none for a while it goes grey and says how long (ui.ts, stale).
  part(card, ".live").hidden = !(has && busy(hand) && hand.picture === "live");
  const marker = part(card, ".marker");
  // The hand is placed in its window's own points: over another window's picture, it would point at nothing there.
  marker.hidden = !(has && hand.at && hand.size) || card.of !== hand.window;
  const [taps, tapped] = [hand.taps ?? 0, card.taps];
  card.taps = taps;
  if (!hand.at || !hand.size) return;
  put(marker, hand.glyph);
  // It strikes the pose the real one does, and glides as long as the real one takes, so both land together.
  marker.dataset.pose = hand.pose ?? "";
  marker.style.transitionDuration = `${ms(hand.glide || 80)}ms`;
  const [x, y] = TOUCH[hand.glyph] ?? [0.3, 0.1];
  marker.style.left = `${(100 * hand.at[0]) / hand.size[0]}%`;
  marker.style.top = `${(100 * hand.at[1]) / hand.size[1]}%`;
  marker.style.translate = `${-100 * x}% ${-100 * y}%`;
  if (tapped !== null && taps > tapped && !marker.hidden) tap(card, marker);
}

/**
 * A press: the hand in the picture dips, a ring leaves its fingertip, and the spot stays marked, the last three
 * fainter each time, so a picture that comes once a second still shows where it has been clicking.
 */
function tap(card: Card, marker: HTMLElement): void {
  const [ring, ...crumbs] = [part(card, ".tap"), ...card.root.querySelectorAll<HTMLElement>(".crumb")];
  for (let index = crumbs.length - 1; index > 0; index--) {
    [crumbs[index]!.style.left, crumbs[index]!.style.top] = [crumbs[index - 1]!.style.left, crumbs[index - 1]!.style.top];
  }
  for (const spot of [ring!, crumbs[0]!]) [spot.style.left, spot.style.top] = [marker.style.left, marker.style.top];
  for (const crumb of crumbs) crumb.hidden = !crumb.style.left;
  marker.animate([{ scale: 1 }, { scale: 0.8 }, { scale: 1 }], { duration: ms(200), easing: EASE_OUT, composite: "add" });
  // With less motion asked for, the ring does not grow: it shows a moment where the press was, and goes.
  ring!.animate([{ scale: 0.3, opacity: 0.9 }, { scale: 1.7, opacity: 0 }], still() ? { duration: 150, easing: "steps(1, end)" } : { duration: 420, easing: EASE_OUT });
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
  card.shotAt = performance.now();
  mini(card); // before the last frame is let go of
  fresh(card, card.shotAt);
  if (first && card.view) picture(card);
  if (!reshaped) await back.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms(120), easing: "linear" }).finished.catch(() => {});
  URL.revokeObjectURL(old);
  return reshaped;
}

/** The live dot: it beats as a frame comes, and goes grey, saying how long ago, when frames stop coming (rules.ts, stale). */
export function fresh(card: Card, now = performance.now()): void {
  const live = part(card, ".live");
  const late = stale(now, card.shotAt);
  live.classList.toggle("stale", late !== "");
  put(part(card, ".live b"), late || "LIVE");
  if (!late && now === card.shotAt && !live.hidden) part(card, ".live i").animate([{ scale: 1.8 }, { scale: 1 }], { duration: ms(260), easing: EASE_OUT });
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

/** New lines on the sheet, and the steps they make in the header; a transcript scrolled to its end stays at its end. */
export function write(card: Card, entries: LogEntry[], reset = false): void {
  const log = part(card, ".log");
  const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  if (reset) log.replaceChildren();
  log.append(...entries.map(line));
  if (pinned) log.scrollTop = log.scrollHeight;
  card.steps = steps(entries, reset ? [] : card.steps);
  ticks(card);
}

/**
 * The ticks along the foot of the header, a step each, the latest last: done, gone wrong, or still running; Jev's
 * striped, and wider with each of its moves. The same elements are kept and only their class changes, so a new
 * step is the only one that grows in.
 */
function ticks(card: Card): void {
  const row = part(card, ".ticks");
  const latest = card.steps.slice(-TICKS);
  while (row.children.length < latest.length) row.append(element("i"));
  while (row.children.length > latest.length) row.lastElementChild!.remove();
  for (const [index, step] of latest.entries()) {
    const tick = row.children[index] as HTMLElement;
    const name = `${step.ok === null ? "run" : step.ok ? "ok" : "err"}${step.jev ? " jev" : ""}`;
    if (tick.className !== name) tick.className = name;
    if (step.jev) tick.style.setProperty("--moves", String(Math.min(step.moves, 10)));
    else tick.style.removeProperty("--moves");
  }
}

