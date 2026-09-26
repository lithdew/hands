/// <reference lib="dom" />
/**
 * The panel's page. A card per hand (card.ts), standing in a column in the bottom right corner of a window that is
 * otherwise not there; as they pile up (there can be eight) the cards that matter least fold down to their headers,
 * so the column always fits (fold.ts). Click a card for its sheet. Under the cards, the dock: the voice (dock.ts).
 * The orchestrator sends state, log lines, microphone levels and JPEG frames down one socket, and hears back how big
 * the column is, which cards show a picture (only those are filmed), and what the user asked of a hand.
 */

import { build, type Card, frame, fresh, paint, part, track, write } from "./card.ts";
import { extra, level, speak } from "./dock.ts";
import { arrange, finished, lines, order, type Shape } from "./fold.ts";
import { deal, glide, sweep, where } from "./motion.ts";
import { anew, busy, closes, elapsed, hold, neighbour, says, shortcut } from "./rules.ts";
import type { ClientMessage, HandView, LogEntry, ServerMessage } from "./state.ts";

const column = document.getElementById("column") as HTMLElement;
const deck = document.getElementById("deck") as HTMLElement;
const clear = document.getElementById("clear") as HTMLButtonElement;
const dock = document.getElementById("dock") as HTMLElement;
// On Windows the type is Windows' own, a hand is closed with Ctrl+W, and Show can bring its window forward (ui.css
// hides Show elsewhere).
const windows = /Windows/.test(navigator.userAgent);
document.documentElement.classList.toggle("windows", windows);
const KEYS = windows ? { close: "Ctrl+W", mod: "Ctrl" } : { close: "⌘W", mod: "⌘" };

// How many characters of a card's words fit on a line, counted short: across the card, and beside a receipt's picture.
const CARD_CHARS = 44;
const RECEIPT_CHARS = 28;

const cards = new Map<string, Card>();
const logs = new Map<string, LogEntry[]>();
let open: string | null = null;
let watching: string | null = null; // the hand watched big (theater), if any
let last: { hands: HandView[]; room: number } = { hands: [], room: 800 };

// ------------------------------------------------------------------ the socket

let socket: WebSocket | null = null;
let retry = 250;

/** Opened at the start, and again whenever it drops, a little later each time. */
function connect(): void {
  const made = new WebSocket(`ws://${location.host}/ws${location.search}`);
  made.binaryType = "arraybuffer";
  made.addEventListener("open", () => {
    retry = 250;
    reported = filmed = ""; // a new connection hears all of it again
    report();
  });
  made.addEventListener("message", receive);
  made.addEventListener("close", () => {
    if (socket !== made) return;
    socket = null;
    setTimeout(connect, retry);
    retry = Math.min(4000, retry * 2);
  });
  socket = made;
}

/** Says whether it went. */
function send(message: ClientMessage): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function receive({ data }: MessageEvent): void {
  if (typeof data !== "string") {
    // a frame: one byte of id length, the hand's id, then the JPEG
    const bytes = new Uint8Array(data as ArrayBuffer);
    const card = cards.get(new TextDecoder().decode(bytes.subarray(1, 1 + bytes[0]!)));
    if (!card) return;
    void frame(card, bytes.subarray(1 + bytes[0]!)).then((reshaped) => {
      if (reshaped) moving(update); // a picture of another shape can change what fits
    });
    return;
  }
  const message = JSON.parse(data) as ServerMessage;
  if (message.type === "level") return level(message.value);
  if (message.type === "log") return log(message.hand, message.entries, message.reset);
  column.hidden = false; // there is something to show from the first state on: the dock, at least
  moving(() => {
    speak(message.voice, message.hands, message.talkKey); // first: the dock's height is part of what the cards fit around
    show(message.hands, message.room);
  });
  if (message.focus && cards.has(message.focus)) toggle(message.focus, true); // the hand itself was clicked, out on the screen
}

