/**
 * Computer use as agent tools: the clicker's own perception and actions handed to a language model
 * one at a time, plus the whole TypeSafe loop as a tool for the sub-goals a classifier can carry.
 *
 * Every coordinate a tool takes or reports is a pixel of the latest `screen` screenshot, which is
 * drawn at one pixel per screen point, so the model never sees a display origin or a Retina scale.
 */

import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import sharp from "sharp";
import { type TSchema, Type } from "typebox";
import { clickItem, pressOffscreen } from "./actions.ts";
import * as config from "./config.ts";
import * as macos from "./macos.ts";
import { Abort, center, type Item, type Point, repr, roleWord, type Screen, sizePt, toPoints } from "./models.ts";
import { capture, OcrCache, perceive } from "./perception.ts";
import { run } from "./runner.ts";
import type { Writer } from "./writer.ts";

const SETTLE_MS = 800; // what a capture waits after the last action, so it reads the result and not the transition
const PASTE_OVER_CHARS = 120; // longer text goes through the clipboard instead of keystrokes
const ITEM_TEXT_CHARS = 600;
// The clicker's 255 is TypeSafe's Choice ceiling. A model reading a listing has none, and a browser with
// a full tab strip spends 255 on its own controls before any of the page's text gets in.
const SCREEN_ITEMS = 600;
const CLICKER_STEPS = 25;
const PAGE_LOAD_MS = 10_000; // how long a navigation may keep a capture waiting

export interface ToolOptions {
  runDir: string;
  writer: Writer | null;
  /** Work in a browser window of the agent's own, behind the user's, and never take the mouse, the keyboard, or the focus. */
  background?: boolean;
  /** The user asked to stop: the mouse hit a corner, or Ctrl-C. */
  onAbort: (reason: string) => void;
}

/** `listing` marks a result that describes the screen, which goes stale and is cut from the transcript like any other. */
export type Details = { listing: true } | undefined;
type Result = AgentToolResult<Details>;
const say = (text: string): Result => ({ content: [{ type: "text", text }], details: undefined });

type MakeTool = <T extends TSchema>(name: string, description: string, parameters: T, execute: (params: any) => Promise<Result>) => AgentTool<any>;

