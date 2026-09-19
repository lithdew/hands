/** The pointer's contract, its animation and its geometry: everything about the feed's cursors that needs no window. */

import { expect, test } from "bun:test";
import { type CursorEvent, handColor, isCursorEvent, locate, normalizePoint, normalizeRect, short } from "../src/cursor.ts";
import { fitContain, sayAddress, toPixels } from "../src/fit.ts";
import { alongPath, DONE_FADE_MS, DONE_HOLD_MS, GLIDE_BURST_MS, GLIDE_MAX_MS, GLIDE_MIN_MS, glideMs, HandTrack, MAX_EFFECTS, REST_AFTER_MS, REST_OPACITY, RIPPLE_MS, Timeline } from "../src/timeline.ts";

const click = (x: number, y: number, over: Partial<CursorEvent> = {}): CursorEvent => ({ hand: 1, kind: "click", t: 0, x, y, ...over });

// ---------------------------------------------------------------- events

test("a pixel becomes a share of the frame, and a point outside is pulled to the edge", () => {
  expect(normalizePoint(640, 400, [1280, 800])).toEqual({ x: 0.5, y: 0.5 });
  expect(normalizePoint(-20, 9000, [1280, 800])).toEqual({ x: 0, y: 1 });
  expect(normalizePoint(1, 1, [0, 800])).toBeNull();
  expect(normalizePoint(Number.NaN, 1, [1280, 800])).toBeNull();
});

test("a rectangle is cut to the frame, and one wholly outside is nothing", () => {
  expect(normalizeRect([640, 400, 320, 200], [1280, 800])).toEqual([0.5, 0.5, 0.25, 0.25]);
  expect(normalizeRect([1200, 700, 400, 400], [1280, 800])).toEqual([0.9375, 0.875, 0.0625, 0.125]);
  expect(normalizeRect([2000, 0, 10, 10], [1280, 800])).toBeNull();
});

test("a control is located by its middle, a bare point by itself, and an action with no place by nothing", () => {
  expect(locate([1280, 800], { rect: [600, 80, 80, 40] })).toEqual({ x: 0.5, y: 0.125, rect: [0.4688, 0.1, 0.0625, 0.05], frame: [1280, 800] });
  expect(locate([1000, 500], { point: [250, 125] })).toEqual({ x: 0.25, y: 0.25, frame: [1000, 500] });
  expect(locate([1000.4, 500])).toEqual({ frame: [1000, 500] });
});

test("only well-formed events are drawn", () => {
  expect(isCursorEvent({ hand: 1, kind: "click", t: 1, x: 0.5, y: 0.5 })).toBe(true);
  expect(isCursorEvent({ hand: 1, kind: "menu", t: 1, text: "File › New Note" })).toBe(true);
  expect(isCursorEvent({ hand: 0, kind: "click", t: 1 })).toBe(false);
  expect(isCursorEvent({ hand: 1, kind: "explode", t: 1 })).toBe(false);
  expect(isCursorEvent({ hand: 1, kind: "click", t: 1, x: 1.5, y: 0.5 })).toBe(false);
  expect(isCursorEvent({ hand: 1, kind: "click", t: 1, x: 0.5 })).toBe(false);
  expect(isCursorEvent({ hand: 1, kind: "type", t: 1, rect: [0, 0, 2, 1] })).toBe(false);
  expect(isCursorEvent(null)).toBe(false);
});

