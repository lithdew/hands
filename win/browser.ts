/**
 * Background input for a hand's browser.
 *
 * Windows will not deliver posted keys or text to Chromium, and Cua's own CDP
 * typing refuses unless the browser is in the foreground. DevTools input
 * (`Input.dispatch*`, `Input.insertText`) is injected at the renderer and needs
 * no OS focus, so the hand's browser is driven with it directly: the user keeps
 * the screen, and a stroke is one continuous press, move, release.
 *
 * The agent still works in window pixels from Cua's screenshot. Points inside
 * the page area are converted to CSS pixels here; clicks on the tab strip and
 * toolbar are left to Cua, which reaches those controls through UI Automation.
 * The address bar cannot be typed into from the background, so text aimed at
 * it becomes a navigation.
 */
export type Ask = (line: string) => Promise<string>;
export type BrowserWindow = { containerId: number; title: string };
type Rect = [x: number, y: number, w: number, h: number];

const MODIFIERS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, win: 4, cmd: 4, shift: 8 };
const NAMED: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" }, return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 }, escape: { key: "Escape", code: "Escape", vk: 27 }, esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 }, delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }, up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 }, down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  home: { key: "Home", code: "Home", vk: 36 }, end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 }, pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};
/** Chromium runs these editing shortcuts only when the command is named. */
const COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo", y: "redo" };

/** DevTools key event fields for a combination such as ["ctrl", "a"] or ["enter"]. */
export function keyEvent(keys: string[]) {
  const names = keys.map((k) => k.trim().toLowerCase()).filter(Boolean);
  const main = names.findLast((k) => !(k in MODIFIERS));
  if (!main) throw new Error("A key combination needs a key besides its modifiers.");
  const modifiers = names.reduce((bits, k) => bits | (MODIFIERS[k] ?? 0), 0);
  const fn = /^f(\d{1,2})$/.exec(main);
  const named = NAMED[main] ?? (fn ? { key: main.toUpperCase(), code: main.toUpperCase(), vk: 111 + Number(fn[1]) } : undefined);
  if (!named && [...main].length !== 1) throw new Error(`Unknown key: ${main}`);
  const base = named ?? { key: main, code: /[a-z]/.test(main) ? `Key${main.toUpperCase()}` : /\d/.test(main) ? `Digit${main}` : "", vk: main.toUpperCase().charCodeAt(0), text: main };
  const plain = !(modifiers & (MODIFIERS.alt! | MODIFIERS.ctrl! | MODIFIERS.meta!));
  const command = modifiers === MODIFIERS.ctrl ? COMMANDS[main] : undefined;
  return { key: base.key, code: base.code, windowsVirtualKeyCode: base.vk, modifiers, ...(plain && base.text ? { text: base.text } : {}), ...(command ? { commands: [command] } : {}) };
}

