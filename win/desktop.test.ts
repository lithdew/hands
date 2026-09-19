import { describe, expect, test } from "bun:test";
import { frontWindow } from "./desktop";
import { virtualKey } from "./serve";

describe("frontWindow", () => {
  const had = (...ids: number[]) => new Set(ids);

  test("stays on the window the hand is working in, whatever the stacking says", () => {
    // Switching desktops put Paint (7) above Chrome (3); the hand was in Chrome.
    expect(frontWindow([7, 3], had(3, 7), 3)).toBe(3);
  });
  test("a window the hand did not have a moment ago takes over: a dialog, a new page", () => {
    expect(frontWindow([9, 3, 7], had(3, 7), 3)).toBe(9);
  });
  test("the first window of an empty hand is not mistaken for a dialog over another", () => {
    expect(frontWindow([3], had(), undefined)).toBe(3);
  });
  test("falls back to the top of the stack when the working window closed", () => {
    expect(frontWindow([7], had(3, 7), 3)).toBe(7);
    expect(frontWindow([], had(3), 3)).toBeUndefined();
  });
});

describe("virtualKey", () => {
  test("function keys and raw virtual-key numbers", () => {
    expect(virtualKey()).toBe(0x77);
    expect(virtualKey("f9")).toBe(0x78);
    expect(virtualKey("F24")).toBe(0x87);
    expect(virtualKey("19")).toBe(19);
  });
  test("refuses what would poll a key that does not exist", () => {
    expect(() => virtualKey("F25")).toThrow("PUK_HOTKEY");
    expect(() => virtualKey("space")).toThrow("PUK_HOTKEY");
  });
});
