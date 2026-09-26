import { expect, test } from "bun:test";
import { arrange, folded, lines, order, SIZE, type Shape, tall, unfolded } from "../src/ui/fold.ts";
import type { Status } from "../src/ui/state.ts";

const hand = (id: string, status: Status, since: number, viewing = false) => ({ id, status, since, viewing });
const WIDE: Shape = { ratio: 16 / 10, words: true };
const shapes = (...ids: string[]) => new Map(ids.map((id) => [id, WIDE]));
const [LEAST, MOST] = SIZE.picture;
const BASE = SIZE.edge + SIZE.dock; // what the column takes before any card

test("a hand that needs you stands first; the rest keep the order they were sent out in", () => {
  const hands = [hand("lefty", "done", 1), hand("righty", "working", 2), hand("thumbs", "needs_you", 3), hand("pinky", "working", 4)];
  expect(order(hands).map((one) => one.id)).toEqual(["thumbs", "lefty", "righty", "pinky"]);
});

test("a picture is as tall as the column makes it, and a tall window's no taller than the cap", () => {
  expect(tall({ ratio: 16 / 9, words: false })).toBe(212);
  expect(tall({ ratio: 320 / 520, words: false })).toBe(MOST);
  expect(tall({ ratio: 320 / 520, words: false }, 180)).toBe(180);
  expect(tall({ ratio: null, words: false })).toBe(SIZE.brief);
  expect(unfolded(WIDE)).toBe(SIZE.strip + SIZE.rule + 235 + SIZE.pad + 3 * SIZE.line);
});

test("a finished hand unfolds as a receipt, never a full picture, and working hands get the room", () => {
  // Its answer, five lines at most, beside a small picture; with neither, its header alone.
  expect(unfolded(WIDE, MOST, { status: "done" })).toBe(SIZE.strip + SIZE.pad + SIZE.receipt * SIZE.line);
  expect(unfolded({ ...WIDE, lines: 1 }, MOST, { status: "failed" })).toBe(SIZE.strip + SIZE.pad + SIZE.mini);
  expect(unfolded({ ratio: null, words: true, lines: 2 }, MOST, { status: "done" })).toBe(SIZE.strip + SIZE.pad + 2 * SIZE.line);
  expect(unfolded({ ratio: 1.6, words: false }, MOST, { status: "stopped" })).toBe(SIZE.strip + SIZE.pad + SIZE.mini);
  expect(unfolded({ ratio: null, words: false }, MOST, { status: "stopped" })).toBe(SIZE.strip);
  // Under the answer, the tally of its steps, when it took any.
  expect(unfolded({ ...WIDE, tally: true }, MOST, { status: "done" })).toBe(SIZE.strip + SIZE.pad + SIZE.receipt * SIZE.line + SIZE.tally);
  expect(unfolded({ ratio: 1.6, words: false, tally: true }, MOST, { status: "stopped" })).toBe(SIZE.strip + SIZE.pad + SIZE.mini);
  // A lookup has no picture: its answer, then its sources; while it searches, its question and what it searches for.
  expect(unfolded({ ratio: null, words: true, lines: 2, sources: true }, MOST, { status: "done" })).toBe(SIZE.strip + SIZE.pad + 2 * SIZE.line + SIZE.sources);
  expect(unfolded({ ratio: null, words: false }, MOST, { status: "working" })).toBe(SIZE.strip + SIZE.rule + SIZE.brief + SIZE.subtitle);
  // A hand still at work keeps its picture; before it has one, what it is doing stands under its task.
  expect(unfolded(WIDE, MOST, { status: "working" })).toBe(unfolded(WIDE));
  expect(unfolded({ ratio: null, words: false }, MOST, { status: "working" })).toBe(SIZE.strip + SIZE.rule + SIZE.brief + SIZE.subtitle);
  expect(unfolded({ ratio: null, words: false }, MOST, { status: "starting" })).toBe(SIZE.strip + SIZE.rule + SIZE.brief);
  // Two done and one at work, with room for the receipts and a middling picture: the picture takes the rest.
  const hands = [hand("lefty", "done", 1), hand("righty", "working", 2), hand("thumbs", "done", 3)];
  const short: Shape = { ratio: 16 / 10, words: true, lines: 1 };
  const receipt = SIZE.strip + SIZE.pad + SIZE.mini;
  const room = BASE + 3 * SIZE.gap + 2 * receipt + SIZE.strip + SIZE.rule + 200 + SIZE.pad + SIZE.line;
  const layout = arrange(hands, new Map(hands.map((one) => [one.id, short])), room, null);
  expect([...layout.unfolded].sort()).toEqual(["lefty", "righty", "thumbs"]);
  expect(layout.picture).toBe(200);
});

