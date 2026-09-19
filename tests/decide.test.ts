import { expect, test } from "bun:test";
import { SITES } from "../src/config.ts";
import { baseState, Decision, itemCriteria, kindCriteria, offscreenCriteria, siteCriteria } from "../src/decide.ts";
import type { AxNode } from "../src/models.ts";
import { answer, makeItem, screen } from "./helpers.ts";

test("decision click uses item and min confidence", () => {
  const d = new Decision(answer("click_item", 0.9), answer("12", 0.6), answer("none", 1.0));
  expect(d.clicking).toBe(true);
  expect(d.chosen).toBe("12");
  expect(d.confidence).toBe(0.6);
  expect(d.stops).toBe(false);
});

test("decision fixed action ignores item", () => {
  const d = new Decision(answer("use_browser", 0.8), answer("3", 0.1), answer("github", 0.9));
  expect(d.clicking).toBe(false);
  expect(d.chosen).toBe("use_browser");
  expect(d.confidence).toBe(0.8);
});

test("decision use_browser ignores a split site answer", () => {
  const d = new Decision(answer("use_browser", 0.88), null, answer("other", 0.45));
  expect(d.chosen).toBe("use_browser");
  expect(d.confidence).toBe(0.88);
});

test("decision stops on done or none", () => {
  expect(new Decision(answer("done", 0.9), null, answer("none", 1)).stops).toBe(true);
  expect(new Decision(answer("none", 0.9), null, answer("none", 1)).stops).toBe(true);
});

test("decision press_offscreen uses the offscreen answer and min confidence", () => {
  const d = new Decision(answer("press_offscreen", 0.9), answer("3", 0.9), answer("none", 1.0), answer("7", 0.5));
  expect(d.pressingOffscreen).toBe(true);
  expect(d.clicking).toBe(false);
  expect(d.chosen).toBe("offscreen:7");
  expect(d.confidence).toBe(0.5);
});

test("decision ignores an offscreen answer for any other kind", () => {
  const d = new Decision(answer("click_item", 0.9), answer("3", 0.8), answer("none", 1.0), answer("7", 0.1));
  expect(d.pressingOffscreen).toBe(false);
  expect(d.chosen).toBe("3");
  expect(d.confidence).toBe(0.8);
});

test("kind criteria offers press_offscreen only when there are offscreen controls", () => {
  expect(kindCriteria("Google Chrome", null)).not.toHaveProperty("press_offscreen");
  expect(kindCriteria("Google Chrome", null, true)).toHaveProperty("press_offscreen");
});

test("offscreen criteria and state name the role and say it is not visible", () => {
  const nodes: AxNode[] = [
    { role: "AXLink", label: "Register Now", x: 0, y: -4200, w: 120, h: 32, pressable: true },
    { role: "AXRow", label: "Note 900", x: 0, y: 42718, w: 280, h: 68, pressable: true },
  ];
  expect(offscreenCriteria(nodes)).toEqual({
    "0": "link 'Register Now' (not visible)",
    "1": "cell 'Note 900' (not visible)",
  });
  const state = baseState("buy the thing", screen({ offscreen: nodes }), [makeItem(0, "Buy")], []);
  expect(state.offscreen_controls).toEqual([
    { k: 0, role: "link", label: "Register Now" },
    { k: 1, role: "cell", label: "Note 900" },
  ]);
  expect(baseState("buy the thing", screen(), [makeItem(0, "Buy")], [])).not.toHaveProperty("offscreen_controls");
});

test("kind criteria offers one browser action", () => {
  const crit = kindCriteria("Google Chrome", null);
  expect(crit).toHaveProperty("use_browser");
  expect(crit).not.toHaveProperty("switch_to_browser");
  expect(crit).not.toHaveProperty("open_site");
  expect(crit.use_browser).toContain("Google Chrome");
  expect(crit.use_browser).toContain("address bar");
});

test("site criteria covers the catalog, a site outside it, and no site", () => {
  const crit = siteCriteria();
  expect(crit.github).toBe(SITES.github!);
  expect(crit.other).toContain("not one of the sites named in this list");
  expect(crit.none).toContain("already open");
});

test("kind criteria offers email only when set", () => {
  expect(kindCriteria("Google Chrome", null)).not.toHaveProperty("type_email");
  expect(kindCriteria("Google Chrome", "user@example.com")).toHaveProperty("type_email");
  expect(kindCriteria("Google Chrome", null)).toHaveProperty("click_item");
});

test("item criteria and state carry region and dates", () => {
  const items = [makeItem(0, "Sale ends Oct 1, 2099", { y1: 100, y2: 130 }), makeItem(1, "Buy", { y1: 140, y2: 170 })];
  const crit = itemCriteria(screen(), items);
  expect(crit["0"]).toStartWith("'Sale ends Oct 1, 2099' (top-left; dated 2099-10-01");
  expect(crit["1"]).toContain("near a line dated 2099-10-01");
  const state = baseState("buy the thing", screen(), items, ["opened https://example.com/"]);
  expect(state.goal).toBe("buy the thing");
  expect(state.previous_actions).toEqual(["opened https://example.com/"]);
  expect(state.screen_items_in_reading_order[1]?.when).toStartWith("near a line dated");
  expect(state.now).toHaveProperty("today");
});
