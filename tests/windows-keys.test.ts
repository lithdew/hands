import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame } from "../src/models.ts";
import * as windows from "../src/windows.ts";
import { windowsSeat } from "../src/windows-seat.ts";

// Keys from behind: which window they go to, and what cannot be sent that way. The helper is a script of replies,
// as in tests/windows.test.ts.

type Args = Record<string, unknown>;
type Reply = ((args: Args) => unknown) | object | null;
let calls: [string, Args][];
const HOUSEKEEPING: Record<string, Reply> = { displays: [{ index: 0, frame: [0, 0, 2560, 1600] }], foreground: { hwnd: 11, pid: 100 }, sink: { ok: true }, exe: { name: "Notepad", path: "" }, idle: { idleMs: 60_000, held: [], quiet: true, tick: 1 }, guard: { taken: false, back: true } }; // prettier-ignore

function helper(replies: Record<string, Reply>): void {
  spyOn(windows.native, "call").mockImplementation((command: string, args: Args = {}) => {
    calls.push([command, args]);
    const reply = replies[command] ?? HOUSEKEEPING[command];
    if (reply === undefined) throw new Error(`the test did not expect the helper to be asked for ${JSON.stringify(command)}`);
    return typeof reply === "function" ? (reply as (args: Args) => unknown)(args) : reply;
  });
}
const asked = (command: string) => calls.filter(([c]) => c === command).map(([, args]) => args);

const terminal = { hwnd: 11, pid: 100, cls: "CASCADIA_HOSTING_WINDOW_CLASS", title: "bun hands", frame: [0, 0, 900, 600] as Frame, core: 0, exe: "WindowsTerminal.exe" };
const theirs = { hwnd: 66, pid: 500, cls: "Notepad", title: ".env - Notepad", frame: [0, 0, 400, 500] as Frame, core: 0, exe: "Notepad.exe", caption: true };
const mine = { hwnd: 55, pid: 500, cls: "Notepad", title: "Untitled - Notepad", frame: [0, 0, 400, 500] as Frame, core: 0, exe: "Notepad.exe", caption: true };

/** A hand that has opened Notepad in the user's running Notepad: both windows in one process, the user's in front. */
async function notepadOpened(extra: Record<string, Reply> = {}): Promise<void> {
  let launched = false;
  helper({ processes: [{ pid: 500, cmd: "notepad.exe" }], windows: () => (launched ? [terminal, theirs, mine] : [terminal, theirs]), launch: () => ((launched = true), { pid: 0 }), chars: { ok: true }, vkey: { ok: true }, ...extra });
  windows.releaseDesktop();
  expect(await windows.runInBackground("Notepad")).toBe(500);
  calls = [];
}

let lockRoot: string;
beforeEach(() => {
  calls = [];
  windows.pace.persistMs = 0;
  windows.pace.seatWatchMs = 0;
  windows.pace.browserWatchMs = 0;
  lockRoot = mkdtempSync(join(tmpdir(), "hands-test-locks-"));
  windows.locks.root = lockRoot;
});
afterEach(() => {
  windows.releaseDesktop();
  mock.restore();
  rmSync(lockRoot, { recursive: true, force: true });
});

test("keys typed from behind go to the hand's own window, never the user's window of the same app in front of it", async () => {
  await notepadOpened();
  expect(windows.mainWindowId(500)).toBe(55);
  await windows.typeText("secret", 500);
  await windows.press("return", [], 500);
  expect(asked("chars")).toEqual([{ hwnd: 55, text: "secret" }]);
  expect(asked("vkey")).toEqual([{ hwnd: 55, vk: 0x0d }]);
  await windowsSeat.typeIn({ pid: 500, windowId: 55 }, "more");
  await windowsSeat.pressIn({ pid: 500, windowId: 55 }, "tab");
  expect(asked("chars").at(-1)).toEqual({ hwnd: 55, text: "more" });
  expect(asked("vkey").at(-1)).toEqual({ hwnd: 55, vk: 0x09 });
});