/** A tool that drives the machine: one at a time, and never past an abort. */
const toolMaker =
  (onAbort: ToolOptions["onAbort"]): MakeTool =>
  (name, description, parameters, execute) => ({
    name,
    label: name,
    description,
    parameters,
    executionMode: "sequential",
    execute: async (_id, params) => {
      try {
        macos.checkAbort();
        return await execute(params);
      } catch (error) {
        if (error instanceof Abort) onAbort(error.message);
        throw error;
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

export const computerTools = (options: ToolOptions): AgentTool<any>[] => (options.background ? backgroundTools(options) : foregroundTools(options));

function foregroundTools({ runDir, writer, onAbort }: ToolOptions): AgentTool<any>[] {
  const browser = config.browser();
  const ocrCache = new OcrCache();
  const tool = toolMaker(onAbort);
  let view: { screen: Screen; items: Item[] } | null = null;
  let captures = 0;
  let clickerRuns = 0;
  let lastAction = 0;

  /** A capture afterwards waits for the action to land. */
  const acted = (text: string): Result => ((lastAction = performance.now()), say(text));

  const current = () => {
    if (!view) throw new Error("no current screen: call `screen` first");
    return view;
  };
  /**
   * The current screen, for input. The user shares this seat: if they brought another app forward since
   * the capture, a click or a keystroke would land in it, so input is refused until the model looks again.
   */
  const focused = async () => {
    const { screen } = current();
    const [app, pid] = await macos.frontmostAppAndPid();
    if (screen.pid !== null && pid !== screen.pid) {
      view = null;
      throw new Error(`the frontmost app changed from ${repr(screen.app)} to ${repr(app)} since the last \`screen\`; look again before acting`);
    }
    return current();
  };
  /**
   * An action that changes which app or page is in front. The last capture no longer describes the
   * screen and the model's next move is always to look, so the result is the new screen itself.
   */
  const moved = async (text: string, settle?: () => Promise<void>): Promise<Result> => {
    view = null;
    lastAction = performance.now();
    await settle?.();
    const seen = await look(false);
    return { ...seen, content: [{ type: "text", text }, ...seen.content] };
  };
  const pageLoaded = async () => {
    for (const end = performance.now() + PAGE_LOAD_MS; performance.now() < end && (await macos.browserLoading(browser)); ) await macos.sleepWatching(0.25);
  };
  /** A screenshot pixel as a global screen point. */
  const toGlobal = (x: number, y: number): Point => {
    const { screen } = current();
    return [screen.origin[0] + x, screen.origin[1] + y];
  };
  const itemAt = (index: number): Item => {
    const found = current().items.find((it) => it.index === index);
    if (!found) throw new Error(`no item ${index} on the current screen (${current().items.length} items); call \`screen\` again`);
    return found;
  };

  async function look(screenshot: boolean): Promise<Result> {
    const wait = SETTLE_MS - (performance.now() - lastAction);
    if (wait > 0) await Bun.sleep(wait);
    const out = join(runDir, `screen-${String(++captures).padStart(3, "0")}.png`);
    const screen = await capture({ out, browser });
    const items = await perceive(screen, SCREEN_ITEMS, "", undefined, ocrCache);
    view = { screen, items };
    const result: Result = { content: [{ type: "text", text: describe(screen, items) }], details: { listing: true } };
    return screenshot ? withScreenshot(result, screen) : result;
  }

  return [
    tool(
      "screen",
      "Look at the screen: captures the display holding the frontmost window and lists everything clickable on it, " +
        "read by OCR and from the app's accessibility tree, each with an index and its center x,y. Also reports the " +
        "frontmost app, the browser's URL, the focused field, and controls the app exposes off screen. Indexes are " +
        "only valid until the next `screen`. Pass screenshot=true to also see the picture, for anything the text " +
        "cannot tell you: a canvas, an image, a layout, or to check that a drawing came out right.",
      Type.Object({ screenshot: Type.Optional(Type.Boolean({ description: "Attach the screenshot itself. Default false." })) }),
      ({ screenshot }) => look(Boolean(screenshot)),
    ),
    tool(
      "click",
      "Click an item from the latest `screen` by index, or a point by x,y. An item the app declared is pressed through " +
        "accessibility, which lands even when something covers it; set mouse=true to click its pixel instead when a press had no effect.",
      Type.Object({
        item: Type.Optional(Type.Integer({ description: "Index from the latest `screen`." })),
        x: Type.Optional(Type.Number({ description: "Screenshot pixel, when there is no item to name." })),
        y: Type.Optional(Type.Number()),
        button: Type.Optional(StringEnum(["left", "right"] as const)),
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "2 for a double click." })),
        mouse: Type.Optional(Type.Boolean({ description: "Click the pixel even when the item could be pressed through accessibility." })),
      }),
      async ({ item: index, x, y, button = "left", count = 1, mouse = false }) => {
        await focused();
        const plain = button === "left" && count === 1;
        if (index !== undefined) {
          const it = itemAt(index);
          if (plain && !mouse) return acted(await clickItem(it, current().screen));
          await macos.clickAt(toPoints(current().screen, it), { button, count });
          return acted(`clicked ${repr(it.text)} (${button}${count > 1 ? ` x${count}` : ""})`);
        }
        if (x === undefined || y === undefined) throw new Error("give an item, or both x and y");
        await macos.clickAt(toGlobal(x, y), { button, count });
        return acted(`clicked at ${x},${y} (${button}${count > 1 ? ` x${count}` : ""})`);
      },
    ),
    tool(
      "type",
      "Type text into whatever has the keyboard focus, as keystrokes (long text is pasted). Click the field first. Never type a password.",
      Type.Object({
        text: Type.String(),
        enter: Type.Optional(Type.Boolean({ description: "Press Return afterwards." })),
      }),
      async ({ text, enter }) => {
        await focused();
        await (text.length > PASTE_OVER_CHARS ? macos.pasteText(text) : macos.typeText(text));
        if (enter) await macos.press("return");
        return acted(`typed ${repr(text.length > 80 ? `${text.slice(0, 80)}…` : text)}${enter ? " and pressed Return" : ""}`);
      },
    ),
    tool(
      "key",
      "Press keys: one chord such as `return`, `escape`, `tab`, `cmd+a`, `cmd+shift+t`, `pagedown`, or several separated by spaces, pressed in order.",
      Type.Object({ keys: Type.String({ description: "e.g. `cmd+n` or `cmd+a delete`" }) }),
      async ({ keys }) => {
        await focused();
        for (const chord of keys.trim().split(/\s+/)) {
          const parts = chord.length > 1 ? chord.split("+") : [chord];
          await macos.press(parts.pop()!, parts);
        }
        return acted(`pressed ${keys}`);
      },
    ),
    tool(
      "scroll",
      "Scroll the view under the frontmost window's center, or under x,y.",
      Type.Object({
        direction: StringEnum(["up", "down", "left", "right"] as const),
        amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Lines. Default 10." })),
        x: Type.Optional(Type.Number()),
        y: Type.Optional(Type.Number()),
      }),
      async ({ direction, amount = 10, x, y }) => {
        await focused();
        const at = x !== undefined && y !== undefined ? toGlobal(x, y) : undefined;
        const [vertical, horizontal] = { up: [amount, 0], down: [-amount, 0], left: [0, amount], right: [0, -amount] }[direction as "up"]!;
        await macos.scroll(vertical!, at, horizontal);
        return acted(`scrolled ${direction} ${amount}`);
      },
    ),
    tool(
      "drag",
      "Press, drag, release: once per stroke, through every point of it in order. This is how to draw on a canvas, " +
        "drag a slider, or move something. A curve is a stroke with many points; a closed shape repeats its first point last.",
      Type.Object({
        strokes: Type.Array(Type.Array(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 }), { minItems: 2 }), {
          minItems: 1,
          description: "[[[x,y],[x,y],...], ...] in screenshot pixels",
        }),
      }),
      async ({ strokes }: { strokes: [number, number][][] }) => {
        await focused();
        for (const stroke of strokes) await macos.drag(stroke.map(([x, y]) => toGlobal(x, y)));
        return acted(`dragged ${strokes.length} stroke${strokes.length === 1 ? "" : "s"}`);
      },
    ),
    tool(
      "press_offscreen",
      "Activate a control from the latest `screen`'s off-screen list: one the app exposes but does not show, so there is no pixel to click.",
      Type.Object({ control: Type.Integer() }),
      async ({ control }) => acted(pressOffscreen(String(control), current().screen)),
    ),
    tool(
      "open_app",
      "Open a macOS application, or bring it to the front if it is already running. Returns the new `screen` listing.",
      Type.Object({ name: Type.String({ description: "As in /Applications, e.g. Calculator, Notes, Finder" }) }),
      async ({ name }) => {
        const front = await macos.activate(name).catch(() => false);
        if (!front) await Bun.spawn(["open", "-a", name]).exited;
        const reached = front || (await macos.activate(name).catch(() => false));
        return moved(reached ? `${name} is frontmost` : `opened ${name}, but the frontmost app is ${repr(await macos.frontmostApp())}`);
      },
    ),
    tool(
      "browser",
      `Drive ${browser} as the user already has it running, in their own profile: \`open\` a url (a new tab, or new_tab=false for the ` +
        "current one), list `tabs`, `switch_tab` to one, open a `new_window`, `close_tab`, go `back` or `forward`, `reload`. This is " +
        "the only way to reach a website: never type a URL into the address bar. Except for `tabs`, it waits for the page to load " +
        "and returns the new `screen` listing.",
      Type.Object({
        action: StringEnum(["open", "tabs", "switch_tab", "new_window", "close_tab", "back", "forward", "reload"] as const),
        url: Type.Optional(Type.String({ description: "https URL, for open and new_window" })),
        new_tab: Type.Optional(Type.Boolean({ description: "For open. Default true." })),
        window: Type.Optional(Type.Integer({ description: "Window number from `tabs`. Default the front window." })),
        tab: Type.Optional(Type.Integer({ description: "Tab number from `tabs`. Default the active tab." })),
      }),
      async (params) => {
        const outcome = await chrome(browser, params);
        return params.action === "tabs" ? say(outcome) : moved(outcome, params.action === "close_tab" ? undefined : pageLoaded);
      },
    ),
    tool(
      "wait",
      "Wait for a page to load or an animation to finish.",
      Type.Object({ seconds: Type.Number({ minimum: 0, maximum: 30 }) }),
      async ({ seconds }) => (await macos.sleepWatching(seconds), say(`waited ${seconds}s`)),
    ),
    tool(
      "clicker",
      "Hand one small goal to a fast autonomous loop: each step it reads the screen and a classifier picks the next click, key, " +
        "scroll, or website, in about a second and for a fraction of a cent. It stops the moment its choice is not clear-cut, so " +
        "give it a single visible target (`open the Pricing page`, `choose 21 September in the date picker`, `dismiss the cookie " +
        "banner`), never a compound goal, a search, or a judgement: those split its vote and it stops without acting. It cannot " +
        "draw, drag, use key chords, or open an app. Returns what it did and what the screen shows; check the screen yourself after.",
      Type.Object({
        goal: Type.String({ description: "One plain-English goal, with every detail it needs: it sees nothing of this conversation." }),
        steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: `Most actions it may take. Default ${CLICKER_STEPS}.` })),
      }),
      async ({ goal, steps = CLICKER_STEPS }) => {
        view = null; // its captures release every element handle this one gave out
        const out = join(runDir, `clicker-${String(++clickerRuns).padStart(2, "0")}`);
        const state = await run({ goal, out, act: true, steps }, (typesafe, history) => ({
          goal,
          browser,
          email: config.email(),
          typesafe,
          writer,
          history,
        }));
        if (state.outcome.startsWith("aborted")) throw new Abort(state.outcome);
        const report = { outcome: state.outcome, goal_achieved: state.answer?.achieved ?? null, answer: state.answer?.text ?? null, actions: state.history };
        return acted(JSON.stringify(report, null, 1));
      },
    ),
  ];
}

