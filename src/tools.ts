/**
 * Computer use as agent tools: the clicker's own perception and actions handed to a language model one at a time.
 *
 * A hand works in windows of its own, behind the user's, and everything here names its target instead of going
 * through the seat: one window is captured by id, accessibility reads and presses that window's controls, keys are
 * posted to that window (or, on the Mac, its process), pointer events are addressed to it alone, and apps are started
 * without being brought forward. None of it moves the mouse or changes what is in front. On Windows the few things
 * that cannot be done from there (a shortcut, where a posted key carries no modifier; a drag an app ignores; a click
 * that had no effect) borrow the seat for one action: src/seat.ts waits for the user to pause, and gives it back. The
 * Mac has no borrow yet, so there the model is told to do it from behind or to finish with needs_you.
 *
 * Every coordinate a tool takes or reports is a point of the latest capture: a pixel on Windows, where a capture is
 * at scale 1, and a point of the window on the Mac, where the screenshot the model sees is drawn at one pixel a point.
 */

import { readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, win32 } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import sharp from "sharp";
import { type TSchema, Type } from "typebox";
import { pressOffscreen } from "./actions.ts";
import * as config from "./config.ts";
import { hand, quote } from "./hand.ts";
import { onWindows, platform as macos, seat } from "./platform.ts";
import { Abort, center, type Item, type Point, repr, roleWord, type Screen, sizePt } from "./models.ts";
import { capture, glance, OcrCache, perceive, stillAs, type Thumb } from "./perception.ts";
import { type KeyTarget, SeatBusy, SeatTaken } from "./seat.ts";
import * as windows from "./windows.ts";

const SETTLE_FLOOR_MS = 150; // the least a capture waits after an action, for the action to land
const SETTLE_POLL_MS = 150; // between the glances that tell whether the window has stopped changing
const SETTLE_CAP_MS = 3000; // the most, for a window that never stops (a video, a spinner)
const UNTIL_POLL_S = 1; // between the looks of a `wait` for some text
const ITEM_TEXT_CHARS = 600;
const VALUE_CHARS = 120;
// A model reading a listing has no Choice ceiling, and a busy page has hundreds of things on it.
const SCREEN_ITEMS = 600;
const PAGE_LOAD_MS = 10_000; // how long a navigation may keep a capture waiting
const SCROLL_LINES = 10; // what a borrowed wheel turns, the way a page's own scroll would
// The words the model reads: the Mac strings stay as they were, and Windows gets its own apps, modifier and menus.
const appNames = (mac: string) => (onWindows() ? "e.g. Calculator, Notepad, Paint, Excel" : `As in /Applications, e.g. ${mac}`);
const MOD = onWindows() ? "ctrl" : "cmd";
const KEY_EXAMPLES = `e.g. \`return\`, \`tab\`, \`${MOD}+s\`, or \`${MOD}+a delete\``;
const MENU = onWindows()
  ? 'A command from a classic app\'s menu bar (Notepad, Paint, Explorer), by its path: ["File", "Save"]. The menu opens on screen while the ' +
    "item is pressed, and closes again. Office has no menu bar: its ribbon tabs and buttons are items in the listing, pressed with `click`; " +
    "an app drawn like a web page (Claude, WhatsApp) has none either."
  : 'A command from the app\'s menu bar, by its path: ["File", "New Note"]. The item is pressed in place, so no menu opens on screen.';
const PRESS = onWindows()
  ? "An item with a role (link, button, tab, checkbox, popup, cell...) is pressed through accessibility; on a web page, or in an app drawn " +
    "like one (Claude, WhatsApp, Teams), that press is a click at the item's centre, so check the next capture."
  : "An item with a role (link, button, tab, checkbox, popup, cell...) is pressed through accessibility, which is the sure way.";
const KEYS = onWindows()
  ? "Keys are posted to your window, to wherever its own cursor is, the browser included. A shortcut with ctrl, alt or shift cannot " +
    "be posted, so it is pressed with the user's keyboard for a moment, once they pause."
  : "Keys go to the app's process, to wherever its own cursor is (not available in the browser, where they would reach the user's window).";
const OPENS = onWindows()
  ? "Open a Windows application in a window of your own, behind the user's windows, and work in it from here on"
  : "Start a macOS application without bringing it forward, and work in its current window from here on";
const SHELL_KEYS = onWindows()
  ? " Keys that act on the whole desktop (the Windows key, alt+tab, ctrl+escape, alt+f4) are never pressed. In your browser window `tab` is " +
    "not pressed either: past the page's last control it reaches the browser's own toolbar, where `return` presses the browser's buttons. " +
    "Click the field you want instead."
  : "";
const SEAT_DESCRIPTION = "Borrow the user's real mouse and keyboard for this one action, once they pause: only when doing it from behind had no effect.";
const BORROWED = " (borrowed the user's mouse and keyboard for a moment, and gave them back)";
// Office takes posted characters badly (the first of a cell is lost, a formula's = with it), so its typing borrows the seat.
const OFFICE = /^(excel|winword|powerpnt)(\.exe)?$/i;
// A web field refuses a line break from behind (src/windows.ts), since a page takes Enter as "send".
const LINE_BREAK = /^line break:/;
// The Mac has no borrow of the seat yet (src/macos-seat.ts), and says so in these words.
const NOT_ON_MAC = /^not on the Mac:/;
// A browser's own name: open_app with it gives the user's own browser window, never one of the hand's.
const BROWSER_APP = /^(google chrome|chrome|microsoft edge|msedge|edge|brave( browser)?|firefox|safari|arc|opera|vivaldi)(\.exe)?$/i;
// A context menu goes the moment the seat is handed back, and no capture of the window shows it: there is no right click.
const NO_RIGHT_CLICK = "there is no right click: a context menu cannot be used from behind, and it closes as soon as the user's mouse is given back. Use the app's own menu, ribbon or buttons for what it holds";
/** How long a window that shows no change yet is watched after an action, for a reaction that starts late. A test shortens it. */
export const settling = { unchangedMs: 800 };
/**
 * The click guard's own wait for the user to pause (src/windows.ts, before a click into a Chromium window) shown on the
 * hand and its card as a borrow's wait is, so a hand held up by a busy user does not look as if it were clicking. Only
 * where the platform tells of that wait: Windows, through `hooks.onSeatWait` (a listener it calls with "waiting" and
 * "free"). A platform without it says nothing, and the guard waits unseen.
 */
function seatWaits(tell: (state: "waiting" | "free", why: string) => void): void {
  const hooks = (windows as unknown as { hooks?: { onSeatWait?: unknown } }).hooks;
  if (!onWindows() || !hooks || !("onSeatWait" in hooks)) return;
  hooks.onSeatWait = (state: "waiting" | "free", why: string) => {
    guardWaiting = state === "waiting";
    tell(state, why);
  };
}
let guardWaiting = false; // the guard's wait is shown on the hand: a tool that ends any way at all (an Abort, say) shows it over

