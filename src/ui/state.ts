/** What the orchestrator and its panel say to each other. Types only: this file is in both bundles. */

export type Status = "starting" | "working" | "paused" | "done" | "failed" | "stopped";

export interface LogEntry {
  kind: "task" | "tool" | "result" | "error" | "say" | "steer" | "status";
  text: string;
}

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
  viewing: boolean; // the user has that window in front of them: no picture needed
  answer: string;
  since: number;
}

export interface VoiceView {
  state: "idle" | "connecting" | "listening" | "thinking" | "speaking";
  heard: string;
  said: string;
}

export type ServerMessage =
  | { type: "state"; hands: HandView[]; voice: VoiceView; focus: string | null; room: number } // room: how tall the panel may grow, in points
  | { type: "level"; value: number } // how loud the microphone is this instant, 0 to 1: the dock's fingers move with it
  | { type: "log"; hand: string; entries: LogEntry[]; reset?: boolean };

export type ClientMessage =
  | { cmd: "size"; width: number; height: number }
  | { cmd: "steer"; hand: string; text: string }
  | { cmd: "pause" | "resume" | "stop" | "close"; hand: string }
  | { cmd: "focus"; on: boolean };
