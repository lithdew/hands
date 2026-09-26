import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cue, glideMs, hand, quote, tintOf } from "../src/hand.ts";
import * as macos from "../src/macos.ts";
import * as platform from "../src/platform.ts";

test("a glide is brisk up close, slower far away, and never a crawl", () => {
  expect(glideMs([0, 0], [0, 0])).toBe(160);
  expect(glideMs([0, 0], [300, 400])).toBe(345);
  expect(glideMs([0, 0], [3000, 0])).toBe(520);
});

test("a glide is as long in points wherever it is: on Windows the pixels are fewer to the point at 100% than at 150%", () => {
  expect(glideMs([0, 0], [300, 400], 1.5)).toBe(270);
  expect(glideMs([0, 0], [600, 800], 2)).toBe(glideMs([0, 0], [300, 400]));
});

test("what goes on the tag is one short line", () => {
  expect(quote("Sign\n  in")).toBe("“Sign in”");
  expect(quote("x".repeat(80))).toBe(`“${"x".repeat(30)}…”`);
});

test("a colour is hex, with or without the hash, and nothing else", () => {
  expect(tintOf("#ff8000")).toEqual([1, 128 / 255, 0]);
  expect(tintOf("48f")).toEqual([0x44 / 255, 0x88 / 255, 1]);
  for (const bad of ["", "blue", "#ff80", "ff8000ff", "gggggg"]) expect(tintOf(bad)).toBeNull();
});

test("until it is started, the hand costs the tools nothing: no process, no wait", async () => {
  const before = performance.now();
  hand.look({ origin: [0, 0] }, [100, 100]);
  await hand.cue("press", "click", [5000, 5000]);
  hand.at([1, 1]);
  hand.rest();
  expect(await hand.unseen(async () => "the capture")).toBe("the capture");
  expect(performance.now() - before).toBeLessThan(50);
});

// A renderer that draws nothing: it answers a shy cue as the real ones do, and first says its scale when it is given one.
const RENDERER = join(tmpdir(), "hands-test-renderer.ts");
await Bun.write(RENDERER, `if (process.argv[2]) console.log("scale " + process.argv[2]);\nfor await (const line of console) if (line.includes('"shy":true')) console.log("");\n`);
const SET = ["HANDS_PLATFORM", "HANDS_SLOT"] as const;
const before = SET.map((name) => process.env[name]);
let spawns: ReturnType<typeof spyOn<typeof Bun, "spawn">> | null = null;

/** Start the hand on that renderer, with `env` set, and hear every cue it is sent. */
function started(env: Partial<Record<(typeof SET)[number], string>>, scale = ""): Cue[] {
  Object.assign(process.env, env);
  spyOn(platform, "rendererCommand").mockReturnValue([process.execPath, RENDERER, scale]);
  spawns = spyOn(Bun, "spawn");
  const cues: Cue[] = [];
  hand.onCue = (cue) => void cues.push(cue);
  hand.start("Lefty", [1, 0, 0]);
  return cues;
}

afterEach(async () => {
  // The renderer goes, and with it the started hand: the tools in other tests find it stopped again.
  for (const { value } of spawns?.mock.results ?? []) {
    (value as Bun.Subprocess).kill();
    await (value as Bun.Subprocess).exited;
  }
  spawns = null;
  hand.onCue = null;
  SET.forEach((name, i) => (before[i] === undefined ? delete process.env[name] : (process.env[name] = before[i])));
  mock.restore();
});

test("in hands live on Windows a hand shows first where it first looks, not above everything at one spot of the main display", () => {
  const cues = started({ HANDS_PLATFORM: "windows", HANDS_SLOT: "0" });
  expect(cues).toEqual([{ name: "Lefty", color: [1, 0, 0], pose: "wave", label: "" }]);
  hand.look({ window: 7, origin: [10, 20] }, [800, 600]);
  expect(cues.slice(1)).toEqual([{ subject: { window: 7, origin: [10, 20] }, size: [800, 600], at: [400, 300] }, { pose: "look", label: "looking" }]);
});

test("elsewhere the hand waves hello at the top right of the main display, above everything", () => {
  spyOn(macos, "displays").mockReturnValue([{ index: 0, frame: [0, 0, 1440, 900] }]);
  const cues = started({});
  expect(cues).toEqual([{ name: "Lefty", color: [1, 0, 0], subject: { origin: [0, 0] }, at: [1180, 150], pose: "wave", label: "" }]);
});

test("a window that has changed size is told so without being ridden anew, so its picture elsewhere keeps its shape", () => {
  const cues = started({ HANDS_PLATFORM: "windows", HANDS_SLOT: "0" });
  hand.look({ window: 7, origin: [10, 20] }, [800, 600]);
  const from = cues.length;
  hand.look({ window: 7, origin: [10, 20] }, [800, 600]);
  hand.look({ window: 7, origin: [0, 0] }, [1280, 700]);
  expect(cues.slice(from)).toEqual([{ pose: "look", label: "looking" }, { size: [1280, 700] }, { pose: "look", label: "looking" }]);
});

test("borrowing the seat is a cue of its own, for the hand on the screen and its card alike", () => {
  const cues = started({ HANDS_PLATFORM: "windows", HANDS_SLOT: "0" });
  hand.seat("waiting", "pressing ctrl+s");
  hand.seat("holding", "pressing ctrl+s");
  hand.seat("free");
  expect(cues.slice(1)).toEqual([
    { seat: { state: "waiting", why: "pressing ctrl+s" } },
    { seat: { state: "holding", why: "pressing ctrl+s" } },
    { seat: { state: "free", why: "" } },
  ]);
});

test("a glide is timed in the points the renderer says the pixels make", async () => {
  const cues = started({ HANDS_PLATFORM: "windows", HANDS_SLOT: "0" }, "2");
  await hand.unseen(async () => {}); // its answer comes after its scale: the scale is in
  hand.look({ window: 7, origin: [0, 0] }, [800, 600]);
  await hand.cue("press", "click", [1000, 1100]); // 1000 pixels from the middle, where a look puts the hand: 500 points
  expect(cues.find((cue) => cue.ms !== undefined)).toEqual({ pose: "point", label: "click", at: [1000, 1100], ms: glideMs([0, 0], [500, 0]) });
});
