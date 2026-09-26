import { expect, test } from "bun:test";
import { macSeat } from "../src/macos-seat.ts";
import { onWindows, rendererCommand, seat } from "../src/platform.ts";
import { windowsSeat } from "../src/windows-seat.ts";

test("the platform is the OS, except that a test is the Mac and HANDS_PLATFORM has the last word", () => {
  expect(onWindows({}, "win32")).toBe(true);
  expect(onWindows({}, "darwin")).toBe(false);
  expect(onWindows({ NODE_ENV: "test" }, "win32")).toBe(false);
  expect(onWindows({ NODE_ENV: "test", HANDS_PLATFORM: "windows" }, "darwin")).toBe(true);
  expect(onWindows({ HANDS_PLATFORM: "macos" }, "win32")).toBe(false);
  expect(onWindows()).toBe(false); // bun test sets NODE_ENV=test, so the fakes of macos.ts are what every test drives
});

test("the seat is the platform's: a test's is the Mac's, which sends chords from behind; Windows' borrows the seat for them", () => {
  expect(seat).toBe(macSeat);
  expect(macSeat.chordsFromBehind).toBe(true);
  expect(windowsSeat.chordsFromBehind).toBe(false);
  expect(windowsSeat.browserKeysFromBehind).toBe(true);
});

test("on the Mac the hand is drawn by hand.ts itself, run by this same bun", () => {
  const [exe, script] = rendererCommand();
  expect(exe).toBe(process.execPath);
  expect(script).toMatch(/[\\/]src[\\/]hand\.ts$/);
});
