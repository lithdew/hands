import { expect, test } from "bun:test";
import { arrange, folded, order, SIZE, type Shape, tall, unfolded } from "../src/ui/fold.ts";
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

test("folded, a hand at work is its header; one that has stopped keeps two lines of what came of it", () => {
  expect(folded({ status: "working" }, WIDE)).toBe(SIZE.strip);
  expect(folded({ status: "done" }, WIDE)).toBe(SIZE.strip + SIZE.pad + 2 * SIZE.line);
  expect(folded({ status: "done" }, { ratio: 1, words: false })).toBe(SIZE.strip);
  expect(folded({ status: "done" }, WIDE, true)).toBe(SIZE.strip);
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
  const least = unfolded(WIDE, LEAST) - two;
  const room = BASE + 3 * SIZE.gap + 3 * two + least - 10;
  const layout = arrange(hands, shapes("lefty", "righty", "index"), room, null);
  expect([...layout.bare]).toEqual(["lefty"]);
  expect([...layout.unfolded]).toEqual(["index"]);
  expect(layout.picture).toBe(LEAST - 10 + (two - SIZE.strip)); // what Lefty gave up, less the 10 it was short
  const hopeless = arrange(hands, shapes("lefty", "righty", "index"), BASE + 3 * SIZE.gap + 3 * two + 20, null);
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
  expect(roomy.picture).toBe(tall(WIDE, SIZE.open[1]));
  const room = 700;
  const cramped = arrange(hands, shapes("lefty", "righty"), room, "lefty");
  const left = room - BASE - 2 * SIZE.gap - 2 * SIZE.strip - SIZE.rule - SIZE.sheet;
  expect(cramped.picture).toBe(tall(WIDE, SIZE.open[1]));
  expect(cramped.log).toBe(left - cramped.picture);
  const tiny = arrange(hands, shapes("lefty", "righty"), 440, "lefty");
  expect(tiny.log).toBe(SIZE.log[0]);
  expect(tiny.picture).toBe(SIZE.open[0]);
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
