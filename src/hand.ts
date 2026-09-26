#!/usr/bin/env bun
/**
 * The hand: the agent, made visible. An emoji hand with its name on a tag underneath rides on the window the
 * agent is working in. It glides to what is about to be pressed and taps it, writes, scrolls, looks, waits,
 * and waves hello.
 *
 * It is drawn by a process of its own, which this module starts and feeds one JSON cue per line. An agent's
 * thread stalls for a second at a time inside OCR and accessibility walks, which would freeze a window it
 * owned; AppKit wants a main thread that answers its events; and a fault in a drawing must never end a run.
 * The renderer is deliberately dumb: a cue is applied the moment it arrives, and all the timing is decided
 * on this side. Core Animation plays the motion inside the window server, so nothing here draws a frame.
 */

import { toArrayBuffer } from "bun:ffi";
import * as macos from "./macos.ts";
import { onWindows, platform, rendererCommand } from "./platform.ts";
import type { Frame, Point } from "./models.ts";

export type Pose = "wave" | "point" | "press" | "write" | "draw" | "key" | "scroll" | "look" | "go" | "wait" | "think" | "done" | "stop";

/**
 * What the hand rides on. A window is followed by id wherever it goes, and the hand is stacked right above
 * it, so whatever covers the window covers the hand. Without one it is a spot on a display, above everything;
 * on Windows only while it acts there, since it lies over the user's own windows: at rest it fades away.
 */
export interface Subject {
  window?: number;
  origin: Point;
}

export type Tint = [red: number, green: number, blue: number]; // each 0 to 1

export interface Cue {
  name?: string;
  color?: Tint;
  shy?: boolean; // stay out of screen captures; the renderer answers with a line once it has
  subject?: Subject;
  size?: Point; // how big the subject is, for whoever draws the hand somewhere else: the renderer has no use for it
  pose?: Pose;
  label?: string;
  at?: Point; // points from the subject's top-left corner, which is what a capture's pixels are
  ms?: number; // how long the glide to `at` takes; without it the hand is simply there
  count?: number; // taps
  swipe?: Point; // which way the fingers go in a scroll
  seat?: { state: "waiting" | "holding" | "free"; why: string }; // borrowing the user's mouse and keyboard (src/seat.ts): the hand shows it, and so does its card
}

const REST_MS = 400; // how long a pose is held once its action is over, before the hand goes back to thinking
const SEAT_ACK_MS = 150; // how long a seat cue waits to hear that the renderer has taken it in: a renderer that has died or hung costs this, not the borrow
const LABEL_CHARS = 30;

/**
 * A glide's length in time: brisk along a row of buttons, and never a crawl across a display. It is measured in points,
 * so `perPoint` says how many of the subject's pixels make one: on the Mac they are points already, and on Windows
 * they are physical pixels, one and a half to the point at 150%, as the renderer says (`listen`).
 */
export const glideMs = (from: Point, to: Point, perPoint = 1): number =>
  Math.round(Math.min(520, Math.max(160, 120 + (0.45 * Math.hypot(to[0] - from[0], to[1] - from[1])) / perPoint)));

/** A colour as the command line gives it: `4f8cff`, `#4f8cff`, `#48f`. Null for anything else. */
export const tintOf = (hex: string): Tint | null => {
  const digits = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())?.[1];
  if (!digits) return null;
  const pairs = digits.length === 3 ? [...digits].map((d) => d + d) : digits.match(/../g)!;
  return pairs.map((pair) => Number.parseInt(pair, 16) / 255) as Tint;
};

/** A name for what is being acted on, short enough for the tag. */
export const quote = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return `“${flat.length > LABEL_CHARS ? `${flat.slice(0, LABEL_CHARS)}…` : flat}”`;
};

