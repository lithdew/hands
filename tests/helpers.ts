/** What conftest.py gave every test, plus the net that keeps a test from ever driving the machine. */

import { spyOn } from "bun:test";
import type { ChoiceAnswer } from "../src/decide.ts";
import * as macos from "../src/macos.ts";
import { type Item, item, type Screen } from "../src/models.ts";

/** A 2000x1200 capture at two pixels a point. No test decodes it, so the path names nothing. */
export const screen = (overrides: Partial<Screen> = {}): Screen => ({
  image: { path: "/nonexistent/capture.png", width: 2000, height: 1200 },
  scale: 2,
  app: "Google Chrome",
  field: null,
  url: null,
  pid: null,
  window: null,
  origin: [0, 0],
  axRefs: new Map(),
  offscreen: [],
  ...overrides,
});

export const makeItem = (index: number, text: string, { x1 = 100, y1 = 100, x2 = 400, y2 = 130, conf = 1 } = {}): Item =>
  item(index, text, conf, [x1, y1, x2, y2]);

export const answer = (choice: string, confidence: number, probabilities?: Record<string, number>): ChoiceAnswer => ({
  type: "choice",
  choice,
  confidence,
  probabilities: probabilities ?? { [choice]: confidence },
});

const PURE = ["interrupt", "quoted", "offDisplay", "subtreeKey", "clickable", "descendantLabel", "walkActionable"];

/**
 * Every function of macos.ts that is not pure, replaced by a failure: the mouse, the keyboard, AppleScript,
 * and the reads too, so a function added later is caught without being listed here. Bun rewrites the export
 * itself, so the calls macos.ts makes to its own functions are caught as well. A test fakes the ones it
 * expects on top of this, and `mock.restore()` in afterEach puts the real ones back.
 */
export function guardMachine(): void {
  for (const [name, value] of Object.entries(macos)) {
    if (typeof value !== "function" || PURE.includes(name)) continue;
    spyOn(macos, name as "clickAt").mockImplementation(() => {
      throw new Error(`${name} reached the real machine`);
    });
  }
}
