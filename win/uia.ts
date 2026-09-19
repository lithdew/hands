/**
 * What win/observe.ts is for the hand's browser, for every other window: the controls as labelled
 * elements Jev can pick from, and actions that need neither the pointer nor the focus.
 *
 * The browser taught three things, and UI Automation has all three:
 *   one read of the whole screen      the DOM in one DevTools call       the subtree in one cached request (5 to 450 ms)
 *   words, container, state, order    role, name, form, value            control type, name, nearest named group, value
 *   input that needs no focus         DevTools Input.*                   patterns: Invoke, Toggle, Select, Expand, SetValue
 *
 * Measured on Windows 11 (win/uia.probe.ts, on a desktop nobody is looking at): asked through its
 * top-level handle, a hidden window's tree stops at the title bar, which is why this was once written
 * off (Paint: 7 nodes). Its content's own child windows still answer (Paint: 57 controls, with every
 * colour by name; Character Map: 345; SetValue lands in 48 ms), so win/uia.cs reads those too.
 * UWP applications (Calculator, Settings, Clock) looked closed for another reason: Windows SUSPENDS
 * them within seconds of being on a desktop nobody looks at (every thread "Suspended"), and a frozen
 * process serves one node, reads no keys and reacts to no click. `awake` in win/uia.cs is the switch
 * debuggers use to keep a package running. With it, the hidden Calculator reads as 33 controls in
 * 56 ms and takes One, Two, Multiply by, Three, One, Equals at 2 to 11 ms a press: "Display is 372".
 * The package is handed back to Windows when the hand closes (`releaseNative`).
 */
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { debugLog, type Hand } from "../desktop";
import type { Observation, UiElement } from "../jev/observe";
import type { ScreenAction } from "../jev/screen";
import { createHelper, frontOf, helper } from "./desktop";

// ---------------------------------------------------------------- types

export type NativeNode = { n: number; role: string; name: string; value: string; within: string; editable: boolean; setValue: boolean; focused: boolean; enabled: boolean; can: "" | "invoke" | "toggle" | "select" | "expand"; rect: [number, number, number, number] };
export type NativeDump = { elements: NativeNode[]; texts: string[]; frame: [number, number, number, number]; seen: number; ms: number };

/** Fewer controls than this and Jev has nothing to work with: a UWP window, a game, a canvas. */
export const READABLE = 5;
const OUT = join(import.meta.dir, "..", "out", "win"), SOURCE = join(import.meta.dir, "uia.cs");
const ROLES: Record<string, string> = { edit: "text field", document: "text field", "check box": "checkbox", "combo box": "dropdown", hyperlink: "link", "tab item": "tab" };

// ---------------------------------------------------------------- helper

const windowsPath = async (path: string) => (await new Response(Bun.spawn(["wslpath", "-w", path], { stdout: "pipe" }).stdout).text()).trim();

/** Build win/uia.cs with the C# compiler that ships in Windows. Named after its source: a running .exe is locked. */
export async function ensureUia(): Promise<string> {
  const exe = join(OUT, `puk-uia-${Bun.hash(await Bun.file(SOURCE).text()).toString(16).slice(0, 10)}.exe`);
  if (await stat(exe).then(() => true, () => false)) return exe;
  await mkdir(OUT, { recursive: true });
  for (const old of new Bun.Glob("puk-uia-*.exe").scanSync(OUT)) await rm(join(OUT, old)).catch(() => { /* still running */ });
  const framework = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319";
  const build = Bun.spawn(["/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe", "/nologo", "/optimize", "/platform:x64", "/nowarn:0168,0649,0169", "/main:PukUia", `/out:${await windowsPath(exe)}`,
    `/lib:${framework}\\WPF`, "/r:UIAutomationClient.dll", "/r:UIAutomationTypes.dll", "/r:WindowsBase.dll", await windowsPath(SOURCE)], { stdout: "pipe", stderr: "pipe" });
  if ((await build.exited) !== 0) throw new Error(`The UI Automation helper did not build: ${(await new Response(build.stdout).text()).slice(0, 400)}`);
  return exe;
}

let shared: Promise<ReturnType<typeof createHelper>> | undefined;
const uia = () => shared ??= ensureUia().then(createHelper);

// ---------------------------------------------------------------- observe

/** Pure: a dump of one window as the Observation jev/screen.ts reads. Ids are `n<k>`: the helper's index, which is also what `performNative` sends back. */
export function nativeObservation(dump: NativeDump, title: string): Observation {
  const elements: UiElement[] = dump.elements.filter((e) => e.enabled).map((e) => ({
    id: `n${e.n}`, source: "atspi", role: ROLES[e.role.toLowerCase()] ?? e.role.toLowerCase(), name: e.name, value: e.value, editable: e.editable && e.setValue, focused: e.focused,
    within: e.within === title ? "title bar" : e.within, frame: title, rect: { x: e.rect[0], y: e.rect[1], w: Math.max(1, e.rect[2]), h: Math.max(1, e.rect[3]) },
  }));
  const seen = JSON.stringify([title, elements.map((e) => [e.role, e.name, e.value, e.focused]), dump.texts]);
  return { elements, texts: [`window: ${title}`, ...dump.texts], frames: [title], fingerprint: `native:${Bun.hash(seen).toString(16)}` };
}

