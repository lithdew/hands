/**
 * How the column stands: in what order the cards come, and which of them are unfolded. As hands pile up (there
 * can be eight) the cards that matter least fold down to their headers, so the column always fits the screen:
 * a hand that needs you unfolds first, then the ones at work, the newest first. A card whose window is in front
 * of the user stays folded, since they are looking at the real thing. A finished hand unfolds as a receipt, its
 * answer beside a small picture, so the room goes to the pictures of hands still at work. Arithmetic only, over
 * the heights ui.css draws, so it is tested without a page.
 */

import type { HandView, Status } from "./state.ts";

/** How tall the pieces are, in CSS pixels, as ui.css draws them. */
export const SIZE = {
  column: 380, // a card's width, its border included
  strip: 46, // a folded card: its header in its border
  gap: 10, // under each card
  edge: 20, // the column's own margin, above and below: room for the shadows and the listening ring
  rule: 2, // the line over a picture
  line: 20, // a line of a card's words
  pad: 18, // above and below those words
  picture: [150, 240], // a picture on a card whose sheet is not out: at 240 a landscape window fills the width, and it shrinks as far as 150 before a card stays folded for want of room
  brief: 84, // what the hand was asked, where its picture will be
  subtitle: 20, // under that task, what a hand at work is doing, until its picture comes
  mini: 70, // a finished hand's small picture, beside its answer
  receipt: 5, // lines of a finished hand's answer
  dock: 100, // the dock at its tallest, three lines of words: kept free, so that no card folds because the voice is talking
  sheet: 96, // an open card's box and buttons, without its transcript
  log: [96, 300], // an open card's transcript, at least and at most
  open: [120, 300], // an open card's picture, at least and at most
} as const;

export const finished = (status: Status): boolean => status === "done" || status === "failed" || status === "stopped";
const busy = (status: Status): boolean => status === "working" || status === "starting";

/**
 * How many lines words take where `chars` of them fit on a line. A guess that errs long, since a line breaks between
 * words: the column is arranged for at least what is drawn, and never runs over for a line it did not count.
 */
export const lines = (text: string, chars: number): number => (text ? text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / chars)), 0) : 0);

/** Which hands want the room most: one that needs you, then the ones at work (a picture before a task still waiting for one), then one waiting to go on. */
const ATTENTION: Record<Status, number> = { needs_you: 0, working: 1, starting: 2, paused: 3, failed: 4, done: 5, stopped: 6 };

/** Top to bottom: the hands that need you, then the rest in the order they were sent out, so the newest stands by the dock. */
export const order = <T extends Pick<HandView, "status">>(hands: T[]): T[] => [...hands.filter((hand) => hand.status === "needs_you"), ...hands.filter((hand) => hand.status !== "needs_you")];

/**
 * What a card has to show: its picture's width over its height (null until there is one: the task stands there
 * instead), whether it has words under it, and how many lines those take (see `lines`; as many as fit, unsaid).
 */
export interface Shape {
  ratio: number | null;
  words: boolean;
  lines?: number;
}

type Of = Pick<HandView, "status"> & Partial<Pick<HandView, "seat">>;

/** How tall a card's picture is at the column's width, no taller than `most`. */
export const tall = (shape: Shape, most: number = SIZE.picture[1]): number => (shape.ratio ? Math.min(most, Math.round((SIZE.column - 4) / shape.ratio)) : SIZE.brief);

/** A card's words, no more than `most` lines of them. */
const said = (shape: Shape, most: number): number => (shape.words ? Math.min(most, shape.lines ?? most) * SIZE.line : 0);

/**
 * A folded card: its header, and under it two lines of what came of a hand that has stopped, or of what a hand at
 * work is doing with the user's mouse and keyboard (unless it is bare, header only). card.ts keeps the same words.
 */
export const folded = (hand: Of, shape: Shape, bare = false): number => SIZE.strip + (shape.words && !bare && (!busy(hand.status) || !!hand.seat) ? SIZE.pad + said(shape, 2) : 0);

/**
 * An unfolded card: its header, its picture, and three lines of words. When `hand` says whose it is: a hand at work
 * with no picture yet has what it is doing under its task, and a finished hand's is a receipt instead, its answer
 * first, in as many as five lines, with a small picture beside it.
 */
