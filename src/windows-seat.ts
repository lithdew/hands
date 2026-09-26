/**
 * Windows' half of the seat contract (src/seat.ts). From behind, keys are posted to the hand's own window: a posted key
 * carries no modifier, so a chord needs the seat, and so does a line break in a chat box. The window to look at follows
 * a dialog the hand's window has open. A borrow of the seat is one hand at a time across the machine, waits for the
 * user to pause, brings the window forward, sends the work's input until the user touches anything, and puts back the
 * window and the cursor they had (src/windows.ts, borrow). A hand stopped, paused or clicked while it waits never
 * borrows afterwards: the wait ends with Abort (windows.checkStopped).
 */

import { type KeyTarget, type SeatOptions, type SeatPlatform, SeatTaken } from "./seat.ts";
import * as windows from "./windows.ts";

const QUIET_MS = 1500; // how long the user must have left the mouse and keyboard alone before a hand takes them
const TELL_MS = 1500; // a wait this long is worth showing on the hand and its card
const WAIT_MS = 20_000;
// The user who has just taken the seat back mid-borrow is at work: for a while after, a hand waits for a longer pause
// before it borrows again, rather than taking the mouse the moment they rest it.
const TAKEN_COOL_MS = 30_000;
const TAKEN_QUIET_MS = 5000;

let takenAt = -Infinity; // when the user last took the seat back from one of this hand's borrows

export const windowsSeat: SeatPlatform = {
  chordsFromBehind: false, // a posted key carries no modifier state
  browserKeysFromBehind: true, // keys are posted to a window, so the hand's own browser window can take them
  pressIn: (target: KeyTarget, key: string, modifiers: string[] = []) => windows.pressIn(target, key, modifiers),
  typeIn: (target: KeyTarget, text: string) => windows.typeIn(target, text),
  openFile: (path: string) => windows.openFile(path),
  workingWindow: (pid: number, preferred?: number) => windows.workingWindow(pid, preferred),
  userIdleMs() {
    try {
      return windows.idle().idleMs;
    } catch {
      return 0; // the helper cannot say: taken to be in use
    }
  },
  /**
   * The seat's lock is taken only once the user has paused (windows.whenPaused), and held for the borrow alone: while
   * it is held the panel lets every click through, which it must not do while the user is still at work.
   */
  async withSeat<T>(target: KeyTarget, work: () => Promise<T>, options: SeatOptions): Promise<T> {
    const started = performance.now();
    let told = false;
    const waiting = () => {
      if (told || performance.now() - started < TELL_MS) return;
      told = true;
      options.onWaiting?.();
    };
    const quietMs = started - takenAt < TAKEN_COOL_MS ? TAKEN_QUIET_MS : QUIET_MS;
    const { release, seat } = await windows.whenPaused(quietMs, started + (options.waitMs ?? WAIT_MS), options.why, waiting);
    try {
      return await windows.borrow(target, seat.tick, work, options.onHolding);
    } catch (error) {
      if (error instanceof SeatTaken) takenAt = performance.now();
      throw error;
    } finally {
      release();
    }
  },
};
