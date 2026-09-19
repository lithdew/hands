/**
 * macOS adapter: synthetic input, app control, screen capture, Vision OCR, and the accessibility tree.
 *
 * This is the only module that touches Quartz, ApplicationServices, Vision, or AppleScript, all of it
 * through bun:ffi (hand.ts draws the agent's hand with the runtime bound here, and nothing else). A Linux
 * adapter would provide the same functions over xdotool and AT-SPI.
 *
 * bun:ffi cannot return a struct, so nothing here calls a function that returns CGPoint or CGRect:
 * Cocoa hands those over as NSValue through key-value coding, and AX and CG write them to a pointer.
 * Passing one by value is fine: arm64 and x86-64 both spread a struct of doubles over the float
 * registers exactly as separate double arguments.
 */

import { CFunction, dlopen, type FFITypeOrString, read } from "bun:ffi";
import { existsSync } from "node:fs";
import { ABORT_CORNER_PX } from "./config.ts";
import { Abort, type AxNode, type Box, type Capture, type Field, type Frame, type Point } from "./models.ts";

export const MIN_WINDOW_SIDE_PT = 50.0; // anything smaller is a palette or a shadow, not the window being worked in
const EVENT_DELAY_MS = 40;
const TYPING_DELAY_MS = 12;
const DRAG_STEP_PT = 6; // distance between the mouse-dragged events along a stroke
const DRAG_DELAY_MS = 8;

// ANSI virtual keycodes. Chords go by keycode, so they follow the US layout; typed text does not.
export const KEYCODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
  "]": 30, o: 31, u: 32, "[": 33, i: 34, p: 35, return: 36, enter: 36, l: 37, j: 38, "'": 39, k: 40, ";": 41,
  "\\": 42, ",": 43, "/": 44, n: 45, m: 46, ".": 47, tab: 48, space: 49, "`": 50, delete: 51, backspace: 51,
  escape: 53, esc: 53, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111, home: 115, pageup: 116, forwarddelete: 117, end: 119, pagedown: 121, left: 123,
  right: 124, down: 125, up: 126,
}; // prettier-ignore
export const MODIFIERS: Record<string, number> = {
  cmd: 0x100000, command: 0x100000, shift: 0x20000, ctrl: 0x40000, control: 0x40000, alt: 0x80000, option: 0x80000, opt: 0x80000,
}; // prettier-ignore

// ------------------------------------------------------------------ native bindings

type Native = (...args: any[]) => any;
// A CF or Objective-C object pointer. Short strings and small numbers are tagged pointers, whose high
// bit bun:ffi can only carry as a bigint, so a pointer is never narrowed with Number(): that rounds it
// to a double, and the next call dereferences whatever address the rounding made.
type Ref = number | bigint;

const UTF8 = 0x08000100;
const AX_POINT = 1;
const AX_SIZE = 2;
const FRAMEWORKS = "/System/Library/Frameworks";
const IMAGES = [
  "/usr/lib/libobjc.A.dylib",
  `${FRAMEWORKS}/CoreFoundation.framework/CoreFoundation`,
  `${FRAMEWORKS}/ApplicationServices.framework/ApplicationServices`,
  `${FRAMEWORKS}/CoreGraphics.framework/CoreGraphics`,
  `${FRAMEWORKS}/ImageIO.framework/ImageIO`,
  `${FRAMEWORKS}/AppKit.framework/AppKit`,
  `${FRAMEWORKS}/Vision.framework/Vision`,
  `${FRAMEWORKS}/ScriptingBridge.framework/ScriptingBridge`,
];

function bind() {
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    dlopen: { args: ["cstring", "i32"], returns: "ptr" },
    dlsym: { args: ["ptr", "cstring"], returns: "ptr" },
  }).symbols;
  const handles = IMAGES.map((path) => {
    const handle = libc.dlopen(path, 1);
    if (!handle) throw new Error(`cannot load ${path}`);
    return handle;
  });
  const sym = (name: string): Ref => {
    for (const handle of handles) {
      const address = libc.dlsym(handle, name);
      if (address) return address as unknown as Ref;
    }
    throw new Error(`symbol not found: ${name}`);
  };
  const fn = (name: string, args: FFITypeOrString[], returns: FFITypeOrString): Native =>
    CFunction({ ptr: sym(name) as never, args, returns }) as unknown as Native;
  // objc_msgSend has to be called through the exact signature of the method behind it.
  const send = (returns: FFITypeOrString, ...args: FFITypeOrString[]) => fn("objc_msgSend", ["ptr", "ptr", ...args], returns);

  return {
    sym,
    fn,
    send,
    kCFBooleanTrue: read.ptr(sym("kCFBooleanTrue") as never, 0) as unknown as Ref,
    getClass: fn("objc_getClass", ["cstring"], "ptr"),
    selector: fn("sel_registerName", ["cstring"], "ptr"),
    id: send("ptr"),
    idId: send("ptr", "ptr"),
    idIdId: send("ptr", "ptr", "ptr"),
    idIndex: send("ptr", "u64"),
    idPid: send("ptr", "i32"),
    count: send("u64"),
    bool: send("bool"),
    integer: send("i64"),
    float: send("f32"),
    voidInt: send("void", "i64"),
    voidPtr: send("void", "ptr"),
    void: send("void"),
    boolIdPtr: send("bool", "ptr", "ptr"),

    CFRelease: fn("CFRelease", ["ptr"], "void"),
    CFRetain: fn("CFRetain", ["ptr"], "ptr"),
    CFGetTypeID: fn("CFGetTypeID", ["ptr"], "u64"),
    CFHash: fn("CFHash", ["ptr"], "u64"),
    CFEqual: fn("CFEqual", ["ptr", "ptr"], "bool"),
    CFStringTypeID: Number(fn("CFStringGetTypeID", [], "u64")()),
    CFStringCreate: fn("CFStringCreateWithCString", ["ptr", "cstring", "u32"], "ptr"),
    CFStringGetLength: fn("CFStringGetLength", ["ptr"], "i64"),
    CFStringGetCString: fn("CFStringGetCString", ["ptr", "ptr", "i64", "u32"], "bool"),
    CFArrayCreate: fn("CFArrayCreate", ["ptr", "ptr", "i64", "ptr"], "ptr"),
    CFArrayGetCount: fn("CFArrayGetCount", ["ptr"], "i64"),
    CFArrayGetValueAtIndex: fn("CFArrayGetValueAtIndex", ["ptr", "i64"], "ptr"),
    CFDictionaryGetValue: fn("CFDictionaryGetValue", ["ptr", "ptr"], "ptr"),
    CFNumberGetValue: fn("CFNumberGetValue", ["ptr", "i64", "ptr"], "bool"),
    CFBooleanGetValue: fn("CFBooleanGetValue", ["ptr"], "bool"),
    CFURLCreateWithFileSystemPath: fn("CFURLCreateWithFileSystemPath", ["ptr", "ptr", "i64", "bool"], "ptr"),

    AXIsProcessTrusted: fn("AXIsProcessTrusted", [], "bool"),
    AXValueTypeID: Number(fn("AXValueGetTypeID", [], "u64")()),
    AXValueGetType: fn("AXValueGetType", ["ptr"], "u32"),
    AXValueGetValue: fn("AXValueGetValue", ["ptr", "u32", "ptr"], "bool"),
    AXCreateSystemWide: fn("AXUIElementCreateSystemWide", [], "ptr"),
    AXCreateApplication: fn("AXUIElementCreateApplication", ["i32"], "ptr"),
    AXGetPid: fn("AXUIElementGetPid", ["ptr", "ptr"], "i32"),
    AXCopyAttribute: fn("AXUIElementCopyAttributeValue", ["ptr", "ptr", "ptr"], "i32"),
    AXCopyAttributes: fn("AXUIElementCopyMultipleAttributeValues", ["ptr", "ptr", "u32", "ptr"], "i32"),
    AXCopyActionNames: fn("AXUIElementCopyActionNames", ["ptr", "ptr"], "i32"),
    AXPerformAction: fn("AXUIElementPerformAction", ["ptr", "ptr"], "i32"),
    AXSetAttribute: fn("AXUIElementSetAttributeValue", ["ptr", "ptr", "ptr"], "i32"),
    AXSetMessagingTimeout: fn("AXUIElementSetMessagingTimeout", ["ptr", "f32"], "i32"),
    // Private, and how every window manager pairs an accessibility window with the window server's id for it.
    AXGetWindow: fn("_AXUIElementGetWindow", ["ptr", "ptr"], "i32"),

    CGWindowListCopyWindowInfo: fn("CGWindowListCopyWindowInfo", ["u32", "u32"], "ptr"),
    CGRectFromDictionary: fn("CGRectMakeWithDictionaryRepresentation", ["ptr", "ptr"], "bool"),
    CGEventCreateMouse: fn("CGEventCreateMouseEvent", ["ptr", "u32", "f64", "f64", "u32"], "ptr"),
    CGEventSourceCreate: fn("CGEventSourceCreate", ["i32"], "ptr"),
    AXValueCreate: fn("AXValueCreate", ["u32", "ptr"], "ptr"),
    CGEventCreateKeyboard: fn("CGEventCreateKeyboardEvent", ["ptr", "u16", "bool"], "ptr"),
    // The variadic CGEventCreateScrollWheelEvent takes its wheels on the stack on arm64; this one does not.
    CGEventCreateScroll: fn("CGEventCreateScrollWheelEvent2", ["ptr", "u32", "u32", "i32", "i32", "i32"], "ptr"),
    CGEventSetFlags: fn("CGEventSetFlags", ["ptr", "u64"], "void"),
    CGEventSetInteger: fn("CGEventSetIntegerValueField", ["ptr", "u32", "i64"], "void"),
    CGEventSetUnicode: fn("CGEventKeyboardSetUnicodeString", ["ptr", "u64", "ptr"], "void"),
    CGEventPost: fn("CGEventPost", ["u32", "ptr"], "void"),
    CGEventPostToPid: fn("CGEventPostToPid", ["i32", "ptr"], "void"),
    CGImageSourceCreateWithURL: fn("CGImageSourceCreateWithURL", ["ptr", "ptr"], "ptr"),
    CGImageSourceCreateImage: fn("CGImageSourceCreateImageAtIndex", ["ptr", "u64", "ptr"], "ptr"),
    CGImageCrop: fn("CGImageCreateWithImageInRect", ["ptr", "f64", "f64", "f64", "f64"], "ptr"),
    CGImageGetWidth: fn("CGImageGetWidth", ["ptr"], "u64"),
    CGImageGetHeight: fn("CGImageGetHeight", ["ptr"], "u64"),
  };
}

