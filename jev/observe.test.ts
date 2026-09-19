import { describe, expect, test } from "bun:test";
import type { Exec, Hand } from "../desktop";
import {
  buildObservation,
  centerOf,
  describeElement,
  observe,
  regionOf,
  swayWindows,
  withVisionElements,
  type UiElement,
} from "./observe";

const hand: Hand = { id: 1, pid: 4242, display: "wayland-7", width: 1200, height: 900 };

function rawEl(over: Record<string, unknown> = {}) {
  return {
    role: "push button",
    name: "Send",
    description: "",
    value: "",
    editable: false,
    focused: false,
    enabled: true,
    pid: 900,
    frame: "Inbox - Chromium",
    within: "New Message",
    x: 100,
    y: 100,
    w: 80,
    h: 30,
    ...over,
  };
}

const el = (over: Partial<UiElement> = {}): UiElement => ({
  id: "e1",
  source: "atspi",
  role: "button",
  name: "Send",
  value: "",
  editable: false,
  focused: false,
  within: "",
  frame: "",
  rect: { x: 0, y: 0, w: 90, h: 30 },
  ...over,
});

describe("regionOf", () => {
  test("names the ninth of the screen the centre falls in", () => {
    expect(regionOf({ x: 0, y: 0, w: 50, h: 20 }, hand)).toBe("top left");
    expect(regionOf({ x: 1100, y: 20, w: 50, h: 20 }, hand)).toBe("top right");
    expect(regionOf({ x: 550, y: 430, w: 100, h: 40 }, hand)).toBe("center");
    expect(regionOf({ x: 550, y: 860, w: 100, h: 30 }, hand)).toBe("bottom center");
  });
});

describe("describeElement", () => {
  test("says role, name and place in words, with no coordinates", () => {
    const text = describeElement(el({ rect: { x: 1100, y: 20, w: 80, h: 30 }, within: "New Message" }), hand);
    expect(text).toBe('button "Send" (top right, in "New Message")');
    expect(text).not.toMatch(/\d/);
  });

  test("shows what a field holds and whether it has focus", () => {
    const field = el({ role: "text field", name: "To", editable: true, focused: true });
    expect(describeElement(field, hand)).toBe('text field "To" empty focused (top left)');
    expect(describeElement({ ...field, value: "sam@example.com", focused: false }, hand)).toBe(
      'text field "To" containing "sam@example.com" (top left)',
    );
  });
});

describe("swayWindows", () => {
  test("collects tiled and floating windows with their content origin", () => {
    const tree = {
      nodes: [
        {
          nodes: [{ pid: 900, name: "Inbox - Chromium", focused: true, rect: { x: 0, y: 0 }, window_rect: { x: 0, y: 0 } }],
          floating_nodes: [{ pid: 901, name: "Save File", rect: { x: 300, y: 200 }, window_rect: { x: 2, y: 24 } }],
        },
      ],
    };
    expect(swayWindows(tree)).toEqual([
      { pid: 900, name: "Inbox - Chromium", focused: true, x: 0, y: 0 },
      { pid: 901, name: "Save File", focused: false, x: 302, y: 224 },
    ]);
  });
});