// ------------------------------------------------------------------ the cards

/** A change to the column that may move cards up or down in a jump: they glide there instead. */
function moving(change: () => void): void {
  const from = where(deck.children as HTMLCollectionOf<HTMLElement>);
  change();
  glide(from);
}

function show(hands: HandView[], room: number): void {
  last = { hands, room };
  // New cards are made before old ones go, so no update ever finds a hand without its card.
  const dealt: Card[] = [];
  for (const hand of hands) {
    if (cards.has(hand.id)) continue;
    const card = build(hand.id, send, { toggle: (id) => toggle(id), watch }, KEYS);
    write(card, logs.get(hand.id) ?? [], true); // lines that came before the card did
    deck.append(card.root);
    cards.set(hand.id, card);
    dealt.push(card);
  }
  for (const [id, card] of cards) if (!hands.some((hand) => hand.id === id)) retire(card);
  update();
  // Several at once (at the start, or after a reconnect) come in turn, from the one by the dock up.
  dealt.sort((a, b) => Number(b.root.style.order) - Number(a.root.style.order));
  for (const [index, card] of dealt.entries()) deal(card.root, Math.min(index, 3) * 40);
}

/** A hand is gone: its card is swept off, and its sheet, if it was out, gives the keyboard back. */
function retire(card: Card): void {
  card.leaving = true;
  cards.delete(card.id);
  logs.delete(card.id);
  if (open === card.id) {
    open = null;
    send({ cmd: "focus", on: false });
  }
  if (watching === card.id) watching = null;
  void sweep(card.root).then(() => {
    URL.revokeObjectURL(card.url);
    report();
  });
}

/** Every card brought up to date, folded or not as the column has room, in the order they stand. */
function update(): void {
  const { hands, room } = last;
  const shapes = new Map<string, Shape>();
  for (const hand of hands) {
    const card = cards.get(hand.id);
    if (card) track(card, hand); // first: a picture of a window the hand has left may go, and change the card's shape
    // A picture's shape is the last frame's; before the first, the window's own, when the hand has one. A lookup has none.
    const ratio = hand.kind === "lookup" ? null : card?.url ? card.ratio : hand.size ? hand.size[0] / hand.size[1] : null;
    const said = says(hand);
    // A receipt's words stand beside its small picture, where fewer of them fit on a line.
    const chars = finished(hand.status) && card?.url ? RECEIPT_CHARS : CARD_CHARS;
    shapes.set(hand.id, { ratio, words: said !== "", lines: lines(said, chars), tally: (card?.steps.length ?? 0) > 0, sources: hand.kind === "lookup" && !!hand.sources?.length });
  }
  const layout = arrange(hands, shapes, room - extra(), open, watching);
  // Watched with no room for it even at its smallest: it is not watched after all.
  if (!layout.theater) watching = null;
  big = watching;
  // Crowded past folding: the column stops at the room and the cards scroll inside it, so the top ones stay reachable.
  column.style.setProperty("--room", `${room}px`);
  column.classList.toggle("over", layout.over);
  for (const [index, hand] of order(hands).entries()) {
    const card = cards.get(hand.id);
    if (!card) continue;
    const theater = hand.id === watching;
    card.root.style.order = String(index);
    paint(card, hand, { folded: !layout.unfolded.has(hand.id), bare: layout.bare.has(hand.id), open: hand.id === open, theater });
    card.root.style.setProperty("--log", `${layout.log}px`);
    card.root.style.setProperty("--tall", `${theater ? layout.theater : layout.picture}px`);
  }
  const over = hands.filter((hand) => finished(hand.status)).length;
  clear.hidden = over === 0;
  (clear.querySelector("b") as HTMLElement).textContent = String(over);
  film([...layout.unfolded]);
  report();
}

/**
 * Watch a hand big, or stop: its card widens to the left and its picture grows, filmed sharper and faster. Unlike a
 * sheet it takes no keyboard, so the user goes on in their own app while they watch; a sheet that was out goes.
 */
