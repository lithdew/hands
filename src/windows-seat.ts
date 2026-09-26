/**
 * Windows' half of the seat contract (src/seat.ts). CONTRACT STUB: the native work package replaces every body here
 * (keys posted to the hand's own window, dialogs followed, idle from GetLastInputInfo, the borrow itself).
 */

import { type KeyTarget, type SeatOptions, type SeatPlatform } from "./seat.ts";
import * as windows from "./windows.ts";

export const windowsSeat: SeatPlatform = {
  chordsFromBehind: false, // a posted key carries no modifier state
  browserKeysFromBehind: true, // keys are posted to a window, so the hand's own browser window can take them
  pressIn: (target: KeyTarget, key: string, modifiers: string[] = []) => windows.press(key, modifiers, target.pid),
  typeIn: (target: KeyTarget, text: string) => windows.typeText(text, target.pid),
  async openFile(path: string): Promise<KeyTarget> {
    throw new Error(`opening a file is not built yet (${path})`);
  },
  workingWindow(pid: number, preferred?: number) {
    const windowId = preferred ?? windows.mainWindowId(pid);
    return windowId === null ? null : { windowId, dialog: null, theirs: false };
  },
  userIdleMs: () => 0,
  async withSeat<T>(_target: KeyTarget, _work: () => Promise<T>, options: SeatOptions): Promise<T> {
    throw new Error(`borrowing the seat is not built yet (${options.why})`);
  },
};