test("the lines words take are counted long: a line breaks between words, so it holds fewer than fit", () => {
  expect(lines("", 30)).toBe(0);
  expect(lines("Done.", 30)).toBe(1);
  expect(lines("a".repeat(31), 30)).toBe(2);
  expect(lines("Opened Notepad and wrote the haiku:\nLunch waits in warm light\nA quiet bowl, a shared pause\nAfternoon begins", 28)).toBe(5);
  expect(folded({ status: "done" }, { ...WIDE, lines: 1 })).toBe(SIZE.strip + SIZE.pad + SIZE.line);
  expect(unfolded({ ...WIDE, lines: 1 })).toBe(SIZE.strip + SIZE.rule + 235 + SIZE.pad + SIZE.line);
});

test("folded, a hand at work is its header; one that has stopped keeps two lines of what came of it", () => {
  expect(folded({ status: "working" }, WIDE)).toBe(SIZE.strip);
  expect(folded({ status: "done" }, WIDE)).toBe(SIZE.strip + SIZE.pad + 2 * SIZE.line);
  expect(folded({ status: "done" }, { ratio: 1, words: false })).toBe(SIZE.strip);
  expect(folded({ status: "done" }, WIDE, true)).toBe(SIZE.strip);
});

test("folded, a hand at work that holds the seat or waits for it keeps its line about that, and the column counts it", () => {
  // card.ts keeps the words under such a card (it is not quiet): "Using your mouse and keyboard.", "Waiting for you to pause."
  expect(folded({ status: "working", seat: "holding" }, WIDE)).toBe(SIZE.strip + SIZE.pad + 2 * SIZE.line);
  expect(folded({ status: "working", seat: "waiting" }, WIDE)).toBe(SIZE.strip + SIZE.pad + 2 * SIZE.line);
  expect(folded({ status: "working", seat: "" }, WIDE)).toBe(SIZE.strip);
  expect(folded({ status: "working", seat: "holding" }, WIDE, true)).toBe(SIZE.strip);
  // Eight hands, two at work with the seat and their windows in front (so they stay folded): the column as card.ts
  // draws it, words and all, fits the room it was arranged in.
  const hands = ["lefty", "righty", "thumbs", "pinky", "index", "palm", "knuckles", "digit"].map((id, index) => ({
    ...hand(id, (["working", "done", "done", "working", "needs_you", "working", "working", "working"] as Status[])[index]!, index, index === 0 || index === 6),
    seat: index === 0 ? ("holding" as const) : index === 6 ? ("waiting" as const) : ("" as const),
  }));
  const room = 900;
  const layout = arrange(hands, shapes(...hands.map((one) => one.id)), room, null);
  const busy = (status: Status) => status === "working" || status === "starting";
  // card.ts: a folded card shows two lines of words unless it is bare, or its hand is at work and not at the seat.
  const drawn = (one: (typeof hands)[number]) => SIZE.strip + (layout.bare.has(one.id) || (busy(one.status) && !one.seat) ? 0 : SIZE.pad + 2 * SIZE.line);
  const height = hands.reduce<number>((sum, one) => sum + SIZE.gap + (layout.unfolded.has(one.id) ? unfolded(WIDE, layout.picture) : drawn(one)), BASE);
  expect(layout.unfolded.has("lefty")).toBe(false);
  expect(height).toBeLessThanOrEqual(room);
  expect(layout.over).toBe(false);
});

test("with room for everything, every card unfolds at full size", () => {
  const hands = [hand("lefty", "working", 1), hand("righty", "done", 2)];
  const layout = arrange(hands, shapes("lefty", "righty"), 2000, null);
  expect([...layout.unfolded].sort()).toEqual(["lefty", "righty"]);
  expect(layout.picture).toBe(MOST);
});

