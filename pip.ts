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
// CLI: bun pip.ts layout | toggle <id> | swap <id> | back | ls | bindings
//
// Requires: hyprctl (comes with Hyprland).

import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { defaultExec, HANDS_DIR, listHands, screenshot, themePalette, type Exec, type Hand, type Palette } from "./desktop";

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
  transform?: number;
  reserved?: [number, number, number, number]; // left, top, right, bottom (hyprctl order)
};

export type HyprClient = {
  address: string;
  pid: number;
  title: string;
  class: string;
  floating: boolean;
  pinned?: boolean;
  fullscreen: number | boolean;
  monitor: number;
  workspace?: { id: number; name: string };
  at?: [number, number];
  size?: [number, number];
  tags?: string[];
  focusHistoryID?: number;
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

/** What a hand is doing, as shown by its preview border. */
export type HandState = "idle" | "working" | "review" | "error";
export const HAND_STATES: readonly HandState[] = ["idle", "working", "review", "error"];
const TILE_ROUNDING = 12;
const TILE_BORDER = 2;
const IDLE_WORKSPACE = "special:puk-idle";

type WindowRef = Pick<HyprClient, "address" | "pid">;
export type SwapState = {
  active: WindowRef & { rect: Rect };
  previous?: WindowRef;
};
export type StateStore = {
  read(): Promise<SwapState | null>;
  write(state: SwapState | null): Promise<void>;
};

const stateFile = join(HANDS_DIR, "pip.json");
const session = process.env.HYPRLAND_INSTANCE_SIGNATURE ?? "";
const diskState: StateStore = {
  async read() {
    try {
      const saved = await Bun.file(stateFile).json();
      return saved.session === session && saved.active?.rect ? saved : null;
    } catch { return null; }
  },
  async write(state) {
    if (!state) { await rm(stateFile, { force: true }); return; }
    await mkdir(HANDS_DIR, { recursive: true });
    const tmp = `${stateFile}.${process.pid}`;
    await Bun.write(tmp, JSON.stringify({ ...state, session }));
    await rename(tmp, stateFile);
  },
};

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
  const reply = await hyprctl(["--batch", commands.map((c) => `dispatch ${c}`).join("; ")], exec);
  // A batch can exit successfully even when one dispatcher reports an error.
  const errors = reply.split("\n").map((line) => line.trim()).filter((line) => line && line !== "ok");
  if (errors.length) throw new Error(`Hyprland rejected the layout: ${errors.join("; ")}`);
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
 * Hyprland's absolute window-move dispatcher expects.
 */
export function tileRects(n: number, mon: Monitor, opts: PipOptions = {}, occupied: Rect[] = []): Rect[] {
  const o = {
    w: opts.w ?? DEFAULTS.w,
    h: opts.h ?? DEFAULTS.h,
    margin: opts.margin ?? DEFAULTS.margin,
    gap: opts.gap ?? DEFAULTS.gap,
  };
  if (!Number.isInteger(n) || n < 0) throw new Error("tile count must be a non-negative integer");
  for (const [name, value] of Object.entries(o)) {
    if (!Number.isFinite(value) || value < (name === "w" || name === "h" ? 1 : 0)) {
      throw new Error(`invalid PIP ${name}: ${value}`);
    }
  }
  if (n === 0) return [];
  const [rLeft, rTop, rRight, rBottom] = mon.reserved ?? [0, 0, 0, 0];
  const rotated = (mon.transform ?? 0) % 2 === 1;
  const logicalW = (rotated ? mon.height : mon.width) / mon.scale;
  const logicalH = (rotated ? mon.width : mon.height) / mon.scale;
  const top = mon.y + rTop + o.margin;
  const bottom = mon.y + logicalH - rBottom - o.margin;
  const right = mon.x + logicalW - rRight - o.margin;
  const left = mon.x + rLeft + o.margin;

  o.w = Math.min(Math.round(o.w), Math.floor(right - left));
  o.h = Math.min(Math.round(o.h), Math.floor(bottom - top));
  if (o.w < 1 || o.h < 1) throw new Error("monitor has no space for PIP tiles with these margins");

  const perColumn = Math.max(1, Math.floor((bottom - top + o.gap) / (o.h + o.gap)));
  const columns = Math.floor((right - left + o.gap) / (o.w + o.gap));
  if (n > columns * perColumn) throw new Error("PIP tiles do not fit; use smaller --w and --h values");
  const rects: Rect[] = [];
  for (let i = 0; i < columns * perColumn && rects.length < n; i++) {
    const col = Math.floor(i / perColumn);
    const row = i % perColumn;
    const x = right - o.w - col * (o.w + o.gap);
    const y = bottom - o.h - row * (o.h + o.gap);
    const rect = { x: Math.max(left, Math.round(x)), y: Math.max(top, Math.round(y)), w: o.w, h: o.h };
    if (!occupied.some((r) => rect.x < r.x + r.w + o.gap && rect.x + rect.w + o.gap > r.x
      && rect.y < r.y + r.h + o.gap && rect.y + rect.h + o.gap > r.y)) rects.push(rect);
  }
  if (rects.length < n) throw new Error("PIP tiles do not fit around existing previews; move or resize them, or run bun pip.ts layout");
  return rects;
}

// ---------------------------------------------------------------- actions

function selector(address: string): string {
  if (!/^0x[0-9a-f]+$/i.test(address)) throw new Error("invalid Hyprland window address");
  return `window="address:${address}"`;
}

function fullscreen(address: string, enabled: boolean): string {
  const mode = enabled ? 2 : 0;
  return `hl.dsp.window.fullscreen_state({${selector(address)},action="set",internal=${mode},client=${mode}})`;
}

function focus(address: string): string {
  return `hl.dsp.focus({${selector(address)}})`;
}

function matches(all: HyprClient[], ref?: WindowRef): HyprClient | undefined {
  return ref && all.find((w) => w.address === ref.address && w.pid === ref.pid);
}

function previewRect(win: HyprClient): Rect | undefined {
  if (!win.fullscreen && win.floating && (win.pinned || isParked(win)) && win.at && win.size) {
    return { x: win.at[0], y: win.at[1], w: win.size[0], h: win.size[1] };
  }
}

function isParked(win: HyprClient) {
  return win.workspace?.name === IDLE_WORKSPACE;
}

async function revealCommands(win: HyprClient, exec: Exec): Promise<string[]> {
  if (!isParked(win)) return [];
  const workspace = JSON.parse(await hyprctl(["activeworkspace", "-j"], exec)) as { id?: number };
  if (!Number.isSafeInteger(workspace.id) || workspace.id! <= 0) throw new Error("No regular workspace is available for the hand.");
  return [`hl.dsp.window.move({${selector(win.address)},workspace="${workspace.id}",follow=false})`];
}

const previewPath = (hand: Hand) => join(HANDS_DIR, `hand-${hand.id}-${hand.pid}.preview.png`);
const pendingPreviews = new Map<number, Promise<Uint8Array>>();
async function capturePreview(hand: Hand): Promise<Uint8Array> {
  const pending = pendingPreviews.get(hand.pid);
  if (pending) return pending;
  const capturing = (async () => {
    const bytes = await screenshot(hand);
    const temporary = `${previewPath(hand)}.${process.pid}.tmp`;
    try {
      await Bun.write(temporary, bytes);
      await rename(temporary, previewPath(hand));
    } finally { await rm(temporary, { force: true }); }
    return bytes;
  })().finally(() => { pendingPreviews.delete(hand.pid); });
  pendingPreviews.set(hand.pid, capturing);
  return capturing;
}

/** Hidden nested outputs stop producing frames. Serve the last visible frame
 * instead of leaving a grim process waiting for each panel refresh. */
export async function previewScreenshot(hand: Hand): Promise<Uint8Array> {
  const win = findHandWindow(hand, await clients());
  if (!win) throw new Error("The desktop is unavailable.");
  if (!isParked(win)) {
    try { return await capturePreview(hand); }
    catch { /* An occluded output may not produce a new frame. */ }
  }
  return Bun.file(previewPath(hand)).bytes();
}

function hyprColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`invalid palette color: ${hex}`);
  return m[1]!.toLowerCase();
}

