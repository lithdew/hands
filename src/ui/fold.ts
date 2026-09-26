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
  wide: 560, // a card watched big, or with its sheet out: as wide as the panel's window lets it be (shell-windows.ts)
  strip: 46, // a folded card: its header in its border
  gap: 10, // under each card
  edge: 20, // the column's own margin, above and below: room for the shadows and the listening ring
  rule: 2, // the line over a picture
  line: 20, // a line of a card's words
  pad: 18, // above and below those words
  picture: [150, 240], // a picture on a card whose sheet is not out: at 240 a landscape window fills the width, and it shrinks as far as 150 before a card stays folded for want of room
  theater: [200, 440], // the picture of a card watched big, at least and at most
  brief: 84, // what the hand was asked, where its picture will be
  subtitle: 20, // under that task, what a hand at work is doing, until its picture comes
  mini: 70, // a finished hand's small picture, beside its answer
  receipt: 5, // lines of a finished hand's answer
  tally: 20, // under that answer, how many steps it took and how long
  sources: 32, // or a finished lookup's row of sources
  ask: 34, // under what a hand that needs you says, the buttons that answer it
  dock: 100, // the dock at its tallest, three lines of words: kept free, so that no card folds because the voice is talking
  sheet: 96, // an open card's box and buttons, without its transcript
  log: [96, 300], // an open card's transcript, at least and at most
  open: [120, 300], // an open card's picture, at least and at most
} as const;

export const finished = (status: Status): boolean => status === "done" || status === "failed" || status === "stopped";
const busy = (status: Status): boolean => status === "working" || status === "starting";

/** A character about as wide as two Latin letters: Chinese, Japanese and Korean, full-width forms, and emoji. */
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3040-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u;

/**
 * How many lines words take where `chars` of them fit on a line: a guess, made before they are drawn. The words are
 * broken as the card breaks them: a word that does not fit on a line goes whole to the next, and one longer than a
 * line takes lines of its own; a wide character counts as two. With `chars` counted short it errs long for most
 * text, but a font's widest letters can still take more room than counted, so the page also measures the lines it
 * drew and arranges the column again when they are more (ui.ts).
 */
export function lines(text: string, chars: number): number {
  let count = 0;
  for (const paragraph of text ? text.split("\n") : []) {
    count++;
    let used = 0; // how much of the line is taken
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const width = [...word].reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0);
      if (used && used + 1 + width <= chars) {
        used += 1 + width;
        continue;
      }
      const more = Math.ceil(width / chars) - 1; // lines of its own, past the one it starts on
      count += (used ? 1 : 0) + more;
      used = width - more * chars;
    }
  }
  return count;
}

/** Which hands want the room most: one that needs you, then the ones at work (a picture before a task still waiting for one), then one waiting to go on. */
const ATTENTION: Record<Status, number> = { needs_you: 0, working: 1, starting: 2, paused: 3, failed: 4, done: 5, stopped: 6 };

/** Top to bottom: the hands that need you, then the rest in the order they were sent out, so the newest stands by the dock. */
export const order = <T extends Pick<HandView, "status">>(hands: T[]): T[] => [...hands.filter((hand) => hand.status === "needs_you"), ...hands.filter((hand) => hand.status !== "needs_you")];

/**
 * What a card has to show: its picture's width over its height (null until there is one: the task stands there
 * instead; a lookup never has one), whether it has words under it, how many lines those take (see `lines`; as many
 * as fit, unsaid), and what its receipt has under them: a tally of the steps it took, a lookup's sources.
 */
export interface Shape {
  ratio: number | null;
  words: boolean;
  lines?: number;
  tally?: boolean;
  sources?: boolean;
}

type Of = Pick<HandView, "status"> & Partial<Pick<HandView, "seat">>;

/** How tall a card's picture is at the card's width (the column's, unless it is wider), no taller than `most`. */
export const tall = (shape: Shape, most: number = SIZE.picture[1], width: number = SIZE.column): number =>
  shape.ratio ? Math.min(most, Math.round((width - 4) / shape.ratio)) : SIZE.brief;

/** A card's words, no more than `most` lines of them. */
const said = (shape: Shape, most: number): number => (shape.words ? Math.min(most, shape.lines ?? most) * SIZE.line : 0);

/**
 * A folded card: its header, and under it two lines of what came of a hand that has stopped, or of what a hand at
 * work is doing with the user's mouse and keyboard (unless it is bare, header only). card.ts keeps the same words.
 */
export const folded = (hand: Of, shape: Shape, bare = false): number =>
  SIZE.strip + (shape.words && !bare && (!busy(hand.status) || !!hand.seat) ? SIZE.pad + said(shape, 2) + asks(hand) : 0);

/** The buttons under the words of a hand that needs you. */
const asks = (hand?: Of): number => (hand?.status === "needs_you" ? SIZE.ask : 0);

/**
 * An unfolded card: its header, its picture, and three lines of words. When `hand` says whose it is: a hand at work
 * with no picture yet has what it is doing under its task, and a finished hand's is a receipt instead, its answer
 * first, in as many as five lines, with a small picture beside it.
 */
export const unfolded = (shape: Shape, most: number = SIZE.picture[1], hand?: Of): number => {
  if (hand && finished(hand.status)) {
    const body = Math.max(shape.ratio ? SIZE.mini : 0, said(shape, SIZE.receipt) + (shape.tally ? SIZE.tally : 0) + (shape.sources ? SIZE.sources : 0));
    return SIZE.strip + (body ? SIZE.pad + body : 0);
  }
  return pictured(shape, shape.ratio ? tall(shape, most) : SIZE.brief + (hand?.status === "working" ? SIZE.subtitle : 0), hand);
};

