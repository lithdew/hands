import { describe, expect, test } from "bun:test";
import type { Exec, Hand } from "./desktop";
import { dispatchBatch, findHandWindow, handLookCommands, layoutPip, pipCommands, setHandState, swapBack, swapTo, tileRects, toggleHand, type HyprClient, type Monitor, type StateStore, type SwapState } from "./pip";

const mon1080: Monitor = { name: "eDP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1, focused: true };
const hands: Hand[] = [
  { id: 1, pid: 100, display: "wayland-1", width: 1280, height: 800 },
  { id: 2, pid: 200, display: "wayland-2", width: 1280, height: 800 },
  { id: 3, pid: 300, display: "wayland-3", width: 1280, height: 800 },
];
const windows: HyprClient[] = [
  { address: "0xaaa", pid: 100, title: "wlroots - WL-1", class: "wlroots", floating: true, pinned: true, at: [1424, 764], size: [480, 300], tags: ["puk-hand"], fullscreen: 0, monitor: 0 },
  { address: "0xbbb", pid: 200, title: "wlroots - WL-1", class: "wlroots", floating: true, pinned: true, at: [1424, 452], size: [480, 300], tags: ["puk-hand"], fullscreen: 0, monitor: 0 },
  { address: "0x123", pid: 999, title: "Chromium", class: "chromium", floating: false, fullscreen: 0, monitor: 0 },
];

/** Fake hyprctl: answers monitors/clients queries, records dispatch batches. */
function fakeHyprctl(mons: Monitor[], clients: HyprClient[], active = clients.find((w) => w.pid === 999)) {
  const batches: string[] = [];
  const exec: Exec = async (argv) => {
    let out = "";
    if (argv[1] === "monitors") out = JSON.stringify(mons);
    else if (argv[1] === "clients") out = JSON.stringify(clients);
    else if (argv[1] === "activewindow") out = JSON.stringify(active ?? {});
    else if (argv[1] === "activeworkspace") out = JSON.stringify({ id: 1, name: "1" });
    else if (argv[1] === "--batch") { batches.push(argv[2]!); out = "ok\n"; }
    return { exitCode: 0, stdout: new TextEncoder().encode(out), stderr: "" };
  };
  return { exec, batches };
}

function memoryState(initial: SwapState | null = null): StateStore {
  let state = initial;
  return { async read() { return state; }, async write(value) { state = value; } };
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
      reserved: [0, 40, 0, 0],
    };
    const [r] = tileRects(1, mon, { w: 400, h: 250, margin: 10 });
    expect(r).toEqual({ x: 1920 + 2560 - 10 - 400, y: 1440 - 10 - 250, w: 400, h: 250 });
  });

  test("CLI options with undefined values keep the defaults", () => {
    expect(tileRects(1, mon1080, { w: undefined, h: undefined, margin: undefined, gap: undefined }))
      .toEqual(tileRects(1, mon1080));
  });

  test("uses Hyprland's left, top, right, bottom reserved order", () => {
    expect(tileRects(1, { ...mon1080, reserved: [10, 20, 30, 40] }))
      .toEqual([{ x: 1394, y: 724, w: 480, h: 300 }]);
  });

  test("rotated monitors use logical portrait dimensions", () => {
    expect(tileRects(1, { ...mon1080, transform: 1 }))
      .toEqual([{ x: 584, y: 1604, w: 480, h: 300 }]);
  });

  test("rejects invalid dimensions and layouts that would overlap", () => {
    expect(() => tileRects(1, mon1080, { w: NaN })).toThrow("invalid PIP w");
    expect(() => tileRects(1, mon1080, { h: -1 })).toThrow("invalid PIP h");
    expect(() => tileRects(100, mon1080)).toThrow("do not fit");
  });

  test("new previews skip the space occupied by resized previews", () => {
    const occupied = [{ x: 1300, y: 630, w: 600, h: 430 }];
    expect(tileRects(2, mon1080, {}, occupied)).toEqual([
      { x: 1424, y: 140, w: 480, h: 300 },
      { x: 932, y: 140, w: 480, h: 300 },
    ]);
    expect(() => tileRects(1, mon1080, {}, [{ x: 0, y: 0, w: 1920, h: 1080 }])).toThrow("around existing previews");
  });
});

describe("findHandWindow", () => {
  test("matches by the nested compositor pid", () => {
    expect(findHandWindow(hands[0]!, windows)?.address).toBe("0xaaa");
    expect(findHandWindow(hands[2]!, windows)).toBeNull();
  });
});