/**
 * Border and opacity for a hand's state. Idle previews sit back slightly and
 * carry a muted border; a working hand glows with the theme accent, a hand
 * waiting on the user turns amber, and a failed one red. Fullscreen hides the
 * border, so the state is only visible while the hand is a preview.
 */
export function handLookCommands(address: string, state: HandState, palette: Palette = themePalette.fallback): string[] {
  const win = selector(address);
  if (!HAND_STATES.includes(state)) throw new Error(`unknown hand state: ${state}`);
  const border = {
    idle: `rgba(${hyprColor(palette.muted)}cc)`,
    working: `rgb(${hyprColor(palette.accent)}) rgb(${hyprColor(palette.green)}) 45deg`,
    review: `rgb(${hyprColor(palette.yellow)})`,
    error: `rgb(${hyprColor(palette.red)})`,
  }[state];
  const opacity = state === "idle" ? "0.92" : "1";
  return [
    `hl.dsp.window.set_prop({${win},prop="active_border_color",value="${border}"})`,
    `hl.dsp.window.set_prop({${win},prop="inactive_border_color",value="${border}"})`,
    `hl.dsp.window.set_prop({${win},prop="opacity",value="${opacity} override ${opacity} override 1 override"})`,
  ];
}

/** Explicit states make repeated layout calls safe; no toggle dispatchers. */
export function pipCommands(address: string, r: Rect, palette: Palette = themePalette.fallback, visible = true): string[] {
  const win = selector(address);
  if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w < 1 || r.h < 1) throw new Error("invalid PIP rectangle");
  return [
    fullscreen(address, false),
    `hl.dsp.window.float({${win},action="enable"})`,
    `hl.dsp.window.pin({${win},action="${visible ? "enable" : "disable"}"})`,
    `hl.dsp.window.tag({${win},tag="+puk-hand"})`,
    `hl.dsp.window.set_prop({${win},prop="no_follow_mouse",value="1"})`,
    `hl.dsp.window.set_prop({${win},prop="rounding",value="${TILE_ROUNDING}"})`,
    `hl.dsp.window.set_prop({${win},prop="border_size",value="${TILE_BORDER}"})`,
    `hl.dsp.window.set_prop({${win},prop="keep_aspect_ratio",value="1"})`,
    `hl.dsp.window.set_prop({${win},prop="no_dim",value="1"})`,
    ...handLookCommands(address, "idle", palette),
    `hl.dsp.window.resize({${win},x=${r.w},y=${r.h},relative=false})`,
    `hl.dsp.window.move({${win},x=${r.x},y=${r.y},relative=false})`,
  ];
}

