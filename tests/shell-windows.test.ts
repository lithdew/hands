import { expect, test } from "bun:test";
import { type Header, type Monitor, padBytes, placement, primaryFirst, recycle, talkKey, talkKeyName, usable, watchKey } from "../src/shell-windows.ts";

/** A keyboard and mouse: which virtual keys are down, and a clock the test moves. The talk key is right Ctrl unless it says otherwise. */
const keyboard = (key = 0xa3) => {
  const down = new Set<number>();
  let now = 0;
  const heard: string[] = [];
  const watch = watchKey((talk) => heard.push(talk), (vk) => down.has(vk), key, () => now);
  /** Poll as the pump does, every 8 ms, for `ms`. */
  const hold = (ms: number) => {
    for (let t = 0; t < ms; t += 8) {
      watch.poll();
      now += 8;
    }
  };
  return { down, heard, watch, hold };
};

test("the talk key is a press only once it has been held alone for a fifth of a second: then down, and up when let go", () => {
  const k = keyboard();
  k.down.add(0xa3);
  k.hold(150);
  expect(k.heard).toEqual([]); // nothing to see yet: no hush, no caption, no connect
  k.hold(100);
  expect(k.heard).toEqual(["down"]);
  k.hold(400);
  k.down.delete(0xa3);
  k.hold(16);
  expect(k.heard).toEqual(["down", "up"]);
});

test("a tap is nothing at all", () => {
  const k = keyboard();
  k.down.add(0xa3);
  k.hold(120);
  k.down.delete(0xa3);
  k.hold(400);
  expect(k.heard).toEqual([]);
});

test("a shortcut or a click with the key, before it is a press, drops it without a sign", () => {
  for (const other of [0x43, 0x01, 0x02, 0x04, 0x05, 0x06, 0x10]) {
    const k = keyboard();
    k.down.add(0xa3);
    k.hold(40);
    k.down.add(other); // Ctrl+C, a Ctrl+click with any button, Ctrl+Shift
    k.hold(600);
    k.down.delete(0xa3);
    k.hold(16);
    expect(k.heard).toEqual([]);
  }
});

test("typing once it is a press cancels once; a modifier, or a key that was already down, does not", () => {
  const k = keyboard();
  k.down.add(0x41); // an A held before the talk key
  k.down.add(0xa3);
  k.hold(240);
  k.down.add(0x10); // Shift
  k.hold(40);
  expect(k.heard).toEqual(["down"]);
  k.down.add(0x42);
  k.hold(16);
  k.down.add(0x43);
  k.hold(16);
  k.down.delete(0xa3);
  k.hold(16);
  expect(k.heard).toEqual(["down", "cancel"]);
});

test("a click once it is a press cancels it: holding Ctrl to pick several files is not talking", () => {
  const k = keyboard();
  k.down.add(0xa3);
  k.hold(400);
  k.down.add(0x01);
  k.hold(16);
  expect(k.heard).toEqual(["down", "cancel"]);
});

test("left Ctrl is not a press when AltGr sends it, and right Alt is one despite the left Ctrl AltGr sends with it", () => {
  const left = keyboard(0xa2);
  left.down.add(0xa2).add(0x11); // AltGr: a left Ctrl first, as the layout sends it
  left.hold(16);
  left.down.add(0xa5).add(0x12); // then right Alt
  left.hold(600);
  expect(left.heard).toEqual([]);

  const right = keyboard(0xa5);
  right.down.add(0xa2).add(0x11).add(0xa5).add(0x12);
  right.hold(240);
  expect(right.heard).toEqual(["down"]);
});

test("a modifier already down makes the talk key part of a chord, whichever came first: AltGr all at once, Shift then Ctrl, Win then Ctrl", () => {
  const altGr = keyboard(0xa2);
  altGr.down.add(0xa2).add(0x11).add(0xa5).add(0x12); // as AltGr arrives: its left Ctrl and right Alt in the same instant
  altGr.hold(600);
  altGr.down.add(0x51); // the Q of an @
  altGr.hold(16);
  expect(altGr.heard).toEqual([]);

  const shift = keyboard(0xa2);
  shift.down.add(0xa0).add(0x10);
  shift.hold(40);
  shift.down.add(0xa2).add(0x11); // Ctrl+Shift, for a shortcut
  shift.hold(600);
  expect(shift.heard).toEqual([]);

  const win = keyboard(0xa2);
  win.down.add(0x5b);
  win.hold(40);
  win.down.add(0xa2).add(0x11);
  win.hold(300);
  win.down.add(0x27); // Win+Ctrl+Right: the next desktop
  win.hold(16);
  expect(win.heard).toEqual([]);

  const again = keyboard(0xa2); // and once they are let go of, the key is a press as ever
  again.down.add(0x5b);
  again.down.add(0xa2).add(0x11);
  again.hold(40);
  again.down.clear();
  again.hold(16);
  again.down.add(0xa2).add(0x11);
  again.hold(240);
  expect(again.heard).toEqual(["down"]);
});

