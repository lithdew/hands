/**
 * The Mac's half of the seat contract (src/seat.ts). The Mac already reaches most things from behind: keys carry
 * their modifiers to a process, menus are pressed without opening, the focused window follows its sheets. A borrow
 * of the seat is not built here yet: raising the app raises whichever of its windows the user was in (in the browser,
 * their own window over the hand's), and nothing waits for the user to pause or puts their cursor back. So a borrow is
 * refused outright, and the tools tell the model to do it from behind or finish with needs_you.
 */

import * as mac from "./macos.ts";
import type { KeyTarget, SeatOptions, SeatPlatform } from "./seat.ts";

/**
 * The windows each app had when the hand first looked at it. On the Mac the hand works in an app's current window
 * (open_app starts no second one), which is the user's own document whenever the app was open already; a window that
 * turned up later is one the hand made itself (File > New in its `menu`).
 */
const foundThere = new Map<number, Set<number>>();

export const macSeat: SeatPlatform = {
  chordsFromBehind: true,
  browserKeysFromBehind: false, // keys go to a process, and in the browser that is whichever window the user is in
  pressIn: (target: KeyTarget, key: string, modifiers: string[] = []) => mac.press(key, modifiers, target.pid),
  typeIn: (target: KeyTarget, text: string) => mac.typeText(text, target.pid),
  async openFile(path: string): Promise<KeyTarget> {
    throw new Error(`opening a file as a window of its own is not built on the Mac yet: open its app, then the file from there (${path})`);
  },
  workingWindow(pid: number, preferred?: number) {
    if (preferred !== undefined) return { windowId: preferred, dialog: null, theirs: false }; // the browser window the hand opened for itself
    const windowId = mac.mainWindowId(pid);
    if (windowId === null) return null;
    if (!foundThere.has(pid)) foundThere.set(pid, new Set([windowId, ...mac.appWindows(pid).map((w) => w.id)]));
    return { windowId, dialog: null, theirs: foundThere.get(pid)!.has(windowId) };
  },
  userIdleMs: () => Number.POSITIVE_INFINITY, // not measured on the Mac, where nothing borrows the seat yet
  async withSeat<T>(_target: KeyTarget, _work: () => Promise<T>, options: SeatOptions): Promise<T> {
    throw new Error(`not on the Mac: borrowing the user's mouse and keyboard is not available on the Mac yet, so ${options.why} did not happen`);
  },
};