/**
 * The window server's private half. Public API can post an event to a process; saying which of its
 * windows the event is for, and telling a window it has the focus without the window server reordering
 * anything, are SkyLight's. Every symbol is looked up, never linked, and a system without them simply
 * has no pointer of its own: `null`.
 */
function bindSkyLight() {
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    dlopen: { args: ["cstring", "i32"], returns: "ptr" },
    dlsym: { args: ["ptr", "cstring"], returns: "ptr" },
  }).symbols;
  const handles = [`${FRAMEWORKS}/CoreGraphics.framework/CoreGraphics`, "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"].map((path) => libc.dlopen(path, 1));
  const fn = (name: string, args: FFITypeOrString[], returns: FFITypeOrString): Native | null => {
    const address = handles.map((handle) => handle && libc.dlsym(handle, name)).find(Boolean);
    return address ? (CFunction({ ptr: address as never, args, returns }) as unknown as Native) : null;
  };
  const symbols = {
    setWindowLocation: fn("CGEventSetWindowLocation", ["ptr", "f64", "f64"], "void"),
    postToPid: fn("SLEventPostToPid", ["i32", "ptr"], "void"),
    mainConnection: fn("CGSMainConnectionID", [], "u32"),
    windowOwner: fn("SLSGetWindowOwner", ["u32", "u32", "ptr"], "i32"),
    connectionPSN: fn("SLSGetConnectionPSN", ["u32", "ptr"], "i32"),
    postRecord: fn("SLPSPostEventRecordTo", ["ptr", "ptr"], "i32"),
  };
  return Object.values(symbols).every(Boolean) ? (symbols as Record<keyof typeof symbols, Native>) : null;
}

let skyLight: ReturnType<typeof bindSkyLight> | undefined;
const sky = () => (skyLight === undefined ? (skyLight = bindSkyLight()) : skyLight);

let bound: ReturnType<typeof bind> | undefined;
/** The bindings, loaded on first use so the pure functions below import anywhere. */
const native = () => (bound ??= bind());

const cache = <T>(make: (name: string) => T) => {
  const made = new Map<string, T>();
  return (name: string): T => made.get(name) ?? (made.set(name, make(name)), made.get(name)!);
};
const cls = cache((name) => native().getClass(name) as Ref);
const sel = cache((name) => native().selector(name) as Ref);
/** An immortal CFString for a constant: attribute names, action names, dictionary keys. */
const cfstr = cache((text) => native().CFStringCreate(null, text, UTF8) as Ref);

const pointerOut = new BigUint64Array(1);
const decoder = new TextDecoder();
let stringBuffer = new Uint8Array(1 << 16);

function jsString(cf: Ref): string {
  const n = native();
  const needed = Number(n.CFStringGetLength(cf)) * 3 + 1;
  if (needed > stringBuffer.length) stringBuffer = new Uint8Array(needed);
  if (!n.CFStringGetCString(cf, stringBuffer, stringBuffer.length, UTF8)) return "";
  return decoder.decode(stringBuffer.subarray(0, stringBuffer.indexOf(0)));
}

/** Cocoa hands back autoreleased objects, and no run loop here ever drains them. `work` must not await. */
function pooled<T>(work: () => T): T {
  const n = native();
  const pool = n.id(n.id(cls("NSAutoreleasePool"), sel("alloc")), sel("init"));
  try {
    return work();
  } finally {
    n.void(pool, sel("drain"));
  }
}

/** A struct that a Cocoa property holds, read as doubles: KVC boxes it in an NSValue, which copies it out. */
function structOf(object: Ref, key: string, doubles: number): number[] {
  const n = native();
  const out = new Float64Array(doubles);
  n.voidPtr(n.idId(object, sel("valueForKey:"), cfstr(key)), sel("getValue:"), out);
  return [...out];
}

/**
 * The Objective-C runtime as bound here, for the one other module that talks to AppKit: the hand draws with it.
 * `msg` is `objc_msgSend` under one exact signature, written "returns,arg,arg":
 * `msg("void,f64,f64")(layer, sel("setPosition:"), x, y)`.
 */
export const objc = {
  cls,
  sel,
  str: cfstr,
  pooled,
  structOf,
  msg: cache((signature): Native => {
    const [returns, ...args] = signature.split(",") as FFITypeOrString[];
    return native().send(returns!, ...args);
  }),
  fn: (name: string, args: FFITypeOrString[], returns: FFITypeOrString): Native => native().fn(name, args, returns),
};

const sleep = (ms: number) => Bun.sleep(ms);

// ------------------------------------------------------------------ escape hatch

let interrupted = false;
/** Ctrl-C lands here so a run unwinds through the same path as the mouse corner, and still writes its summary. */
export function interrupt(on = true): void {
  interrupted = on;
}

/** The mouse in global points, y down from the top of the main display. */
export function mouseLocation(): Point {
  return pooled(() => {
    const [x, y] = structOf(cls("NSEvent"), "mouseLocation", 2) as [number, number];
    return [x, mainDisplayHeight() - y];
  });
}

/** The corner of whichever display the mouse is on: with one display stacked on another, a slam never reaches the main one's. */
export function checkAbort(): void {
  if (interrupted) throw new Abort("Ctrl-C");
  const [x, y] = mouseLocation();
  const cornered = displays().some(({ frame: [dx, dy] }) => x >= dx && y >= dy && x - dx <= ABORT_CORNER_PX && y - dy <= ABORT_CORNER_PX);
  if (cornered) throw new Abort("mouse in top-left corner");
}

export async function sleepWatching(seconds: number): Promise<void> {
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    checkAbort();
    await sleep(100);
  }
}

export const accessibilityTrusted = (): boolean => Boolean(native().AXIsProcessTrusted());

// ------------------------------------------------------------------ displays

export interface Display {
  index: number; // position in NSScreen.screens, which is what `screencapture -D` counts from one
  frame: Frame; // global points, y down from the top of the main display
}

function screenFrames(): Frame[] {
  const n = native();
  return pooled(() => {
    const screens = n.id(cls("NSScreen"), sel("screens"));
    const count = Number(n.count(screens, sel("count")));
    return Array.from({ length: count }, (_, i) => structOf(n.idIndex(screens, sel("objectAtIndex:"), i), "frame", 4) as Frame);
  });
}

const mainDisplayHeight = (): number => screenFrames()[0]?.[3] ?? 0;

/** Every display, the main one first. Cocoa counts y up from the main display's bottom edge; this flips it. */
export function displays(): Display[] {
  const frames = screenFrames();
  const mainHeight = frames[0]?.[3] ?? 0;
  return frames.map(([x, y, w, h], index) => ({ index, frame: [x, mainHeight - (y + h), w, h] }));
}

/** The display holding the center of a frame, or the main one when there is no frame or no such display. */
export function displayFor(frame: Frame | null): Display {
  const all = displays();
  const main = all[0] ?? { index: 0, frame: [0, 0, 0, 0] as Frame };
  if (!frame) return main;
  const [cx, cy] = [frame[0] + frame[2] / 2, frame[1] + frame[3] / 2];
  return all.find(({ frame: [x, y, w, h] }) => cx >= x && cx < x + w && cy >= y && cy < y + h) ?? main;
}

// ------------------------------------------------------------------ input

/**
 * Deliver an event: to the seat, where it goes to whatever has the focus, or to one process, which
 * gets it whether or not it is in front. The second is how a key reaches an app the user is not in.
 */
async function post(event: Ref, delay = EVENT_DELAY_MS, pid?: number): Promise<void> {
  const n = native();
  if (pid === undefined) n.CGEventPost(0, event); // kCGHIDEventTap
  else n.CGEventPostToPid(pid, event);
  n.CFRelease(event);
  await sleep(delay);
}

const MOUSE = { moved: 5, leftDown: 1, leftUp: 2, rightDown: 3, rightUp: 4, leftDragged: 6 };
const CLICK_STATE_FIELD = 1; // kCGMouseEventClickState

export async function moveTo([x, y]: Point): Promise<void> {
  await post(native().CGEventCreateMouse(null, MOUSE.moved, x, y, 0));
}

export async function clickAt(point: Point, options: { button?: "left" | "right"; count?: number } = {}): Promise<void> {
  const n = native();
  const right = options.button === "right";
  const [down, up, button] = right ? [MOUSE.rightDown, MOUSE.rightUp, 1] : [MOUSE.leftDown, MOUSE.leftUp, 0];
  await moveTo(point);
  for (let click = 1; click <= (options.count ?? 1); click++) {
    for (const kind of [down, up]) {
      const event = n.CGEventCreateMouse(null, kind, point[0], point[1], button);
      n.CGEventSetInteger(event, CLICK_STATE_FIELD, click);
      await post(event);
    }
  }
}

/** Press, drag through every point, release. The points between are filled in, since a canvas draws what it is sent; `onMove` hears each one. */
export async function drag(path: Point[], onMove?: (at: Point) => void): Promise<void> {
  const n = native();
  const [start, end] = [path[0], path[path.length - 1]];
  if (!start || !end) return;
  await moveTo(start);
  await post(n.CGEventCreateMouse(null, MOUSE.leftDown, start[0], start[1], 0));
  let [px, py] = start;
  for (const [x, y] of path.slice(1)) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / DRAG_STEP_PT));
    for (let i = 1; i <= steps; i++) {
      checkAbort();
      const at: Point = [px + ((x - px) * i) / steps, py + ((y - py) * i) / steps];
      onMove?.(at);
      await post(n.CGEventCreateMouse(null, MOUSE.leftDragged, at[0], at[1], 0), DRAG_DELAY_MS);
    }
    [px, py] = [x, y];
  }
  await sleep(EVENT_DELAY_MS);
  await post(n.CGEventCreateMouse(null, MOUSE.leftUp, end[0], end[1], 0));
}

export async function press(key: string, modifiers: string[] = [], pid?: number): Promise<void> {
  const n = native();
  const code = KEYCODES[key.toLowerCase()];
  if (code === undefined) throw new Error(`unknown key ${JSON.stringify(key)}`);
  let flags = 0;
  for (const name of modifiers) {
    const flag = MODIFIERS[name.toLowerCase()];
    if (flag === undefined) throw new Error(`unknown modifier ${JSON.stringify(name)}`);
    flags |= flag;
  }
  for (const down of [true, false]) {
    const event = n.CGEventCreateKeyboard(null, code, down);
    // Set even when zero: a bare key must not inherit a modifier the user happens to be holding.
    n.CGEventSetFlags(event, flags);
    await post(event, EVENT_DELAY_MS, pid);
  }
}

