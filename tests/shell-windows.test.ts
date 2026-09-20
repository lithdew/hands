import { expect, test } from "bun:test";
import { type Header, recycle, talkKey, watchKey } from "../src/shell-windows.ts";

/** A keyboard: which virtual keys are down, and a clock the test moves. */
const keyboard = () => {
  const down = new Set<number>();
  let now = 0;
  const heard: string[] = [];
  const key = watchKey((talk) => heard.push(talk), (vk) => down.has(vk), 0xa3, () => now);
  return { down, heard, key, tick: (ms: number) => void (now += ms) };
};

test("the talk key: a hold is down then up, a tap is a cancel", () => {
  const k = keyboard();
  k.down.add(0xa3);
  k.key.poll();
  k.tick(400);
  k.key.poll();
  k.down.delete(0xa3);
  k.key.poll();
  expect(k.heard).toEqual(["down", "up"]);
  k.down.add(0xa3);
  k.key.poll();
  k.tick(100);
  k.down.delete(0xa3);
  k.key.poll();
  expect(k.heard).toEqual(["down", "up", "down", "cancel"]);
});

test("typing while the key is held cancels once; a modifier, or a key that was already down, does not", () => {
  const k = keyboard();
  k.down.add(0x41); // an A held before the talk key
  k.down.add(0xa3);
  k.key.poll();
  k.down.add(0x10); // Shift
  k.key.poll();
  expect(k.heard).toEqual(["down"]);
  k.down.add(0x42);
  k.key.poll();
  k.down.add(0x43);
  k.key.poll();
  k.tick(500);
  k.down.delete(0xa3);
  k.key.poll();
  expect(k.heard).toEqual(["down", "cancel"]);
});

test("a faked hold is a hold, and typing under it is not a cancel", () => {
  const k = keyboard();
  k.key.fake(true);
  k.key.poll();
  k.down.add(0x42);
  k.key.poll();
  k.tick(300);
  k.key.fake(false);
  k.key.poll();
  expect(k.heard).toEqual(["down", "up"]);
});

test("the talk key is left Ctrl unless HANDS_KEY names another", () => {
  expect(talkKey(undefined)).toBe(0xa2);
  expect(talkKey("right-alt")).toBe(0xa5);
  expect(talkKey("F8")).toBe(0x77);
  expect(talkKey("119")).toBe(119);
  expect(talkKey("nonsense")).toBe(0xa2);
});

test("headers the device is done with go back to the free list, in place", () => {
  const h = (done: number): Header => {
    const hdr = new Uint8Array(48);
    const view = new DataView(hdr.buffer);
    view.setUint32(24, done, true);
    return { hdr, data: new Uint8Array(4), view };
  };
  const [a, b, c] = [h(1), h(0), h(3)];
  const queued = [a, b, c];
  const free: Header[] = [];
  recycle(queued, free);
  expect(queued).toEqual([b]);
  expect(free).toEqual([c, a]);
});