/** Windows this process keeps awake, by hand, so they can be given back. */
const awake = new Map<number, Set<number>>();
const WAKE_MS = 900;

/** Give every application this hand kept awake back to Windows' lifetime manager. */
export async function releaseNative(hand: Hand): Promise<void> {
  for (const hwnd of awake.get(hand.id) ?? []) await (await uia()).ask(`asleep ${hwnd}`).catch(() => {});
  awake.delete(hand.id);
}

/** How each element of the last look is operated. Kept here, not on the element: Jev has no use for it. */
const operable = new Map<number, { hwnd: number; nodes: Map<string, NativeNode> }>();

/** The hand's front window for Jev, or no elements when it cannot be read (then jev/screen.ts asks for help, as before). */
export async function observeNative(hand: Hand): Promise<Observation> {
  const front = await frontOf(hand);
  if (!front) return { elements: [], texts: [], frames: [], fingerprint: "native:none" };
  const started = performance.now(), read = async () => JSON.parse(await (await uia()).ask(`tree ${front.containerId}`)) as NativeDump;
  let dump = await read();
  // Nothing to read may mean a UWP application Windows has frozen. Woken once, it answers.
  if (dump.elements.length < READABLE && !awake.get(hand.id)?.has(front.containerId)) {
    const reply = await (await uia()).ask(`awake ${front.containerId}`).catch(() => "none");
    if (reply.startsWith("ok")) {
      awake.set(hand.id, (awake.get(hand.id) ?? new Set()).add(front.containerId));
      await Bun.sleep(WAKE_MS);
      dump = await read();
      debugLog("win.uia", { hand: hand.id, window: front.title, woke: reply.slice(3), controls: dump.elements.length });
    }
  }
  debugLog("win.uia", { hand: hand.id, window: front.title, controls: dump.elements.length, nodes: dump.seen, ms: Math.round(performance.now() - started), inside: dump.ms });
  operable.set(hand.id, { hwnd: front.containerId, nodes: new Map(dump.elements.map((e) => [`n${e.n}`, e])) });
  if (dump.elements.length < READABLE) return { elements: [], texts: [], frames: [front.title], fingerprint: `native:${front.title}` };
  return nativeObservation(dump, front.title);
}

// ---------------------------------------------------------------- act

/** Pure: the helper request for an action, or why it cannot be done without the pointer. Exported for tests. */
export function nativeRequest(hwnd: number, node: NativeNode | undefined, action: ScreenAction): string {
  if (!node) throw new Error("That control is no longer there.");
  if (action.kind === "type") {
    if (!node.setValue) throw new Error(`"${node.name}" cannot be typed into in the background.`);
    return `set ${hwnd} ${node.n} ${action.text ? Buffer.from(action.text).toString("base64") : "-"}`;
  }
  if (action.kind === "click" && action.button === "left" && node.can) return `act ${hwnd} ${node.n} ${node.can}`;
  throw new Error(`"${node.name}" cannot be ${action.kind === "click" ? "pressed" : "used"} in the background.`);
}

/** True when this action aims at a native control of the hand's last look. win/jev.ts sends everything else to the browser's input. */
export const isNative = (action: ScreenAction) => "target" in action && Boolean(action.target?.id.startsWith("n"));

let lastSeen: { where: string; fg: string; when: number } | undefined;
const FRESH_MS = 1200;

/** Pure: did an action on a hidden window pull the user along? Exported for tests. */
export function pulledUser(before: { where: string; fg: string }, after: { where: string; fg: string }, reply: string, stale = false): boolean {
  // "took-focus" is measured inside the helper, around the one call: that is the action's doing. A desktop that differs
  // from a note taken a moment earlier may be the user's own doing, and they are not to be dragged back.
  return (reply.includes("took-focus") && after.fg !== before.fg) || (!stale && after.where !== before.where);
}

export async function performNative(hand: Hand, action: ScreenAction): Promise<void> {
  const look = operable.get(hand.id), id = "target" in action ? action.target?.id : undefined;
  if (!look || !id) throw new Error("Nothing of this window has been read yet.");
  // A hand never takes the user's screen. Patterns are not supposed to need the focus, but some controls take it
  // anyway (measured: SetValue on a classic edit control), and Windows then switches to the hand's desktop. So the
  // user's desktop and focus are noted before every action and put back at once if the action moved them.
  const ask = (await helper()).ask, at = async () => ({ where: await ask("where"), fg: await ask("fg"), when: performance.now() });
  // Between two keys of a run the check after one is the check before the next.
  const stale = Boolean(lastSeen && performance.now() - lastSeen.when < FRESH_MS), before = stale ? lastSeen! : await at();
  const reply = await (await uia()).ask(nativeRequest(look.hwnd, look.nodes.get(id), action));
  const after = await at(), pulled = pulledUser(before, after, reply, stale);
  if (pulled) { await ask(`goto ${JSON.parse(before.where) as string}`).catch(() => {}); await ask(`focus ${before.fg}`).catch(() => {}); }
  lastSeen = pulled ? undefined : after;
  debugLog("win.uia.act", { hand: hand.id, id, reply, pulled });
}
