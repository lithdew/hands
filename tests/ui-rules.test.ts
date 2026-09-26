import { expect, test } from "bun:test";
import { anew, closes, type Press, says, sight } from "../src/ui/rules.ts";
import type { HandView } from "../src/ui/state.ts";

const view = (extra: Partial<HandView>): HandView => ({ id: "lefty", name: "Lefty", color: "4f8cff", task: "Book a table", status: "working", action: "", glyph: "👆", at: null, size: null, viewing: false, answer: "", reason: "", seat: "", seatWhy: "", picture: "none", since: 0, ...extra }); // prettier-ignore

test("a hand at work says what it is doing on its picture, not under it; the rest say what came of it", () => {
  expect(says(view({ action: "click “Search”" }))).toBe("");
  expect(says(view({ status: "starting" }))).toBe("");
  expect(says(view({ seat: "holding", seatWhy: "pressing ctrl+s" }))).toBe("Pressing ctrl+s with your mouse and keyboard.");
  expect(says(view({ status: "paused" }))).toBe("Paused. Tell it what to change, or let it carry on.");
  expect(says(view({ status: "needs_you", answer: "Sign in, then tell me to carry on." }))).toBe("Sign in, then tell me to carry on.");
  expect(says(view({ status: "failed", reason: "The page would not load." }))).toBe("The page would not load.");
  expect(says(view({ status: "done", answer: "Wrote the haiku:\n\nLunch waits" }))).toBe("Wrote the haiku:\nLunch waits");
  expect(says(view({ status: "stopped" }))).toBe("");
});

test("a task in lines for a card still out is a new hand under its name; the same task sent afresh on connecting is not", () => {
  expect(anew([{ kind: "task", text: "Book a table" }])).toBe(true);
  expect(anew([{ kind: "task", text: "Book a table" }], true)).toBe(false);
  expect(anew([{ kind: "steer", text: "for three" }])).toBe(false);
  expect(anew([{ kind: "tool", text: 'click {"index":4}' }, { kind: "result", text: "clicked" }])).toBe(false);
});

test("a live picture says which window the frames are of", () => {
  expect(sight({ picture: "live", window: 42 }, undefined, false)).toBe("of");
  expect(sight({ picture: "live", window: 42 }, 7, true)).toBe("of");
});

test("a frame of the window the hand has left goes when the new one has nothing to show, and not before", () => {
  // Moved to window 42, whose first capture came back blank (or minimized): window 7's frame is not 42's picture.
  expect(sight({ picture: "blank", window: 42 }, 7, true)).toBe("forget");
  expect(sight({ picture: "minimized", window: 42 }, 7, true)).toBe("forget");
  // Not filmed yet: the old frame stays the moment it takes, rather than the card jumping to the task and back.
  expect(sight({ picture: "none", window: 42 }, 7, true)).toBe("keep");
  // The same window stopped drawing: its last good frame stays, dimmed.
  expect(sight({ picture: "blank", window: 42 }, 42, true)).toBe("keep");
  // No frame to let go of.
  expect(sight({ picture: "blank", window: 42 }, 7, false)).toBe("keep");
  // An orchestrator that does not say which window: as before, the frame stays.
  expect(sight({ picture: "blank", window: undefined }, undefined, true)).toBe("keep");
});

const press = (key: string, code: string, keyCode: number, held: Partial<Press> = {}): Press => ({ key, code, keyCode, ctrlKey: false, metaKey: false, altKey: false, ...held });

test("Ctrl+W closes a hand on Windows, whatever the layout calls the W key", () => {
  expect(closes(press("w", "KeyW", 87, { ctrlKey: true }), true)).toBe(true);
  expect(closes(press("W", "KeyW", 87, { ctrlKey: true }), true)).toBe(true);
  expect(closes(press("ц", "KeyW", 87, { ctrlKey: true }), true)).toBe(true); // Russian
  expect(closes(press("ς", "KeyW", 87, { ctrlKey: true }), true)).toBe(true); // Greek
  expect(closes(press("'", "KeyW", 87, { ctrlKey: true }), true)).toBe(true); // Hebrew
  expect(closes(press("w", "KeyZ", 87, { ctrlKey: true }), true)).toBe(true); // AZERTY's W, where Z is on a US keyboard
});

test("Ctrl+W is not the key in W's place on a layout with a Latin letter or a sign there, nor AltGr, nor ⌘ on Windows", () => {
  expect(closes(press("z", "KeyW", 90, { ctrlKey: true }), true)).toBe(false); // AZERTY: Ctrl+Z is undo
  expect(closes(press(",", "KeyW", 188, { ctrlKey: true }), true)).toBe(false); // Dvorak
  expect(closes(press("w", "KeyW", 87, { ctrlKey: true, altKey: true }), true)).toBe(false); // AltGr is Ctrl+Alt
  expect(closes(press("w", "KeyW", 87, { metaKey: true }), true)).toBe(false);
  expect(closes(press("w", "KeyW", 87), true)).toBe(false);
});

test("⌘W closes a hand on the Mac, where a layout with no Latin letters falls back to W's place", () => {
  expect(closes(press("w", "KeyW", 87, { metaKey: true }), false)).toBe(true);
  expect(closes(press("ц", "KeyW", 0, { metaKey: true }), false)).toBe(true);
  expect(closes(press("z", "KeyW", 90, { metaKey: true }), false)).toBe(false);
  expect(closes(press("w", "KeyW", 87, { ctrlKey: true }), false)).toBe(false);
});