let renderer: Bun.Subprocess<"pipe", "pipe", "inherit"> | null = null;
const shyAcks: (() => void)[] = []; // who is waiting to hear that the hand is out of captures
const seatAcks: (() => void)[] = []; // who is waiting to hear that the hand shows the seat's new state
let riding = "";
let size: Point = [0, 0]; // how big the subject was at the last look
let last: Point = [0, 0];
let perPoint = 1; // the subject's pixels to a point, as the renderer last said
let resting: ReturnType<typeof setTimeout> | undefined;
let cues = 0; // cues struck so far: a glide's pose is not struck over a later cue's
let via = ""; // who is acting for the hand just now (Jev, while the clicker runs): its labels say so

/** No renderer will answer those waiting on one now: they go on at once, as they would once they had waited long enough. */
function unanswered(): void {
  for (const heard of [...shyAcks.splice(0), ...seatAcks.splice(0)]) heard();
}

/** Whether anyone is watching the hand: a renderer drawing it, or an orchestrator drawing its picture elsewhere. */
const watched = (): boolean => renderer !== null || hand.onCue !== null;

/**
 * A cue goes to whoever runs the hand from outside first, and then to the renderer, if one is drawing. The two are
 * apart on purpose: the orchestrator learns which window the hand is in, how big it is and whether it holds the
 * user's mouse and keyboard only from these cues, and a renderer that has died must not take that away.
 */
function send(cue: Cue): void {
  hand.onCue?.(cue);
  const to = renderer;
  if (!to) return;
  const gone = () => renderer === to && (renderer = null); // the renderer is gone: the run carries on unseen
  try {
    to.stdin.write(`${JSON.stringify(cue)}\n`);
    const flushed = to.stdin.flush();
    if (flushed instanceof Promise) flushed.catch(gone); // a write still under way when the renderer dies fails later, not here
  } catch {
    gone();
  }
}

/**
 * What the renderer says back, a line at a time: an empty line once it is out of captures, `seat` once it shows a
 * seat cue (and so lets a held seat's clicks through), `click` when the hand is clicked, and `scale 1.5` when the
 * display under the hand has that many pixels to a point (Windows only).
 */
async function listen(replies: ReadableStream<Uint8Array>): Promise<void> {
  let pending = "";
  const decoder = new TextDecoder();
  for await (const chunk of replies) {
    const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "click") hand.onClick?.();
      else if (line === "seat") seatAcks.shift()?.();
      else if (line.startsWith("scale ")) perPoint = Number(line.slice(6)) || 1;
      else shyAcks.shift()?.();
    }
  }
}

/**
 * Every call is a no-op until the hand is started or someone outside listens, so the tools pose without asking whether
 * anyone is watching. A hand whose renderer has gone keeps telling `onCue` everything, and only stops waiting for glides.
 */
