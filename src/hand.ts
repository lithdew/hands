/**
 * A hand: what Jev's loop sees and acts through, in a window behind the user's.
 *
 * It works one window at a time, and which one decides the channel. Its own browser is read from the page's DOM and
 * worked through DevTools input, all down the one session devtools.ts keeps: a step on a page starts no process.
 * Any other window it launched is read from its UI Automation tree and worked through patterns, EM_REPLACESEL and
 * posted messages, each a run of the helper (a process start, ~230 ms from WSL), so they are counted: one a look,
 * one an action. Neither channel needs the focus, and what would need it is refused in one sentence, never borrowed.
 */

import { attachPage, type Cdp, type CdpEvent, type PageSession } from "./devtools.ts";
import { centerOf, isNative, nativeObservation, type Observation, type PageDump, pageObservation, readPage, type Rect, revealNode, selectOption, type UiElement } from "./elements.ts";
import type { Frame } from "./models.ts";
import type { Here } from "./recipes.ts";
import type { Action, KEYS } from "./screen.ts";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { browserCdp, browserWindow, helperPath, native, openBackgroundWindow, stale, type UiaNode, userWindowTitle, windowFrame } from "./windows.ts";

export interface Hand {
  id: number;
  /** The page's DOM when the hand's browser is the worked window, else the native window's UI Automation tree. */
  observe(): Promise<Observation>;
  /** A screen.ts Action, through channels that need no focus. Throws one sentence when it cannot be done from behind. */
  perform(action: Action): Promise<void>;
  /** Navigate the hand's browser, starting it behind the user's windows if it is not running. The browser becomes the worked window. */
  open(url: string): Promise<void>;
  /** Start a native app behind the user's windows and make it the worked window. */
  launch(app: string): Promise<void>;
  /** What the hand's browser shows now, or null when it has no page. */
  here(): Promise<Here | null>;
  /** Title of the window the USER is looking at. */
  onScreen(): Promise<string | null>;
  /**
   * The worked window and its size in pixels, for the feed's tile and cursor. Never asks Windows: it is what the last open, launch or look saw.
   * `page`, for the browser: a page element's rect is CSS pixels of the viewport, which starts under the toolbar, so in the window's
   * pixels it is at `page.x + rect.x * page.scale`, `page.y + rect.y * page.scale`. A native element's rect is the window's pixels already.
   */
  window(): { hwnd: number; frame: [number, number]; page?: { x: number; y: number; scale: number } } | null;
  /** Additive to the brief: an element's rectangle in the pixels of `window().frame`, which is that sum done. */
  place(el: UiElement): [number, number, number, number];
  /** Lets go of the page and closes the app windows this hand launched, the way their close button does. The browser stays: the next request carries on from its page. */
  close(): Promise<void>;
}

