/// <reference lib="dom" />
/**
 * The dock's box: type to the hands instead of talking. A click on the dock at rest, or on its palm rested small,
 * brings the box out and gives it the keyboard; nothing else does, so it never takes the keyboard from the user's app
 * by itself. Enter sends the line and puts the box away, Esc puts it away unsent, and a click anywhere else (on a card,
 * or in another app) puts it away too: each time the keyboard goes back to the app the user was in. What the line comes
 * to is Jev's reading of it, on the orchestrator's side (src/intent.ts); the dock shows it at once as the user's words,
 * then what came of it (dock.ts). Nothing the keyboard does here is animated.
 */

import { asked, resting, typing } from "./dock.ts";
import type { ClientMessage } from "./state.ts";

const dock = document.getElementById("dock") as HTMLElement;
const box = dock.querySelector(".box") as HTMLFormElement;
const input = box.querySelector("input") as HTMLInputElement;

/** What the box needs of the page around it: the socket, and the keyboard, which a card's sheet may have. */
export interface Hooks {
  send(message: ClientMessage): boolean;
  /** Take the keyboard, or give it back, as the page's sheets and box now need. */
  keyboard(): void;
  /** Put away a sheet that is out, keeping the keyboard: the box has it next. */
  sheet(): void;
}

let hooks: Hooks | null = null;

export function wire(given: Hooks): void {
  hooks = given;
}

/** Whether the box is out. */
export const out = (): boolean => !box.hidden;

/**
 * Out, at a click on the dock: a sheet that was out goes, and the keyboard comes to the box. The orchestrator is told
 * with an empty line, so that Jev's connection is open by the time the line is sent (src/live.ts ask).
 */
function open(): void {
  if (out() || !resting() || !hooks) return;
  box.hidden = false; // first: the sheet goes with the box out, so the keyboard is not given back between them
  hooks.sheet();
  typing(true);
  input.focus({ preventScroll: true }); // at once: the window takes the keyboard as it comes (panel.cs), and gives it here
  hooks.keyboard();
  hooks.send({ cmd: "ask", text: "" });
}

/** Away, and what was in it with it. `quietly`: a sheet takes the keyboard next, so it is not given back first. */
export function shut(quietly = false): void {
  if (!out()) return;
  box.hidden = true;
  input.value = "";
  typing(false);
  if (!quietly) hooks?.keyboard();
}

box.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  shut();
  if (text) asked(text, hooks?.send({ cmd: "ask", text }) ?? false);
});
input.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  shut();
});
// The dock opens the box, and a click on it with the box out (on the palm, say) gives the box back its caret; a click
// anywhere else puts it away. A click that opens a sheet has put it away already.
dock.addEventListener("click", (event) => {
  if (box.contains(event.target as Node)) return;
  if (out()) input.focus({ preventScroll: true });
  else open();
});
document.addEventListener("click", (event) => {
  if (out() && !dock.contains(event.target as Node)) shut();
});
window.addEventListener("blur", () => shut()); // the user went to another app: the keyboard is theirs already
