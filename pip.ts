// pip.ts — picture-in-picture layout for hand windows on Hyprland (Omarchy).
//
// Each hand's nested compositor (see desktop.ts) is an ordinary window in the
// user's Hyprland session. This file turns those windows into always-on-top
// tiles stacked in the bottom-right corner, and lets the user swap into one
// (fullscreen) and back. No streaming, no VNC: the window *is* the feed.
//
//   layoutPip(hands)   float + pin + size + stack every hand window
//   swapTo(hand)       fullscreen a hand so the user can watch or take over
//   swapBack()         leave fullscreen
//   tileRects(...)     pure geometry, unit tested
//
// CLI: bun pip.ts layout | swap <id> | back | ls
//
// Requires: hyprctl (comes with Hyprland).

import { defaultExec, listHands, type Exec, type Hand } from "./desktop";

// ---------------------------------------------------------------- types

export type Rect = { x: number; y: number; w: number; h: number };

export type Monitor = {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  focused: boolean;
  reserved?: [number, number, number, number]; // top, right, bottom, left
};

export type HyprClient = {
  address: string;
  pid: number;
  title: string;
  class: string;
  floating: boolean;
  fullscreen: number | boolean;
  monitor: number;
};

export type PipOptions = {
  /** tile width in logical pixels */
  w?: number;
  /** tile height in logical pixels */
  h?: number;
  /** distance from the monitor edges */
  margin?: number;
  /** distance between tiles */
  gap?: number;
};

const DEFAULTS: Required<PipOptions> = { w: 480, h: 300, margin: 16, gap: 12 };

// ---------------------------------------------------------------- hyprctl

export async function hyprctl(args: string[], exec: Exec = defaultExec): Promise<string> {
  const res = await exec(["hyprctl", ...args]);
  if (res.exitCode !== 0) throw new Error(`hyprctl ${args.join(" ")} failed: ${res.stderr.trim()}`);
  return new TextDecoder().decode(res.stdout);
}

export async function monitors(exec: Exec = defaultExec): Promise<Monitor[]> {
  return JSON.parse(await hyprctl(["monitors", "-j"], exec)) as Monitor[];
}

export async function clients(exec: Exec = defaultExec): Promise<HyprClient[]> {
  return JSON.parse(await hyprctl(["clients", "-j"], exec)) as HyprClient[];
}

/** Run several dispatchers in one round trip. */
export async function dispatchBatch(commands: string[], exec: Exec = defaultExec): Promise<void> {
  if (commands.length === 0) return;
  await hyprctl(["--batch", commands.map((c) => `dispatch ${c}`).join("; ")], exec);
}

/** The Hyprland window belonging to a hand, matched by the sway pid. */
export function findHandWindow(hand: Hand, all: HyprClient[]): HyprClient | null {
  return all.find((c) => c.pid === hand.pid) ?? null;
}

// ---------------------------------------------------------------- geometry

/**
 * Positions for `n` tiles, stacked upward from the bottom-right corner of the
 * monitor. When a column would overflow the top, a new column starts to the
 * left. Coordinates are global logical pixels, which is what
 * `movewindowpixel exact` expects.
 */
export function tileRects(n: number, mon: Monitor, opts: PipOptions = {}): Rect[] {
  const o = { ...DEFAULTS, ...opts };
  const [rTop, rRight, rBottom, rLeft] = mon.reserved ?? [0, 0, 0, 0];
  const logicalW = mon.width / mon.scale;
  const logicalH = mon.height / mon.scale;
  const top = mon.y + rTop + o.margin;
  const bottom = mon.y + logicalH - rBottom - o.margin;
  const right = mon.x + logicalW - rRight - o.margin;
  const left = mon.x + rLeft + o.margin;

  const perColumn = Math.max(1, Math.floor((bottom - top + o.gap) / (o.h + o.gap)));
  const rects: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const col = Math.floor(i / perColumn);
    const row = i % perColumn;
    const x = right - o.w - col * (o.w + o.gap);
    const y = bottom - o.h - row * (o.h + o.gap);
    rects.push({ x: Math.max(left, Math.round(x)), y: Math.max(top, Math.round(y)), w: o.w, h: o.h });
  }
  return rects;
}