/**
 * Show previews for active work and park idle ones without stopping their apps.
 * Share the transition lock so a state update cannot hide a manual fullscreen view.
 */
export async function setHandState(hand: Hand, state: HandState, exec: Exec = defaultExec): Promise<boolean> {
  if (!HAND_STATES.includes(state)) throw new Error(`unknown hand state: ${state}`);
  if (exec === defaultExec) {
    const output = await lockedPip(["state", String(hand.id), state, `--pid=${hand.pid}`, "--locked"]);
    return JSON.parse(output) === true;
  }
  return applyHandState(hand, state, exec);
}

async function applyHandState(hand: Hand, state: HandState, exec: Exec): Promise<boolean> {
  const [all, palette] = await Promise.all([clients(exec), themePalette()]);
  const win = findHandWindow(hand, all);
  if (!win || win.fullscreen) return false;
  if (state === "working" || state === "review") {
    const commands = await revealCommands(win, exec);
    if (isParked(win)) commands.push(`hl.dsp.window.pin({${selector(win.address)},action="enable"})`);
    await dispatchBatch([...commands, ...handLookCommands(win.address, state, palette)], exec);
  } else if (!isParked(win)) {
    if (exec === defaultExec) {
      await capturePreview(hand).catch(() => {});
      const current = findHandWindow(hand, await clients(exec));
      if (!current || current.address !== win.address || current.fullscreen) return false;
    }
    await dispatchBatch([
      `hl.dsp.window.pin({${selector(win.address)},action="disable"})`,
      `hl.dsp.window.move({${selector(win.address)},workspace="${IDLE_WORKSPACE}",follow=false})`,
    ], exec);
  }
  return true;
}

/**
 * Lay every running hand out as a PIP tile on the focused monitor. Hands whose
 * window has not been mapped yet are skipped and reported. Startup preserves
 * adjusted previews and open desktops; explicit arrangement resets the layout.
 */