test("short of room, the hand that needs you unfolds, then the newest at work, and a task with no picture yet after them", () => {
  const hands = [hand("lefty", "working", 1), hand("righty", "working", 2), hand("thumbs", "needs_you", 3), hand("pinky", "starting", 4)];
  const plain: Shape = { ratio: 16 / 10, words: false };
  const pictures = new Map([["lefty", plain], ["righty", plain], ["thumbs", plain]]);
  const room = BASE + 4 * SIZE.gap + 4 * SIZE.strip + 2 * (SIZE.rule + LEAST) + 100; // two pictures at their smallest, and 100 over
  const layout = arrange(hands, pictures, room, null);
  expect([...layout.unfolded]).toEqual(["thumbs", "righty", "pinky"]); // Lefty's would not fit; Pinky's task, smaller, does
  expect(layout.picture).toBe(LEAST + Math.floor((100 - SIZE.rule - SIZE.brief) / 2));
});

test("two at work share the room: both unfold, smaller, rather than one alone", () => {
  const hands = [hand("lefty", "working", 1), hand("righty", "working", 2)];
  const room = BASE + 2 * SIZE.gap + 2 * SIZE.strip + 500;
  const layout = arrange(hands, shapes("lefty", "righty"), room, null);
  expect([...layout.unfolded].sort()).toEqual(["lefty", "righty"]);
  expect(layout.picture).toBe(250 - SIZE.rule - SIZE.pad - 3 * SIZE.line);
});

test("the dock's tallest is kept free, so nothing folds while the voice talks", () => {
  const hands = [hand("lefty", "working", 1)];
  const exactly = BASE + SIZE.gap + unfolded(WIDE);
  expect(arrange(hands, shapes("lefty"), exactly, null).picture).toBe(MOST);
  expect(arrange(hands, shapes("lefty"), exactly - 30, null).picture).toBe(205);
});

test("a picture shrinks so the card that wants room most can unfold, but only so far", () => {
  const hands = [hand("lefty", "working", 1)];
  const smallest = BASE + SIZE.gap + unfolded(WIDE, LEAST);
  const layout = arrange(hands, shapes("lefty"), smallest, null);
  expect([...layout.unfolded]).toEqual(["lefty"]);
  expect(layout.picture).toBe(LEAST);
  expect(arrange(hands, shapes("lefty"), smallest - 1, null).unfolded.size).toBe(0);
});

test("finished hands give up their two lines, oldest first, before the hand that needs you stays folded", () => {
  const hands = [hand("lefty", "done", 1), hand("righty", "done", 2), hand("index", "needs_you", 3)];
  const two = folded({ status: "done" }, WIDE);
  const needs = folded({ status: "needs_you" }, WIDE); // two lines, and the buttons that answer it
  expect(needs).toBe(two + SIZE.ask);
  const least = unfolded(WIDE, LEAST, { status: "needs_you" }) - needs;
  const room = BASE + 3 * SIZE.gap + 2 * two + needs + least - 10;
  const layout = arrange(hands, shapes("lefty", "righty", "index"), room, null);
  expect([...layout.bare]).toEqual(["lefty"]);
  expect([...layout.unfolded]).toEqual(["index"]);
  expect(layout.picture).toBe(LEAST - 10 + (two - SIZE.strip)); // what Lefty gave up, less the 10 it was short
  expect(unfolded(WIDE, LEAST, { status: "needs_you" })).toBe(unfolded(WIDE, LEAST) + SIZE.ask);
  const hopeless = arrange(hands, shapes("lefty", "righty", "index"), BASE + 3 * SIZE.gap + 2 * two + needs + 20, null);
  expect(hopeless.bare.size).toBe(0); // no room to be had: nobody gives theirs up for nothing
});

test("a card whose window is in front stays folded, and still counts", () => {
  const hands = [hand("lefty", "working", 1, true), hand("righty", "working", 2)];
  const layout = arrange(hands, shapes("lefty", "righty"), 2000, null);
  expect([...layout.unfolded]).toEqual(["righty"]);
});