export async function typeText(text: string, pid?: number): Promise<void> {
  const n = native();
  for (const ch of text) {
    if (ch === "\n" || ch === "\t") {
      await press(ch === "\n" ? "return" : "tab", [], pid);
      continue;
    }
    const units = Uint16Array.from({ length: ch.length }, (_, i) => ch.charCodeAt(i));
    for (const down of [true, false]) {
      const event = n.CGEventCreateKeyboard(null, 0, down);
      n.CGEventSetFlags(event, 0);
      n.CGEventSetUnicode(event, units.length, units);
      await post(event, TYPING_DELAY_MS, pid);
    }
  }
}

/** Long text goes through the clipboard: one paste instead of two events per character. */
export async function pasteText(text: string): Promise<void> {
  const pbcopy = Bun.spawn(["pbcopy"], { stdin: "pipe" });
  pbcopy.stdin.write(text);
  await pbcopy.stdin.end();
  await pbcopy.exited;
  await press("v", ["cmd"]);
}

export async function clearField(): Promise<void> {
  await press("a", ["cmd"]);
  await press("delete");
}

/** Scroll events go to the view under the cursor, so park it over the frontmost window, or the given point, first. */
export async function scroll(lines: number, at?: Point, horizontal = 0): Promise<void> {
  const target = at ?? (await frontmostWindowCenter());
  if (target) await moveTo(target);
  await post(native().CGEventCreateScroll(null, 1, 2, lines, horizontal, 0)); // kCGScrollEventUnitLine
}

// ------------------------------------------------------------------ apps and windows

export async function osascript(script: string): Promise<string> {
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`osascript failed: ${err.trim() || `exit ${code}`}`);
  return out.trim();
}

/** AppleScript string literal. */
export const quoted = (text: string): string => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Name and pid of the frontmost process. The accessibility API answers without spawning anything;
 * AppleScript is the fallback for the moments it has no focused application to report.
 *
 * The name is the one the workspace knows the process by ("Google Chrome"), which is what AppleScript
 * addresses it as. The accessibility element's own title is whatever the app calls itself ("Chrome").
 */
export async function frontmostAppAndPid(): Promise<[string, number]> {
  const n = native();
  const app = copyAttribute(systemWide(), "AXFocusedApplication");
  if (app) {
    const pid = new Int32Array(1);
    const ok = n.AXGetPid(app, pid) === 0;
    n.CFRelease(app);
    const name = pooled(() => {
      const running = ok && n.idPid(cls("NSRunningApplication"), sel("runningApplicationWithProcessIdentifier:"), pid[0]!);
      const localized = running && n.id(running, sel("localizedName"));
      return localized ? jsString(localized) : "";
    });
    if (name) return [name, pid[0]!];
  }
  const reply = await osascript(
    'tell application "System Events" to tell (first application process whose frontmost is true) to get {name, unix id}',
  );
  const cut = reply.lastIndexOf(", ");
  return [reply.slice(0, cut), Number(reply.slice(cut + 2))];
}

export const frontmostApp = async (): Promise<string> => (await frontmostAppAndPid())[0];
export const frontmostPid = async (): Promise<number> => (await frontmostAppAndPid())[1];

// An app can run twice: the user's own, and one that automation started with a profile of its own. A
// name addresses either, and which one depends on who asks (AppleScript and JXA disagree), so the
// user's instance is found by its command line and then only ever addressed by pid.
const AUTOMATION_FLAGS = /--(user-data-dir|headless|remote-debugging-(port|pipe))\b/;
const userPids = new Map<string, number>();

/** The pid of the app as the user runs it, or null when only automation's instances, or none, are up. */
export async function userInstance(app: string): Promise<number | null> {
  const known = userPids.get(app);
  if (known !== undefined) {
    try {
      process.kill(known, 0); // still running
      return known;
    } catch {
      userPids.delete(app);
    }
  }
  const mine = (await appInstances(app)).find((instance) => !instance.automated);
  if (mine) userPids.set(app, mine.pid);
  return mine?.pid ?? null;
}

/** Main processes of an app. Helpers live under Frameworks, so the executable's own folder tells them apart. */
export async function appInstances(app: string): Promise<{ pid: number; automated: boolean }[]> {
  const ps = Bun.spawn(["ps", "-axo", "pid=,command="], { stdout: "pipe" });
  const lines = (await new Response(ps.stdout).text()).split("\n");
  return lines
    .filter((line) => line.includes(`/${app}.app/Contents/MacOS/`))
    .map((line) => ({ pid: Number.parseInt(line, 10), automated: AUTOMATION_FLAGS.test(line) }));
}

/** The app's pid, started if it was not running, without it coming forward or taking the keyboard. */
export async function runInBackground(app: string, timeout = 8.0): Promise<number | null> {
  let pid = await userInstance(app);
  if (pid !== null) return pid;
  const others = (await appInstances(app)).length > 0; // -n, or `open` settles for automation's instance
  const opened = Bun.spawn(["open", "-g", ...(others ? ["-n"] : []), "-a", app], { stderr: "pipe" }); // -g: do not bring it forward
  if ((await opened.exited) !== 0) throw new Error((await new Response(opened.stderr).text()).trim() || `cannot open ${app}`);
  for (const end = performance.now() + timeout * 1000; pid === null && performance.now() < end; await sleep(200)) pid = await userInstance(app);
  return pid;
}

/** Bring an app to the front and confirm it got there. */
export async function activate(app: string, timeout = 3.0): Promise<boolean> {
  let pid = await userInstance(app);
  if (pid === null) {
    // Not running as the user's: `open` starts it, and -n keeps it from settling for automation's instance.
    const others = (await appInstances(app)).length > 0;
    await Bun.spawn(["open", ...(others ? ["-n"] : []), "-a", app], { stderr: "ignore" }).exited;
    for (const end = performance.now() + timeout * 1000; pid === null && performance.now() < end; await sleep(200)) pid = await userInstance(app);
  }
  // No such process: a name `open` did not know, or an app whose bundle is not named after it.
  const front = pid === null ? `tell application ${quoted(app)} to activate` : `tell application "System Events" to set frontmost of (first application process whose unix id is ${pid}) to true`;
  // Accessibility reports some apps by their process name ("ghostty"), so the fallback comparison ignores case.
  const isFront = async () => (pid === null ? (await frontmostApp()).toLowerCase() === app.toLowerCase() : (await frontmostPid()) === pid);
  for (let attempt = 0; attempt < 2; attempt++) {
    await osascript(front).catch(() => {});
    for (const end = performance.now() + (timeout * 1000) / 2; performance.now() < end; await sleep(100)) if (await isFront()) return true;
  }
  return isFront();
}

// ------------------------------------------------------------------ the browser

export interface Tab {
  scripted: string; // the window's scripting id, which outlives reordering
  window: number; // 1 is the front window
  tab: number;
  active: boolean;
  title: string;
  url: string;
}

/**
 * The user's browser over ScriptingBridge, which is the one Apple Events route that binds to a pid.
 *
 * Now and then the bridge cannot resolve a pid that is plainly running, and hands back an application
 * with no scripting classes behind it. An Objective-C exception crossing the FFI boundary cannot be
 * caught, it ends the process, so nothing is asked of an application that does not answer `isRunning`.
 */
async function scripted(browser: string, launch?: "front" | "background"): Promise<Ref | null> {
  let pid = await userInstance(browser);
  if (pid === null && launch === "front" && (await activate(browser))) pid = await userInstance(browser);
  if (pid === null && launch === "background") pid = await runInBackground(browser);
  if (pid === null) return null;
  const n = native();
  for (let attempt = 0; attempt < 5; attempt++) {
    const app = n.idPid(cls("SBApplication"), sel("applicationWithProcessIdentifier:"), pid) as Ref | null;
    if (app && n.bool(app, sel("isRunning"))) return app;
    await sleep(300);
  }
  return null;
}

const elements = (array: Ref | null): Ref[] => {
  const n = native();
  return array ? Array.from({ length: Number(n.count(array, sel("count"))) }, (_, i) => n.idIndex(array, sel("objectAtIndex:"), i) as Ref) : [];
};
const stringOf = (object: Ref | null, key: string): string => {
  const value = object ? native().id(object, sel(key)) : null;
  return value ? jsString(value) : "";
};

/** A window by its place front to back (1 is the front one), or by the id the browser's scripting knows it by, which outlives reordering. */
export type WindowSelector = number | string;

const describe = (object: Ref | null): string => (object ? jsString(native().id(object, sel("description"))) : "");
/** The scripting id of every window, front to back, in one Apple Event. */
const windowIds = (app: Ref): string[] => elements(native().idId(native().id(app, sel("windows")), sel("arrayByApplyingSelector:"), sel("id"))).map(describe);

/** Window `window` (the front one by default) and tab `tab` of it (the active one by default), or null. */
function tabAt(app: Ref, window?: WindowSelector, tab?: number): { win: Ref; target: Ref } | null {
  const n = native();
  const index = typeof window === "string" ? windowIds(app).indexOf(window) : (window ?? 1) - 1;
  const win = elements(n.id(app, sel("windows")))[index];
  if (!win) return null;
  const target = tab === undefined ? (n.id(win, sel("activeTab")) as Ref | null) : elements(n.id(win, sel("tabs")))[tab - 1];
  return target ? { win, target } : null;
}

export async function browserTabs(browser: string): Promise<Tab[]> {
  const app = await scripted(browser);
  if (!app) return [];
  const n = native();
  return pooled(() => {
    const ids = windowIds(app);
    return elements(n.id(app, sel("windows"))).flatMap((win, w) => {
      const active = Number(n.integer(win, sel("activeTabIndex")));
      // One Apple Event per property for the whole window, where asking each tab costs one per tab.
      const every = (property: string) => elements(n.idId(n.id(win, sel("tabs")), sel("arrayByApplyingSelector:"), sel(property))).map(jsString);
      const urls = every("URL");
      return every("title").map((title, t) => ({ scripted: ids[w] ?? "", window: w + 1, tab: t + 1, active: t + 1 === active, title, url: urls[t] ?? "" }));
    });
  });
}

/** The front window's active tab URL in the user's browser. A browser that is not running answers null rather than being launched. */
export async function browserUrl(browser: string, window?: WindowSelector): Promise<string | null> {
  const app = await scripted(browser).catch(() => null);
  if (!app) return null;
  return pooled(() => stringOf(tabAt(app, window)?.target ?? null, "URL")) || null;
}