export const hand = {
  /** Whoever runs the hand from outside (the orchestrator's picture of it) hears every cue it is sent, and every click on it. */
  onCue: null as ((cue: Cue) => void) | null,
  onClick: null as (() => void) | null,

  /**
   * Come on screen: top right of the main display, where the system says hello too. Without a colour the hand is the
   * emoji's own yellow. In `hands live` on Windows (HANDS_SLOT is set) it shows first where it first looks instead:
   * every hand would wave at the same spot, above everything, and that is where the panel's cards are.
   */
  start(name: string, color?: Tint): void {
    unanswered();
    const spawned = (renderer = Bun.spawn(rendererCommand(), { stdin: "pipe", stdout: "pipe", stderr: "inherit" }));
    spawned.unref();
    void listen(spawned.stdout).catch(() => {});
    void spawned.exited.then(() => {
      if (renderer !== spawned) return;
      renderer = null;
      unanswered();
    });
    riding = "";
    perPoint = 1;
    if (onWindows() && process.env.HANDS_SLOT !== undefined) return send({ name, color, pose: "wave", label: "" });
    const [x, y, width] = platform.displays()[0]?.frame ?? [0, 0, 1440, 900];
    last = [width - 260, 150];
    send({ name, color, subject: { origin: [x, y] }, at: last, pose: "wave", label: "" });
  },

  /**
   * Run a capture of a whole display with the hand left out of it: it would cover the very thing it points
   * at, and its tag would be read back as text on the screen. It stays on the screen itself, and in anyone's
   * recording but for this moment. (A window is captured by id, alone, and needs none of this.)
   */
  async unseen<T>(work: () => Promise<T>): Promise<T> {
    if (!renderer) return work();
    send({ shy: true });
    await Promise.race([new Promise<void>((heard) => shyAcks.push(heard)), Bun.sleep(500)]); // a renderer that has died or hung costs half a second, not the run
    try {
      return await work();
    } finally {
      send({ shy: false });
    }
  },

  /** The agent is about to read this window, or this display: ride on it, and look. A window that has changed size since is told so, and ridden as before. */
  look(subject: Subject, [width, height]: Point): void {
    if (!watched()) return;
    const key = String(subject.window ?? subject.origin);
    if (key !== riding) send({ subject, size: [width, height], at: (last = [width / 2, height / 2]) });
    else if (width !== size[0] || height !== size[1]) send({ size: [width, height] });
    riding = key;
    size = [width, height];
    void hand.cue("look", "looking");
  },

  /**
   * Strike a pose, gliding to `at` first when the action has a place. Resolves once the hand is there; with no renderer
   * drawing the glide there is nothing to wait for. A click or typing does not wait for it (src/tools.ts): the pose then
   * comes as the glide ends, unless another cue has come meanwhile, which the hand is showing by then.
   */
  async cue(pose: Pose, label: string, at?: Point, extra: Pick<Cue, "count" | "swipe"> = {}): Promise<void> {
    if (!watched()) return;
    clearTimeout(resting);
    const mine = ++cues;
    if (via && label) label = `${via} › ${label}`;
    if (at) {
      const ms = glideMs(last, at, perPoint);
      send({ pose: pose === "draw" ? pose : "point", label, at: (last = at), ms }); // a pen stays a pen between strokes
      if (renderer) await Bun.sleep(ms);
      if (mine !== cues) return;
    }
    send({ pose, label, ...extra });
  },

  /**
   * The hand is waiting to borrow the user's mouse and keyboard, holding them, or has given them back. Resolves once
   * the renderer shows it: a hand that holds the seat lets every click through from then on, so the borrow's own click
   * cannot land on a hand the user's pointer had left hovered while it waited. A silent renderer is not waited for long.
   */
  seat(state: "waiting" | "holding" | "free", why = ""): Promise<void> {
    if (!watched()) return Promise.resolve();
    send({ seat: { state, why } });
    if (!renderer) return Promise.resolve();
    return Promise.race([new Promise<void>((heard) => seatAcks.push(heard)), Bun.sleep(SEAT_ACK_MS)]);
  },

  /**
   * Who acts for the hand from now on, until it is cleared with "": every label it shows then reads `Jev › click
   * “Pricing”`, on the tag under the hand, on its card, and in what the voice hears of its recent actions.
   */
  via(who: string): void {
    via = who;
  },

  /** Where the pointer is this instant, in the middle of a drag. */
  at(point: Point): void {
    if (watched()) send({ at: (last = point) });
  },

  /** The action is over. Its pose stays a moment, then the hand goes back to thinking, unless the next action comes first. */
  rest(): void {
    if (!watched()) return;
    clearTimeout(resting);
    resting = setTimeout(() => send({ pose: "think", label: "thinking" }), REST_MS);
  },
};

// ------------------------------------------------------------------ the renderer

const GLYPH_PT = 36;
const BOX_PT = 48; // the square a glyph is set in
const PIXELS_PER_PT = 2;
const SKIN_LIGHT = 0.78; // how bright the emoji's own yellow is: the brightness that becomes the tint exactly
const GOLD: Tint = [1, 0.78, 0.22];
const TAG_PT = 20; // the name tag's height
const FOLLOW_MS = 40;
const LINGER_MS = 1400; // how long the last pose stays up after the agent has gone
const FOREVER = 1e9;
const SCREEN_SAVER_LEVEL = 1000;