export interface HandOptions {
  id?: number;
  /** An open DevTools connection to the hand's browser. Without one the hand takes the process's own (windows.ts `browserCdp`) when it first needs a page. */
  cdp?: Cdp;
  /** "Google Chrome" or "Microsoft Edge". */
  browser?: string;
  /** How long `open` waits for a page before working on what has loaded. */
  loadMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const [PAGE_MS, WHEEL_MS, SETTLE_MS, WAIT_MS] = [10_000, 1200, 3000, 1000];
/** Listings a launch waits through for its window: each is a run of the helper and a pause, so about nine seconds. */
const LAUNCH_LOOKS = 24;

interface Key {
  key: string;
  code: string;
  vk: number;
  text?: string;
  /** DevTools bits: alt 1, ctrl 2, shift 8. */
  modifiers?: number;
  /** Chromium runs an editing shortcut only when the command is named. */
  commands?: string[];
  /** The browser's own shortcuts never reach a page as keys. */
  page?: "back" | "reload";
}
/** Every key of screen.ts KEYS, by type: one added there does not compile until it is here. */
const KEY: Record<keyof typeof KEYS, Key> = {
  Return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  "shift+Tab": { key: "Tab", code: "Tab", vk: 9, modifiers: 8 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  BackSpace: { key: "Backspace", code: "Backspace", vk: 8 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  Down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  Up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  "ctrl+a": { key: "a", code: "KeyA", vk: 65, modifiers: 2, commands: ["selectAll"] },
  "alt+Left": { key: "ArrowLeft", code: "ArrowLeft", vk: 37, modifiers: 1, page: "back" },
  F5: { key: "F5", code: "F5", vk: 116, page: "reload" },
};

/** What people call an app, as something Windows can start. Any other name is started as given. */
const APPS: Record<string, string> = { calculator: "calc", paint: "mspaint", "file explorer": "explorer", files: "explorer", settings: "ms-settings:", word: "winword", terminal: "wt", "command prompt": "cmd" };

/** Runs in the page. Puts the cursor in the node of a look, with what it holds selected when it is to be replaced. "focused", "not focused", or null when the node is gone. */
export const focusNode = (token: string, index: number, replace: boolean): string => `(() => {
  const kept = window.__hands, el = kept && kept.token === ${JSON.stringify(token)} ? kept.nodes[${Number(index)}] : null;
  if (!el || !el.isConnected) return null;
  // A search box is often a wrapper around the real input: when the cursor is already inside, it stays there.
  if (!el.contains(document.activeElement)) el.focus();
  const field = el.contains(document.activeElement) ? document.activeElement : null;
  if (!field) return "not focused";
  if (${Boolean(replace)}) {
    if (typeof field.select === "function") field.select();
    else { const all = document.createRange(); all.selectNodeContents(field); const chosen = getSelection(); chosen.removeAllRanges(); chosen.addRange(all); }
  }
  return "focused";
})()`;

/** Runs in the page. How far the document is, and the viewport with the window around it, which is where the page sits in the window. */
const READY = "JSON.stringify([document.readyState, innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio])";

const LATE = Symbol("late");
/** `work`, or LATE once `ms` have passed. What arrives after that is dropped: a page that is navigating away may never answer. */
function soon<T>(work: Promise<T>, ms: number): Promise<T | typeof LATE> {
  let timer: ReturnType<typeof setTimeout>;
  work.catch(() => {});
  return Promise.race([work, new Promise<typeof LATE>((resolve) => (timer = setTimeout(resolve, ms, LATE)))]).finally(() => clearTimeout(timer));
}

const words = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.trim();
/** The session is gone, so the command never arrived: a tab that crashed or closed, a target that was swapped. */
const lost = (error: unknown): boolean => /session with given id|no target with given id|target (closed|crashed)|not attached|detached/i.test(words(error));
/** The document was swapped while it was being asked. */
const moved = (error: unknown): boolean => /execution context|cannot find context|navigated or closed/i.test(words(error));
const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const called = (el: UiElement): string => `${el.role} ${JSON.stringify(el.name)}`;

interface Listing {
  foreground: number;
  windows: { id: number; app: string; title: string; minimized: boolean; frame: Frame }[];
}

export async function openHand(options: HandOptions = {}): Promise<Hand> {
  const id = options.id ?? 1;
  const [sleep, log, loadMs, browser] = [options.sleep ?? Bun.sleep, options.log ?? (() => {}), options.loadMs ?? 8000, options.browser ?? "Google Chrome"];
  const say = (line: string) => log(`hand ${id}: ${line}`);

  let cdp: Cdp | null = null;
  let session: PageSession | null = null;
  let [unwatch, unhear] = [() => {}, () => {}];
  /** The tab to attach to next, and the tabs to fall back to when one that was followed closes. */
  let follow: string | undefined;
  const back: string[] = [];
  let working: "page" | "native" | undefined;
  let chrome: { hwnd: number; size: [number, number] } | null = null;
  let app: { hwnd: number; title: string; frame: Frame } | null = null;
  const opened = new Map<number, string>();
  /** The last look: the token its nodes are kept under, the viewport and the window around it, the native tree. */
  let [looks, token] = [0, ""];
  let view: { inner: [number, number]; outer: [number, number]; dpr: number } | null = null;
  let [nodes, seen] = [[] as UiaNode[], [] as UiElement[]];
  const said: string[] = [];

  // ---------------------------------------------------------------- the page, over one session

  /** Chrome's profile lock is there exactly while it runs (delete-on-close), and asking a port nobody listens on costs seconds. */
  const running = (): boolean => existsSync(join(dirname(helperPath()), "browser", "lockfile"));

  function watch(connection: Cdp): void {
    cdp = connection;
    const gone = () => void (cdp === connection && ([cdp, session, chrome] = [null, null, null]));
    void connection.closed.then(gone, gone);
    // A link that opens a tab takes the window with it, so the hand goes where a person's eyes would; when that tab closes it comes back.
    void connection.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    unwatch = connection.on(({ method, params }: CdpEvent) => {
      if (!session) return;
      const info = params?.targetInfo;
      if (method === "Target.targetCreated" && info?.type === "page" && info.openerId === session.targetId) (back.push(session.targetId), (follow = info.targetId), (session = null));
      else if ((method === "Target.targetDestroyed" || method === "Target.targetCrashed") && params?.targetId === session.targetId) ((follow = back.pop()), (session = null));
      else if (method === "Target.detachedFromTarget" && params?.sessionId === session.sessionId) session = null;
    });
  }

  if (options.cdp) watch(options.cdp);

  /** The hand's one page session, attached when there is none: the first time, and again after its target went away. */
  async function attached(): Promise<PageSession> {
    if (session) return session;
    if (!cdp) {
      if (!running()) throw new Error("the hand has no window open yet");
      watch(await browserCdp());
    }
    const [connection, wanted] = [cdp!, follow];
    follow = undefined;
    const page = await (wanted ? attachPage(connection, wanted).catch(() => attachPage(connection)) : attachPage(connection));
    unhear();
    unhear = page.on(({ method, params }) => {
      if (method !== "Page.javascriptDialogOpening") return;
      // A dialog stops the page until it is answered, and Jev cannot see it. Only what has one answer is said yes to: a notice, and leaving a page the hand was told to leave.
      said.push(`the page said: ${JSON.stringify(String(params.message).slice(0, 200))}`);
      void page.send("Page.handleJavaScriptDialog", { accept: params.type === "alert" || params.type === "beforeunload" }).catch(() => {});
    });
    // Without focus emulation a page that is not the OS focus shows no caret and drops some keys.
    await Promise.all([page.send("Page.enable"), page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {})]);
    working ??= "page";
    return (session = page);
  }

  /** One command to the page. Asked once more, on a fresh attachment, when the session was gone (it never arrived); a read also when the document was swapped under it. */
  async function toPage<T>(work: (page: PageSession) => Promise<T>, reading = false, ms = PAGE_MS): Promise<T> {
    for (let again = false; ; again = true) {
      try {
        const answer = await soon(work(await attached()), ms);
        if (answer === LATE) throw new Error(`the page did not answer within ${ms / 1000} seconds`);
        return answer;
      } catch (error) {
        if (again || !(lost(error) || (reading && moved(error)))) throw error;
        if (lost(error)) session = null;
        else await sleep(100);
      }
    }
  }
  const read = <T>(expression: string): Promise<T> => toPage((page) => page.evaluate<T>(expression), true);
  /** Input is sent once: a click asked twice is two clicks. */
  const input = <T = any>(method: string, params: object = {}, ms = PAGE_MS): Promise<T> => toPage((page) => page.send<T>(method, params), false, ms);

  /** Until the document is there to be read, or the time is up: then the hand works on what has loaded. */
  async function loaded(ms: number): Promise<void> {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      const raw = await soon(read<string>(READY), Math.max(100, end - performance.now())).catch(() => LATE);
      const [ready, ...sizes] = typeof raw === "string" ? (JSON.parse(raw) as [string, number, number, number, number, number]) : ["loading"];
      if (sizes.length) view = { inner: [sizes[0]!, sizes[1]!], outer: [sizes[2]!, sizes[3]!], dpr: sizes[4]! };
      if (ready === "interactive" || ready === "complete") return;
      await sleep(100);
    }
  }

  async function lookAtPage(): Promise<Observation> {
    const mine = `h${id}-${++looks}`;
    // The window around the viewport rides along, so placing an element in the window costs no trip of its own.
    const raw = await read<string>(`JSON.stringify([${readPage(mine)}, outerWidth, outerHeight, devicePixelRatio])`);
    const [dump, outerWidth, outerHeight, dpr] = JSON.parse(raw) as [string, number, number, number];
    const page = JSON.parse(dump) as PageDump;
    [token, view] = [mine, { inner: page.view, outer: [outerWidth, outerHeight], dpr }];
    page.texts.unshift(...said.splice(0));
    return pageObservation(page);
  }

  async function reveal(target: UiElement): Promise<Rect | null> {
    const raw = await read<string | null>(revealNode(token, Number(target.ref)));
    return raw ? (JSON.parse(raw) as Rect) : null;
  }

  async function click(target: UiElement, button: "left" | "right", count: number): Promise<void> {
    const rect = await reveal(target);
    if (!rect) throw new Error(`${called(target)} is no longer there, or something covers it`);
    const [x, y] = centerOf(rect);
    await input("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    // A double click is two clicks that count themselves: that is what makes the page's `dblclick`.
    for (let n = 1; n <= count; n++) {
      await input("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: button === "right" ? 2 : 1, clickCount: n });
      await input("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: n });
    }
  }

  async function press(key: Key): Promise<void> {
    if (key.page === "reload") return void (await input("Page.reload"));
    if (key.page === "back") {
      // Not `history.back()`: a page that leaves while it is being asked looks like a lost answer, and asking again goes back twice.
      const { currentIndex, entries } = await input<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
      if (currentIndex > 0) await input("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1]!.id });
      return;
    }
    const event = { key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, modifiers: key.modifiers ?? 0 };
    await input("Input.dispatchKeyEvent", { type: key.text ? "keyDown" : "rawKeyDown", ...event, ...(key.text ? { text: key.text } : {}), ...(key.commands ? { commands: key.commands } : {}) });
    await input("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  }

  async function onPage(action: Action): Promise<void> {
    if (action.kind === "wait") return sleep(WAIT_MS);
    if (action.kind === "click") await click(action.target, action.button, action.count);
    else if (action.kind === "select") {
      const reply = await read<string>(selectOption(token, Number(action.target.ref), action.option));
      if (reply !== "set") throw new Error(`${JSON.stringify(action.option)} could not be chosen in ${called(action.target)}: ${reply}`);
    } else if (action.kind === "type") {
      if (action.target) {
        // What a field holds is replaced, not added to. A password's value is never read, so it is always replaced.
        const replace = Boolean(action.target.value || action.target.secret);
        let focus = await read<string | null>(focusNode(token, Number(action.target.ref), replace));
        // A field that only a click wakes (a box that swaps in its input) is clicked, as a person would.
        if (focus === "not focused") (await click(action.target, "left", 1), (focus = await read<string | null>(focusNode(token, Number(action.target.ref), replace))));
        if (focus !== "focused") throw new Error(`${called(action.target)} ${focus === null ? "is no longer there" : "did not take the cursor"}`);
      }
      await input("Input.insertText", { text: action.text });
      if (!action.submit) return; // text alone takes a page nowhere
      await press(KEY.Return);
    } else if (action.kind === "key") await press(KEY[action.combo]);
    else {
      const [width, height] = view?.inner ?? [1280, 720];
      const deltaY = (action.direction === "down" ? 1 : -1) * Math.round(height * 0.8);
      // The wheel, because it scrolls what is under it (a list pane, a dialog) and `scrollBy` only the document. Chrome answers a
      // wheel once a frame has taken it, and a covered window can go without frames: then the document is scrolled instead.
      await input("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(width / 2), y: Math.round(height / 2), deltaX: 0, deltaY }, WHEEL_MS).catch(() => read(`window.scrollBy(0, ${deltaY})`));
      return;
    }
    // A press can start a navigation. Waiting here for the new document costs a trip; looking too early costs Jev a whole screen.
    await sleep(80);
    await loaded(SETTLE_MS);
  }

  // ---------------------------------------------------------------- any other window, through the helper

  const act = (ref: string, verb: string, text?: string): { ok: boolean; tookFocus?: boolean } => native.run("act", ref.split(":")[0]!, ref, verb, ...(text === undefined ? [] : [base64(text)]));

  /** One run of the helper: the tree's first node is the window itself, so its title and frame need no listing of their own. */
  function lookAtWindow(): Observation {
    const window = app!;
    nodes = native.run("tree", window.hwnd).nodes as UiaNode[];
    const root = nodes[0]?.parent === -1 && nodes[0].ref.startsWith(`${window.hwnd}:`) ? nodes[0] : undefined;
    if (!nodes.length && !windowFrame(window.hwnd)) throw new Error(`the ${JSON.stringify(window.title)} window has closed`);
    [window.title, window.frame] = [root?.name || window.title, root?.frame ?? window.frame];
    const obs = nativeObservation(nodes, window.title, window.frame);
    seen = obs.elements;
    return obs;
  }

  function onWindow(action: Action): void | Promise<void> {
    const window = app!;
    if (action.kind === "wait") return sleep(WAIT_MS);
    let took = false;
    if (action.kind === "click") {
      if (action.button === "right") throw new Error(`a right click on ${called(action.target)} needs the real pointer, and a hand never takes it`);
      const [x, y] = centerOf(action.target.rect);
      // There is no pattern for a double click. Posted to the window it reaches a classic list; XAML reads only the real pointer.
      if (action.count === 2) native.run("pointer", window.hwnd, 2, window.frame[0] + x, window.frame[1] + y);
      else {
        const reply = act(String(action.target.ref), "press");
        if (!reply.ok) throw new Error(`${called(action.target)} cannot be pressed from behind`);
        took = Boolean(reply.tookFocus);
      }
    } else if (action.kind === "type") {
      const field = action.target ?? seen.find((el) => el.focused && el.editable);
      if (!field) throw new Error("typing with no field named needs the keyboard, and a hand never takes it");
      // `set` is EM_REPLACESEL for a classic edit control (ValuePattern.SetValue would give it the focus) and the value pattern for the rest.
      const reply = act(String(field.ref), "set", action.text);
      if (!reply.ok) throw new Error(`${called(field)} does not take text from behind`);
      took = Boolean(reply.tookFocus);
      if (action.submit) native.run("key", String(field.ref).split(":")[0]!, KEY.Return.vk, "");
    } else if (action.kind === "select") throw new Error(`${called(action.target)} cannot be set from behind: press it, then press the option it shows`);
    else if (action.kind === "key") {
      // A posted key carries no held modifier: "ctrl+a" would arrive as the letter a.
      if (KEY[action.combo].modifiers) throw new Error(`${action.combo} needs the real keyboard, and a hand never takes it`);
      native.run("key", window.hwnd, KEY[action.combo].vk, "");
    } else {
      const areas = nodes.filter((n) => n.actions.includes("scroll") && n.frame).sort((a, b) => b.frame![2] * b.frame![3] - a.frame![2] * a.frame![3]);
      if (!areas.some((area) => act(area.ref, action.direction).ok)) throw new Error("nothing in this window scrolls from behind");
    }
    if (took) say("the app took the focus for a moment, and it was given back");
  }

  // ---------------------------------------------------------------- the hand

  const listing = (): Listing => native.run("windows");

  function where(): ReturnType<Hand["window"]> {
    if (working === "native") return app && { hwnd: app.hwnd, frame: [app.frame[2], app.frame[3]] };
    if (working !== "page" || !chrome) return null;
    if (!view) return { hwnd: chrome.hwnd, frame: chrome.size };
    // The page came along with the last look, so this costs nothing. The toolbar is all above it, and the border below is as wide as the ones beside.
    // A window Windows gave no size for is measured by the page: the feed divides by this, and nothing is a share of zero.
    const frame: [number, number] = chrome.size[0] ? chrome.size : [Math.round(view.outer[0] * view.dpr), Math.round(view.outer[1] * view.dpr)];
    const x = Math.max(0, Math.round((frame[0] - view.inner[0] * view.dpr) / 2));
    return { hwnd: chrome.hwnd, frame, page: { x, y: Math.max(0, Math.round(frame[1] - view.inner[1] * view.dpr - x)), scale: view.dpr } };
  }

  return {
    id,

    observe: async () => (working === "native" ? lookAtWindow() : lookAtPage()),

    async perform(action) {
      const started = performance.now();
      const target = "target" in action && action.target ? action.target : null;
      if (target && isNative(target) !== (working === "native")) throw new Error(`${called(target)} belongs to a window the hand is no longer working in`);
      try {
        await (working === "native" ? onWindow(action) : onPage(action));
      } catch (error) {
        throw new Error(words(error)); // one sentence, and never what was being typed
      } finally {
        stale(); // anything may have moved a window or changed a title
      }
      const what = action.kind === "key" ? ` ${action.combo}` : action.kind === "scroll" ? ` ${action.direction}` : target ? ` ${called(target)}` : "";
      say(`${action.kind}${what} ${working === "native" ? "through the helper" : "over DevTools"}, ${Math.round(performance.now() - started)} ms`);
    },

    async open(url) {
      const started = performance.now();
      if (session || cdp) {
        const reply = await soon(input<{ errorText?: string }>("Page.navigate", { url }, loadMs + 1000), loadMs);
        // ERR_ABORTED is a download, or a page that went on somewhere else by itself: neither is a failure to load.
        if (reply !== LATE && reply.errorText && !reply.errorText.includes("ERR_ABORTED")) throw new Error(`${url} did not load: ${reply.errorText}`);
      } else {
        // The page is already on its way there when this returns: through the tab that shows, or as the address the browser started with.
        const pinned = await openBackgroundWindow(browser, url);
        watch(await browserCdp());
        follow = pinned.scripted || undefined;
        const frame = windowFrame(pinned.windowId);
        chrome = { hwnd: pinned.windowId, size: [frame?.[2] ?? 0, frame?.[3] ?? 0] };
        await attached();
      }
      working = "page";
      await loaded(Math.max(500, loadMs - (performance.now() - started)));
      if (!chrome && session) {
        const window = await browserWindow(session.targetId).catch(() => null);
        chrome = window && { hwnd: window.id, size: [window.frame[2], window.frame[3]] };
      }
      stale();
      say(`opened ${url.slice(0, 120)} in ${Math.round(performance.now() - started)} ms`);
    },

    async launch(name) {
      const started = performance.now();
      const command = APPS[name.trim().toLowerCase()] ?? name.trim();
      const asked = [name.trim().toLowerCase(), command.toLowerCase().replace(/\.exe$|:$/g, "")];
      const its = (w: Listing["windows"][number]) => asked.some((word) => [w.app, w.title].some((text) => text.toLowerCase().includes(word)));
      const before = listing();
      // A window this hand opened earlier is taken up again. One of the user's is never worked in, so the app is started anew.
      let window = before.windows.find((w) => opened.get(w.id) === asked[0]);
      if (!window) {
        const known = new Set(before.windows.map((w) => w.id));
        native.run("launch", base64(command), base64(""), "background");
        // The launch is not waited for: an app reports ready seconds after its window exists. The window is taken as it appears.
        let now = before;
        for (let looked = 0; !window && looked < LAUNCH_LOOKS; looked++) {
          await sleep(150);
          window = (now = listing()).windows.find((w) => !known.has(w.id) && its(w));
        }
        if (!window) {
          // An app that was already running may have answered by coming forward: the user gets their window back.
          if (now.foreground !== before.foreground) native.run("front", before.foreground);
          stale();
          throw new Error(`${name} showed no window of its own`);
        }
        // Shown without being activated, under every other window: minimized it would paint nothing for the feed.
        native.run("behind", window.id, before.foreground);
        if (window.minimized) window = listing().windows.find((w) => w.id === window!.id) ?? window; // its real size, now that it has one
        opened.set(window.id, asked[0]!);
      }
      [app, working, nodes, seen] = [{ hwnd: window.id, title: window.title, frame: window.frame }, "native", [], []];
      stale();
      say(`launched ${name} in ${Math.round(performance.now() - started)} ms`);
    },

    async here() {
      if (!session && !cdp && !running()) return null;
      const raw = await read<string>("JSON.stringify({ url: location.href, title: document.title })").catch(() => null);
      const page = raw ? (JSON.parse(raw) as Here) : null;
      return page && /^https?:/.test(page.url) ? page : null;
    },

    async onScreen() {
      try {
        return userWindowTitle();
      } catch {
        return null;
      }
    },

    window: where,

    place(el) {
      const { x, y, w, h } = el.rect;
      const page = (!isNative(el) && where()?.page) || { x: 0, y: 0, scale: 1 };
      return [Math.round(page.x + x * page.scale), Math.round(page.y + y * page.scale), Math.round(w * page.scale), Math.round(h * page.scale)];
    },

    async close() {
      unwatch();
      unhear();
      // The connection is the process's, or the caller's: only the hand's session on it is let go.
      if (cdp && session) await soon(cdp.send("Target.detachFromTarget", { sessionId: session.sessionId }), 1000).catch(() => {});
      [cdp, session, working] = [null, null, undefined];
      for (const hwnd of opened.keys()) {
        try {
          native.run("close", hwnd); // WM_CLOSE, never the process: ApplicationFrameHost hosts Calculator next to the user's Settings
        } catch {
          // already closed
        }
      }
      opened.clear();
      stale();
    },
  };
}
