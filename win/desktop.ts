#!/usr/bin/env bun
/**
 * Windows hands. A hand is a Windows virtual desktop ("Puk hand 1") holding the
 * windows its agent opened. The agent sees and drives the hand's front window
 * through Cua Driver; the user keeps their own desktop, mouse and keyboard.
 *
 * This file supplies the same five seams `createDesktopAgent` takes on Omarchy
 * (`discover`, `launch`, `state`, `bash`, `cua`), so ai.ts and hotkey.ts run
 * unchanged. It works from native Windows Bun and from WSL through interop.
 *
 * Hands never take the user's screen, pointer or keyboard. Native windows get
 * Cua's background input (UI Automation and posted messages); the hand's
 * browser is driven over DevTools (win/browser.ts), which needs no focus. What
 * Windows refuses to deliver in the background fails with an explanation. Set
 * PUK_WIN_BORROW=1 to let a hand switch to its desktop for those inputs.
 *
 * A hand's browser is Puk's own profile, never the user's Chrome, so it knows
 * only the sign-ins made inside it. `login` opens that profile as an ordinary
 * window on the user's desktop, once; the hand keeps the sessions from then on.
 *
 * CLI:
 *   bun win/desktop.ts up [n]            create the hand desktops
 *   bun win/desktop.ts list
 *   bun win/desktop.ts down              remove them (their windows fall back to your desktop)
 *   bun win/desktop.ts login [n|all]     sign a hand's browser in to your sites, once
 *   bun win/desktop.ts sessions [n|all]  which sites each hand's browser is signed in to
 */
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv, AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { debugLog, redact, subprocessEnv, type CuaConnection, type Hand, type InstalledApp } from "../desktop";
import { browserInput } from "./browser";
import { loginPage, loginTargets, parseDevToolsFile, seenByUser, signedInSites, signInWall, type Cookie, type Foreground, type SeenWindow, type Wall } from "./session";

const WSL = process.platform === "linux";
const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "out", "win");
const SOURCES = [join(import.meta.dir, "helper.cs"), join(import.meta.dir, "vendor", "VirtualDesktop11-24H2.cs")];
/** What the agent sees for a hand with no window yet. */
const EMPTY = { width: 1280, height: 800 };

// ---------------------------------------------------------------- paths