export const unfolded = (shape: Shape, most: number = SIZE.picture[1], hand?: Of): number => {
  if (hand && finished(hand.status)) {
    const body = Math.max(shape.ratio ? SIZE.mini : 0, said(shape, SIZE.receipt));
    return SIZE.strip + (body ? SIZE.pad + body : 0);
  }
  const picture = shape.ratio ? tall(shape, most) : SIZE.brief + (hand?.status === "working" ? SIZE.subtitle : 0);
  return SIZE.strip + SIZE.rule + picture + (shape.words ? SIZE.pad + said(shape, 3) : 0);
};

export interface Layout {
  unfolded: Set<string>;
  bare: Set<string>; // cards folded to their header alone: while a sheet is out, or when the column had no room even for two lines each
  picture: number; // how tall a picture may be: on an unfolded card, or on the open one (0: the open card has no room for one)
  log: number; // the open card's transcript, how tall
  over: boolean; // even so, the column is taller than the room: the cards scroll, so none is lost off the top
}

type Hand = Pick<HandView, "id" | "status" | "since" | "viewing"> & Partial<Pick<HandView, "seat">>;

/**
 * Which cards unfold, within `room` (the height the panel may take). While a sheet is out, its card alone, and the
 * others down to their headers: its picture and transcript share what they leave, the transcript giving way first,
 * and with too little left for both, the picture goes (the open card is then folded, with its sheet out).
 */
export function arrange(hands: Hand[], shapes: Map<string, Shape>, room: number, open: string | null): Layout {
  const shape = (hand: Hand): Shape => shapes.get(hand.id) ?? { ratio: null, words: false };
  const opened = open ? hands.find((hand) => hand.id === open) : undefined;
  const bare = new Set(opened ? hands.filter((hand) => hand !== opened).map((hand) => hand.id) : []);
  const cost = () => hands.reduce<number>((sum, hand) => sum + folded(hand, shape(hand), bare.has(hand.id)) + SIZE.gap, SIZE.edge + SIZE.dock);
  const oldest = hands.filter((hand) => finished(hand.status) && !bare.has(hand.id)).sort((a, b) => a.since - b.since);
  // Too many to fold even to two lines each: the oldest finished hands go down to their headers.
  while (oldest.length && cost() > room) bare.add(oldest.shift()!.id);
  if (opened) {
    const left = room - cost() + folded(opened, shape(opened), bare.has(opened.id)) - SIZE.strip - SIZE.rule - SIZE.sheet;
    const [fewest, most] = SIZE.log;
    const ideal = tall(shape(opened), SIZE.open[1]);
    if (left < Math.min(ideal, SIZE.open[0]) + fewest) {
      // No room for the smallest picture and the shortest transcript together: the picture (and the rule over it)
      // gives way, and the transcript takes what is left, a line of it at least.
      const log = Math.max(2 * SIZE.line, left + SIZE.rule);
      return { unfolded: new Set(), bare, picture: 0, log, over: log > left + SIZE.rule };
    }
    const log = Math.min(most, Math.max(fewest, left - ideal));
    return { unfolded: new Set([opened.id]), bare, picture: Math.min(ideal, Math.max(SIZE.open[0], left - log)), log, over: false };
  }
  const wanted = hands.filter((hand) => !hand.viewing).sort((a, b) => ATTENTION[a.status] - ATTENTION[b.status] || b.since - a.since);
  /** What unfolding a card adds to the column, with its picture no taller than `most`. */
  const more = (hand: Hand, most: number) => unfolded(shape(hand), most, hand) - folded(hand, shape(hand), bare.has(hand.id));
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
  // As many cards unfold as fit with their pictures at the smallest, the ones that want it most first: more hands
  // in sight beats fewer, larger. Then the pictures grow together, as far as the room lets them.
  const left = room - cost();
  const unfolding: Hand[] = [];
  let least = 0;
  for (const hand of wanted) {
    if (least + more(hand, SIZE.picture[0]) > left) continue;
    least += more(hand, SIZE.picture[0]);
    unfolding.push(hand);
  }
  const taken = (most: number) => unfolding.reduce((sum, hand) => sum + more(hand, most), 0);
  let picture: number = SIZE.picture[0];
  while (picture < SIZE.picture[1] && taken(picture + 1) <= left) picture++;
  return { unfolded: new Set(unfolding.map((hand) => hand.id)), bare, picture, log: SIZE.log[0], over: left < 0 };
}
