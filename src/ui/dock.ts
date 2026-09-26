/// <reference lib="dom" />
/**
 * The dock: the voice. Yellow with your words while you hold the key and it thinks, the same two colours the other
 * way round while it answers, and only the dock is ever that yellow. Its hand's fingers rise with your voice (and
 * a ring around the dock spreads with it), drum while it thinks, move while it speaks, and spring up once when a
 * hand has finished. Above the words, a line when a hand has borrowed your mouse and keyboard or is waiting to, and a
 * line when the voice has a problem. Once you have spoken to it, it rests as a small palm in the corner until the key
 * goes down again, counting the hands that need you. Typed to instead (ask.ts), it holds the box while it is out, then
 * shows your line as your words while its fingers drum, and then what came of it, for as long as that takes to read.
 */

import { identity } from "./card.ts";
import { settle } from "./motion.ts";
import { lingers } from "./rules.ts";
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
let done: Set<string> | null = null; // the hands that were done at the last word from the orchestrator
let cheer = -Infinity; // when one last finished

const CHEER_MS = 260; // how long the fingers are held up for a hand that has finished
const UNANSWERED_MS = 8000; // a typed line whose answer never came stops being shown after this long

let boxed = false; // the box is out (ask.ts): the dock is for typing
/** A line the user typed: shown as their words until what came of it is known (said), then that, and then it goes. */
let typed: { asked: string; said: string | null; timer: ReturnType<typeof setTimeout> } | null = null;

/** Whether the voice is at rest, so the dock can be typed to: not while it listens, thinks or speaks. */
export const resting = (): boolean => state === "idle" || state === "offline";

/** The box is out, or put away: while it is out the dock holds it, and whatever the dock was showing of a typed line goes. */
export function typing(on: boolean): void {
  boxed = on;
  if (on) forget();
  redraw();
}

/** A line was typed and sent (or could not be: `went` false), shown at once as the user's own words while it is read. */
export function asked(text: string, went: boolean): void {
  spoken = true; // the dock is known: it can rest small afterwards
  show(text, went ? null : "Not sent: hands is not answering. Try again in a moment.");
}

/** What came of a typed line, as the orchestrator says it: shown for as long as it takes to read. */
export function answered(text: string, said: string): void {
  show(text, said);
}

function show(text: string, said: string | null): void {
  forget();
  const timer = setTimeout(() => {
    typed = null;
    redraw();
  }, said === null ? UNANSWERED_MS : lingers(said));
  typed = { asked: text, said, timer };
  redraw();
}

function forget(): void {
  if (typed) clearTimeout(typed.timer);
  typed = null;
}

const redraw = (): void => {
  if (last) speak(...last);
};

/** The dock brought up to date: the voice's state and words, the seat, and any trouble. */
export function speak(voice: VoiceView, hands: HandView[], talkKey: string): void {
  last = [voice, hands, talkKey];
  const was = state;
  state = voice.state === "connecting" ? "listening" : voice.state;
  if (state === "listening" || state === "thinking" || state === "speaking") {
    spoken = true;
    forget(); // the voice has the dock now: a typed line's answer is not shown over it, nor after it
  }
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

  // Hands that need you are counted on the palm, even when it rests small, and named in the hint.
  const needy = hands.filter((hand) => hand.status === "needs_you");
  dock.dataset.needs = needy.length ? String(needy.length) : "";
  // A hand has just finished: the fingers spring up once, a cheer. Not for the ones already done when the page came.
  const over = hands.filter((hand) => hand.status === "done").map((hand) => hand.id);
  if (done && over.some((id) => !done!.has(id))) cheer = performance.now();
  done = new Set(over);

  const heard = voice.heard.trim();
  const said = voice.said.trim();
  const still = resting();
  // What the dock is showing of a typed line, when it is: the box, the line, or what came of it.
  const mode = !still ? "" : boxed ? "asking" : typed?.said === null ? "typed" : typed ? "answered" : "";
  if (mode === "typed") write("typed", typed!.asked, false, true);
  else if (mode === "answered") reply(typed!.asked, typed!.said!);
  else if (mode === "asking") showing = "asking"; // the box stands where the words were: they are set down afresh after it
  else if (state === "idle" && lingering) write("said", lingering.said);
  else if (still) hint(talkKey, hands.length > 0, needy[0]?.name);
  else if (state === "speaking") write("said", said || "…", !said);
  // Only while the key is held does it say "Listening…": the transcript trails the speech, and a dock still saying so after the key is up looks like one that has not let go.
  else write("heard", heard || (state === "listening" ? "Listening…" : "…"), !heard);

  const compact = spoken && state === "idle" && !lingering && !mode && banner.hidden && notice.hidden;
  const hinting = still && !mode && !(state === "idle" && lingering);
  dock.className = `${state === "idle" && lingering && !mode ? "idle lingering" : state}${mode ? ` ${mode}` : ""}${hinting ? " hint" : ""}${compact ? " compact" : ""}`;
  // A long sentence keeps its newest words in sight, and its oldest line fades out at the top. What came of a typed
  // line is read from its start.
  words.scrollTop = mode === "answered" ? 0 : words.scrollHeight;
  words.classList.toggle("long", words.scrollTop > 0);
  wake();
}

/** How much taller the dock is than its words make it: the seat's banner and the notice, when they show. The cards make room for them. */
export const extra = (): number => (banner.hidden ? 0 : banner.offsetHeight + 8) + (notice.hidden ? 0 : notice.offsetHeight + 9);

/**
 * The words: one voice's, set down afresh when the speaker changes and simply replaced as a transcript grows. A line
 * the user has just typed is there at once (`instant`): what the keyboard does is not animated.
 */
function write(whose: string, text: string, waiting = false, instant = false): void {
  if (words.textContent !== text || words.firstElementChild) words.textContent = text;
  words.classList.toggle("waiting", waiting);
  if (showing !== whose && !instant) settle(words);
  showing = whose;
}

/** What came of a typed line: the line itself, small, as what was asked, and under it the answer. */
function reply(text: string, said: string): void {
  const whose = `answer ${text}\n${said}`;
  if (showing === whose) return;
  const line = document.createElement("q");
  line.textContent = text;
  const answer = document.createElement("span");
  answer.className = "reply";
  answer.textContent = said;
  words.replaceChildren(line, answer);
  words.classList.remove("waiting");
  settle(words);
  showing = whose;
}

/** What the idle dock says: which key to hold, and what for; first, when one does, which hand needs you. */
function hint(key: string, hands: boolean, needs?: string): void {
  const lead = needs ? `${needs} needs you · Hold ` : "Hold ";
  const rest = needs ? " to answer" : hands ? " to steer, stop or ask" : " and ask for a hand";
  if (showing !== `hint ${lead}${key}${rest}`) {
    const cap = document.createElement("kbd");
    cap.textContent = key;
    words.replaceChildren(lead, cap, rest);
    if (!showing.startsWith("hint") || needs) settle(words);
    showing = `hint ${lead}${key}${rest}`;
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
  const cheering = now - cheer < CHEER_MS;
  let moving = state === "speaking" || cheering;
  for (const [index, finger] of fingers.entries()) {
    const voiced = state === "listening" ? Math.min(1, input * GAIN[index]!) : state === "speaking" ? 0.35 + 0.3 * Math.sin((now / 1000) * 2 * Math.PI * TALK_HZ[index]!) : 0;
    const goal = cheering ? Math.max(voiced, 0.9) : voiced;
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