/** On Windows, once: that an app just opened cannot work on the hand's own desktop (src/windows.ts). Nothing on the Mac. */
const desktopNote = (): string => {
  const note = onWindows() ? windows.desktopNote() : null;
  return note ? ` (${note})` : "";
};

export interface ToolOptions {
  runDir: string;
  /** Where the shell and file tools work, and where a relative path given to `open_app` is found. */
  cwd?: string;
  /** The user asked to stop: the mouse hit a corner, or Ctrl-C. */
  onAbort: (reason: string) => void;
}

/** How a task ended, in the model's own words: its `finish` call. */
export type Outcome = "done" | "needs_you" | "could_not";
export interface Finish {
  outcome: Outcome;
  summary: string;
  /** The hand left pages or files open for the user: its browser windows stay when it is dismissed (src/agent.ts). */
  keep_open?: boolean;
}

/** `listing` marks a result that describes the screen, which goes stale and is cut from the transcript like any other; `finish` carries the model's verdict. */
export type Details = { listing?: true; finish?: Finish } | undefined;
type Result = AgentToolResult<Details>;
const say = (text: string): Result => ({ content: [{ type: "text", text }], details: undefined });

type MakeTool = <T extends TSchema>(name: string, description: string, parameters: T, execute: (params: any) => Promise<Result>) => AgentTool<any>;

/**
 * A tool that drives the machine: one at a time, and never past an abort. A stop, a pause or a click on the hand that
 * comes while a tool is under way reaches it through the platform's interrupt, which every wait for the seat checks
 * (src/windows.ts): the Abort thrown there ends the run where it is, as the stop or pause it was.
 */
const toolMaker =
  (onAbort: ToolOptions["onAbort"]): MakeTool =>
  (name, description, parameters, execute) => ({
    name,
    label: name,
    description,
    parameters,
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      try {
        if (signal?.aborted) throw new Abort("stopped");
        macos.checkAbort();
        return await execute(params);
      } catch (error) {
        if (error instanceof Abort) onAbort(error.message);
        throw error;
      } finally {
        if (guardWaiting) {
          guardWaiting = false;
          hand.seat("free");
        }
      }
    },
  });

/** The capture at one pixel per screen point, which is the space every coordinate in a listing is in. */
async function withScreenshot(result: Result, screen: Screen): Promise<Result> {
  const [width, height] = sizePt(screen).map(Math.round) as Point;
  const jpeg = await sharp(screen.image.path).resize(width, height, { fit: "fill" }).jpeg({ quality: 80 }).toBuffer();
  result.content.push({ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" });
  return result;
}

/** Where an item is, in the points of its capture: the space the hand moves in. */
const spot = (screen: Screen, it: Item): Point => center(it).map((v) => v / screen.scale) as Point;
/** Which way two fingers go to scroll that way. */
const SWIPES: Record<string, Point> = { up: [0, 1], down: [0, -1], left: [1, 0], right: [-1, 0] };
const times = (count: number): string => (count > 1 ? ` x${count}` : "");
const brief = (text: string, limit = 80): string => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** The chords a key string names, pressed in order: `ctrl+a delete` is two. A lone `+` is the key itself. */
export const chords = (keys: string): { key: string; modifiers: string[] }[] =>
  keys
    .trim()
    .split(/\s+/)
    .map((chord) => {
      const parts = chord.length > 1 ? chord.split("+") : [chord];
      return { key: parts.pop()!, modifiers: parts };
    });

/** A modifier by one name whatever alias the model used. On Windows cmd is ctrl, as the platform itself takes it. */
const modifierName = (name: string): string =>
  ({ cmd: MOD, command: MOD, control: "ctrl", option: "alt", opt: "alt", windows: "win", super: "win", meta: "win" })[name.toLowerCase()] ?? name.toLowerCase();

/**
 * Why a chord is never pressed, or null: it acts on the user's whole desktop rather than on a window (the Start menu,
 * the app switcher, closing whatever is in front), so from a hand it would land on whatever the user is doing.
 */
export function shellChord(key: string, modifiers: string[]): string | null {
  const [name, held] = [key.toLowerCase(), new Set(modifiers.map(modifierName))];
  if (["win", "lwin", "rwin", "windows", "super"].includes(name) || held.has("win")) return "the Windows key acts on the user's whole desktop (Start, Run, snapping windows)";
  if (held.has("ctrl") && (name === "escape" || name === "esc")) return "ctrl+escape opens the Start menu over whatever the user is doing";
  if (held.has("alt") && name === "tab") return "alt+tab switches the user's windows";
  if (held.has("alt") && name === "f4") return "alt+f4 closes whichever window is in front, which may be the user's";
  return null;
}

/** The screenshot numbering picks up after the captures already in a run folder, so a hand given a second task keeps its first one's pictures. */
export function lastCapture(runDir: string): number {
  try {
    return Math.max(0, ...readdirSync(runDir).map((name) => Number(/^screen-(\d+)\.png$/.exec(name)?.[1] ?? 0)));
  } catch {
    return 0;
  }
}

/** Text compared the way a field keeps it: any run of white space (a no-break space too) as one space, ends trimmed. */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * A path the model gave `open_app`, as the file system knows it. The shell it is given on Windows is Git Bash, which
 * prints /c/Users/... (or /mnt/c/..., /cygdrive/c/...), and a model writes ~ for home and file:// URLs as well, as pi's
 * own file tools take them. Anything else is relative to `cwd`.
 */
export function filePath(file: string, cwd: string, home = homedir(), drives = onWindows()): string {
  let path = file.trim().replace(/^file:\/\/(localhost)?(?=\/)/i, "");
  if (path !== file.trim()) {
    try {
      path = decodeURI(path);
    } catch {} // a stray % is taken as it is
    if (/^\/[a-z]:/i.test(path)) path = path.slice(1); // file:///C:/... is C:/...
  }
  if (drives) path = path.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?=\/|$)/i, (_, drive: string) => `${drive.toUpperCase()}:`);
  path = path.replace(/^~(?=[\\/]|$)/, home);
  return (drives ? win32.resolve : resolve)(cwd, /^[a-z]:$/i.test(path) ? `${path}/` : path);
}

/**
 * What a borrow the seat never granted tells the model: its own reason (the user kept on, another hand had it, the
 * window went), and what to do about that reason. Nothing was done in any case.
 */
export function seatRefused(why: string, reason: string): string {
  const advice = /\bgone\b/.test(reason)
    ? "Look again with `screen`."
    : /would not come to the front/.test(reason)
      ? "Look again with `screen`, and do it from behind if you can, or finish with needs_you."
      : /another hand/.test(reason)
        ? "Try again shortly."
        : "Try again in a while, or finish with needs_you if it cannot wait.";
  return `nothing was done (${why}): ${reason}. ${advice}`;
}