test("a key is never posted to a window of the user's while the hand has windows of its own in that app", async () => {
  await notepadOpened();
  await expect(windowsSeat.typeIn({ pid: 500, windowId: 66 }, "secret")).rejects.toThrow("not one this hand opened");
  await expect(windowsSeat.pressIn({ pid: 500, windowId: 66 }, "return")).rejects.toThrow("not one this hand opened");
  expect(asked("chars")).toEqual([]);
  expect(asked("vkey")).toEqual([]);
});

test("in an app the hand only took up as it was, keys go to the window it was pointed at", async () => {
  const spotify = { hwnd: 77, pid: 700, cls: "Chrome_WidgetWin_0", title: "Spotify", frame: [0, 0, 400, 500] as Frame, core: 0, exe: "Spotify.exe", caption: true };
  helper({ windows: [terminal, spotify], vkey: { ok: true } });
  await windowsSeat.pressIn({ pid: 700, windowId: 77 }, "space");
  expect(asked("vkey")).toEqual([{ hwnd: 77, vk: 0x20 }]);
});

test("a chord from behind throws, naming it, and nothing is posted: a posted key carries no modifier", async () => {
  await notepadOpened();
  await expect(windows.press("s", ["ctrl"], 500)).rejects.toThrow("ctrl+s cannot be sent to a window from behind");
  await expect(windowsSeat.pressIn({ pid: 500, windowId: 55 }, "f4", ["alt"])).rejects.toThrow("alt+f4");
  await expect(windowsSeat.pressIn({ pid: 500, windowId: 55 }, "tab", ["shift"])).rejects.toThrow("shift+tab"); // shift with a key that is not a character
  await expect(windowsSeat.pressIn({ pid: 500, windowId: 55 }, "win")).rejects.toThrow("win cannot be sent"); // a modifier alone
  expect(asked("vkey")).toEqual([]);
  expect(asked("chars")).toEqual([]);
  expect(windowsSeat.chordsFromBehind).toBe(false);
  expect(windowsSeat.browserKeysFromBehind).toBe(true);
});

test("shift with a character is posted as the character it makes, and '+' or '*' as themselves", async () => {
  await notepadOpened();
  await windowsSeat.pressIn({ pid: 500, windowId: 55 }, "1", ["shift"]);
  await windowsSeat.pressIn({ pid: 500, windowId: 55 }, "a", ["shift"]);
  await windowsSeat.pressIn({ pid: 500, windowId: 55 }, "plus");
  await windowsSeat.pressIn({ pid: 500, windowId: 55 }, "*");
  await windowsSeat.pressIn({ pid: 500, windowId: 55 }, "delete");
  expect(asked("chars").map((a) => a.text)).toEqual(["!", "A", "+", "*"]);
  expect(asked("vkey")).toEqual([{ hwnd: 55, vk: 0x2e }]);
});

test("a keystroke is a key and its modifiers, or text: the table the seat and the posted keys share", () => {
  expect(windows.keystroke("s", ["ctrl"])).toEqual({ vk: 0x53, mods: [0x11] });
  expect(windows.keystroke("A", ["ctrl"])).toEqual({ vk: 0x41, mods: [0x11] }); // how a shortcut is written, not shift
  expect(windows.keystroke("A")).toEqual({ text: "A" });
  expect(windows.keystroke("plus", ["ctrl"])).toEqual({ vk: 0xbb, mods: [0x11, 0x10] });
  expect(windows.keystroke("=", ["ctrl"])).toEqual({ vk: 0xbb, mods: [0x11] });
  expect(windows.keystroke("8", ["shift"])).toEqual({ text: "*" });
  expect(windows.keystroke("tab", ["shift"])).toEqual({ vk: 0x09, mods: [0x10] });
  expect(windows.keystroke("alt")).toEqual({ vk: 0x12, mods: [] });
  expect(windows.keystroke("pgdn")).toEqual({ vk: 0x22, mods: [] });
  expect(() => windows.keystroke("hyper")).toThrow("unknown key");
  expect(() => windows.keystroke("a", ["meta+"])).toThrow("unknown modifier");
});