/** Show a URL in the user's browser: a new tab of a window by default, or the tab named, and bring the browser forward. */
export async function openUrl(
  browser: string,
  url: string,
  options: { newTab?: boolean; newWindow?: boolean; window?: WindowSelector; tab?: number; background?: boolean } = {},
): Promise<boolean> {
  const app = await scripted(browser, options.background ? "background" : "front");
  if (!app) throw new Error(`${browser} did not answer over its scripting interface; try again`);
  const n = native();
  // The window about to be navigated may already be the front one, and then there is nothing to put back.
  const front = options.background ? pooled(() => windowIds(app)[0]) : undefined;
  const inFront = front === options.window ? undefined : front;
  const seat = options.background ? await frontmostPid() : undefined;
  const fresh = options.newTab ?? true;
  /** A new scripting object added to `container`. Adding nil raises, and nothing here can catch that. */
  const add = (container: Ref | null, kind: string, properties: Ref | null) => {
    const made = n.id(n.idId(app, sel("classForScriptingClass:"), cfstr(kind)), sel("alloc"));
    const object = made && (properties ? n.idId(made, sel("initWithProperties:"), properties) : n.id(made, sel("init")));
    if (!container || !object) throw new Error(`${browser} would not make a new ${kind}; try again`);
    n.voidPtr(container, sel("addObject:"), object);
  };
  const setUrl = (tab: Ref | null) => {
    const cfUrl = n.CFStringCreate(null, url, UTF8);
    n.voidPtr(tab, sel("setURL:"), cfUrl);
    n.CFRelease(cfUrl);
  };

  // From inside the page, when the user allows it: a bare new tab raises nothing, and neither does a page that navigates itself.
  const quiet = options.background && !options.newWindow && pooled(() => {
    const existing = tabAt(app, options.window, options.tab);
    if (!existing || !runInPage(existing.target, "1")) return false;
    if (fresh) add(n.id(existing.win, sel("tabs")), "tab", null);
    return true;
  });
  if (quiet) {
    // A tab that was made a moment ago may not run scripts yet.
    for (const end = performance.now() + 2000; performance.now() < end; await sleep(100)) {
      if (pooled(() => navigateFromPage((fresh ? tabAt(app, options.window) : tabAt(app, options.window, options.tab))?.target ?? null, url))) return true;
    }
  }

  pooled(() => {
    const existing = options.newWindow ? null : tabAt(app, options.window, quiet && fresh ? undefined : options.tab);
    if (!existing) {
      add(n.id(app, sel("windows")), "window", null); // the new window comes to the front, on a blank tab
      setUrl(tabAt(app)?.target ?? null);
    } else if (fresh && !quiet) {
      const cfUrl = n.CFStringCreate(null, url, UTF8);
      add(n.id(existing.win, sel("tabs")), "tab", n.idIdId(cls("NSDictionary"), sel("dictionaryWithObject:forKey:"), cfUrl, cfstr("URL")));
      n.CFRelease(cfUrl);
    } else {
      setUrl(existing.target); // including the bare tab made above, when its page would not run the script
    }
  });
  if (!options.background) return activate(browser);
  await restoreFront(app, inFront);
  await returnSeat(seat, await userInstance(browser));
  return true;
}

/** Whether the front window's active tab is still loading. A browser that is not running is not. */
export async function browserLoading(browser: string, window?: WindowSelector): Promise<boolean> {
  const app = await scripted(browser).catch(() => null);
  if (!app) return false;
  return pooled(() => {
    const at = tabAt(app, window);
    return at ? Boolean(native().bool(at.target, sel("loading"))) : false;
  });
}

export type TabCommand = "switch_tab" | "close_tab" | "back" | "forward" | "reload";

/** Act on a tab of the user's browser. Returns the tab it acted on as `title | url`, or null when there is no such tab. */
export async function tabCommand(browser: string, command: TabCommand, window?: WindowSelector, tab?: number, background = false): Promise<string | null> {
  const app = await scripted(browser);
  if (!app) return null;
  const n = native();
  const described = pooled(() => {
    const at = tabAt(app, window, tab);
    if (!at) return null;
    const description = `${stringOf(at.target, "title")} | ${stringOf(at.target, "URL")}`;
    if (command === "switch_tab") {
      if (tab !== undefined) n.voidInt(at.win, sel("setActiveTabIndex:"), tab);
      if (!background) n.voidInt(at.win, sel("setIndex:"), 1); // raising the window is the part that takes the user's place
    } else {
      n.void(at.target, sel({ close_tab: "close", back: "goBack", forward: "goForward", reload: "reload" }[command]));
    }
    return description;
  });
  if (described !== null && command === "switch_tab" && !background) await activate(browser);
  return described;
}

/** A script run in a tab through the browser's scripting, or null when that is not allowed, or the page is one scripts cannot run in. */
function runInPage(tab: Ref | null, script: string): Ref | null {
  if (!tab) return null;
  const n = native();
  const source = n.CFStringCreate(null, script, UTF8);
  const result = n.idId(tab, sel("executeJavascript:"), source) as Ref | null;
  n.CFRelease(source);
  return result;
}

/**
 * Navigate a tab from inside its own page: `location.href = url`, run through the browser's scripting.
 * Chrome stamps a navigation that arrives by Apple Event as a user gesture, and answers a user gesture by
 * activating itself and raising the window; one the page starts carries no gesture and raises nothing
 * (measured: two navigations and a new tab, with the frontmost app and the window order never changing).
 * It takes the user's say-so, though: View > Developer > Allow JavaScript from Apple Events, off by
 * default. False when that is off, or the page is one scripts cannot run in, and the caller sets the URL
 * the plain way instead.
 */
function navigateFromPage(tab: Ref | null, url: string): boolean {
  if (!runInPage(tab, "1")) return false;
  runInPage(tab, `location.href = ${JSON.stringify(url)}`);
  return true;
}

/**
 * Give the keyboard back to the app that had it. Making a window or setting a tab's URL does not only
 * reorder the browser's windows: the browser activates itself over whatever the user was in.
 */
async function returnSeat(seat: number | undefined, taker: number | null): Promise<void> {
  if (seat === undefined || taker === null || seat === taker) return;
  for (const end = performance.now() + 1000; performance.now() < end; await sleep(50)) {
    if ((await frontmostPid()) !== taker) continue;
    await osascript(`tell application "System Events" to set frontmost of (first application process whose unix id is ${seat}) to true`).catch(() => {});
    return;
  }
}

/**
 * Put the window that was in front back in front, after a scripting call that made the browser raise another.
 *
 * Measured on Chrome: pressing, filling and scrolling a covered window through accessibility never
 * reorder anything, and neither do its back, forward and reload, which go straight to the navigation
 * controller. Making a window and setting a tab's URL do: Chrome takes a navigation that arrives by
 * Apple Event for a user gesture, and answers one with Show(), which on a visible window activates the
 * app and makes the window key. `make new window` calls Show() before any property is applied, so
 * nothing passed to it helps. Those calls are therefore followed by this and by returnSeat, and what
 * the user loses is about a fifth of a second.
 * ponytail: a blink per scripted navigation. navigateFromPage removes it when the user has allowed
 * JavaScript from Apple Events; an extension (windows.create focused:false) would remove the last one.
 */
async function restoreFront(app: Ref, wasInFront: string | undefined): Promise<void> {
  if (wasInFront === undefined) return;
  const n = native();
  for (const end = performance.now() + 1500; performance.now() < end; await sleep(50)) {
    const raised = pooled(() => {
      if (windowIds(app)[0] === wasInFront) return false;
      n.voidInt(tabAt(app, wasInFront)?.win ?? null, sel("setIndex:"), 1);
      return true;
    });
    if (raised) return;
  }
}

/** A browser window of the agent's own: which process, the window server's id for it, and the scripting id. */
export interface PinnedWindow {
  pid: number;
  windowId: number;
  scripted: string;
}

/**
 * A new window in the user's browser and profile, opened without bringing the browser forward.
 *
 * Nothing about it takes the keyboard or the mouse. The one visible moment is when the user is in the
 * browser themselves: a new window opens over theirs, and theirs is put back in front a beat later.
 * A window that is covered keeps rendering and keeps its accessibility tree, so it can be read and
 * worked from behind.
 */
export async function openBackgroundWindow(browser: string, url: string): Promise<PinnedWindow> {
  const app = await scripted(browser, "background");
  const pid = await userInstance(browser);
  if (!app || pid === null) throw new Error(`${browser} did not answer over its scripting interface; try again`);
  const [windowsBefore, scriptedBefore] = [new Set(appWindows(pid).map((w) => w.id)), pooled(() => windowIds(app))];
  await openUrl(browser, url, { newWindow: true, background: true });
  let opened: PinnedWindow | null = null;
  for (const end = performance.now() + 5000; !opened && performance.now() < end; await sleep(100)) {
    const windowId = appWindows(pid).find((w) => !windowsBefore.has(w.id))?.id;
    const scriptedId = pooled(() => windowIds(app)).find((id) => !scriptedBefore.includes(id));
    if (windowId !== undefined && scriptedId !== undefined) opened = { pid, windowId, scripted: scriptedId };
  }
  if (!opened) throw new Error(`${browser} opened no new window`);
  return opened;
}

/**
 * The frontmost app's topmost on-screen window as x, y, w, h in points. Pure Quartz, no AX needed.
 *
 * Pass the pid when the caller already has it; looking it up is another round trip.
 */
export async function frontmostWindowBounds(pid?: number | null): Promise<Frame | null> {
  return appWindows(pid ?? (await frontmostPid()))[0]?.frame ?? null;
}

export interface AppWindow {
  id: number; // CGWindowID, which `screencapture -l` and the accessibility tree both know a window by
  frame: Frame;
}

