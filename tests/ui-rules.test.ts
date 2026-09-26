import { expect, test } from "bun:test";
import { anew, closes, driver, moved, type Press, STALE_MS, says, searching, sight, site, stale, steps, tally } from "../src/ui/rules.ts";
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

test("a step for each tool call, settled by its result; the clicker's are Jev's, and fail when its goal was not reached", () => {
  const made = steps([
    { kind: "task", text: "Book a table" },
    { kind: "tool", text: 'click {"index":4}' },
    { kind: "result", text: "clicked" },
    { kind: "tool", text: 'type {"text":"Dishoom"}' },
    { kind: "error", text: "no such field" },
    { kind: "say", text: "Trying the clicker." },
    { kind: "tool", text: 'clicker {"goal":"choose 21 September"}' },
  ]);
  expect(made).toEqual([
    { ok: true, jev: false, moves: 0 },
    { ok: false, jev: false, moves: 0 },
    { ok: null, jev: true, moves: 0 },
  ]);
  // Lines that come later settle what is running, into the same steps.
  steps([{ kind: "result", text: '{ "outcome": "stopped: not sure", "goal_achieved": false, "answer": null }' }], made);
  expect(made[2]!.ok).toBe(false);
  expect(steps([{ kind: "tool", text: 'clicker {"goal":"x"}' }, { kind: "result", text: '{ "outcome": "done", "goal_achieved": true }' }])[0]!.ok).toBe(true);
  // A result with no call waiting for it changes nothing.
  expect(steps([{ kind: "result", text: "stray" }])).toEqual([]);
});

test("a receipt's tally counts each of Jev's moves as a step of its own, and the time it took", () => {
  const all = [
    { ok: true, jev: false, moves: 0 },
    { ok: true, jev: true, moves: 5 },
    { ok: false, jev: false, moves: 0 },
    { ok: true, jev: true, moves: 0 }, // a clicker call whose moves were not seen still counts as one
  ];
  expect(tally(all, "0:52")).toBe("8 steps · 6 by Jev · 0:52");
  expect(tally([{ ok: true, jev: false, moves: 0 }], "0:07")).toBe("1 step · 0:07");
  expect(tally([], "0:07")).toBe("0:07");
});

test("Jev's moves are told by its name before the action, and counted once each, never its rests", () => {
  expect(driver("Jev › click “Next”")).toEqual({ jev: true, label: "click “Next”" });
  expect(driver("Jev > typing “ramen”")).toEqual({ jev: true, label: "typing “ramen”" });
  expect(driver("click “Next”")).toEqual({ jev: false, label: "click “Next”" });
  expect(moved("clicker: “choose 21 September”", "Jev › click “September”")).toBe(true);
  expect(moved("Jev › click “September”", "Jev › thinking")).toBe(false);
  expect(moved("Jev › thinking", "Jev › click “September”")).toBe(true); // the same click again, after a rest, is another move
  expect(moved("Jev › click “21”", "Jev › click “21”")).toBe(false);
  expect(moved("click “21”", "Jev › click “21”")).toBe(false);
  expect(moved("thinking", "Jev › looking")).toBe(false);
  expect(moved("thinking", "Jev › clicker: “x”")).toBe(false);
  expect(moved("thinking", "")).toBe(false);
});

test("a live picture says nothing while frames come, and how long ago the last one was once they stop", () => {
  expect(stale(10_000, 9_000)).toBe("");
  expect(stale(10_000, 10_000 - STALE_MS)).toBe("");
  expect(stale(10_000, 5_500)).toBe("4s ago");
  expect(stale(200_000, 60_000)).toBe("2m ago");
});

test("a lookup says what it is searching for, in the words its action gives", () => {
  expect(searching("searching 'best ramen near King's Cross'")).toBe("Searching “best ramen near King's Cross”");
  expect(searching("searching “tate modern hours”")).toBe("Searching “tate modern hours”");
  expect(searching("reading 3 pages")).toBe("Reading 3 pages");
  expect(searching("")).toBe("Searching the web");
});

test("a source's chip names its site as a reader would, with the letter of its own name", () => {
  expect(site("https://www.tate.org.uk/visit/tate-modern")).toEqual({ letter: "T", name: "tate.org.uk" });
  expect(site("https://en.wikipedia.org/wiki/Tate_Modern")).toEqual({ letter: "W", name: "en.wikipedia.org" });
  expect(site("https://www.bbc.co.uk/news")).toEqual({ letter: "B", name: "bbc.co.uk" });
  expect(site("http://localhost:3000/a")).toEqual({ letter: "L", name: "localhost" });
  expect(site("https://a-very-long-subdomain.of-a-long-site.example.com/")).toEqual({ letter: "E", name: "a-very-long-subdomain.of-…" });
  expect(site("not a url").letter).toBe("?");
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
