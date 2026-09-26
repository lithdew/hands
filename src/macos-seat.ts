/**
 * The Mac's half of the seat contract (src/seat.ts). The Mac already reaches most things from behind: keys carry
 * their modifiers to a process, menus are pressed without opening, the focused window follows its sheets. So a
 * borrow is rare here, and simple: the app is brought forward, the work done, and the app the user was in put back.
 */

import * as mac from "./macos.ts";
import { type KeyTarget, type SeatOptions, type SeatPlatform, SeatBusy } from "./seat.ts";

export const macSeat: SeatPlatform = {
  chordsFromBehind: true,
  browserKeysFromBehind: false, // keys go to a process, and in the browser that is whichever window the user is in
  pressIn: (target: KeyTarget, key: string, modifiers: string[] = []) => mac.press(key, modifiers, target.pid),
  typeIn: (target: KeyTarget, text: string) => mac.typeText(text, target.pid),
  workingWindow(pid: number, preferred?: number) {
    const windowId = preferred ?? mac.mainWindowId(pid);
    return windowId === null || windowId === undefined ? null : { windowId, dialog: null, theirs: false };
  },
  userIdleMs: () => Number.POSITIVE_INFINITY, // not measured on the Mac: a borrow there does not wait
  async withSeat<T>(target: KeyTarget, work: () => Promise<T>, options: SeatOptions): Promise<T> {
    const before = await mac.frontmostApp();
    options.onHolding?.();
    if (!(await mac.activate(mac.appName(target.pid)))) throw new SeatBusy(`${mac.appName(target.pid)} would not come forward for ${options.why}`);
    try {
      return await work();
    } finally {
      if (before) await mac.activate(before).catch(() => false);
    }
  },
};