// ---------------------------------------------------------------- actions

/** Dispatcher commands that turn one window into a pinned tile at `r`. */
export function pipCommands(address: string, r: Rect): string[] {
  const win = `address:${address}`;
  return [
    `setfloating ${win}`,
    `pin ${win}`,
    `resizewindowpixel exact ${r.w} ${r.h},${win}`,
    `movewindowpixel exact ${r.x} ${r.y},${win}`,
  ];
}

/**
 * Lay every running hand out as a PIP tile on the focused monitor. Hands whose
 * window has not been mapped yet are skipped and reported.
 */
export async function layoutPip(
  hands: Hand[],
  opts: PipOptions = {},
  exec: Exec = defaultExec,
): Promise<{ placed: Hand[]; missing: Hand[] }> {
  const mons = await monitors(exec);
  const mon = mons.find((m) => m.focused) ?? mons[0];
  if (!mon) throw new Error("hyprctl reported no monitors");
  const all = await clients(exec);

  const placed: Hand[] = [];
  const missing: Hand[] = [];
  const commands: string[] = [];
  const rects = tileRects(hands.length, mon, opts);
  let slot = 0;
  for (const hand of hands) {
    const win = findHandWindow(hand, all);
    if (!win) {
      missing.push(hand);
      continue;
    }
    // un-fullscreen first so resize/move take effect
    if (win.fullscreen) commands.push(`focuswindow address:${win.address}`, `fullscreen 0`);
    commands.push(...pipCommands(win.address, rects[slot++]!));
    placed.push(hand);
  }
  await dispatchBatch(commands, exec);
  return { placed, missing };
}

/** Fullscreen a hand's window so the user can watch closely or take over. */
export async function swapTo(hand: Hand, exec: Exec = defaultExec): Promise<void> {
  const win = findHandWindow(hand, await clients(exec));
  if (!win) throw new Error(`hand ${hand.id} has no window yet`);
  const cmds = [`focuswindow address:${win.address}`];
  if (!win.fullscreen) cmds.push("fullscreen 0");
  await dispatchBatch(cmds, exec);
}

/** Leave fullscreen on whichever hand is currently swapped in. */
export async function swapBack(hands: Hand[], exec: Exec = defaultExec): Promise<void> {
  const all = await clients(exec);
  const cmds: string[] = [];
  for (const hand of hands) {
    const win = findHandWindow(hand, all);
    if (win?.fullscreen) cmds.push(`focuswindow address:${win.address}`, "fullscreen 0");
  }
  await dispatchBatch(cmds, exec);
}

// ---------------------------------------------------------------- CLI

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const hands = await listHands();
  switch (cmd) {
    case "layout": {
      const opt = (k: string) => {
        const v = rest.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
        return v ? Number(v) : undefined;
      };
      const { placed, missing } = await layoutPip(hands, {
        w: opt("w"),
        h: opt("h"),
        margin: opt("margin"),
        gap: opt("gap"),
      });
      console.log(`placed ${placed.map((h) => h.id).join(", ") || "none"}`);
      if (missing.length) console.log(`no window yet for hand ${missing.map((h) => h.id).join(", ")}`);
      return;
    }
    case "swap": {
      const id = Number(rest[0]);
      const hand = hands.find((h) => h.id === id);
      if (!hand) throw new Error(`no running hand ${rest[0]}`);
      await swapTo(hand);
      return;
    }
    case "back": {
      await swapBack(hands);
      return;
    }
    case "ls": {
      const all = await clients();
      for (const hand of hands) {
        const win = findHandWindow(hand, all);
        console.log(`hand ${hand.id}: ${win ? `${win.address} "${win.title}"` : "no window yet"}`);
      }
      return;
    }
    default:
      console.log(
        [
          "usage: bun pip.ts <command>",
          "  layout [--w=480] [--h=300] [--margin=16] [--gap=12]   pin hand windows as PIP tiles",
          "  swap <id>                                             fullscreen a hand",
          "  back                                                  leave fullscreen",
          "  ls                                                    show which hand owns which window",
        ].join("\n"),
      );
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
