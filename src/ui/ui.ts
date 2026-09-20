/// <reference lib="dom" />
/**
 * The panel's page. A card per hand, headed in its glove colour: a live picture of the window it is in with its hand
 * drawn over it, and what it is doing. As hands pile up (there can be eight) the cards that matter least fold down to
 * their headers, so the column always fits the screen. Click a card for its sheet: what it was asked, did and said,
 * and a box to tell it something. Under the cards, the dock: the voice, in large type, with a hand whose fingers move.
 * The orchestrator sends state, log lines, microphone levels and JPEG frames down one socket, and gets commands back.
 */

import type { ClientMessage, HandView, LogEntry, ServerMessage, Status, VoiceView } from "./state.ts";

const column = document.getElementById("column") as HTMLElement;
const deck = document.getElementById("deck") as HTMLElement;
const dock = document.getElementById("dock") as HTMLElement;
const words = dock.querySelector(".words") as HTMLElement;
const socket = new WebSocket(`ws://${location.host}/ws${location.search}`);
socket.binaryType = "arraybuffer";
const send = (message: ClientMessage) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
// On Windows the panel is a browser window with a page background of its own, and the key to hold is another.
const windows = /Windows/.test(navigator.userAgent);
document.documentElement.classList.toggle("windows", windows);
const KEY = windows ? "left Ctrl" : "right ⌥";

// How tall the pieces are, for deciding how many cards can stay unfolded. Measured off the stylesheet, give or take.
const [STRIP, GAP, ANSWER, FULL_EXTRA, SHEET_FIXED] = [46, 10, 44, 262, 154]; // a folded card, the space between, a folded card's answer, what unfolding adds, a sheet without its log
const STATUS: Record<Status, string> = { starting: "getting ready", working: "working", paused: "paused", done: "done", failed: "couldn’t finish", stopped: "stopped" };

interface Card {
  root: HTMLElement;
  view: HandView | null;
  picture: string; // the object URL the image shows, to be let go of when the next frame comes
  clock: string; // how long it has been at it, frozen when it stops
}
const cards = new Map<string, Card>();
const logs = new Map<string, LogEntry[]>();
let open: string | null = null;
let last: { hands: HandView[]; room: number } = { hands: [], room: 800 };

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text) made.textContent = text;
  return made;
};
const part = <T extends HTMLElement>(card: Card, selector: string) => card.root.querySelector(selector) as T;
const plain = (text: string) => text.replace(/\*\*/g, ""); // a hand answers in Markdown; a card does not render it

function build(id: string): Card {
  const root = element("article", "card dealt");
  root.innerHTML = `
    <header><span class="pose"></span><b class="name"></b><span class="doing"></span><span class="state"></span><time></time></header>
    <div class="view"><div class="screen"><img alt=""><span class="marker"></span></div><p class="brief"></p></div>
    <p class="now"></p>
    <div class="sheet" hidden>
      <ol class="log"></ol>
      <form><input type="text" autocomplete="off" spellcheck="false"><button class="send">Send</button></form>
      <div class="controls"><button type="button" data-cmd="pause"></button><button type="button" data-cmd="stop">Stop</button><button type="button" data-cmd="close">Close</button>
        <span class="keys"><kbd>↵</kbd> send <kbd>esc</kbd> back <kbd>${windows ? "Ctrl+W" : "⌘W"}</kbd> close</span></div>
    </div>`;
  const card: Card = { root, view: null, picture: "", clock: "" };
  for (const selector of ["header", ".view", ".now"]) part(card, selector).addEventListener("click", () => toggle(id));
  part<HTMLFormElement>(card, "form").addEventListener("submit", (event) => {
    event.preventDefault();
    const box = part<HTMLInputElement>(card, "input");
    // An empty line to a paused hand means: carry on.
    if (box.value.trim()) send({ cmd: "steer", hand: id, text: box.value.trim() });
    else if (card.view?.status === "paused") send({ cmd: "resume", hand: id });
    box.value = "";
  });
  for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-cmd]")) {
    button.addEventListener("click", () => {
      const cmd = button.dataset.cmd as "pause" | "stop" | "close";
      send({ cmd: cmd === "pause" && card.view?.status === "paused" ? "resume" : cmd, hand: id });
    });
  }
  for (const entry of logs.get(id) ?? []) part(card, ".log").append(line(entry)); // lines that came before the card did
  deck.append(root);
  return card;
}