function watch(id: string): void {
  watching = watching === id ? null : id;
  if (watching && open) toggle(null);
  else moving(update);
}

/** Open a hand's sheet, which takes the keyboard for its box, or put it away, which gives the keyboard back. */
function toggle(id: string | null, on = open !== id): void {
  const next = on ? id : null;
  if (next === open) return;
  open = next;
  if (open) watching = null; // a sheet is the other way to see a hand larger: one at a time
  update();
  const card = open ? cards.get(open) : undefined;
  if (card) {
    const log = part(card, ".log");
    log.scrollTop = log.scrollHeight;
    part<HTMLInputElement>(card, "input").focus({ preventScroll: true }); // at once, as the sheet starts to open
  }
  send({ cmd: "focus", on: open !== null });
}

function log(hand: string, entries: LogEntry[], reset = false): void {
  const was = cards.get(hand);
  if (was && anew(entries, reset)) {
    // A new hand under a name whose card is still out (rules.ts, anew): that card goes, as it would have, and the
    // new hand's comes with the next state, starting from its task.
    retire(was);
    entries = entries.slice(entries.findIndex((entry) => entry.kind === "task"));
    reset = true;
  }
  logs.set(hand, [...(reset ? [] : (logs.get(hand) ?? [])), ...entries]);
  const card = cards.get(hand);
  if (card) write(card, entries, reset);
}

clear.addEventListener("click", () => send({ cmd: "clear" }));

document.addEventListener("keydown", (event) => {
  if (!open) return;
  const card = cards.get(open);
  if (event.key === "Escape") {
    // Put away at once: what the keyboard does gets no animation.
    event.preventDefault();
    card?.root.classList.add("instant");
    toggle(null);
    void card?.root.offsetHeight;
    card?.root.classList.remove("instant");
  } else if (closes(event, windows)) {
    // Close the hand, but only from an empty box: with words in it, the keys are the user's to edit with.
    // Ctrl+Backspace is never a close: in a text box it deletes a word.
    event.preventDefault();
    if (card && !part<HTMLInputElement>(card, "input").value) send({ cmd: "close", hand: card.id });
  } else {
    const key = shortcut(event, windows);
    if (!key || !card?.view) return;
    event.preventDefault();
    if (key === "hold") {
      // Pause a hand at work, or let a paused one carry on, as its buttons would (rules.ts, hold): a hand starting,
      // or a lookup, offers neither. The sheet stays out, and so does the keyboard.
      const cmd = hold(card.view);
      if (cmd) send({ cmd, hand: card.id });
      return;
    }
    const next = neighbour(order(last.hands).map((hand) => hand.id), card.id, key === "next" ? 1 : -1);
    if (next) toggle(next, true);
  }
});

// The clocks of the hands at work, and whether their pictures are still coming.
setInterval(() => {
  const now = performance.now();
  for (const card of cards.values()) {
    if (!card.view || !busy(card.view)) continue;
    part(card, "time").textContent = card.clock = elapsed(card.view.since);
    fresh(card, now);
  }
}, 1000);

// ------------------------------------------------------------------ what the orchestrator is told

let reported = "";
let measuring = 0;

/** Whether something in the column is on its way somewhere: a card coming or going, a fold, a glide. The endless ones do not count. */
const settling = (): boolean => column.getAnimations({ subtree: true }).some((running) => running.playState === "running" && running.effect?.getComputedTiming().iterations !== Infinity);

/**
 * How big the column is, in CSS pixels, and how many device pixels each of those is, whenever either changes;
 * nothing at all until there is something to show. Measured in a moment, so a burst of changes is said once, and
 * never on an animation frame: a window that is not showing gets none. It grows at once, and shrinks once the
 * column has come to rest, so a card folding away is not said twenty times on its way down.
 */