/** An app's ordinary on-screen windows, front to back. One that is covered by another still counts; a minimized one does not. */
export function appWindows(pid: number): AppWindow[] {
  const n = native();
  const windows = n.CGWindowListCopyWindowInfo(1 | 16, 0); // on screen only, no desktop elements
  if (!windows) return [];
  try {
    const number = new BigInt64Array(1);
    const rect = new Float64Array(4);
    const integer = (dict: Ref, key: string): number | null => {
      const value = n.CFDictionaryGetValue(dict, cfstr(key));
      return value && n.CFNumberGetValue(value, 4, number) ? Number(number[0]) : null; // kCFNumberSInt64Type
    };
    const out: AppWindow[] = [];
    for (let i = 0; i < Number(n.CFArrayGetCount(windows)); i++) {
      const window = n.CFArrayGetValueAtIndex(windows, i);
      if (integer(window, "kCGWindowOwnerPID") !== pid || integer(window, "kCGWindowLayer") !== 0) continue;
      const bounds = n.CFDictionaryGetValue(window, cfstr("kCGWindowBounds"));
      if (!bounds || !n.CGRectFromDictionary(bounds, rect)) continue;
      if (rect[2]! > MIN_WINDOW_SIDE_PT && rect[3]! > MIN_WINDOW_SIDE_PT) out.push({ id: integer(window, "kCGWindowNumber") ?? 0, frame: [...rect] as Frame });
    }
    return out;
  } finally {
    n.CFRelease(windows);
  }
}

/** Every ordinary on-screen window of every app, front to back, with the process that owns it and how solid it is. */
export function allWindows(): (AppWindow & { pid: number; alpha: number })[] {
  const n = native();
  const windows = n.CGWindowListCopyWindowInfo(1 | 16, 0);
  if (!windows) return [];
  try {
    const number = new BigInt64Array(1);
    const rect = new Float64Array(4);
    const integer = (dict: Ref, key: string): number | null => {
      const value = n.CFDictionaryGetValue(dict, cfstr(key));
      return value && n.CFNumberGetValue(value, 4, number) ? Number(number[0]) : null;
    };
    const out: (AppWindow & { pid: number; alpha: number })[] = [];
    const real = new Float64Array(1);
    for (let i = 0; i < Number(n.CFArrayGetCount(windows)); i++) {
      const window = n.CFArrayGetValueAtIndex(windows, i);
      const bounds = n.CFDictionaryGetValue(window, cfstr("kCGWindowBounds"));
      if (integer(window, "kCGWindowLayer") !== 0 || !bounds || !n.CGRectFromDictionary(bounds, rect)) continue;
      if (rect[2]! <= MIN_WINDOW_SIDE_PT || rect[3]! <= MIN_WINDOW_SIDE_PT) continue;
      const alpha = n.CFDictionaryGetValue(window, cfstr("kCGWindowAlpha"));
      out.push({
        id: integer(window, "kCGWindowNumber") ?? 0,
        pid: integer(window, "kCGWindowOwnerPID") ?? 0,
        frame: [...rect] as Frame,
        alpha: alpha && n.CFNumberGetValue(alpha, 13, real) ? real[0]! : 1, // kCFNumberDoubleType
      });
    }
    return out;
  } finally {
    n.CFRelease(windows);
  }
}

/** Center of the frontmost app's topmost on-screen window, in points. */
export async function frontmostWindowCenter(pid?: number | null): Promise<Point | null> {
  const bounds = await frontmostWindowBounds(pid);
  return bounds && [bounds[0] + bounds[2] / 2, bounds[1] + bounds[3] / 2];
}

// ------------------------------------------------------------------ capture and OCR

