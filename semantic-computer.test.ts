import { expect, test } from "bun:test";
import { createSemanticComputer, diffLines, type Snapshot } from "./semantic-computer";

const page = (): Snapshot => ({ kind: "browser", identity: "1:2:https://example.test", title: "Search", url: "https://example.test/", texts: ["Ready"], binding: {}, elements: [
  { key: "search", role: "textbox", name: "Search", value: "", editable: true, address: { x: 1, y: 2 } },
  { key: "save", role: "button", name: "Save", within: "Notifications", address: { x: 3, y: 4 } },
] });

test("an action returns fresh state and references; old or hidden refs never reach input", async () => {
  const state = page(), inputs: unknown[] = [];
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => structuredClone(state), act: async (_s, action) => { inputs.push(action); state.texts = ["Search complete"]; } });
  await expect(computer.act({ action: "click", ref: "p1:1" })).rejects.toThrow("Look");
  await computer.look({ what: "window" });
  const done = await computer.act({ action: "click", ref: "p1:1" });
  expect(JSON.stringify(done.content)).toContain("Search complete");
  expect(JSON.stringify(done.content)).toContain("p2:1");
  await expect(computer.act({ action: "click", ref: "p1:1" })).rejects.toThrow("stale");
  await computer.look({ what: "window", query: "Search" });
  await expect(computer.act({ action: "click", ref: "p3:1" })).rejects.toThrow("not shown");
  expect(inputs).toHaveLength(1);
});

test("the action gate receives the actual scoped control, not just an opaque ref", async () => {
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => page(), act: async () => {} });
  await computer.look({ what: "window" });
  expect(computer.describe("computer_act", { action: "click", ref: "p1:1" })).toMatchObject({ control: 'button "Save" in "Notifications"', url: "https://example.test/" });
  await expect(computer.act({ action: "type", ref: "p1:1", text: "oops" })).rejects.toThrow("not editable");
});

test("failed observations invalidate references and a failed action is never retried", async () => {
  let failRead = false, attempts = 0;
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => { if (failRead) throw new Error("unavailable"); return page(); }, act: async () => { attempts++; throw new Error("unconfirmed effect"); } });
  await computer.look({ what: "window" });
  failRead = true;
  await expect(computer.look({ what: "window" })).rejects.toThrow("unavailable");
  await expect(computer.act({ action: "click", ref: "p1:1" })).rejects.toThrow("Look");
  failRead = false; await computer.look({ what: "window" });
  await expect(computer.act({ action: "click", ref: "p2:1" })).rejects.toThrow("unconfirmed");
  expect(attempts).toBe(1);
  await expect(computer.act({ action: "click", ref: "p2:1" })).rejects.toThrow("Look");
});

test("cancellation and instruction changes stop input; navigation stays http(s)", async () => {
  let changed = false, inputs = 0;
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => page(), act: async () => { inputs++; } }, () => { if (changed) throw new Error("instruction changed"); });
  await computer.browser({ action: "snapshot" });
  await expect(computer.browser({ action: "navigate", url: "javascript:alert(1)" })).rejects.toThrow("http(s)");
  changed = true;
  await expect(computer.act({ action: "click", ref: "p1:1" })).rejects.toThrow("instruction changed");
  changed = false;
  await expect(computer.act({ action: "click", ref: "p1:1" })).rejects.toThrow("Look");
  await expect(computer.act({ action: "click", ref: "p1:1" }, AbortSignal.abort())).rejects.toThrow();
  expect(inputs).toBe(0);
});

test("a windows-only observation also expires the previous control references", async () => {
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => page(), act: async () => { throw new Error("must not act"); } });
  await computer.look({ what: "window" });
  await computer.look({ what: "windows" });
  await expect(computer.act({ action: "click", ref: "p1:1" })).rejects.toThrow("Look");
});

test("large Unicode observations and action diffs stay below the text budget", async () => {
  const state = page();
  state.title = "界".repeat(1000); state.url = `https://example.test/${"界".repeat(1000)}`;
  state.texts = Array.from({ length: 100 }, (_, i) => `${i}${"🐈".repeat(600)}`);
  state.elements = Array.from({ length: 400 }, (_, i) => ({ key: String(i), role: "button", name: `${i}${"界".repeat(300)}`, within: "界".repeat(300), value: "界".repeat(300), address: {} }));
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => structuredClone(state), act: async () => {
    state.texts = state.texts.map((text) => `Changed ${text}`);
    state.elements = state.elements.map((element) => ({ ...element, name: `Changed ${element.name}` }));
  } });
  const first = await computer.look({ what: "window" });
  const second = await computer.act({ action: "click", ref: "p1:0" });
  for (const observation of [first, second]) {
    const text = observation.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    expect(Buffer.byteLength(text)).toBeLessThan(24_000);
    expect(text).toContain("omitted");
  }
  expect(second.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("State changed") });
});

test("diffs count duplicate labels and do not call unchanged state a success", async () => {
  expect(diffLines(["Save", "Save"], ["Save"])).toEqual({ added: [], removed: ["Save"] });
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => page(), act: async () => {} });
  await computer.look({ what: "window" });
  expect(JSON.stringify((await computer.act({ action: "click", ref: "p1:1" })).content)).toContain("does not prove the action worked");
});