function report(): void {
  if (measuring) return;
  measuring = window.setTimeout(() => {
    measuring = 0;
    outline();
    const [width, height] = column.hidden ? [0, 0] : [column.offsetWidth, column.offsetHeight];
    const size = `${width}x${height}@${devicePixelRatio}`;
    if (size === reported) return;
    const [wide = 0, high = 0] = reported.split(/[x@]/).map(Number);
    if (width && (width < wide || height < high) && settling()) {
      measuring = window.setTimeout(() => {
        measuring = 0;
        report();
      }, 120);
      return;
    }
    if (send({ cmd: "size", width, height, dpr: devicePixelRatio })) reported = size;
  }, 0);
}
// The dock and the chip are watched as well as the column: the dock rests small by its own timer once the voice has
// stopped, and opens out under the pointer, often with the column's size unchanged, and where they are solid changes.
const resized = new ResizeObserver(report);
for (const one of [column, dock, clear]) resized.observe(one);
deck.addEventListener("scroll", report, { passive: true }); // a crowded column's cards move under the pointer
/** A move to a display of another scale, or a change of scale, is said too. */
function rescaled(): void {
  const scale = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
  scale.addEventListener("change", () => {
    report();
    rescaled();
  }, { once: true }); // prettier-ignore
}
rescaled();

let filmed = "";
let pictured: string[] = [];
let hot: string | null = null;
let big: string | null = null;

/**
 * The hands whose card shows its picture, the one under the pointer and the one watched big, when any of them
 * changes: only those are filmed, the last two first, and the one watched big sharper.
 */
function film(hands = pictured): void {
  pictured = hands;
  const said = `${[...hands].sort().join(" ")} ${hot} ${big}`;
  if (said !== filmed && send({ cmd: "visible", hands, hot, big })) filmed = said;
}

// The card under the pointer is the one being looked at: its picture comes four times a second.
deck.addEventListener("pointerover", (event) => {
  const id = (event.target as Element).closest<HTMLElement>(".card")?.dataset.id ?? null;
  if (id === hot) return;
  hot = id;
  film();
});
deck.addEventListener("pointerleave", () => {
  hot = null;
  film();
});

// ------------------------------------------------------------------ what the Windows panel is told

// In WebView2 the page takes the mouse over every pixel of its window, even where it shows nothing, so it tells its
// window where it is solid (src/panel.cs lets the mouse through everywhere else), over the web view's own channel.
const host = (window as { chrome?: { webview?: { postMessage(message: unknown): void } } }).chrome?.webview;
let solid = "";
let following = 0;

/**
 * The cards, the chip and the dock, each with its shadow, as rectangles in CSS pixels: sent when they change, and every
 * frame while they move. Cards scrolled out of a crowded column are cut to what shows of them.
 */
function outline(): void {
  if (!host) return;
  const scroll = column.classList.contains("over") ? deck.getBoundingClientRect() : null;
  const cut = (part: Element): { left: number; top: number; width: number; height: number } => {
    const box = part.getBoundingClientRect();
    if (!scroll || part.parentElement !== deck) return box;
    const [top, bottom] = [Math.max(box.top, scroll.top), Math.min(box.bottom, scroll.bottom)];
    return { left: box.left, top, width: box.width, height: Math.max(0, bottom - top) };
  };
  const parts = column.hidden ? [] : [...deck.children, clear, dock].filter((part) => !(part as HTMLElement).hidden).map(cut);
  const boxes = parts.filter((box) => box.width && box.height).map((box) => [Math.floor(box.left), Math.floor(box.top), Math.ceil(box.width) + 5, Math.ceil(box.height) + 5]);
  const said = JSON.stringify(boxes);
  if (said !== solid) host.postMessage({ solid: boxes, dpr: devicePixelRatio });
  solid = said;
  if (following || !settling()) return;
  following = requestAnimationFrame(() => {
    following = 0;
    outline();
  });
}

connect();