async function text(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { env: subprocessEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${argv[0]} failed: ${(err || out).trim().slice(0, 400)}`);
  return out.replaceAll("\r", "").trim();
}
/** A path a Windows program understands. */
export const toWindows = async (path: string) => WSL ? text(["wslpath", "-w", path]) : path;
/** A Windows path as this process can open it. */
export const fromWindows = async (path: string) => WSL ? text(["wslpath", "-u", path]) : path;

let folders: Promise<{ windir: string; local: string; programs: string[] }> | undefined;
const windowsFolders = () => folders ??= (async () => {
  if (!WSL) return { windir: process.env.WINDIR ?? "C:\\Windows", local: process.env.LOCALAPPDATA ?? "", programs: [process.env.ProgramFiles ?? "", process.env["ProgramFiles(x86)"] ?? ""] };
  const [windir, local, a, b] = (await text(["cmd.exe", "/d", "/c", "echo %WINDIR%^|%LOCALAPPDATA%^|%ProgramFiles%^|%ProgramFiles(x86)%"])).split("|");
  return { windir: windir!, local: local!, programs: [a!, b!] };
})();

// ---------------------------------------------------------------- helper

/** Build win/helper.cs with the C# compiler that ships in Windows. The file is
 * named after its sources: Windows locks a running .exe, so a helper still held
 * by another Puk could never be rebuilt in place. */
export async function ensureHelper(): Promise<string> {
  const hash = Bun.hash((await Promise.all(SOURCES.map((s) => Bun.file(s).text()))).join("\0")).toString(16).slice(0, 10);
  const HELPER = join(OUT, `puk-win-${hash}.exe`);
  if (await stat(HELPER).then(() => true, () => false)) return HELPER;
  await mkdir(OUT, { recursive: true });
  for (const old of new Bun.Glob("puk-win*.exe").scanSync(OUT)) await rm(join(OUT, old)).catch(() => { /* still running */ });
  const csc = await fromWindows(`${(await windowsFolders()).windir}\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe`);
  await text([csc, "/nologo", "/optimize", "/platform:x64", "/nowarn:0168,0649,0169", "/main:PukWin", `/out:${await toWindows(HELPER)}`,
    "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll", ...await Promise.all(SOURCES.map(toWindows))]);
  return HELPER;
}

type Helper = { ask(line: string): Promise<string>; close(): void };

/** One long-lived `puk-win serve`: a request line in, a reply line out. */
export function createHelper(exe: string): Helper {
  const proc = Bun.spawn([exe, "serve"], { env: subprocessEnv(), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = proc.stdout.getReader(), decoder = new TextDecoder();
  let buffered = "", queue: Promise<unknown> = Promise.resolve();
  async function line(): Promise<string> {
    for (;;) {
      const end = buffered.indexOf("\n");
      if (end >= 0) { const out = buffered.slice(0, end).replace(/\r$/, ""); buffered = buffered.slice(end + 1); return out; }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("The Windows helper stopped.");
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  }
  return {
    ask(request) {
      if (/[\r\n]/.test(request)) throw new Error("Helper requests are single lines.");
      const reply = queue.then(async () => {
        proc.stdin.write(`${request}\n`); await proc.stdin.flush();
        const out = await line();
        if (out.startsWith("error ")) throw new Error(out.slice(6));
        return out;
      });
      queue = reply.catch(() => {});
      return reply;
    },
    close() { try { proc.stdin.end(); } catch { /* already gone */ } },
  };
}

let shared: Promise<Helper> | undefined;
export const helper = () => shared ??= ensureHelper().then(createHelper);
const ask = async (line: string) => (await helper()).ask(line);

// ---------------------------------------------------------------- hands

export const desktopName = (id: number) => `Puk hand ${id}`;

export async function listHands(): Promise<Hand[]> {
  const names: string[] = JSON.parse(await ask("desktops"));
  return names.flatMap((name) => {
    const id = /^Puk hand (\d+)$/.exec(name)?.[1];
    // `pid` tells the panel when a hand was replaced. These live as long as this process.
    return id ? [{ id: Number(id), pid: process.pid, display: name, ...EMPTY }] : [];
  }).sort((a, b) => a.id - b.id);
}
export const getHand = async (id: number) => (await listHands()).find((h) => h.id === id) ?? null;

export async function startHands(count: number): Promise<Hand[]> {
  for (let id = 1; id <= count; id++) await ask(`ensure ${desktopName(id)}`);
  return (await listHands()).filter((h) => h.id <= count);
}

export async function stopHands(): Promise<void> {
  for (const hand of await listHands()) await ask(`remove ${hand.display}`);
}

type RawWindow = { app: string; title: string; focused: boolean; pid: number; containerId: number; iconic?: boolean; rect: [number, number, number, number] };
/** What Cua last captured for a hand. ai.ts compares `state().width/height` with the PNG it was given. */
const frames = new Map<number, { window: number; rect: string; width: number; height: number }>();

/** Window handles each hand owns. The shell can pull an activated window onto the
 * user's desktop, so membership is tracked here and the helper moves strays back. */
const owned = new Map<number, Set<number>>();
/** The window each hand is working in. Stacking order cannot say: switching
 * desktops and activating windows reshuffle it. */
const active = new Map<number, number>();

/** Pure: which window is in front, given what the hand had before. */
export function frontWindow(found: number[], before: ReadonlySet<number>, current?: number): number | undefined {
  // A window the hand did not have a moment ago is a dialog or a new page: it takes over.
  const opened = found.find((id) => !before.has(id));
  if (opened !== undefined && before.size) return opened;
  return current !== undefined && found.includes(current) ? current : found[0];
}

async function windows(hand: Hand): Promise<RawWindow[]> {
  const mine = owned.get(hand.id) ?? new Set<number>();
  const found: RawWindow[] = JSON.parse(await ask(`state ${hand.display}|${[...mine].join(",")}`)).windows;
  const front = frontWindow(found.map((w) => w.containerId), mine, active.get(hand.id));
  if (front === undefined) active.delete(hand.id); else active.set(hand.id, front);
  // Dialogs and windows an app opened by itself join the hand; closed ones leave.
  owned.set(hand.id, new Set(found.map((w) => w.containerId)));
  return found.map((w) => ({ ...w, focused: w.containerId === front }));
}

const NOTE = `This hand is a Windows virtual desktop working in the background while the user works on theirs. The computer tool shows and drives only its front window, in that window's own pixels; open_app opens an app or brings its window to the front. Prefer the browser: it takes every input, including freehand strokes in a web canvas such as jspaint.app. Native apps accept clicks on real controls and typed text, but their canvases ignore background pointer strokes. To go to a site, press ctrl+l, type the address, press enter. ${WSL ? "Bash runs in WSL: call Windows programs as powershell.exe -NoProfile -Command '...' and find the user's files under /mnt/c/Users." : "The bash tool runs PowerShell here."}`;

export async function handState(hand: Hand) {
  const all = await windows(hand), front = all.find((w) => w.focused), frame = frames.get(hand.id);
  const size = !front ? EMPTY
    : frame?.window === front.containerId && frame.rect === front.rect.slice(2).join("x") ? frame
    : { width: front.rect[2], height: front.rect[3] };
  return { width: size.width, height: size.height, windows: all.map(({ rect: _, iconic: __, ...w }) => w), platform: NOTE };
}

// ---------------------------------------------------------------- borrowing the screen

let screen: Promise<unknown> = Promise.resolve();
let giveBack: ReturnType<typeof setTimeout> | undefined;

/** Run `work` with the hand's desktop visible. Returning is delayed a moment so
 * a burst of strokes or keys does not flip desktops for every call. */
function onScreen<T>(hand: Hand, work: () => Promise<T>): Promise<T> {
  const run = screen.then(async () => {
    clearTimeout(giveBack);
    if (JSON.parse(await ask("where")) !== hand.display) { await ask(`show ${hand.display}`); await Bun.sleep(350); }
    try { return await work(); }
    finally { giveBack = setTimeout(() => { screen = screen.then(() => ask("back")).catch(() => {}); }, 1200); }
  });
  screen = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------- Cua

type Raw = { call: CuaConnection["call"]; close(): Promise<void> };
const drivers = new Map<number, Promise<Raw>>();

async function cuaDriver(): Promise<string> {
  const installed = `${(await windowsFolders()).local}\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe`;
  const path = Bun.which(WSL ? "cua-driver.exe" : "cua-driver") ?? await fromWindows(installed);
  if (!await Bun.file(path).exists()) throw new Error("Install Cua Driver for Windows: irm https://cua.ai/driver/install.ps1 | iex");
  return path;
}

/** One private driver per hand, shared by the agent's computer tool and open_app. */
export function driver(hand: Hand): Promise<Raw> {
  let raw = drivers.get(hand.id);
  if (!raw) {
    raw = (async () => {
      const client = new Client({ name: "puk", version: "0.1" }, { jsonSchemaValidator: new AjvJsonSchemaValidator(new Ajv({ strict: false, logger: false })) });
      const transport = new StdioClientTransport({
        // The grant lets Cua attach over CDP to a browser it did not launch. The
        // facade below only ever aims it at the hand's own profile.
        command: await cuaDriver(), args: ["mcp", "--grant", "existing-profile"], stderr: "pipe",
        env: { ...subprocessEnv(), CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", ...(WSL ? { WSLENV: "CUA_DRIVER_RS_TELEMETRY_ENABLED" } : {}) },
      });
      transport.stderr?.on("data", (chunk) => debugLog("cua.stderr", String(chunk)));
      try { await client.connect(transport, { timeout: 15_000 }); await client.listTools(); }
      catch (error) { await client.close(); throw error; }
      return {
        async call(name, args = {}, signal) {
          signal?.throwIfAborted();
          const response = await client.callTool({ name, arguments: args }, { signal, timeout: 30_000 });
          if (response.isError) throw new Error(redact(response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")));
          return response;
        },
        close: () => client.close(),
      };
    })();
    drivers.set(hand.id, raw);
    raw.catch(() => { if (drivers.get(hand.id) === raw) drivers.delete(hand.id); });
  }
  return raw;
}

const pngSize = (base64: string) => { const b = Buffer.from(base64.slice(0, 64), "base64"); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; };
const image = (data: string) => ({ content: [{ type: "image" as const, data, mimeType: "image/png" }] }) as unknown as Awaited<ReturnType<CuaConnection["call"]>>;
const refused = (error: unknown) => error instanceof Error && /background[_ ](delivery|unavailable)|delivery_mode:\s*"?foreground/i.test(error.message);

const pages = new Map<number, ReturnType<typeof browserInput>>();
const relays = new Map<number, Promise<Helper>>();
/** The hand's own helper process for DevTools: a page that stops answering must not hold
 * up window state, launches or the other hands, which all share the main helper. */
function relayOf(hand: Hand): Promise<Helper> {
  const relay = relays.get(hand.id) ?? ensureHelper().then(createHelper);
  relays.set(hand.id, relay);
  return relay;
}
/** DevTools access to the hand's browser. One per hand: it remembers whether the address bar was aimed at. */
export function handBrowser(hand: Hand) {
  const relay = relayOf(hand);
  const page = pages.get(hand.id) ?? browserInput(async (line) => (await relay).ask(line), (reread) => devtoolsPort(hand, reread),
    (where, error) => debugLog("win.devtools", { hand: hand.id, where, error: error instanceof Error ? error.message : String(error) }));
  pages.set(hand.id, page);
  return page;
}
/** The hand's front window when it is the hand's browser, else null. */
export async function browserWindow(hand: Hand) {
  const front = (await windows(hand)).find((w) => w.focused);
  return front && front.pid === browsers.get(hand.id) ? front : null;
}
/** The hand's front window, with its frame on screen. */
export const frontOf = async (hand: Hand) => (await windows(hand)).find((w) => w.focused) ?? null;

/** PNG of the hand's front window, or a placeholder. The helper's own capture
 * takes about 100 ms; Cua's takes 0.5 to 2.5 s and queues behind whatever else
 * the driver is doing, such as the five seconds it settles after a launch.
 * `preview` captures do not count as what the agent last saw. */
export async function capture(hand: Hand, preview = false): Promise<string> {
  const front = (await windows(hand)).find((w) => w.focused);
  if (!front) {
    if (!preview) frames.delete(hand.id);
    return ask(`blank ${EMPTY.width} ${EMPTY.height} Hand ${hand.id} is empty. Use open_app to start an app.`);
  }
  const data = await ask(`grab ${front.containerId}`).catch(async () => {
    // Minimized, or a window that will not draw itself on request.
    const response = await (await driver(hand)).call("get_window_state", { pid: front.pid, window_id: front.containerId, include_accessibility_tree: false });
    const shot = response.content.find((c) => c.type === "image");
    if (!shot || shot.type !== "image") throw new Error("Cua did not return a window screenshot.");
    return shot.data;
  });
  if (!preview) frames.set(hand.id, { window: front.containerId, rect: front.rect.slice(2).join("x"), ...pngSize(data) });
  return data;
}

/**
 * The Cua connection ai.ts expects. It speaks the calls ai.ts makes on Linux
 * (a desktop target, foreground delivery, press / drag / release) and turns
 * them into Windows calls against the hand's front window.
 */
export async function connectCua(hand: Hand): Promise<CuaConnection> {
  const raw = await driver(hand);
  const browser = handBrowser(hand);
  const borrow = process.env.PUK_WIN_BORROW === "1";
  let stroke: { x: number; y: number }[] = [], untouched = "";
  const front = async () => {
    const w = (await windows(hand)).find((x) => x.focused);
    if (!w) throw new Error("This hand has no window. Use open_app first, then take a screenshot.");
    return w;
  };
  return {
    async call(name, args = {}, signal) {
      signal?.throwIfAborted();
      if (name === "get_desktop_state") return image(await capture(hand));
      if (name === "list_windows") {
        const all = await windows(hand);
        return { content: [], structuredContent: { windows: all.map((w) => ({ window_id: w.containerId, pid: w.pid, app_name: w.app, title: w.title })) } } as unknown as Awaited<ReturnType<CuaConnection["call"]>>;
      }
      const w = await front(), target = { pid: w.pid, window_id: w.containerId };
      if (w.pid === browsers.get(hand.id) && await browser.handle(name, args, w)) return image("");
      // The agent cursor is an overlay in screen space; it is decoration, never a reason to fail.
      if (name === "move_cursor") return raw.call(name, { x: w.rect[0] + Number(args.x), y: w.rect[1] + Number(args.y) }, signal).catch(() => image(""));
      if (name === "mouse_button_down") {
        stroke = [{ x: Number(args.x), y: Number(args.y) }];
        untouched = borrow ? "" : await capture(hand, true).catch(() => "");
        return image("");
      }
      if (name === "mouse_drag") { stroke.push({ x: Number(args.x), y: Number(args.y) }); return image(""); }
      if (name === "mouse_button_up") {
        // Cua has no press and release on Windows, so a stroke is a chain of drags
        // that share end points. Posted drags reach classic canvases; Paint and
        // other XAML canvases drop them without an error, hence the note to the model.
        const points = stroke; stroke = [];
        const draw = async (mode: Record<string, unknown>) => {
          let last = image("");
          for (let i = 1; i < points.length; i++) {
            const a = points[i - 1]!, b = points[i]!;
            last = await raw.call("drag", { ...target, from_x: a.x, from_y: a.y, to_x: b.x, to_y: b.y, steps: Math.min(16, Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 6))), duration_ms: 60, ...mode });
          }
          return last;
        };
        if (borrow) return onScreen(hand, () => draw({ delivery_mode: "foreground" }));
        const drawn = await draw({});
        await Bun.sleep(150);
        // Say so, or the model redraws the same cat until its action budget is gone.
        if (untouched && untouched === await capture(hand, true).catch(() => "")) {
          throw new Error(`${w.app} ignored the stroke: native Windows canvases take only the real pointer, which this hand leaves to the user. Open the browser, go to jspaint.app and draw there.`);
        }
        return drawn;
      }
      const { target: _, delivery_mode: __, ...input } = args;
      // Cua measures from its own capture, which is this frame inset by one pixel.
      for (const axis of ["x", "y"] as const) if (typeof input[axis] === "number") input[axis] = Math.max(0, input[axis] - 1);
      const request = { ...input, ...target };
      try { return await raw.call(name, request, signal); }
      catch (error) {
        if (!refused(error)) throw error;
        debugLog("win.refused", { hand: hand.id, name, app: w.app });
        if (borrow) return onScreen(hand, () => raw.call(name, { ...request, delivery_mode: "foreground" }, signal));
        throw new Error(`Windows does not deliver this input to ${w.app} while it works in the background. Do this step in the browser, another app or Bash instead.`);
      }
    },
    async close() { drivers.delete(hand.id); await raw.close(); },
  };
}

// ---------------------------------------------------------------- apps

const BROWSER = /\b(chrome|edge|browser|brave|firefox)\b/i;
const JUNK = /uninstall|readme|release notes|documentation|website|\bhelp\b|license|\((x86|32-bit)\)|32-bit|diagnostic|troubleshooter|preferences|\bupdates?\b|configuration|\bodbc\b|iscsi|event viewer|component services|security policy|print management|(performance|resource) monitor|recovery drive|registry|^services$|system (configuration|information)|task scheduler|defragment|disk clean|computer management|windows tools|telemetry|steps recorder|\bexamples?\b|\bdemo\b|upgrader|compile script|run script|window info|preboot|\bkernel\b|reset .* settings|firewall/i;
/** Start menu AppIDs by catalog id. Kept here so the model is not sent them. */
const appIds = new Map<string, string>();

/** The Start menu, which also lists Store apps. `argv` carries the AppID for `launchInstalledApp`. */
const NATIVE_CANVAS: Record<string, string> = { paint: "Native canvas: strokes cannot reach it while this hand works in the background. To draw, open the browser and use jspaint.app." };
let catalog: { at: number; apps: Promise<InstalledApp[]> } | undefined;

/** The agent asks for this at the start of every task, and PowerShell takes about
 * three seconds to answer, so the list is kept for a few minutes. */
export function discoverApps(): Promise<InstalledApp[]> {
  if (!catalog || Date.now() - catalog.at > 300_000) {
    const apps = readStartMenu();
    catalog = { at: Date.now(), apps };
    apps.catch(() => { if (catalog?.apps === apps) catalog = undefined; });
  }
  return catalog.apps;
}

async function readStartMenu(): Promise<InstalledApp[]> {
  const listed = JSON.parse(await text(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"]) || "[]");
  const seen = new Set<string>();
  return (Array.isArray(listed) ? listed : [listed]).flatMap((entry: { Name?: string; AppID?: string }) => {
    const name = entry.Name?.trim(), appId = entry.AppID?.trim();
    if (!name || !appId || JUNK.test(name) || /^https?:|\.(url|txt|chm|pdf|html?)$/i.test(appId)) return [];
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!id || seen.has(id)) return [];
    seen.add(id);
    appIds.set(id, appId);
    // The model re-reads this list on every turn of a task, so an entry is an id,
    // a name and only a description worth reading. Launching needs nothing else.
    const description = BROWSER.test(name) ? "Web browser. Already open in this hand; opens instantly." : NATIVE_CANVAS[id];
    return [{ id, name, ...(description ? { description } : {}) } as unknown as InstalledApp];
  }).slice(0, 250);
}

const opened = new Map<number, Map<string, number>>();
/** The process behind each hand's browser; its windows are driven over DevTools. */
const browsers = new Map<number, number>();
const profile = async (hand: Hand) => `${(await windowsFolders()).local}\\Puk\\hands\\${hand.id}\\browser`;

const ports = new Map<number, number>();
/** Chrome writes its DevTools port to a file. From WSL that file takes about a
 * second to read, so it is read once per browser launch, not once per click. */
async function devtoolsPort(hand: Hand, reread = false): Promise<number | null> {
  if (!reread && ports.has(hand.id)) return ports.get(hand.id)!;
  const file = Bun.file(await fromWindows(`${await profile(hand)}\\DevToolsActivePort`));
  const port = await file.exists() ? Number((await file.text()).split("\n")[0]) : NaN;
  if (!Number.isInteger(port) || port <= 0) { ports.delete(hand.id); return null; }
  ports.set(hand.id, port);
  return port;
}

let browserExe: Promise<string> | undefined;
/** Chrome, else Edge. The sign-in window must be the same program as the hand's browser: they share a profile. */
const browserPath = () => browserExe ??= (async () => {
  const { programs } = await windowsFolders();
  const candidates = [...programs.map((p) => `${p}\\Google\\Chrome\\Application\\chrome.exe`), ...programs.map((p) => `${p}\\Microsoft\\Edge\\Application\\msedge.exe`)];
  for (const path of candidates) if (await Bun.file(await fromWindows(path)).exists()) return path;
  throw new Error("No Chrome or Edge installation was found.");
})();

async function browserCommand(hand: Hand) {
  return {
    path: await browserPath(),
    // Its own profile keeps the user's browser untouched. A window on another
    // desktop counts as occluded, and Chromium stops painting those.
    additional_arguments: [`--user-data-dir=${await profile(hand)}`, "--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble",
      "--disable-features=CalculateNativeWinOcclusion,UseEcoQoSForBackgroundProcess", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--remote-debugging-port=0", "--force-device-scale-factor=1",
      // Windows presents no frames for a window on another desktop, and Chrome paces
      // a page by its frames: measured here, a hidden page got 0 animation frames and
      // 0 timer ticks a second, and YouTube needed a minute to load. Unpaced: 43 and 99.
      "--disable-gpu-vsync", "--disable-frame-rate-limit", "--disable-background-timer-throttling",
      ...(process.env.PUK_WIN_BROWSER_FLAGS?.split(/\s+/).filter(Boolean) ?? []), "--new-window", "about:blank"],
  };
}

/** Opt a hand's app out of Windows power throttling, which falls on every process
 * without a visible window. A browser starts new renderers as it goes, so call again. */
export const boost = (pid: number) => ask(`boost ${pid}`).catch(() => "");
/** The hand's browser process, once it has one. */
export const browserPid = (hand: Hand) => browsers.get(hand.id);

const warming = new Map<number, Promise<unknown>>();
/** Start the hand's browser before anyone asks: it is the tool most tasks reach
 * for first, and cold it costs about four seconds. */
export function warmBrowser(hand: Hand): Promise<unknown> {
  const started = warming.get(hand.id) ?? launchInstalledApp(hand, { id: "browser", name: "Web browser" } as unknown as InstalledApp, true);
  warming.set(hand.id, started);
  return started;
}

let launches: Promise<unknown> = Promise.resolve();
/** Open an app in the hand, or bring the window this hand already opened to the front.
 * One launch at a time: a new window is recognised by being new on the user's
 * desktop, so two hands launching together could take each other's. */
export async function launchInstalledApp(hand: Hand, app: InstalledApp, warmingUp = false): Promise<number> {
  // Whoever asks for the browser while it is still being warmed up gets that one.
  if (!warmingUp && BROWSER.test(app.name)) await warming.get(hand.id)?.catch(() => {});
  const mine = launches.then(() => launchOne(hand, app));
  launches = mine.catch(() => {});
  return mine;
}

/** Pure: a window already on the hand's desktop that is this application, the largest if several. Not for the browser, whose window must be the one with this hand's DevTools port. */
export function adoptable<W extends { app: string; title: string; rect: [number, number, number, number]; iconic?: boolean }>(found: W[], appName: string): W | undefined {
  const words = appName.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (!words.length) return undefined;
  // Every word of the name, in the title or the process: "Paint" must not adopt "Paint 3D", nor "Notepad" a "Notepad++".
  const same = (w: W) => { const text = `${w.title} ${w.app}`.toLowerCase(); return words.every((word) => text.includes(word)) && !/\+\+|\b3d\b/.test(text.replace(appName.toLowerCase(), "")); };
  return found.filter((w) => !w.iconic && same(w)).toSorted((a, b) => b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3])[0];
}

async function launchOne(hand: Hand, app: InstalledApp): Promise<number> {
  const mine = opened.get(hand.id) ?? new Map<string, number>();
  opened.set(hand.id, mine);
  // Chrome, Edge or "browser": the hand has one, and it is usually open already.
  const key = BROWSER.test(app.name) ? "browser" : app.id;
  // Starting it now would take the profile from under the window the user is signing in to.
  if (key === "browser" && signingIn.has(hand.id)) throw new Error(`Hand ${hand.id}'s browser is open on your desktop for signing in. Close that window, then ask again.`);
  const here = await windows(hand);
  // What this process opened, or, after a restart, what an earlier one left on this hand's desktop: a second
  // Calculator next to the first is two "focused" candidates for whoever reads the screen next.
  const existing = here.find((w) => w.containerId === mine.get(key)) ?? (key === "browser" ? undefined : adoptable(here, app.name));
  if (existing) { active.set(hand.id, existing.containerId); mine.set(key, existing.containerId); await ask(`raise ${existing.containerId}`); return existing.pid; }

  const before = new Set((JSON.parse(await ask("state")).windows as RawWindow[]).map((w) => w.containerId));
  const focus = await ask("fg");
  const appId = appIds.get(app.id) ?? app.name;
  let pid = 0, announced: number[] = [], launching: Promise<void> | undefined;
  if (BROWSER.test(app.name)) {
    // Started directly: a browser already running on this hand's profile takes
    // over the launch and exits, which Cua's launch_app would wait out.
    const { path, additional_arguments } = await browserCommand(hand);
    // A browser left over from an earlier run would adopt the launch and leave two
    // identical windows, which Cua refuses to tell apart. The profile is this hand's alone.
    await text(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*\\Puk\\hands\\${hand.id}\\browser*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`]).catch(() => {});
    Bun.spawn([await fromWindows(path), ...additional_arguments], { env: subprocessEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
    ports.delete(hand.id);
  } else {
    // Not awaited: Cua keeps "settling" for about five seconds after the window
    // exists. Its reply still names the window, which settles any doubt below.
    launching = (await driver(hand)).call("launch_app", appId.includes("!") ? { aumid: appId } : { name: app.name }).then((launched) => {
      const reply = launched.structuredContent as { pid?: number; windows?: { window_id: number }[] } | undefined;
      pid = Number(reply?.pid ?? 0);
      announced = (reply?.windows ?? []).map((w) => w.window_id);
    });
    launching.catch(() => {});
  }
  // Take the new window the moment it appears, so it spends a blink on the user's
  // desktop instead of seconds. A window that looks like the app is taken at once;
  // anything else waits for Cua to name it, or for the launch to have clearly ended.
  const words = key === "browser" ? ["chrome", "msedge"] : app.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const resembles = (w: RawWindow) => words.some((word) => w.title.toLowerCase().includes(word) || w.app.toLowerCase().includes(word));
  let created: RawWindow | undefined, display = { width: 1920, height: 1200 }, failed: unknown;
  launching?.catch((error) => { failed = error; });
  for (let i = 0; i < 100 && !created && !failed; i++) {
    if (i) await Bun.sleep(100);
    const seen = JSON.parse(await ask("state")) as { width: number; height: number; windows: RawWindow[] };
    display = seen;
    const fresh = seen.windows.filter((w) => !before.has(w.containerId) && (w.iconic || (w.rect[2] > 200 && w.rect[3] > 150)));
    // The largest: a browser recovering from a crash also shows a small "restore pages" bubble.
    const largest = (list: RawWindow[]) => list.toSorted((a, b) => b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3])[0];
    created = fresh.find((w) => announced.includes(w.containerId)) ?? fresh.find((w) => pid && w.pid === pid) ?? largest(fresh.filter(resembles))
      ?? (i >= 40 ? fresh[0] : undefined);
  }
  if (failed) throw failed;
  if (!created) throw new Error(`${app.name} started but did not open a window.`);
  await ask(`move ${created.containerId} ${hand.display}`);
  await ask(`place ${created.containerId} 40 40 ${Math.min(1360, display.width - 120)} ${Math.min(900, display.height - 160)}`);
  await ask(`focus ${focus}`);
  (owned.get(hand.id) ?? owned.set(hand.id, new Set()).get(hand.id)!).add(created.containerId);
  active.set(hand.id, created.containerId);
  mine.set(key, created.containerId);
  if (BROWSER.test(app.name)) browsers.set(hand.id, created.pid);
  void boost(created.pid);
  return created.pid;
}

// ---------------------------------------------------------------- signing in

/**
 * A hand's browser is Puk's own profile, so it is signed in to nothing until the
 * user signs in inside it. They do that in an ordinary window of the same profile
 * on their own desktop, started WITHOUT the hand's flags: Google refuses sign-in
 * ("This browser or app may not be secure") to a browser it takes for automated,
 * and a DevTools port is one of the things it looks at. The sessions land in the
 * profile; the hand's browser, DevTools and all, uses them from then on.
 *
 * One process per profile: Chrome hands a second launch over to the first. So the
 * hand's browser is asked to close first, and cannot start while the window is open.
 */
export type SignIn = { state: "waiting" | "closing" | "open" | "checking" | "done" | "error"; sites: string[] | null; error?: string };
const signIns = new Map<number, SignIn>();
const signingIn = new Map<number, Promise<SignIn>>();
/** Every sign-in asked for in this process, by hand. */
export const signInStatus = (): Record<number, SignIn> => Object.fromEntries(signIns);
/** A hand by number, whether or not its desktop exists: signing in needs only its profile. */
export const handFor = (id: number): Hand => ({ id, pid: process.pid, display: id === 99 ? "Puk bench" : desktopName(id), ...EMPTY });

/** Chrome keeps `lockfile` for as long as any process has the profile, with or without DevTools. */
const profileInUse = async (hand: Hand) => Bun.file(await fromWindows(`${await profile(hand)}\\lockfile`)).exists();

/** The hand's browser when it is running with DevTools. `DevToolsActivePort` outlives its
 * browser, and the port it names may since be another program's: the browser that answers
 * has to be the one that wrote the file. */
async function liveBrowser(hand: Hand): Promise<string | null> {
  const file = Bun.file(await fromWindows(`${await profile(hand)}\\DevToolsActivePort`));
  const named = await file.exists() ? parseDevToolsFile(await file.text()) : null;
  if (!named) return null;
  const version = await (await relayOf(hand)).ask(`http http://127.0.0.1:${named.port}/json/version`).then((body) => JSON.parse(body) as { webSocketDebuggerUrl?: string }, () => null);
  return version?.webSocketDebuggerUrl?.endsWith(named.browser) ? `ws://127.0.0.1:${named.port}${named.browser}` : null;
}

let calls = 1_000_000;
/** One DevTools call to the browser itself, not a page. Replies are never logged: they can hold cookies. */
async function browserCall(hand: Hand, ws: string, method: string, params: Record<string, unknown> = {}) {
  const id = calls++;
  const reply = JSON.parse(await (await relayOf(hand)).ask(`cdp ${ws} ${id} ${JSON.stringify({ id, method, params })}`));
  if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
  return reply.result;
}

const cookieSites = async (hand: Hand, ws: string) =>
  signedInSites(((await browserCall(hand, ws, "Storage.getCookies")).cookies as Cookie[]).map(({ name, domain, expires }) => ({ name, domain, expires })));

/** The well-known sites this hand's browser is signed in to; null when that cannot be read right now.
 * A running hand is asked over DevTools. Otherwise the profile is opened by a browser with no
 * window that loads no page, so nothing is shown and no session is touched. */
export async function handSessions(hand: Hand): Promise<string[] | null> {
  const live = await liveBrowser(hand);
  if (live) return cookieSites(hand, live);
  if (await profileInUse(hand)) return null; // a window without DevTools has it: someone is signing in
  const dir = await profile(hand);
  if (!await Bun.file(await fromWindows(`${dir}\\Local State`)).exists()) return [];
  await rm(await fromWindows(`${dir}\\DevToolsActivePort`), { force: true });
  const proc = Bun.spawn([await fromWindows(await browserPath()), "--headless=new", `--user-data-dir=${dir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "about:blank"],
    { env: subprocessEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(500);
      const ws = await liveBrowser(hand);
      if (!ws) continue;
      try { return await cookieSites(hand, ws); }
      finally { await browserCall(hand, ws, "Browser.close").catch(() => {}); }
    }
    return null;
  } finally {
    await Promise.race([proc.exited, Bun.sleep(8000)]);
    for (let i = 0; i < 20 && await profileInUse(hand); i++) await Bun.sleep(250);
    proc.unref();
  }
}

/** Ask the hand's own browser to leave its profile. A clean exit writes its cookies out; a kill may not. */
async function releaseProfile(hand: Hand): Promise<void> {
  if (!await profileInUse(hand)) return;
  const live = await liveBrowser(hand);
  if (!live) throw new Error(`Hand ${hand.id}'s browser is already open in a window of its own (an earlier sign-in?). Close that window first.`);
  await browserCall(hand, live, "Browser.close").catch(() => {});
  opened.get(hand.id)?.delete("browser"); browsers.delete(hand.id); ports.delete(hand.id);
  for (let i = 0; i < 40 && await profileInUse(hand); i++) await Bun.sleep(250);
  if (await profileInUse(hand)) throw new Error(`Hand ${hand.id}'s browser did not close.`);
}

/** The hand's profile as a plain window on the user's desktop. Runs as a launch, so that
 * another hand starting an app at the same moment does not take this window for its own. */
async function openSignInWindow(hand: Hand): Promise<void> {
  if (/^Puk (hand \d+|bench)$/.test(JSON.parse(await ask("where")))) throw new Error("Go back to your own desktop first: the sign-in window opens where you are.");
  const dir = await profile(hand), page = `${dir.slice(0, dir.lastIndexOf("\\"))}\\login.html`;
  await mkdir(await fromWindows(dir.slice(0, dir.lastIndexOf("\\"))), { recursive: true });
  await Bun.write(await fromWindows(page), loginPage(hand.id));
  const before = new Set((JSON.parse(await ask("state")).windows as RawWindow[]).map((w) => w.containerId));
  // No DevTools port and none of the hand's switches: to the sites this is the user's ordinary browser.
  Bun.spawn([await fromWindows(await browserPath()), `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble",
    ...(process.env.PUK_WIN_LOGIN_FLAGS?.split(/\s+/).filter(Boolean) ?? []), "--new-window", encodeURI(`file:///${page.replaceAll("\\", "/")}`)],
    { env: subprocessEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(200);
    const seen = JSON.parse(await ask("state")).windows as RawWindow[];
    if (seen.some((w) => !before.has(w.containerId) && /chrome|msedge/i.test(w.app) && w.rect[2] > 200 && w.rect[3] > 150)) return;
  }
  if (!await profileInUse(hand)) throw new Error("The sign-in window did not open.");
}

/** Open the hand's browser for the user to sign in, wait until they close it, and say what it is now
 * signed in to. The one time a hand puts a window on the user's desktop, and only because they asked. */
export function signIn(hand: Hand): Promise<SignIn> {
  const running = signingIn.get(hand.id);
  if (running) return running;
  const note = (next: SignIn) => { signIns.set(hand.id, next); debugLog("win.login", { hand: hand.id, ...next }); return next; };
  const mine = (async () => {
    try {
      note({ state: "closing", sites: null });
      await warming.get(hand.id)?.catch(() => {});
      await releaseProfile(hand);
      const opening = launches.then(() => openSignInWindow(hand));
      launches = opening.catch(() => {});
      await opening;
      note({ state: "open", sites: null });
      for (let gone = 0; gone < 2;) { await Bun.sleep(1000); gone = await profileInUse(hand) ? 0 : gone + 1; }
      note({ state: "checking", sites: null });
      return note({ state: "done", sites: await handSessions(hand).catch(() => null) });
    } catch (error) {
      return note({ state: "error", sites: null, error: redact(error instanceof Error ? error.message : "Signing in failed.").slice(0, 400) });
    } finally {
      signingIn.delete(hand.id);
      // A server had this hand's browser ready before; have it ready again.
      if (warming.delete(hand.id)) void warmBrowser(hand).catch(() => {});
    }
  })();
  signingIn.set(hand.id, mine);
  return mine;
}

/** One hand after another: each window says which hand it is, and one at a time there is no mixing them up. */
export async function signInAll(hands: Hand[]): Promise<SignIn[]> {
  for (const hand of hands) if (!signingIn.has(hand.id)) signIns.set(hand.id, { state: "waiting", sites: null });
  const done: SignIn[] = [];
  for (const hand of hands) done.push(await signIn(hand));
  return done;
}

/** The sign-in wall the hand's browser is standing at, or null. Read twice: a signed-in
 * browser passes through the same addresses for a moment on its way to the site. */
export async function handWall(hand: Hand): Promise<Wall | null> {
  const read = async () => {
    const window = await browserWindow(hand);
    if (!window) return null;
    const raw = await handBrowser(hand).evaluate(window, "JSON.stringify([location.href, document.title])");
    const [url, title] = typeof raw === "string" ? JSON.parse(raw) as [string, string] : ["", window.title];
    return signInWall(url, title, hand.id);
  };
  const first = await read();
  if (!first) return null;
  await Bun.sleep(700);
  const second = await read();
  return second?.site === first.site ? second : null;
}

// ---------------------------------------------------------------- what the user is looking at

/** The window the user has in front of them on their own desktop: what "that email" or "this page"
 * means. For understanding the request only. A hand never acts on it; it opens the same site in its
 * own browser. Null when they are looking at a hand, or at nothing but the shell. */
export const userForeground = async (): Promise<Foreground | null> => (await userWindows(1))[0] ?? null;

/** The same, with what is behind it: the user's windows front to back. The one they mean is not
 * always in front; a terminal or Puk's own panel may be, with Gmail right behind it. */
export async function userWindows(limit = 5): Promise<Foreground[]> {
  try {
    const where = JSON.parse(await ask("where")) as string, seen = JSON.parse(await ask("state")).windows as SeenWindow[];
    return seenByUser(seen, new Set([...owned.values()].flatMap((set) => [...set])), where).slice(0, limit);
  } catch (error) { debugLog("win.foreground", String(error)); return []; }
}

// ---------------------------------------------------------------- shell

/** Native Windows Bun has no bash; PowerShell takes its place. WSL keeps ai.ts's runBash. */
export async function runPowerShell(_hand: Hand, command: string, opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}) {
  if (!command.trim() || command.length > 24_000) throw new Error("The shell needs a command of at most 24000 characters.");
  const timeout = AbortSignal.timeout(Math.min(120_000, opts.timeoutMs ?? 30_000));
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], { cwd: opts.cwd, env: subprocessEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, timedOut: timeout.aborted, cancelled: Boolean(opts.signal?.aborted), stdout: redact(stdout.slice(-32_768)), stderr: redact(stderr.slice(-32_768)) };
}

/** Pass as `createDesktopAgent({ desktop })`. */
export const windowsDesktop = { discover: discoverApps, launch: launchInstalledApp, state: handState, cua: connectCua, ...(WSL ? {} : { bash: runPowerShell }) };

// ---------------------------------------------------------------- cli

/** Pure: what to tell the user when a hand's sign-in changes state; "" when there is nothing new to say. */
export function signInLine(id: number, now: SignIn): string {
  if (now.state === "open") return `Hand ${id}: its browser is open on your desktop. Sign in to what this hand should use, then close the window.`;
  if (now.state === "checking") return `Hand ${id}: window closed, looking at what it is signed in to.`;
  if (now.state === "error") return `Hand ${id}: ${now.error ?? "signing in failed."}`;
  if (now.state !== "done") return "";
  if (!now.sites) return `Hand ${id}: could not read its sign-ins just now. Try: bun win/desktop.ts sessions ${id}`;
  return now.sites.length ? `Hand ${id} is signed in to: ${now.sites.join(", ")}.` : `Hand ${id}: none of the sign-ins Puk knows how to recognise (Google, Microsoft, GitHub and the like). Others may still be there.`;
}

if (import.meta.main) {
  const [command, count, ...more] = process.argv.slice(2);
  try {
    if (command === "up") console.log((await startHands(Math.max(1, Math.min(4, Number(count ?? 2) || 2)))).map((h) => h.display).join("\n"));
    else if (command === "down") await stopHands();
    else if (command === "list") console.log((await listHands()).map((h) => h.display).join("\n") || "No hands. Run: bun win/desktop.ts up");
    else if (command === "login" || command === "sessions") {
      const ids = loginTargets([count ?? "", ...more], (await listHands()).map((h) => h.id), Math.max(1, Math.min(4, Number(process.env.PUK_HANDS ?? 2) || 2)));
      if (command === "sessions") {
        for (const id of ids) console.log(signInLine(id, { state: "done", sites: await handSessions(handFor(id)).catch(() => null) }));
      } else {
        // A running Puk owns the hands' browsers: it has to be the one that closes and reopens them.
        const server = `http://127.0.0.1:${process.env.PUK_PORT ?? 7777}/login`;
        const read = (init?: RequestInit, query = "") => fetch(server + query, { ...init, signal: AbortSignal.timeout(5000) }).then(async (r) => ({ ok: r.ok, body: await r.json() as { puk?: string; error?: string; hands?: Record<string, SignIn> } }), () => null);
        const remote = (await read())?.body.puk === "login";
        if (remote) {
          const asked = await read({ method: "POST" }, `?hand=${ids.join(",")}`);
          if (!asked?.ok) throw new Error(asked?.body.error ?? "The running Puk did not take the request.");
        } else void signInAll(ids.map(handFor));
        const said = new Map<number, string>();
        for (let finished = false, silent = 0; !finished;) {
          await Bun.sleep(remote ? 1000 : 300);
          const heard = remote ? (await read())?.body.hands : signInStatus();
          if (!heard && ++silent > 5) throw new Error("The running Puk stopped answering. Any sign-in window that is open still works: finish there and close it.");
          const hands = heard ?? {};
          if (heard) silent = 0;
          for (const id of ids) {
            const line = hands[id] ? signInLine(id, hands[id]) : "";
            if (line && said.get(id) !== line) { said.set(id, line); console.log(line); }
          }
          finished = ids.every((id) => ["done", "error"].includes(hands[id]?.state ?? ""));
        }
      }
    }
    else console.log("usage: bun win/desktop.ts up [n] | list | down | login [n|all] | sessions [n|all]");
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
  for (const relay of relays.values()) (await relay.catch(() => null))?.close();
  (await helper()).close();
}