describe("PIP layout", () => {
  test("uses explicit Lua states and rejects untrusted selectors or geometry", () => {
    const commands = pipCommands("0xaaa", { x: 10, y: 20, w: 480, h: 300 }).join("; ");
    expect(commands).toContain('hl.dsp.window.pin({window="address:0xaaa",action="enable"})');
    expect(commands).toContain('hl.dsp.window.move({window="address:0xaaa",x=10,y=20,relative=false})');
    expect(commands).not.toContain('action="toggle"');
    expect(() => pipCommands('0xaaa"; os.execute("bad")', { x: 0, y: 0, w: 480, h: 300 })).toThrow("address");
    expect(() => pipCommands("0xaaa", { x: NaN, y: 0, w: 480, h: 300 })).toThrow("rectangle");
  });

  test("tiles get rounded corners, a thin border and an idle look", () => {
    const commands = pipCommands("0xaaa", { x: 10, y: 20, w: 480, h: 300 }).join("; ");
    expect(commands).toContain('prop="rounding",value="12"');
    expect(commands).toContain('prop="border_size",value="2"');
    expect(commands).toContain('prop="keep_aspect_ratio",value="1"');
    expect(commands).toContain('prop="inactive_border_color",value="rgba(414868cc)"');
    expect(commands).toContain('prop="opacity",value="0.92 override 0.92 override 1 override"');
  });

  test("hand states map to theme colors and reject unknown states or colors", () => {
    const palette = { background: "#000000", lighterBackground: "#111111", foreground: "#ffffff", mutedForeground: "#888888", muted: "#444444", accent: "#0000ff", green: "#00ff00", yellow: "#ffff00", red: "#ff0000" };
    expect(handLookCommands("0xaaa", "working", palette).join("; ")).toContain('prop="active_border_color",value="rgb(0000ff) rgb(00ff00) 45deg"');
    expect(handLookCommands("0xaaa", "review", palette).join("; ")).toContain('value="rgb(ffff00)"');
    expect(handLookCommands("0xaaa", "error", palette).join("; ")).toContain('value="rgb(ff0000)"');
    expect(handLookCommands("0xaaa", "working", palette).join("; ")).toContain('prop="opacity",value="1 override 1 override 1 override"');
    expect(() => handLookCommands("0xaaa", "busy" as never)).toThrow("unknown hand state");
    expect(() => handLookCommands("0xaaa", "error", { ...palette, red: "rgb(1,2,3)" })).toThrow("palette color");
  });

  test("setHandState recolors a mapped preview and leaves fullscreen or missing windows alone", async () => {
    const { exec, batches } = fakeHyprctl([mon1080], windows);
    expect(await setHandState(hands[0]!, "working", exec)).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toContain('window="address:0xaaa",prop="active_border_color"');
    expect(batches[0]).not.toContain("resize");
    expect(await setHandState(hands[2]!, "working", exec)).toBe(false);
    const fullscreen = windows.map((w) => w.address === "0xaaa" ? { ...w, fullscreen: 2 } : w);
    const inside = fakeHyprctl([mon1080], fullscreen);
    expect(await setHandState(hands[0]!, "review", inside.exec)).toBe(false);
    expect(await setHandState(hands[0]!, "idle", inside.exec)).toBe(false);
    expect(inside.batches).toHaveLength(0);
  });

  test("idle and failed hands are parked without resizing or closing their desktops", async () => {
    for (const state of ["idle", "error"] as const) {
      const { exec, batches } = fakeHyprctl([mon1080], windows);
      expect(await setHandState(hands[0]!, state, exec)).toBe(true);
      expect(batches[0]).toContain('window="address:0xaaa",action="disable"');
      expect(batches[0]).toContain('workspace="special:puk-idle",follow=false');
      expect(batches[0]).not.toMatch(/resize|fullscreen|focus|kill/);
    }
  });

  test("already hidden idle previews need no dispatcher and working/review restores them without focus", async () => {
    const hidden = windows.map(w => w.address === "0xaaa" ? { ...w, pinned: false, workspace: { id: -98, name: "special:puk-idle" } } : w);
    const idle = fakeHyprctl([mon1080], hidden);
    expect(await setHandState(hands[0]!, "idle", idle.exec)).toBe(true);
    expect(idle.batches).toEqual([]);
    for (const state of ["working", "review"] as const) {
      const { exec, batches } = fakeHyprctl([mon1080], hidden);
      expect(await setHandState(hands[0]!, state, exec)).toBe(true);
      expect(batches[0]).toContain('workspace="1",follow=false');
      expect(batches[0]).toContain('window="address:0xaaa",action="enable"');
      expect(batches[0]!.indexOf('workspace="1"')).toBeLessThan(batches[0]!.indexOf('action="enable"'));
      expect(batches[0]).not.toMatch(/resize|fullscreen|hl\.dsp\.focus/);
    }
  });

  test("resetting previews adjusts parked geometry without showing an idle desktop", async () => {
    const hidden = windows.map(w => w.address === "0xaaa" ? { ...w, pinned: false, workspace: { id: -98, name: "special:puk-idle" } } : w);
    const { exec, batches } = fakeHyprctl([mon1080], hidden);
    await layoutPip(hands, {}, exec, memoryState());
    expect(batches[0]).toContain('window="address:0xaaa",action="disable"');
    expect(batches[0]).not.toContain('hl.dsp.window.pin({window="address:0xaaa",action="enable"})');
    expect(batches[0]).toContain('window="address:0xaaa",x=1424,y=764,relative=false');
  });

  test("a hidden hand can be opened manually and keeps its saved preview geometry", async () => {
    const rect = { x: 1200, y: 710, w: 600, h: 350 };
    const hidden = windows.map(w => w.address === "0xaaa" ? { ...w, pinned: false, at: [rect.x, rect.y] as [number, number], size: [rect.w, rect.h] as [number, number], workspace: { id: -98, name: "special:puk-idle" } } : w);
    const { exec, batches } = fakeHyprctl([mon1080], hidden);
    const state = memoryState();
    await swapTo(hands[0]!, exec, state);
    expect((await state.read())?.active.rect).toEqual(rect);
    expect(batches[0]).toContain('workspace="1",follow=false');
    expect(batches[0]!.indexOf('workspace="1"')).toBeLessThan(batches[0]!.indexOf('hl.dsp.focus'));
    expect(batches[0]).toContain('internal=2,client=2');
  });

  test("places mapped hands in one batch and reports unmapped ones", async () => {
    const { exec, batches } = fakeHyprctl([mon1080], windows);
    const { placed, missing } = await layoutPip(hands, {}, exec, memoryState());
    expect(placed.map((h) => h.id)).toEqual([1, 2]);
    expect(missing.map((h) => h.id)).toEqual([3]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toContain('window="address:0xaaa",x=1424,y=764,relative=false');
    expect(batches[0]).toContain('window="address:0xbbb",x=1424,y=452,relative=false');
    expect(batches[0]).not.toContain("0x123");
    expect(batches[0]).not.toContain("hl.dsp.focus");
  });

  test("repeated layout still enables pinning instead of toggling it off", async () => {
    const { exec, batches } = fakeHyprctl([mon1080], windows);
    const state = memoryState();
    await layoutPip(hands, {}, exec, state);
    await layoutPip(hands, {}, exec, state);
    expect(batches[1]).toEqual(batches[0]);
    expect(batches[1]).toContain('hl.dsp.window.pin({window="address:0xaaa",action="enable"})');
  });

  test("startup keeps manual adjustments and places only new hands in free slots", async () => {
    const adjusted = windows.map((win) => win.pid === 100
      ? { ...win, at: [1300, 630] as [number, number], size: [600, 430] as [number, number] }
      : win.pid === 200 ? { ...win, floating: false, pinned: false } : win);
    const { exec, batches } = fakeHyprctl([mon1080], adjusted);
    const result = await layoutPip(hands, { preserve: true }, exec, memoryState());
    expect(result.placed.map((h) => h.id)).toEqual([1, 2]);
    expect(result.missing.map((h) => h.id)).toEqual([3]);
    expect(batches[0]).not.toContain('window="address:0xaaa"');
    expect(batches[0]).toContain('window="address:0xbbb",x=1424,y=140,relative=false');
  });

  test("startup preserves an open desktop and its return state", async () => {
    const saved = { active: { address: "0xaaa", pid: 100, rect: { x: 60, y: 80, w: 600, h: 400 } }, previous: { address: "0x123", pid: 999 } };
    const state = memoryState(saved);
    const { exec, batches } = fakeHyprctl([mon1080], windows.map((win) => win.pid === 100 ? { ...win, fullscreen: 2, pinned: false } : win));
    await layoutPip(hands, { preserve: true }, exec, state);
    expect(batches).toHaveLength(0);
    expect(await state.read()).toEqual(saved);
  });

  test("surfaces dispatcher errors even when hyprctl exits zero", async () => {
    const exec: Exec = async () => ({ exitCode: 0, stdout: new TextEncoder().encode("ok\nInvalid dispatcher\n"), stderr: "" });
    await expect(dispatchBatch(["invalid()"], exec)).rejects.toThrow("Invalid dispatcher");
  });
});

describe("enter and return", () => {
  test("enter and return preserve a moved, resized preview without touching the other hand", async () => {
    const state = memoryState();
    const adjusted = windows.map((win) => win.pid === 100
      ? { ...win, at: [80, 100] as [number, number], size: [720, 450] as [number, number] } : win);
    await swapTo(hands[0]!, fakeHyprctl([mon1080], adjusted).exec, state);
    const { exec, batches } = fakeHyprctl([mon1080], adjusted.map((win) => win.pid === 100 ? { ...win, fullscreen: 2, pinned: false } : win));
    await swapBack(hands, exec, state);
    expect(batches[0]).toContain('window="address:0xaaa",x=720,y=450,relative=false');
    expect(batches[0]).toContain('window="address:0xaaa",x=80,y=100,relative=false');
    expect(batches[0]).not.toContain('window="address:0xbbb"');
    expect(await state.read()).toBeNull();
  });

  test("saves the actual tile and previous window before entering fullscreen", async () => {
    const { exec, batches } = fakeHyprctl([mon1080], windows);
    const state = memoryState();
    await swapTo(hands[0]!, exec, state);
    expect(await state.read()).toEqual({
      active: { address: "0xaaa", pid: 100, rect: { x: 1424, y: 764, w: 480, h: 300 } },
      previous: { address: "0x123", pid: 999 },
    });
    expect(batches[0]).toContain('hl.dsp.window.pin({window="address:0xaaa",action="disable"})');
    expect(batches[0]).toContain('hl.dsp.focus({window="address:0xaaa"})');
    expect(batches[0]).toContain('window="address:0xaaa",action="set",internal=2,client=2');
  });

  test("switching hands restores the first tile and remembers the original desktop", async () => {
    const state = memoryState();
    const first = fakeHyprctl([mon1080], windows);
    await swapTo(hands[0]!, first.exec, state);
    const fullscreenWindows = windows.map((w) => w.pid === 100 ? { ...w, fullscreen: 2, pinned: false, at: [0, 0] as [number, number], size: [1920, 1080] as [number, number] } : w);
    const second = fakeHyprctl([mon1080], fullscreenWindows, fullscreenWindows[0]);
    await swapTo(hands[1]!, second.exec, state);
    expect(second.batches[0]).toContain('window="address:0xaaa",x=1424,y=764,relative=false');
    expect(second.batches[0]).toContain('window="address:0xbbb",action="set",internal=2,client=2');
    expect((await state.read())?.previous).toEqual({ address: "0x123", pid: 999 });

    const back = fakeHyprctl([mon1080], windows.map((w) => w.pid === 200 ? { ...w, fullscreen: 2, pinned: false } : w));
    await swapBack(hands, back.exec, state);
    expect(back.batches[0]).toContain('window="address:0xbbb",x=1424,y=452,relative=false');
    expect(back.batches[0]).toEndWith('dispatch hl.dsp.focus({window="address:0x123"})');
    expect(await state.read()).toBeNull();
  });

  test("same shortcut returns when the hand is already fullscreen", async () => {
    const state = memoryState({ active: { address: "0xaaa", pid: 100, rect: { x: 50, y: 60, w: 400, h: 250 } } });
    const { exec, batches } = fakeHyprctl([mon1080], windows.map((w) => w.pid === 100 ? { ...w, fullscreen: 2 } : w));
    await toggleHand(hands[0]!, hands, exec, state);
    expect(batches[0]).toContain('window="address:0xaaa",x=50,y=60,relative=false');
    expect(batches[0]).not.toContain("internal=2,client=2");
    expect(await state.read()).toBeNull();
  });

  test("closed hands and reused window addresses cannot redirect restoration", async () => {
    const state = memoryState({ active: { address: "0xaaa", pid: 777, rect: { x: 1, y: 1, w: 100, h: 100 } }, previous: { address: "0x123", pid: 888 } });
    const { exec, batches } = fakeHyprctl([mon1080], windows);
    await swapBack(hands, exec, state);
    expect(batches).toHaveLength(0);
    expect(await state.read()).toBeNull();
  });

  test("return also recovers a manually fullscreened hand without saved state", async () => {
    const { exec, batches } = fakeHyprctl([mon1080], windows.map((w) => w.pid === 100 ? { ...w, fullscreen: 2 } : w));
    await swapBack(hands, exec, memoryState());
    expect(batches[0]).toContain('window="address:0xaaa",action="set",internal=0,client=0');
    expect(batches[0]).not.toContain('window="address:0xbbb"');
    expect(batches[0]).not.toContain('window="address:0x123"');
  });
});