test("an open card is the only one unfolded, the others are headers, and its transcript gives way before its picture", () => {
  const hands = [hand("lefty", "working", 1), hand("righty", "done", 2)];
  const roomy = arrange(hands, shapes("lefty", "righty"), 2000, "lefty");
  expect([...roomy.unfolded]).toEqual(["lefty"]);
  expect([...roomy.bare]).toEqual(["righty"]);
  expect(roomy.log).toBe(SIZE.log[1]);
  // Open, the card is wide: a landscape picture is as tall as the most an open one may be.
  expect(roomy.picture).toBe(tall(WIDE, SIZE.open[1], SIZE.wide));
  expect(roomy.picture).toBe(SIZE.open[1]);
  const room = 700;
  const cramped = arrange(hands, shapes("lefty", "righty"), room, "lefty");
  const left = room - BASE - 2 * SIZE.gap - 2 * SIZE.strip - SIZE.rule - SIZE.sheet;
  expect(cramped.picture).toBe(Math.min(tall(WIDE, SIZE.open[1], SIZE.wide), left - SIZE.log[0]));
  expect(cramped.log).toBe(left - cramped.picture);
  const small = BASE + 2 * SIZE.gap + 2 * SIZE.strip + SIZE.rule + SIZE.sheet + SIZE.open[0] + SIZE.log[0]; // just room for both at their smallest
  const tiny = arrange(hands, shapes("lefty", "righty"), small, "lefty");
  expect(tiny.unfolded.has("lefty")).toBe(true);
  expect(tiny.log).toBe(SIZE.log[0]);
  expect(tiny.picture).toBe(SIZE.open[0]);
});

test("a watched card is wide and tall, and the others fold for it, down to a point", () => {
  const hands = [hand("lefty", "working", 1), hand("righty", "working", 2), hand("thumbs", "done", 3)];
  const ids = hands.map((one) => one.id);
  const plain: Shape = { ratio: 16 / 10, words: false };
  const pictures = new Map(ids.map((id) => [id, plain]));
  // With room, it is as tall as the wide card makes it; the others still unfold.
  const roomy = arrange(hands, pictures, 2000, null, "lefty");
  expect(roomy.theater).toBe(tall(plain, SIZE.theater[1], SIZE.wide));
  expect(roomy.theater).toBe(348);
  expect([...roomy.unfolded].sort()).toEqual(ids.sort());
  // Short of room, it keeps its picture and the others fold: it goes first.
  const headers = BASE + 3 * (SIZE.gap + SIZE.strip);
  const short = arrange(hands, pictures, headers + SIZE.rule + 300, null, "lefty");
  expect(short.theater).toBe(300);
  expect([...short.unfolded]).toEqual(["lefty"]);
  // A tall window is no taller than the most.
  expect(arrange(hands, new Map([["lefty", { ratio: 0.5, words: false }]]), 2000, null, "lefty").theater).toBe(SIZE.theater[1]);
  // Too short even for its smallest picture: it is not watched big, and the column is arranged as ever.
  const none = arrange(hands, pictures, headers + SIZE.rule + SIZE.theater[0] - 1, null, "lefty");
  expect(none.theater).toBe(0);
  expect(none).toEqual(arrange(hands, pictures, headers + SIZE.rule + SIZE.theater[0] - 1, null));
  // A sheet out wins: nothing is watched big behind it.
  expect(arrange(hands, pictures, 2000, "righty", "lefty").theater).toBe(0);
});

test("a finished card watched big shows its picture and its words, and older finished hands give up their lines for it", () => {
  const hands = [hand("lefty", "done", 1), hand("righty", "done", 2)];
  const said: Shape = { ratio: 16 / 10, words: true, lines: 2 };
  const pictures = new Map([["lefty", said], ["righty", said]]);
  const two = folded({ status: "done" }, said);
  const chrome = SIZE.rule + SIZE.pad + 2 * SIZE.line - (two - SIZE.strip); // what watching Righty adds, less its picture
  const room = BASE + 2 * SIZE.gap + 2 * two + chrome + SIZE.theater[0] - 10; // 10 short, until Lefty gives up its lines
  const layout = arrange(hands, pictures, room, null, "righty");
  expect([...layout.bare]).toEqual(["lefty"]);
  expect(layout.theater).toBe(SIZE.theater[0] - 10 + (two - SIZE.strip));
  expect([...layout.unfolded]).toEqual(["righty"]);
});

