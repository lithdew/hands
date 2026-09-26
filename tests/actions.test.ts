import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { type Context, clickItem, fillField, isNoop, perform, pressOffscreen } from "../src/actions.ts";
import { Decision } from "../src/decide.ts";
import * as macos from "../src/macos.ts";
import { type AxNode, type Field, fieldRecord, item, type Point } from "../src/models.ts";
import * as writing from "../src/writer.ts";
import { answer, guardMachine, screen } from "./helpers.ts";

/** Every trip to the machine, recorded instead of made. */
let calls: (["click", Point] | ["type", string] | ["focus", unknown])[];

beforeEach(() => {
  guardMachine();
  calls = [];
  spyOn(macos, "clickAt").mockImplementation(async (point) => void calls.push(["click", point]));
  spyOn(macos, "typeText").mockImplementation(async (text) => void calls.push(["type", text]));
  spyOn(macos, "axFocus").mockImplementation((ref) => (calls.push(["focus", ref]), true));
});
afterEach(() => mock.restore());

const unreachable = (why: string) => () => {
  throw new Error(why);
};

const field = (ref?: unknown, value = ""): Field => ({ role: "AXTextField", label: "Email", placeholder: "", value, x: 10, y: 20, w: 200, h: 30, ref });

const registerNow = (role = "", source: "ocr" | "ax" = "ocr") => item(3, "Register Now", source === "ax" ? 1.0 : 0.9, [100, 100, 300, 140], role, source);

const hidden = (role: string, label: string, y: number, ref: unknown): AxNode => ({ role, label, x: 0, y, w: 120, h: 32, pressable: true, ref });

test("a fake replaces the export itself, so the calls macos.ts makes to its own functions meet it too", async () => {
  spyOn(macos, "frontmostApp").mockRestore();
  spyOn(macos, "frontmostAppAndPid").mockImplementation(async () => ["Finder", 1]);
  expect(await macos.frontmostApp()).toBe("Finder");
  expect(() => macos.clearField()).toThrow("clearField reached the real machine");
});

test("an item from the accessibility tree is pressed", async () => {
  const ref = {};
  const pressed = spyOn(macos, "axPress").mockImplementation(() => true);
  const live = screen({ axRefs: new Map([[3, ref]]) });
  expect(await clickItem(registerNow("link", "ax"), live)).toBe("pressed 'Register Now' via accessibility");
  expect(pressed.mock.calls).toEqual([[ref]]);
  expect(pressed.mock.calls[0]?.[0]).toBe(ref);
  expect(calls).toEqual([]);
});

test("a refused press falls back to the mouse", async () => {
  spyOn(macos, "axPress").mockImplementation(() => false);
  const live = screen({ axRefs: new Map([[3, {}]]) });
  expect(await clickItem(registerNow("link", "ax"), live)).toBe("clicked 'Register Now' (accessibility press did not take)");
  expect(calls).toEqual([["click", [100, 60]]]);
});

test("an ocr-only item is clicked without asking accessibility", async () => {
  const pressed = spyOn(macos, "axPress").mockImplementation(unreachable("no element to press"));
  expect(await clickItem(registerNow(), screen())).toBe("clicked 'Register Now'");
  expect(calls).toEqual([["click", [100, 60]]]);
  expect(pressed).not.toHaveBeenCalled();
});

test("an off-screen control is pressed through accessibility", () => {
  const ref = {};
  const pressed = spyOn(macos, "axPress").mockImplementation(() => true);
  const live = screen({ offscreen: [hidden("AXLink", "Register Now", -4200, ref)] });
  expect(pressOffscreen("0", live)).toBe("pressed 'Register Now' (off-screen control) via accessibility");
  expect(pressed.mock.calls[0]?.[0]).toBe(ref);
  expect(pressed).toHaveBeenCalledTimes(1);
  expect(calls).toEqual([]);
});

test("a refused off-screen press is a no-op with nothing to click", () => {
  spyOn(macos, "axPress").mockImplementation(() => false);
  const refusal = pressOffscreen("0", screen({ offscreen: [hidden("AXLink", "Register Now", -4200, {})] }));
  expect(refusal).toBe("press_offscreen refused: 'Register Now' did not accept the press");
  expect(isNoop(refusal)).toBe(true);
  expect(calls).toEqual([]);
});

test("an offscreen key that names nothing is refused", () => {
  const pressed = spyOn(macos, "axPress").mockImplementation(unreachable("no element to press"));
  const refusal = pressOffscreen("4", screen());
  expect(refusal).toBe("press_offscreen refused: there is no off-screen control '4'");
  expect(isNoop(refusal)).toBe(true);
  expect(calls).toEqual([]);
  expect(pressed).not.toHaveBeenCalled();
});

const context = (writer: writing.Writer | null = null): Context => ({
  goal: "find the next upcoming bruno mars concert",
  browser: "Google Chrome",
  email: null,
  typesafe: null as unknown as TypeSafeClient,
  writer,
  history: [],
});