/**
 * The tools of one hand. The app being worked, and for the browser the one window in it that is the hand's own, are
 * `target`; the window looked at is the one the platform says to (src/seat.ts workingWindow): the hand's own, or a
 * dialog it has opened.
 */
export function computerTools({ runDir, cwd = process.cwd(), onAbort }: ToolOptions): AgentTool<any>[] {
  const browser = config.browser();
  const ocrCache = new OcrCache();
  const tool = toolMaker(onAbort);
  const scratch = join(tmpdir(), `hands-glance-${process.pid}.png`);
  let target: { app: string; pid: number; pinned?: macos.PinnedWindow; window?: number } | null = null;
  let webWindow: macos.PinnedWindow | null = null; // kept across a spell in another app, so the pages stay where they were
  let view: { screen: Screen; items: Item[] } | null = null;
  let tabsSeen: { url: string | null; tabs: Screen["tabs"] } | null = null; // asked again only when the page changes
  let captures = lastCapture(runDir);
  let lastAction = 0;
  let lastLook = 0;
  // Only Windows borrows the seat (src/macos-seat.ts): the Mac is not offered seat=true, nor told of it.
  const borrows = onWindows();
  const seatParam: Record<string, TSchema> = borrows ? { seat: Type.Optional(Type.Boolean({ description: SEAT_DESCRIPTION })) } : {};
  seatWaits((state, why) => hand.seat(state, why));

  const acted = (text: string): Result => ((lastAction = performance.now()), say(text));
  const current = () => {
    if (!view) throw new Error("no current screen: call `screen` first");
    if (view.screen.readOnly) throw new Error("the last `screen` was the user's own screen, which is only to be read: `open_app` or `browser` open a window of your own to act in");
    return view;
  };
  const mine = () => {
    if (!target) throw new Error("nothing of yours is open yet: `open_app` an app, or `browser` open a url");
    return target;
  };
  /** The window of the latest capture (a dialog, when one is up), as input addresses it. */
  const windowTarget = (): KeyTarget => {
    const { screen } = current();
    return { pid: screen.pid!, windowId: screen.windowId! };
  };
  /** Keys from behind. On the Mac they reach a process, which in the browser means whichever window the user is in. */
  const keyTarget = (): KeyTarget => {
    const { app, pinned } = mine();
    const window = windowTarget();
    if (pinned && !seat.browserKeysFromBehind) {
      throw new Error(`keys go to a process, and in ${app} that means whichever window the user is using. Press the page's own controls instead, or set a field with \`type\` and its item (submit=true sends it).`);
    }
    return window;
  };
  /** A web page, or an app drawn as one: its fields take Enter as "send", and it takes pointer input only where it thinks it can be seen. */
  const web = (): boolean => mine().pinned !== undefined || macos.isWebContentApp(mine().pid);
  /**
   * Whether the browser window the hand opened is still there. On Windows a window the user minimized is still there,
   * and is looked at all the same (the capture restores it behind their windows); the platform's list of an app's
   * windows leaves minimized ones out, and on the Mac windows on another Space, as before.
   */
  const alive = (pinned: macos.PinnedWindow): boolean =>
    macos.appWindows(pinned.pid).some((w) => w.id === pinned.windowId) || (onWindows() && seat.workingWindow(pinned.pid, pinned.windowId) !== null);
  /** The browser window is gone: the next `open` makes a new one. */
  const forgetWindow = () => {
    webWindow = null;
    tabsSeen = null;
    if (target?.pinned) target = null;
  };

  /**
   * The window being worked, as a pointer needs it: where it is now, not where the last capture found it, since
   * showing a sliver of it may have moved it. A page is only handed input while its browser thinks it can be seen,
   * so a browser's window is first slid until some of it shows.
   */
  const pointed = async (): Promise<macos.PointerTarget> => {
    const { app, pid } = mine();
    const windowId = current().screen.windowId!;
    const isWeb = web();
    const place = () => macos.appWindows(pid).find((w) => w.id === windowId)?.frame;
    const before = place();
    if (isWeb && !(await macos.revealWindow(pid, windowId))) {
      const instead = borrows ? "Pass seat=true to do it with the user's mouse once they pause." : "Press an item with a role instead, or finish with needs_you.";
      throw new Error(`${app} only takes pointer input in a window that shows somewhere, and every screen is covered edge to edge. ${instead}`);
    }
    const frame = place();
    if (!frame) throw new Error("the window is gone; look again");
    if (before && (before[0] !== frame[0] || before[1] !== frame[1])) await Bun.sleep(1200); // the browser takes a moment to notice it can be seen
    return { pid, windowId, frame, web: isWeb };
  };
  /** A point of the latest capture, which is window-local, as a global screen point. */
  const onScreen = (target: macos.PointerTarget, x: number, y: number): Point => [target.frame[0] + x, target.frame[1] + y];
  /** The same, from where the window is at this moment: a borrow brings it forward first. */
  const onScreenNow = (x: number, y: number): Point => {
    const { screen } = current();
    const frame = macos.appWindows(screen.pid!).find((w) => w.id === screen.windowId)?.frame ?? screen.window!;
    return [frame[0] + x, frame[1] + y];
  };

  /**
   * One action with the user's own mouse and keyboard (src/seat.ts): it waits for them to pause, holds the seat for
   * `work` alone, and gives it back. The hand and its card show the wait and the hold, and the seat is shown free
   * again however it ends. A stop, a pause or a click on the hand during the wait ends it with an Abort before anything
   * is sent (the platform checks its interrupt there); the work checks once more as it starts, and between its steps.
   * The Mac refuses a borrow outright, which is said as a plain result: nothing was done, and what to do instead.
   */
  const seatAction = async (why: string, work: () => Promise<string>): Promise<Result> => {
    try {
      const done = await seat.withSeat(
        windowTarget(),
        async () => {
          macos.checkAbort();
          return work();
        },
        { why, onWaiting: () => hand.seat("waiting", why), onHolding: () => hand.seat("holding", why) },
      );
      return acted(`${done}${BORROWED}`);
    } catch (error) {
      if (error instanceof Error && NOT_ON_MAC.test(error.message)) {
        return say(`nothing was done (${why}): borrowing the user's mouse and keyboard is not available on the Mac yet. Do it from behind (an item with a role, the app's \`menu\`, \`type\` with an item), or finish with needs_you and say what the user must do.`);
      }
      if (error instanceof SeatBusy) throw new Error(seatRefused(why, error.message));
      if (error instanceof SeatTaken) throw new Error(`the user took the mouse back partway through ${why}, so it may be half done: look with \`screen\` before trying again.`);
      throw error;
    } finally {
      hand.seat("free");
    }
  };
  /** A click from behind that the platform guards (a Chromium window comes forward for an instant) waits for the user to pause too, and says so when they did not. */
  const unguarded = (error: unknown, what: string): unknown =>
    error instanceof SeatBusy ? new Error(`nothing was done (${what}): ${error.message}. The user was busy, or another hand had the mouse and keyboard; try again shortly.`) : error;
  /** Text with the user's keyboard. A page takes Enter as "send", so there each line break is shift+Enter. */
  const typeOnSeat = async (text: string, page: boolean): Promise<void> => {
    if (!page) return macos.typeText(text);
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      if (i > 0) await macos.press("return", ["shift"]);
      await macos.typeText(line);
    }
  };
  const lineBreak = (text: string) =>
    new Error(`${repr(brief(text))} has a line break, and a page takes Enter as "send": write it on one line, or pass seat=true to type it with the user's keyboard once they pause, with shift+Enter between the lines.`);
  /** Tab in the hand's own browser window walks past the page into the browser's toolbar, where Enter presses its buttons (measured: it bookmarked a page in the user's profile). */
  const noTab = (what: string) => {
    if (onWindows() && mine().pinned) throw new Error(`${what} is not pressed in your browser window: past the page's last control Tab reaches the browser's own toolbar, where Enter presses its buttons. Click the field you want instead.`);
  };

  /** The accessibility element behind an item, which is the only way to reach it from here. */
  const control = (index: number) => {
    const { screen, items } = current();
    const it = items.find((candidate) => candidate.index === index);
    if (!it) throw new Error(`no item ${index} on the current screen (${items.length} items); call \`screen\` again`);
    const ref = screen.axRefs.get(index);
    if (ref === undefined) throw new Error(`item ${index} ${repr(it.text)} is text read off the picture, with no control behind it. Pick the control with a role (link, button, field...) instead.`);
    return { it, ref };
  };

  /**
   * After an action, wait for the window to stop changing: two glances alike, and a page that is not loading. At
   * least a moment for the action to land, and at most a few seconds for a window that never stops. A window that has
   * not changed at all is watched a while longer (`settling`, from the action): a chat's Send, an Office command or a
   * page's update often begins only then, and a capture taken before it would say the action did nothing.
   */
  async function settled(windowId: number, scripted?: string): Promise<void> {
    if (lastAction <= lastLook) return;
    const since = performance.now() - lastAction;
    if (since < SETTLE_FLOOR_MS) await Bun.sleep(SETTLE_FLOOR_MS - since);
    let [first, before, changed]: [Thumb | null, Thumb | null, boolean] = [null, null, false];
    for (const end = performance.now() + SETTLE_CAP_MS; performance.now() < end; await Bun.sleep(SETTLE_POLL_MS)) {
      const now = await glance(windowId, scratch);
      if (!now) return; // nothing to watch: the floor is all the wait
      first ??= now;
      changed ||= !stillAs(now, first);
      const loading = scripted !== undefined && (await macos.browserLoading(browser, scripted).catch(() => false));
      if (before && !loading && stillAs(now, before) && (changed || performance.now() - lastAction >= settling.unchangedMs)) return;
      before = now;
    }
  }

  /** The browser window's tabs, which the listing gives in place of its tab strip. Asked again only when the page has changed. */
  async function tabsOf(pinned: macos.PinnedWindow, url: string | null): Promise<Screen["tabs"]> {
    if (tabsSeen && tabsSeen.url === url) return tabsSeen.tabs;
    const tabs = (await macos.browserTabs(browser).catch(() => [])).filter((t) => t.scripted === pinned.scripted);
    const seen = tabs.length ? { count: tabs.length, active: tabs.find((t) => t.active)?.title ?? "" } : undefined;
    tabsSeen = { url, tabs: seen };
    return seen;
  }

  async function listing(screen: Screen, screenshot: boolean): Promise<[Result, Screen]> {
    const items = await perceive(screen, SCREEN_ITEMS, "", undefined, ocrCache);
    view = { screen, items };
    lastLook = performance.now();
    const result: Result = { content: [{ type: "text", text: describe(screen, items) }], details: { listing: true } };
    return [screenshot ? await withScreenshot(result, screen) : result, screen];
  }
  const nextCapture = () => join(runDir, `screen-${String(++captures).padStart(3, "0")}.png`);

  /** The window being worked, or, with nothing of the hand's open, the user's screen to read. */
  async function see(screenshot: boolean): Promise<[Result, Screen]> {
    if (!target) {
      // The display the user is working on, with the hand kept out of it, and not left on it either: nothing there is
      // for the hand to act on. What they are typing stays theirs.
      const screen = await capture({ out: nextCapture(), browser, onlyToRead: true });
      return listing({ ...screen, field: null, readOnly: true }, screenshot);
    }
    const { app, pid, pinned } = target;
    if (pinned && !alive(pinned)) {
      forgetWindow();
      throw new Error("your browser window was closed: `browser` open a url for a new one");
    }
    const working = seat.workingWindow(pid, pinned?.windowId ?? target.window);
    // On the Mac open_app opens no second window of an app that is running, so asking again would change nothing.
    if (!working) throw new Error(onWindows() ? `${app} has no window open: \`open_app\` it again for a window of your own` : `${app} has no window open. Its \`menu\` can make one (File > New...).`);
    await settled(working.windowId, pinned?.scripted);
    const url = pinned ? ((await macos.browserUrl(browser, pinned.scripted)) ?? undefined) : undefined;
    const screen = await capture({ target: { pid, windowId: working.windowId }, out: nextCapture(), url });
    Object.assign(screen, { dialog: working.dialog, theirs: working.theirs });
    if (pinned && !working.dialog) screen.tabs = await tabsOf(pinned, screen.url);
    return listing(screen, screenshot);
  }
  const look = async (screenshot: boolean): Promise<Result> => (await see(screenshot))[0];

  /**
   * An action that changes the page or the app. The last capture no longer describes it, and the model's next move
   * is always to look, so the result is the new listing, led by what the action says of what it found.
   */
  const moved = async (text: string | ((screen: Screen) => string)): Promise<Result> => {
    view = null;
    lastAction = performance.now();
    const scripted = target?.pinned?.scripted;
    for (const end = performance.now() + PAGE_LOAD_MS; scripted && performance.now() < end && (await macos.browserLoading(browser, scripted)); ) await macos.sleepWatching(0.25);
    const [seen, screen] = await see(false);
    return { ...seen, content: [{ type: "text", text: typeof text === "string" ? text : text(screen) }, ...seen.content] };
  };

  const notepads = new Set<number>(); // Notepad windows already given a tab of the hand's own
  /**
   * Notepad reopens the tabs of its earlier sessions in whichever window opens first, and they can hold the user's
   * unsaved notes (a hand once cleared one it took for its own: measured). So a Notepad that comes up with any tab that
   * is not a fresh, empty one gets a new tab for the hand to work in, and the model is told to leave the others alone.
   */
  const freshNotepadTab = async (): Promise<Result | null> => {
    const { screen, items } = current();
    if (screen.windowId === undefined || notepads.has(screen.windowId)) return null; // looked at once: its other tabs now include the hand's own
    notepads.add(screen.windowId);
    const restored = items.filter((it) => it.role === "tab" && !/^untitled\b.*\bunmodified\b/i.test(it.text));
    const add = items.find((it) => it.role === "button" && /^add new tab$/i.test(it.text.trim()));
    const ref = add && screen.axRefs.get(add.index);
    if (!restored.length || ref === undefined || !macos.axPress(ref)) return null;
    const tabs = restored.length === 1 ? "a tab" : `${restored.length} tabs`;
    return moved(`Notepad reopened ${tabs} from an earlier session, which may hold the user's own notes, so a new tab was made for you: work only in it, and leave the others as they are.`);
  };

  return [
    tool(
      "screen",
      "Look at the window you are working in: captures it where it lies, behind the user's windows, and lists everything in it, " +
        "read by OCR and from the accessibility tree, each with an index and its x,y in the capture. Also lists the controls " +
        "scrolled out of view. Indexes are only valid until the next `screen`. Pass screenshot=true to also see the picture. With " +
        "no window of yours open, it shows the user's own screen instead, only to read.",
      Type.Object({ screenshot: Type.Optional(Type.Boolean({ description: "Attach the screenshot itself. Default false." })) }),
      ({ screenshot }) => look(Boolean(screenshot)),
    ),
    tool(
      "open_app",
      // Only Windows opens a document as a window of the hand's own (src/macos-seat.ts openFile): the Mac is not offered `file`.
      `${OPENS}: an app by \`name\`${onWindows() ? ", or a document by `file`, which opens in the app it belongs to" : ""}. Returns the \`screen\` listing.`,
      Type.Object({
        name: Type.Optional(Type.String({ description: appNames("Calculator, Notes, TextEdit") })),
        ...(onWindows() ? { file: Type.Optional(Type.String({ description: `A document to open in its app (an .xlsx in Excel, a .docx in Word): a full path, or one relative to ${cwd}.` })) } : {}),
      }),
      async ({ name, file }) => {
        if (file) {
          const path = filePath(file, cwd);
          void hand.cue("go", `opening ${basename(path)}`);
          const opened = await seat.openFile(path);
          const app = macos.appName(opened.pid);
          target = { app, pid: opened.pid, window: opened.windowId };
          return moved(`opened ${basename(path)} in ${app}, in a window of your own${desktopNote()}`);
        }
        if (!name) throw new Error("give an app's `name`, or a `file` to open in its app");
        void hand.cue("go", `opening ${name}`);
        const pid = await macos.runInBackground(name);
        if (pid === null) throw new Error(`${name} did not start`);
        target = { app: name, pid };
        // A browser is never started again for a window of the hand's: open_app gives the user's own, and `browser` gives one of its own.
        const whose = BROWSER_APP.test(name.trim())
          ? `: this is the user's own ${name} window, to act in only as far as the task asks. For a page of your own, \`browser\` open url=...`
          : "";
        const opened = await moved(`opened ${name}${whose}${desktopNote()}`);
        return (onWindows() && /^notepad(\.exe)?$/i.test(name.trim()) && (await freshNotepadTab())) || opened;
      },
    ),
    tool(
      "menu",
      `${MENU} A path that stops at a menu lists what is in it, and an empty path lists the menu bar: look before you guess a name.`,
      Type.Object({ path: Type.Array(Type.String(), { description: 'e.g. ["Edit", "Select All"], or ["View"] to see what View holds' }) }),
      async ({ path }: { path: string[] }) => {
        if (path.length) void hand.cue("press", `menu ${path.join(" › ")}`);
        const result = macos.menu(mine().pid, path);
        return "items" in result ? say(`${path.join(" > ") || "menu bar"}: ${result.items.join(", ")}`) : moved(`chose ${result.pressed}`);
      },
    ),
    tool(
      "click",
      `Click in the window you are working in. ${PRESS} Anything else, plain text, a canvas, a bare x,y, gets a pointer click addressed ` +
        "to this window alone: the user's cursor does not move. Prefer an item with a role whenever one carries what you want. There is " +
        "no right click: a context menu cannot be used from behind, so use the app's own menu, ribbon or buttons for what it holds.",
      Type.Object({
        item: Type.Optional(Type.Integer({ description: "Index from the latest `screen`." })),
        x: Type.Optional(Type.Number({ description: "Point of the latest capture, when there is no item to name." })),
        y: Type.Optional(Type.Number()),
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "2 for a double click." })),
        ...seatParam,
      }),
      async ({ item: index, x, y, button = "left", count = 1, seat: borrow = false }) => {
        // A right click opens a menu that the seat's handing back closes, and that no capture of the window shows.
        if (button === "right") throw new Error(`${NO_RIGHT_CLICK}.`);
        const { screen, items } = current();
        const it = index === undefined ? undefined : items.find((candidate) => candidate.index === index);
        if (index !== undefined && !it) throw new Error(`no item ${index} on the current screen (${items.length} items); call \`screen\` again`);
        if (!it && (x === undefined || y === undefined)) throw new Error("give an item, or both x and y");
        const [px, py] = it ? spot(screen, it) : [x!, y!];
        const what = it ? repr(it.text) : `at ${px},${py}`;
        await hand.cue("press", `click${it ? ` ${quote(it.text)}` : ""}`, [px, py], { count });
        if (borrow) {
          return seatAction(`clicking ${what}`, async () => {
            await macos.clickAt(onScreenNow(px, py), { count });
            return `clicked ${what}${times(count)}`;
          });
        }
        const ref = it && screen.axRefs.get(it.index);
        try {
          if (it && ref !== undefined && count === 1 && macos.axPress(ref)) {
            return acted(onWindows() && web() ? `clicked ${what} at its centre: check the next capture, since a click on a page can miss` : `pressed ${what} via accessibility`);
          }
          const pointer = await pointed();
          await macos.windowPointer(pointer, [onScreen(pointer, px, py)], { count });
        } catch (error) {
          throw unguarded(error, `clicking ${what}`);
        }
        return acted(`clicked ${what}${times(count)} with a pointer of your own`);
      },
    ),
    tool(
      "drag",
      "Press, drag, release, once per stroke, through every point of it in order, with a pointer addressed to this window alone: " +
        "the user's cursor does not move. This is how to draw on a canvas, drag a slider, or move something. A curve is a stroke " +
        "with many points; a closed shape repeats its first point last." +
        (onWindows() ? " An app that is not a web page ignores a posted drag, so there the user's mouse is borrowed for it, once they pause." : ""),
      Type.Object({
        strokes: Type.Array(Type.Array(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 }), { minItems: 2 }), {
          minItems: 1,
          description: "[[[x,y],[x,y],...], ...] in points of the latest capture",
        }),
        ...seatParam,
      }),
      async ({ strokes, seat: borrow = false }: { strokes: [number, number][][]; seat?: boolean }) => {
        const what = `${strokes.length} stroke${strokes.length === 1 ? "" : "s"}`;
        if (borrow || (onWindows() && !web())) {
          current(); // a capture to aim by
          return seatAction(`dragging ${what}`, async () => {
            const [left, top] = onScreenNow(0, 0);
            for (const stroke of strokes) {
              macos.checkAbort(); // a stop between strokes ends the drawing there
              await hand.cue("draw", "drawing", stroke[0]);
              await macos.drag(stroke.map(([x, y]) => onScreenNow(x, y)), ([x, y]) => hand.at([x - left, y - top]));
            }
            return `dragged ${what}`;
          });
        }
        const pointer = await pointed();
        const onMove = ([x, y]: Point) => hand.at([x - pointer.frame[0], y - pointer.frame[1]]);
        for (const [i, stroke] of strokes.entries()) {
          await hand.cue("draw", "drawing", stroke[0]);
          try {
            await macos.windowPointer(pointer, stroke.map(([x, y]) => onScreen(pointer, x, y)), { onMove });
          } catch (error) {
            throw unguarded(error, i === 0 ? `dragging ${what}` : `the rest of the drag, from stroke ${i + 1} of ${strokes.length}: the ones before it were drawn`);
          }
        }
        return acted(`dragged ${what} with a pointer of your own`);
      },
    ),
    tool(
      "type",
      "Put text in the window. With `item`, a field from the latest `screen`: its value is set through accessibility, replacing what it " +
        `held, and submit=true confirms it as Return would. Without \`item\`, the text is typed where the window's own cursor is. ${KEYS} ` +
        "Never type a password.",
      Type.Object({
        text: Type.String(),
        item: Type.Optional(Type.Integer({ description: "Index of the field to fill." })),
        submit: Type.Optional(Type.Boolean({ description: "Confirm the field, or press Return, afterwards." })),
        ...seatParam,
      }),
      async ({ item: index, text, submit = false, seat: borrow = false }) => {
        const { app, pid } = mine();
        const typed = repr(brief(text));
        const returned = submit ? " and pressed Return" : "";
        if (index === undefined) {
          if (text.includes("\t")) noTab("a tab in the text");
          const office = onWindows() && OFFICE.test(macos.appName(pid));
          const to = borrow ? windowTarget() : keyTarget();
          void hand.cue("write", `typing ${quote(text)}`);
          if (borrow || office) {
            return seatAction(`typing into ${app}`, async () => {
              await typeOnSeat(text, web());
              if (submit) await macos.press("return");
              return `typed ${typed} into ${app}${returned}`;
            });
          }
          try {
            await seat.typeIn(to, text);
          } catch (error) {
            throw LINE_BREAK.test((error as Error).message) ? lineBreak(text) : error;
          }
          if (submit) await seat.pressIn(to, "return");
          return acted(`typed ${typed} into ${app}${returned}`);
        }
        const { it, ref } = control(index);
        await hand.cue("write", `typing ${quote(text)}`, spot(current().screen, it));
        if (borrow) {
          const [px, py] = spot(current().screen, it);
          return seatAction(`typing into ${repr(it.text)}`, async () => {
            await macos.clickAt(onScreenNow(px, py));
            await macos.press("a", [MOD]); // the field's own text, replaced as a value would be
            await typeOnSeat(text, web());
            if (submit) await macos.press("return");
            return `typed ${typed} into ${repr(it.text)}${returned}`;
          });
        }
        let taken: boolean;
        try {
          taken = macos.axSetValue(ref, text);
        } catch (error) {
          throw LINE_BREAK.test((error as Error).message) ? lineBreak(text) : unguarded(error, `typing into ${repr(it.text)}`);
        }
        const holds = macos.axValue(ref);
        if (!taken || holds === null) throw new Error(`${repr(it.text)} would not take a value from behind: click it and type without an item${borrows ? ", or pass seat=true" : ""}`);
        // A field that took the text but reads back otherwise is said as it is, so the model looks rather than types it all again.
        if (!flat(holds).endsWith(flat(text))) return acted(`typed into ${repr(it.text)}, which now holds ${repr(brief(holds, VALUE_CHARS))} (${holds.length} characters; ${text.length} were typed): look before typing again`);
        const confirmed = submit ? macos.axPerform(ref, "AXConfirm") : false;
        return acted(`set ${repr(it.text)} to ${typed}${submit ? (confirmed ? " and confirmed it" : ", but the field has no confirm action: press the form's button") : ""}`);
      },
    ),
    tool(
      "key",
      `Press keys in the window: \`return\`, \`escape\`, \`tab\`, arrows, a shortcut, or several separated by spaces, pressed in order. ${KEYS}${SHELL_KEYS}`,
      Type.Object({ keys: Type.String({ description: KEY_EXAMPLES }), ...seatParam }),
      async ({ keys, seat: borrow = false }) => {
        const { app } = mine();
        const sequence = chords(keys);
        for (const { key, modifiers } of sequence) {
          const why = shellChord(key, modifiers);
          if (why) throw new Error(`${[...modifiers, key].join("+")} is never pressed: ${why}. Use the window's own controls instead (its buttons, its menu, \`browser\` close_tab).`);
          if (key.toLowerCase() === "tab" && !modifiers.map(modifierName).includes("ctrl")) noTab([...modifiers, key].join("+"));
        }
        const to = borrow ? windowTarget() : keyTarget();
        void hand.cue("key", `press ${keys}`, undefined, { count: sequence.length });
        // A posted key carries no modifier on Windows: a shortcut there is pressed with the user's keyboard.
        if (borrow || (!seat.chordsFromBehind && sequence.some((chord) => chord.modifiers.length))) {
          return seatAction(`pressing ${keys}`, async () => {
            for (const [i, { key, modifiers }] of sequence.entries()) {
              if (i > 0) macos.checkAbort(); // a stop between chords ends the sequence there
              await macos.press(key, modifiers);
            }
            return `pressed ${keys} in ${app}`;
          });
        }
        for (const { key, modifiers } of sequence) await seat.pressIn(to, key, modifiers);
        return acted(`pressed ${keys} in ${app}`);
      },
    ),
    tool(
      "scroll",
      "Scroll the window: a page in a direction (left and right where the view scrolls sideways), or bring a control from the " +
        "off-screen list into view by its number.",
      Type.Object({
        direction: Type.Optional(StringEnum(["up", "down", "left", "right"] as const)),
        control: Type.Optional(Type.Integer({ description: "Number from the latest `screen`'s off-screen list." })),
        ...seatParam,
      }),
      async ({ direction, control: chosen, seat: borrow = false }) => {
        const { screen } = current();
        const way: "up" | "down" | "left" | "right" = direction ?? "down";
        void hand.cue("scroll", chosen === undefined ? `scroll ${way}` : "scroll to a control", undefined, { swipe: SWIPES[way] });
        if (borrow) {
          // A wheel turned over the window's middle. Windows counts a sideways turn the other way round from the Mac.
          const sideways = onWindows() ? SCROLL_LINES : -SCROLL_LINES;
          const [vertical, horizontal] = { up: [SCROLL_LINES, 0], down: [-SCROLL_LINES, 0], left: [0, -sideways], right: [0, sideways] }[way] as Point;
          const [width, height] = sizePt(screen);
          return seatAction(`scrolling ${way}`, async () => {
            await macos.scroll(vertical, onScreenNow(width / 2, height / 2), horizontal);
            return `scrolled ${way}`;
          });
        }
        // A list or a text view pages itself. A web page has no such action, and is moved by bringing something on it into view.
        if (chosen === undefined && macos.scrollPage(screen.pid!, screen.windowId!, way)) return acted(`scrolled ${way} a page`);
        if (chosen === undefined && (way === "left" || way === "right")) {
          throw new Error(`nothing in this window scrolls ${way} from behind: ${borrows ? "pass seat=true to turn the user's wheel over it once they pause" : "bring a control on that side into view with `scroll` control=..."}`);
        }
        const [, top, , height] = screen.window!;
        const page = (node: { y: number; h: number }) => (way === "up" ? top - (node.y + node.h) : node.y - (top + height));
        // About a page away: the farthest control within one window height in that direction, or, across a long stretch of text, the nearest beyond it.
        const beyond = screen.offscreen.filter((node) => page(node) >= 0).sort((a, b) => page(a) - page(b));
        const node = chosen !== undefined ? screen.offscreen[chosen] : (beyond.filter((candidate) => page(candidate) <= height).at(-1) ?? beyond[0]);
        if (!node) throw new Error(chosen !== undefined ? `there is no off-screen control ${chosen}` : `nothing is listed off screen ${way}: this may be the end`);
        if (!macos.axPerform(node.ref, "AXScrollToVisible")) throw new Error(`${repr(node.label)} would not scroll into view`);
        return acted(`scrolled ${repr(node.label)} into view`);
      },
    ),
    tool(
      "press_offscreen",
      "Press a control from the latest `screen`'s off-screen list: one the app exposes but does not show, so there is no pixel to click. " +
        "When it seems to do nothing, `scroll` control=... brings it into view, to click there instead.",
      Type.Object({ control: Type.Integer() }),
      async ({ control: chosen }) => acted(pressOffscreen(String(chosen), current().screen)),
    ),
    tool(
      "browser",
      `Your own window in the user's running ${browser}, in their profile, kept behind theirs: \`open\` a url (in the window's current tab, ` +
        "or new_tab=true to keep the current page up as a tab), list the window's `tabs`, `switch_tab`, `close_tab`, go `back` or `forward`, " +
        "`reload`. The first `open` makes the window, and any `open` makes it the window you are working in. Except for `tabs`, it waits for " +
        "the page to load and returns the new `screen` listing.",
      Type.Object({
        action: StringEnum(["open", "tabs", "switch_tab", "close_tab", "back", "forward", "reload"] as const),
        url: Type.Optional(Type.String({ description: "https URL, for open. A page you wrote yourself opens by its file:// URL." })),
        new_tab: Type.Optional(Type.Boolean({ description: "For open. Default false." })),
        tab: Type.Optional(Type.Integer({ minimum: 1, description: "Tab number from `tabs`, counted from 1. Default the active tab." })),
      }),
      async ({ action, url, new_tab = false, tab }) => {
        void hand.cue("go", `${action.replace("_", " ")} ${(url ?? "").replace(/^https?:\/\//, "")}`.trim());
        tabsSeen = null;
        let pinned = target?.pinned ?? webWindow;
        let note = "";
        if (pinned && !alive(pinned)) {
          forgetWindow();
          pinned = null;
          note = " (your earlier window had been closed, so this is a new one)";
        }
        if (action === "open") {
          if (!url || !/^(https?|file):\/\//.test(url)) throw new Error("open needs a url starting with https:// (or file:// for a local page)");
          if (pinned) {
            if (!(await macos.openUrl(browser, url, { window: pinned.scripted, newTab: new_tab, background: true }))) {
              const showing = await macos.browserUrl(browser, pinned.scripted).catch(() => null);
              view = null;
              throw new Error(`${url} did not open: your window still shows ${showing ?? "no page"}. Open it again, or reach it through the page's own links.`);
            }
          } else {
            pinned = webWindow = await macos.openBackgroundWindow(browser, url);
            await macos.stageWindow(pinned.pid, pinned.windowId);
            note += desktopNote(); // a browser that should have worked on the hand's own desktop, but did not
          }
          target = { app: browser, pid: pinned.pid, pinned };
          return moved((screen) => `opened ${screen.url ?? url}${new_tab ? " in a new tab" : ""} in your own window${note}`);
        }
        if (!pinned) throw new Error(`${note ? "your browser window was closed" : "no page is open yet"}: \`browser\` open a url first`);
        // Back in the browser from another app: the capture of that app no longer says where input goes, so the next action looks first.
        if (target?.pinned?.windowId !== pinned.windowId) view = null;
        target = { app: browser, pid: pinned.pid, pinned };
        if (action === "tabs") {
          const tabs = (await macos.browserTabs(browser)).filter((t) => t.scripted === pinned.scripted);
          return say(tabs.map((t) => `tab ${t.tab}${t.active ? " (active)" : ""}: ${t.title} | ${t.url}`).join("\n") || "your window has no tabs");
        }
        if (action === "switch_tab" && tab === undefined) throw new Error("switch_tab needs a tab number from `tabs`, counted from 1");
        const done = await macos.tabCommand(browser, action, pinned.scripted, tab, true);
        if (done === null) throw new Error(`there is no such tab in your window${action === "close_tab" ? ", or it is too narrow to show its close button: switch_tab to it first" : ""}; list \`tabs\` to see them, counted from 1`);
        const verb = { switch_tab: "switched to", close_tab: "closed", back: "went back in", forward: "went forward in", reload: "reloaded" }[action as macos.TabCommand];
        return moved(`${verb} ${tab ? `tab ${tab}` : "the active tab"}: ${done}`);
      },
    ),
    tool(
      "wait",
      "Wait for a page to load or a window to settle, then look again: returns the new `screen` listing. With `until`, it stops as soon as " +
        "that text shows in the window, and `seconds` is the most it waits.",
      Type.Object({
        seconds: Type.Number({ minimum: 0, maximum: 30 }),
        until: Type.Optional(Type.String({ description: "Text to wait for: a result, a message, a button that appears when something is ready." })),
      }),
      async ({ seconds, until }: { seconds: number; until?: string }) => {
        void hand.cue("wait", until ? `waiting for ${quote(until)}` : `waiting ${seconds}s`);
        if (!until) {
          await macos.sleepWatching(seconds);
          return target ? moved(`waited ${seconds}s`) : say(`waited ${seconds}s`);
        }
        if (!target) throw new Error("there is nothing of yours to watch: open a window first");
        const wanted = until.toLowerCase();
        const shows = (screen: Screen, items: Item[]) => (screen.url ?? "").toLowerCase().includes(wanted) || items.some((it) => it.text.toLowerCase().includes(wanted));
        const started = performance.now();
        for (;;) {
          const [seen, screen] = await see(false);
          const waited = Math.round((performance.now() - started) / 1000);
          if (shows(screen, current().items)) return { ...seen, content: [{ type: "text", text: `${repr(until)} shows, after ${waited}s` }, ...seen.content] };
          if (waited >= seconds) return { ...seen, content: [{ type: "text", text: `waited ${waited}s, and ${repr(until)} has not shown` }, ...seen.content] };
          await macos.sleepWatching(Math.min(UNTIL_POLL_S, seconds - waited));
        }
      },
    ),
    {
      name: "finish",
      label: "finish",
      description:
        "End the task: say how it went, then give the user your short answer. done: it is done, and you saw it done. needs_you: the next " +
        "step is one only the user can take (a login, a payment, a CAPTCHA, a choice that is theirs): say exactly what they must do. " +
        "could_not: it cannot be done from here: say why. keep_open says whether you left pages or files open for the user to see" +
        (onWindows() ? ": your browser window stays for them when you are dismissed only if it is true." : "."),
      parameters: Type.Object({
        outcome: StringEnum(["done", "needs_you", "could_not"] as const),
        summary: Type.String({ description: "One sentence: what was done, what the user must do, or why it could not be done." }),
        keep_open: Type.Boolean({ description: "true when you left pages or files open for the user (results in tabs, a page to log in on); false when nothing you opened is for them." }),
      }),
      execute: async (_id, params): Promise<Result> => {
        const { outcome, summary, keep_open } = params as Finish;
        return { content: [{ type: "text", text: `recorded: ${outcome}. Now give the user your short answer.` }], details: { finish: { outcome, summary, keep_open: keep_open === true } } };
      },
    },
  ];
}

