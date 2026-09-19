import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as macos from "../src/macos.ts";
import { type AxAttrs, type WalkOptions, walkActionable } from "../src/macos.ts";
import type { AxNode, Frame } from "../src/models.ts";
import { axItems, type Line, perceive } from "../src/perception.ts";
import { guardMachine, screen } from "./helpers.ts";

beforeEach(guardMachine);
afterEach(() => mock.restore());

const DISPLAY: Frame = [0, 0, 1728, 1117];

interface Node {
  role: string;
  label: string;
  frame: Frame | null;
  press: boolean;
  children: Node[];
}

const node = (role: string, label = "", { frame = [10, 10, 100, 20] as Frame | null, press = false, children = [] as Node[] } = {}): Node => ({
  role,
  label,
  frame,
  press,
  children,
});

const walk = (root: Node, options: WalkOptions<Node> = {}) =>
  walkActionable(
    root,
    (n) => n.children,
    (n) => ({ role: n.role, label: n.label, frame: n.frame }),
    (n) => (n.press ? ["AXPress"] : []),
    DISPLAY,
    options,
  );

const labels = (root: Node, options: WalkOptions<Node> = {}) => walk(root, options)[0].map((n) => n.label);

const offscreen = (root: Node) => walk(root)[1].map((n) => [n.role, n.label]);

/** An application element reports a zero-size frame at the bottom of the display, not a real one. */
const app = (...children: Node[]) => node("AXApplication", "Finder", { frame: [0, 1117, 0, 0], children });

/** A tree of names, for the walks where several objects stand for one control. */
const walkNames = (tree: Record<string, string[]>, attrs: (name: string) => AxAttrs) =>
  walkActionable<string>("app", (n) => tree[n]!, attrs, () => ["AXPress"], [0, 0, 1000, 800]);

test("keeps labelled controls and reports no cap", () => {
  const [found, , capped] = walk(app(node("AXButton", "Share"), node("AXLink", "Pricing", { frame: [0, 40, 60, 16] })));
  expect(found.map((n) => [n.role, n.label, n.x, n.w])).toEqual([
    ["AXButton", "Share", 10, 100],
    ["AXLink", "Pricing", 0, 60],
  ]);
  expect(capped).toBe(false);
});

test("a frameless root does not prune the whole tree", () => {
  expect(labels(node("AXApplication", "Finder", { frame: null, children: [node("AXButton", "Share")] }))).toEqual(["Share"]);
});

test("drops unlabelled controls", () => {
  expect(labels(app(node("AXButton", "")))).toEqual([]);
});

test("skips nameless group even when pressable", () => {
  const tree = app(node("AXGroup", "", { press: true }), node("AXGroup", "Toolbar", { press: true }));
  expect(labels(tree)).toEqual(["Toolbar"]);
});

test("press action makes an unlisted role actionable", () => {
  expect(labels(app(node("AXStaticText", "Sign in", { press: true })))).toEqual(["Sign in"]);
  expect(labels(app(node("AXStaticText", "Sign in")))).toEqual([]);
});

test("prunes slivers and offscreen frames", () => {
  const tree = app(
    node("AXLink", "clamped", { frame: [100, 125, 72, 1] }),
    node("AXLink", "narrow", { frame: [100, 125, 2, 30] }),
    node("AXLink", "below the display", { frame: [100, 40000, 200, 30] }),
    node("AXLink", "above the display", { frame: [100, -300, 200, 30] }),
    node("AXLink", "on screen", { frame: [100, 125, 72, 30] }),
  );
  expect(labels(tree)).toEqual(["on screen"]);
});

test("offscreen container prunes its whole subtree", () => {
  const row = node("AXRow", "Note 900", { frame: [1085, 42718, 280, 68], children: [node("AXButton", "Delete")] });
  expect(labels(app(row))).toEqual([]);
});

test("a scrolled-out link is collected off screen without joining the items", () => {
  const tree = app(
    node("AXLink", "Register Now", { frame: [320, -4200, 120, 32], press: true }),
    node("AXLink", "clamped to a sliver", { frame: [100, 125, 72, 1], press: true }),
    node("AXLink", "on screen", { frame: [100, 125, 72, 30], press: true }),
  );
  const [found, hidden, capped] = walk(tree);
  expect(found.map((n) => n.label)).toEqual(["on screen"]);
  expect(hidden.map((n) => [n.role, n.label, n.pressable])).toEqual([
    ["AXLink", "Register Now", true],
    ["AXLink", "clamped to a sliver", true],
  ]);
  expect(hidden[0]?.ref).toBe(tree.children[0]);
  expect(capped).toBe(false);
});

