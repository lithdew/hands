import { describe, expect, test } from "bun:test";
import { keyCall, routeRequest, titleForPlanner, type Triage } from "./jev";
import { pageObservation, READ_PAGE, selectScript } from "./observe";

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
    expect(at({ ...dump, elements: [{ ...field, x: 600 }, link] })).not.toBe(at(dump));
    expect(at({ ...dump, elements: [{ ...field, w: 600 }, link] })).not.toBe(at(dump));
    expect(at({ ...dump, elements: [{ ...field, within: "different form" }, link] })).not.toBe(at(dump));
    expect(at({ ...dump, url: "https://en.wikipedia.org/wiki/Capybara" })).not.toBe(at(dump));
  });
});

describe("dropdowns", () => {
  const party = { role: "combo box", name: "Party size", value: "2 people", editable: false, focused: false, within: "Find a table", x: 10, y: 10, w: 120, h: 30, options: ["1 person", "2 people", "3 people"] };
  test("a native dropdown's choices ride along, so Jev can set it without opening it", () => {
    const obs = pageObservation({ ...dump, elements: [party, link] }, ["w"], { area: [0, 0, 100, 100], scale: 1 });
    expect(obs.elements[0]).toMatchObject({ value: "2 people", options: ["1 person", "2 people", "3 people"] });
    expect(obs.elements[1]).not.toHaveProperty("options");
  });

  test("the scripts that run in the page parse", () => {
    expect(() => new Function(`return ${READ_PAGE}`)).not.toThrow();
    expect(() => new Function(`return ${selectScript(12.5, 40, 'He said "two"')}`)).not.toThrow();
  });

  test("selectScript sets the option with those words and tells the page, or says why not", () => {
    const events: string[] = [];
    const select = { value: "2", options: [{ text: " 1 person ", value: "1", disabled: false }, { text: "2 people", value: "2", disabled: false }, { text: "9 people", value: "9", disabled: true }], dispatchEvent: (e: { type: string }) => events.push(e.type) };
    const run = (option: string, hit: unknown = { closest: () => select }) => new Function("document", "Event", `return ${selectScript(5, 5, option)}`)({ elementFromPoint: () => hit }, class { constructor(public type: string) {} });
    expect(run("1 Person")).toBe("set");
    expect(select.value).toBe("1");
    expect(events).toEqual(["input", "change"]);
    expect(run("9 people")).toBe("no such option"); // disabled
    expect(run("2 people", { closest: () => null })).toBe("no dropdown there");
  });
});

describe("keyCall", () => {
  test("keys from jev/cua.ts KEYS become the calls the hand's input understands", () => {
    expect(keyCall("Return")).toEqual({ name: "press_key", args: { key: "return" } });
    expect(keyCall("shift+Tab")).toEqual({ name: "hotkey", args: { keys: ["shift", "tab"] } });
    expect(keyCall("alt+Left")).toEqual({ name: "hotkey", args: { keys: ["alt", "left"] } });
  });
});

describe("routeRequest", () => {
  const kind = (over: Partial<Triage>): Triage => ({ app: "none", sure: 0.9, onlyOpen: 0, wantsAnswer: 0, creative: 0, existingBrowser: 0, ...over });
  test("an installed application is opened, however much the request sounds like a site to open", () => {
    // quick.ts answered "open calculator" with nothing to open and "calculator" to type, and the browser took it to Google.
    expect(routeRequest(kind({ app: "calc", onlyOpen: 0.9 }), "quick")).toEqual({ to: "native", app: "calc" });
    expect(routeRequest(kind({ app: "calc" }), null)).toEqual({ to: "native", app: "calc" });
    expect(routeRequest(kind({ app: "mspaint", creative: 0.9 }), null)).toEqual({ to: "native", app: "mspaint" }); // "draw a cat in paint": open it, then the vision agent
  });
  test("the user's own signed-in browser, asked for by name, is never swapped for the hand's private one", () => {
    expect(routeRequest(kind({ app: "browser", existingBrowser: 0.9 }), "recipe")).toMatchObject({ to: "vision" }); // even an email Jev could set up alone
    expect((routeRequest(kind({ existingBrowser: 0.9 }), null) as { why: string }).why).toContain("mode: existing");
  });
  test("a recipe Jev knows wins over an application the words also suggest", () => {
    expect(routeRequest(kind({ app: "stickynotes" }), "recipe")).toEqual({ to: "browser", plan: false });
    expect(routeRequest(kind({ app: "stickynotes" }), "learned")).toEqual({ to: "browser", plan: false });
  });
  test("what is made by eye or by taste is not Jev's, and an unsure application pick is not acted on", () => {
    expect(routeRequest(kind({ app: "none", creative: 0.8 }), null).to).toBe("vision");
    expect(routeRequest(kind({ app: "mspaint", sure: 0.4, creative: 0.8 }), null).to).toBe("vision");
    expect(routeRequest(kind({ app: "mspaint", sure: 0.4 }), null)).toEqual({ to: "browser", plan: true });
  });
  test("the web is the pilot's: a site to open needs no plan, the rest is planned, and a failed triage still gets a plan", () => {
    expect(routeRequest(kind({ app: "browser" }), "quick")).toEqual({ to: "browser", plan: false });
    expect(routeRequest(kind({ app: "browser" }), null)).toEqual({ to: "browser", plan: true });
    expect(routeRequest(null, null)).toEqual({ to: "browser", plan: true });
  });
});

describe("titleForPlanner", () => {
  test("the planner learns which site the user is looking at, not their address", () => {
    expect(titleForPlanner("Inbox (3) - chi.li@example.com - Gmail")).toBe("Inbox (3) - [address] - Gmail");
    expect(titleForPlanner("Capybara - Wikipedia")).toBe("Capybara - Wikipedia");
  });
});