/** One display as a PNG at `path`. Without Screen Recording permission this is wallpaper. */
export async function screenshot(display: Display, path: string): Promise<Capture> {
  const proc = Bun.spawn(["screencapture", "-x", "-D", String(display.index + 1), path], { stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`screencapture failed: ${(await new Response(proc.stderr).text()).trim()}`);
  return captureAt(path);
}

/** One window as a PNG, without its shadow. The window server composites it whole even when other windows cover it. */
export async function screenshotWindow(windowId: number, path: string): Promise<Capture> {
  const proc = Bun.spawn(["screencapture", "-x", "-o", "-l", String(windowId), path], { stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`screencapture failed: ${(await new Response(proc.stderr).text()).trim()}`);
  return captureAt(path);
}

/** The name the workspace knows a process by. */
export function appName(pid: number): string {
  const n = native();
  return pooled(() => {
    const running = n.idPid(cls("NSRunningApplication"), sel("runningApplicationWithProcessIdentifier:"), pid);
    const localized = running && n.id(running, sel("localizedName"));
    return localized ? jsString(localized) : "";
  });
}

/** A capture already on disk. Reading its size decodes the image, which the OCR that follows needs anyway. */
export function captureAt(path: string): Capture {
  const { width, height } = loadImage(path);
  return { path, width, height };
}

let loaded: { path: string; image: Ref; width: number; height: number } | undefined;

function loadImage(path: string) {
  if (loaded?.path === path) return loaded;
  const n = native();
  const cfPath = n.CFStringCreate(null, path, UTF8);
  const url = n.CFURLCreateWithFileSystemPath(null, cfPath, 0, false);
  const source = n.CGImageSourceCreateWithURL(url, null);
  const image = source && n.CGImageSourceCreateImage(source, 0, null);
  for (const ref of [source, url, cfPath]) if (ref) n.CFRelease(ref);
  if (!image) throw new Error(`cannot read image ${path}`);
  if (loaded) n.CFRelease(loaded.image);
  loaded = { path, image, width: Number(n.CGImageGetWidth(image)), height: Number(n.CGImageGetHeight(image)) };
  return loaded;
}

export type OcrLine = [text: string, confidence: number, box: Box];

/**
 * Vision text recognition over one rectangle of a capture, accurate level. Boxes come back in
 * full-capture pixels, so nothing downstream knows a crop happened.
 */
export function recognizeText(path: string, rect?: Box): OcrLine[] {
  const n = native();
  const full = loadImage(path);
  const [left, y1, x2, y2] = (rect ?? [0, 0, full.width, full.height]).map(Math.round) as Box;
  // A crop is a view into the decoded capture, not a copy. ImageIO pads that buffer's rows to 16 bytes and ends it with
  // a guard page, and Core Image reads a row 16 bytes at a time from wherever the crop begins. Begun off that grid, a
  // crop that reaches the capture's bottom right corner is read up to 12 bytes past the buffer: a bus error whenever the
  // decoded bytes fill their last page exactly, as a 3840x2160 display's do. Begun on it, no read leaves the row.
  const x1 = Math.max(0, Math.floor(left / 4) * 4);
  const whole = x1 === 0 && y1 === 0 && x2 === full.width && y2 === full.height;
  const [width, height] = [x2 - x1, y2 - y1];
  if (width <= 0 || height <= 0) return [];
  const image = whole ? full.image : n.CGImageCrop(full.image, x1, y1, width, height);
  if (!image) return [];

  const pool = n.id(n.id(cls("NSAutoreleasePool"), sel("alloc")), sel("init"));
  const request = n.id(n.id(cls("VNRecognizeTextRequest"), sel("alloc")), sel("init"));
  const options = n.id(cls("NSDictionary"), sel("dictionary"));
  const handler = n.idIdId(n.id(cls("VNImageRequestHandler"), sel("alloc")), sel("initWithCGImage:options:"), image, options);
  try {
    n.voidInt(request, sel("setRecognitionLevel:"), 0); // VNRequestTextRecognitionLevelAccurate
    if (!n.boolIdPtr(handler, sel("performRequests:error:"), n.idId(cls("NSArray"), sel("arrayWithObject:"), request), null)) return [];
    const results = n.id(request, sel("results"));
    const count = results ? Number(n.count(results, sel("count"))) : 0;
    const lines: OcrLine[] = [];
    for (let i = 0; i < count; i++) {
      const observation = n.idIndex(results, sel("objectAtIndex:"), i);
      const candidate = n.id(n.idIndex(observation, sel("topCandidates:"), 1), sel("firstObject"));
      if (!candidate) continue;
      // Vision boxes are fractions of the image it was given, y up from the bottom edge.
      const [bx, by, bw, bh] = structOf(observation, "boundingBox", 4) as Frame;
      const box: Box = [x1 + bx * width, y1 + (1 - by - bh) * height, x1 + (bx + bw) * width, y1 + (1 - by) * height];
      lines.push([jsString(n.id(candidate, sel("string"))), n.float(candidate, sel("confidence")), box]);
    }
    return lines;
  } finally {
    n.void(handler, sel("release"));
    n.void(request, sel("release"));
    n.void(pool, sel("drain"));
    if (!whole) n.CFRelease(image);
  }
}

// ------------------------------------------------------------------ accessibility elements

// Element handles given out to a Screen stay retained until the next capture replaces them. Pressing
// one from an older capture is refused rather than sent to freed memory.
let live = new Set<bigint>();

/** Drop every handle the previous capture gave out. Perception calls this as a new capture starts. */
export function releaseElements(): void {
  if (!bound) return;
  for (const ref of live) bound.CFRelease(ref);
  live = new Set();
}

const keep = (ref: Ref): Ref => (live.add(BigInt(ref)), ref);
const alive = (ref: unknown): ref is Ref => (typeof ref === "number" || typeof ref === "bigint") && live.has(BigInt(ref));

let systemWideElement: Ref | undefined;
const systemWide = (): Ref => (systemWideElement ??= native().AXCreateSystemWide() as Ref);

/** One attribute as a retained object, or null. A dead or hostile element reports an error; that is a miss, not a crash. */
function copyAttribute(element: Ref, name: string): Ref | null {
  pointerOut[0] = 0n;
  const err = native().AXCopyAttribute(element, cfstr(name), pointerOut);
  return err === 0 && pointerOut[0] ? pointerOut[0] : null;
}

type AxValue = string | Point | null;

const attributeLists = cache((names) => {
  const refs = BigUint64Array.from(names.split(","), (name) => BigInt(cfstr(name)));
  return native().CFArrayCreate(null, refs, refs.length, native().sym("kCFTypeArrayCallBacks")) as Ref;
});

/** Several attributes in one round trip to the app: strings as strings, points and sizes as pairs, the rest null. */
function axValues(element: Ref, names: string[]): AxValue[] {
  const n = native();
  pointerOut[0] = 0n;
  const err = n.AXCopyAttributes(element, attributeLists(names.join(",")), 0, pointerOut);
  const values = pointerOut[0];
  if (err !== 0 || !values) return names.map(() => null);
  const pair = new Float64Array(2);
  const out = names.map((_, i): AxValue => {
    const value = n.CFArrayGetValueAtIndex(values, i);
    if (!value) return null;
    const type = Number(n.CFGetTypeID(value));
    if (type === n.CFStringTypeID) return jsString(value);
    if (type !== n.AXValueTypeID) return null;
    const kind = n.AXValueGetType(value);
    if (kind !== AX_POINT && kind !== AX_SIZE) return null; // an AXError stands in for a missing attribute
    return n.AXValueGetValue(value, kind, pair) ? [pair[0]!, pair[1]!] : null;
  });
  n.CFRelease(values);
  return out;
}

const text = (value: AxValue | undefined): string => (typeof value === "string" ? value : "");
const pairOf = (value: AxValue | undefined): Point | null => (Array.isArray(value) ? value : null);

export function focusedField(): Field | null {
  const element = copyAttribute(systemWide(), "AXFocusedUIElement");
  if (!element) return null;
  const [role, title, description, placeholder, value, position, size] = axValues(element, [
    "AXRole", "AXTitle", "AXDescription", "AXPlaceholderValue", "AXValue", "AXPosition", "AXSize",
  ]); // prettier-ignore
  const [at, extent] = [pairOf(position), pairOf(size)];
  const [x, y, w, h] = at && extent ? [...at, ...extent] : [0, 0, 0, 0];
  return {
    role: text(role),
    label: text(title) || text(description),
    placeholder: text(placeholder),
    value: text(value),
    x: x!,
    y: y!,
    w: w!,
    h: h!,
    ref: keep(element),
  };
}

// ------------------------------------------------------------------ acting on an element

export const AX_PRESS = "AXPress";

// An element accepts these directly, so a press lands on the control the app declared rather than
// on whatever pixel happens to sit at its center. Every one of them is best effort: the element may
// be dead, the app may refuse. False means "use synthetic input".

/** Send AXPress to an element. */
export const axPress = (ref: unknown): boolean => alive(ref) && native().AXPerformAction(ref, cfstr(AX_PRESS)) === 0;

/** Any other action an element offers: AXScrollToVisible, AXConfirm, AXShowMenu. */
export const axPerform = (ref: unknown, action: string): boolean => alive(ref) && native().AXPerformAction(ref, cfstr(action)) === 0;

/** Give an element the keyboard focus. */
export const axFocus = (ref: unknown): boolean => alive(ref) && native().AXSetAttribute(ref, cfstr("AXFocused"), native().kCFBooleanTrue) === 0;

/** Write an element's value. A read-only or unwilling element reports an error. */
export function axSetValue(ref: unknown, value: string): boolean {
  if (!alive(ref)) return false;
  const n = native();
  const cf = n.CFStringCreate(null, value, UTF8);
  const ok = n.AXSetAttribute(ref, cfstr("AXValue"), cf) === 0;
  n.CFRelease(cf);
  return ok;
}

/** An element's value, when it has a textual one. */
export function axValue(ref: unknown): string | null {
  if (!alive(ref)) return null;
  const [value] = axValues(ref, ["AXValue"]);
  return typeof value === "string" ? value : null;
}

// ------------------------------------------------------------------ a pointer that is not the user's

/** One window of one process, as a pointer needs it: `web` for a browser or Electron page, which takes a different road in. */
export interface PointerTarget {
  pid: number;
  windowId: number;
  frame: Frame;
  web: boolean;
}

export const pointerAvailable = (): boolean => sky() !== null;

/** Whether a process draws its windows with Chromium: a browser of that family, or anything built on Electron or CEF. */
export function isWebContentApp(pid: number): boolean {
  const n = native();
  const path = pooled(() => {
    const running = n.idPid(cls("NSRunningApplication"), sel("runningApplicationWithProcessIdentifier:"), pid);
    const url = running && n.id(running, sel("bundleURL"));
    const bundle = url && n.id(url, sel("path"));
    return bundle ? jsString(bundle) : "";
  });
  if (!path) return false;
  const has = (relative: string) => existsSync(`${path}/Contents/Frameworks/${relative}`);
  return has("Electron Framework.framework") || has("Chromium Embedded Framework.framework") || /\/(Google Chrome|Chromium|Brave Browser|Microsoft Edge|Arc|Vivaldi|Opera)[^/]*\.app$/.test(path);
}

/** The window an app holds as key, by the window server's id. It is the app's own notion, whether or not the app is in front. */
export function keyWindowId(pid: number): number | null {
  const n = native();
  const app = n.AXCreateApplication(pid) as Ref;
  const window = copyAttribute(app, "AXFocusedWindow");
  const id = window ? windowIdOf(window) : null;
  for (const ref of [window, app]) if (ref) n.CFRelease(ref);
  return id;
}

/**
 * Tell a window it has the focus and is key, without the window server reordering a thing. The records
 * go to the process that owns the window and to nobody else: the app in front is sent nothing, which is
 * the difference between this and the recipe that makes the user's window flicker as it loses the focus.
 */
export function focusWithoutRaise(windowId: number): boolean {
  const s = sky();
  if (!s) return false;
  const [owner, psn] = [new Uint32Array(1), new Uint8Array(8)];
  if (s.windowOwner(s.mainConnection(), windowId, owner) !== 0 || !owner[0] || s.connectionPSN(owner[0], psn) !== 0) return false;
  const record = (fill: (bytes: Uint8Array) => void) => {
    const bytes = new Uint8Array(0xf8);
    bytes[0x04] = 0xf8;
    new DataView(bytes.buffer).setUint32(0x3c, windowId, true);
    fill(bytes);
    return s.postRecord(psn, bytes) === 0;
  };
  const focused = record((bytes) => ((bytes[0x08] = 0x0d), (bytes[0x8a] = 0x01)));
  // Key window, begin and end.
  const key = [0x01, 0x02].map((phase) => record((bytes) => ((bytes[0x3a] = 0x10), bytes.fill(0xff, 0x20, 0x30), (bytes[0x08] = phase))));
  return focused && key.every(Boolean);
}

const POINTER = { moved: 5, down: 1, up: 2, dragged: 6 };

/**
 * A press, a run of drags through every point, a release: addressed to one window of one process. The
 * events never enter the HID stream, so the real cursor does not move and nothing reaches the app in
 * front. Each one carries the window it is for (the window server is not asked to hit-test it) and the
 * point inside that window. A path of one point is a click.
 *
 * An AppKit window takes these whether or not anything covers it. A Chromium page takes them only when
 * it has the focus, hence the records, and only when Chrome thinks the page is visible, which a window
 * covered on every side is not: see revealWindow. The key window the app had before is given back.
 */
export async function windowPointer(target: PointerTarget, path: Point[], options: { count?: number; onMove?: (at: Point) => void } = {}): Promise<void> {
  const [n, s] = [native(), sky()];
  const [start, end] = [path[0], path[path.length - 1]];
  if (!s) throw new Error("this system has no window-addressed pointer (SkyLight's symbols are missing)");
  if (!start || !end) return;
  const keyBefore = target.web ? keyWindowId(target.pid) : null;
  if (target.web && !focusWithoutRaise(target.windowId)) throw new Error("the window would not take the focus");
  if (target.web) await sleep(50);

  const source = n.CGEventSourceCreate(1); // kCGEventSourceStateHIDSystemState
  const gesture = Number(process.hrtime.bigint() % 1_000_000_000n);
  const send = async ([x, y]: Point, type: number, clickState: number, delay: number) => {
    const event = n.CGEventCreateMouse(source, type, x, y, 0);
    s.setWindowLocation(event, x - target.frame[0], y - target.frame[1]);
    // click state, button, subtype, target pid, window number, gesture, window under the pointer, and the one that handles it
    for (const [field, value] of [[1, clickState], [3, 0], [7, 3], [40, target.pid], [51, target.windowId], [58, gesture], [91, target.windowId], [92, target.windowId]] as const) n.CGEventSetInteger(event, field, value);
    // Posted once: AppKit takes the public road, and Chromium needs SkyLight's, which also wakes its activity monitor. Both roads at once arrive twice.
    if (target.web) s.postToPid(target.pid, event);
    else n.CGEventPostToPid(target.pid, event);
    n.CFRelease(event);
    await sleep(delay);
  };
  try {
    await send(start, POINTER.moved, 0, 15); // a window that was never moved over hit-tests the press against stale tracking
    for (let click = 1; click <= (options.count ?? 1); click++) {
      await send(start, POINTER.down, click, path.length > 1 ? 16 : 28);
      let [px, py] = start;
      for (const [x, y] of path.slice(1)) {
        const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / DRAG_STEP_PT));
        for (let i = 1; i <= steps; i++) {
          checkAbort();
          const at: Point = [px + ((x - px) * i) / steps, py + ((y - py) * i) / steps];
          options.onMove?.(at);
          await send(at, POINTER.dragged, click, DRAG_DELAY_MS);
        }
        [px, py] = [x, y];
      }
      if (path.length > 1) await sleep(50); // the page handles the last drag before the release
      await send(end, POINTER.up, click, 80);
    }
  } finally {
    n.CFRelease(source);
    if (keyBefore !== null && keyBefore !== target.windowId) focusWithoutRaise(keyBefore);
  }
}

const SLIVER_PT = 24; // how much of a window has to show for the browser to call its page visible
const GRID_PT = 12;

/**
 * What lies over a window: the frames in front of it. A window that lets any light through covers nothing,
 * which is how an agent's hand, a display-wide sheet of glass right above the window it works in, says so.
 */
const coversOf = (windows: ReturnType<typeof allWindows>, at: number): Frame[] => windows.slice(0, at).filter((c) => c.alpha >= 1).map((c) => c.frame);

/** The patch of a window that nothing covers, if there is one: a grid point on a display, inside the window, under no window in front of it. */
function showing(windowId: number): Point | null {
  const windows = allWindows();
  const at = windows.findIndex((w) => w.id === windowId);
  if (at < 0) return null;
  const [x, y, w, h] = windows[at]!.frame;
  const covers = coversOf(windows, at);
  const inside = ([fx, fy, fw, fh]: Frame, px: number, py: number) => px >= fx && py >= fy && px < fx + fw && py < fy + fh;
  const screens = displays().map((d) => d.frame);
  for (let py = y + GRID_PT; py < y + h; py += GRID_PT) {
    for (let px = x + GRID_PT; px < x + w; px += GRID_PT) {
      const free = (qx: number, qy: number) => screens.some((d) => inside(d, qx, qy)) && !covers.some((c) => inside(c, qx, qy));
      if (free(px, py) && free(px + SLIVER_PT, py) && free(px, py + SLIVER_PT) && free(px + SLIVER_PT, py + SLIVER_PT)) return [px, py];
    }
  }
  return null;
}

/**
 * Make sure some of a window shows, moving it if it has to. A browser stops delivering input to a page
 * it considers hidden, and it considers a page hidden when its window is covered on every side, by
 * anything. A strip at a screen's edge is enough, so the window is slid until a corner of it lies over
 * a spot that no window in front of it covers, the rest of it staying behind them or off the screen.
 * Nothing is raised, and nothing of the user's is moved. False when every screen is covered edge to edge.
 */
