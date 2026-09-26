/** What the orchestrator and its panel say to each other. Types only: this file is in both bundles. */

/** needs_you: the hand stopped for something only the user can do (a login, a CAPTCHA, a choice), and says what in its answer. */
export type Status = "starting" | "working" | "paused" | "needs_you" | "done" | "failed" | "stopped";

export interface LogEntry {
  kind: "task" | "tool" | "result" | "error" | "say" | "steer" | "status";
  text: string;
  call?: string; // on a tool call and on its result: the call's id, so a result finds its own call when several run at once
  moves?: number; // on a clicker call's result: how many moves Jev made in it
}

/** Whether a hand is borrowing the user's mouse and keyboard: waiting for them to pause, or holding it now. */
export type SeatState = "" | "waiting" | "holding";

/** What the card's picture can show: frames of the window, or why there are none. */
export type Picture = "none" | "live" | "blank" | "minimized";

/** What a card stands for: a hand working windows of its own, or a lookup answered from a web search, with no window (src/web.ts). */
export type Kind = "hand" | "lookup";

/** A page a lookup read its answer from. */
export interface Source {
  title: string;
  url: string;
}

/** The on-screen hand's pose (src/hand.ts POSES), which the picture's marker mirrors. */
export type PoseName = "wave" | "point" | "press" | "write" | "look" | "think" | "draw" | "key" | "scroll" | "go" | "wait" | "done" | "fail";

export interface HandView {
  id: string;
  name: string;
  color: string; // hex, no hash
  task: string;
  status: Status;
  action: string; // what it is doing this moment, as its own tag says it
  glyph: string;
  at: [number, number] | null; // where its hand is, in points from its window's corner
  size: [number, number] | null; // how big that window is
  viewing: boolean; // the user has that window in front of them
  answer: string;
  reason: string; // why it failed, when it did
  seat: SeatState;
  seatWhy: string; // what the borrow is for: "pressing ctrl+s"
  picture: Picture;
  since: number;
  until?: number; // when its run stopped (paused, needs you, or over), so a card drawn later still says how long it took
  window?: number | null; // which window it works in, as the camera films it: the card tells a new one's picture from the last one's (card.ts, track)
  kind?: Kind; // a hand (the default) or a lookup
  sources?: Source[]; // a lookup's pages, once it has answered
  pose?: PoseName; // the on-screen hand's pose now
  taps?: number; // how many presses it has made, so the picture can ripple on each new one
  glide?: number; // how long its latest move takes, in ms, so the picture's hand lands when the real one does
  checked?: number; // a done hand's last screen, as Jev read it: how likely it shows the answer is so, 0 to 1 (src/reflex.ts). Absent when nothing was checked
}

export interface VoiceView {
  state: "idle" | "connecting" | "listening" | "thinking" | "speaking" | "offline";
  heard: string;
  said: string;
  notice: string; // a problem worth a line in the dock: "Can't reach the voice. Retrying…", "Microphone is silent"
}

export type ServerMessage =
  | { type: "state"; hands: HandView[]; voice: VoiceView; focus: string | null; room: number; talkKey: string } // room: how tall the panel may grow, in points; talkKey: the key to hold, as the user would name it
  | { type: "level"; value: number } // how loud the microphone is this instant, 0 to 1: the dock's fingers move with it
  | { type: "log"; hand: string; entries: LogEntry[]; reset?: boolean };

export type ClientMessage =
  | { cmd: "size"; width: number; height: number; dpr?: number }
  | { cmd: "steer"; hand: string; text: string }
  | { cmd: "pause" | "resume" | "stop" | "close" | "show"; hand: string } // show: bring the hand's window to the user
  | { cmd: "clear" } // close every hand that has finished
  | { cmd: "visible"; hands: string[]; hot?: string | null; big?: string | null } // the hands whose card shows a picture now: only they are filmed; hot: the one under the pointer, filmed first; big: the one watched large, filmed sharper
  | { cmd: "open"; url: string } // open a lookup's source in the user's own browser: only a URL some card lists is opened
  | { cmd: "ask"; text: string } // what the user typed into the dock: a new task, or a word to a hand, as Jev reads it (src/intent.ts)
  | { cmd: "focus"; on: boolean };
