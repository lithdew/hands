import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame } from "../src/models.ts";
import * as windows from "../src/windows.ts";
import { windowsSeat } from "../src/windows-seat.ts";

// Starting an app, or a document, for a window of the hand's own. The helper is a script of replies, as in
// tests/windows.test.ts.

type Args = Record<string, unknown>;
type Reply = ((args: Args) => unknown) | object | null;
let calls: [string, Args][];
const HOUSEKEEPING: Record<string, Reply> = { displays: [{ index: 0, frame: [0, 0, 2560, 1600] }], foreground: { hwnd: 11, pid: 100 }, sink: { ok: true }, processes: [] }; // prettier-ignore

function helper(replies: Record<string, Reply>): void {
  spyOn(windows.native, "call").mockImplementation((command: string, args: Args = {}) => {
    calls.push([command, args]);
    const reply = replies[command] ?? HOUSEKEEPING[command];
    if (reply === undefined) throw new Error(`the test did not expect the helper to be asked for ${JSON.stringify(command)}`);
    return typeof reply === "function" ? (reply as (args: Args) => unknown)(args) : reply;
  });
}
const asked = (command: string) => calls.filter(([c]) => c === command).map(([, args]) => args);

const terminal = { hwnd: 11, pid: 100, cls: "CASCADIA_HOSTING_WINDOW_CLASS", title: "bun hands", frame: [0, 0, 900, 600] as Frame, core: 0, exe: "WindowsTerminal.exe", caption: true };
const window = (hwnd: number, pid: number, exe: string, extra: object = {}) => ({ hwnd, pid, cls: "App", title: `Window ${hwnd}`, frame: [0, 0, 800, 600] as Frame, core: 0, exe, caption: true, ...extra });

let lockRoot: string;
beforeEach(() => {
  calls = [];
  windows.pace.persistMs = 0;
  windows.pace.seatWatchMs = 0;
  windows.pace.browserWatchMs = 0;
  lockRoot = mkdtempSync(join(tmpdir(), "hands-test-locks-"));
  windows.locks.root = lockRoot;
  spyOn(process, "kill").mockImplementation(() => {
    throw new Error("no such process"); // an app is looked for afresh each time
  });
});
afterEach(() => {
  windows.releaseDesktop();
  mock.restore();
  rmSync(lockRoot, { recursive: true, force: true });
});

test("a window of anyone else's that appears during a launch is never taken for the app's", async () => {
  const strangers = window(77, 900, "explorer.exe", { cls: "CabinetWClass", title: "Documents - File Explorer" });
  let launched = false;
  helper({ windows: () => (launched ? [terminal, strangers] : [terminal]), launch: () => ((launched = true), { pid: 0 }) });
  await expect(windows.runInBackground("Paint", 0.3)).rejects.toThrow("Paint opened no window");
  expect(asked("sink")).toEqual([]);
  expect(windows.mainWindowId(900)).toBe(77); // nothing of the stranger's became the hand's
});

test("a splash screen, a message box and a window that comes and goes are passed over for the app's main window", async () => {
  const splash = window(71, 500, "EXCEL.EXE", { cls: "MsoSplash", popup: true, caption: false });
  const box = window(72, 500, "EXCEL.EXE", { cls: "#32770", title: "Microsoft Excel" });
  const main = window(73, 500, "EXCEL.EXE", { cls: "XLMAIN", title: "Book1 - Excel" });
  let asks = 0;
  helper({ windows: () => [terminal, ...(asks++ === 1 ? [splash, box, window(74, 500, "EXCEL.EXE")] : asks > 2 ? [splash, box, main] : [])], launch: { pid: 0 } });
  windows.pace.persistMs = 1; // 74 shows for one look only
  expect(await windows.runInBackground("Excel")).toBe(500);
  expect(windows.mainWindowId(500)).toBe(73);
  expect(asked("launch")).toEqual([{ file: "EXCEL.EXE", args: "", show: 4 }]);
});

test("a window is known for the app by the process the shell started or its children, by a shortcut's target, or by the package of an AppID", async () => {
  let launched = "";
  const list: Record<string, object[]> = {
    kid: [window(81, 610, "helper-host.exe")], // a launcher that hands over to a child process with another name
    lnk: [window(82, 620, "Code.exe")],
    appid: [window(83, 630, "claude.exe", { package: "Claude_pzs8sxrjxfjjc" })],
  };
  helper({
    windows: () => [terminal, ...(list[launched] ?? [])],
    launch: ({ file }) => {
      launched = String(file).endsWith(".lnk") ? "lnk" : String(file).startsWith("shell:") ? "appid" : "kid";
      return { pid: launched === "kid" ? 600 : 0, exe: launched === "kid" ? "launcher.exe" : "", target: launched === "lnk" ? "Code.exe" : "" };
    },
    children: ({ pid }) => (pid === 600 ? [610] : []),
  });
  expect(await windows.runInBackground("C:\\Tools\\launcher.exe")).toBe(610);
  expect(await windows.runInBackground("C:\\Users\\me\\Desktop\\Code.lnk")).toBe(620);
  expect(await windows.runInBackground("Claude_pzs8sxrjxfjjc!Claude")).toBe(630);
  expect(asked("launch").map((a) => a.file)).toEqual(["C:\\Tools\\launcher.exe", "C:\\Users\\me\\Desktop\\Code.lnk", "shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude"]);
  expect(asked("processes")).toEqual([{ exe: "launcher.exe" }]); // by the file name, not the path; nothing for a shortcut or an AppID
});

