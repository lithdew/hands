import { describe, expect, test } from "bun:test";
import type { Exec, Hand } from "./desktop";
import { findHandWindow, layoutPip, pipCommands, swapBack, swapTo, tileRects, type HyprClient, type Monitor } from "./pip";

const mon1080: Monitor = { name: "eDP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1, focused: true };
const hands: Hand[] = [
  { id: 1, pid: 100, display: "wayland-1", width: 1280, height: 800 },
  { id: 2, pid: 200, display: "wayland-2", width: 1280, height: 800 },
  { id: 3, pid: 300, display: "wayland-3", width: 1280, height: 800 },
];
const windows: HyprClient[] = [
  { address: "0xaaa", pid: 100, title: "wlroots - WL-1", class: "wlroots", floating: false, fullscreen: 0, monitor: 0 },
  { address: "0xbbb", pid: 200, title: "wlroots - WL-1", class: "wlroots", floating: false, fullscreen: 0, monitor: 0 },
  { address: "0x123", pid: 999, title: "Chromium", class: "chromium", floating: false, fullscreen: 0, monitor: 0 },
];

/** Fake hyprctl: answers monitors/clients queries, records dispatch batches. */
function fakeHyprctl(mons: Monitor[], clients: HyprClient[]) {
  const batches: string[] = [];
  const exec: Exec = async (argv) => {
    let out = "";
    if (argv[1] === "monitors") out = JSON.stringify(mons);
    else if (argv[1] === "clients") out = JSON.stringify(clients);
    else if (argv[1] === "--batch") batches.push(argv[2]!);
    return { exitCode: 0, stdout: new TextEncoder().encode(out), stderr: "" };
  };
  return { exec, batches };
}

describe("tileRects", () => {
  test("one tile sits in the bottom-right corner", () => {
    expect(tileRects(1, mon1080, { w: 480, h: 300, margin: 16 })).toEqual([{ x: 1920 - 16 - 480, y: 1080 - 16 - 300, w: 480, h: 300 }]);
  });

  test("tiles stack upward with a gap", () => {
    const [a, b, c] = tileRects(3, mon1080, { w: 480, h: 300, margin: 16, gap: 12 });
    expect(a!.x).toBe(b!.x);
    expect(a!.y - b!.y).toBe(312);
    expect(b!.y - c!.y).toBe(312);
    expect(c!.y).toBeGreaterThanOrEqual(16);
  });

  test("overflowing tiles start a second column to the left", () => {
    const rects = tileRects(4, mon1080, { w: 480, h: 300, margin: 16, gap: 12 });
    // 1080 - 32 margin = 1048 usable; (1048 + 12) / 312 = 3 per column
    expect(rects[3]!.x).toBe(rects[0]!.x - 492);
    expect(rects[3]!.y).toBe(rects[0]!.y);
  });

  test("honors monitor offset, scale and reserved bar space", () => {
    const mon: Monitor = {
      name: "DP-1",
      x: 1920,
      y: 0,
      width: 5120,
      height: 2880,
      scale: 2,
      focused: true,
      reserved: [40, 0, 0, 0],
    };
    const [r] = tileRects(1, mon, { w: 400, h: 250, margin: 10 });
    expect(r).toEqual({ x: 1920 + 2560 - 10 - 400, y: 1440 - 10 - 250, w: 400, h: 250 });
  });
});

describe("findHandWindow", () => {
  test("matches by the nested compositor pid", () => {
    expect(findHandWindow(hands[0]!, windows)?.address).toBe("0xaaa");
    expect(findHandWindow(hands[2]!, windows)).toBeNull();
  });
});

describe("pipCommands", () => {
  test("floats, pins, resizes and moves the window", () => {
    expect(pipCommands("0xaaa", { x: 10, y: 20, w: 480, h: 300 })).toEqual([
      "setfloating address:0xaaa",
      "pin address:0xaaa",
      "resizewindowpixel exact 480 300,address:0xaaa",
      "movewindowpixel exact 10 20,address:0xaaa",
    ]);
  });
});

describe("layoutPip", () => {
  test("places mapped hands in one batch and reports unmapped ones", async () => {
    const { exec, batches } = fakeHyprctl([mon1080], windows);
    const { placed, missing } = await layoutPip(hands, { w: 480, h: 300, margin: 16, gap: 12 }, exec);
    expect(placed.map((h) => h.id)).toEqual([1, 2]);
    expect(missing.map((h) => h.id)).toEqual([3]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toContain("dispatch pin address:0xaaa");
    expect(batches[0]).toContain("dispatch movewindowpixel exact 1424 764,address:0xaaa");
    expect(batches[0]).toContain("dispatch movewindowpixel exact 1424 452,address:0xbbb");
    expect(batches[0]).not.toContain("0x123");
  });
});

describe("swap", () => {
  test("swapTo focuses and fullscreens the hand's window", async () => {
    const { exec, batches } = fakeHyprctl([mon1080], windows);
    await swapTo(hands[1]!, exec);
    expect(batches[0]).toBe("dispatch focuswindow address:0xbbb; dispatch fullscreen 0");
  });

  test("swapBack only touches fullscreen hand windows", async () => {
    const fs = windows.map((w) => (w.address === "0xaaa" ? { ...w, fullscreen: 2 } : w));
    const { exec, batches } = fakeHyprctl([mon1080], fs);
    await swapBack(hands, exec);
    expect(batches[0]).toBe("dispatch focuswindow address:0xaaa; dispatch fullscreen 0");
  });

  test("swapBack with nothing fullscreen sends nothing", async () => {
    const { exec, batches } = fakeHyprctl([mon1080], windows);
    await swapBack(hands, exec);
    expect(batches).toHaveLength(0);
  });
});
