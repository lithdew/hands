/// <reference lib="dom" />
/**
 * The dock's box: type to the hands instead of talking. A click on the dock at rest, or on its palm rested small,
 * brings the box out and gives it the keyboard; nothing else does, so it never takes the keyboard from the user's app
 * by itself, and it does not come out while a hand has the mouse and keyboard or waits to take them. Enter sends the
 * line and puts the box away, Esc puts it away unsent, and a click elsewhere in the panel (on a card) puts it away too:
 * each time the keyboard goes back to the app the user was in.
 *
 * The window losing the foreground does not put the box away, as it does not put a card's sheet away: a hand's click
 * into its browser window takes the foreground for a moment, a borrow of the mouse and keyboard for longer, and each
 * hands it back to the panel, whose focus goes on into the page (panel.cs, WM_SETFOCUS), where the box must still be,
 * with what was typed in it. A user who went to another app finds the box as they left it, and a click on it goes on.
 *
 * What the line comes to is Jev's reading of it, on the orchestrator's side (src/intent.ts); the dock shows it at once
 * as the user's words, then what came of it (dock.ts). Nothing the keyboard does here is animated.
 */

import { asked, resting, seated, typing } from "./dock.ts";
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

// Jev's connection, once opened, stayed open for a minute with nothing sent (measured: a reading 45 or 60 s later took
// 300 to 350 ms, as one a second later did; 90 or 120 s later, 400 to 480 ms, as on a new connection).
const WARM_MS = 45_000;
let warmed = -Infinity; // when the orchestrator was last told the box is in use

/**
 * Tell the orchestrator, with an empty line, that a line is coming, so that Jev's connection is open by the time it is
 * sent (src/live.ts ask): as the box comes out, and again as the user types into a box that has been out long enough
 * for the connection to have closed (the box stays out while the user is in another app).
 */
function warm(): void {
  if (!hooks || performance.now() - warmed < WARM_MS) return;
  warmed = performance.now();
  hooks.send({ cmd: "ask", text: "" });
}

/** Out, at a click on the dock: a sheet that was out goes, and the keyboard comes to the box. */
function open(): void {
  if (out() || !resting() || seated() || !hooks) return;
  box.hidden = false; // first: the sheet goes with the box out, so the keyboard is not given back between them
  hooks.sheet();
  typing(true);
  input.focus({ preventScroll: true }); // at once: the window takes the keyboard as it comes (panel.cs), and gives it here
  hooks.keyboard();
  warm();
}

/** Away, and what was in it with it. `quietly`: a sheet takes the keyboard next, so it is not given back first. */
export function shut(quietly = false): void {
  if (!out()) return;
  box.hidden = true;
  input.value = "";
  typing(false);
  if (!quietly) hooks?.keyboard();
}

/** What the keys did to the dock, done at once: a dock resting small again after Esc does not animate its way there. */
function instantly(change: () => void): void {
  dock.dataset.instant = "";
  change();
  void dock.offsetHeight;
  delete dock.dataset.instant;
}

box.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  instantly(() => {
    shut();
    if (text) asked(text, hooks?.send({ cmd: "ask", text }) ?? false);
  });
});
input.addEventListener("input", warm);
input.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  instantly(() => shut());
});
// The dock opens the box, and a click on it with the box out (on the palm, say) gives the box back its caret; a click
// anywhere else in the panel puts it away. A click that opens a sheet has put it away already.
dock.addEventListener("click", (event) => {
  if (box.contains(event.target as Node)) return;
  if (out()) input.focus({ preventScroll: true });
  else open();
});
document.addEventListener("click", (event) => {
  if (out() && !dock.contains(event.target as Node)) shut();
});