test("perform routes an offscreen key to the press", async () => {
  const ref = {};
  const pressed = spyOn(macos, "axPress").mockImplementation(() => true);
  const live = screen({ offscreen: [hidden("AXRow", "Note 900", 42718, ref)] });
  const decision = new Decision(answer("press_offscreen", 0.9), null, answer("none", 1), answer("0", 0.9));
  expect(decision.chosen).toBe("offscreen:0");
  expect(await perform(decision, live, [], context())).toBe("pressed 'Note 900' (off-screen control) via accessibility");
  expect(pressed.mock.calls[0]?.[0]).toBe(ref);
  expect(pressed).toHaveBeenCalledTimes(1);
});

test("a fallback click is not treated as a no-op", () => {
  expect(isNoop("clicked 'Register Now' (accessibility press did not take)")).toBe(false);
});

const browsing = (site: string) => new Decision(answer("use_browser", 0.9), null, answer(site, 0.9));

/** The trips use_browser makes, recorded, with both of them reporting success. */
function browser(): (["activate", string] | ["open", string, string])[] {
  const log: ReturnType<typeof browser> = [];
  spyOn(macos, "activate").mockImplementation(async (app) => (log.push(["activate", app]), true));
  spyOn(macos, "openUrl").mockImplementation(async (app, url) => (log.push(["open", app, url]), true));
  return log;
}

const fakeWriter: writing.Writer = unreachable("the writer is asked through composeUrl, which these tests replace");

test("use_browser with no site only brings the browser forward", async () => {
  const trips = browser();
  expect(await perform(browsing("none"), screen(), [], context())).toBe("activated Google Chrome");
  expect(trips).toEqual([["activate", "Google Chrome"]]);
});

test("use_browser opens a catalog site by its url", async () => {
  const trips = browser();
  const asked = spyOn(writing, "composeUrl").mockImplementation(unreachable("the catalog already names this site"));
  expect(await perform(browsing("github"), screen(), [], context())).toBe("opened https://github.com/");
  expect(trips).toEqual([["open", "Google Chrome", "https://github.com/"]]);
  expect(asked).not.toHaveBeenCalled();
});

test("use_browser asks the writer for a site outside the catalog", async () => {
  const trips = browser();
  const asked = spyOn(writing, "composeUrl").mockImplementation(async () => "https://www.songkick.com/");
  expect(await perform(browsing("other"), screen(), [], context(fakeWriter))).toBe("opened https://www.songkick.com/");
  expect(asked.mock.calls).toEqual([[fakeWriter, "find the next upcoming bruno mars concert", []]]);
  expect(trips).toEqual([["open", "Google Chrome", "https://www.songkick.com/"]]);
});

test("use_browser without a writer refuses a site outside the catalog", async () => {
  const trips = browser();
  const refusal = await perform(browsing("other"), screen(), [], context());
  expect(refusal).toBe("use_browser refused: the site is outside the catalog and no writer is available to propose a URL");
  expect(isNoop(refusal)).toBe(true);
  expect(trips).toEqual([]);
});

test("use_browser refuses when the writer proposes nothing", async () => {
  const trips = browser();
  spyOn(writing, "composeUrl").mockImplementation(async () => "");
  const refusal = await perform(browsing("other"), screen(), [], context(fakeWriter));
  expect(refusal).toBe("use_browser refused: the writer proposed no usable URL for this goal");
  expect(isNoop(refusal)).toBe(true);
  expect(trips).toEqual([]);
});

test("a browser that does not come to the front is a no-op", async () => {
  spyOn(macos, "activate").mockImplementation(async () => false);
  const failure = await perform(browsing("none"), screen(), [], context());
  expect(failure).toBe("use_browser failed: Google Chrome did not come to the front");
  expect(isNoop(failure)).toBe(true);
});

test("typing sets the value when the field reads it back", async () => {
  const written: string[] = [];
  spyOn(macos, "axSetValue").mockImplementation((_ref, text) => (written.push(text), true));
  spyOn(macos, "axValue").mockImplementation(() => written.at(-1) ?? null);
  const ref = {};
  expect(await fillField(field(ref), "user@example.com")).toBe("via accessibility");
  expect(written).toEqual(["user@example.com"]);
  expect(calls).toEqual([["focus", ref]]);
});

test("typing accepts a read back that ends with the text", async () => {
  spyOn(macos, "axSetValue").mockImplementation(() => true);
  spyOn(macos, "axValue").mockImplementation(() => "mailto:user@example.com");
  expect(await fillField(field({}), "user@example.com")).toBe("via accessibility");
  expect(calls).not.toContainEqual(["type", "user@example.com"]);
});

test("typing falls back to keystrokes when the value does not stick", async () => {
  spyOn(macos, "axSetValue").mockImplementation(() => true);
  spyOn(macos, "axValue").mockImplementation(() => "");
  expect(await fillField(field({}), "user@example.com")).toBe("via keystrokes");
  expect(calls.at(-1)).toEqual(["type", "user@example.com"]);
});

