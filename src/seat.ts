/**
 * The one mode: a hand works from behind the user's windows, in windows of its own, and borrows the seat (the real
 * mouse and keyboard) only for what cannot be done from there: a shortcut with modifiers where posted keys carry
 * none, a drag an app ignores when it is posted, a click that had no effect from behind. A borrow waits for the user
 * to pause, is one hand at a time across every hand on the machine, and gives the foreground and the cursor back.
 *
 * This file is the contract between the tools (src/tools.ts) and each platform's half of it (src/macos-seat.ts,
 * src/windows-seat.ts). Types and errors only, plus nothing that touches the machine.
 */

/** A window to send input to, and the process that owns it. */
export interface KeyTarget {
  pid: number;
  windowId: number;
}

/** The window a hand should look at and act in now. */
export interface WorkingWindow {
  windowId: number;
  /** The title of a dialog the hand's window has opened (Open, Save As, a message box), which is what is shown instead; null when there is none. */
  dialog: string | null;
  /** The window is the user's own, not one the hand opened: an app that opens no second window. */
  theirs: boolean;
}

export interface SeatOptions {
  /** Said on the hand's tag and in the panel while it waits and while it holds the seat: "pressing ctrl+s". */
  why: string;
  /** How long to wait for the user to pause before giving up with SeatBusy. Default 20 s. */
  waitMs?: number;
  /** Called once when the wait has gone on long enough to be worth showing (about 1.5 s). */
  onWaiting?: () => void;
  /** Called once the seat is held, just before `work` runs. */
  onHolding?: () => void;
}

/** The user did not pause long enough for a borrow: nothing was done. */
export class SeatBusy extends Error {
  override name = "SeatBusy";
}

/** The user moved the mouse or typed during a borrow: the work was cut short and the seat given back. */
export class SeatTaken extends Error {
  override name = "SeatTaken";
}

export interface SeatPlatform {
  /** Whether a key with modifiers (ctrl+s) reaches a window from behind. The Mac posts flags with keys; Windows cannot. */
  readonly chordsFromBehind: boolean;
  /** Whether plain keys (Enter, Tab, arrows, text) can be sent from behind to a browser window of the hand's own. */
  readonly browserKeysFromBehind: boolean;
  /** Keys to one window from behind. Modifiers only where chordsFromBehind; otherwise the caller borrows the seat. */
  pressIn(target: KeyTarget, key: string, modifiers?: string[]): Promise<void>;
  /** Text to one window from behind, into wherever that window's own cursor is. */
  typeIn(target: KeyTarget, text: string): Promise<void>;
  /** The window to look at for a hand working in `pid`: `preferred` (or its own window of that app), or a dialog it has opened. Null when the app has no window. */
  workingWindow(pid: number, preferred?: number): WorkingWindow | null;
  /** Milliseconds since the user last touched the mouse or keyboard, not counting input the hands made themselves. */
  userIdleMs(): number;
  /**
   * Borrow the seat for `work`, in `target`'s window: wait until the user pauses (or throw SeatBusy), bring the window
   * forward, run `work` (which uses the platform's seat input: clickAt, press and typeText without a target, drag,
   * scroll), then put back the window and the cursor the user had. Throws SeatTaken if the user takes over midway.
   */
  withSeat<T>(target: KeyTarget, work: () => Promise<T>, options: SeatOptions): Promise<T>;
}
