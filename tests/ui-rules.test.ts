import { expect, test } from "bun:test";
import { anew, clock, closes, controls, driver, hold, moved, neighbour, type Press, recount, STALE_MS, says, searching, shortcut, sight, site, stale, steps, tally } from "../src/ui/rules.ts";
import type { HandView } from "../src/ui/state.ts";

const view = (extra: Partial<HandView>): HandView => ({ id: "lefty", name: "Lefty", color: "4f8cff", task: "Book a table", status: "working", action: "", glyph: "👆", at: null, size: null, viewing: false, answer: "", reason: "", seat: "", seatWhy: "", picture: "none", since: 0, ...extra }); // prettier-ignore

test("a hand at work says what it is doing on its picture, not under it; the rest say what came of it", () => {
  expect(says(view({ action: "click “Search”" }))).toBe("");
  expect(says(view({ status: "starting" }))).toBe("");
  expect(says(view({ seat: "holding", seatWhy: "pressing ctrl+s" }))).toBe("Pressing ctrl+s with your mouse and keyboard — move the mouse to take them back.");
  expect(says(view({ seat: "holding" }))).toBe("Using your mouse and keyboard — move the mouse to take them back.");
  expect(says(view({ seat: "waiting", seatWhy: "pressing ctrl+s" }))).toBe("Waiting for you to pause a second, before pressing ctrl+s.");
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

test("in a batch run at once, a result that names its call settles that call, whatever order they finish in", () => {
  // pi-agent-core starts every call of a parallel batch, then ends each as it finishes: here the read first.
  const batch = [
    { kind: "tool", text: 'bash {"command":"make"}', call: "a" },
    { kind: "tool", text: 'read {"path":"notes.md"}', call: "b" },
    { kind: "result", text: "# notes", call: "b" },
    { kind: "error", text: "make: *** no rule", call: "a" },
  ] as const;
  expect(steps([...batch]).map((step) => step.ok)).toEqual([false, true]);
  // Without the ids, results go to the oldest call still running: the count of good and bad is right, not their places.
  const unnamed = steps(batch.map(({ kind, text }) => ({ kind, text })));
  expect(unnamed.map((step) => step.ok)).toEqual([true, false]);
  // A result naming a call no step has falls back to the oldest still running.
  expect(steps([{ kind: "tool", text: "screen {}" }, { kind: "result", text: "ok", call: "z" }])[0]!.ok).toBe(true);
});

test("a clicker result's count of Jev's moves is the count; a transcript sent afresh keeps the moves the page counted", () => {
  const made = steps([{ kind: "tool", text: 'clicker {"goal":"x"}', call: "c" }]);
  made[0]!.moves = 3; // counted by the page as the moves came
  steps([{ kind: "result", text: '{ "outcome": "done", "goal_achieved": true }', call: "c", moves: 9 }], made);
  expect(made[0]).toEqual({ ok: true, jev: true, moves: 9, call: "c" });
  // On connecting afresh the transcript comes again from its start, without the moves the page counted.
  const log = [
    { kind: "tool", text: "screen {}" },
    { kind: "result", text: "ok" },
    { kind: "tool", text: 'clicker {"goal":"x"}' },
    { kind: "result", text: '{ "outcome": "done", "goal_achieved": true }' },
    { kind: "tool", text: 'clicker {"goal":"y"}' },
  ] as const;
  const before = steps([...log]);
  [before[1]!.moves, before[2]!.moves] = [9, 4];
  const again = recount(before, steps([...log]));
  expect(again.map((step) => step.moves)).toEqual([0, 9, 4]);
  expect(tally(again, "0:52")).toBe("14 steps · 13 by Jev · 0:52");
  // A count the transcript gives stands; a step that was not Jev's in that place gives none.
  expect(recount(before, steps([...log.slice(0, 3), { kind: "result", text: "{}", moves: 7 }]))[1]!.moves).toBe(7);
  expect(recount([{ ok: true, jev: false, moves: 5 }], steps([{ kind: "tool", text: 'clicker {"goal":"x"}' }]))[0]!.moves).toBe(0);
});

test("the sheet's buttons, the picture's tools and Ctrl+. follow one table: a starting hand and a lookup never pause", () => {
  expect(controls({ status: "working" })).toEqual(["pause", "stop", "show"]);
  expect(controls({ status: "working", kind: "lookup" })).toEqual(["stop", "show"]);
  expect(controls({ status: "starting" })).toEqual(["stop"]);
  expect(controls({ status: "done" })).toEqual(["show", "close"]);
  expect(hold({ status: "working" })).toBe("pause");
  expect(hold({ status: "paused" })).toBe("resume");
  expect(hold({ status: "starting" })).toBeNull();
  expect(hold({ status: "working", kind: "lookup" })).toBeNull();
  expect(hold({ status: "paused", kind: "lookup" })).toBeNull();
  expect(hold({ status: "needs_you" })).toBeNull();
  expect(hold({ status: "done" })).toBeNull();
});

test("a hand's clock runs while it works and stops when it does; a card drawn after it stopped does not guess", () => {
  const at = { since: 1_000 };
  expect(clock("", { ...at, status: "working" }, null, 53_000)).toBe("0:52");
  // Stopped, as the page saw: the clock stops now, and stays.
  expect(clock("0:51", { ...at, status: "done" }, { status: "working" }, 53_000)).toBe("0:52");
  expect(clock("0:52", { ...at, status: "done" }, { status: "done" }, 900_000)).toBe("0:52");
  expect(clock("0:30", { ...at, status: "stopped" }, { status: "paused" }, 900_000)).toBe("0:30");
  // When the state says when it stopped, that is the time, however late the card is drawn.
  expect(clock("", { ...at, status: "done", until: 53_000 }, null, 900_000)).toBe("0:52");
  // Drawn first after it stopped, with no such time: nothing, not the fifteen minutes since it started.
  expect(clock("", { ...at, status: "done" }, null, 900_000)).toBe("");
  expect(clock("", { ...at, status: "paused" }, null, 900_000)).toBe("");
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

test("in a sheet, Ctrl ↑↓ moves between the hands and Ctrl . pauses or carries on; ⌘ on the Mac, and never AltGr", () => {
  expect(shortcut(press("ArrowDown", "ArrowDown", 40, { ctrlKey: true }), true)).toBe("next");
  expect(shortcut(press("ArrowUp", "ArrowUp", 38, { ctrlKey: true }), true)).toBe("previous");
  expect(shortcut(press(".", "Period", 190, { ctrlKey: true }), true)).toBe("hold");
  expect(shortcut(press(":", "Period", 190, { ctrlKey: true }), true)).toBe("hold"); // a layout that puts another sign there
  expect(shortcut(press("ArrowDown", "ArrowDown", 40), true)).toBeNull(); // a plain arrow is the box's
  expect(shortcut(press(".", "Period", 190, { ctrlKey: true, altKey: true }), true)).toBeNull();
  expect(shortcut(press("ArrowDown", "ArrowDown", 40, { metaKey: true }), false)).toBe("next");
  expect(shortcut(press("ArrowDown", "ArrowDown", 40, { ctrlKey: true }), false)).toBeNull();
  expect(shortcut(press("w", "KeyW", 87, { ctrlKey: true }), true)).toBeNull();
});

test("the next and the previous hand stop at the ends of the column", () => {
  const ids = ["index", "lefty", "righty"];
  expect(neighbour(ids, "lefty", 1)).toBe("righty");
  expect(neighbour(ids, "lefty", -1)).toBe("index");
  expect(neighbour(ids, "righty", 1)).toBeNull();
  expect(neighbour(ids, "index", -1)).toBeNull();
  expect(neighbour(ids, "gone", 1)).toBeNull();
  expect(neighbour(["lefty"], "lefty", 1)).toBeNull();
});

test("⌘W closes a hand on the Mac, where a layout with no Latin letters falls back to W's place", () => {
  expect(closes(press("w", "KeyW", 87, { metaKey: true }), false)).toBe(true);
  expect(closes(press("ц", "KeyW", 0, { metaKey: true }), false)).toBe(true);
  expect(closes(press("z", "KeyW", 90, { metaKey: true }), false)).toBe(false);
  expect(closes(press("w", "KeyW", 87, { ctrlKey: true }), false)).toBe(false);
});
