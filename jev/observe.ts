// observe.ts — what a hand's screen holds, as text Jev can choose from.
//
// Jev cannot see pixels, and it is weak with raw numbers. So each step we read
// the accessibility tree (AT-SPI) of the apps inside the hand and hand Jev a
// list of labels: `e7: button "Send" (top right, in "New Message")`. Jev picks
// a label. The rectangle behind the label never leaves this program.
//
//   observe(hand)            elements + readable text + a fingerprint
//   describeElement(el)      the words Jev reads for one element
//   withVisionElements(...)  add elements a vision planner saw (planner.ts)
//
// This is free and takes no model call, which is why the core loop can run on
// it and keep the vision model for when Jev is stuck. When the tree is empty
// (an app that exposes nothing), that is one of the ways to be stuck.
//
// CLI: bun jev/observe.ts <id>        print what Jev would be offered
//
// Requires: python-gobject at-spi2-core   (pacman -S python-gobject at-spi2-core)

import { join } from "node:path";
import { defaultExec, getHand, type Exec, type Hand } from "../desktop";

// ---------------------------------------------------------------- types

export type Rect = { x: number; y: number; w: number; h: number };

export type UiElement = {
  /** Label Jev picks, "e1".."eN". Only valid within one Observation. */
  id: string;
  source: "atspi" | "vision";
  role: string;
  name: string;
  /** Current content of a text field. Never read for password fields. */
  value: string;
  editable: boolean;
  focused: boolean;
  /** Nearest named container, e.g. a dialog or toolbar. */
  within: string;
  /** Title of the window it belongs to. */
  frame: string;
  /** Position on the hand's screen, in pixels. */
  rect: Rect;
  /** A native dropdown's choices, when the observer can read them. screen.ts sets one without opening it. */
  options?: string[];
};

export type Observation = {
  elements: UiElement[];
  /** Headings, labels and other text on screen, for context. Untrusted. */
  texts: string[];
  /** Titles of the open windows, active one first. */
  frames: string[];
  /** Changes when the screen changes. Compared before and after an action. */
  fingerprint: string;
};

type RawElement = {
  role: string;
  name: string;
  description: string;
  value: string;
  editable: boolean;
  focused: boolean;
  enabled: boolean;
  pid: number;
  frame: string;
  within: string;
  x: number;
  y: number;
  w: number;
  h: number;
};
type RawDump = { elements: RawElement[]; texts: string[]; frames: { name: string; pid: number; active: boolean }[] };
type SwayWindow = { pid: number; name: string; focused: boolean; x: number; y: number };

// ---------------------------------------------------------------- config

const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
/** System python: that is where python-gobject installs, not a conda or venv python. */
const PYTHON = process.env.PUK_PYTHON ?? "/usr/bin/python3";
const DUMP_SCRIPT = join(import.meta.dir, "atspi_dump.py");

/** Jev's accuracy drops as the list grows with things unrelated to the decision. */
export const MAX_ELEMENTS = 150;
const MAX_TEXTS = 40;

const ROLE_WORDS: Record<string, string> = {
  "push button": "button",
  "toggle button": "toggle button",
  "check box": "checkbox",
  "radio button": "radio button",
  "check menu item": "menu item",
  "radio menu item": "menu item",
  entry: "text field",
  text: "text field",
  "password text": "password field",
  "combo box": "dropdown",
  "spin button": "number field",
  "page tab": "tab",
  "table cell": "cell",
};

// ---------------------------------------------------------------- words

/** Where on the screen, in words. Jev reads "top right" better than "1180, 40". */
export function regionOf(rect: Rect, screen: { width: number; height: number }): string {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const col = cx < screen.width / 3 ? "left" : cx < (screen.width * 2) / 3 ? "center" : "right";
  const row = cy < screen.height / 3 ? "top" : cy < (screen.height * 2) / 3 ? "middle" : "bottom";
  return row === "middle" && col === "center" ? "center" : `${row} ${col}`;
}

/** The words Jev reads for one element. */
export function describeElement(el: UiElement, screen: { width: number; height: number }): string {
  const parts = [el.role, el.name ? JSON.stringify(el.name) : "(no name)"];
  if (el.editable) parts.push(el.value ? `containing ${JSON.stringify(el.value)}` : "empty");
  if (el.focused) parts.push("focused");
  const where = [regionOf(el.rect, screen)];
  if (el.within && el.within !== el.name) where.push(`in ${JSON.stringify(el.within)}`);
  return `${parts.join(" ")} (${where.join(", ")})`;
}

export function centerOf(rect: Rect): { x: number; y: number } {
  return { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) };
}

// ---------------------------------------------------------------- sway tree

/** Where the nested sway listens for IPC. Sway derives it from its uid and pid. */
function swaySocket(hand: Hand): string {
  return join(RUNTIME_DIR, `sway-ipc.${process.getuid?.() ?? 1000}.${hand.pid}.sock`);
}

/** Leaf windows of a `swaymsg -t get_tree` result. Exported for tests. */
export function swayWindows(tree: unknown): SwayWindow[] {
  const found: SwayWindow[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.pid === "number" && node.rect) {
      found.push({
        pid: node.pid,
        name: String(node.name ?? ""),
        focused: Boolean(node.focused),
        x: node.rect.x + (node.window_rect?.x ?? 0),
        y: node.rect.y + (node.window_rect?.y ?? 0),
      });
    }
    for (const child of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) visit(child);
  };
  visit(tree);
  return found;
}