/** What someone typing into an address bar means: a URL, or a search. */
export function addressToUrl(text: string): string {
  const value = text.trim();
  if (/^(https?|about|file):/i.test(value)) return value;
  if (!/\s/.test(value) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(value)) return `https://${value}`;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(value)) return `http://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

/** Window pixels to the page's CSS pixels, or null outside the page area. */
export function toCss(x: number, y: number, page: Rect, cssWidth: number): { x: number; y: number } | null {
  if (x < page[0] || y < page[1] || x >= page[0] + page[2] || y >= page[1] + page[3]) return null;
  const scale = cssWidth / page[2];
  return { x: Math.round((x - page[0]) * scale * 100) / 100, y: Math.round((y - page[1]) * scale * 100) / 100 };
}

/** `port` reads the browser's DevToolsActivePort; null when the browser is not running. */
export function browserInput(ask: Ask, port: (reread?: boolean) => Promise<number | null>, onError: (where: string, error: unknown) => void = () => {}) {
  let next = 1;
  let address = false, swallowEnter = false;
  let held: { x: number; y: number } | undefined;
  const prepared = new Set<string>();
  const widths = new Map<string, { css: number; area: number; at: number }>();

  async function send(ws: string, method: string, params: Record<string, unknown> = {}) {
    const id = next++;
    const reply = JSON.parse(await ask(`cdp ${ws} ${id} ${JSON.stringify({ id, method, params })}`));
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result;
  }

  async function page(window: BrowserWindow) {
    let devtools = await port();
    if (!devtools) return null;
    const list = (p: number) => ask(`http http://127.0.0.1:${p}/json/list`);
    // The remembered port goes stale when the browser was restarted: look once more.
    const listed = await list(devtools).catch(async () => { devtools = await port(true); if (!devtools) throw new Error("no browser"); return list(devtools); });
    const targets: { type: string; title: string; url: string; webSocketDebuggerUrl?: string }[] = JSON.parse(listed);
    const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl && !t.url.startsWith("devtools://"));
    // The window is titled after its active tab: "Capybara - Wikipedia - Google Chrome".
    const ws = (pages.find((t) => t.title && window.title.startsWith(t.title)) ?? pages[0])?.webSocketDebuggerUrl;
    if (!ws) return null;
    if (!prepared.has(ws)) {
      // Without this a page that is not the OS focus shows no caret and drops some key events.
      await send(ws, "Emulation.setFocusEmulationEnabled", { enabled: true });
      prepared.add(ws);
    }
    const area: Rect = JSON.parse(await ask(`viewport ${window.containerId}`));
    // Asking the page for its width needs the page's main thread, which a loading
    // site keeps busy for seconds. The answer only changes with zoom or a resize.
    const known = widths.get(ws);
    const cssWidth = known && known.area === area[2] && Date.now() - known.at < 5000 ? known.css
      : Number((await send(ws, "Page.getLayoutMetrics")).cssVisualViewport.clientWidth);
    widths.set(ws, { css: cssWidth, area: area[2], at: Date.now() });
    return { ws, area, cssWidth, at: (x: unknown, y: unknown) => toCss(Number(x), Number(y), area, cssWidth) };
  }

  const mouse = (ws: string, type: string, p: { x: number; y: number }, extra: Record<string, unknown> = {}) => send(ws, "Input.dispatchMouseEvent", { type, ...p, ...extra });

  return {
    /** Run an expression in the page and return its value; null when there is no page. */
    async evaluate(window: BrowserWindow, expression: string): Promise<unknown> {
      const target = await page(window).catch((error) => { onError("page", error); return null; });
      if (!target) return null;
      // A page that is navigating away drops the call; that is "not now", not an error.
      const reply = await send(target.ws, "Runtime.evaluate", { expression, returnByValue: true }).catch((error) => { onError("evaluate", error); return null; });
      return !reply || reply.exceptionDetails ? null : reply.result?.value ?? null;
    },
    /** Window pixels of the page area, and how many CSS pixels one of them is. */
    async geometry(window: BrowserWindow): Promise<{ area: [number, number, number, number]; scale: number } | null> {
      const target = await page(window).catch((error) => { onError("page", error); return null; });
      return target ? { area: target.area, scale: target.cssWidth / target.area[2] } : null;
    },
    async navigate(window: BrowserWindow, url: string): Promise<boolean> {
      const target = await page(window).catch((error) => { onError("page", error); return null; });
      if (!target) return false;
      // Page.navigate answers only once the site has responded, which can take
      // seconds. Assigning the location returns at once; pageSettled does the waiting.
      await send(target.ws, "Runtime.evaluate", { expression: `location.assign(${JSON.stringify(addressToUrl(url))})` }).catch(() => {});
      address = false; swallowEnter = false;
      return true;
    },
    /** True when the call was delivered here; false leaves it to Cua. */
    async handle(name: string, args: Record<string, unknown>, window: BrowserWindow): Promise<boolean> {
      const target = await page(window).catch((error) => { onError("page", error); return null; });
      if (!target) return false;
      const { ws, at } = target;

      if (name === "click") {
        const p = at(args.x, args.y);
        // Above the page is the toolbar. Cua presses it; typing that follows is for the address bar.
        if (!p) { address = true; swallowEnter = false; return false; }
        address = false;
        const button = String(args.button ?? "left");
        await mouse(ws, "mouseMoved", p);
        await mouse(ws, "mousePressed", p, { button, clickCount: 1 });
        await mouse(ws, "mouseReleased", p, { button, clickCount: 1 });
        return true;
      }
      if (name === "move_cursor") { const p = at(args.x, args.y); if (p) await mouse(ws, "mouseMoved", p); return true; }
      if (name === "scroll") {
        const p = at(args.x, args.y);
        if (!p) return false;
        await mouse(ws, "mouseWheel", p, { deltaX: 0, deltaY: (args.direction === "up" ? -1 : 1) * Number(args.amount ?? 3) * 40 });
        return true;
      }
      if (name === "type_text") {
        const text = String(args.text ?? "");
        if (address) {
          // Navigating at once keeps the next screenshot truthful; the Enter that usually follows is spent.
          await send(ws, "Runtime.evaluate", { expression: `location.assign(${JSON.stringify(addressToUrl(text))})` });
          address = false; swallowEnter = true;
        } else await send(ws, "Input.insertText", { text });
        return true;
      }
      if (name === "press_key" || name === "hotkey") {
        const keys = name === "hotkey" ? (args.keys as string[]) : [...((args.modifiers as string[] | undefined) ?? []), String(args.key)];
        const combo = keys.map((k) => k.toLowerCase()).join("+");
        if (["ctrl+l", "alt+d", "f6", "ctrl+t", "ctrl+k", "ctrl+e"].includes(combo)) { address = true; swallowEnter = false; return true; }
        if (["ctrl+r", "f5"].includes(combo)) { await send(ws, "Page.reload"); return true; }
        if (combo === "alt+left" || combo === "alt+right") { await send(ws, "Runtime.evaluate", { expression: `history.${combo === "alt+left" ? "back" : "forward"}()` }); return true; }
        if (swallowEnter && (combo === "enter" || combo === "return")) { swallowEnter = false; return true; }
        swallowEnter = false;
        const event = keyEvent(keys);
        await send(ws, "Input.dispatchKeyEvent", { type: event.text ? "keyDown" : "rawKeyDown", ...event });
        await send(ws, "Input.dispatchKeyEvent", { type: "keyUp", ...event, text: undefined, commands: undefined });
        return true;
      }
      // ai.ts draws with press, drag, release. A press outside the page belongs to Cua.
      if (name === "mouse_button_down") {
        const p = at(args.x, args.y);
        if (!p) return false;
        await mouse(ws, "mouseMoved", p);
        await mouse(ws, "mousePressed", p, { button: "left", buttons: 1, clickCount: 1 });
        held = p;
        return true;
      }
      if (name === "mouse_drag" && held) {
        const p = at(args.x, args.y);
        if (!p) return true;
        // Canvases sample the pointer; a single jump would draw nothing in some of them.
        const from = held, steps = Math.min(16, Math.max(1, Number(args.steps ?? 4)));
        for (let i = 1; i <= steps; i++) await mouse(ws, "mouseMoved", { x: from.x + (p.x - from.x) * i / steps, y: from.y + (p.y - from.y) * i / steps }, { button: "left", buttons: 1 });
        held = p;
        return true;
      }
      if (name === "mouse_button_up" && held) {
        // ai.ts releases without a position: lift where the stroke ended.
        const release = held;
        held = undefined;
        await mouse(ws, "mouseReleased", release, { button: "left", clickCount: 1 });
        return true;
      }
      return false;
    },
  };
}