describe("buildObservation", () => {
  const frames = [{ name: "Inbox - Chromium", pid: 900, active: true }];

  test("labels elements in reading order and maps roles to plain words", () => {
    const dump = {
      elements: [rawEl({ name: "Send", y: 500 }), rawEl({ role: "entry", name: "To", editable: true, y: 50 })],
      texts: ["New Message", "New Message"],
      frames,
    };
    const obs = buildObservation(dump, [], hand);
    expect(obs.elements.map((e) => [e.id, e.role, e.name])).toEqual([
      ["e1", "text field", "To"],
      ["e2", "button", "Send"],
    ]);
    expect(obs.texts).toEqual(["New Message"]);
    expect(obs.frames).toEqual(["Inbox - Chromium"]);
  });

  test("adds the position of the window the element belongs to", () => {
    const windows = [
      { pid: 900, name: "Other", focused: false, x: 0, y: 0 },
      { pid: 900, name: "Inbox - Chromium", focused: false, x: 600, y: 40 },
    ];
    const obs = buildObservation({ elements: [rawEl()], texts: [], frames }, windows, hand);
    expect(obs.elements[0]!.rect).toEqual({ x: 700, y: 140, w: 80, h: 30 });
  });

  test("drops what Jev could not use: disabled, nameless, off screen, duplicates", () => {
    const dump = {
      elements: [
        rawEl({ name: "Disabled", enabled: false }),
        rawEl({ name: "" }),
        rawEl({ name: "Far away", x: 5000 }),
        rawEl({ name: "Twice" }),
        rawEl({ name: "Twice" }),
        rawEl({ role: "entry", name: "", editable: true, y: 300 }),
        rawEl({ name: "", description: "Attach files", y: 400 }),
      ],
      texts: [],
      frames,
    };
    const obs = buildObservation(dump, [], hand);
    expect(obs.elements.map((e) => e.name)).toEqual(["Twice", "", "Attach files"]);
  });

  test("the fingerprint changes when the screen does, and only then", () => {
    const a = buildObservation({ elements: [rawEl()], texts: ["Hi"], frames }, [], hand);
    const same = buildObservation({ elements: [rawEl()], texts: ["Hi"], frames }, [], hand);
    const typed = buildObservation(
      { elements: [rawEl({ role: "entry", editable: true, value: "x" })], texts: ["Hi"], frames },
      [],
      hand,
    );
    expect(same.fingerprint).toBe(a.fingerprint);
    expect(typed.fingerprint).not.toBe(a.fingerprint);
  });
});

describe("withVisionElements", () => {
  const obs = buildObservation(
    { elements: [rawEl()], texts: [], frames: [] },
    [],
    hand,
  );

  test("adds what the planner saw, under its own labels", () => {
    const merged = withVisionElements(obs, [{ role: "button", name: "Accept cookies", rect: { x: 500, y: 700, w: 120, h: 40 } }], hand);
    expect(merged.elements.map((e) => [e.id, e.source, e.name])).toEqual([
      ["e1", "atspi", "Send"],
      ["v1", "vision", "Accept cookies"],
    ]);
    expect(merged.fingerprint).toBe(obs.fingerprint);
  });

  test("skips what is already known, nameless, or off the hand's screen", () => {
    const merged = withVisionElements(
      obs,
      [
        { role: "button", name: "Send (again)", rect: { x: 102, y: 101, w: 78, h: 30 } },
        { role: "button", name: "", rect: { x: 500, y: 500, w: 10, h: 10 } },
        { role: "button", name: "Outside", rect: { x: 3000, y: 10, w: 50, h: 20 } },
      ],
      hand,
    );
    expect(merged.elements).toHaveLength(1);
  });
});

describe("observe", () => {
  test("dumps the hand's own display and asks the nested sway for window positions", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (argv) => {
      calls.push(argv);
      const out = argv[0] === "swaymsg" ? { nodes: [] } : { elements: [rawEl()], texts: [], frames: [] };
      return { exitCode: 0, stdout: new TextEncoder().encode(JSON.stringify(out)), stderr: "" };
    };
    const obs = await observe(hand, exec);
    expect(obs.elements).toHaveLength(1);
    expect(calls[0]!.slice(1)).toEqual([expect.stringMatching(/atspi_dump\.py$/), "wayland-7"]);
    expect(calls[1]!.slice(0, 2)).toEqual(["swaymsg", "-s"]);
    expect(calls[1]![2]).toMatch(/sway-ipc\.\d+\.4242\.sock$/);
  });

  test("names the package when the bindings are missing", async () => {
    const exec: Exec = async () => ({
      exitCode: 1,
      stdout: new Uint8Array(),
      stderr: "Traceback\nValueError: Namespace Atspi not available",
    });
    await expect(observe(hand, exec)).rejects.toThrow(/pacman -S python-gobject at-spi2-core/);
  });

  test("still works when swaymsg is not there", async () => {
    const exec: Exec = async (argv) => {
      if (argv[0] === "swaymsg") throw new Error("not installed");
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode(JSON.stringify({ elements: [rawEl()], texts: [], frames: [] })),
        stderr: "",
      };
    };
    expect((await observe(hand, exec)).elements[0]!.rect.x).toBe(100);
  });
});

describe("centerOf", () => {
  test("rounds to whole pixels", () => {
    expect(centerOf({ x: 10, y: 10, w: 25, h: 15 })).toEqual({ x: 23, y: 18 });
  });
});
