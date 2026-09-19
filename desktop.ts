// desktop.ts — one isolated desktop per "hand".
//
// Each hand is a nested `sway` compositor started with the Wayland backend from
// inside the user's session (Hyprland on Omarchy). It shows up as an ordinary
// window, has its own seat, runs the user's real apps as the user, and only
// sees input we inject through `wlrctl` / `wtype` against its own socket.
//
//   startHand(1)            spawn nested sway, learn its WAYLAND_DISPLAY
//   screenshot(hand)        PNG bytes via grim
//   click / typeText / ...  input via wlr-virtual-pointer + virtual-keyboard
//   launch / launchBrowser  run an app inside the hand
//   stopHand / listHands    lifecycle + registry in $XDG_RUNTIME_DIR/hands
//
// CLI: bun desktop.ts up [n] | down | ls | shot <id> [file] | click <id> x y
//      | move <id> x y | scroll <id> x y dy | type <id> text | key <id> combo
//      | run <id> cmd...
//
// Requires: sway grim wtype wlrctl   (pacman -S sway grim wtype wlrctl)

import { mkdir, readdir, rm, cp, rename } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv, AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

// ---------------------------------------------------------------- types

export const HandSchema = z.object({
  id: z.int().positive(),
  /** pid of the nested sway process. Hyprland reports it on the window. */
  pid: z.int().positive(),
  /** nested Wayland socket name, e.g. "wayland-1" */
  display: z.string().regex(/^wayland-\d+$/),
  /**
   * Logical desktop size. The nested bar keeps the output scaled so this stays
   * constant while the Hyprland window is a preview tile or fullscreen.
   */
  width: z.int().min(1).max(8192),
  height: z.int().min(1).max(8192),
});
export type Hand = z.infer<typeof HandSchema>;

export type ExecResult = { exitCode: number; stdout: Uint8Array; stderr: string };
export type Exec = (argv: string[], opts?: { env?: Record<string, string>; signal?: AbortSignal }) => Promise<ExecResult>;

export type MouseButton = "left" | "right" | "middle";

// ---------------------------------------------------------------- config

const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
/** Registry of running hands. One JSON file per hand. */
export const HANDS_DIR = join(RUNTIME_DIR, "hands");
/** Per-hand browser profiles (copies of the user's, so logins carry over). */
export const PROFILES_DIR = join(homedir(), ".hands");

// ---------------------------------------------------------------- theme

/** Colors shared by the nested bar, tab strip and preview borders. */
export type Palette = {
  background: string; lighterBackground: string; foreground: string; mutedForeground: string;
  muted: string; accent: string; green: string; yellow: string; red: string;
};
const FALLBACK_PALETTE: Palette = {
  background: "#1a1b26", lighterBackground: "#24283b", foreground: "#c0caf5", mutedForeground: "#565f89",
  muted: "#414868", accent: "#7aa2f7", green: "#9ece6a", yellow: "#e0af68", red: "#f7768e",
};
const PALETTE_KEYS: Record<keyof Palette, string> = {
  background: "background", lighterBackground: "lighter_background", foreground: "bright_foreground", mutedForeground: "dark_foreground",
  muted: "muted", accent: "accent", green: "green", yellow: "yellow", red: "red",
};

/** Colors from an Omarchy `colors.toml`; unknown or malformed keys keep the fallback. */
export function parsePalette(toml: string, fallback: Palette = FALLBACK_PALETTE): Palette {
  const values = new Map<string, string>();
  for (const match of toml.matchAll(/^\s*([a-z_]+)\s*=\s*"(#[0-9a-fA-F]{6})"/gm)) values.set(match[1]!, match[2]!.toLowerCase());
  const palette = { ...fallback };
  for (const [key, name] of Object.entries(PALETTE_KEYS) as [keyof Palette, string][]) {
    const value = values.get(name);
    if (value) palette[key] = value;
  }
  return palette;
}

let paletteCache: Promise<Palette> | undefined;
/** The active Omarchy theme's palette, read once per process. Falls back to Tokyo Night. */
export async function themePalette(): Promise<Palette> {
  return paletteCache ??= (async () => {
    try {
      const state = join(homedir(), ".local/state/omarchy/current");
      const slug = (await Bun.file(join(state, "theme.name")).text()).trim();
      const candidates = [join(state, "theme/colors.toml")];
      if (/^[a-z0-9-]+$/.test(slug)) {
        candidates.push(join(homedir(), ".config/omarchy/themes", slug, "colors.toml"), join("/usr/share/omarchy/themes", slug, "colors.toml"));
      }
      for (const file of candidates) {
        if (await Bun.file(file).exists()) return parsePalette(await Bun.file(file).text());
      }
    } catch { /* No Omarchy theme: use the fallback. */ }
    return FALLBACK_PALETTE;
  })();
}
themePalette.fallback = FALLBACK_PALETTE;

const START_TIMEOUT_MS = 10_000;
const PACKAGE_FOR_BINARY: Record<string, string> = {
  sway: "sway",
  grim: "grim",
  wtype: "wtype",
  wlrctl: "wlrctl",
};