test("an unlabelled or unpressable off-screen node is not collected", () => {
  const tree = app(
    node("AXLink", "", { frame: [320, -4200, 120, 32], press: true }),
    node("AXRow", "Note 900", { frame: [1085, 42718, 280, 68] }),
    node("AXGroup", "", { frame: [0, -900, 400, 80], press: true }),
  );
  expect(offscreen(tree)).toEqual([]);
});

test("an off-display container still yields its pressable children", () => {
  const row = node("AXRow", "Note 900", {
    frame: [1085, 42718, 280, 68],
    press: true,
    children: [node("AXButton", "Delete", { frame: [1300, 42730, 40, 40], press: true })],
  });
  const [found, hidden] = walk(app(row));
  expect(found).toEqual([]);
  expect(hidden.map((n) => n.label)).toEqual(["Note 900", "Delete"]);
});

test("the offscreen cap stops collection and leaves the on-screen walk alone", () => {
  const rows = Array.from({ length: 8 }, (_, i) => node("AXRow", `Note ${i}`, { frame: [1085, 4000 + 70 * i, 280, 68], press: true }));
  const tree = app(node("AXButton", "New Note", { press: true }), ...rows);
  const [found, hidden, capped] = walk(tree, { offscreenCap: 3 });
  expect(hidden.map((n) => n.label)).toEqual(["Note 0", "Note 1", "Note 2"]);
  expect(found.map((n) => n.label)).toEqual(["New Note"]);
  expect(capped).toBe(false);
});

test("skips closed menu subtrees but keeps the menu bar item", () => {
  const menu = node("AXMenu", "", { frame: [0, 1117, 0, 0], children: [node("AXMenuItem", "New Folder", { frame: [0, 0, 100, 20] })] });
  const barItem = node("AXMenuBarItem", "File", { frame: [50, 0, 34, 24], children: [menu] });
  expect(labels(app(barItem))).toEqual(["File"]);
});

test("decorative child does not repeat its parent's label", () => {
  const button = node("AXButton", "Add reaction", { children: [node("AXImage", "", { frame: [20, 12, 16, 16] })] });
  expect(labels(app(button))).toEqual(["Add reaction"]);
});

test("child recovers the label of a parent that was not emitted", () => {
  const cell = node("AXCell", "Inbox", { frame: [10, 10, 100, 2], children: [node("AXImage", "", { frame: [10, 40, 20, 20] })] });
  const [found] = walk(app(cell));
  expect(found.map((n) => [n.role, n.label])).toEqual([["AXImage", "Inbox"]]);
});

test("window title does not leak onto its buttons", () => {
  const window = node("AXWindow", "Notes", { frame: [0, 0, 900, 600], children: [node("AXButton", "", { frame: [882, 56, 16, 16] })] });
  expect(labels(app(window))).toEqual([]);
});

test("row recovers its label from a shallow static text", () => {
  const childText = node("AXRow", "", { children: [node("AXStaticText", "Projects", { frame: [12, 12, 80, 16] })] });
  const grandchildText = node("AXRow", "", {
    frame: [10, 40, 100, 20],
    children: [node("AXGroup", "", { children: [node("AXStaticText", "Downloads", { frame: [12, 42, 80, 16] })] })],
  });
  expect(labels(app(childText, grandchildText))).toEqual(["Projects", "Downloads"]);
});

test("node cap stops the walk and is reported", () => {
  const wide = app(...Array.from({ length: 20 }, (_, i) => node("AXButton", `b${i}`, { frame: [10 * i, 10, 8, 20] })));
  const [found, , capped] = walk(wide, { nodeCap: 5 });
  expect(capped).toBe(true);
  expect(found).toHaveLength(4); // the application element itself costs one visit
});