/**
 * The same job from behind the user's windows, in any app. Everything here names its target instead of
 * going through the seat: the window server captures one window by id, accessibility reads and presses
 * that window's controls and the app's menu commands, keys are posted to the app's process rather than
 * to whatever has the focus, pointer events are addressed to one window rather than sent down the HID
 * stream, and apps are started without being brought forward. None of it moves the mouse or changes
 * what is in front.
 */
function backgroundTools({ runDir, onAbort }: ToolOptions): AgentTool<any>[] {
  const browser = config.browser();
  const ocrCache = new OcrCache();
  const tool = toolMaker(onAbort);
  // The app being worked, and for the browser the one window in it that is the agent's own. Any other
  // app is followed by whichever window it considers current, since a command often opens a new one.
  let target: { app: string; pid: number; pinned?: macos.PinnedWindow } | null = null;
  let webWindow: macos.PinnedWindow | null = null; // kept across a spell in another app, so the pages stay where they were
  let view: { screen: Screen; items: Item[] } | null = null;
  let captures = 0;
  let lastAction = 0;

  const acted = (text: string): Result => ((lastAction = performance.now()), say(text));
  const current = () => {
    if (!view) throw new Error("no current screen: call `screen` first");
    return view;
  };
  const mine = () => {
    if (!target) throw new Error("nothing is open yet: `open_app` an app, or `browser` open a url");
    return target;
  };
  /** Keys reach a process, not a window: in the browser they would land in whichever window the user is in. */
  const keyboard = () => {
    const { app, pid, pinned } = mine();
    if (pinned) throw new Error(`keys go to a process, and in ${app} that means whichever window the user is using. Press the page's own controls instead.`);
    return pid;
  };
  /**
   * The window being worked, as a pointer needs it: where it is now, not where the last capture found it,
   * since showing a sliver of it may have moved it. A page is only handed input while its browser thinks
   * it can be seen, so a browser's window is first slid until some of it shows.
   */
  const pointed = async (): Promise<macos.PointerTarget> => {
    const { app, pid, pinned } = mine();
    const windowId = current().screen.windowId!;
    const web = pinned !== undefined || macos.isWebContentApp(pid);
    const place = () => macos.appWindows(pid).find((w) => w.id === windowId)?.frame;
    const before = place();
    if (web && !(await macos.revealWindow(pid, windowId))) {
      throw new Error(`${app} only takes pointer input in a window that shows somewhere, and every screen is covered edge to edge. Ask the user to leave a gap at a screen edge, or to run this without --background.`);
    }
    const frame = place();
    if (!frame) throw new Error("the window is gone; look again");
    if (before && (before[0] !== frame[0] || before[1] !== frame[1])) await Bun.sleep(1200); // the browser takes a moment to notice it can be seen
    return { pid, windowId, frame, web };
  };
  /** A point of the latest capture, which is window-local, as a global screen point. */
  const onScreen = (target: macos.PointerTarget, x: number, y: number): Point => [target.frame[0] + x, target.frame[1] + y];

  /** The accessibility element behind an item, which is the only way to reach it from here. */
  const control = (index: number) => {
    const { screen, items } = current();
    const it = items.find((candidate) => candidate.index === index);
    if (!it) throw new Error(`no item ${index} on the current screen (${items.length} items); call \`screen\` again`);
    const ref = screen.axRefs.get(index);
    if (ref === undefined) throw new Error(`item ${index} ${repr(it.text)} is text read off the picture, with no control behind it. Pick the control with a role (link, button, field...) instead.`);
    return { it, ref };
  };

  async function look(screenshot: boolean): Promise<Result> {
    const { app, pid, pinned } = mine();
    const wait = SETTLE_MS - (performance.now() - lastAction);
    if (wait > 0) await Bun.sleep(wait);
    const windowId = pinned?.windowId ?? macos.mainWindowId(pid);
    if (windowId === null) throw new Error(`${app} has no window open. Its \`menu\` can make one (File > New...).`);
    const out = join(runDir, `screen-${String(++captures).padStart(3, "0")}.png`);
    const url = pinned ? ((await macos.browserUrl(browser, pinned.scripted)) ?? undefined) : undefined;
    const screen = await capture({ target: { pid, windowId }, out, url });
    const items = await perceive(screen, SCREEN_ITEMS, "", undefined, ocrCache);
    view = { screen, items };
    const result: Result = { content: [{ type: "text", text: describe(screen, items) }], details: { listing: true } };
    return screenshot ? withScreenshot(result, screen) : result;
  }
  const moved = async (text: string): Promise<Result> => {
    view = null;
    lastAction = performance.now();
    const scripted = mine().pinned?.scripted;
    for (const end = performance.now() + PAGE_LOAD_MS; scripted && performance.now() < end && (await macos.browserLoading(browser, scripted)); ) await macos.sleepWatching(0.25);
    const seen = await look(false);
    return { ...seen, content: [{ type: "text", text }, ...seen.content] };
  };

  return [
    tool(
      "screen",
      "Look at the window you are working in: captures it where it lies, behind the user's windows, and lists everything in it, " +
        "read by OCR and from the accessibility tree, each with an index and its x,y in the capture. Also lists the controls " +
        "scrolled out of view. Indexes are only valid until the next `screen`. Pass screenshot=true to also see the picture.",
      Type.Object({ screenshot: Type.Optional(Type.Boolean({ description: "Attach the screenshot itself. Default false." })) }),
      ({ screenshot }) => look(Boolean(screenshot)),
    ),
    tool(
      "open_app",
      "Start a macOS application without bringing it forward, or take up one that is already running, and work in its current " +
        "window from here on. Returns the `screen` listing.",
      Type.Object({ name: Type.String({ description: "As in /Applications, e.g. Calculator, Notes, TextEdit" }) }),
      async ({ name }) => {
        const pid = await macos.runInBackground(name);
        if (pid === null) throw new Error(`${name} did not start`);
        target = { app: name, pid };
        return moved(`${name} is running in the background`);
      },
    ),
    tool(
      "menu",
      "A command from the app's menu bar, by its path: [\"File\", \"New Note\"]. The item is pressed in place, so no menu opens on " +
        "screen. A path that stops at a menu lists what is in it, and an empty path lists the menu bar: look before you guess a name.",
      Type.Object({ path: Type.Array(Type.String(), { description: "e.g. [\"Edit\", \"Select All\"], or [\"View\"] to see what View holds" }) }),
      async ({ path }: { path: string[] }) => {
        const result = macos.menu(mine().pid, path);
        return "items" in result ? say(`${path.join(" > ") || "menu bar"}: ${result.items.join(", ")}`) : moved(`chose ${result.pressed}`);
      },
    ),
    tool(
      "click",
      "Click in the window you are working in. An item with a role (link, button, tab, checkbox, popup, cell...) is pressed through " +
        "accessibility, which is the sure way. Anything else, plain text, a canvas, a bare x,y, gets a pointer click addressed to " +
        "this window alone: the user's cursor does not move. Prefer an item with a role whenever one carries what you want.",
      Type.Object({
        item: Type.Optional(Type.Integer({ description: "Index from the latest `screen`." })),
        x: Type.Optional(Type.Number({ description: "Pixel of the latest capture, when there is no item to name." })),
        y: Type.Optional(Type.Number()),
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "2 for a double click." })),
      }),
      async ({ item: index, x, y, count = 1 }) => {
        const { screen, items } = current();
        const it = index === undefined ? undefined : items.find((candidate) => candidate.index === index);
        if (index !== undefined && !it) throw new Error(`no item ${index} on the current screen (${items.length} items); call \`screen\` again`);
        const ref = it && screen.axRefs.get(it.index);
        if (it && ref !== undefined && count === 1 && macos.axPress(ref)) return acted(`pressed ${repr(it.text)} via accessibility`);
        if (!it && (x === undefined || y === undefined)) throw new Error("give an item, or both x and y");
        const [px, py] = it ? center(it).map((v) => v / screen.scale) : [x!, y!];
        const target = await pointed();
        await macos.windowPointer(target, [onScreen(target, px!, py!)], { count });
        return acted(`clicked ${it ? repr(it.text) : `at ${px},${py}`}${count > 1 ? ` x${count}` : ""} with a pointer of your own`);
      },
    ),
    tool(
      "drag",
      "Press, drag, release, once per stroke, through every point of it in order, with a pointer addressed to this window alone: " +
        "the user's cursor does not move. This is how to draw on a canvas, drag a slider, or move something. A curve is a stroke " +
        "with many points; a closed shape repeats its first point last.",
      Type.Object({
        strokes: Type.Array(Type.Array(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 }), { minItems: 2 }), {
          minItems: 1,
          description: "[[[x,y],[x,y],...], ...] in pixels of the latest capture",
        }),
      }),
      async ({ strokes }: { strokes: [number, number][][] }) => {
        const target = await pointed();
        for (const stroke of strokes) await macos.windowPointer(target, stroke.map(([x, y]) => onScreen(target, x, y)));
        return acted(`dragged ${strokes.length} stroke${strokes.length === 1 ? "" : "s"} with a pointer of your own`);
      },
    ),
    tool(
      "type",
      "Put text in the app. With `item`, a field from the latest `screen`: its value is set through accessibility, replacing what it " +
        "held, and submit=true confirms it as Return would. Without `item`, the text is typed as keys sent to the app's process, to " +
        "wherever its own cursor is (not available in the browser). Never type a password.",
      Type.Object({
        text: Type.String(),
        item: Type.Optional(Type.Integer({ description: "Index of the field to fill." })),
        submit: Type.Optional(Type.Boolean({ description: "Confirm the field, or press Return, afterwards." })),
      }),
      async ({ item: index, text, submit }) => {
        if (index === undefined) {
          const pid = keyboard();
          await macos.typeText(text, pid);
          if (submit) await macos.press("return", [], pid);
          return acted(`typed ${repr(text.length > 80 ? `${text.slice(0, 80)}…` : text)} into ${mine().app}${submit ? " and pressed Return" : ""}`);
        }
        const { it, ref } = control(index);
        if (!macos.axSetValue(ref, text) || !macos.axValue(ref)?.endsWith(text)) throw new Error(`${repr(it.text)} would not take a value through accessibility`);
        const confirmed = submit ? macos.axPerform(ref, "AXConfirm") : false;
        return acted(`set ${repr(it.text)} to ${repr(text)}${submit ? (confirmed ? " and confirmed it" : ", but the field has no confirm action: press the form's button") : ""}`);
      },
    ),
    tool(
      "key",
      "Press keys in the app, sent to its process rather than to whatever has the focus: `return`, `escape`, `tab`, arrows, or several " +
        "separated by spaces. A menu's shortcut (`cmd+n`, `cmd+s`) often does not fire in an app that is not in front: choose the command " +
        "with `menu` instead. Not available in the browser.",
      Type.Object({ keys: Type.String({ description: "e.g. `cmd+n` or `cmd+a delete`" }) }),
      async ({ keys }) => {
        const pid = keyboard();
        for (const chord of keys.trim().split(/\s+/)) {
          const parts = chord.length > 1 ? chord.split("+") : [chord];
          await macos.press(parts.pop()!, parts, pid);
        }
        return acted(`pressed ${keys} in ${mine().app}`);
      },
    ),
    tool(
      "scroll",
      "Scroll the window: a page in a direction, or to bring a control from the off-screen list into view by its number.",
      Type.Object({
        direction: Type.Optional(StringEnum(["up", "down"] as const)),
        control: Type.Optional(Type.Integer({ description: "Number from the latest `screen`'s off-screen list." })),
      }),
      async ({ direction, control: chosen }) => {
        const { screen } = current();
        // A list or a text view pages itself. A web page has no such action, and is moved by bringing something on it into view.
        if (chosen === undefined && direction && macos.scrollPage(screen.pid!, screen.windowId!, direction)) return acted(`scrolled ${direction} a page`);
        const [, top, , height] = screen.window!;
        const page = (node: { y: number; h: number }) => (direction === "up" ? top - (node.y + node.h) : node.y - (top + height));
        // About a page away: the farthest control within one window height in that direction, or, across a long stretch of text, the nearest beyond it.
        const beyond = screen.offscreen.filter((node) => page(node) >= 0).sort((a, b) => page(a) - page(b));
        const node = chosen !== undefined ? screen.offscreen[chosen] : (beyond.filter((candidate) => page(candidate) <= height).at(-1) ?? beyond[0]);
        if (!node) throw new Error(chosen !== undefined ? `there is no off-screen control ${chosen}` : `nothing is listed off screen ${direction ?? "there"}: this may be the end`);
        if (!macos.axPerform(node.ref, "AXScrollToVisible")) throw new Error(`${repr(node.label)} would not scroll into view`);
        return acted(`scrolled ${repr(node.label)} into view`);
      },
    ),
    tool(
      "press_offscreen",
      "Activate a control from the latest `screen`'s off-screen list without scrolling to it.",
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
        url: Type.Optional(Type.String({ description: "https URL, for open" })),
        new_tab: Type.Optional(Type.Boolean({ description: "For open. Default false." })),
        tab: Type.Optional(Type.Integer({ description: "Tab number from `tabs`. Default the active tab." })),
      }),
      async ({ action, url, new_tab = false, tab }) => {
        let pinned = target?.pinned ?? webWindow;
        if (action === "open") {
          if (!url || !/^https?:\/\//.test(url)) throw new Error("open needs a url starting with https://");
          if (pinned) await macos.openUrl(browser, url, { window: pinned.scripted, newTab: new_tab, background: true });
          else pinned = webWindow = await macos.openBackgroundWindow(browser, url);
          target = { app: browser, pid: pinned.pid, pinned };
          return moved(`opened ${url}${new_tab ? " in a new tab" : ""} in your background window`);
        }
        if (!pinned) throw new Error("no page is open yet: `browser` open a url first");
        target = { app: browser, pid: pinned.pid, pinned };
        if (action === "tabs") {
          const tabs = (await macos.browserTabs(browser)).filter((t) => t.scripted === pinned.scripted);
          return say(tabs.map((t) => `tab ${t.tab}${t.active ? " (active)" : ""}: ${t.title} | ${t.url}`).join("\n") || "your window has no tabs");
        }
        if (action === "switch_tab" && !tab) throw new Error("switch_tab needs a tab number from `tabs`");
        const done = await macos.tabCommand(browser, action, pinned.scripted, tab, true);
        if (done === null) throw new Error("there is no such tab in your window; list `tabs` first");
        const verb = { switch_tab: "switched to", close_tab: "closed", back: "went back in", forward: "went forward in", reload: "reloaded" }[action as macos.TabCommand];
        return moved(`${verb} ${tab ? `tab ${tab}` : "the active tab"}: ${done}`);
      },
    ),
    tool(
      "wait",
      "Wait for a page to load or a window to settle.",
      Type.Object({ seconds: Type.Number({ minimum: 0, maximum: 30 }) }),
      async ({ seconds }) => (await macos.sleepWatching(seconds), say(`waited ${seconds}s`)),
    ),
  ];
}