test("the launch is made under the lock every hand shares, and whoever had the keyboard gets it back from an app that takes it", async () => {
  let front = { hwnd: 11, pid: 100 };
  let launched = false;
  let locked = false;
  helper({
    windows: () => (launched ? [window(55, 500, "Notepad.exe"), terminal] : [terminal]),
    foreground: () => front,
    launch: () => {
      locked = existsSync(join(lockRoot, "hands-open-window.lock"));
      launched = true;
      front = { hwnd: 55, pid: 500 }; // Notepad takes the foreground as it appears (measured)
      return { pid: 0 };
    },
    activate: ({ hwnd }) => ((front = { hwnd: hwnd as number, pid: 100 }), { ok: true }),
  });
  expect(await windows.runInBackground("Notepad")).toBe(500);
  expect(locked).toBe(true);
  expect(existsSync(join(lockRoot, "hands-open-window.lock"))).toBe(false);
  expect(asked("activate")).toEqual([{ hwnd: 11 }]);
  expect(asked("sink")).toEqual([{ hwnd: 55 }]);
});

test("an app that opens no window of the hand's own is handed back its pid, its window is the user's, and the keyboard goes back even so", async () => {
  const spotify = window(66, 500, "Spotify.exe", { title: "Spotify" });
  let front = { hwnd: 11, pid: 100 };
  helper({
    processes: [{ pid: 500, cmd: '"C:\\spotify.exe"' }],
    windows: [spotify, terminal],
    foreground: () => front,
    launch: () => ((front = { hwnd: 66, pid: 500 }), { pid: 0 }), // a single-instance app brings its window forward instead
    activate: ({ hwnd }) => ((front = { hwnd: hwnd as number, pid: 100 }), { ok: true }),
  });
  expect(await windows.runInBackground("Spotify", 0.2)).toBe(500);
  expect(front.hwnd).toBe(11);
  expect(asked("sink")).toEqual([]); // a window of the user's is never put anywhere
  expect(windowsSeat.workingWindow(500)).toEqual({ windowId: 66, dialog: null, theirs: true });
});

test("a window the user brings forward during a launch is theirs, and stays in front", async () => {
  const theirs = window(66, 700, "WINWORD.EXE", { title: "Report - Word" });
  let front = { hwnd: 11, pid: 100 };
  let launched = false;
  helper({
    windows: () => (launched ? [theirs, window(55, 500, "Notepad.exe"), terminal] : [theirs, terminal]),
    foreground: () => front,
    launch: () => ((launched = true), (front = { hwnd: 66, pid: 700 }), { pid: 0 }), // the user clicked into Word
    activate: () => ({ ok: true }),
  });
  expect(await windows.runInBackground("Notepad")).toBe(500);
  expect(asked("activate")).toEqual([]);
});