test("time cap stops the walk and is reported", () => {
  const ticks = [0, ...Array.from({ length: 39 }, (_, i) => 0.1 * (i + 1))];
  let tick = 0;
  const wide = app(...Array.from({ length: 20 }, (_, i) => node("AXButton", `b${i}`, { frame: [10 * i, 10, 8, 20] })));
  const [found, , capped] = walk(wide, { timeCap: 0.5, clock: () => ticks[tick++]! });
  expect(capped).toBe(true);
  expect(found.length).toBeGreaterThan(0);
  expect(found.length).toBeLessThan(20);
});

test("ax items convert points to capture pixels and name the role", () => {
  const nodes: AxNode[] = [
    { role: "AXPopUpButton", label: "View site information", x: 126, y: 89, w: 24, h: 24, pressable: true },
    { role: "AXDisclosureTriangle", label: "More", x: 10, y: 10, w: 12, h: 12, pressable: true },
  ];
  spyOn(macos, "actionableElements").mockImplementation(() => [nodes, [], false]);
  const items = axItems(screen({ pid: 123 }), 255);
  expect(items.map((it) => [it.role, it.source, it.text])).toEqual([
    ["popup", "ax", "View site information"],
    ["other", "ax", "More"],
  ]);
  expect(items[0]).toMatchObject({ x1: 252, y1: 178, x2: 300, y2: 226 });
});

test("ax items are skipped without a pid and when the walk raises", () => {
  const walked = spyOn(macos, "actionableElements").mockImplementation(() => {
    throw new Error("accessibility said no");
  });
  expect(axItems(screen(), 255)).toEqual([]);
  expect(walked).not.toHaveBeenCalled();
  expect(axItems(screen({ pid: 123 }), 255)).toEqual([]);
  expect(walked).toHaveBeenCalledTimes(1);
});

test("the walker keeps a handle to every element it reports", () => {
  const button = node("AXButton", "Share");
  const [found] = walk(app(button));
  expect(found).toHaveLength(1);
  expect(found[0]?.ref).toBe(button);
  expect(found[0]).toEqual({ role: "AXButton", label: "Share", x: 10, y: 10, w: 100, h: 20, pressable: false, ref: button });
});

/** What perceive reads off the screen, in place of Vision. */
const reads = (...lines: Line[]) => spyOn(macos, "recognizeText").mockImplementation(() => lines);

test("ax refs follow items through the merge and the renumbering", async () => {
  const [left, right] = [{ element: "left" }, { element: "right" }];
  const nodes: AxNode[] = [
    { role: "AXButton", label: "Right", x: 400, y: 50, w: 60, h: 20, pressable: true, ref: right },
    { role: "AXLink", label: "Left", x: 50, y: 52, w: 60, h: 20, pressable: true, ref: left },
  ];
  spyOn(macos, "actionableElements").mockImplementation(() => [nodes, [], false]);
  reads(
    ["Left", 0.9, [100, 104, 220, 140]], // names the control, so the two merge
    ["Unrelated text", 0.9, [100, 400, 300, 430]],
  );
  const live = screen({ pid: 123 });
  const items = await perceive(live, 255, "goal");
  expect(items.map((it) => [it.index, it.text, it.source])).toEqual([
    [0, "Left", "ax+ocr"],
    [1, "Right", "ax"],
    [2, "Unrelated text", "ocr"],
  ]);
  expect([...live.axRefs.keys()]).toEqual([0, 1]);
  expect(live.axRefs.get(0)).toBe(left);
  expect(live.axRefs.get(1)).toBe(right);
});

test("offscreen controls are deduplicated and never repeat a visible item", async () => {
  const hidden: AxNode[] = [
    { role: "AXRow", label: "Note 900", x: 0, y: 42718, w: 280, h: 68, pressable: true, ref: {} },
    { role: "AXRow", label: "Note 900", x: 0, y: 48000, w: 280, h: 68, pressable: true, ref: {} },
    { role: "AXButton", label: "Note 900", x: 0, y: 48000, w: 40, h: 40, pressable: true, ref: {} },
    { role: "AXLink", label: "Only text", x: 0, y: -900, w: 60, h: 20, pressable: true, ref: {} },
  ];
  spyOn(macos, "actionableElements").mockImplementation(() => [[], hidden, false]);
  reads(["Only text", 0.9, [10, 10, 90, 40]]);
  const live = screen({ pid: 123 });
  await perceive(live, 255, "goal");
  expect(live.offscreen.map((n) => [n.role, n.label])).toEqual([
    ["AXRow", "Note 900"],
    ["AXButton", "Note 900"],
  ]);
  expect(live.offscreen[0]).toBe(hidden[0]!);
});

