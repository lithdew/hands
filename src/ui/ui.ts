/// <reference lib="dom" />
/**
 * The panel's page. A card per hand (card.ts), standing in a column in the bottom right corner of a window that is
 * otherwise not there; as they pile up (there can be eight) the cards that matter least fold down to their headers,
 * so the column always fits (fold.ts). Click a card for its sheet. Under the cards, the dock: the voice (dock.ts).
 * The orchestrator sends state, log lines, microphone levels and JPEG frames down one socket, and hears back how big
 * the column is, which cards show a picture (only those are filmed), and what the user asked of a hand.
 */

import { build, busy, type Card, elapsed, frame, paint, part, says, write } from "./card.ts";
import { extra, level, speak } from "./dock.ts";
import { arrange, finished, order, type Shape } from "./fold.ts";
import { deal, glide, sweep, where } from "./motion.ts";
import type { ClientMessage, HandView, LogEntry, ServerMessage } from "./state.ts";

const column = document.getElementById("column") as HTMLElement;
const deck = document.getElementById("deck") as HTMLElement;
const clear = document.getElementById("clear") as HTMLButtonElement;
// On Windows the type is Windows' own, and a hand is closed with Ctrl+W.
const windows = /Windows/.test(navigator.userAgent);
document.documentElement.classList.toggle("windows", windows);
const CLOSE_KEY = windows ? "Ctrl+W" : "⌘W";

const cards = new Map<string, Card>();
const logs = new Map<string, LogEntry[]>();
let open: string | null = null;
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
    const card = build(hand.id, send, (id) => toggle(id), CLOSE_KEY);
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
    shapes.set(hand.id, { ratio: card?.url ? card.ratio : null, words: says(hand) !== "" });
  }
  const layout = arrange(hands, shapes, room - extra(), open);
  for (const [index, hand] of order(hands).entries()) {
    const card = cards.get(hand.id);
    if (!card) continue;
    card.root.style.order = String(index);
    paint(card, hand, { folded: !layout.unfolded.has(hand.id), bare: layout.bare.has(hand.id), open: hand.id === open });
    card.root.style.setProperty("--log", `${layout.log}px`);
    card.root.style.setProperty("--tall", `${layout.picture}px`);
  }
  const over = hands.filter((hand) => finished(hand.status)).length;
  clear.hidden = over === 0;
  (clear.querySelector("b") as HTMLElement).textContent = String(over);
  film([...layout.unfolded]);
  report();
}

/** Open a hand's sheet, which takes the keyboard for its box, or put it away, which gives the keyboard back. */
function toggle(id: string | null, on = open !== id): void {
  const next = on ? id : null;
  if (next === open) return;
  open = next;
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
  } else if ((windows ? event.ctrlKey : event.metaKey) && !event.altKey && event.key.toLowerCase() === "w") {
    // Close the hand, but only from an empty box: with words in it, the keys are the user's to edit with.
    // Ctrl+Backspace is never a close: in a text box it deletes a word.
    event.preventDefault();
    if (card && !part<HTMLInputElement>(card, "input").value) send({ cmd: "close", hand: card.id });
  }
});

setInterval(() => {
  for (const card of cards.values()) if (card.view && busy(card.view)) part(card, "time").textContent = card.clock = elapsed(card.view.since);
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
new ResizeObserver(report).observe(column);
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

/** The hands whose card shows its picture, when that set changes: only they are filmed. */
function film(hands: string[]): void {
  const said = [...hands].sort().join(" ");
  if (said !== filmed && send({ cmd: "visible", hands })) filmed = said;
}

// ------------------------------------------------------------------ what the Windows panel is told

// In WebView2 the page takes the mouse over every pixel of its window, even where it shows nothing, so it tells its
// window where it is solid (src/panel.cs lets the mouse through everywhere else), over the web view's own channel.
const host = (window as { chrome?: { webview?: { postMessage(message: unknown): void } } }).chrome?.webview;
const dock = document.getElementById("dock") as HTMLElement;
let solid = "";
let following = 0;

/** The cards, the chip and the dock, each with its shadow, as rectangles in CSS pixels: sent when they change, and every frame while they move. */
function outline(): void {
  if (!host) return;
  const parts = column.hidden ? [] : [...deck.children, clear, dock].filter((part) => !(part as HTMLElement).hidden).map((part) => part.getBoundingClientRect());
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