// Unknown key names added to .env must be private too. Keep only names here;
// values are read from the active environment when scrubbing output/processes.
const privateEnvNames = new Set(["OAI", "ANT", "GEMINI", "JEV", "jev_key"]);
const publicConfig = /^(?:PUK_(?:PORT|PROVIDER|HAND|MICROPHONE|DEBUG)|TRANSCRIBE_MODEL|JEV_MODEL|GEMINI_BACKEND|(?:OPENAI|ANTHROPIC|GEMINI)(?:_COMPLEX)?_MODEL)$/;
for (const dir of new Set([process.cwd(), import.meta.dir])) {
  try {
    for (const file of readdirSync(dir).filter((name) => /^\.env(?:\.[\w.-]+)?$/.test(name) && !/\.(?:example|sample)$/.test(name))) {
      for (const match of readFileSync(join(dir, file), "utf8").matchAll(/^\s*(?:export\s+)?([\w]+)\s*=/gm)) {
        if (!publicConfig.test(match[1]!)) privateEnvNames.add(match[1]!);
      }
    }
  } catch { /* A missing .env is fine; exported credential names are also handled. */ }
}
const isPrivateEnv = (name: string) => privateEnvNames.has(name)
  || /(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PRIVATE_?KEY|CREDENTIALS?)(?:_|$)/i.test(name);
const explicitSecrets = new Set<string>();
export function rememberSecret(value?: string) {
  if (value?.trim() && value.trim().length >= 6) explicitSecrets.add(value.trim());
}

export function redact(text: string): string {
  const secrets = new Set([...explicitSecrets, ...Object.entries(process.env).filter(([name]) => isPrivateEnv(name)).map(([, value]) => value?.trim() ?? "")]);
  for (const secret of [...secrets].filter((value) => value.length >= 6).sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(secret, "[redacted]").replaceAll(JSON.stringify(secret).slice(1, -1), "[redacted]");
  }
  return text;
}

export function debugLog(scope: string, detail: unknown) {
  if (process.env.PUK_DEBUG === "1") console.error(redact(JSON.stringify({ time: new Date().toISOString(), scope, detail })).slice(0, 16_000));
}

/** Keep .env secrets and exported credentials out of GUI apps and Bash. */
export function subprocessEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && !isPrivateEnv(name))) as Record<string, string>;
}

/** Arch's sway has CAP_SYS_NICE. A nested desktop does not need realtime scheduling. */
export function swayCommand(config: string, dropPrivileges = Boolean(Bun.which("setpriv"))): string[] {
  return [...(dropPrivileges ? ["setpriv", "--no-new-privs"] : []), "sway", "-c", config];
}

// ---------------------------------------------------------------- exec seam

