import { expect, test } from "bun:test";
import { onWindows, rendererCommand } from "../src/platform.ts";

test("the platform is the OS, except that a test is the Mac and HANDS_PLATFORM has the last word", () => {
  expect(onWindows({}, "win32")).toBe(true);
  expect(onWindows({}, "darwin")).toBe(false);
  expect(onWindows({ NODE_ENV: "test" }, "win32")).toBe(false);
  expect(onWindows({ NODE_ENV: "test", HANDS_PLATFORM: "windows" }, "darwin")).toBe(true);
  expect(onWindows({ HANDS_PLATFORM: "macos" }, "win32")).toBe(false);
  expect(onWindows()).toBe(false); // bun test sets NODE_ENV=test, so the fakes of macos.ts are what every test drives
});

test("on the Mac the hand is drawn by hand.ts itself, run by this same bun", () => {
  const [exe, script] = rendererCommand();
  expect(exe).toBe(process.execPath);
  expect(script).toMatch(/[\\/]src[\\/]hand\.ts$/);
});
