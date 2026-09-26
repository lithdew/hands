/**
 * Windows' half of the seat contract (src/seat.ts). From behind, keys are posted to the hand's own window: a posted key
 * carries no modifier, so a chord needs the seat, and so does a line break in a chat box. The window to look at follows
 * a dialog the hand's window has open. A borrow of the seat is one hand at a time across the machine, waits for the
 * user to pause, brings the window forward, sends the work's input until the user touches anything, and puts back the
 * window and the cursor they had (src/windows.ts, borrow).
 */

import { type KeyTarget, type SeatOptions, type SeatPlatform, SeatBusy } from "./seat.ts";
import * as windows from "./windows.ts";

const QUIET_MS = 1500; // how long the user must have left the mouse and keyboard alone before a hand takes them
const TELL_MS = 1500; // a wait this long is worth showing on the hand and its card
const WAIT_MS = 20_000;
const POLL_MS = 100;

/** Why the user was not paused, as a SeatBusy says it. */
const busy = (seat: windows.Idle): string =>
  seat.held.length > 0 ? `the user was holding ${seat.held[0]}` : !seat.quiet ? "a full-screen app or a presentation was up" : "the user kept using the mouse or keyboard";

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
  async withSeat<T>(target: KeyTarget, work: () => Promise<T>, options: SeatOptions): Promise<T> {
    const started = performance.now();
    const until = started + (options.waitMs ?? WAIT_MS);
    let told = false;
    const waiting = () => {
      if (told || performance.now() - started < TELL_MS) return;
      told = true;
      options.onWaiting?.();
    };
    const release = await windows.takeLock(windows.SEAT_LOCK, until, waiting);
    if (!release) throw new SeatBusy(`another hand had the mouse and keyboard all this time, so ${options.why} did not happen`);
    try {
      for (;;) {
        const seat = windows.idle();
        if (windows.paused(seat, QUIET_MS)) return await windows.borrow(target, seat.tick, work, options.onHolding);
        if (performance.now() >= until) throw new SeatBusy(`${busy(seat)}, so ${options.why} did not happen`);
        waiting();
        await Bun.sleep(POLL_MS);
      }
    } finally {
      release();
    }
  },
};
