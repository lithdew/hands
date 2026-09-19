import { expect, test } from "bun:test";
import { createSemanticComputer, type Element, type Snapshot } from "../semantic-computer";
import type { ExistingBrowserSnapshot } from "./browser";
import { existingBrowserElements, existingBrowserTexts } from "./semantic";

type Ref = ExistingBrowserSnapshot["refs"][number];
const control = (ref: string, role: string, name: string, extra: Partial<Ref> = {}): Ref => ({
  ref, role, name, actions: ["click"], visibility: "in_viewport", ...extra,
});
const text = (result: { content: { type: string; text?: string }[] }) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

test("cached continuation content is bounded read-only evidence and never creates input aliases", async () => {
  const texts = existingBrowserTexts({ outline: "Other page text", content: [{ role: "statictext", name: "recipient@example.test" }],
    coverage: { complete: false, selectedNodes: 600, totalNodes: 900, omitted: { budget: 300 }, continuation: "limit-reached" } });
  const snapshot: Snapshot = { identity: "browser", kind: "browser", title: "Draft", texts, elements: [], binding: {} };
  let inputs = 0;
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => snapshot, act: async () => { inputs++; } });
  const observed = await computer.browser({ action: "snapshot" });
  expect(text(observed)).toContain("incomplete"); expect(text(observed)).toContain("600/900");
  expect(text(observed)).toContain("cached continuation limit-reached"); expect(text(observed)).toContain("recipient@example.test");
  expect(text(observed)).toContain("has no input references"); expect(observed.details.refs).toBe(0);
  await expect(computer.browser({ action: "click", ref: "p1:0" })).rejects.toThrow("stale"); expect(inputs).toBe(0);
  const large = existingBrowserTexts({ outline: "line\n".repeat(500), content: Array.from({ length: 600 }, (_, i) => ({ role: "text", name: i === 599 ? "late-recipient@example.test" : "x".repeat(1000), value: "y".repeat(1000) })) });
  expect(large.length).toBeLessThanOrEqual(640); expect(Buffer.byteLength(large.join("\n"))).toBeLessThan(300_000);
  let reads = 0;
  const bounded = createSemanticComputer({ windows: async () => [], observe: async () => { reads++; return { ...snapshot, texts: large }; }, act: async () => {} });
  const first = await bounded.browser({ action: "snapshot" });
  expect(Buffer.byteLength(text(first))).toBeLessThan(7000); expect(text(first)).not.toContain("late-recipient@example.test");
  expect(text(first)).toContain("[name truncated]");
  const queried = await bounded.browser({ action: "query", query: "late-recipient@example.test" });
  expect(text(queried)).toContain("late-recipient@example.test"); expect(queried.details.refs).toBe(0); expect(reads).toBe(1);
});

test("a long inbox retains editable fields and unique buttons inside the observation budget, with exact source refs", async () => {
  const body = "First line\n\n" + "Complete unmodified draft text. ".repeat(60);
  const refs: Ref[] = [
    ...Array.from({ length: 230 }, (_, i) => control(`cua:${i}`, "row", `Message ${i}: ${"message preview ".repeat(20)}`)),
    ...Array.from({ length: 50 }, (_, i) => control(`cua:star:${i}`, "button", "Add star")),
    ...Array.from({ length: 10 }, (_, i) => control(`cua:image:${i}`, "image", `Avatar ${i}`)),
    control("cua:recipient", "textbox", "To", { actions: ["type"], value: "alpha@example.test" }),
    control("cua:subject", "textbox", "Subject", { actions: ["type"], value: "Draft subject" }),
    control("cua:body", "textbox", "Message body", { actions: ["type"], value: body, states: { focused: true } }),
    control("cua:compose", "button", "Compose"), control("cua:send", "button", "Send"),
  ];
  const original = structuredClone(refs), elements = existingBrowserElements(refs);
  expect(refs).toEqual(original);
  expect(elements).toHaveLength(refs.length);
  expect(elements.find((element) => element.key === "cua:body")?.value).toBe(body);
  const calls: Element[] = [];
  const snapshot: Snapshot = { identity: "bound-browser", kind: "browser", title: "Inbox", texts: [], binding: {}, elements };
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => snapshot, act: async (_snapshot, _action, element) => { calls.push(element!); } });
  const first = await computer.browser({ action: "snapshot" }), visible = text(first);
  expect(visible).toContain('textbox "To"');
  expect(visible).toContain('textbox "Subject"');
  expect(visible).toContain('textbox "Message body"');
  expect(visible).toContain('button "Compose"');
  expect(visible).toContain('button "Send"');
  expect(visible).toContain("More controls omitted");
  expect(Buffer.byteLength(visible)).toBeLessThan(24_000);
  const send = visible.match(/\[(p\d+:\d+)\] button "Send"/)![1]!;
  await computer.browser({ action: "click", ref: send });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.address).toEqual({ browser_ref: "cua:send" });
  await expect(computer.browser({ action: "click", ref: send })).rejects.toThrow("stale");
  expect(calls).toHaveLength(1);
});

test("focused and visible fields precede rows, while duplicate controls keep their original distinct refs", () => {
  const refs = [control("row", "row", "Selected thread"), control("duplicate-a", "button", "Star"),
    control("duplicate-b", "button", "Star"), control("visible", "button", "Compose"),
    control("offscreen", "textbox", "Other field", { actions: ["type"], visibility: "offscreen" }),
    control("field", "textbox", "Subject", { actions: ["type"] }),
    control("focused", "textbox", "Message body", { actions: ["type"], states: { focused: true } })];
  const elements = existingBrowserElements(refs);
  expect(elements.slice(0, 3).map((element) => element.key)).toEqual(["focused", "field", "visible"]);
  expect(elements.findIndex((element) => element.key === "row")).toBeLessThan(elements.findIndex((element) => element.key === "offscreen"));
  expect(elements.find(element => element.key === "offscreen")?.visible).toBe(false);
  expect(elements.find(element => element.key === "visible")?.visible).toBe(true);
  expect(elements.filter((element) => element.name === "Star").map((element) => element.address.browser_ref)).toEqual(["duplicate-a", "duplicate-b"]);
  expect(existingBrowserElements(refs)).toEqual(elements);
});

test("projection never promotes inferred editability or exposes protected values", () => {
  const refs = [
    control("readonly", "textbox", "Read only", { actions: ["click"], value: "unchanged" }),
    control("password", "textbox", "Account secret", { actions: ["type"], states: { protected: true }, value: "must not appear" }),
    control("password-role", "password", "Secret", { actions: ["type"], value: "must not appear" }),
    control("disabled", "button", "Disabled", { states: { disabled: true } }),
    control("static", "image", "Graphic", { actions: [] }),
  ];
  const elements = existingBrowserElements(refs);
  expect(elements.find((element) => element.key === "readonly")).toMatchObject({ editable: false, value: "unchanged" });
  for (const key of ["password", "password-role"]) expect(elements.find((element) => element.key === key)).toMatchObject({ editable: false, value: undefined });
  expect(elements.some((element) => element.key === "disabled")).toBe(false);
  expect(elements.some((element) => element.key === "static")).toBe(true);
});