/** Runs a command and collects its output. Tests replace this with a fake. */
export const defaultExec: Exec = async (argv, opts) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      env: { ...subprocessEnv(), ...opts?.env },
      signal: opts?.signal,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    throw missingBinary(argv[0]!, err);
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).bytes(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

function missingBinary(bin: string, err: unknown): Error {
  const pkg = PACKAGE_FOR_BINARY[bin];
  if (pkg && !Bun.which(bin)) {
    return new Error(`"${bin}" is not installed. Install it with: sudo pacman -S ${pkg}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function run(exec: Exec, argv: string[], env?: Record<string, string>): Promise<ExecResult> {
  const res = await exec(argv, { env });
  if (res.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
  }
  return res;
}

function handEnv(hand: Hand): Record<string, string> {
  return { WAYLAND_DISPLAY: hand.display };
}

// ---------------------------------------------------------------- lifecycle

/** The sway config a hand boots with. Exported for tests. */
export function swayConfig(opts: { width: number; height: number; displayFile: string; handId?: number; palette?: Palette }): string {
  const p = opts.palette ?? FALLBACK_PALETTE;
  return [
    `# generated by hands/desktop.ts`,
    `xwayland disable`,
    `swaybg_command -`,
    `output * mode ${opts.width}x${opts.height}`,
    `output * scale 1`,
    `output * bg ${p.background} solid_color`,
    `font pango:${BAR_FONT} 10`,
    `default_border none`,
    `titlebar_padding 12 5`,
    `title_align center`,
    `# Tab strip: accent underline on the active app, quiet tabs elsewhere.`,
    `client.focused ${p.accent} ${p.lighterBackground} ${p.foreground} ${p.accent} ${p.accent}`,
    `client.focused_inactive ${p.background} ${p.background} ${p.mutedForeground} ${p.background} ${p.background}`,
    `client.unfocused ${p.background} ${p.background} ${p.mutedForeground} ${p.background} ${p.background}`,
    `workspace_layout tabbed`,
    `focus_follows_mouse no`,
    ...(opts.handId ? [
      `bar {`,
      `  position top`,
      `  font pango:${BAR_FONT} 10`,
      `  height 30`,
      `  status_padding 0`,
      `  workspace_buttons no`,
      `  tray_output none`,
      `  colors {`,
      `    background ${p.background}`,
      `    statusline ${p.foreground}`,
      `    separator ${p.background}`,
      `  }`,
      `  status_command ${shellQuote(process.execPath)} ${shellQuote(import.meta.path)} panel ${opts.handId}`,
      `}`,
    ] : []),
    `# Tell the outer world which Wayland socket this hand listens on.`,
    `exec echo "$WAYLAND_DISPLAY" > ${shellQuote(opts.displayFile)}`,
    ``,
  ].join("\n");
}

const BAR_FONT = "JetBrainsMono Nerd Font, sans-serif";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function registryPath(id: number) {
  return join(HANDS_DIR, `hand-${id}.json`);
}

/**
 * Start a nested desktop for hand `id`. Resolves once the nested compositor
 * has reported its socket name, so the returned Hand is immediately usable.
 */
export async function startHand(
  id: number,
  opts: { width?: number; height?: number; env?: Record<string, string> } = {},
): Promise<Hand> {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 800;
  if (!Number.isInteger(id) || id < 1) throw new Error("hand id must be a positive integer");
  if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 8192)) {
    throw new Error("hand dimensions must be integers between 1 and 8192");
  }
  await mkdir(HANDS_DIR, { recursive: true });

  const existing = await getHand(id);
  if (existing) throw new Error(`hand ${id} is already running (pid ${existing.pid})`);

  const displayFile = join(HANDS_DIR, `hand-${id}.display`);
  const confFile = join(HANDS_DIR, `hand-${id}.conf`);
  const logFile = join(HANDS_DIR, `hand-${id}.log`);
  await rm(displayFile, { force: true });
  await Bun.write(confFile, swayConfig({ width, height, displayFile, handId: id, palette: await themePalette() }));
  await Bun.write(logFile, "");

  if (!Bun.which("sway")) throw missingBinary("sway", new Error("sway not found"));
  const proc = Bun.spawn(swayCommand(confFile), {
    env: {
      ...subprocessEnv(),
      WLR_BACKENDS: "wayland", // run as a window inside the outer compositor
      WLR_WL_OUTPUTS: "1",
      ...opts.env,
    },
    stdin: "ignore",
    stdout: Bun.file(logFile),
    stderr: Bun.file(logFile),
    detached: true,
  });
  proc.unref(); // let the CLI exit while the hand keeps running

  const deadline = Date.now() + START_TIMEOUT_MS;
  let display = "";
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) break;
    const f = Bun.file(displayFile);
    if (await f.exists()) {
      display = (await f.text()).trim();
      if (display) break;
    }
    await Bun.sleep(100);
  }
  if (!display) {
    const reason = proc.signalCode ? `exited with ${proc.signalCode}`
      : proc.exitCode !== null ? `exited with code ${proc.exitCode}`
      : `did not come up within ${START_TIMEOUT_MS}ms`;
    proc.kill();
    const log = (await Bun.file(logFile).exists()) ? await Bun.file(logFile).text() : "";
    throw new Error(`hand ${id}: nested sway ${reason}\n${log.slice(-800)}`);
  }

  const hand: Hand = { id, pid: proc.pid, display, width, height };
  const temporary = `${registryPath(id)}.${proc.pid}.tmp`;
  try {
    await Bun.write(temporary, JSON.stringify(hand));
    await rename(temporary, registryPath(id));
  } catch (error) {
    proc.kill();
    throw error;
  } finally { await rm(temporary, { force: true }); }
  return hand;
}