export async function layoutPip(
  hands: Hand[],
  opts: PipOptions & { preserve?: boolean } = {},
  exec: Exec = defaultExec,
  store: StateStore = diskState,
): Promise<{ placed: Hand[]; missing: Hand[] }> {
  const [mons, all, saved, palette] = await Promise.all([monitors(exec), clients(exec), store.read(), themePalette()]);
  const mon = mons.find((m) => m.focused) ?? mons[0];
  if (!mon) throw new Error("hyprctl reported no monitors");

  const placed: Hand[] = [];
  const missing: Hand[] = [];
  const commands: string[] = [];
  const mapped = hands.flatMap((hand) => findHandWindow(hand, all) ?? []);
  const kept = opts.preserve ? mapped.filter((win) => win.fullscreen || previewRect(win)) : [];
  const occupied = kept.flatMap((win) => previewRect(win)
    ?? (win === matches(all, saved?.active) ? [saved!.active.rect] : []));
  const rects = tileRects(mapped.length - kept.length, mon, opts, occupied);
  let slot = 0;
  for (const hand of hands) {
    const win = findHandWindow(hand, all);
    if (!win) {
      missing.push(hand);
      continue;
    }
    if (!kept.includes(win)) commands.push(...pipCommands(win.address, rects[slot++]!, palette, !isParked(win)));
    placed.push(hand);
  }
  const previous = !opts.preserve && matches(all, saved?.previous);
  if (previous) commands.push(focus(previous.address));
  await dispatchBatch(commands, exec);
  if (!opts.preserve) await store.write(null);
  return { placed, missing };
}

/** Fullscreen a hand's window so the user can watch closely or take over. */
export async function swapTo(hand: Hand, exec: Exec = defaultExec, store: StateStore = diskState): Promise<void> {
  const [all, saved, active, palette] = await Promise.all([
    clients(exec), store.read(),
    hyprctl(["activewindow", "-j"], exec).then((json) => JSON.parse(json) as HyprClient),
    themePalette(),
  ]);
  const win = findHandWindow(hand, all);
  if (!win) throw new Error(`hand ${hand.id} has no window yet`);
  const old = matches(all, saved?.active);
  const isHand = (w: HyprClient) => w.pid === hand.pid || w.address === old?.address || w.tags?.some((t) => t.replace(/\*$/, "") === "puk-hand");
  const previous = (active.address && !isHand(active) ? matches(all, active) : undefined)
    ?? matches(all, saved?.previous)
    ?? all.filter((w) => !isHand(w) && (w.focusHistoryID ?? -1) >= 0).sort((a, b) => a.focusHistoryID! - b.focusHistoryID!)[0];
  let rect = old?.address === win.address ? saved!.active.rect : previewRect(win);
  if (!rect) {
    const mons = await monitors(exec);
    const mon = mons.find((m) => m.focused) ?? mons[0];
    if (!mon) throw new Error("hyprctl reported no monitors");
    rect = tileRects(1, mon)[0]!;
  }
  const cmds: string[] = [];
  if (old && old.address !== win.address) cmds.push(...pipCommands(old.address, saved!.active.rect, palette));
  cmds.push(...await revealCommands(win, exec));
  cmds.push(
    `hl.dsp.window.pin({${selector(win.address)},action="disable"})`,
    focus(win.address),
    fullscreen(win.address, true),
  );
  // Persist before dispatch so `back` can recover even if a later command fails.
  await store.write({ active: { address: win.address, pid: win.pid, rect }, previous: previous && { address: previous.address, pid: previous.pid } });
  await dispatchBatch(cmds, exec);
}

/** Restore the tile and the user's previous window, including after switching hands. */
export async function swapBack(hands: Hand[], exec: Exec = defaultExec, store: StateStore = diskState): Promise<void> {
  const [all, saved, palette] = await Promise.all([clients(exec), store.read(), themePalette()]);
  const cmds: string[] = [];
  const old = matches(all, saved?.active);
  if (old) cmds.push(...pipCommands(old.address, saved!.active.rect, palette));
  for (const [index, hand] of hands.entries()) {
    const win = findHandWindow(hand, all);
    if (win?.fullscreen && win.address !== old?.address) {
      const mons = await monitors(exec);
      const mon = mons.find((m) => m.focused) ?? mons[0];
      if (!mon) throw new Error("hyprctl reported no monitors");
      cmds.push(...pipCommands(win.address, tileRects(hands.length, mon)[index]!, palette));
    }
  }
  const previous = matches(all, saved?.previous);
  if (previous) cmds.push(focus(previous.address));
  await dispatchBatch(cmds, exec);
  await store.write(null);
}

export async function toggleHand(hand: Hand, hands: Hand[], exec: Exec = defaultExec, store: StateStore = diskState): Promise<void> {
  if (findHandWindow(hand, await clients(exec))?.fullscreen) await swapBack(hands, exec, store);
  else await swapTo(hand, exec, store);
}

/** UI and desktop-bar requests share the keybindings' cross-process lock. */
export async function runPip(command: "swap" | "back" | "layout", id?: number): Promise<void> {
  await lockedPip([command, ...(id === undefined ? [] : [String(id)])]);
}