/** The glyph of each pose, and where it touches what it points at, as a fraction of its box: a fingertip, a pen's point, a palm. Read off renders. */
export const POSES: Record<Pose, [glyph: string, x: number, y: number]> = {
  wave: ["👋", 0.45, 0.75],
  point: ["👆", 0.28, 0.11],
  press: ["👆", 0.28, 0.11],
  write: ["✍️", 0.02, 0.81],
  draw: ["✍️", 0.02, 0.81], // the same pen, held still: its point is where the ink comes out
  key: ["👇", 0.48, 0.82],
  scroll: ["✌️", 0.45, 0.13],
  look: ["🖐️", 0.4, 0.47],
  go: ["👉", 0.74, 0.42],
  wait: ["✋", 0.37, 0.47],
  think: ["👆", 0.28, 0.11],
  done: ["👍", 0.36, 0.44],
  stop: ["✋", 0.37, 0.47],
};

/** How each pose moves: a key path of the glyph's layer, the values it passes through, how long once through takes, and how often (default: once per tap). */
const MOVES: Partial<Record<Pose, [keyPath: string, values: number[], seconds: number, repeat?: number][]>> = {
  wave: [["transform.rotation.z", [0, 0.3, -0.15, 0.3, -0.15, 0], 1.1, 2]],
  press: [["transform.scale", [1, 0.76, 1], 0.2]],
  write: [["transform.translation.x", [0, 6, 1, 8, 0], 0.5, FOREVER], ["transform.translation.y", [0, -2, 1, -1, 0], 0.5, FOREVER]], // prettier-ignore
  key: [["transform.translation.y", [0, 5, 0], 0.18]],
  look: [["transform.translation.x", [-9, 9, -9], 1.8, FOREVER]],
  go: [["transform.translation.x", [0, 8, 0], 0.5, 3]],
  wait: [["transform.scale", [1, 1.07, 1], 1.3, FOREVER]],
  think: [["transform.translation.y", [0, -4, 0], 1.7, FOREVER]],
  done: [["transform.scale", [0.4, 1.2, 1], 0.4, 1]],
};