test("the Windows key going down during a press is a modifier, not typing", () => {
  const k = keyboard(0xa2);
  k.down.add(0xa2).add(0x11);
  k.hold(240);
  k.down.add(0x5b);
  k.hold(40);
  expect(k.heard).toEqual(["down"]);
});

test("a faked hold is a press at once, and typing under it is not a cancel", () => {
  const k = keyboard();
  k.watch.fake(true);
  k.hold(8);
  expect(k.heard).toEqual(["down"]);
  k.down.add(0x42);
  k.hold(300);
  k.watch.fake(false);
  k.hold(8);
  expect(k.heard).toEqual(["down", "up"]);
});

test("the talk key is left Ctrl unless HANDS_KEY names another, and is named as the user would name it", () => {
  expect(talkKey(undefined)).toBe(0xa2);
  expect(talkKey("right-alt")).toBe(0xa5);
  expect(talkKey("F8")).toBe(0x77);
  expect(talkKey("119")).toBe(119);
  expect(talkKey("nonsense")).toBe(0xa2);
  expect([0xa2, 0xa3, 0xa5, 0x77, 0x7b, 0x4b].map(talkKeyName)).toEqual(["left Ctrl", "right Ctrl", "right Alt", "F8", "F12", "K"]);
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

test("silence goes to the speaker in 10 ms steps, so its headers come in a few sizes and are used again", () => {
  expect(padBytes(0)).toBe(0);
  expect(padBytes(4)).toBe(0);
  expect(padBytes(137.3)).toBe(padBytes(140));
  expect(padBytes(10)).toBe(480); // 10 ms of 24 kHz, 16-bit
  const sizes = new Set<number>();
  for (let ms = 0; ms <= 200; ms += 0.37) sizes.add(padBytes(ms));
  expect(sizes.size).toBe(21);
});

const monitor = (bounds: Monitor["bounds"], work: Monitor["work"], primary = false): Monitor => ({ bounds, work, primary });

test("the panel's display 0 is the primary one, as it is for the hands, wherever the system lists it", () => {
  const side = monitor([-1920, 0, 0, 1080], [-1920, 0, 0, 1040]);
  const main = monitor([0, 0, 2560, 1600], [0, 0, 2560, 1552], true);
  expect(primaryFirst([side, main])).toEqual([main, side]);
});

test("the panel is one fixed box, the page's width by all the height there is, in the bottom right corner clear of the taskbar", () => {
  const main = monitor([0, 0, 2560, 1600], [0, 0, 2560, 1528], true); // a taskbar that stays: the work area leaves it out already
  expect(usable(main, null, 1.5)).toEqual([0, 0, 2560, 1528]);
  expect(placement([0, 0, 2560, 1528], 1.5)).toEqual({ x: 2560 - 12 - 900, y: 12, w: 900, h: 1528 - 24 });
  // A taskbar that hides is not left out of the work area, and slides up over the corner: it is cleared by all of it, even while hidden.
  const hiding = monitor([0, 0, 2560, 1600], [0, 0, 2560, 1600], true);
  expect(usable(hiding, { edge: 3, rect: [0, 1528, 2560, 1600] }, 1.5)).toEqual([0, 0, 2560, 1528]);
  expect(usable(hiding, { edge: 3, rect: [0, 1598, 2560, 1600] }, 1.5)).toEqual([0, 0, 2560, 1600 - 72]);
  expect(usable(hiding, { edge: 2, rect: [2488, 0, 2560, 1600] }, 1.5)).toEqual([0, 0, 2488, 1600]);
  expect(usable(hiding, { edge: 3, rect: [2560, 1528, 4480, 1600] }, 1.5)).toEqual([0, 0, 2560, 1600]); // on another display
});