/** The window an element lives in: same process, then same title, then the focused one. */
function windowFor(el: RawElement, windows: SwayWindow[]): SwayWindow | undefined {
  const mine = windows.filter((w) => w.pid === el.pid);
  return mine.find((w) => w.name === el.frame) ?? mine.find((w) => w.focused) ?? mine[0];
}

// ---------------------------------------------------------------- build

/** Turn a raw dump into an Observation. Pure, exported for tests. */
export function buildObservation(dump: RawDump, windows: SwayWindow[], hand: Hand): Observation {
  const seen = new Set<string>();
  const kept: Omit<UiElement, "id">[] = [];
  for (const raw of dump.elements) {
    if (!raw.enabled) continue;
    const name = raw.name || raw.description;
    if (!name && !raw.editable) continue; // nothing Jev could tell it apart by
    const win = windowFor(raw, windows);
    const rect = { x: raw.x + (win?.x ?? 0), y: raw.y + (win?.y ?? 0), w: raw.w, h: raw.h };
    const c = centerOf(rect);
    if (c.x < 0 || c.y < 0 || c.x >= hand.width || c.y >= hand.height) continue;
    const key = `${raw.role}|${name}|${rect.x}|${rect.y}|${rect.w}|${rect.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({
      source: "atspi",
      role: ROLE_WORDS[raw.role] ?? raw.role,
      name: name.slice(0, 120),
      value: raw.value,
      editable: raw.editable,
      focused: raw.focused,
      within: raw.within,
      frame: raw.frame,
      rect,
    });
  }
  kept.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x); // reading order
  const elements = kept.slice(0, MAX_ELEMENTS).map((el, i) => ({ ...el, id: `e${i + 1}` }));
  const texts = [...new Set(dump.texts)].slice(0, MAX_TEXTS);
  const frames = [...dump.frames].sort((a, b) => Number(b.active) - Number(a.active)).map((f) => f.name);
  return { elements, texts, frames, fingerprint: fingerprintOf(elements, texts) };
}

function fingerprintOf(elements: UiElement[], texts: string[]): string {
  const stable = elements.map((e) => [e.role, e.name, e.value, e.focused, e.rect.x, e.rect.y, e.rect.w, e.rect.h]);
  return Bun.hash(JSON.stringify([stable, texts])).toString(36);
}

/**
 * Add elements a vision planner saw. They only describe the screen they were
 * seen on, so the caller drops them once the fingerprint changes.
 */
export function withVisionElements(
  obs: Observation,
  seen: { role: string; name: string; rect: Rect }[],
  hand: Hand,
): Observation {
  const extra: UiElement[] = [];
  for (const v of seen) {
    const c = centerOf(v.rect);
    if (!v.name || v.rect.w <= 0 || v.rect.h <= 0) continue;
    if (c.x < 0 || c.y < 0 || c.x >= hand.width || c.y >= hand.height) continue;
    const known = obs.elements.some((e) => {
      const ec = centerOf(e.rect);
      return Math.abs(ec.x - c.x) < 12 && Math.abs(ec.y - c.y) < 12;
    });
    if (known) continue;
    extra.push({
      id: `v${extra.length + 1}`,
      source: "vision",
      role: v.role || "element",
      name: v.name.slice(0, 120),
      value: "",
      editable: /field|input|box|area/i.test(v.role),
      focused: false,
      within: "",
      frame: "",
      rect: v.rect,
    });
  }
  // The fingerprint stays that of the real screen, so staleness is still detected.
  return { ...obs, elements: [...obs.elements, ...extra].slice(0, MAX_ELEMENTS) };
}

// ---------------------------------------------------------------- observe

export async function observe(hand: Hand, exec: Exec = defaultExec): Promise<Observation> {
  const dumped = await exec([PYTHON, DUMP_SCRIPT, hand.display]);
  if (dumped.exitCode !== 0) {
    const hint = /No module named 'gi'|Namespace Atspi/.test(dumped.stderr)
      ? "\nInstall it with: sudo pacman -S python-gobject at-spi2-core"
      : "";
    throw new Error(`could not read the accessibility tree: ${dumped.stderr.trim().split("\n").pop()}${hint}`);
  }
  const dump = JSON.parse(new TextDecoder().decode(dumped.stdout)) as RawDump;

  // Window positions. A hand usually shows one borderless window at 0,0, so a
  // missing swaymsg costs accuracy only when windows are split or floating.
  let windows: SwayWindow[] = [];
  try {
    const tree = await exec(["swaymsg", "-s", swaySocket(hand), "-r", "-t", "get_tree"]);
    if (tree.exitCode === 0) windows = swayWindows(JSON.parse(new TextDecoder().decode(tree.stdout)));
  } catch {
    // positions fall back to window-relative
  }
  return buildObservation(dump, windows, hand);
}

// ---------------------------------------------------------------- CLI

if (import.meta.main) {
  (async () => {
    const id = Number(process.argv[2]);
    const hand = Number.isInteger(id) ? await getHand(id) : null;
    if (!hand) throw new Error("usage: bun jev/observe.ts <id>   (see: bun desktop.ts ls)");
    const obs = await observe(hand);
    console.log(`windows: ${obs.frames.join(" | ") || "(none)"}   fingerprint ${obs.fingerprint}`);
    for (const el of obs.elements) console.log(`${el.id}\t${describeElement(el, hand)}`);
    if (!obs.elements.length) console.log("no elements: is accessibility on? see docs/omarchy-setup.md");
    console.log(`\n${obs.texts.length} texts:`);
    for (const t of obs.texts) console.log(`  ${t}`);
  })().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