export async function revealWindow(pid: number, windowId: number): Promise<boolean> {
  if (showing(windowId)) return true;
  const n = native();
  const windows = allWindows();
  const at = windows.findIndex((w) => w.id === windowId);
  if (at < 0) return false;
  const [, , w, h] = windows[at]!.frame;
  const covers = coversOf(windows, at);
  const inside = ([fx, fy, fw, fh]: Frame, px: number, py: number) => px >= fx && py >= fy && px < fx + fw && py < fy + fh;
  // Free spots, below the menu bar, nearest a side edge first: the window then hangs off the screen rather than lying under the user's.
  const spots: { point: Point; edge: number; left: boolean }[] = [];
  for (const { frame: d } of displays()) {
    for (let py = d[1] + 60; py < d[1] + d[3] - SLIVER_PT; py += GRID_PT) {
      for (let px = d[0]; px < d[0] + d[2] - SLIVER_PT; px += GRID_PT) {
        const free = [[0, 0], [SLIVER_PT, 0], [0, SLIVER_PT], [SLIVER_PT, SLIVER_PT]].every(([dx, dy]) => inside(d, px + dx!, py + dy!) && !covers.some((c) => inside(c, px + dx!, py + dy!)));
        if (free) spots.push({ point: [px, py], edge: Math.min(px - d[0], d[0] + d[2] - px), left: px - d[0] < d[0] + d[2] - px });
      }
    }
  }
  spots.sort((a, b) => a.edge - b.edge);
  const app = n.AXCreateApplication(pid) as Ref;
  const owned: Ref[] = [app];
  try {
    const all = axArray(app, () => n.AXCopyAttribute(app, cfstr("AXWindows"), pointerOut), (ref) => n.CFRetain(ref) as Ref);
    owned.push(...all);
    const window = all.find((candidate) => windowIdOf(candidate) === windowId);
    if (!window) return false;
    for (const { point, left } of spots.filter((_, i) => i % 7 === 0).slice(0, 6)) {
      // The spot goes just inside the window's near side, a little below its top.
      const position = n.AXValueCreate(AX_POINT, new Float64Array([left ? point[0] + SLIVER_PT * 2 - w : point[0] - SLIVER_PT, point[1] - Math.min(120, h / 3)]));
      n.AXSetAttribute(window, cfstr("AXPosition"), position);
      n.CFRelease(position);
      await sleep(400);
      if (showing(windowId)) return true;
    }
    return false;
  } finally {
    for (const ref of owned) n.CFRelease(ref);
  }
}

// ------------------------------------------------------------------ an app that is not in front

const windowIdOf = (window: Ref): number | null => {
  const id = new Uint32Array(1);
  return native().AXGetWindow(window, id) === 0 && id[0] ? id[0] : null;
};

/**
 * The window an app itself considers current, by the window server's id: its focused window, its main
 * one, or its first. That is the app's own notion, and holds whether or not the app is in front.
 */
export function mainWindowId(pid: number): number | null {
  const n = native();
  const app = n.AXCreateApplication(pid) as Ref;
  n.AXSetMessagingTimeout(app, AX_MESSAGE_TIMEOUT * 5);
  const owned: Ref[] = [app];
  try {
    for (const name of ["AXFocusedWindow", "AXMainWindow"]) {
      const window = copyAttribute(app, name);
      if (!window) continue;
      owned.push(window);
      const id = windowIdOf(window);
      if (id !== null) return id;
    }
    const windows = axArray(app, () => n.AXCopyAttribute(app, cfstr("AXWindows"), pointerOut), (ref) => n.CFRetain(ref) as Ref);
    owned.push(...windows);
    return windows.map(windowIdOf).find((id) => id !== null) ?? null;
  } finally {
    for (const ref of owned) n.CFRelease(ref);
  }
}

/** The elements under `root`, breadth first, whose role `wanted` accepts. Bounded: this finds a few containers, it does not list a window. */
function axFind(root: Ref, wanted: (role: string) => boolean, owned: Ref[], cap = 600): Ref[] {
  const n = native();
  const hits: Ref[] = [];
  const queue: Ref[] = [root];
  for (let head = 0; head < queue.length && head < cap; head++) {
    const element = queue[head]!;
    if (wanted(text(axValues(element, ["AXRole"])[0]))) hits.push(element);
    const kids = axArray(element, () => n.AXCopyAttribute(element, cfstr("AXChildren"), pointerOut), (ref) => n.CFRetain(ref) as Ref);
    owned.push(...kids);
    queue.push(...kids);
  }
  return hits;
}

/**
 * A menu command, by the path a person would read off the menu bar: ["File", "New Note"]. A path that
 * ends on a menu lists what is in it instead. The item is pressed where it is, without its menu ever
 * opening, which is why this works on an app that is not in front, and shows nothing on screen.
 */
export function menu(pid: number, path: string[]): { pressed: string } | { items: string[] } {
  const n = native();
  const app = n.AXCreateApplication(pid) as Ref;
  n.AXSetMessagingTimeout(app, AX_MESSAGE_TIMEOUT * 5);
  const owned: Ref[] = [app];
  const kidsOf = (element: Ref) => {
    const kids = axArray(element, () => n.AXCopyAttribute(element, cfstr("AXChildren"), pointerOut), (ref) => n.CFRetain(ref) as Ref);
    owned.push(...kids);
    return kids;
  };
  const roleOf = (element: Ref) => text(axValues(element, ["AXRole"])[0]);
  const titled = (element: Ref) => text(axValues(element, ["AXTitle"])[0]);
  const unavailable = (element: Ref) => {
    const enabled = copyAttribute(element, "AXEnabled");
    const off = enabled !== null && !n.CFBooleanGetValue(enabled);
    if (enabled) n.CFRelease(enabled);
    return off;
  };
  /** An item as the menu shows it: ticked when it is the current choice, and marked when it cannot be chosen now. */
  const shown = (element: Ref) => {
    const title = titled(element);
    return title && `${text(axValues(element, ["AXMenuItemMarkChar"])[0]) ? "✓ " : ""}${title}${unavailable(element) ? " (unavailable)" : ""}`;
  };
  const plain = (title: string) => title.replace(/(\.\.\.|\u2026)$/, "").trim().toLowerCase();
  // A menu bar item and a submenu item each hold one AXMenu, and the items are inside that.
  const itemsOf = (element: Ref) => kidsOf(element).flatMap((kid) => (roleOf(kid) === "AXMenu" ? kidsOf(kid) : [kid]));
  try {
    let at = copyAttribute(app, "AXMenuBar");
    if (!at) throw new Error("this app has no menu bar to press");
    owned.push(at);
    for (const [depth, name] of path.entries()) {
      const items = itemsOf(at);
      const next = items.find((candidate) => plain(titled(candidate)) === plain(name));
      if (!next) throw new Error(`no ${JSON.stringify(name)} in ${depth ? path.slice(0, depth).join(" > ") : "the menu bar"}; it has: ${items.map(titled).filter(Boolean).join(", ")}`);
      at = next;
    }
    const inside = itemsOf(at);
    if (inside.length) return { items: inside.map(shown).filter(Boolean) };
    // A dimmed item takes a press and reports success while doing nothing, which is the one answer that must not be passed on.
    if (unavailable(at)) throw new Error(`${path.join(" > ")} is unavailable right now. An app dims commands that have nothing to act on: put its cursor or selection where the command applies first.`);
    if (n.AXPerformAction(at, cfstr(AX_PRESS)) !== 0) throw new Error(`${path.join(" > ")} did not accept the press`);
    return { pressed: path.join(" > ") };
  } finally {
    for (const ref of owned) n.CFRelease(ref);
  }
}

/** Page a window's largest scroll area, the way AppKit lists and text views offer. False when nothing in the window takes it. */
export function scrollPage(pid: number, windowId: number, direction: "up" | "down" | "left" | "right"): boolean {
  const n = native();
  const app = n.AXCreateApplication(pid) as Ref;
  n.AXSetMessagingTimeout(app, AX_MESSAGE_TIMEOUT * 5);
  const owned: Ref[] = [app];
  try {
    const windows = axArray(app, () => n.AXCopyAttribute(app, cfstr("AXWindows"), pointerOut), (ref) => n.CFRetain(ref) as Ref);
    owned.push(...windows);
    const window = windows.find((candidate) => windowIdOf(candidate) === windowId);
    if (!window) return false;
    const action = `AXScroll${direction[0]!.toUpperCase()}${direction.slice(1)}ByPage`;
    const area = (element: Ref) => {
      const size = axValues(element, ["AXSize"])[0];
      return Array.isArray(size) ? size[0] * size[1] : 0;
    };
    const areas = axFind(window, (role) => role === "AXScrollArea", owned).sort((a, b) => area(b) - area(a));
    return areas.some((element) => n.AXPerformAction(element, cfstr(action)) === 0);
  } finally {
    for (const ref of owned) n.CFRelease(ref);
  }
}

// ------------------------------------------------------------------ actionable elements

export const AX_ACTIONABLE_ROLES = new Set([
  "AXButton", "AXCell", "AXCheckBox", "AXComboBox", "AXDisclosureTriangle", "AXImage", "AXIncrementor", "AXLink",
  "AXMenuBarItem", "AXMenuButton", "AXPopUpButton", "AXRadioButton", "AXRow", "AXSearchField", "AXSlider", "AXTab",
  "AXTextArea", "AXTextField",
]); // prettier-ignore
// A bare child, usually a decorative AXImage, borrows the label of a parent that is itself a control.
export const AX_LABEL_PARENT_ROLES = new Set([
  "AXButton", "AXCell", "AXCheckBox", "AXLink", "AXMenuButton", "AXPopUpButton", "AXRadioButton", "AXRow", "AXTab",
]); // prettier-ignore
// List containers keep their label in a shallow AXStaticText rather than on themselves.
export const AX_LABEL_DESCENDANT_ROLES = new Set(["AXCell", "AXRow"]);
export const AX_SKIP_SUBTREE_ROLES = new Set(["AXMenu"]); // a closed menu: thousands of zero-sized items, none on screen
export const AX_NODE_CAP = 4000;
export const AX_TIME_CAP = 0.6;
export const AX_OFFSCREEN_CAP = 120; // off-screen controls collected before the walk stops looking for more
export const AX_MIN_SIDE_PT = 4.0; // anything thinner is a Chromium sliver for a scrolled-out node
export const AX_MESSAGE_TIMEOUT = 0.2;
export const AX_FANOUT = 8; // children scanned per level when recovering a label
export const AX_VALUE_CHARS = 120;

