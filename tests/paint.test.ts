/** The design, as the primitives feed.cs is given: what each action looks like in a tile, with no window. */

import { expect, test } from "bun:test";
import type { CursorEvent } from "../src/cursor.ts";
import { fitContain } from "../src/fit.ts";
import { paint } from "../src/paint.ts";
import { Timeline } from "../src/timeline.ts";

const FIT = fitContain([1000, 500], { w: 300, h: 200 }); // 300 x 150, 25 px down the well
const text = (base64: string) => (base64 === "-" ? "" : Buffer.from(base64, "base64").toString("utf8"));

function picture(events: Partial<CursorEvent>[], at: number, options: { reducedMotion?: boolean } = {}) {
  const timeline = new Timeline(options);
  for (const event of events) timeline.push({ hand: 1, kind: "click", t: 0, ...event } as CursorEvent, 0);
  return paint(timeline.poses(at), FIT, options)
    .split(";")
    .filter(Boolean)
    .map((primitive) => primitive.split(" "));
}
const kinds = (primitives: string[][]) => primitives.map((p) => p[0]);

test("nothing to show is an empty picture", () => {
  expect(paint(new Timeline().poses(0), FIT)).toBe("");
});

test("a click: the pointer with its name, then a ripple where it landed, in the well's pixels", () => {
  const gliding = picture([{ x: 0.5, y: 0.5 }], 100);
  expect(kinds(gliding)).toEqual(["pointer", "tag"]);
  const landed = picture([{ x: 0.5, y: 0.5 }], 400);
  expect(kinds(landed)).toEqual(["disc", "ring", "pointer", "tag"]);
  const [ring, pointer, tag] = [landed[1]!, landed[2]!, landed[3]!];
  expect(ring.slice(1, 3)).toEqual(["150", "100"]); // half of 300 across, 25 + half of 150 down
  expect(ring[7]).toBe("0");
  expect(pointer.slice(1, 3)).toEqual(["150", "100"]);
  expect(pointer.slice(5)).toEqual(["arrow", "7aa2f7"]);
  expect(text(tag[9]!)).toBe("H1");
});

test("a right click is dashed, and each hand keeps its own colour", () => {
  const timeline = new Timeline();
  timeline.push({ hand: 2, kind: "click", t: 0, x: 0.2, y: 0.2, button: "right" }, 0);
  const ring = paint(timeline.poses(400), FIT).split(";").find((p) => p.startsWith("ring "))!.split(" "); // prettier-ignore
  expect(ring[6]).toBe("bb9af7");
  expect(ring[7]).toBe("1");
});

test("a control pressed in place flashes its rectangle and makes no ripple", () => {
  const pressed = picture([{ kind: "control", x: 0.5, y: 0.5, rect: [0.4, 0.4, 0.2, 0.2] }], 400);
  expect(kinds(pressed)).toEqual(["rect", "pointer", "tag"]);
  expect(pressed[0]!.slice(1, 5)).toEqual(["118", "83", "64", "34"]); // the control, grown by 2 px a side
});

test("typing: an I-beam, the field lit, and the newest characters in the tag", () => {
  const typing = picture([{ kind: "type", x: 0.5, y: 0.5, rect: [0.3, 0.45, 0.4, 0.1], text: "hello world" }], 450);
  expect(kinds(typing)).toEqual(["rect", "pointer", "tag"]);
  expect(typing[1]![5]).toBe("ibeam");
  const tag = typing[2]!;
  expect(tag.slice(7, 9)).toEqual(["1", "end"]);
  expect("hello world").toStartWith(text(tag[10]!));
});

test("a drag leaves a trail as far as the stroke has got, and the pointer holds on", () => {
  const stroke = { kind: "drag" as const, x: 0.1, y: 0.5, path: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] }; // prettier-ignore
  const midway = picture([stroke], 600);
  const line = midway.find((p) => p[0] === "line")!;
  const [endX] = line.at(-1)!.split(",").map(Number) as [number];
  expect(endX).toBeGreaterThan(30);
  expect(endX).toBeLessThan(270);
  expect(midway.find((p) => p[0] === "pointer")![5]).toBe("grab");
});

test("a scroll is three chevrons, and a look is a band passing down the picture", () => {
  expect(kinds(picture([{ kind: "scroll", x: 0.5, y: 0.5, text: "down" }], 300)).filter((k) => k === "line")).toHaveLength(3);
  const look = picture([{ kind: "look" }], 500);
  const band = look.find((p) => p[0] === "band")!;
  expect(Number(band[2])).toBeGreaterThan(25);
  expect(Number(band[2])).toBeLessThan(175);
  expect(band.slice(1, 4).filter((_, i) => i !== 1)).toEqual(["0", "300"]);
});

test("going somewhere moves no pointer: a chip along the bottom edge says where", () => {
  const timeline = new Timeline();
  timeline.push({ hand: 1, kind: "click", t: 0, x: 0.5, y: 0.5 }, 0);
  timeline.push({ hand: 1, kind: "navigate", t: 0, text: "https://www.youtube.com/results?search_query=lofi" }, 2000);
  const at = paint(timeline.poses(2600), FIT).split(";").map((p) => p.split(" ")); // prettier-ignore
  const chip = at.find((p) => p[0] === "chip")!;
  expect(chip.slice(1, 3)).toEqual(["150", "169"]); // centred, 6 px above the picture's bottom edge
  expect(chip[6]).toBe("middle");
  expect([text(chip[7]!), text(chip[8]!)]).toEqual(["H1 →", "youtube.com/results?search_query=lofi"]);
  expect(at.find((p) => p[0] === "pointer")!.slice(1, 3)).toEqual(["150", "100"]);
  expect(kinds(picture([{ kind: "open", text: "Calculator" }], 300))).toContain("chip");
});

test("the ring is the state: amber while it needs the user, a turning arc while it waits", () => {
  const blocked = picture([{ x: 0.5, y: 0.5 }, { kind: "blocked" }], 3000);
  expect(blocked.find((p) => p[0] === "ring")![6]).toBe("e0af68");
  expect(blocked.find((p) => p[0] === "pointer")![6]).toBe("7aa2f7"); // the body never changes colour
  expect(text(blocked.find((p) => p[0] === "tag")![10]!)).toBe("needs you");
  expect(kinds(picture([{ x: 0.5, y: 0.5 }, { kind: "wait" }], 3000))).toContain("arc");
});

test("words with spaces and semicolons cross the pipe whole", () => {
  const timeline = new Timeline();
  timeline.push({ hand: 1, kind: "think", t: 0, caption: "reading; then a plan" }, 0);
  const sent = paint(timeline.poses(500), FIT);
  expect(sent.split(";")).toHaveLength(4); // disc, ring, pointer, tag: the caption added no separators
  expect(text(sent.split(";")[3]!.split(" ")[10]!)).toBe("reading; then a plan");
});