/** Kill a hand's compositor (and everything running inside it). */
export async function stopHand(hand: Hand): Promise<void> {
  try {
    process.kill(hand.pid, "SIGTERM");
  } catch {
    // already gone
  }
  await rm(registryPath(hand.id), { force: true });
  await rm(join(HANDS_DIR, `hand-${hand.id}.display`), { force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Running hands, sorted by id. Prunes registry entries whose process died. */
export async function listHands(directory = HANDS_DIR, alive: (pid: number) => boolean = isAlive): Promise<Hand[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const hands: Hand[] = [];
  for (const name of names) {
    if (!/^hand-\d+\.json$/.test(name)) continue;
    try {
      const file = join(directory, name);
      const parsed = HandSchema.safeParse(await Bun.file(file).json());
      if (!parsed.success || name !== `hand-${parsed.data.id}.json`) continue;
      if (alive(parsed.data.pid)) hands.push(parsed.data);
      else await rm(file, { force: true });
    } catch (error) { debugLog("desktop.registry", { file: name, error: error instanceof Error ? error.message : "Unreadable entry" }); }
  }
  return hands.sort((a, b) => a.id - b.id);
}

export async function getHand(id: number): Promise<Hand | null> {
  return (await listHands()).find((h) => h.id === id) ?? null;
}

// The agent uses the real Cua MCP server. Native helpers below remain useful
// for desktop lifecycle, the CLI, and Chi's standalone experiment.
export type CuaConnection = {
  call(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<Awaited<ReturnType<Client["callTool"]>>>;
  close(): Promise<void>;
};

export async function connectCua(hand: Hand): Promise<CuaConnection> {
  const command = Bun.which("cua-driver");
  if (!command) throw new Error("Install Cua Driver to enable computer use. See docs/omarchy-setup.md.");
  const current = await getHand(hand.id);
  if (current?.pid !== hand.pid || current.display !== hand.display) throw new Error("The agent desktop changed. Restart Puk to reconnect.");
  const client = new Client({ name: "puk", version: "0.1" }, {
    jsonSchemaValidator: new AjvJsonSchemaValidator(new Ajv({ strict: false, logger: false })),
  });
  const transport = new StdioClientTransport({
    command, args: ["mcp"], stderr: "pipe",
    // Cua 0.28.2 requires this opt-in for native Wayland. Never inherit the
    // host X11 display or connect to a shared host-driver daemon.
    env: appEnv(hand, { CUA_DRIVER_RS_ENABLE_WAYLAND: "1", CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" }),
  });
  transport.stderr?.on("data", (chunk) => debugLog("cua.stderr", String(chunk)));
  try {
    await client.connect(transport, { timeout: 10_000 });
    await client.listTools();
  } catch (error) { await client.close(); throw error; }
  return {
    async call(name, args = {}, signal) {
      signal?.throwIfAborted();
      const response = await client.callTool({ name, arguments: args }, { signal, timeout: 15_000 });
      if (response.isError) throw new Error(redact(response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")));
      return response;
    },
    close: () => client.close(),
  };
}

// ---------------------------------------------------------------- perception

/** PNG screenshot of the hand's whole desktop. `scale` < 1 shrinks it. */
export async function screenshot(
  hand: Hand,
  opts: { scale?: number; timeoutMs?: number } = {},
  exec: Exec = defaultExec,
): Promise<Uint8Array> {
  const argv = ["grim"];
  if (opts.scale && opts.scale !== 1) argv.push("-s", String(opts.scale));
  argv.push("-t", "png", "-");
  const res = await exec(argv, { env: handEnv(hand), signal: AbortSignal.timeout(opts.timeoutMs ?? 2000) });
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || "Desktop screenshot timed out or failed.");
  return res.stdout;
}

// ---------------------------------------------------------------- input

/**
 * Move the hand's cursor to absolute (x, y). `wlrctl pointer move` is relative,
 * so we first slam the cursor into the top-left corner (wlroots clamps to the
 * output) and then move by (x, y). The nested compositor has exactly one
 * output, which makes this exact.
 */
export async function moveMouse(hand: Hand, x: number, y: number, exec: Exec = defaultExec): Promise<void> {
  const env = handEnv(hand);
  await run(exec, ["wlrctl", "pointer", "move", "-100000", "-100000"], env);
  await run(exec, ["wlrctl", "pointer", "move", String(Math.round(x)), String(Math.round(y))], env);
}

export async function click(
  hand: Hand,
  x: number,
  y: number,
  opts: { button?: MouseButton; count?: number } = {},
  exec: Exec = defaultExec,
): Promise<void> {
  await moveMouse(hand, x, y, exec);
  const count = opts.count ?? 1;
  for (let i = 0; i < count; i++) {
    await run(exec, ["wlrctl", "pointer", "click", opts.button ?? "left"], handEnv(hand));
  }
}

/** Scroll at (x, y). Positive `dy` scrolls down, like a mouse wheel. */
export async function scroll(
  hand: Hand,
  x: number,
  y: number,
  dy: number,
  dx = 0,
  exec: Exec = defaultExec,
): Promise<void> {
  await moveMouse(hand, x, y, exec);
  await run(exec, ["wlrctl", "pointer", "scroll", String(dy), String(dx)], handEnv(hand));
}

/**
 * Delay before the first key event. A freshly created virtual keyboard can
 * race the compositor applying its keymap, which garbles the first
 * characters (seen once in testing). A short pause avoids it.
 */
const KEYMAP_SETTLE_MS = "40";

/** Removing wtype's virtual keyboard leaves Sway with no active keymap. Restore
 * the persistent keyboard so newly opened Chromium/Electron apps cannot receive
 * modifier events before their first keymap (a libxkbcommon null-state crash). */
async function restoreKeyboard(hand: Hand, exec: Exec) {
  const socket = join(RUNTIME_DIR, `sway-ipc.${process.getuid?.() ?? 1000}.${hand.pid}.sock`);
  await run(exec, ["swaymsg", "-s", socket, "input type:keyboard repeat_delay 600"], handEnv(hand));
}

/** Type literal text into whatever is focused inside the hand. */
export async function typeText(hand: Hand, text: string, exec: Exec = defaultExec): Promise<void> {
  if (!text) return;
  try { await run(exec, ["wtype", "-s", KEYMAP_SETTLE_MS, "-d", "8", "--", text], handEnv(hand)); }
  finally { await restoreKeyboard(hand, exec); }
}

const MODIFIERS: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  super: "logo",
  meta: "logo",
  cmd: "logo",
  win: "win",
  altgr: "altgr",
};

const KEY_NAMES: Record<string, string> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  insert: "Insert",
};

/** Turn "ctrl+shift+t" into wtype arguments. Exported for tests. */
export function keyComboToWtypeArgs(combo: string): string[] {
  const parts = combo
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error("empty key combo");
  const key = parts.pop()!;
  const mods = parts.map((m) => {
    const mod = MODIFIERS[m.toLowerCase()];
    if (!mod) throw new Error(`unknown modifier "${m}" in "${combo}"`);
    return mod;
  });
  const keyName = KEY_NAMES[key.toLowerCase()] ?? (key.length === 1 ? key : key[0]!.toUpperCase() + key.slice(1));
  const args: string[] = [];
  for (const m of mods) args.push("-M", m);
  args.push("-k", keyName);
  for (const m of [...mods].reverse()) args.push("-m", m);
  return args;
}

/** Press a key or chord, e.g. "Return", "ctrl+l", "ctrl+shift+t". */
export async function pressKey(hand: Hand, combo: string, exec: Exec = defaultExec): Promise<void> {
  try { await run(exec, ["wtype", "-s", KEYMAP_SETTLE_MS, ...keyComboToWtypeArgs(combo)], handEnv(hand)); }
  finally { await restoreKeyboard(hand, exec); }
}

// ---------------------------------------------------------------- apps

export type InstalledApp = { id: string; name: string; description: string; categories: string[]; argv: string[]; terminal: boolean; cwd?: string };

/** Parse desktop entry arguments without involving a shell. File/URL placeholders
 * are omitted for a plain app launch. Unknown field codes fail closed. */
export function desktopEntryArgs(value: string, fields: Record<string, string>, path: string): string[] {
  const decoded = value.replace(/\\([sntr\\])/g, (_, c: string) => ({ s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" })[c]!);
  const words: string[] = [];
  let word = "", quoted = false, started = false;
  for (let i = 0; i < decoded.length; i++) {
    const c = decoded[i]!;
    if (c === '"') { quoted = !quoted; started = true; }
    else if (c === "\\") { if (++i >= decoded.length) throw new Error("Trailing escape in desktop entry"); word += decoded[i]; started = true; }
    else if (/\s/.test(c) && !quoted) { if (started) words.push(word); word = ""; started = false; }
    else { word += c; started = true; }
  }
  if (quoted) throw new Error("Unclosed quote in desktop entry");
  if (started) words.push(word);
  return words.flatMap((arg) => {
    if (/^%[fFuUdDnNvm]$/.test(arg)) return [];
    if (arg === "%i") return fields.Icon ? ["--icon", fields.Icon] : [];
    if (arg === "%c") return [fields.Name ?? ""];
    if (arg === "%k") return [path];
    if (/%(?!%)/.test(arg.replace(/%%/g, ""))) throw new Error("Unsupported desktop entry field code");
    return [arg.replace(/%%/g, "%")];
  });
}

/** Discover the machine's app catalog, including user overrides. Desktop entry
 * names/descriptions are data for the agent, never instructions. */
export async function discoverApps(roots?: string[]): Promise<InstalledApp[]> {
  roots ??= [process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), ...(process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":")].map((root) => join(root, "applications"));
  const found = new Map<string, InstalledApp | null>();
  async function scan(root: string, relative = "", depth = 0) {
    if (depth > 5) return;
    const entries = await readdir(join(root, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const rel = join(relative, entry.name), path = join(root, rel);
      if (entry.isDirectory()) { await scan(root, rel, depth + 1); continue; }
      if (!entry.name.endsWith(".desktop")) continue;
      const id = rel.replaceAll("/", "-");
      if (found.has(id)) continue;
      found.set(id, null); // Hidden user entries also mask a system entry.
      try {
        const file = Bun.file(path);
        if (file.size > 128_000) continue;
        const fields: Record<string, string> = {};
        let section = "";
        for (const line of (await file.text()).split(/\r?\n/)) {
          if (line.startsWith("[")) section = line.trim();
          else if (section === "[Desktop Entry]" && !line.startsWith("#")) {
            const at = line.indexOf("=");
            if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1).trim();
          }
        }
        if (fields.Type !== "Application" || fields.Hidden === "true" || fields.NoDisplay === "true" || !fields.Name || !fields.Exec) continue;
        if (fields.TryExec && !Bun.which(fields.TryExec)) continue;
        const argv = desktopEntryArgs(fields.Exec, fields, path);
        if (!argv[0] || !Bun.which(argv[0])) continue;
        found.set(id, { id, name: fields.Name, description: [fields.GenericName, fields.Comment, fields.Keywords?.replaceAll(";", ", ")].filter(Boolean).join(" — "), categories: (fields.Categories ?? "").split(";").filter(Boolean), argv, terminal: fields.Terminal === "true", ...(fields.Path ? { cwd: fields.Path } : {}) });
      } catch { /* An invalid launcher does not prevent discovering other apps. */ }
    }
  }
  for (const root of roots) await scan(root);
  return [...found.values()].filter((app): app is InstalledApp => app !== null).sort((a, b) => a.name.localeCompare(b.name));
}

export async function launchInstalledApp(hand: Hand, app: InstalledApp): Promise<number> {
  const bin = basename(app.argv[0]!);
  const state = await handState(hand);
  const existing = state.windows.find((window) => [bin, app.id.replace(/\.desktop$/, "")].includes(window.app));
  if (existing?.containerId) {
    await run(defaultExec, ["swaymsg", "-s", join(RUNTIME_DIR, `sway-ipc.${process.getuid?.() ?? 1000}.${hand.pid}.sock`), `[con_id=${existing.containerId}] focus`]);
    return existing.pid ?? 0;
  }
  if (bin === "omarchy-launch-webapp" && /^https?:\/\//.test(app.argv[1] ?? "")) return launchBrowser(hand, app.argv[1]);
  // A foot client would connect to the host's terminal server.
  if (bin === "footclient" || bin === "foot") return launch(hand, ["foot"]);
  if (/^(chromium(-browser)?|google-chrome(-stable)?|brave(-browser)?|firefox)$/.test(bin)) {
    return launchBrowser(hand, "about:blank", { browser: bin });
  }
  const argv = app.terminal ? [Bun.which("foot") ? "foot" : "alacritty", "-e", ...app.argv] : app.argv;
  return launch(hand, argv, {}, app.cwd);
}

/** Window titles and dimensions for app discovery and the text-only action gate. */
export async function handState(hand: Hand, exec: Exec = defaultExec) {
  const socket = join(RUNTIME_DIR, `sway-ipc.${process.getuid?.() ?? 1000}.${hand.pid}.sock`);
  const res = await run(exec, ["swaymsg", "-s", socket, "-t", "get_tree", "-r"], handEnv(hand));
  const tree = JSON.parse(new TextDecoder().decode(res.stdout));
  const windows: { app: string; title: string; focused: boolean; pid?: number; containerId?: number }[] = [];
  let width = 0, height = 0;
  function walk(node: any) {
    if (node.type === "output" && node.name !== "__i3") { width = node.rect.width; height = node.rect.height; }
    if (node.app_id || node.window_properties) windows.push({ app: node.app_id ?? node.window_properties.class, title: node.name ?? "", focused: Boolean(node.focused), ...(Number.isInteger(node.pid) ? { pid: node.pid } : {}), ...(Number.isSafeInteger(node.id) ? { containerId: node.id } : {}) });
    for (const child of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) walk(child);
  }
  walk(tree);
  return { width, height, windows };
}

export type HandApp = "notes" | "browser" | "terminal";

/** Convenience buttons for the desktop bar; the agent discovers all installed apps. */
export function availableApps(which: (name: string) => string | null = Bun.which): Partial<Record<HandApp, string>> {
  const notes = [process.env.PUK_NOTES_APP, "omawrite", "obsidian", "gnome-text-editor", "gedit", "kate"].find((bin) => bin && which(bin));
  return {
    ...(notes ? { notes } : {}),
    ...(["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave", "firefox"].some((bin) => which(bin)) ? { browser: "Web browser" } : {}),
    ...(["foot", "alacritty"].some((bin) => which(bin)) ? { terminal: "Terminal" } : {}),
  };
}

export async function launchApp(hand: Hand, app: HandApp): Promise<number> {
  const available = availableApps();
  if (!available[app]) throw new Error(`No ${app} app is installed.`);
  if (app === "browser") return launchBrowser(hand);
  if (app === "terminal") return launch(hand, [Bun.which("foot") ? "foot" : "alacritty"]);
  return launch(hand, [available.notes!]);
}

/** Environment that makes toolkits pick the hand's Wayland socket. */
export function appEnv(hand: Hand, extra: Record<string, string> = {}): Record<string, string> {
  const env = subprocessEnv();
  delete env.DISPLAY; // no X here; force Wayland
  delete env.SWAYSOCK;
  delete env.I3SOCK;
  delete env.HYPRLAND_INSTANCE_SIGNATURE;
  return {
    ...env,
    WAYLAND_DISPLAY: hand.display,
    SWAYSOCK: join(RUNTIME_DIR, `sway-ipc.${process.getuid?.() ?? 1000}.${hand.pid}.sock`),
    XDG_CURRENT_DESKTOP: "sway",
    XDG_SESSION_DESKTOP: "sway",
    DESKTOP_SESSION: "sway",
    XDG_SESSION_TYPE: "wayland",
    GDK_BACKEND: "wayland",
    QT_QPA_PLATFORM: "wayland",
    SDL_VIDEODRIVER: "wayland",
    MOZ_ENABLE_WAYLAND: "1",
    ELECTRON_OZONE_PLATFORM_HINT: "wayland",
    ...extra,
  };
}

/** Launch a program inside the hand. Returns its pid. */
export function launch(hand: Hand, argv: string[], env: Record<string, string> = {}, cwd?: string): number {
  const proc = Bun.spawn(argv, {
    env: appEnv(hand, env),
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  proc.unref();
  return proc.pid;
}

/**
 * Launch a browser inside the hand with its own profile directory. On first
 * use the user's real profile is copied so cookies and logins carry over.
 */
export async function launchBrowser(
  hand: Hand,
  url = "about:blank",
  opts: { copyProfile?: boolean; browser?: string } = {},
): Promise<number> {
  const copyProfile = opts.copyProfile ?? true;
  const bin =
    opts.browser ??
    ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave", "firefox"].find((b) =>
      Bun.which(b),
    );
  if (!bin) throw new Error("no browser found (looked for chromium, chrome, brave, firefox)");

  if (bin.startsWith("firefox")) {
    const profile = join(PROFILES_DIR, `firefox-${hand.id}`);
    if (copyProfile && !(await exists(profile))) {
      const src = await defaultFirefoxProfile();
      if (src) await cp(src, profile, { recursive: true });
    }
    await mkdir(profile, { recursive: true });
    for (const lock of ["lock", ".parentlock"]) await rm(join(profile, lock), { force: true });
    return launch(hand, [bin, "--new-instance", "--profile", profile, url]);
  }

  const profile = join(PROFILES_DIR, `${bin}-${hand.id}`);
  if (copyProfile && !(await exists(profile))) {
    const src = chromiumProfileDir(bin);
    if (src && (await exists(src))) await cp(src, profile, { recursive: true });
  }
  await mkdir(profile, { recursive: true });
  for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    await rm(join(profile, lock), { force: true });
  }
  return launch(hand, [
    bin,
    "--ozone-platform=wayland",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    url,
  ]);
}

function chromiumProfileDir(bin: string): string | null {
  const cfg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  if (bin.includes("chromium")) return join(cfg, "chromium");
  if (bin.includes("chrome")) return join(cfg, "google-chrome");
  if (bin.includes("brave")) return join(cfg, "BraveSoftware", "Brave-Browser");
  return null;
}

async function defaultFirefoxProfile(): Promise<string | null> {
  const root = join(homedir(), ".mozilla", "firefox");
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return null;
  }
  const pick = names.find((n) => n.endsWith(".default-release")) ?? names.find((n) => n.endsWith(".default"));
  return pick ? join(root, pick) : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return await Bun.file(path).exists();
  }
}

// ---------------------------------------------------------------- CLI

/**
 * A small native desktop bar; Sway's tab strip switches between apps. The bar
 * polls the Puk server so the user can see, from inside the hand, whether the
 * agent is working, waiting on them, or stopped.
 */
async function panel(id: number) {
  const p = await themePalette();
  const port = Number(process.env.PUK_PORT ?? 7777);
  const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const span = (text: string, attrs: string) => `<span ${attrs}>${esc(text)}</span>`;
  const block = (name: string, full_text: string, gap = 6) => ({ name, full_text, markup: "pango", separator: false, separator_block_width: gap });
  type BarState = { state: "idle" | "working" | "review" | "error"; label: string };
  const dot = { idle: p.mutedForeground, working: p.green, review: p.yellow, error: p.red };
  let status: BarState | null = null;
  // A preview tile is ~480 px wide; keep the bar short there and spell things out once entered.
  let compact = true;
  const blocks = () => [
    block("back", span(compact ? " ‹ Back " : " ‹ My desktop ", `foreground="${p.accent}" weight="bold"`), 16),
    ...(status && (status.state !== "idle" || !compact)
      ? [block("status", `${span("●", `foreground="${dot[status.state]}"`)} ${span(compact ? status.label.split(" · ")[0]! : status.label, `foreground="${p.foreground}"`)}`, 16)]
      : []),
    block("terminal", span(compact ? "+ Term" : " + Terminal ", `foreground="${p.mutedForeground}"`)),
    block("browser", span(compact ? "+ Web" : " + Browser ", `foreground="${p.mutedForeground}"`)),
    ...(availableApps().notes ? [block("notes", span(compact ? "+ Notes" : " + Notes ", `foreground="${p.mutedForeground}"`))] : []),
    block("label", span(` Hand ${id} `, `background="${p.lighterBackground}" foreground="${p.foreground}"`), 8),
  ];
  let first = true;
  let shown = "";
  const emit = () => {
    const line = JSON.stringify(blocks());
    if (line === shown) return;
    console.log(`${first ? "" : ","}${line}`);
    first = false; shown = line;
  };
  console.log(JSON.stringify({ version: 1, click_events: true }));
  console.log("[");
  emit();

  const poll = async () => {
    let next: BarState | null = null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(800) });
      if (res.ok) {
        const s = await res.json() as { workers?: { hand: number; agent: { running: boolean; error: string | null; currentTool: string | null; approval: unknown } }[] };
        const agent = s.workers?.find((w) => w.hand === id)?.agent;
        next = !agent ? { state: "idle", label: "Idle" }
          : agent.approval ? { state: "review", label: "Review · an action needs you" }
          : agent.running ? { state: "working", label: agent.currentTool ? `Working · ${agent.currentTool}` : "Working" }
          : agent.error ? { state: "error", label: "Error · the agent stopped" }
          : { state: "idle", label: "Idle" };
      }
    } catch { /* Puk is not running; hide the status chip. */ }
    await keepScale();
    status = next;
    emit();
  };

  /**
   * The Hyprland window sets the physical size of the nested output. Scale it so
   * the logical desktop stays at the hand's size: a 480 px tile shows the whole
   * 1280 px desktop reduced, and entering or resizing never reflows the apps.
   */
  const hand = await getHand(id);
  let lastMode = "";
  async function keepScale() {
    try {
      const outputs = JSON.parse(new TextDecoder().decode((await defaultExec(["swaymsg", "-t", "get_outputs", "-r"])).stdout)) as { scale?: number; current_mode?: { width: number; height: number } }[];
      const out = outputs[0];
      const mode = out?.current_mode;
      if (!mode?.width) return;
      compact = mode.width < 800;
      if (!hand) return;
      const scale = Number((mode.width / hand.width).toFixed(4));
      const key = `${mode.width}x${mode.height}@${scale}`;
      if (key === lastMode && Math.abs((out?.scale ?? 0) - scale) < 0.002) return;
      lastMode = key;
      if (Math.abs((out?.scale ?? 0) - scale) >= 0.002) await defaultExec(["swaymsg", "output", "*", "scale", String(scale)]);
    } catch { /* Keep the last known size. */ }
  }
  // React to resizes right away; the poll is the fallback.
  const events = Bun.spawn(["swaymsg", "-t", "subscribe", "-m", '["output"]'], { env: subprocessEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  void (async () => {
    for await (const _chunk of events.stdout as ReadableStream) { await keepScale(); emit(); }
  })().catch(() => { /* The subscription ends with sway. */ });
  await keepScale();
  setInterval(poll, 1000);
  void poll();

  let pending = "";
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end).replace(/^,/, "").trim();
      pending = pending.slice(end + 1);
      if (!line.startsWith("{")) continue;
      try {
        const event = JSON.parse(line);
        if (event.button !== 1) continue;
        const hand = await getHand(id);
        if (!hand) continue;
        if (event.name === "back") await (await import("./pip")).runPip("back");
        else if (["terminal", "browser", "notes"].includes(event.name)) await launchApp(hand, event.name);
      } catch (error) { console.error(error instanceof Error ? error.message : "Desktop bar action failed"); }
    }
  }
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const need = async (idStr: string | undefined): Promise<Hand> => {
    const id = Number(idStr);
    const hand = Number.isInteger(id) ? await getHand(id) : null;
    if (!hand) throw new Error(`no running hand with id "${idStr}". Try: bun desktop.ts ls`);
    return hand;
  };

  switch (cmd) {
    case "panel": {
      await panel(Number(rest[0]));
      return;
    }
    case "up": {
      const n = Number(rest.find((a) => /^\d+$/.test(a)) ?? 2);
      if (!Number.isInteger(n) || n < 1 || n > 9) throw new Error("start between 1 and 9 hands");
      const terminal = rest.includes("--terminal");
      const noApp = rest.includes("--empty");
      const url = rest.find((a) => a.startsWith("--url="))?.slice(6) ?? "about:blank";
      const pip = process.env.HYPRLAND_INSTANCE_SIGNATURE && !rest.includes("--no-pip") ? await import("./pip") : null;
      const previous = pip ? JSON.parse(await pip.hyprctl(["activewindow", "-j"])) : null;
      for (let id = 1; id <= n; id++) {
        const existing = await getHand(id);
        if (existing) { console.log(`hand ${id}: already running on ${existing.display}`); continue; }
        const hand = await startHand(id);
        if (terminal) launch(hand, [Bun.which("foot") ? "foot" : "alacritty"]);
        else if (!noApp) await launchBrowser(hand, url);
        console.log(`hand ${id}: pid ${hand.pid} display ${hand.display} ${hand.width}x${hand.height}`);
      }
      if (pip) {
        const hands = await listHands();
        let result = await pip.layoutPip(hands, { preserve: true });
        for (let attempt = 0; result.missing.length && attempt < 20; attempt++) {
          await Bun.sleep(100);
          result = await pip.layoutPip(hands, { preserve: true });
        }
        if (previous?.address && !hands.some((hand) => hand.pid === previous.pid)) {
          const current = await pip.clients();
          if (current.some((win) => win.address === previous.address && win.pid === previous.pid)) {
            await pip.dispatchBatch([`hl.dsp.focus({window="address:${previous.address}"})`]);
          }
        }
        if (result.missing.length) throw new Error(`no window appeared for hand ${result.missing.map((h) => h.id).join(", ")}; try bun pip.ts layout`);
        console.log("PIP ready. Super + left-drag moves; Super + right-drag resizes. Ctrl+Alt+1/2/3 enters/returns (install `bun pip.ts bindings` first).");
      }
      return;
    }
    case "down": {
      for (const hand of await listHands()) {
        await stopHand(hand);
        console.log(`stopped hand ${hand.id}`);
      }
      return;
    }
    case "ls": {
      for (const hand of await listHands()) console.log(JSON.stringify(hand));
      return;
    }
    case "shot": {
      const hand = await need(rest[0]);
      const png = await screenshot(hand);
      if (rest[1]) {
        await Bun.write(rest[1], png);
        console.log(`wrote ${rest[1]} (${png.byteLength} bytes)`);
      } else {
        await Bun.write(Bun.stdout, png);
      }
      return;
    }
    case "move": {
      await moveMouse(await need(rest[0]), Number(rest[1]), Number(rest[2]));
      return;
    }
    case "click": {
      await click(await need(rest[0]), Number(rest[1]), Number(rest[2]), {
        button: (rest[3] as MouseButton) ?? "left",
      });
      return;
    }
    case "scroll": {
      await scroll(await need(rest[0]), Number(rest[1]), Number(rest[2]), Number(rest[3] ?? 3));
      return;
    }
    case "type": {
      await typeText(await need(rest[0]), rest.slice(1).join(" "));
      return;
    }
    case "key": {
      await pressKey(await need(rest[0]), rest[1] ?? "Return");
      return;
    }
    case "run": {
      const hand = await need(rest[0]);
      const pid = launch(hand, rest.slice(1));
      console.log(`pid ${pid}`);
      return;
    }
    default:
      console.log(
        [
          "usage: bun desktop.ts <command>",
          "  up [n] [--url=URL] [--terminal] [--empty] [--no-pip]   start/reuse n hands and arrange PIP",
          "  down                                          stop all hands",
          "  ls                                            list running hands",
          "  shot <id> [file.png]                          screenshot (stdout if no file)",
          "  move <id> <x> <y>",
          "  click <id> <x> <y> [left|right|middle]",
          "  scroll <id> <x> <y> [dy]",
          "  type <id> <text...>",
          "  key <id> <combo>                              e.g. Return, ctrl+l, ctrl+shift+t",
          "  run <id> <cmd...>                             launch a program inside the hand",
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