async function render(): Promise<void> {
  const { cls, sel, str, msg, fn, pooled, structOf } = macos.objc;
  const call = (object: unknown, selector: string, signature = "void", ...args: unknown[]) => msg(signature)(object, sel(selector), ...args);
  const rgba = fn("CGColorCreateGenericRGB", ["f64", "f64", "f64", "f64"], "ptr");
  const [pathCreate, pathMove, pathCurve, pathRelease] = [
    fn("CGPathCreateMutable", [], "ptr"),
    fn("CGPathMoveToPoint", ["ptr", "ptr", "f64", "f64"], "void"),
    fn("CGPathAddQuadCurveToPoint", ["ptr", "ptr", "f64", "f64", "f64", "f64"], "void"),
    fn("CGPathRelease", ["ptr"], "void"),
  ];
  const [bitmapCreate, bitmapData, bitmapImage, contextScale, contextRelease] = [
    fn("CGBitmapContextCreate", ["ptr", "u64", "u64", "u64", "u64", "ptr", "u32"], "ptr"),
    fn("CGBitmapContextGetData", ["ptr"], "ptr"),
    fn("CGBitmapContextCreateImage", ["ptr"], "ptr"),
    fn("CGContextScaleCTM", ["ptr", "f64", "f64"], "void"),
    fn("CGContextRelease", ["ptr"], "void"),
  ];
  const deviceRGB = fn("CGColorSpaceCreateDeviceRGB", [], "ptr")();
  const [RECT, PAIR, OBJECT] = ["void,f64,f64,f64,f64", "void,f64,f64", "void,ptr"];
  const [white, faint, ink] = [rgba(1, 1, 1, 1), rgba(1, 1, 1, 0.7), rgba(0.09, 0.09, 0.11, 0.9)];

  const pool = call(call(cls("NSAutoreleasePool"), "alloc", "ptr"), "init", "ptr");
  const app = call(cls("NSApplication"), "sharedApplication", "ptr");
  call(app, "setActivationPolicy:", "bool,i64", 1); // accessory: no Dock icon, no menu bar, never the app in front
  // A panel that does not activate its app: a click on the hand must interrupt the hand, not take the user out of the app they are in.
  const win = call(call(cls("NSPanel"), "alloc", "ptr"), "initWithContentRect:styleMask:backing:defer:", "ptr,f64,f64,f64,f64,u64,u64,bool", 0, 0, 100, 100, 1 << 7, 2, false);
  for (const [selector, value] of [["setOpaque:", false], ["setHasShadow:", false], ["setIgnoresMouseEvents:", true], ["setReleasedWhenClosed:", false], ["setHidesOnDeactivate:", false]] as const) call(win, selector, "void,bool", value); // prettier-ignore
  call(win, "setBackgroundColor:", OBJECT, call(cls("NSColor"), "clearColor", "ptr"));
  call(win, "setAlphaValue:", "void,f64", 0.99); // not for the eye: it is how macos.ts knows this window, as wide as a display, covers nothing
  call(win, "setCollectionBehavior:", "void,u64", 1 | (1 << 3) | (1 << 6) | (1 << 8)); // on every desktop and over full screen apps, out of Mission Control and the window cycle
  const number = Number(call(win, "windowNumber", "i64"));

  const layer = (parent: unknown, kind = "CALayer") => {
    const made = call(cls(kind), "layer", "ptr");
    call(parent, "addSublayer:", OBJECT, made);
    return made;
  };
  const view = call(win, "contentView", "ptr");
  call(view, "setWantsLayer:", "void,bool", true);
  const stage = layer(call(view, "layer", "ptr")); // the display, y down like every coordinate here
  call(stage, "setGeometryFlipped:", "void,bool", true);
  const rider = layer(stage); // the subject's top-left corner
  const body = layer(rider); // the hand: its position is the point it touches
  const ring = layer(body);
  const glyph = layer(body); // a picture of the emoji rather than the emoji, so that it can be any colour: see `picture`
  const tag = layer(body);
  const words = layer(tag, "CATextLayer");
  const type = call(call(cls("CATextLayer"), "layer", "ptr"), "retain", "ptr"); // never shown: it sets the emoji for `picture` to photograph

  call(ring, "setBounds:", RECT, 0, 0, 44, 44);
  call(ring, "setCornerRadius:", "void,f64", 22);
  call(ring, "setBorderWidth:", "void,f64", 3);
  call(ring, "setBorderColor:", OBJECT, rgba(...GOLD, 1)); // the emoji's own colour, until a cue brings another
  call(ring, "setOpacity:", "void,f32", 0);
  for (const square of [glyph, type]) call(square, "setBounds:", RECT, 0, 0, BOX_PT, BOX_PT);
  call(type, "setFontSize:", "void,f64", GLYPH_PT);
  call(glyph, "setShadowOpacity:", "void,f32", 0.45);
  call(glyph, "setShadowRadius:", "void,f64", 3);
  call(glyph, "setShadowOffset:", PAIR, 0, 1.5);
  call(tag, "setBackgroundColor:", OBJECT, ink);
  call(tag, "setCornerRadius:", "void,f64", TAG_PT / 2);
  call(tag, "setBorderWidth:", "void,f64", 0.5); // a hairline, or the tag is lost on a dark window
  call(tag, "setBorderColor:", OBJECT, rgba(1, 1, 1, 0.28));
  // ponytail: drawn for a 2x display and scaled down on a 1x one; read each screen's backingScaleFactor if that ever looks soft
  for (const textLayer of [type, words]) call(textLayer, "setContentsScale:", "void,f64", PIXELS_PER_PT);
  call(pool, "drain");

  let riding: Subject | null = null;
  let covered = ""; // the display the window is laid over
  let shown = false;
  let spot: Point = [0, 0];
  let [name, status] = ["", ""];
  let tint: Tint | null = null;
  let anchor: Point = [0, 0]; // where in its box the current glyph touches the hand's position
  let tagWidth = 0;
  let hovered = false;
  const pictures = new Map<string, unknown>();

  /**
   * An emoji in the hand's colour. Colour emoji are pictures, so there is no colour to set: the glyph is set in
   * type, photographed into a bitmap, and every pixel given the tint at the brightness it had. The shading
   * survives, a pen stays black, and the skin, which is where the emoji is brightest, comes out the tint itself.
   */
  const picture = (symbol: string) => {
    const key = `${symbol}${tint}`;
    if (pictures.has(key)) return pictures.get(key);
    const side = BOX_PT * PIXELS_PER_PT;
    const context = bitmapCreate(null, side, side, 8, side * 4, deviceRGB, 1); // RGBA, premultiplied
    contextScale(context, PIXELS_PER_PT, PIXELS_PER_PT);
    call(type, "setString:", OBJECT, str(symbol));
    call(type, "renderInContext:", OBJECT, context);
    const pixels = new Uint8Array(toArrayBuffer(bitmapData(context), 0, side * side * 4));
    for (let i = 0; tint && i < pixels.length; i += 4) {
      const light = (0.299 * pixels[i]! + 0.587 * pixels[i + 1]! + 0.114 * pixels[i + 2]!) / SKIN_LIGHT;
      for (let channel = 0; channel < 3; channel++) pixels[i + channel] = Math.min(pixels[i + 3]!, tint[channel]! * light);
    }
    const made = bitmapImage(context); // a copy: the bitmap can go
    contextRelease(context);
    pictures.set(key, made);
    return made;
  };

  /** One value passing through `values`, smoothly, `repeat` times over. */
  const animate = (target: unknown, keyPath: string, values: number[], seconds: number, repeat = 1) => {
    const animation = call(cls("CAKeyframeAnimation"), "animationWithKeyPath:", "ptr,ptr", str(keyPath));
    const list = call(cls("NSMutableArray"), "array", "ptr");
    for (const value of values) call(list, "addObject:", OBJECT, call(cls("NSNumber"), "numberWithDouble:", "ptr,f64", value));
    call(animation, "setValues:", OBJECT, list);
    call(animation, "setCalculationMode:", OBJECT, str("cubic"));
    call(animation, "setDuration:", "void,f64", seconds);
    call(animation, "setRepeatCount:", "void,f32", repeat);
    call(target, "addAnimation:forKey:", "void,ptr,ptr", animation, str(keyPath));
  };

  /** The name in full voice and what it is doing beside it, more quietly; the tag is cut to fit. */
  const relabel = () => {
    const run = (text: string, weight: number, color: unknown) => {
      const attributes = call(cls("NSMutableDictionary"), "dictionary", "ptr");
      call(attributes, "setObject:forKey:", "void,ptr,ptr", call(cls("NSFont"), "systemFontOfSize:weight:", "ptr,f64,f64", 11.5, weight), str("NSFont"));
      call(attributes, "setObject:forKey:", "void,ptr,ptr", color, str("CTForegroundColor"));
      const made = call(call(cls("NSAttributedString"), "alloc", "ptr"), "initWithString:attributes:", "ptr,ptr,ptr", call(cls("NSString"), "stringWithUTF8String:", "ptr,cstring", Buffer.from(`${text}\0`)), attributes);
      return call(made, "autorelease", "ptr");
    };
    const label = call(call(call(cls("NSMutableAttributedString"), "alloc", "ptr"), "init", "ptr"), "autorelease", "ptr");
    call(label, "appendAttributedString:", OBJECT, run(name, 0.3, white));
    if (status) call(label, "appendAttributedString:", OBJECT, run(`  ${status}`, 0, faint));
    const [width, height] = structOf(label, "size", 2).map(Math.ceil) as Point;
    call(words, "setString:", OBJECT, label);
    call(words, "setFrame:", RECT, 9, (TAG_PT - height) / 2, width, height);
    call(tag, "setBounds:", RECT, 0, 0, (tagWidth = width + 18), TAG_PT);
  };

  const strike = (pose: Pose, count = 1, swipe: Point = [0, -1]) => {
    const [symbol, x, y] = POSES[pose];
    anchor = [x, y];
    call(glyph, "removeAllAnimations");
    call(glyph, "setContents:", OBJECT, picture(symbol));
    call(glyph, "setAnchorPoint:", PAIR, x, y); // so the glyph touches the hand's position, and turns and shrinks about it
    call(tag, "setPosition:", PAIR, BOX_PT * (0.5 - x), BOX_PT * (1 - y) + 6 + TAG_PT / 2);
    for (const [keyPath, values, seconds, repeat] of MOVES[pose] ?? []) animate(glyph, keyPath, values, seconds, repeat ?? count);
    if (pose === "press") for (const [keyPath, values] of [["transform.scale", [0.2, 1.6]], ["opacity", [0.9, 0]]] as const) animate(ring, keyPath, [...values], 0.45, count); // prettier-ignore
    if (pose === "scroll") {
      swipe.forEach((way, axis) => way && animate(glyph, `transform.translation.${"xy"[axis]}`, [-14 * way, 14 * way], 0.45, 3));
      animate(glyph, "opacity", [0, 1, 1, 0], 0.45, 3);
    }
  };

  const move = (at: Point, ms?: number) => {
    const [fromX, fromY] = spot;
    const [x, y] = (spot = at);
    call(body, "setPosition:", PAIR, x, y);
    call(body, "removeAnimationForKey:", OBJECT, str("position"));
    if (!ms) return;
    // A hand does not travel in a straight line: it lifts off a little on the way.
    const [sideX, sideY] = [(y - fromY) * 0.16, (fromX - x) * 0.16];
    const lift = sideY > 0 ? -1 : 1;
    const route = pathCreate();
    pathMove(route, null, fromX, fromY);
    pathCurve(route, null, (fromX + x) / 2 + sideX * lift, (fromY + y) / 2 + sideY * lift, x, y);
    const glide = call(cls("CAKeyframeAnimation"), "animationWithKeyPath:", "ptr,ptr", str("position"));
    call(glide, "setPath:", OBJECT, route);
    pathRelease(route);
    call(glide, "setDuration:", "void,f64", ms / 1000);
    call(glide, "setTimingFunction:", OBJECT, call(cls("CAMediaTimingFunction"), "functionWithName:", "ptr,ptr", str("easeInEaseOut")));
    call(body, "addAnimation:forKey:", "void,ptr,ptr", glide, str("position"));
  };

  const ride = (subject: Subject) => {
    riding = subject;
    shown = false;
    call(win, "setLevel:", "void,i64", subject.window === undefined ? SCREEN_SAVER_LEVEL : 0);
    animate(body, "opacity", [0, 1], 0.35);
  };

  /** Keep the window over the subject's display, the rider on the subject's corner, and the stacking right. */
  const follow = () => {
    // Nothing is drawn by events, but an app that never takes them off its queue is one the system calls unresponsive.
    // The one event that means something is a press on the hand, which only arrives while the mouse is over it (below).
    for (let event; (event = call(app, "nextEventMatchingMask:untilDate:inMode:dequeue:", "ptr,u64,ptr,ptr,bool", 0xffffffffffffffffn, null, str("kCFRunLoopDefaultMode"), true)); ) {
      if (hovered && Number(call(event, "type", "u64")) === 1) process.stdout.write("click\n"); // NSEventTypeLeftMouseDown
      call(app, "sendEvent:", OBJECT, event);
    }
    if (!riding) return;
    let frame: Frame = [riding.origin[0], riding.origin[1], 2, 2];
    if (riding.window !== undefined) {
      const windows = macos.allWindows();
      const under = windows.findIndex((w) => w.id === riding!.window);
      if (under < 0) {
        if (shown) call(win, "orderOut:", OBJECT, null); // closed, minimized, or on another desktop: the hand goes with it
        shown = false;
        return;
      }
      frame = windows[under]!.frame;
      const mine = windows.findIndex((w) => w.id === number);
      if (!shown || mine < 0 || mine > under) call(win, "orderWindow:relativeTo:", "void,i64,i64", 1, riding.window); // NSWindowAbove; asked again only when the window has come up past the hand
    } else if (!shown) call(win, "orderFrontRegardless");
    shown = true;

    const all = macos.displays();
    const display = macos.displayFor(frame).frame;
    call(cls("CATransaction"), "begin");
    call(cls("CATransaction"), "setDisableActions:", "void,bool", true);
    if (String(display) !== covered) {
      covered = String(display);
      call(win, "setFrame:display:", "void,f64,f64,f64,f64,bool", display[0], (all[0]?.frame[3] ?? 0) - (display[1] + display[3]), display[2], display[3], true); // Cocoa counts y up from the main display's bottom edge
      call(stage, "setFrame:", RECT, 0, 0, display[2], display[3]);
    }
    call(rider, "setPosition:", PAIR, frame[0] - display[0], frame[1] - display[1]);

    // The window is a display wide and lets every click through, except while the mouse is on the hand or its tag:
    // then it takes them, so the hand can be clicked, and it swells a little to say so.
    const [mouseX, mouseY] = macos.mouseLocation();
    const [handX, handY] = [frame[0] + spot[0], frame[1] + spot[1]];
    const within = (left: number, top: number, width: number, height: number) => mouseX >= left && mouseY >= top && mouseX < left + width && mouseY < top + height;
    const over =
      within(handX - anchor[0] * BOX_PT, handY - anchor[1] * BOX_PT, BOX_PT, BOX_PT) ||
      within(handX + BOX_PT * (0.5 - anchor[0]) - tagWidth / 2, handY + BOX_PT * (1 - anchor[1]) + 6, tagWidth, TAG_PT);
    if (over !== hovered) {
      hovered = over;
      call(win, "setIgnoresMouseEvents:", "void,bool", !over);
      call(body, "setValue:forKeyPath:", "void,ptr,ptr", call(cls("NSNumber"), "numberWithDouble:", "ptr,f64", over ? 1.12 : 1), str("transform.scale"));
    }
    call(cls("CATransaction"), "commit");
    call(cls("CATransaction"), "flush");
  };

  const play = (cue: Cue) => {
    call(cls("CATransaction"), "begin");
    call(cls("CATransaction"), "setDisableActions:", "void,bool", true);
    if (cue.color) {
      tint = cue.color;
      call(ring, "setBorderColor:", OBJECT, rgba(...tint, 1));
    }
    if (cue.shy !== undefined) call(win, "setSharingType:", "void,u64", cue.shy ? 0 : 1); // NSWindowSharingNone, or ReadOnly as every window starts
    if (cue.subject) ride(cue.subject);
    if (cue.name !== undefined || cue.label !== undefined) {
      [name, status] = [cue.name ?? name, cue.label ?? status];
      relabel();
    }
    if (cue.pose) strike(cue.pose, cue.count, cue.swipe);
    if (cue.at) move(cue.at, cue.ms);
    call(cls("CATransaction"), "commit");
    if (cue.subject) follow();
    call(cls("CATransaction"), "flush"); // no run loop here to commit for us
    if (cue.shy) process.stdout.write("\n"); // the window server has it: a capture from here on leaves the hand out
    if (cue.seat) process.stdout.write("seat\n"); // this hand draws nothing for the seat (its card does), so a seat cue is taken in as it arrives
  };

  setInterval(() => pooled(follow), FOLLOW_MS);
  for await (const line of console) {
    try {
      if (line) pooled(() => play(JSON.parse(line)));
    } catch (error) {
      console.error(`hand: ${error}`);
    }
  }
  // The agent is gone. Its last pose stays up long enough to be seen, and the hand goes after it.
  await Bun.sleep(LINGER_MS);
  pooled(() => {
    call(body, "setOpacity:", "void,f32", 0);
    animate(body, "opacity", [1, 0], 0.3);
    call(cls("CATransaction"), "flush");
  });
  await Bun.sleep(350);
}

if (import.meta.main && !onWindows()) {
  // The Mac renderer; on Windows rendererCommand() names the native overlay, and this half never runs.
  process.on("SIGINT", () => {}); // Ctrl-C reaches the whole process group; the agent decides when this ends, by closing the pipe
  await render();
  process.exit(0);
}
