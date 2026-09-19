import { describe, expect, test } from "bun:test";
import type { Llm } from "../jev/openai";
import { planTasks } from "../jev/plan";
import type { ScreenAction } from "../jev/screen";
import { isNative, nativeObservation, nativeRequest, pulledUser, type NativeDump, type NativeNode } from "./uia";

const node = (over: Partial<NativeNode>): NativeNode => ({ n: 0, role: "button", name: "Save", value: "", within: "", editable: false, setValue: false, focused: false, enabled: true, can: "invoke", rect: [10, 20, 80, 30], ...over });
// Paint on a desktop nobody is looking at, as win/uia.probe.ts read it.
const paint: NativeDump = { frame: [0, 0, 1200, 800], seen: 94, ms: 83, texts: ["1734 × 1361px"], elements: [
  node({ n: 0, role: "button", name: "Close", within: "Untitled - Paint" }), node({ n: 1, role: "menu", name: "File" }), node({ n: 2, role: "app bar button", name: "Save" }),
  node({ n: 3, role: "radio button", name: "Color 1: Black", value: "selected", within: "Colors", can: "select" }), node({ n: 4, role: "list item", name: "Red", within: "Colors" }),
  node({ n: 5, role: "edit", name: "Width", value: "1734", editable: true, setValue: true, can: "" }), node({ n: 6, role: "button", name: "Paste", enabled: false }),
] };

describe("nativeObservation", () => {
  const obs = nativeObservation(paint, "Untitled - Paint");
  test("controls become the elements Jev already reads: role words, container, value, in tree order", () => {
    expect(obs.elements.map((e) => `${e.id} ${e.role} ${e.name}`)).toEqual(["n0 button Close", "n1 menu File", "n2 app bar button Save", "n3 radio button Color 1: Black", "n4 list item Red", "n5 text field Width"]);
    expect(obs.elements[0]!.within).toBe("title bar"); // the window's own name tells nothing
    expect(obs.elements[3]).toMatchObject({ within: "Colors", value: "selected" });
    expect(obs.elements[5]).toMatchObject({ editable: true, value: "1734", rect: { x: 10, y: 20, w: 80, h: 30 } });
    expect(obs.texts).toEqual(["window: Untitled - Paint", "1734 × 1361px"]);
  });
  test("a control that is greyed out is not offered, and ids stay the helper's own numbers", () => {
    expect(obs.elements.some((e) => e.name === "Paste")).toBe(false);
    expect(nativeObservation({ ...paint, elements: [node({ n: 41, name: "OK" })] }, "w").elements[0]!.id).toBe("n41");
  });
  test("a menu bar is not an open menu: jev/screen.ts answers 'menu item' before anything else", () => {
    expect(obs.elements.some((e) => /^(option|menu ?item|listitem|gridcell)$/i.test(e.role))).toBe(false);
  });
  test("the fingerprint moves with a value, not with the read time", () => {
    const again = nativeObservation({ ...paint, ms: 5 }, "Untitled - Paint");
    expect(again.fingerprint).toBe(obs.fingerprint);
    expect(nativeObservation({ ...paint, elements: paint.elements.map((e) => (e.n === 5 ? { ...e, value: "800" } : e)) }, "Untitled - Paint").fingerprint).not.toBe(obs.fingerprint);
  });
});

describe("nativeRequest", () => {
  const target = (id: string) => nativeObservation(paint, "Untitled - Paint").elements.find((e) => e.id === id)!;
  const click = (id: string, button: "left" | "right" = "left"): ScreenAction => ({ kind: "click", target: target(id), button, count: 1 });
  test("a click is the control's own pattern, and typing is SetValue: neither needs the pointer or the focus", () => {
    expect(nativeRequest(77, paint.elements[2], click("n2"))).toBe("act 77 2 invoke");
    expect(nativeRequest(77, paint.elements[3], click("n3"))).toBe("act 77 3 select");
    expect(nativeRequest(77, paint.elements[5], { kind: "type", target: target("n5"), input: "width", text: "800", submit: false })).toBe(`set 77 5 ${Buffer.from("800").toString("base64")}`);
    expect(nativeRequest(77, paint.elements[5], { kind: "type", target: target("n5"), input: "width", text: "", submit: false })).toBe("set 77 5 -");
  });
  test("what cannot be done in the background is refused, not sent to the user's screen", () => {
    expect(() => nativeRequest(77, paint.elements[5], click("n5"))).toThrow(/cannot be pressed in the background/);
    expect(() => nativeRequest(77, paint.elements[2], click("n2", "right"))).toThrow(/in the background/);
    expect(() => nativeRequest(77, paint.elements[2], { kind: "type", target: target("n2"), input: "x", text: "x", submit: false })).toThrow(/cannot be typed into/);
    expect(() => nativeRequest(77, undefined, click("n2"))).toThrow(/no longer there/);
  });
  test("isNative tells a native control from a page element by its id", () => {
    expect(isNative(click("n2"))).toBe(true);
    expect(isNative({ kind: "click", target: { ...target("n2"), id: "e2" }, button: "left", count: 1 })).toBe(false);
    expect(isNative({ kind: "scroll", direction: "down" })).toBe(false);
  });
});

describe("pulledUser", () => {
  const here = { where: '"Desktop 1"', fg: "100" };
  test("an action that moved the user's desktop, or took their focus, is noticed; the user switching windows themselves is not", () => {
    expect(pulledUser(here, { where: '"Puk hand 1"', fg: "200" }, "ok")).toBe(true); // measured: SetValue on a classic edit control did this
    expect(pulledUser(here, { where: '"Desktop 1"', fg: "200" }, "ok took-focus")).toBe(true);
    expect(pulledUser(here, { where: '"Desktop 1"', fg: "200" }, "ok")).toBe(false);
    expect(pulledUser(here, here, "ok")).toBe(false);
    // Between two keys of a run the earlier note is reused: a desktop the user changed themselves in that moment is left alone.
    expect(pulledUser(here, { where: '"Desktop 2"', fg: "300" }, "ok", true)).toBe(false);
    expect(pulledUser(here, { where: '"Puk hand 1"', fg: "200" }, "ok took-focus", true)).toBe(true);
  });
});

describe("planning inside an application", () => {
  test("the planner is told which application is open, and a plan there needs no url", async () => {
    let system = "";
    const llm: Llm = async (req) => { system = req.system; return { can_do: true, tasks: [{ goal: "Choose red in Paint.", url: "", inputs: [], facts: [], steps: ["Choose 'Red' in 'Colors'."], done_when: "Color 1 is red.", avoid: [], wants_answer: false }] }; };
    const [task] = await planTasks(llm, "pick the red colour", { today: new Date(2026, 8, 19), contacts: [], app: "Paint" });
    expect(system).toContain('desktop application "Paint"');
    expect(system).not.toContain("mail.google.com");
    expect(task!.intent).toMatchObject({ launcher: "none", url: null, steps: ["Choose 'Red' in 'Colors'."] });
  });
});
