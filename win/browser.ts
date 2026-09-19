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
import { debugLog, type CuaConnection } from "../desktop";
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
    const title = window.title.replace(/\s+-\s+(?:Google Chrome|Microsoft Edge|Chromium|Brave)$/u, "");
    const matches = pages.filter((t) => t.title === title);
    if (matches.length > 1 || (!matches.length && pages.length > 1)) throw new Error("The browser tab is ambiguous. Select a uniquely titled tab before continuing.");
    const ws = (matches[0] ?? (pages.length === 1 ? pages[0] : undefined))?.webSocketDebuggerUrl;
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
    async evaluate(window: BrowserWindow, expression: string, beforeInput?: () => void): Promise<unknown> {
      const target = await page(window).catch((error) => { onError("page", error); return null; });
      if (!target) return null;
      beforeInput?.();
      // A page that is navigating away drops the call; that is "not now", not an error.
      const reply = await send(target.ws, "Runtime.evaluate", { expression, returnByValue: true }).catch((error) => { onError("evaluate", error); return null; });
      return !reply || reply.exceptionDetails ? null : reply.result?.value ?? null;
    },
    /** Window pixels of the page area, and how many CSS pixels one of them is. */
    async geometry(window: BrowserWindow): Promise<{ area: [number, number, number, number]; scale: number } | null> {
      const target = await page(window).catch((error) => { onError("page", error); return null; });
      return target ? { area: target.area, scale: target.cssWidth / target.area[2] } : null;
    },
    async navigate(window: BrowserWindow, url: string, beforeInput?: () => void): Promise<boolean> {
      const target = await page(window).catch((error) => { onError("page", error); return null; });
      if (!target) return false;
      beforeInput?.();
      // Page.navigate answers only once the site has responded, which can take
      // seconds. Assigning the location returns at once; pageSettled does the waiting.
      await send(target.ws, "Runtime.evaluate", { expression: `location.assign(${JSON.stringify(addressToUrl(url))})` }).catch(() => {});
      address = false; swallowEnter = false;
      return true;
    },
    /** True when the call was delivered here; false leaves it to Cua. */
    async handle(name: string, args: Record<string, unknown>, window: BrowserWindow, beforeInput: () => void = () => {}): Promise<boolean> {
      const target = await page(window).catch((error) => { onError("page", error); return null; });
      if (!target) return false;
      beforeInput();
      const { ws, at } = target;
      const input = (method: string, params: Record<string, unknown> = {}) => { beforeInput(); return send(ws, method, params); };
      const pointer = (type: string, point: { x: number; y: number }, extra: Record<string, unknown> = {}) => input("Input.dispatchMouseEvent", { type, ...point, ...extra });

      if (name === "click") {
        const p = at(args.x, args.y);
        // Above the page is the toolbar. Cua presses it; typing that follows is for the address bar.
        if (!p) { address = true; swallowEnter = false; return false; }
        address = false;
        const button = String(args.button ?? "left");
        await pointer("mouseMoved", p);
        await pointer("mousePressed", p, { button, clickCount: 1 });
        // A matching release is cleanup even if the instruction changed while pressed.
        await mouse(ws, "mouseReleased", p, { button, clickCount: 1 });
        return true;
      }
      if (name === "move_cursor") { const p = at(args.x, args.y); if (p) await pointer("mouseMoved", p); return true; }
      if (name === "scroll") {
        const p = at(args.x, args.y);
        if (!p) return false;
        await pointer("mouseWheel", p, { deltaX: 0, deltaY: (args.direction === "up" ? -1 : 1) * Number(args.amount ?? 3) * 40 });
        return true;
      }
      if (name === "type_text") {
        const text = String(args.text ?? "");
        if (address) {
          // Navigating at once keeps the next screenshot truthful; the Enter that usually follows is spent.
          await input("Runtime.evaluate", { expression: `location.assign(${JSON.stringify(addressToUrl(text))})` });
          address = false; swallowEnter = true;
        } else await input("Input.insertText", { text });
        return true;
      }
      if (name === "press_key" || name === "hotkey") {
        const keys = name === "hotkey" ? (args.keys as string[]) : [...((args.modifiers as string[] | undefined) ?? []), String(args.key)];
        const combo = keys.map((k) => k.toLowerCase()).join("+");
        if (["ctrl+l", "alt+d", "f6", "ctrl+t", "ctrl+k", "ctrl+e"].includes(combo)) { address = true; swallowEnter = false; return true; }
        if (["ctrl+r", "f5"].includes(combo)) { await input("Page.reload"); return true; }
        if (combo === "alt+left" || combo === "alt+right") { await input("Runtime.evaluate", { expression: `history.${combo === "alt+left" ? "back" : "forward"}()` }); return true; }
        if (swallowEnter && (combo === "enter" || combo === "return")) { swallowEnter = false; return true; }
        swallowEnter = false;
        const event = keyEvent(keys);
        await input("Input.dispatchKeyEvent", { type: event.text ? "keyDown" : "rawKeyDown", ...event });
        await send(ws, "Input.dispatchKeyEvent", { type: "keyUp", ...event, text: undefined, commands: undefined });
        return true;
      }
      // ai.ts draws with press, drag, release. A press outside the page belongs to Cua.
      if (name === "mouse_button_down") {
        const p = at(args.x, args.y);
        if (!p) return false;
        await pointer("mouseMoved", p);
        await pointer("mousePressed", p, { button: "left", buttons: 1, clickCount: 1 });
        held = p;
        return true;
      }
      if (name === "mouse_drag" && held) {
        const p = at(args.x, args.y);
        if (!p) return true;
        // Canvases sample the pointer; a single jump would draw nothing in some of them.
        const from = held, steps = Math.min(16, Math.max(1, Number(args.steps ?? 4)));
        for (let i = 1; i <= steps; i++) await pointer("mouseMoved", { x: from.x + (p.x - from.x) * i / steps, y: from.y + (p.y - from.y) * i / steps }, { button: "left", buttons: 1 });
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

/** Existing-profile input deliberately goes through Cua's exact native binding.
 * Its opaque refs are not pixel coordinates and must never use the private
 * profile's DevTools connection as a fallback. */
export type ExistingBrowserWindow = BrowserWindow & { pid: number; ownerNonce?: string; rect: Rect };
type ExistingRef = { ref: string; role: string; name: string; value?: string; states?: Record<string, unknown>; actions?: string[]; visibility?: string };
type ExistingTab = { tab_id: string; title: string; url: string; active: boolean | null };
type ExistingPage = { target_id: string; tab_id: string; title: string; url: string; tabs: ExistingTab[]; refs: ExistingRef[]; outline: string; snapshot_id: string; window: ExistingBrowserWindow };
type ExistingBinding = { target_id: string; tab: ExistingTab; tabs: ExistingTab[]; window: ExistingBrowserWindow };
export type ExistingDialog = { target_id: string; tab_id: string; title: string; url: string; window: ExistingBrowserWindow } &
  ({ present: false } | { present: true; dialog_id: string; kind: "alert" | "confirm" | "prompt" | "beforeunload" | "other" });
type ExistingAction = { action: string; url?: string; text?: string; replace?: boolean; key?: string; direction?: string; amount?: number };
const sameExistingWindow = (a: ExistingBrowserWindow, b: ExistingBrowserWindow, frame = false) => a.pid === b.pid
  && a.containerId === b.containerId && a.ownerNonce === b.ownerNonce
  && (!frame || a.title === b.title && a.rect[2] === b.rect[2] && a.rect[3] === b.rect[3]);
// Chrome reports its New Tab alias through Target.getTargets and the backing
// document through DOM.getDocument. This is the only observed equivalence;
// ordinary URLs, including their query and fragment, remain exact comparisons.
const chromeNewTabUrls = new Set(["chrome://newtab/", "chrome://new-tab-page/"]);
const sameBrowserUrl = (a: string | undefined, b: string | undefined) => a === b || typeof a === "string" && typeof b === "string" && chromeNewTabUrls.has(a) && chromeNewTabUrls.has(b);
class BrowserObservationChanged extends Error {}

export type ExistingBrowserTiming = {
  phase: "native_check" | "bind_rpc" | "snapshot_rpc" | "action_rpc" | "prepare_rpc";
  sequence: number;
  event: "start" | "end";
  durationMs?: number;
  outcome?: "ok" | "failed" | "cancelled";
};
type ExistingBrowserDiagnostics = { timing?: (event: ExistingBrowserTiming) => void; now?: () => number };

export function existingBrowserInput(call: CuaConnection["call"], current: () => Promise<ExistingBrowserWindow>, session = `puk-existing-${crypto.randomUUID()}`,
  beforePrepare?: (window: ExistingBrowserWindow) => Promise<void>, diagnostics: ExistingBrowserDiagnostics = {}) {
  let closed = false;
  let healthy = true;
  let currentPage: ExistingPage | undefined;
  let lastBinding: ExistingBinding | undefined;
  let currentDialog: ExistingDialog | undefined;
  let generation = 0;
  let timingSequence = 0;
  const now = diagnostics.now ?? (() => performance.now());
  const emitTiming = (event: ExistingBrowserTiming) => {
    // The event is constructed only from fixed phase labels, counters and time.
    // Never include arguments, window identity, URL, title, refs or errors.
    try { (diagnostics.timing ?? ((value) => debugLog("win.browser.phase", value)))(event); } catch { /* Diagnostics cannot affect input semantics. */ }
  };
  const timed = async <T>(phase: ExistingBrowserTiming["phase"], signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> => {
    const sequence = ++timingSequence, started = now();
    emitTiming({ phase, sequence, event: "start" });
    let outcome: ExistingBrowserTiming["outcome"] = "failed";
    try { const result = await work(); outcome = "ok"; return result; }
    finally { emitTiming({ phase, sequence, event: "end", durationMs: Math.max(0, Math.round(now() - started)), outcome: signal?.aborted ? "cancelled" : outcome }); }
  };
  const check = async (signal?: AbortSignal, expected?: ExistingBrowserWindow, frame = false) => timed("native_check", signal, async () => {
    signal?.throwIfAborted();
    if (closed) throw new Error("This existing-browser binding has been released. Attach and look again.");
    const window = await current();
    signal?.throwIfAborted();
    if (closed) throw new Error("This existing-browser binding has been released. Attach and look again.");
    if (!window.ownerNonce || expected && !sameExistingWindow(window, expected)) throw new Error("The existing Chrome window changed. Attach or look again before acting.");
    if (expected && frame && !sameExistingWindow(window,expected,true)) throw new BrowserObservationChanged("The existing Chrome window changed title or size. Take a fresh observation before acting.");
    return { ...window, rect: [...window.rect] as Rect };
  });
  const invoke = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => timed(
    name === "get_browser_state" ? args.target_id ? "snapshot_rpc" : "bind_rpc" : name === "browser_prepare" ? "prepare_rpc" : "action_rpc", signal, async () => {
    signal?.throwIfAborted();
    if (closed) throw new Error("This existing-browser binding has been released. Attach and look again.");
    let reply: Awaited<ReturnType<CuaConnection["call"]>>;
    try { reply = await call(name, { ...args, session }, signal); }
    catch (error) {
      // A public session may expire while its MCP transport remains alive.
      // Never revive or replay an input here: the next explicit attach must
      // retire this label, re-attest the window and obtain a fresh binding.
      if (/session (?:has ended|'[^']*' has ended)|persistent Cua connection is disconnected|Cua transport closed/i.test(String(error))) {
        healthy = false; currentPage = undefined; currentDialog = undefined; lastBinding = undefined; generation++;
      }
      throw error;
    }
    signal?.throwIfAborted();
    const state = reply.structuredContent as Record<string, unknown> | undefined;
    if (reply.isError || state?.status === "refused" || ["refused", "failed", "partial", "suspected_noop"].includes(String(state?.effect))) {
      throw new Error(`Cua ${name} refused: ${JSON.stringify(state ?? reply.content)}`);
    }
    // Cua publishes action outcomes without the internal status/target fields.
    // "unverifiable" confirms dispatch only: the caller always takes a fresh
    // semantic observation and must inspect the application's postcondition.
    const dispatched = ["browser_click", "browser_type", "browser_pointer"].includes(name)
      && ["confirmed", "unverifiable"].includes(String(state?.effect)) && ["dom", "trusted_input"].includes(String(state?.route))
      && (state?.delivery as { mode?: string } | undefined)?.mode === "background";
    if (!state || state.status !== "ok" && !dispatched) throw new Error(`Cua ${name} did not return a verified browser result. Read fresh state before any retry. Result metadata: ${JSON.stringify({
      keys: Object.keys(reply), structured_keys: state ? Object.keys(state) : [], status: state?.status, effect: state?.effect,
      route: state?.route, delivery: state?.delivery,
    })}`);
    return state;
  });
  const bind = async (signal?: AbortSignal) => {
    const window = await check(signal);
    const result = await invoke("get_browser_state", { pid: window.pid, window_id: window.containerId }, signal);
    await check(signal, window, true);
    if (result.mode !== "bind" || result.binding_quality !== "exact" || result.mutation_allowed !== true || typeof result.target_id !== "string") {
      throw new Error("Cua could not bind this exact Chrome window for input. No other browser was selected.");
    }
    const tabs = (Array.isArray(result.tabs) ? result.tabs : []) as ExistingTab[];
    const active = tabs.filter((tab) => tab.active === true && typeof tab.tab_id === "string" && typeof tab.title === "string" && typeof tab.url === "string");
    if (active.length !== 1 || tabs.filter((tab) => tab.title === active[0]?.title).length !== 1) {
      throw new Error("Cua could not identify one uniquely titled active tab in this Chrome window. Select a tab and observe again.");
    }
    lastBinding = { target_id: result.target_id, tab: active[0]!, tabs, window };
    return lastBinding;
  };
  const dialogCall = async (args: Record<string, unknown>, signal?: AbortSignal) => {
    try { return await invoke("browser_dialog", { ...args, delivery_mode: "background" }, signal); }
    catch (error) {
      signal?.throwIfAborted();
      // Cua still performs its own exact-tab and live-URL authorization. A
      // modal can block that attestation too; never bypass it with raw CDP.
      throw new Error(`Cua could not ${args.action === "inspect" ? "inspect" : "resolve"} the page dialog. Exact-tab/URL attestation must succeed; no alternate input was sent. Inspect again before any resolution retry. Cause: ${String(error)}`);
    }
  };
  return {
    healthy: () => healthy && !closed,
    async attach(signal?: AbortSignal, options: { allowPrepare?: boolean } = {}) {
      currentPage = undefined; currentDialog = undefined; generation++;
      try {
        try { await bind(signal); }
        catch (error) {
          if (options.allowPrepare === false || !/session (?:has ended|'[^']*' has ended)/i.test(String(error))) throw error;
          // Explicit attachment is the public Cua lifecycle boundary. Reviving
          // a label grants no browser access: bind/prepare below still enforce
          // the driver's exact-window consent checks. Never do this for input.
          await check(signal);
          const revived = await call("start_session", { session }, signal);
          signal?.throwIfAborted();
          if (revived.isError) throw new Error("Cua could not restart the ended browser session.");
          healthy = true;
          await bind(signal);
        }
      }
      catch (error) {
        signal?.throwIfAborted();
        if (options.allowPrepare === false) throw error;
        // Only an explicitly requested attach may prepare the signed-in browser.
        // Denial, cancellation, ambiguity and stale native identity are final.
        const message = error instanceof Error ? error.message : String(error);
        if (/denied|declined|cancelled|canceled|aborted|rejected/i.test(message) || !/browser_(?:requires_setup|consent_required)\b/.test(message)) throw error;
        const window = await check(signal);
        // Windows exposes the browser-owned setup/consent UI reliably only
        // when visible. This hook is exclusive to an explicit attachment, and
        // visits the exact browser's own desktop before Cua can activate it.
        await beforePrepare?.(window);
        await check(signal, window);
        await invoke("browser_prepare", { pid: window.pid, window_id: window.containerId, strategy: { kind: "existing_profile" }, allow_launch: false }, signal);
        await check(signal, window);
        await bind(signal);
      }
    },
    async snapshot(signal?: AbortSignal, retry = 0): Promise<ExistingPage> {
      try {
      const observedGeneration = ++generation;
      currentPage = undefined; currentDialog = undefined;
      const bound = await bind(signal);
      const result = await invoke("get_browser_state", { target_id: bound.target_id, tab_id: bound.tab.tab_id, snapshot_format: "semantic_v2", include_screenshot: false }, signal);
      const page = result.page as { title?: string; url?: string } | undefined;
      const snapshot = result.snapshot as { id?: string; format?: string } | undefined;
      if (result.mode !== "snapshot" || result.target_id !== bound.target_id || result.tab_id !== bound.tab.tab_id
        || snapshot?.format !== "semantic_v2" || !snapshot.id || !page || page.title !== bound.tab.title || !sameBrowserUrl(page.url, bound.tab.url) || !Array.isArray(result.refs)) {
        // Diagnose contract/version/internal-page aliases without logging any
        // page outline, control values or references. URLs omit credentials and
        // query/fragment contents, which may carry account/session information.
        const label = (value: unknown) => typeof value === "string" ? value.slice(0, 200) : null;
        const safeUrl = (value: unknown) => {
          if (typeof value !== "string") return null;
          try {
            const url = new URL(value); url.username = ""; url.password = "";
            if (url.search) url.search = "?redacted";
            if (url.hash) url.hash = "#redacted";
            return url.href.slice(0, 400);
          } catch { return "<invalid URL>"; }
        };
        const metadata = { mode: label(result.mode), target_matches: result.target_id === bound.target_id, tab_matches: result.tab_id === bound.tab.tab_id,
          format: label(snapshot?.format), has_snapshot_id: Boolean(snapshot?.id), has_refs_array: Array.isArray(result.refs),
          bound_title: label(bound.tab.title), bound_url: safeUrl(bound.tab.url), page_title: label(page?.title), page_url: safeUrl(page?.url),
          titles_match: page?.title === bound.tab.title, urls_match: page?.url === bound.tab.url };
        const stableContract = result.mode === "snapshot" && result.target_id === bound.target_id && result.tab_id === bound.tab.tab_id && snapshot?.format === "semantic_v2" && snapshot.id && page && Array.isArray(result.refs);
        const ErrorType = stableContract ? BrowserObservationChanged : Error;
        throw new ErrorType(`The visible Chrome tab changed while observing it. Take a fresh snapshot. Browser snapshot metadata: ${JSON.stringify(metadata)}`);
      }
      await check(signal, bound.window, true);
      const seen = new Set<string>();
      const refs = (result.refs as ExistingRef[]).filter((ref) => {
        if (!ref || typeof ref.ref !== "string" || !ref.ref || typeof ref.role !== "string" || seen.has(ref.ref)) return false;
        seen.add(ref.ref);
        return true;
      }).map((ref) => ({ ...ref, name: typeof ref.name === "string" ? ref.name : "", value: typeof ref.value === "string" ? ref.value : undefined }));
      const observation: ExistingPage = { target_id: bound.target_id, tab_id: bound.tab.tab_id, title: page.title, url: page.url!,
        tabs: bound.tabs, refs, outline: typeof result.outline === "string" ? result.outline : "", snapshot_id: snapshot.id, window: bound.window };
      if (observedGeneration !== generation) throw new Error("A newer browser observation replaced this one. Use the newest snapshot.");
      currentPage = observation;
      return observation;
      } catch(error) {
        // A navigation can settle between the two read-only RPCs. Discard all
        // refs and retry once on the same owned window, without reconnecting,
        // repeating input, or asking an expressive model to rediscover this.
        signal?.throwIfAborted();
        if (retry === 0 && error instanceof BrowserObservationChanged) return this.snapshot(signal,1);
        throw error;
      }
    },
    async inspectDialog(signal?: AbortSignal): Promise<ExistingDialog> {
      const observedGeneration = ++generation;
      currentPage = undefined; currentDialog = undefined;
      // A dialog can block DOM/AX reads after an input timed out. Retain only
      // the last exact binding, never its element refs, and require the native
      // window identity/title/frame to remain the same. Cua re-attests the tab.
      const bound = lastBinding ?? await bind(signal);
      await check(signal, bound.window, true);
      const result = await dialogCall({ target_id: bound.target_id, tab_id: bound.tab.tab_id, action: "inspect" }, signal);
      await check(signal, bound.window, true);
      if (result.target_id !== bound.target_id || result.tab_id !== bound.tab.tab_id || typeof result.present !== "boolean"
        || result.present && (typeof result.dialog_id !== "string" || !result.dialog_id || result.dialog_id.length > 100
          || !["alert", "confirm", "prompt", "beforeunload", "other"].includes(String(result.kind)))) {
        throw new Error("Cua did not return a current dialog for the exact bound tab. Inspect again before resolving it.");
      }
      const observed: ExistingDialog = { target_id: bound.target_id, tab_id: bound.tab.tab_id, title: bound.tab.title, url: bound.tab.url,
        window: bound.window, ...(result.present ? { present: true, dialog_id: result.dialog_id as string, kind: result.kind as Extract<ExistingDialog, { present: true }>["kind"] } : { present: false }) };
      if (observedGeneration !== generation) throw new Error("A newer observation replaced this dialog inspection. Inspect again.");
      currentDialog = observed;
      return observed;
    },
    async resolveDialog(observed: ExistingDialog, operation: "accept" | "dismiss", dialogId: string, signal?: AbortSignal, beforeInput = () => {}) {
      if (currentDialog !== observed || !observed.present || observed.dialog_id !== dialogId) throw new Error("The dialog inspection is stale or its id does not match. Inspect the current dialog first.");
      if (operation !== "accept" && operation !== "dismiss") throw new Error("A dialog resolution must be accept or dismiss.");
      try {
        beforeInput(); signal?.throwIfAborted();
        await check(signal, observed.window, true);
        // Bind reads tab metadata rather than the blocked DOM. It proves the
        // same active page, while the old IDs still own the observed dialog.
        const active = await bind(signal);
        if (active.tab.title !== observed.title || !sameBrowserUrl(active.tab.url, observed.url)) throw new Error("The active Chrome tab changed after dialog inspection or approval. Inspect again.");
        await check(signal, observed.window, true);
        beforeInput(); signal?.throwIfAborted();
        if (currentDialog !== observed) throw new Error("The dialog inspection changed while resolution was being prepared. Inspect again.");
        currentDialog = undefined; currentPage = undefined; generation++;
        const result = await dialogCall({ target_id: observed.target_id, tab_id: observed.tab_id, action: operation, dialog_id: dialogId }, signal);
        if (result.target_id !== observed.target_id || result.tab_id !== observed.tab_id || result.dialog_id !== dialogId
          || result.kind !== observed.kind || result.action !== operation) throw new Error("Cua did not confirm this exact dialog resolution. Inspect again; do not replay the request.");
        signal?.throwIfAborted(); beforeInput();
      } catch (error) { currentDialog = undefined; currentPage = undefined; generation++; throw error; }
    },
    async act(observed: ExistingPage, action: ExistingAction, reference?: string, signal?: AbortSignal, beforeInput = () => {}) {
      if (currentPage !== observed) throw new Error("The browser observation is stale or does not belong to this binding. Look again.");
      const ref = reference ? observed.refs.find((entry) => entry.ref === reference) : undefined;
      if (reference && !ref) throw new Error("That Chrome reference was not observed in this snapshot.");
      if (["click", "type", "set_value"].includes(action.action) && !ref) throw new Error("Existing Chrome input needs a current browser reference.");
      beforeInput();
      await check(signal, observed.window, true);
      // Cua mints new opaque tab IDs on every bind. Compare the freshly proved
      // active page, then dispatch with the old IDs that own the observed ref.
      const active = await bind(signal);
      if (active.tab.title !== observed.title || !sameBrowserUrl(active.tab.url, observed.url)) throw new Error("The active Chrome tab changed after observation or approval. Look again.");
      await check(signal, observed.window, true);
      beforeInput(); signal?.throwIfAborted();
      if (currentPage !== observed) throw new Error("The browser observation changed while input was being prepared. Look again.");
      currentPage = undefined; currentDialog = undefined; generation++; // No failed or cancelled mutation may be replayed.
      const target = { target_id: observed.target_id, tab_id: observed.tab_id };
      if (action.action === "navigate") {
        if (!action.url || !/^https?:\/\//i.test(action.url)) throw new Error("Browser navigation needs an http(s) URL.");
        await invoke("browser_navigate", { ...target, url: action.url }, signal);
      } else if (action.action === "click") {
        await invoke("browser_click", { ...target, ref: ref!.ref, input_route: "dom_event" }, signal);
      } else if (action.action === "type" || action.action === "set_value") {
        await invoke("browser_type", { ...target, ref: ref!.ref, text: action.text ?? "", replace: action.replace !== false }, signal);
      } else if (action.action === "scroll") {
        const scroll = ref ?? observed.refs.find((entry) => entry.actions?.includes("scroll"));
        if (!scroll) throw new Error("Scroll needs a visible browser reference. Look again and select a scrollable control.");
        await invoke("browser_pointer", { ...target, action: "scroll", ref: scroll.ref, input_route: "dom_event", delta_x: 0,
          delta_y: (action.direction === "up" ? -1 : 1) * Math.min(30, Math.max(1, action.amount ?? 6)) * 40 }, signal);
      } else if (action.action === "key") {
        // There is no Cua browser-key endpoint. Native delivery is still scoped
        // to the exact HWND; a background refusal never switches desktops.
        const keys = (action.key ?? "").toLowerCase().split("+").map((key) => key.trim()).filter(Boolean);
        if (!keys.length) throw new Error("A key or chord is required.");
        const reply = await timed("action_rpc", signal, () => call(keys.length > 1 ? "hotkey" : "press_key", { pid: observed.window.pid, window_id: observed.window.containerId, session,
          ...(keys.length > 1 ? { keys } : { key: keys[0] }) }, signal));
        if (reply.isError) throw new Error(`Cua refused existing Chrome keyboard input: ${JSON.stringify(reply.content)}`);
      } else throw new Error(`Unsupported existing-browser action: ${action.action}`);
      signal?.throwIfAborted(); beforeInput();
    },
    async navigate(url: string, signal?: AbortSignal) {
      const observed = await this.snapshot(signal);
      await this.act(observed, { action: "navigate", url: addressToUrl(url) }, undefined, signal);
      return true;
    },
    async close() {
      closed = true;
      generation++;
      currentPage = undefined; currentDialog = undefined; lastBinding = undefined;
      // Session cleanup releases only Cua's grant/connection; it does not own or
      // terminate the existing browser process.
      await call("end_session", { session }).catch(() => {});
    },
  };
}
export type ExistingBrowserInput = ReturnType<typeof existingBrowserInput>;
export type ExistingBrowserSnapshot = Awaited<ReturnType<ExistingBrowserInput["snapshot"]>>;