export interface AxAttrs {
  role: string;
  label: string;
  frame: Frame | null;
}

/**
 * True when a real frame lies wholly outside the display: a note list thousands of screens down,
 * or a web node the browser parked above the viewport. A zero-size frame claims nothing, which is
 * what an application element and a closed menu report, so their subtrees are still worth a look.
 */
export function offDisplay(frame: Frame | null, display: Frame): boolean {
  if (!frame) return false;
  const [x, y, w, h] = frame;
  if (w <= 0 || h <= 0) return false;
  const [dx, dy, dw, dh] = display;
  return x >= dx + dw || y >= dy + dh || x + w <= dx || y + h <= dy;
}

/**
 * Identity of a node for de-duplication: same role, label and frame is the same control, whatever
 * object the bridge wrapped it in. Frameless, zero-size and nameless nodes are containers and are
 * never keyed: layout boxes nest with one frame (Calculator wraps its keypad in three), and a box
 * taken for a repeat of the one around it would take the controls inside down with it.
 */
export function subtreeKey(role: string, label: string, frame: Frame | null): string | null {
  if (!label || !frame || frame[2] <= 0 || frame[3] <= 0) return null;
  return JSON.stringify([role, label, ...frame.map(Math.round)]);
}

export const clickable = (frame: Frame | null): boolean => frame !== null && Math.min(frame[2], frame[3]) >= AX_MIN_SIDE_PT;

/** The first static text within two levels, which is where list rows hide their label. */
export function descendantLabel<T>(kids: T[], children: (node: T) => Iterable<T>, attrs: (node: T) => AxAttrs): string {
  for (const kid of kids.slice(0, AX_FANOUT)) {
    const { role, label } = attrs(kid);
    if (role === "AXStaticText" && label) return label;
  }
  for (const kid of kids.slice(0, AX_FANOUT)) {
    for (const grandkid of [...children(kid)].slice(0, AX_FANOUT)) {
      const { role, label } = attrs(grandkid);
      if (role === "AXStaticText" && label) return label;
    }
  }
  return "";
}

export interface WalkOptions<T> {
  nodeCap?: number;
  timeCap?: number;
  offscreenCap?: number;
  clock?: () => number; // seconds
  /** False for a node already walked. Two fetches of one control are different objects, so the platform decides. */
  firstVisit?: (node: T) => boolean;
}

/**
 * Breadth-first hunt for labelled controls: the on-screen ones, the reachable off-screen ones,
 * and whether a cap cut the walk short.
 *
 * The callables are the only way into the tree, so the pruning rules are platform-free
 * and testable against a plain object. The caps are the point: an unbounded walk of a note list
 * or a long web page costs seconds and finds nothing on screen.
 *
 * A node that misses the display, or that the app clamped to a sliver, is not on screen and is
 * not offered as one: its subtree stays pruned from `found`. But AXPress does not need a node to
 * be visible, so a labelled one that accepts the action is collected separately, down to
 * `offscreenCap`, after which those subtrees are dropped again and the walk is the old one.
 */
export function walkActionable<T>(
  root: T,
  children: (node: T) => Iterable<T>,
  attrs: (node: T) => AxAttrs,
  actions: (node: T) => Iterable<string>,
  display: Frame,
  options: WalkOptions<T> = {},
): [found: AxNode[], offscreen: AxNode[], capped: boolean] {
  const { nodeCap = AX_NODE_CAP, timeCap = AX_TIME_CAP, offscreenCap = AX_OFFSCREEN_CAP } = options;
  const clock = options.clock ?? (() => performance.now() / 1000);
  const visited = new Set<T>(); // a self-listing app is walked once
  const firstVisit = options.firstVisit ?? ((node: T) => !visited.has(node) && (visited.add(node), true));
  const found: AxNode[] = [];
  const offscreen: AxNode[] = [];
  const deadline = clock() + timeCap;
  const queue: [node: T, parentLabel: string, parentEmitted: boolean, hidden: boolean][] = [[root, "", false, false]];
  const visitedKeys = new Set<string>(); // and a control handed over as several distinct objects is kept once
  const emittedKeys = new Set<string>(); // including one that borrowed its label, which the key above cannot know yet
  let seen = 0;
  for (let head = 0; head < queue.length; head++) {
    if (seen >= nodeCap || clock() >= deadline) return [found, offscreen, true];
    const [node, parentLabel, parentEmitted, parentHidden] = queue[head]!;
    if (!firstVisit(node)) continue;
    seen += 1;
    const { role, label: ownLabel, frame } = attrs(node);
    if (AX_SKIP_SUBTREE_ROLES.has(role)) continue;
    const key = subtreeKey(role, ownLabel, frame);
    if (key !== null) {
      if (visitedKeys.has(key)) continue;
      visitedKeys.add(key);
    }
    const hidden = parentHidden || offDisplay(frame, display);
    if (hidden && offscreen.length >= offscreenCap) continue; // nothing left to collect down there, and it never counted on screen
    const kids = [...children(node)];
    let [label, inherited] = [ownLabel, false];
    if (!label && AX_LABEL_DESCENDANT_ROLES.has(role)) label = descendantLabel(kids, children, attrs);
    if (!label && parentLabel) [label, inherited] = [parentLabel, true];
    let emitted = false;
    const duplicate = inherited && parentEmitted; // the parent already stands for this label
    const namelessGroup = role === "AXGroup" && !ownLabel; // a Chromium layout box, not a control
    const visible = !hidden && clickable(frame);
    const emitKey = subtreeKey(role, label, frame);
    const repeated = !ownLabel && emitKey !== null && emittedKeys.has(emitKey);
    if (label && !duplicate && !namelessGroup && !repeated && frame) {
      const [x, y, w, h] = frame;
      if (visible) {
        const pressable = [...actions(node)].includes(AX_PRESS);
        if (pressable || AX_ACTIONABLE_ROLES.has(role)) {
          found.push({ role, label, x, y, w, h, pressable, ref: node });
          emitted = true;
        }
      } else if (offscreen.length < offscreenCap && [...actions(node)].includes(AX_PRESS)) {
        offscreen.push({ role, label, x, y, w, h, pressable: true, ref: node });
      }
      if (emitKey !== null) emittedKeys.add(emitKey);
    }
    const childLabel = AX_LABEL_PARENT_ROLES.has(role) ? ownLabel : "";
    for (const kid of kids) queue.push([kid, childLabel, emitted, hidden]);
  }
  return [found, offscreen, false];
}

const oneLine = (value: string): string => value.split(/\s+/).filter(Boolean).join(" ");

/** AXTitle on AppKit, AXDescription on web and Electron, a short AXValue as a last resort. */
function axAttrs(element: Ref): AxAttrs {
  const [role, title, description, value, position, size] = axValues(element, ["AXRole", "AXTitle", "AXDescription", "AXValue", "AXPosition", "AXSize"]);
  const [at, extent] = [pairOf(position), pairOf(size)];
  const short = text(value).trim();
  const label = oneLine(text(title)) || oneLine(text(description)) || (short.length <= AX_VALUE_CHARS ? oneLine(short) : "");
  return { role: text(role), label, frame: at && extent ? [...at, ...extent] : null };
}

/** An array attribute's members. Elements come back retained, for the caller to release. */
function axArray<T>(element: Ref, fetch: () => number, member: (ref: Ref) => T): T[] {
  const n = native();
  pointerOut[0] = 0n;
  const err = fetch();
  const array = pointerOut[0];
  if (err !== 0 || !array) return [];
  const out = Array.from({ length: Number(n.CFArrayGetCount(array)) }, (_, i) => member(n.CFArrayGetValueAtIndex(array, i)));
  n.CFRelease(array);
  return out;
}

/**
 * Labelled controls of one process: the on-screen ones in points, the pressable off-screen ones,
 * and whether a cap cut the walk short. `display` is the captured display's frame in global points.
 */
export function actionableElements(pid: number, display: Frame, options: WalkOptions<Ref> & { windowId?: number } = {}): [AxNode[], AxNode[], boolean] {
  const n = native();
  const app = n.AXCreateApplication(pid) as Ref;
  n.AXSetMessagingTimeout(app, AX_MESSAGE_TIMEOUT);
  const owned: Ref[] = [app];
  // The app's children are all of its windows, and one stacked behind the front one is on the display
  // by its frame while nothing of it shows: its controls would be offered, and a press would land in a
  // window the user cannot see. So the walk takes the focused window and the menu bar, as OCR does.
  // A window named by id is walked alone, wherever it sits in the stack: that is how a window behind the user's is read.
  const { windowId, ...walk } = options;
  const front =
    windowId === undefined
      ? [copyAttribute(app, "AXFocusedWindow") ?? copyAttribute(app, "AXMainWindow"), copyAttribute(app, "AXMenuBar")].filter((ref) => ref !== null)
      : axArray(app, () => n.AXCopyAttribute(app, cfstr("AXWindows"), pointerOut), (ref) => n.CFRetain(ref) as Ref);
  owned.push(...front);
  const id = new Uint32Array(1);
  const roots = windowId === undefined ? (front.length === 2 ? front : null) : front.filter((window) => n.AXGetWindow(window, id) === 0 && id[0] === windowId);
  const children = (element: Ref) => {
    if (element === app && roots) return roots;
    const kids = axArray(element, () => n.AXCopyAttribute(element, cfstr("AXChildren"), pointerOut), (ref) => n.CFRetain(ref) as Ref);
    for (const kid of kids) owned.push(kid);
    return kids;
  };
  const actions = (element: Ref) => axArray(element, () => n.AXCopyActionNames(element, pointerOut), jsString);
  // The bridge hands one control over as many objects, so identity is CFEqual, bucketed by CFHash.
  const buckets = new Map<bigint, Ref[]>();
  const firstVisit = (element: Ref) => {
    const hash = BigInt(n.CFHash(element));
    const bucket = buckets.get(hash) ?? (buckets.set(hash, []), buckets.get(hash)!);
    if (bucket.some((other) => n.CFEqual(other, element))) return false;
    bucket.push(element);
    return true;
  };
  try {
    const result = walkActionable(app, children, axAttrs, actions, display, { firstVisit, ...walk });
    for (const node of [...result[0], ...result[1]]) keep(node.ref as Ref);
    return result;
  } finally {
    for (const ref of owned) if (!live.has(BigInt(ref))) n.CFRelease(ref);
  }
}