async function lockedPip(args: string[]): Promise<string> {
  const result = await defaultExec(["flock", "-w", "5", join(HANDS_DIR, "pip.lock"), process.execPath, import.meta.path, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Desktop transition failed.");
  return new TextDecoder().decode(result.stdout).trim();
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
    case "enter-pid":
    case "toggle":
    case "swap": {
      const id = Number(rest[0]);
      const hand = hands.find((h) => cmd === "enter-pid" ? h.pid === id : h.id === id);
      if (!hand) throw new Error(`no running hand ${rest[0]}`);
      if (cmd === "toggle") await toggleHand(hand, hands);
      else await swapTo(hand);
      return;
    }
    case "back": {
      await swapBack(hands);
      return;
    }
    case "state": {
      const id = Number(rest[0]);
      const state = rest[1] as HandState;
      const hand = hands.find((h) => h.id === id);
      if (rest.includes("--locked")) {
        const pid = Number(rest.find((arg) => arg.startsWith("--pid="))?.slice(6));
        if (!HAND_STATES.includes(state)) throw new Error("Invalid hand state");
        console.log(Boolean(hand && hand.pid === pid && await applyHandState(hand, state, defaultExec)));
        return;
      }
      if (!hand) throw new Error(`no running hand ${rest[0]}`);
      if (!HAND_STATES.includes(state)) throw new Error(`state must be one of ${HAND_STATES.join(", ")}`);
      console.log((await setHandState(hand, state)) ? `hand ${id}: ${state}` : `hand ${id} has no preview to recolor`);
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
    case "bindings": {
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
      // flock serializes fast key presses across separate CLI processes.
      const run = `flock -w 5 ${quote(join(HANDS_DIR, "pip.lock"))} ${quote(process.execPath)} ${quote(import.meta.path)}`;
      for (let id = 1; id <= 3; id++) console.log(`o.bind("CTRL + ALT + ${id}", "Puk: enter/return hand ${id}", ${JSON.stringify(`${run} toggle ${id}`)})`);
      console.log(`o.bind("CTRL + ALT + 0", "Puk: return to desktop", ${JSON.stringify(`${run} back`)})`);
      console.log(`o.bind("CTRL + ALT + P", "Puk: arrange previews", ${JSON.stringify(`${run} layout`)})`);
      const port = Number(process.env.PUK_PORT ?? 7777);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PUK_PORT");
      const post = (path: string) => `curl --fail --silent --show-error --max-time 2 --request POST http://127.0.0.1:${port}${path} >/dev/null`;
      console.log(`o.bind("F8", "Puk: hold to speak", ${JSON.stringify(post("/hotkey/down"))})`);
      console.log(`o.bind("F8", "Puk: release to send", ${JSON.stringify(post("/hotkey/up"))}, { release = true })`);
      console.log(`o.bind("CTRL + ALT + ESCAPE", "Puk: stop recording and agent", ${JSON.stringify(post("/stop"))})`);
      console.log([
        '-- A preview click opens the desktop without clicking the app underneath.',
        'hl.bind("mouse:272", function()',
        '  local cursor = hl.get_cursor_pos()',
        '  for _, window in ipairs(hl.get_windows({ tag = "puk-hand" })) do',
        '    local at, size = window.at, window.size',
        '    if window.visible and window.pinned and window.fullscreen == 0',
        '      and cursor.x >= at.x and cursor.x < at.x + size.x',
        '      and cursor.y >= at.y and cursor.y < at.y + size.y then',
        `      hl.dispatch(hl.dsp.exec_cmd(${JSON.stringify(`${run} enter-pid `)} .. tostring(window.pid)))`,
        '      return { ok = true }',
        '    end',
        '  end',
        '  return { ok = false }',
        'end, { auto_consuming = true, description = "Puk: open a preview" })',
      ].join("\n"));
      return;
    }
    default:
      console.log(
        [
          "usage: bun pip.ts <command>",
          "  layout [--w=480] [--h=300] [--margin=16] [--gap=12]   pin hand windows as PIP tiles",
          "  swap <id>                                             fullscreen a hand",
          "  toggle <id>                                           enter a hand; press again to return",
          "  back                                                  restore PIP and previous window",
          "  state <id> idle|working|review|error                  recolor a preview's border",
          "  ls                                                    show which hand owns which window",
          "  bindings                                              print Omarchy Lua shortcuts",
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