test("offscreen controls are empty in replay", async () => {
  const walked = spyOn(macos, "actionableElements").mockImplementation(() => {
    throw new Error("no pid to walk");
  });
  reads();
  const replayed = screen();
  await perceive(replayed, 255, "goal");
  expect(replayed.offscreen).toEqual([]);
  expect(walked).not.toHaveBeenCalled();
});

test("ax refs are empty without an accessibility tree", async () => {
  reads(["Only text", 0.9, [10, 10, 90, 40]]);
  const replayed = screen();
  const items = await perceive(replayed, 255, "goal");
  expect(items.map((it) => it.source)).toEqual(["ocr"]);
  expect(replayed.axRefs.size).toBe(0);
});

test("a subtree repeated under several parents is walked once", () => {
  // Ghostty hangs its menu bar under every window: same role, label and frame, new objects each time.
  const tree: Record<string, string[]> = {
    app: ["win1", "win2", "win3"],
    win1: ["bar1"],
    win2: ["bar2"],
    win3: ["bar3"],
    bar1: ["file1"],
    bar2: ["file2"],
    bar3: ["file3"],
    file1: [],
    file2: [],
    file3: [],
  };
  const frame = (n: string): Frame | null => {
    if (n.startsWith("win")) return [0, 40, 800, 600];
    if (n.startsWith("bar")) return [0, 0, 800, 24];
    return n.startsWith("file") ? [40, 0, 30, 24] : null;
  };
  const role = (n: string) => {
    if (n === "app") return "AXApplication";
    if (n.startsWith("win")) return "AXWindow";
    return n.startsWith("bar") ? "AXMenuBar" : "AXMenuBarItem";
  };
  const [found, , capHit] = walkNames(tree, (n) => ({ role: role(n), label: n.startsWith("file") ? "File" : "", frame: frame(n) }));
  expect(found.map((n) => n.label)).toEqual(["File"]);
  expect(capHit).toBe(false);
});

test("nested nameless containers sharing one frame do not prune their subtree", () => {
  // Calculator wraps its keypad in layout boxes of one frame: no label, so none of them is a repeat of another.
  const keypad: Frame = [0, 100, 230, 300];
  const button = node("AXButton", "7", { frame: [10, 110, 50, 50] });
  const inner = node("AXGroup", "", { frame: keypad, children: [button] });
  const split = node("AXSplitGroup", "", { frame: keypad, children: [inner] });
  const [found, , capped] = walk(app(node("AXGroup", "", { frame: keypad, children: [split] })));
  expect(found.map((n) => [n.role, n.label])).toEqual([["AXButton", "7"]]);
  expect(found[0]?.ref).toBe(button);
  expect(capped).toBe(false);
});

test("a row that borrowed its label is reported once however many parents hand it over", () => {
  const inbox = () => node("AXRow", "", { children: [node("AXStaticText", "Inbox", { frame: [12, 12, 80, 16] })] });
  const [first, second] = [inbox(), inbox()];
  const tree = app(
    node("AXOutline", "", { frame: [0, 0, 300, 600], children: [first] }),
    node("AXScrollArea", "", { frame: [0, 0, 300, 600], children: [second] }),
  );
  const [found] = walk(tree);
  expect(found.map((n) => [n.role, n.label])).toEqual([["AXRow", "Inbox"]]);
  expect(found[0]?.ref).toBe(first);
});

test("an app that lists itself as a child terminates", () => {
  const tree: Record<string, string[]> = { app: ["app", "app", "bar"], bar: ["file"], file: [] };
  const frames: Record<string, Frame | null> = { app: null, bar: [0, 0, 800, 24], file: [40, 0, 30, 24] };
  const roles: Record<string, string> = { app: "AXApplication", bar: "AXMenuBar", file: "AXMenuBarItem" };
  const [found, , capHit] = walkNames(tree, (n) => ({ role: roles[n]!, label: n === "file" ? "File" : "", frame: frames[n]! }));
  expect(found.map((n) => n.label)).toEqual(["File"]);
  expect(capHit).toBe(false);
});
