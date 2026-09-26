/// <reference lib="dom" />
/**
 * The dock: the voice. Yellow with your words while you hold the key and it thinks, the same two colours the other
 * way round while it answers, and only the dock is ever that yellow. Its hand's fingers rise with your voice (and
 * a ring around the dock spreads with it), drum while it thinks, and move while it speaks. Above the words, a line
 * when a hand has borrowed your mouse and keyboard or is waiting to, and a line when the voice has a problem. Once
 * you have spoken to it, it rests as a small palm in the corner until the key goes down again.
 */

import { identity } from "./card.ts";
import { settle } from "./motion.ts";
import type { HandView, VoiceView } from "./state.ts";

const dock = document.getElementById("dock") as HTMLElement;
const words = dock.querySelector(".words") as HTMLElement;
const banner = dock.querySelector(".banner") as HTMLElement;
const notice = dock.querySelector(".notice") as HTMLElement;
const fingers = [...dock.querySelectorAll<HTMLElement>(".palm i")];
const reduce = matchMedia("(prefers-reduced-motion: reduce)");

const LINGER_MS = 4000; // how long its last words stay up once it has stopped speaking, to be read to the end

type State = VoiceView["state"];
let state: State = "idle";
let spoken = false; // the key has been held once: the user knows it, and the idle dock can rest small
let lingering: { said: string; timer: ReturnType<typeof setTimeout> } | null = null;
let showing = ""; // what the words are now: the hint, or whose words, so a change of speaker is set down afresh
let last: [VoiceView, HandView[], string] | null = null;

/** The dock brought up to date: the voice's state and words, the seat, and any trouble. */
export function speak(voice: VoiceView, hands: HandView[], talkKey: string): void {
  last = [voice, hands, talkKey];
  const was = state;
  state = voice.state === "connecting" ? "listening" : voice.state;
  if (state === "listening" || state === "thinking" || state === "speaking") spoken = true;
  if (was === "speaking" && state === "idle" && voice.said.trim()) {
    if (lingering) clearTimeout(lingering.timer);
    const timer = setTimeout(() => {
      lingering = null;
      if (last) speak(...last);
    }, LINGER_MS);
    lingering = { said: voice.said.trim(), timer };
  } else if (state !== "idle" && lingering) {
    clearTimeout(lingering.timer);
    lingering = null;
  }

  const holder = hands.find((hand) => hand.seat === "holding") ?? hands.find((hand) => hand.seat === "waiting");
  banner.hidden = !holder;
  if (holder) {
    banner.dataset.seat = holder.seat;
    banner.style.setProperty("--glove", `#${holder.color}`);
    (banner.querySelector(".who") as HTMLElement).textContent = identity(holder.name);
    (banner.querySelector(".what") as HTMLElement).textContent = holder.seat === "holding" ? `${holder.name} is using your mouse and keyboard — move the mouse to take them back` : `${holder.name} is waiting for you to pause`;
  }
  const trouble = voice.notice.trim() || (state === "offline" ? "The voice is offline. Trying again…" : "");
  notice.hidden = !trouble;
  notice.textContent = trouble;

  const heard = voice.heard.trim();
  const said = voice.said.trim();
  if (state === "idle" && lingering) write("said", lingering.said);
  else if (state === "idle" || state === "offline") hint(talkKey, hands.length > 0);
  else if (state === "speaking") write("said", said || "…", !said);
  // Only while the key is held does it say "Listening…": the transcript trails the speech, and a dock still saying so after the key is up looks like one that has not let go.
  else write("heard", heard || (state === "listening" ? "Listening…" : "…"), !heard);

  const compact = spoken && state === "idle" && !lingering && banner.hidden && notice.hidden;
  dock.className = `${state === "idle" && lingering ? "idle lingering" : state}${compact ? " compact" : ""}`;
  // A long sentence keeps its newest words in sight, and its oldest line fades out at the top.
  words.scrollTop = words.scrollHeight;
  words.classList.toggle("long", words.scrollTop > 0);
  wake();
}

/** How much taller the dock is than its words make it: the seat's banner and the notice, when they show. The cards make room for them. */
export const extra = (): number => (banner.hidden ? 0 : banner.offsetHeight + 8) + (notice.hidden ? 0 : notice.offsetHeight + 9);

/** The words: one voice's, set down afresh when the speaker changes and simply replaced as a transcript grows. */
function write(whose: string, text: string, waiting = false): void {
  if (words.textContent !== text || words.firstElementChild) words.textContent = text;
  words.classList.toggle("waiting", waiting);
  if (showing !== whose) settle(words);
  showing = whose;
}

/** What the idle dock says: which key to hold, and what for. */
function hint(key: string, hands: boolean): void {
  const rest = hands ? " to steer, stop or ask" : " and ask for a hand";
  if (showing !== `hint ${key}${rest}`) {
    const cap = document.createElement("kbd");
    cap.textContent = key;
    words.replaceChildren("Hold ", cap, rest);
    if (!showing.startsWith("hint")) settle(words);
    showing = `hint ${key}${rest}`;
  }
  words.classList.remove("waiting");
}

// ------------------------------------------------------------------ the fingers

// Each finger is its full length and slides up out of the palm: how far it can, how much of the voice it takes,
// and how fast it rises and falls (unequal, so the five ripple instead of moving as one).
const REACH = [9, 13, 15, 13, 5];
const GAIN = [0.8, 1, 1.1, 0.95, 0.5];
const ATTACK_MS = [40, 25, 30, 45, 60];
const RELEASE_MS = [200, 170, 160, 190, 240];
const TALK_HZ = [2.7, 3.3, 4.1, 3.7, 2.3]; // while it speaks: its own level does not reach the page, so each finger keeps a rhythm of its own
const shown = [0, 0, 0, 0, 0];
let input = 0;
let frame = 0;
let then = 0;

/** How loud the microphone is this instant, 0 to 1, a dozen times a second while the key is held. */
export function level(value: number): void {
  input = Math.max(0, (value - 0.1) / 0.9); // below a tenth is the room, not a voice
  wake();
}

function wake(): void {
  if (!frame) frame = requestAnimationFrame(tick);
}

function tick(now: number): void {
  const dt = then ? Math.min(64, now - then) : 16;
  then = now;
  const scale = reduce.matches ? 0.5 : 1;
  let moving = state === "speaking";
  for (const [index, finger] of fingers.entries()) {
    const goal = state === "listening" ? Math.min(1, input * GAIN[index]!) : state === "speaking" ? 0.35 + 0.3 * Math.sin((now / 1000) * 2 * Math.PI * TALK_HZ[index]!) : 0;
    const was = shown[index]!;
    const next = was + (goal * scale - was) * (1 - Math.exp(-dt / (goal * scale > was ? ATTACK_MS[index]! : RELEASE_MS[index]!)));
    shown[index] = next;
    moving ||= Math.abs(goal * scale - next) > 0.002;
    const down = `${((1 - next) * REACH[index]!).toFixed(2)}px`;
    if (index === 4) finger.style.transform = `translateY(${down})`; // the thumb slides along its own slant
    else finger.style.translate = `0 ${down}`;
  }
  dock.style.setProperty("--ring", state === "listening" ? (shown.reduce((sum, one) => sum + one, 0) / shown.length).toFixed(3) : "0");
  frame = moving ? requestAnimationFrame(tick) : 0;
  if (!frame) then = 0;
}
