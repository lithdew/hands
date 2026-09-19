import { describe, expect, test } from "bun:test";
import { addressToUrl, browserInput, keyEvent, toCss, type Ask } from "./browser";

/** A scripted helper: records every request line and answers the DevTools ones. */
function fakeHelper(opts: { page?: [number, number, number, number]; cssWidth?: number; title?: string } = {}) {
  const sent: { method: string; params: any }[] = [];
  const ask: Ask = async (line) => {
    if (line.startsWith("http ")) return JSON.stringify([
      { type: "service_worker", title: "sw", url: "https://x/sw.js", webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/page/SW" },
      { type: "page", title: "Other tab", url: "https://other.example", webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/page/OTHER" },
      { type: "page", title: opts.title ?? "Capybara - Wikipedia", url: "https://en.wikipedia.org", webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/page/WIKI" },
    ]);
    if (line.startsWith("viewport ")) return JSON.stringify(opts.page ?? [1, 86, 1344, 805]);
    const [, ws, id, json] = /^cdp (\S+) (\d+) (.*)$/.exec(line)!;
    const message = JSON.parse(json!);
    expect(message.id).toBe(Number(id));
    sent.push({ method: `${ws!.split("/").pop()}:${message.method}`, params: message.params });
    return JSON.stringify({ id: message.id, result: message.method === "Page.getLayoutMetrics" ? { cssVisualViewport: { clientWidth: opts.cssWidth ?? 1344 } } : {} });
  };
  const input = browserInput(ask, async () => 9);
  const window = { containerId: 42, title: "Capybara - Wikipedia - Google Chrome" };
  const acts = () => sent.filter((s) => !/getLayoutMetrics|setFocusEmulation/.test(s.method));
  return { input, window, sent, acts };
}

describe("keyEvent", () => {
  test("Enter carries the carriage return Chromium needs to submit a form", () => {
    expect(keyEvent(["Return"])).toEqual({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r" });
  });
  test("ctrl+a names the editing command and sends no text", () => {
    expect(keyEvent(["ctrl", "a"])).toEqual({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] });
  });
  test("shift keeps the text, function keys map to their virtual keys", () => {
    expect(keyEvent(["shift", "x"]).text).toBe("x");
    expect(keyEvent(["F5"]).windowsVirtualKeyCode).toBe(116);
  });
  test("rejects names it cannot deliver instead of sending a wrong key", () => {
    expect(() => keyEvent(["ctrl"])).toThrow("besides its modifiers");
    expect(() => keyEvent(["hyperspace"])).toThrow("Unknown key");
  });
});

describe("addressToUrl", () => {
  test("hosts become https, words become a search", () => {
    expect(addressToUrl("en.wikipedia.org/wiki/Capybara")).toBe("https://en.wikipedia.org/wiki/Capybara");
    expect(addressToUrl(" https://jspaint.app ")).toBe("https://jspaint.app");
    expect(addressToUrl("localhost:7777/status")).toBe("http://localhost:7777/status");
    expect(addressToUrl("weather in tokyo")).toBe("https://www.google.com/search?q=weather%20in%20tokyo");
    expect(addressToUrl("水豚")).toBe(`https://www.google.com/search?q=${encodeURIComponent("水豚")}`);
  });
});

describe("toCss", () => {
  test("outside the page area is not the page's business", () => {
    expect(toCss(500, 40, [1, 86, 1344, 805], 1344)).toBeNull();
    expect(toCss(1345, 400, [1, 86, 1344, 805], 1344)).toBeNull();
  });
  test("subtracts the toolbar and applies the display scale", () => {
    expect(toCss(471, 205, [1, 86, 1344, 805], 1344)).toEqual({ x: 470, y: 119 });
    expect(toCss(561, 180, [0, 140, 1340, 749], 820)).toEqual({ x: 343.3, y: 24.48 });
  });
});

describe("browserInput", () => {
  test("a click in the page is a trusted press and release on the tab the window shows", async () => {
    const { input, window, sent, acts } = fakeHelper();
    expect(await input.handle("click", { x: 471, y: 205, button: "left" }, window)).toBe(true);
    expect(sent[0]!.method).toBe("WIKI:Emulation.setFocusEmulationEnabled");
    expect(acts().map((s) => [s.method, s.params.type, s.params.x, s.params.y])).toEqual([
      ["WIKI:Input.dispatchMouseEvent", "mouseMoved", 470, 119],
      ["WIKI:Input.dispatchMouseEvent", "mousePressed", 470, 119],
      ["WIKI:Input.dispatchMouseEvent", "mouseReleased", 470, 119],
    ]);
  });

  test("toolbar clicks go to Cua, and what is typed next navigates", async () => {
    const { input, window, acts } = fakeHelper();
    expect(await input.handle("click", { x: 500, y: 60 }, window)).toBe(false);
    expect(await input.handle("type_text", { text: "jspaint.app" }, window)).toBe(true);
    expect(await input.handle("press_key", { key: "Return" }, window)).toBe(true);
    expect(acts()).toEqual([{ method: "WIKI:Runtime.evaluate", params: { expression: 'location.assign("https://jspaint.app")' } }]);
  });

  test("ctrl+l then text navigates once; the following Enter is spent, the one after is real", async () => {
    const { input, window, acts } = fakeHelper();
    await input.handle("hotkey", { keys: ["ctrl", "l"] }, window);
    await input.handle("type_text", { text: "capybara facts" }, window);
    await input.handle("press_key", { key: "enter" }, window);
    await input.handle("press_key", { key: "enter" }, window);
    expect(acts().map((s) => s.method.split(":")[1])).toEqual(["Runtime.evaluate", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent"]);
    expect(acts()[0]!.params.expression).toBe('location.assign("https://www.google.com/search?q=capybara%20facts")');
  });

  test("text after a page click is inserted, not navigated", async () => {
    const { input, window, acts } = fakeHelper();
    await input.handle("click", { x: 471, y: 205 }, window);
    await input.handle("type_text", { text: "水豚" }, window);
    expect(acts().at(-1)).toEqual({ method: "WIKI:Input.insertText", params: { text: "水豚" } });
  });

  test("a stroke is one held press, and lifts where it ended because ai.ts releases without a point", async () => {
    const { input, window, acts } = fakeHelper();
    await input.handle("mouse_button_down", { x: 301, y: 486, button: "left" }, window);
    await input.handle("mouse_drag", { x: 421, y: 386, steps: 2 }, window);
    expect(await input.handle("mouse_button_up", {}, window)).toBe(true);
    expect(acts().map((s) => [s.params.type, s.params.x, s.params.y, s.params.buttons])).toEqual([
      ["mouseMoved", 300, 400, undefined], ["mousePressed", 300, 400, 1],
      ["mouseMoved", 360, 350, 1], ["mouseMoved", 420, 300, 1],
      ["mouseReleased", 420, 300, undefined],
    ]);
  });

  test("a press on the toolbar, or a browser that is not running, is left to Cua", async () => {
    const { input, window } = fakeHelper();
    expect(await input.handle("mouse_button_down", { x: 300, y: 20 }, window)).toBe(false);
    expect(await input.handle("mouse_button_up", {}, window)).toBe(false);
    const gone = browserInput(async () => { throw new Error("no helper"); }, async () => null);
    expect(await gone.handle("click", { x: 10, y: 200 }, window)).toBe(false);
  });
});