/** The screen as the model reads it: where things stand, then one line per item. */
export function describe(screen: Screen, items: Item[]): string {
  const [width, height] = sizePt(screen).map(Math.round);
  const local = ([x, y]: Point) => `${Math.round(x / screen.scale)},${Math.round(y / screen.scale)}`;
  const lines =
    screen.windowId === undefined
      ? [`frontmost app: ${screen.app} | screenshot: ${width}x${height}${screen.url ? ` | ${config.browser()}'s active tab: ${screen.url}` : ""}`]
      : [`${screen.app}, the window you are working in, in the background | screenshot: ${width}x${height}${screen.url ? ` | url: ${screen.url}` : ""}`];
  if (screen.window && screen.windowId === undefined) {
    const [x, y, w, h] = screen.window.map(Math.round) as [number, number, number, number];
    lines.push(`window: x=${x - screen.origin[0]} y=${y - screen.origin[1]} w=${w} h=${h}`);
  }
  const f = screen.field;
  if (f) lines.push(`focused: ${f.role} ${repr(f.label || f.placeholder)} value=${repr(f.value.length > 200 ? `…${f.value.slice(-200)}` : f.value)}`);
  lines.push(`items (index role 'text' @x,y), ${items.length} in reading order:`);
  for (const it of items) {
    const label = it.text.length > ITEM_TEXT_CHARS ? `${it.text.slice(0, ITEM_TEXT_CHARS)}…` : it.text;
    lines.push(`${it.index} ${it.role ? `${it.role} ` : ""}${repr(label)} @${local(center(it))}`);
  }
  if (screen.offscreen.length) {
    lines.push("off-screen controls (press_offscreen):");
    screen.offscreen.forEach((node, i) => lines.push(`${i} ${roleWord(node)} ${repr(node.label)}`));
  }
  return lines.join("\n");
}

interface ChromeParams {
  action: "open" | "tabs" | "switch_tab" | "new_window" | "close_tab" | "back" | "forward" | "reload";
  url?: string;
  new_tab?: boolean;
  window?: number;
  tab?: number;
}

/** The user's own running browser, in their own profile: never automation's instance, never a fresh one. */
export async function chrome(browser: string, { action, url, new_tab = true, window, tab }: ChromeParams): Promise<string> {
  if ((action === "open" || action === "new_window") && url !== undefined && !/^https?:\/\//.test(url)) throw new Error("url must start with https://");
  const where = `${tab ? `tab ${tab}` : "the active tab"} of ${window ? `window ${window}` : "the front window"}`;
  switch (action) {
    case "tabs": {
      const tabs = await macos.browserTabs(browser);
      return tabs.map((t) => `window ${t.window} tab ${t.tab}${t.active ? " (active)" : ""}: ${t.title} | ${t.url}`).join("\n") || `${browser} has no windows open`;
    }
    case "open":
    case "new_window": {
      if (!url && action === "open") throw new Error("open needs a url");
      const front = await macos.openUrl(browser, url ?? "chrome://newtab/", { newWindow: action === "new_window", newTab: new_tab, window, tab });
      const what = action === "new_window" ? `opened a new window${url ? ` at ${url}` : ""}` : `opened ${url}${new_tab ? " in a new tab" : ` in ${where}`}`;
      return front ? what : `${what}, but ${browser} did not come to the front`;
    }
    default: {
      if (action === "switch_tab" && !tab) throw new Error("switch_tab needs a tab number from `tabs`");
      const acted = await macos.tabCommand(browser, action, window, tab);
      if (acted === null) throw new Error(`${browser} has no ${where}; list \`tabs\` first`);
      const verb = { switch_tab: "switched to", close_tab: "closed", back: "went back in", forward: "went forward in", reload: "reloaded" }[action];
      return `${verb} ${where}: ${acted}`;
    }
  }
}