test("a hand keeps the colour the panel gives it, and a caption is one short line", () => {
  expect([1, 2, 3, 4, 5].map(handColor)).toEqual(["#7aa2f7", "#bb9af7", "#73daca", "#ff9e64", "#7aa2f7"]);
  expect(short("  click   the\nbutton ")).toBe("click the button");
  expect(short("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
});

// ---------------------------------------------------------------- from the frame to the preview

test("a frame is letterboxed like the picture it is drawn over", () => {
  expect(fitContain([1280, 800], { w: 468, h: 293 })).toEqual({ x: 0, y: 0, w: 468, h: 293 }); // whole pixels, rounded as feed.cs rounds the thumbnail
  expect(fitContain([1920, 1040], { w: 310, h: 193 })).toEqual({ x: 0, y: 12, w: 310, h: 168 });
  expect(fitContain([1000, 1000], { w: 400, h: 200 })).toEqual({ x: 100, y: 0, w: 200, h: 200 });
  expect(fitContain([1600, 400], { w: 400, h: 300 })).toEqual({ x: 0, y: 100, w: 400, h: 100 });
  expect(fitContain(null, { w: 400, h: 300 })).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  expect(toPixels({ x: 0.5, y: 0.5 }, fitContain([1000, 1000], { w: 400, h: 200 }))).toEqual({ x: 200, y: 100 });
});

test("a glide takes 140 to 300 ms by distance, and nothing at all with reduced motion", () => {
  expect(glideMs(0.001)).toBeCloseTo(GLIDE_MIN_MS, 0);
  expect(glideMs(1.4)).toBe(GLIDE_MAX_MS);
  expect(glideMs(0.4)).toBeGreaterThan(GLIDE_MIN_MS);
  expect(glideMs(0.4)).toBeLessThan(GLIDE_MAX_MS);
  expect(glideMs(1, Number.POSITIVE_INFINITY, true)).toBe(0);
  expect(glideMs(1, 30)).toBe(GLIDE_BURST_MS);
  expect(glideMs(1, 200)).toBe(180);
});

test("the pointer glides to its target and the ripple starts when it lands", () => {
  const track = new HandTrack(1);
  track.push(click(0.2, 0.2), 0);
  track.push(click(0.8, 0.8), 1000);
  const land = 1000 + glideMs(Math.hypot(0.6, 0.6));
  const mid = track.pose(1000 + (land - 1000) / 2);
  expect(mid.x).toBeGreaterThan(0.2);
  expect(mid.x).toBeLessThan(0.8);
  expect(mid.effects.filter((e) => e.kind === "ripple")).toHaveLength(0);
  const landed = track.pose(land + 1);
  expect([landed.x, landed.y]).toEqual([0.8, 0.8]);
  expect(landed.effects.filter((e) => e.kind === "ripple")).toHaveLength(1);
  expect(track.pose(land + RIPPLE_MS + 1).effects).toHaveLength(0);
});

test("a burst never queues: the target is always the latest action and no click is lost", () => {
  const track = new HandTrack(1);
  const points = Array.from({ length: 24 }, (_, i) => ({ x: ((i * 37) % 100) / 100, y: ((i * 61) % 100) / 100 }));
  const shown = new Set<number>();
  let now = 5000;
  for (const [i, p] of points.entries()) {
    track.push(click(p.x, p.y), now);
    expect(track.target()).toEqual(p);
    // Whatever was still waiting for the pointer fires on this very push, at its own place.
    const ripples = track.pose(now).effects.filter((e) => e.kind === "ripple");
    if (i > 0) expect(ripples.some((e) => e.x === points[i - 1]!.x && e.y === points[i - 1]!.y)).toBe(true);
    for (const e of ripples) shown.add(e.id);
    expect(track.pose(now).effects.length).toBeLessThanOrEqual(MAX_EFFECTS);
    now += 30;
  }
  expect(shown.size).toBe(points.length - 1);
  // One burst glide after the last action the pointer is exactly there, with its ripple: never more than a glide behind.
  const settled = track.pose(now - 30 + GLIDE_BURST_MS + 1);
  expect({ x: settled.x, y: settled.y }).toEqual(points.at(-1)!);
  expect(settled.effects.some((e) => e.kind === "ripple" && e.x === points.at(-1)!.x)).toBe(true);
});

test("an action with no place lets the pointer finish its glide, and starts when it lands", () => {
  const track = new HandTrack(1);
  track.push(click(0.1, 0.1), 0);
  track.push(click(0.9, 0.9), 1000);
  track.push({ hand: 1, kind: "type", t: 0, text: "hello" }, 1020);
  track.push({ hand: 1, kind: "think", t: 0 }, 1040);
  expect(track.target()).toEqual({ x: 0.9, y: 0.9 });
  expect(track.pose(1050).effects.filter((e) => e.kind === "ripple")).toHaveLength(0);
  const landed = track.pose(1000 + GLIDE_MAX_MS + 1);
  expect([landed.x, landed.y]).toEqual([0.9, 0.9]);
  expect(landed.effects.filter((e) => e.kind === "ripple")).toHaveLength(1);
});

test("a long burst cannot pile effects up", () => {
  const track = new HandTrack(1);
  for (let i = 0; i < 200; i++) track.push(click(Math.random(), Math.random(), { count: 2 }), i * 5);
  expect(track.pose(1000).effects.length).toBeLessThanOrEqual(MAX_EFFECTS);
  track.prune(1000 + RIPPLE_MS * 2);
  expect(track.pose(1000 + RIPPLE_MS * 2).effects).toHaveLength(0);
});

test("a double click ripples twice and a right click says so", () => {
  const track = new HandTrack(1, { reducedMotion: true });
  track.push(click(0.5, 0.5, { count: 2, button: "right" }), 0);
  const ripples = track.pose(200).effects.filter((e) => e.kind === "ripple");
  expect(ripples).toHaveLength(2);
  expect(ripples.every((e) => e.button === "right")).toBe(true);
});

test("text appears as it is typed, with an I-beam, in the field's outline", () => {
  const track = new HandTrack(1);
  track.push({ hand: 1, kind: "type", t: 0, x: 0.5, y: 0.1, rect: [0.3, 0.08, 0.4, 0.05], text: "lofi hip hop", caption: "type in Search" }, 0);
  const land = glideMs(Math.hypot(0.035, 0.05));
  const [early, late] = [track.pose(land + 100), track.pose(land + 2000)];
  expect(early.shape).toBe("ibeam");
  expect(early.caret).toBe(true);
  expect("lofi hip hop".startsWith(early.note)).toBe(true);
  expect(early.note.length).toBeGreaterThan(0);
  expect(early.note.length).toBeLessThan(12);
  expect(early.effects.find((e) => e.kind === "rect")).toMatchObject({ tone: "type", rect: [0.3, 0.08, 0.4, 0.05] });
  expect(late.note).toBe("lofi hip hop");
  expect(late.shape).toBe("arrow");
});

test("a control operated with no pointer lights up its rectangle and makes no ripple", () => {
  const track = new HandTrack(1);
  track.push({ hand: 1, kind: "control", t: 0, x: 0.5, y: 0.5, rect: [0.4, 0.45, 0.2, 0.1], caption: "press Bold" }, 0);
  const pose = track.pose(400);
  expect(pose.effects.map((e) => [e.kind, e.tone])).toEqual([["rect", "control"]]);
  expect(pose.note).toBe("press Bold");
  expect(pose.scale).toBe(1);
});

test("a drag holds the pointer down along its stroke and leaves a trail", () => {
  const path = [{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.2 }, { x: 0.6, y: 0.6 }];
  const track = new HandTrack(1);
  track.push({ hand: 1, kind: "move", t: 0, x: 0.2, y: 0.2 }, 0);
  track.push({ hand: 1, kind: "drag", t: 0, x: 0.2, y: 0.2, path }, 1000);
  const during = track.pose(1400);
  expect(during.shape).toBe("grab");
  expect(during.effects[0]).toMatchObject({ kind: "trail", path });
  expect(during.effects[0]!.drawn).toBeGreaterThan(0);
  expect(during.effects[0]!.drawn).toBeLessThan(1);
  const after = track.pose(2000);
  expect([after.x, after.y, after.shape]).toEqual([0.6, 0.6, "arrow"]);
  expect(alongPath(path, 0.5)).toEqual({ x: 0.6, y: 0.2 });
});

test("a stroke cut short is shown whole, and the pointer leaves from where it was", () => {
  const track = new HandTrack(1);
  track.push({ hand: 1, kind: "drag", t: 0, x: 0.2, y: 0.2, path: [{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.6 }] }, 0);
  track.push(click(0.9, 0.9), 400);
  expect(track.pose(401).effects.find((e) => e.kind === "trail")!.drawn).toBe(1);
  expect(track.target()).toEqual({ x: 0.9, y: 0.9 });
});

test("going somewhere moves no pointer: an address, an app and a menu command are chips", () => {
  const track = new HandTrack(1);
  track.push(click(0.3, 0.3), 0);
  track.push({ hand: 1, kind: "navigate", t: 0, text: "https://www.youtube.com/results?search_query=lofi" }, 1000);
  track.push({ hand: 1, kind: "open", t: 0, text: "Calculator" }, 1100);
  track.push({ hand: 1, kind: "menu", t: 0, text: "File › New Note" }, 1200);
  const pose = track.pose(1300);
  expect([pose.x, pose.y]).toEqual([0.3, 0.3]);
  expect(pose.effects.filter((e) => e.kind === "chip").map((e) => [e.tone, e.text])).toEqual([["navigate", "https://www.youtube.com/results?search_query=lofi"], ["open", "Calculator"], ["menu", "File › New Note"]]);
});

test("states: thinking breathes, looking scans, waiting spins, blocked turns amber and stays, done leaves", () => {
  const track = new HandTrack(3);
  track.push({ hand: 3, kind: "think", t: 0 }, 0);
  expect(new Set([0, 400, 800, 1200].map((t) => track.pose(1000 + t).halo)).size).toBeGreaterThan(1);
  expect(track.pose(500)).toMatchObject({ x: 0.5, y: 0.5, mode: "think", color: "#73daca", accent: "#73daca" });
  expect(track.pose(500).note.startsWith("thinking")).toBe(true);

  track.push({ hand: 3, kind: "look", t: 0 }, 2000);
  expect(track.pose(2300).effects.map((e) => e.kind)).toEqual(["scan"]);
  track.push({ hand: 3, kind: "wait", t: 0 }, 4000);
  expect(track.pose(4300).spin).not.toBeNull();

  track.push({ hand: 3, kind: "blocked", t: 0 }, 5000);
  expect(track.pose(5000 + REST_AFTER_MS * 3)).toMatchObject({ accent: "#e0af68", color: "#73daca", note: "needs you", opacity: 1 });
  expect(track.animating(5000 + REST_AFTER_MS * 3)).toBe(true);

  track.push({ hand: 3, kind: "done", t: 0 }, 60000);
  expect(track.pose(60000 + DONE_HOLD_MS - 1)).toMatchObject({ opacity: 1, accent: "#9ece6a", note: "done" });
  expect(track.pose(60000 + DONE_HOLD_MS + DONE_FADE_MS + 1).opacity).toBe(0);
  expect(track.animating(60000 + DONE_HOLD_MS + DONE_FADE_MS + 1)).toBe(false);
});

test("a hand that has gone quiet sits back, and comes forward with its next action", () => {
  const track = new HandTrack(1);
  track.push(click(0.5, 0.5), 0);
  expect(track.pose(2000).opacity).toBe(1);
  expect(track.pose(REST_AFTER_MS + 5000).opacity).toBe(REST_OPACITY);
  expect(track.animating(REST_AFTER_MS + 5000)).toBe(false);
  track.push(click(0.6, 0.6), REST_AFTER_MS + 6000);
  expect(track.pose(REST_AFTER_MS + 6500).opacity).toBe(1);
});

test("reduced motion: the pointer is simply there, the text simply typed, nothing pulses", () => {
  const track = new HandTrack(1, { reducedMotion: true });
  track.push(click(0.2, 0.2), 0);
  track.push({ hand: 1, kind: "type", t: 0, x: 0.9, y: 0.9, text: "hello" }, 1000);
  expect(track.pose(1000)).toMatchObject({ x: 0.9, y: 0.9, note: "hello", scale: 1 });
  track.push({ hand: 1, kind: "think", t: 0 }, 2000);
  expect(new Set([0, 300, 700, 1100].map((t) => track.pose(2000 + t).halo)).size).toBe(1);
  expect(track.pose(2500).note).toBe("thinking");
});

test("several hands are drawn at once, the one that acted last on top", () => {
  const timeline = new Timeline();
  timeline.push({ hand: 1, kind: "click", t: 0, x: 0.2, y: 0.2 }, 0);
  timeline.push({ hand: 2, kind: "click", t: 0, x: 0.8, y: 0.8 }, 100);
  expect(timeline.poses(500).map((p) => [p.hand, p.label, p.color])).toEqual([[1, "H1", "#7aa2f7"], [2, "H2", "#bb9af7"]]);
  timeline.push({ hand: 1, kind: "click", t: 0, x: 0.3, y: 0.3 }, 600);
  expect(timeline.poses(700).map((p) => p.hand)).toEqual([2, 1]);
  timeline.push({ hand: 2, kind: "idle", t: 0 }, 800);
  expect(timeline.poses(3000).map((p) => p.hand)).toEqual([1]);
});

// ---------------------------------------------------------------- the hub