test("a line break the helper refuses (Enter would send a chat message) comes back as an error starting 'line break:'", async () => {
  const chrome = { hwnd: 44, pid: 400, cls: "Chrome_WidgetWin_1", title: "WhatsApp", frame: [0, 0, 900, 600] as Frame, core: 0, exe: "chrome.exe", caption: true };
  helper({ windows: [terminal, chrome], chars: () => { throw new Error("chars: Exception: line break: a line break typed here would press Enter, which sends the message in a chat app."); } }); // prettier-ignore
  const refused = windowsSeat.typeIn({ pid: 400, windowId: 44 }, "one\ntwo");
  await expect(refused).rejects.toThrow(/^line break: a line break typed here would press Enter/);
});

test("a field's value is read back until it shows the text, spaces and quotes as the field spells them; a refused line break is an error", () => {
  const tree = { nodes: [{ id: 1, parent: -1, role: "AXGroup", label: "w", frame: [0, 0, 500, 500], actions: [] }, { id: 7, parent: 1, role: "AXTextField", label: "Message", frame: [10, 10, 200, 30], actions: [] }], capped: false };
  let value = "";
  helper({
    windows: [terminal, { ...mine, hwnd: 44, cls: "Chrome_WidgetWin_1", exe: "chrome.exe" }],
    exe: { name: "chrome", path: "" },
    tree,
    setValue: ({ text }) => {
      if (String(text).includes("\n")) throw new Error("setValue: Exception: line break: a line break typed here would press Enter");
      value = String(text).replace(/ /g, "\u00a0").replace(/'/g, "\u2019"); // as a rich editor gives it back
      return { ok: true, posted: true };
    },
    value: () => ({ value }),
  });
  const [[field]] = windows.actionableElements(500, [0, 0, 2560, 1600], { windowId: 44 });
  expect(windows.axSetValue(field!.ref, "it's  here")).toBe(true);
  expect(windows.holdsText(value, "it's  here")).toBe(true);
  expect(asked("value")).toHaveLength(1); // it matched on the first read-back
  expect(asked("guard")).toEqual([]); // the helper guards its own clicks into the field
  expect(asked("setValue")[0]).toEqual({ id: 7, text: "it's  here", sink: false }); // and hands the foreground back without sinking a window that is not the hand's
  expect(asked("idle")).toHaveLength(1); // after waiting, under the seat's lock, for the user to pause
  expect(() => windows.axSetValue(field!.ref, "one\ntwo")).toThrow(/^line break:/);
  expect(windows.plainText("  a\u00a0b \u201cc\u201d\u2019 ")).toBe("a b \"c\"'");
});

test("a dialog that comes up in front after a key from behind is sent back, and the user's window is in front again", async () => {
  const dialog = { hwnd: 57, pid: 500, cls: "#32770", title: "Save As", frame: [50, 50, 300, 200] as Frame, core: 0, exe: "Notepad.exe", owner: 55, caption: true };
  let front = { hwnd: 11, pid: 100 };
  let launched = false;
  helper({
    processes: [{ pid: 500, cmd: "notepad.exe" }],
    windows: () => (launched ? [dialog, terminal, theirs, { ...mine, enabled: front.hwnd === 57 ? false : true }] : [terminal, theirs]),
    launch: () => ((launched = true), { pid: 0 }),
    foreground: () => front,
    vkey: () => ((front = { hwnd: 57, pid: 500 }), { ok: true }), // Enter on "Save": the dialog comes up in front
    activate: ({ hwnd }) => ((front = { hwnd: hwnd as number, pid: 100 }), { ok: true }),
  });
  windows.releaseDesktop();
  await windows.runInBackground("Notepad");
  calls = [];
  await windowsSeat.pressIn({ pid: 500, windowId: 55 }, "return");
  expect(asked("activate")).toEqual([{ hwnd: 11 }]);
  expect(asked("sink")).toEqual([{ hwnd: 55 }]); // its owner, and the dialog with it
  expect(front.hwnd).toBe(11);
});