/** Open a hand's sheet, which takes the keyboard for its box, or put it away, which gives the keyboard back. */
function toggle(id: string | null, on = open !== id): void {
  const next = on ? id : null;
  if (next === open) return;
  open = next;
  arrange();
  const card = open && cards.get(open);
  if (card) {
    const log = part(card, ".log");
    log.scrollTop = log.scrollHeight;
    part<HTMLInputElement>(card, "input").focus();
  }
  send({ cmd: "focus", on: open !== null });
}

/** What a card says about its hand under its picture: what it is doing, or what came of it. */
function doing(hand: HandView): string {
  if (hand.status === "starting") return "Getting ready";
  if (hand.status === "working") return hand.action || "Thinking";
  if (hand.status === "paused") return "Paused. Tell it what to change, or let it carry on.";
  return plain(hand.answer) || { done: "Done", failed: "Couldn’t finish", stopped: "Stopped" }[hand.status];
}
const finished = (hand: HandView) => hand.status === "done" || hand.status === "failed" || hand.status === "stopped";

const elapsed = (since: number): string => {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/**
 * Which cards stay unfolded. The open one, alone, while a sheet is out; otherwise as many as the screen has room for,
 * the hands at work first and the newest of the rest after them. Everything else is a header: name, colour, one line.
 */
function arrange(): void {
  const { hands, room } = last;
  const seen = hands.filter((hand) => !hand.viewing || hand.id === open); // a hand whose own window you are looking at needs no card
  // What is left once every card is folded (a finished one keeps its answer showing) and the dock has its place.
  const budget = room - dock.offsetHeight - GAP - seen.reduce((sum, hand) => sum + STRIP + GAP + (finished(hand) ? ANSWER : 0), 0);
  const rank = (hand: HandView) => (hand.status === "working" || hand.status === "starting" ? 0 : hand.status === "paused" ? 1 : 2);
  const wanted = [...seen].sort((a, b) => rank(a) - rank(b) || b.since - a.since).slice(0, Math.max(1, Math.floor(budget / FULL_EXTRA)));
  // An open card shares that between its picture and its log: the log gives way first, then the picture.
  const log = Math.min(236, Math.max(96, budget - SHEET_FIXED - 280));
  const tall = Math.min(280, Math.max(110, budget - SHEET_FIXED - log));
  for (const hand of hands) {
    const card = cards.get(hand.id)!;
    const isOpen = hand.id === open;
    card.root.hidden = !seen.includes(hand);
    card.root.classList.toggle("open", isOpen);
    card.root.classList.toggle("strip", open ? !isOpen : !wanted.includes(hand));
    card.root.classList.toggle("finished", finished(hand));
    part(card, ".sheet").hidden = !isOpen;
    part(card, ".log").style.maxHeight = `${log}px`;
    part(card, ".screen").style.setProperty("--tall", isOpen ? `${tall}px` : "");
  }
}

function show(hands: HandView[], room: number, focus: string | null): void {
  last = { hands, room };
  for (const [id, card] of cards) {
    if (hands.some((hand) => hand.id === id)) continue;
    URL.revokeObjectURL(card.picture);
    card.root.remove();
    cards.delete(id);
    logs.delete(id);
    if (open === id) toggle(null);
  }
  for (const hand of hands) {
    const card = cards.get(hand.id) ?? build(hand.id);
    cards.set(hand.id, card);
    card.view = hand;
    const active = hand.status === "working" || hand.status === "starting";
    if (active || !card.clock) card.clock = elapsed(hand.since);
    card.root.style.setProperty("--glove", `#${hand.color}`);
    card.root.classList.toggle("working", active);
    if (hand.size) {
      card.root.style.setProperty("--shape", `${hand.size[0]} / ${hand.size[1]}`);
      card.root.style.setProperty("--ratio", String(hand.size[0] / hand.size[1]));
    }
    part(card, ".pose").textContent = hand.glyph;
    part(card, ".name").textContent = hand.name;
    part(card, ".state").textContent = STATUS[hand.status];
    part(card, "time").textContent = card.clock;
    part(card, ".now").textContent = doing(hand);
    part(card, ".doing").textContent = hand.status === "working" ? hand.action || "thinking" : ""; // folded, the header says it; a finished hand's answer gets a line of its own
    part(card, ".brief").textContent = hand.task;
    part(card, ".brief").hidden = part(card, ".screen").hidden = false;
    part(card, hand.size ? ".brief" : ".screen").hidden = true; // until it has a window, the card shows what it was asked
    part(card, 'button[data-cmd="pause"]').textContent = hand.status === "paused" ? "Resume" : "Pause";
    part<HTMLInputElement>(card, "input").placeholder = active ? `Tell ${hand.name} what to change` : `Give ${hand.name} something else to do`;
    const marker = part(card, ".marker");
    marker.textContent = hand.glyph;
    marker.hidden = !(hand.at && hand.size);
    if (hand.at && hand.size) {
      marker.style.left = `${(100 * hand.at[0]) / hand.size[0]}%`;
      marker.style.top = `${(100 * hand.at[1]) / hand.size[1]}%`;
    }
  }
  arrange();
  if (focus && cards.has(focus)) toggle(focus, true); // the hand itself was clicked, out on the screen
}

/** One line of a hand's sheet. A tool call reads as a verb and what it was done to, not as JSON. */
function line(entry: LogEntry): HTMLElement {
  if (entry.kind === "task" || entry.kind === "steer") return element("li", "asked", entry.text);
  if (entry.kind === "say") return element("li", "said", plain(entry.text));
  if (entry.kind === "status") return element("li", "mark", STATUS[entry.text as Status] ?? entry.text);
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

function write(hand: string, entries: LogEntry[], reset = false): void {
  logs.set(hand, [...(reset ? [] : (logs.get(hand) ?? [])), ...entries]);
  const card = cards.get(hand);
  if (!card) return;
  const log = part(card, ".log");
  const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  if (reset) log.replaceChildren();
  log.append(...entries.map(line));
  if (pinned) log.scrollTop = log.scrollHeight;
}

/** The dock. Yellow with your words while you talk and it thinks; the same two colours the other way round while it answers. */
function speak({ state, heard, said }: VoiceView): void {
  const hint = last.hands.length ? `Hold ${KEY} to steer, stop or ask` : `Hold ${KEY} and ask for a hand`;
  const text = { idle: hint, connecting: heard, listening: heard, thinking: heard, speaking: said }[state].trim();
  dock.className = state === "connecting" ? "listening" : state;
  words.textContent = text || (state === "listening" || state === "connecting" ? "Listening…" : "…"); // only while the key is held: the transcript trails the speech, and a dock still saying "Listening…" after the key is up looks like one that has not let go
  words.classList.toggle("waiting", !text);
  if (state !== "listening" && state !== "connecting") dock.style.setProperty("--level", "0");
}

socket.addEventListener("message", ({ data }) => {
  if (typeof data !== "string") {
    // a frame: one byte of id length, the hand's id, then the JPEG
    const bytes = new Uint8Array(data as ArrayBuffer);
    const card = cards.get(new TextDecoder().decode(bytes.subarray(1, 1 + bytes[0]!)));
    if (!card) return;
    URL.revokeObjectURL(card.picture);
    card.picture = URL.createObjectURL(new Blob([bytes.subarray(1 + bytes[0]!)], { type: "image/jpeg" }));
    part<HTMLImageElement>(card, "img").src = card.picture;
    return;
  }
  const message = JSON.parse(data) as ServerMessage;
  if (message.type === "level") return dock.style.setProperty("--level", message.value.toFixed(2));
  if (message.type === "log") return write(message.hand, message.entries, message.reset);
  show(message.hands, message.room, message.focus);
  speak(message.voice);
});

document.addEventListener("keydown", (event) => {
  if (!open) return;
  if (event.key === "Escape") toggle(null);
  else if ((windows ? event.ctrlKey : event.metaKey) && (event.key === "w" || event.key === "Backspace")) {
    event.preventDefault();
    send({ cmd: "close", hand: open });
  }
});

setInterval(() => {
  for (const card of cards.values()) if (card.view && (card.view.status === "working" || card.view.status === "starting")) part(card, "time").textContent = card.clock = elapsed(card.view.since);
}, 1000);

// The window is cut to the page: tell the orchestrator how big the page is, at the start and whenever that changes.
const measure = () => {
  const { width, height } = column.getBoundingClientRect();
  send({ cmd: "size", width: Math.ceil(width), height: Math.ceil(height) });
};
new ResizeObserver(measure).observe(column);
socket.addEventListener("open", measure);