/** A card with its picture (or the task in its place) `picture` tall, and its words under it. */
const pictured = (shape: Shape, picture: number, hand?: Of): number => SIZE.strip + SIZE.rule + picture + (shape.words ? SIZE.pad + said(shape, 3) + asks(hand) : 0);

export interface Layout {
  unfolded: Set<string>;
  bare: Set<string>; // cards folded to their header alone: while a sheet is out, or when the column had no room even for two lines each
  picture: number; // how tall a picture may be: on an unfolded card, or on the open one (0: the open card has no room for one)
  log: number; // the open card's transcript, how tall
  over: boolean; // even so, the column is taller than the room: the cards scroll, so none is lost off the top
  theater: number; // how tall the picture of the card watched big is (0: none is, for want of room or of asking)
}

type Hand = Pick<HandView, "id" | "status" | "since" | "viewing"> & Partial<Pick<HandView, "seat">>;

/**
 * Which cards unfold, within `room` (the height the panel may take). While a sheet is out, its card alone, and the
 * others down to their headers: its picture and transcript share what they leave, the transcript giving way first,
 * and with too little left for both, the picture goes (the open card is then folded, with its sheet out). A card
 * `watching` names is watched big (theater): wide, its picture as tall as it can be, and the others fold for it.
 */
export function arrange(hands: Hand[], shapes: Map<string, Shape>, room: number, open: string | null, watching: string | null = null): Layout {
  const shape = (hand: Hand): Shape => shapes.get(hand.id) ?? { ratio: null, words: false };
  const opened = open ? hands.find((hand) => hand.id === open) : undefined;
  const bare = new Set(opened ? hands.filter((hand) => hand !== opened).map((hand) => hand.id) : []);
  const cost = () => hands.reduce<number>((sum, hand) => sum + folded(hand, shape(hand), bare.has(hand.id)) + SIZE.gap, SIZE.edge + SIZE.dock);
  const oldest = hands.filter((hand) => finished(hand.status) && !bare.has(hand.id)).sort((a, b) => a.since - b.since);
  // Too many to fold even to two lines each: the oldest finished hands go down to their headers.
  while (oldest.length && cost() > room) bare.add(oldest.shift()!.id);
  /** The finished hands, oldest first, give up their two lines until `need` fits, if all of them together would make it fit. */
  const giveWay = (need: number, keep: (Hand | undefined)[]) => {
    const givers = oldest.filter((hand) => !keep.includes(hand) && !bare.has(hand.id));
    const given = givers.reduce((sum, hand) => sum + folded(hand, shape(hand)) - SIZE.strip, 0);
    for (const hand of need <= room - cost() + given ? givers : []) {
      if (need <= room - cost()) break;
      bare.add(hand.id);
    }
    return need <= room - cost();
  };
  if (opened) {
    const left = room - cost() + folded(opened, shape(opened), bare.has(opened.id)) - SIZE.strip - SIZE.rule - SIZE.sheet;
    const [fewest, most] = SIZE.log;
    const ideal = tall(shape(opened), SIZE.open[1], SIZE.wide);
    if (left < Math.min(ideal, SIZE.open[0]) + fewest) {
      // No room for the smallest picture and the shortest transcript together: the picture (and the rule over it)
      // gives way, and the transcript takes what is left, a line of it at least.
      const log = Math.max(2 * SIZE.line, left + SIZE.rule);
      return { unfolded: new Set(), bare, picture: 0, log, over: log > left + SIZE.rule, theater: 0 };
    }
    const log = Math.min(most, Math.max(fewest, left - ideal));
    return { unfolded: new Set([opened.id]), bare, picture: Math.min(ideal, Math.max(SIZE.open[0], left - log)), log, over: false, theater: 0 };
  }
  // A card watched big comes first: its picture as tall as the wide card makes it, up to the most, with the finished
  // hands giving up their lines for it as for any card; the others unfold in what it leaves. With no room for it even
  // at its smallest, it is not watched big.
  let watched = watching ? hands.find((hand) => hand.id === watching) : undefined;
  let [theater, reserved] = [0, 0];
  if (watched) {
    const own = shape(watched);
    const was = bare.delete(watched.id); // watched, it shows its words
    const chrome = pictured(own, 0, watched) - folded(watched, own); // what unfolding it adds, less its picture
    const ideal = tall(own, SIZE.theater[1], SIZE.wide);
    if (giveWay(chrome + Math.min(ideal, SIZE.theater[0]), [watched])) {
      theater = Math.min(ideal, room - cost() - chrome);
      reserved = chrome + theater;
    } else {
      if (was) bare.add(watched.id);
      watched = undefined;
    }
  }
  const wanted = hands.filter((hand) => !hand.viewing && hand !== watched).sort((a, b) => ATTENTION[a.status] - ATTENTION[b.status] || b.since - a.since);
  /** What unfolding a card adds to the column, with its picture no taller than `most`. */
  const more = (hand: Hand, most: number) => unfolded(shape(hand), most, hand) - folded(hand, shape(hand), bare.has(hand.id));
  // The card that wants the room most unfolds if it can be made to: the finished hands give up their two lines,
  // oldest first, and then the pictures shrink, down to a point.
  const first = wanted[0];
  if (first) giveWay(more(first, SIZE.picture[0]) + reserved, [first, watched]);
  // As many cards unfold as fit with their pictures at the smallest, the ones that want it most first: more hands
  // in sight beats fewer, larger. Then the pictures grow together, as far as the room lets them.
  const left = room - reserved - cost();
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
  return { unfolded: new Set([...(watched ? [watched.id] : []), ...unfolding.map((hand) => hand.id)]), bare, picture, log: SIZE.log[0], over: left < 0, theater };
}