/** How tall the column is drawn with a sheet out: the open card's picture (if it has one), transcript and box, and the others as headers. */
const opened = (hands: { id: string }[], layout: ReturnType<typeof arrange>, open: string): number =>
  hands.reduce<number>((sum, one) => sum + SIZE.gap + (one.id === open ? SIZE.strip + (layout.picture ? SIZE.rule + layout.picture : 0) + layout.log + SIZE.sheet : SIZE.strip), BASE);

test("with a sheet out and no room for both a picture and a transcript, the picture goes and the transcript takes the rest", () => {
  const hands = Array.from({ length: 8 }, (_, index) => hand(`h${index}`, index === 0 ? "needs_you" : "working", index));
  const ids = hands.map((one) => one.id);
  // 1080p at 125% (the room shell-windows gives it): the smallest picture and transcript would have run 25 px over the top.
  const room = 806;
  const layout = arrange(hands, shapes(...ids), room, "h7");
  expect(layout.picture).toBe(0);
  expect(layout.unfolded.size).toBe(0); // the open card is folded, its sheet out: nothing of it is filmed
  expect(layout.log).toBeGreaterThan(SIZE.log[0]);
  expect(opened(hands, layout, "h7")).toBe(room);
  expect(layout.over).toBe(false);
  // One pixel short of the smallest of both: the picture goes rather than the column running over.
  const hands2 = [hand("lefty", "working", 1), hand("righty", "done", 2)];
  const both = BASE + 2 * SIZE.gap + 2 * SIZE.strip + SIZE.rule + SIZE.sheet + SIZE.open[0] + SIZE.log[0];
  const short = arrange(hands2, shapes("lefty", "righty"), both - 1, "lefty");
  expect(short.picture).toBe(0);
  expect(opened(hands2, short, "lefty")).toBe(both - 1);
});

test("with a sheet out on a room too small even for a line of its transcript, the column says it runs over, so its cards scroll", () => {
  const hands = Array.from({ length: 8 }, (_, index) => hand(`h${index}`, index === 0 ? "needs_you" : "working", index));
  const ids = hands.map((one) => one.id);
  // 1080p at 150% with a 48 px taskbar: the dock is kept at its tallest, and then there is no room for a transcript.
  const layout = arrange(hands, shapes(...ids), 672, "h7");
  expect(layout.picture).toBe(0);
  expect(layout.log).toBe(2 * SIZE.line);
  expect(layout.over).toBe(true);
});

test("hands too many even for their headers say the column runs over; with room, it does not", () => {
  const hands = Array.from({ length: 8 }, (_, index) => hand(`h${index}`, "working", index));
  const ids = hands.map((one) => one.id);
  const headers = BASE + 8 * (SIZE.strip + SIZE.gap);
  expect(arrange(hands, shapes(...ids), headers - 1, null).over).toBe(true);
  expect(arrange(hands, shapes(...ids), headers, null).over).toBe(false);
  expect(arrange(hands, shapes(...ids), 2000, null).over).toBe(false);
});

test("with too many finished hands for two lines each, the oldest fold to their headers", () => {
  const hands = Array.from({ length: 8 }, (_, index) => hand(`h${index}`, "done", index));
  const ids = hands.map((one) => one.id);
  const room = 700;
  const layout = arrange(hands, shapes(...ids), room, null);
  expect(layout.bare.has("h0")).toBe(true);
  expect(layout.bare.has("h7")).toBe(false);
  const height = hands.reduce<number>((sum, one) => sum + folded(one, WIDE, layout.bare.has(one.id)) + SIZE.gap, BASE);
  expect(height).toBeLessThanOrEqual(room);
});

test("a hand with no card shape yet is treated as a task with no words", () => {
  const layout = arrange([hand("lefty", "starting", 1)], new Map(), 1000, null);
  expect(layout.unfolded.has("lefty")).toBe(true);
});
