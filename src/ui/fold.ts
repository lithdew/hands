/**
 * How the column stands: in what order the cards come, and which of them are unfolded. As hands pile up (there
 * can be eight) the cards that matter least fold down to their headers, so the column always fits the screen:
 * a hand that needs you unfolds first, then the ones at work, the newest first. A card whose window is in front
 * of the user stays folded, since they are looking at the real thing. Arithmetic only, over the heights ui.css
 * draws, so it is tested without a page.
 */

import type { HandView, Status } from "./state.ts";

/** How tall the pieces are, in CSS pixels, as ui.css draws them. */
export const SIZE = {
  column: 380, // a card's width, its border included
  strip: 46, // a folded card: its header in its border
  gap: 10, // under each card
  line: 20, // a line of a card's words
  pad: 18, // above and below those words
  picture: [150, 240], // a picture on a card whose sheet is not out: at 240 a landscape window fills the width, and it shrinks as far as 150 before a card stays folded for want of room
  brief: 84, // what the hand was asked, where its picture will be
  dock: 100, // the dock at its tallest, three lines of words: kept free, so that no card folds because the voice is talking
  sheet: 96, // an open card's box and buttons, without its transcript
  log: [96, 300], // an open card's transcript, at least and at most
  open: [120, 300], // an open card's picture, at least and at most
} as const;

export const finished = (status: Status): boolean => status === "done" || status === "failed" || status === "stopped";
const busy = (status: Status): boolean => status === "working" || status === "starting";

/** Which hands want the room most: one that needs you, then the ones at work, then one waiting to go on. */
const ATTENTION: Record<Status, number> = { needs_you: 0, working: 1, starting: 1, paused: 2, failed: 3, done: 4, stopped: 5 };

/** Top to bottom: the hands that need you, then the rest in the order they were sent out, so the newest stands by the dock. */
export const order = <T extends Pick<HandView, "status">>(hands: T[]): T[] => [...hands.filter((hand) => hand.status === "needs_you"), ...hands.filter((hand) => hand.status !== "needs_you")];

/** What a card has to show: its picture's width over its height (null until there is one: the task stands there instead), and whether it has words under it. */
export interface Shape {
  ratio: number | null;
  words: boolean;
}

/** How tall a card's picture is at the column's width, no taller than `most`. */
export const tall = (shape: Shape, most: number = SIZE.picture[1]): number => (shape.ratio ? Math.min(most, Math.round((SIZE.column - 4) / shape.ratio)) : SIZE.brief);

/** A folded card: its header, and under it two lines of what came of a hand that has stopped (unless it is bare, header only). */
export const folded = (hand: Pick<HandView, "status">, shape: Shape, bare = false): number => SIZE.strip + (shape.words && !busy(hand.status) && !bare ? SIZE.pad + 2 * SIZE.line : 0);

/** An unfolded card: its header, its picture, and three lines of words. */
export const unfolded = (shape: Shape, most: number = SIZE.picture[1]): number => SIZE.strip + tall(shape, most) + (shape.words ? SIZE.pad + 3 * SIZE.line : 0);

export interface Layout {
  unfolded: Set<string>;
  bare: Set<string>; // cards folded to their header alone: while a sheet is out, or when the column had no room even for two lines each
  picture: number; // how tall a picture may be: on an unfolded card, or on the open one
  log: number; // the open card's transcript, how tall
}

type Hand = Pick<HandView, "id" | "status" | "since" | "viewing">;

/**
 * Which cards unfold, within `room` (the height the panel may take). While a sheet is out, its card alone, and the
 * others down to their headers: its picture and transcript share what they leave, the transcript giving way first.
 */
export function arrange(hands: Hand[], shapes: Map<string, Shape>, room: number, open: string | null): Layout {
  const shape = (hand: Hand): Shape => shapes.get(hand.id) ?? { ratio: null, words: false };
  const opened = open ? hands.find((hand) => hand.id === open) : undefined;
  const bare = new Set(opened ? hands.filter((hand) => hand !== opened).map((hand) => hand.id) : []);
  const cost = () => hands.reduce<number>((sum, hand) => sum + folded(hand, shape(hand), bare.has(hand.id)) + SIZE.gap, SIZE.dock);
  const oldest = hands.filter((hand) => finished(hand.status) && !bare.has(hand.id)).sort((a, b) => a.since - b.since);
  // Too many to fold even to two lines each: the oldest finished hands go down to their headers.
  while (oldest.length && cost() > room) bare.add(oldest.shift()!.id);
  if (opened) {
    const left = room - cost() + folded(opened, shape(opened), bare.has(opened.id)) - SIZE.strip - SIZE.sheet;
    const [fewest, most] = SIZE.log;
    const ideal = tall(shape(opened), SIZE.open[1]);
    const log = Math.min(most, Math.max(fewest, left - ideal));
    return { unfolded: new Set([opened.id]), bare, picture: Math.min(ideal, Math.max(SIZE.open[0], left - log)), log };
  }
  const wanted = hands.filter((hand) => !hand.viewing).sort((a, b) => ATTENTION[a.status] - ATTENTION[b.status] || b.since - a.since);
  /** What unfolding a card adds to the column, with its picture no taller than `most`. */
  const more = (hand: Hand, most: number) => unfolded(shape(hand), most) - folded(hand, shape(hand), bare.has(hand.id));
  // The card that wants the room most unfolds if it can be made to: the finished hands give up their two lines,
  // oldest first, and then the pictures shrink, down to a point.
  const first = wanted[0];
  if (first) {
    const least = more(first, SIZE.picture[0]);
    const givers = oldest.filter((hand) => hand !== first);
    const given = givers.reduce((sum, hand) => sum + folded(hand, shape(hand)) - SIZE.strip, 0);
    for (const hand of least <= room - cost() + given ? givers : []) {
      if (least <= room - cost()) break;
      bare.add(hand.id);
    }
  }
  let left = room - cost();
  let picture: number = SIZE.picture[1];
  if (first && shape(first).ratio && more(first, picture) > left) picture = Math.max(SIZE.picture[0], left - more(first, 0));
  const unfolding = new Set<string>();
  for (const hand of wanted) {
    if (more(hand, picture) > left) continue;
    left -= more(hand, picture);
    unfolding.add(hand.id);
  }
  return { unfolded: unfolding, bare, picture, log: SIZE.log[0] };
}
