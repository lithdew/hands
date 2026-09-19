import { describe, expect, test } from "bun:test";
import { keyCall } from "./jev";
import { pageObservation } from "./observe";

const field = { role: "text field", name: "Search Wikipedia", value: "", editable: true, focused: true, within: "search", x: 268, y: 18, w: 402, h: 32 };
const link = { role: "link", name: "Donate", value: "", editable: false, focused: false, within: "navigation", x: 1088, y: 24, w: 45, h: 20 };
const dump = { url: "https://en.wikipedia.org/", title: "Wikipedia", ready: "complete", elements: [field, link], texts: ["Welcome to Wikipedia"] };

describe("pageObservation", () => {
  test("page pixels become window pixels: past the toolbar, and through the display scale", () => {
    const obs = pageObservation(dump, ["Wikipedia - Google Chrome"], { area: [2, 87, 1344, 805], scale: 1 });
    expect(obs.elements[0]).toMatchObject({ id: "e1", editable: true, focused: true, within: "search", frame: "Wikipedia - Google Chrome", rect: { x: 270, y: 105, w: 402, h: 32 } });
    const zoomed = pageObservation(dump, ["w"], { area: [0, 140, 1340, 749], scale: 0.5 });
    expect(zoomed.elements[0]!.rect).toEqual({ x: 536, y: 176, w: 804, h: 64 });
  });
  test("Jev is told the page and its address, and when it is still loading", () => {
    expect(pageObservation(dump, ["w"], { area: [0, 0, 100, 100], scale: 1 }).texts.slice(0, 3)).toEqual(["page: Wikipedia", "address: https://en.wikipedia.org/", "Welcome to Wikipedia"]);
    expect(pageObservation({ ...dump, ready: "interactive" }, ["w"], { area: [0, 0, 100, 100], scale: 1 }).texts).toContain("the page is still loading");
  });
  test("the fingerprint moves with what Jev could notice: a value, a scroll, a new page", () => {
    const at = (d: typeof dump) => pageObservation(d, ["w"], { area: [0, 0, 100, 100], scale: 1 }).fingerprint;
    expect(at(dump)).toBe(at(structuredClone(dump)));
    expect(at({ ...dump, elements: [{ ...field, value: "capybara" }, link] })).not.toBe(at(dump));
    expect(at({ ...dump, elements: [{ ...field, y: -200 }, link] })).not.toBe(at(dump));
    expect(at({ ...dump, url: "https://en.wikipedia.org/wiki/Capybara" })).not.toBe(at(dump));
  });
});

describe("keyCall", () => {
  test("keys from jev/cua.ts KEYS become the calls the hand's input understands", () => {
    expect(keyCall("Return")).toEqual({ name: "press_key", args: { key: "return" } });
    expect(keyCall("shift+Tab")).toEqual({ name: "hotkey", args: { keys: ["shift", "tab"] } });
    expect(keyCall("alt+Left")).toEqual({ name: "hotkey", args: { keys: ["alt", "left"] } });
  });
});