/** The screen as the model reads it: where things stand, then one line per item. */
export function describe(screen: Screen, items: Item[]): string {
  const [width, height] = sizePt(screen).map(Math.round);
  const local = ([x, y]: Point) => `${Math.round(x / screen.scale)},${Math.round(y / screen.scale)}`;
  const lines = screen.readOnly
    ? [
        `the user's own screen, only to read: ${screen.app} is in front | screenshot: ${width}x${height}${screen.url ? ` | ${config.browser()}'s active tab: ${screen.url}` : ""}`,
        "nothing here is yours to click or type into: `open_app` or `browser` open a window of your own to act in",
      ]
    : screen.windowId === undefined
      ? [`frontmost app: ${screen.app} | screenshot: ${width}x${height}${screen.url ? ` | ${config.browser()}'s active tab: ${screen.url}` : ""}`]
      : [`${screen.app}, the window you are working in | screenshot: ${width}x${height}${screen.url ? ` | url: ${screen.url}` : ""}`];
  if (screen.dialog) lines.push(`a dialog is open: ${repr(screen.dialog)}. It is what this capture shows, and the window behind it waits until it is answered or closed.`);
  if (screen.theirs) {
    // Why the window is theirs: a browser is never started again for the hand (`browser` gives it its own), an app on the
    // Mac is worked in as it is, and any other app was started again and opened no second window.
    const why = BROWSER_APP.test(screen.app)
      ? `\`browser\` open gives you a ${screen.app} window of your own`
      : onWindows()
        ? `${screen.app} opened no second window`
        : "make one of your own with the app's `menu` (File > New...) before you write anything";
    lines.push(`this ${screen.app} window is the user's own, not one of yours (${why}): act in it only as far as the task asks, and leave the rest of it as it is.`);
  }
  if (screen.tabs) lines.push(`tabs: ${screen.tabs.count} (active: ${screen.tabs.active})`);
  if (screen.image.stale) lines.push("the screenshot may be out of date: the window is covered, and its browser stops painting it there. This listing is read from the page itself and is current; trust it over the picture.");
  // Notepad opens the tabs of its earlier sessions in a new window too (measured), and those are nobody's work of this task.
  const tabs = items.filter((it) => it.role === "tab").length;
  if (/^notepad$/i.test(screen.app) && tabs > 1) lines.push(`this window has ${tabs} tabs: Notepad reopens the tabs of earlier sessions, so any but the one you made may be the user's.`);
  // Excel names every cell by its address alone, full or empty, so the grid's cells are left out of the list: hundreds of them said nothing.
  if (onWindows() && /^excel$/i.test(screen.app) && !screen.dialog) lines.push("Excel's grid cells are not listed: read them off the text below, and to go to a cell click where it lies, or set the 'Name Box' field to its address (submit=true) before typing.");
  if (screen.window && screen.windowId === undefined) {
    const [x, y, w, h] = screen.window.map(Math.round) as [number, number, number, number];
    lines.push(`window: x=${x - screen.origin[0]} y=${y - screen.origin[1]} w=${w} h=${h}`);
  }
  const f = screen.field;
  if (f) lines.push(`focused: ${f.role} ${repr(f.label || f.placeholder)} value=${repr(f.value.length > 200 ? `…${f.value.slice(-200)}` : f.value)}`);
  // A field's value is said where the platform gave one: the header promises no more than the lines below hold.
  lines.push(`items (index role 'text'${items.some((it) => it.value !== undefined) ? " = value" : ""} @x,y), ${items.length} in reading order:`);
  for (const it of items) {
    const label = it.text.length > ITEM_TEXT_CHARS ? `${it.text.slice(0, ITEM_TEXT_CHARS)}…` : it.text;
    const value = it.value === undefined ? "" : ` = ${repr(brief(it.value, VALUE_CHARS))}`;
    lines.push(`${it.index} ${it.role ? `${it.role} ` : ""}${repr(label)}${value} @${local(center(it))}`);
  }
  if (screen.offscreen.length) {
    lines.push("off-screen controls (press_offscreen):");
    screen.offscreen.forEach((node, i) => lines.push(`${i} ${roleWord(node)} ${repr(node.label)}`));
  }
  return lines.join("\n");
}
