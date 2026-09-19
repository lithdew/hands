import { describe, expect, test } from "bun:test";
import { frontWindow, handFor, signInLine, adoptable } from "./desktop";
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

describe("signing in", () => {
  test("tells the user what to do while the window is open, and what came of it", () => {
    expect(signInLine(1, { state: "waiting", sites: null })).toBe("");
    expect(signInLine(1, { state: "open", sites: null })).toContain("close the window");
    expect(signInLine(2, { state: "done", sites: ["Google", "GitHub"] })).toBe("Hand 2 is signed in to: Google, GitHub.");
    expect(signInLine(2, { state: "done", sites: [] })).toContain("none of the sign-ins Puk knows");
    expect(signInLine(2, { state: "done", sites: null })).toContain("bun win/desktop.ts sessions 2");
    expect(signInLine(3, { state: "error", sites: null, error: "Hand 3's browser did not close." })).toBe("Hand 3: Hand 3's browser did not close.");
  });
  test("a hand by number needs no desktop: the bench keeps its own name", () => {
    expect(handFor(2).display).toBe("Puk hand 2");
    expect(handFor(99).display).toBe("Puk bench");
  });
});

describe("adoptable", () => {
  const w = (app: string, title: string, size = 800, iconic = false) => ({ app, title, rect: [0, 0, size, size] as [number, number, number, number], iconic });
  test("an application left on the hand's desktop by an earlier run is used again, not opened a second time", () => {
    const left = [w("chrome", "about:blank - Google Chrome"), w("ApplicationFrameHost", "Calculator", 400), w("CalculatorApp", "Calculator", 500), w("mspaint", "Untitled - Paint")];
    expect(adoptable(left, "Calculator")?.app).toBe("CalculatorApp");
    expect(adoptable(left, "Paint")?.title).toBe("Untitled - Paint");
    expect(adoptable(left, "Notepad")).toBeUndefined();
  });
  test("a lookalike is not the application, and a minimised window is not adopted", () => {
    expect(adoptable([w("PaintStudio.View", "Paint 3D")], "Paint")).toBeUndefined();
    expect(adoptable([w("notepad++", "new 1 - Notepad++")], "Notepad")).toBeUndefined();
    expect(adoptable([w("mspaint", "Untitled - Paint", 800, true)], "Paint")).toBeUndefined();
    expect(adoptable([w("charmap", "Character Map")], "Character Map")?.app).toBe("charmap");
  });
});
