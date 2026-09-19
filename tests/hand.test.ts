import { expect, test } from "bun:test";
import { glideMs, hand, quote, tintOf } from "../src/hand.ts";

test("a glide is brisk up close, slower far away, and never a crawl", () => {
  expect(glideMs([0, 0], [0, 0])).toBe(160);
  expect(glideMs([0, 0], [300, 400])).toBe(345);
  expect(glideMs([0, 0], [3000, 0])).toBe(520);
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