test("typing falls back to keystrokes when the element refuses", async () => {
  spyOn(macos, "axSetValue").mockImplementation(() => false);
  const read = spyOn(macos, "axValue").mockImplementation(unreachable("nothing was written"));
  expect(await fillField(field({}), "hello")).toBe("via keystrokes");
  expect(calls.at(-1)).toEqual(["type", "hello"]);
  expect(read).not.toHaveBeenCalled();
});

test("typing uses keystrokes when there is no element", async () => {
  const written = spyOn(macos, "axSetValue").mockImplementation(unreachable("no element to write to"));
  expect(await fillField(field(), "hello")).toBe("via keystrokes");
  expect(calls).toEqual([["type", "hello"]]);
  expect(written).not.toHaveBeenCalled();
});

test("a value the field took but formats its own way is not typed again: the field changed", async () => {
  spyOn(macos, "axSetValue").mockImplementation(() => true);
  spyOn(macos, "axValue").mockImplementation(() => "(555) 123-4567");
  expect(await fillField(field({}), "5551234567")).toBe("via accessibility");
  expect(calls).not.toContainEqual(["type", "5551234567"]);
});

/** type_text into item 1, a field of the screen's that is not the one with the focus (that one lies elsewhere). */
const typingInto = (submit = 0) => new Decision(answer("type_text", 0.9), null, null, null, { field: answer("1", 0.9), submit });
const nameField = item(1, "Name", 1, [100, 100, 300, 140], "field", "ax");
const otherFocused: Field = { role: "AXTextField", label: "Search", placeholder: "", value: "", x: 400, y: 20, w: 200, h: 30, ref: { other: true } };

test("on the seat, typing reads back the field it chose, not whichever has the focus", async () => {
  const ref = { name: true };
  const values = new Map<unknown, string>();
  spyOn(macos, "axSetValue").mockImplementation((r, text) => (values.set(r, text), true));
  spyOn(macos, "axValue").mockImplementation((r) => values.get(r) ?? "");
  const focused = spyOn(macos, "focusedField").mockImplementation(unreachable("the chosen field has an element of its own to read"));
  const live = screen({ axRefs: new Map([[1, ref]]), field: otherFocused });
  expect(await perform(typingInto(), live, [nameField], { ...context(), text: "Ada" })).toBe("typed 'Ada' into 'Name' via accessibility");
  expect(focused).not.toHaveBeenCalled();
});

test("on the seat, a listed field that is not the focused one is clicked before keystrokes, and checked by its own value", async () => {
  const ref = { name: true };
  let holds = "";
  spyOn(macos, "axSetValue").mockImplementation(() => false);
  spyOn(macos, "axPress").mockImplementation(() => false);
  spyOn(macos, "axValue").mockImplementation(() => holds);
  spyOn(macos, "typeText").mockImplementation(async (text) => void (calls.push(["type", text]), (holds = text)));
  const live = screen({ axRefs: new Map([[1, ref]]), field: otherFocused });
  expect(await perform(typingInto(), live, [nameField], { ...context(), text: "Ada" })).toBe("typed 'Ada' into 'Name' via keystrokes");
  expect(calls).toEqual([["focus", ref], ["click", [100, 60]], ["type", "Ada"]]);
  // The field that has the focus already is typed into as it is.
  calls = [];
  holds = "";
  const focusedHere: Field = { ...otherFocused, x: 50, y: 50, w: 100, h: 20, ref };
  await perform(typingInto(), screen({ axRefs: new Map([[1, ref]]), field: focusedHere }), [nameField], { ...context(), text: "Ada" });
  expect(calls).toEqual([["focus", ref], ["type", "Ada"]]);
});

test("on the seat, Return after typing goes to the field's own confirm action, and to the keyboard only when it has none", async () => {
  const ref = { name: true };
  spyOn(macos, "axSetValue").mockImplementation(() => true);
  spyOn(macos, "axValue").mockImplementation(() => "Ada");
  const confirm = spyOn(macos, "axPerform").mockImplementation(() => true);
  const pressed = spyOn(macos, "press").mockImplementation(async () => {});
  const live = screen({ axRefs: new Map([[1, ref]]), field: otherFocused });
  expect(await perform(typingInto(0.9), live, [nameField], { ...context(), text: "Ada" })).toBe("typed 'Ada' into 'Name' via accessibility, and pressed Return");
  expect(confirm.mock.calls).toEqual([[ref, "AXConfirm"]]);
  expect(pressed).not.toHaveBeenCalled();
  confirm.mockImplementation(() => false);
  await perform(typingInto(0.9), live, [nameField], { ...context(), text: "Ada" });
  expect(pressed.mock.calls).toEqual([["return"]]);
});

test("the field record leaves the element out so a run can be written", () => {
  const element: Record<string, unknown> = {};
  element.self = element; // no log can serialize it, as with the real handle
  const record = fieldRecord(field(element, "hello"));
  expect(record).not.toHaveProperty("ref");
  expect(JSON.parse(JSON.stringify(record)).value).toBe("hello");
});