test("a document is opened by the shell as a window of the hand's own, known by the app that opens its kind or by its name in the title", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hands-test-doc-"));
  const file = join(dir, "Model 2026.xlsx");
  writeFileSync(file, "");
  let launched = false;
  helper({
    windows: () => (launched ? [window(90, 900, "EXCEL.EXE", { cls: "XLMAIN", title: "Model 2026.xlsx - Excel" }), terminal] : [terminal]),
    assoc: ({ ext }) => ({ exe: ext === ".xlsx" ? "EXCEL.EXE" : "" }),
    launch: () => ((launched = true), { pid: 0 }),
  });
  try {
    expect(await windowsSeat.openFile(file)).toEqual({ pid: 900, windowId: 90 });
    expect(asked("launch")).toEqual([{ file, args: "", show: 4 }]);
    expect(asked("sink")).toEqual([{ hwnd: 90 }]);
    expect(windowsSeat.workingWindow(900)).toEqual({ windowId: 90, dialog: null, theirs: false });
    await expect(windowsSeat.openFile(join(dir, "missing.txt"))).rejects.toThrow("there is no file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a window of another app that carries the document's name is never taken for the document's, nor has its foreground taken back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hands-test-doc-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "");
  let front = { hwnd: 11, pid: 100 };
  let launched = false;
  const users = window(77, 900, "OUTLOOK.EXE", { title: "RE: notes - Message" }); // the user opens a mail about the notes meanwhile
  const notepad = window(78, 500, "Notepad.exe", { title: "notes.txt - Notepad" });
  helper({
    windows: () => (launched ? [users, notepad, terminal] : [terminal]),
    assoc: { exe: "Notepad.exe" },
    foreground: () => front,
    launch: () => ((launched = true), (front = { hwnd: 77, pid: 900 }), { pid: 0 }),
    activate: ({ hwnd }) => ((front = { hwnd: hwnd as number, pid: 100 }), { ok: true }),
  });
  try {
    expect(await windowsSeat.openFile(file)).toEqual({ pid: 500, windowId: 78 });
    expect(asked("activate")).toEqual([]); // the user's mail keeps the foreground they gave it
    expect(front.hwnd).toBe(77);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new browser window is handed back from, and only it: a window the user opens meanwhile keeps the foreground", async () => {
  let front = { hwnd: 11, pid: 100 };
  let launched = false;
  const chrome = window(46, 400, "chrome.exe", { cls: "Chrome_WidgetWin_1", title: "Example - Google Chrome" });
  const explorer = window(77, 900, "explorer.exe", { cls: "CabinetWClass", title: "Documents" });
  helper({
    processes: ({ exe }) => (exe === "chrome.exe" ? [{ pid: 400, cmd: '"C:\\chrome.exe"' }] : []),
    windows: () => (launched ? [explorer, chrome, terminal] : [terminal]),
    foreground: () => front,
    launch: () => ((launched = true), (front = { hwnd: 77, pid: 900 }), { pid: 0 }), // the user opened Explorer as the browser started
    activate: ({ hwnd }) => ((front = { hwnd: hwnd as number, pid: 100 }), { ok: true }),
    reg: { value: null },
  });
  spyOn(process, "kill").mockImplementation(() => true);
  expect((await windows.openBackgroundWindow("Google Chrome", "https://example.com/")).windowId).toBe(46);
  expect(asked("activate")).toEqual([]);
  expect(front.hwnd).toBe(77);
});

test("a document that opens no window of the hand's own is an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hands-test-doc-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "");
  helper({ windows: [terminal], assoc: { exe: "Notepad.exe" }, launch: { pid: 0 } });
  const clock = spyOn(performance, "now");
  let now = 0;
  clock.mockImplementation(() => (now += 1000));
  try {
    await expect(windowsSeat.openFile(file)).rejects.toThrow("notes.txt opened no window of its own");
  } finally {
    clock.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an app's name is what the shell is handed: a known name, a URI, an AppID, a shortcut, a path", () => {
  expect(windows.appSpec("Settings")).toEqual({ file: "ms-settings:", exe: "SystemSettings.exe", package: null });
  expect(windows.appSpec("ms-settings:batterysaver")).toEqual({ file: "ms-settings:batterysaver", exe: "SystemSettings.exe", package: null });
  expect(windows.appSpec("Word")).toEqual({ file: "WINWORD.EXE", exe: "WINWORD.EXE", package: null });
  expect(windows.appSpec("Microsoft Excel").exe).toBe("EXCEL.EXE");
  expect(windows.appSpec("PowerPoint").exe).toBe("POWERPNT.EXE");
  expect(windows.appSpec("Microsoft.YourPhone_8wekyb3d8bbwe!App")).toEqual({ file: "shell:AppsFolder\\Microsoft.YourPhone_8wekyb3d8bbwe!App", exe: null, package: "Microsoft.YourPhone_8wekyb3d8bbwe" });
  expect(windows.appSpec("shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude").package).toBe("Claude_pzs8sxrjxfjjc");
  expect(windows.appSpec("powercfg.cpl")).toMatchObject({ file: "powercfg.cpl", dialogs: true });
  expect(windows.appSpec("devmgmt.msc")).toEqual({ file: "devmgmt.msc", exe: "mmc.exe", package: null });
  expect(windows.appSpec("C:\\Program Files\\WindowsApps\\Claude\\claude.exe")).toEqual({ file: "C:\\Program Files\\WindowsApps\\Claude\\claude.exe", exe: "claude.exe", package: null });
  expect(windows.appSpec("C:\\Users\\me\\Desktop\\Code.lnk")).toEqual({ file: "C:\\Users\\me\\Desktop\\Code.lnk", exe: null, package: null });
  expect(windows.appSpec("PhoneExperienceHost")).toEqual({ file: "PhoneExperienceHost.exe", exe: "PhoneExperienceHost.exe", package: null });
});

test("an app not on the PATH is found by its Start Menu shortcut, else among the shell's packaged apps", () => {
  const menu = mkdtempSync(join(tmpdir(), "hands-test-menu-"));
  mkdirSync(join(menu, "Microsoft Office"));
  writeFileSync(join(menu, "Microsoft Office", "Excel.lnk"), "");
  writeFileSync(join(menu, "Excellent Notes.lnk"), "");
  const packaged = (): [string, string][] => [["Claude", "Claude_pzs8sxrjxfjjc!Claude"], ["Spotify Music", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"]];
  try {
    expect(windows.installedApp("excel", [menu], packaged)).toBe(join(menu, "Microsoft Office", "Excel.lnk"));
    expect(windows.installedApp("excellent", [menu], packaged)).toBe(join(menu, "Excellent Notes.lnk")); // a name the shortcut starts with
    expect(windows.installedApp("Claude", [menu], packaged)).toBe("shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude");
    expect(windows.installedApp("spotify", [menu], packaged)).toBe("shell:AppsFolder\\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify");
    expect(windows.installedApp("nothing", [menu, join(menu, "absent")], packaged)).toBeNull();
  } finally {
    rmSync(menu, { recursive: true, force: true });
  }
});
