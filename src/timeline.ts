/**
 * The animation, as a pure model: events in, a pose per hand out, for any moment asked.
 *
 * feed.ts only sends what `poses(now)` says (through paint.ts), so everything that matters about motion is
 * decided, and tested, here with no window:
 *
 *   - The pointer glides to its target in 140 to 300 ms, by distance, on a slight arc.
 *   - It never queues. A new action retargets the pointer from wherever it is, and an effect that was waiting
 *     for the pointer to land (a click's ripple) fires at once, at its own place. However fast the hand works,
 *     the pointer's target is always the latest action and it is at most one glide behind.
 *   - In a burst the glide shrinks to the gap between actions (no less than 70 ms).
 *   - Effects are capped, so a long burst cannot pile up.
 *
 * Time is whatever clock the caller passes; an event's own `t` orders it against others and is not used for
 * animation, so a slow pipe delays the picture but never distorts it.
 */
import { type CursorEvent, handColor, type Part, STATE_KINDS, type StateKind, type XY } from "./cursor.ts";

// ---------------------------------------------------------------- numbers

export const GLIDE_MIN_MS = 140, GLIDE_MAX_MS = 300, GLIDE_BURST_MS = 70;
export const RIPPLE_MS = 460, DOUBLE_GAP_MS = 120, PRESS_MS = 170;
export const RECT_MS = 1100, SCROLL_MS = 620, CHIP_MS = 2200, SCAN_MS = 950, TRAIL_FADE_MS = 650;
export const STROKE_MIN_MS = 260, STROKE_MAX_MS = 900;
export const NOTE_MS = 1900, NOTE_FADE_MS = 250, TYPE_REVEAL_MAX_MS = 900, TYPE_CHAR_MS = 38;
export const APPEAR_MS = 160, DONE_HOLD_MS = 1100, DONE_FADE_MS = 600, IDLE_FADE_MS = 320;
/** A hand that has shown nothing new for this long sits back, so a stale pointer does not look busy. */
export const REST_AFTER_MS = 9000, REST_OPACITY = 0.55;
export const MAX_EFFECTS = 12;

const STATE_COLORS: Partial<Record<StateKind, string>> = { blocked: "#e0af68", error: "#f7768e", done: "#9ece6a" };
const STATE_WORDS: Record<StateKind, string> = { think: "thinking", look: "looking", wait: "waiting", blocked: "needs you", done: "done", error: "stopped", idle: "" };

// ---------------------------------------------------------------- what the feed draws

export type EffectKind = "ripple" | "rect" | "trail" | "scroll" | "chip" | "scan";
export type Effect = {
  id: number;
  kind: EffectKind;
  /** 0 at its start, 1 when it is gone. */
  progress: number;
  x?: number; y?: number; rect?: Part; path?: XY[];
  text?: string;
  /** ripple: a right-click ripple is dashed. */
  button?: "left" | "right" | "middle";
  /** trail: how much of the stroke has been drawn, 0..1; then it fades with `progress`. */
  drawn?: number;
  /** rect: a field being typed into is lit, a control operated with no pointer flashes. chip: what kind of going-somewhere it is. */
  tone?: "type" | "control" | "navigate" | "open" | "menu";
};

export type Pose = {
  hand: number;
  /** The hand's identity colour. The pointer's body is always this. */
  color: string;
  /** The colour of the halo and the tag's edge: the hand's, or amber, red or green for blocked, error and done. */
  accent: string;
  x: number; y: number;
  opacity: number;
  /** 1 at rest, dipping to 0.84 on a press. */
  scale: number;
  shape: "arrow" | "ibeam" | "grab";
  mode: StateKind | "act";
  /** 0..1 strength of the ring around the pointer: it breathes while thinking, holds while blocked. */
  halo: number;
  /** A turning arc around the pointer while the hand waits on a page: 0..1 turn, or null. */
  spin: number | null;
  /** "H1". */
  label: string;
  /** The words beside the label: the step's caption, the text as it is typed, or the state. */
  note: string;
  noteOpacity: number;
  /** Show a text caret after `note`. */
  caret: boolean;
  effects: Effect[];
};

export type TimelineOptions = { reducedMotion?: boolean };

// ---------------------------------------------------------------- pure pieces

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));
export const easeInOut = (p: number) => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
export const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);

/** How long the pointer takes over a distance (in frame units, 0..1.41). `gap`: ms since the hand's previous action. */
export function glideMs(distance: number, gap = Infinity, reducedMotion = false): number {
  if (reducedMotion || distance <= 0) return 0;
  const nominal = clamp(GLIDE_MIN_MS + 230 * distance, GLIDE_MIN_MS, GLIDE_MAX_MS);
  return gap < nominal ? Math.max(GLIDE_BURST_MS, Math.min(nominal, gap * 0.9)) : nominal;
}

/** A point `p` (0..1, eased) of the way along a slightly bowed path: a straight glide looks like a machine. */
export function alongArc(from: XY, to: XY, p: number): XY {
  const dx = to.x - from.x, dy = to.y - from.y, bow = 0.07 * Math.sin(Math.PI * p);
  return { x: from.x + dx * p - dy * bow, y: from.y + dy * p + dx * bow };
}

const lengths = (path: XY[]) => { const cum = [0]; for (let i = 1; i < path.length; i++) cum.push(cum[i - 1]! + Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y)); return cum; };
/** The point a fraction `p` of the way along a polyline, by length. */
export function alongPath(path: XY[], p: number): XY {
  if (path.length === 0) return { x: 0.5, y: 0.5 };
  const cum = lengths(path), total = cum[cum.length - 1]!, want = clamp(p, 0, 1) * total;
  for (let i = 1; i < path.length; i++) {
    if (cum[i]! >= want) {
      const span = cum[i]! - cum[i - 1]!, k = span > 0 ? (want - cum[i - 1]!) / span : 1;
      return { x: path[i - 1]!.x + (path[i]!.x - path[i - 1]!.x) * k, y: path[i - 1]!.y + (path[i]!.y - path[i - 1]!.y) * k };
    }
  }
  return path[path.length - 1]!;
}

// ---------------------------------------------------------------- one hand

type Pending = { id: number; kind: EffectKind; at: number; life: number; x?: number; y?: number; rect?: Part; path?: XY[]; text?: string; button?: Effect["button"]; tone?: Effect["tone"]; strokeMs?: number };

export class HandTrack {
  readonly hand: number;
  private readonly reduced: boolean;
  private placed = false;
  private from: XY = { x: 0.5, y: 0.5 };
  private to: XY = { x: 0.5, y: 0.5 };
  private start = 0;
  private dur = 0;
  private stroke: { path: XY[]; start: number; dur: number } | null = null;
  private effects: Pending[] = [];
  private nextId = 1;
  private pressAt = -Infinity;
  private mode: StateKind | "act" = "idle";
  private modeAt = 0;
  private appearedAt = 0;
  private lastPush = -Infinity;
  private lastPointed = -Infinity;
  private note = "";
  private noteAt = -Infinity;
  private typed: { text: string; at: number; ms: number } | null = null;

  constructor(hand: number, options: TimelineOptions = {}) { this.hand = hand; this.reduced = Boolean(options.reducedMotion); }

  /** When the hand last did or said anything. */
  get touched() { return this.lastPush; }

  position(now: number): XY {
    if (this.stroke && now >= this.stroke.start) return alongPath(this.stroke.path, this.stroke.dur > 0 ? easeInOut(clamp((now - this.stroke.start) / this.stroke.dur, 0, 1)) : 1);
    if (this.dur <= 0 || now >= this.start + this.dur) return this.to;
    return alongArc(this.from, this.to, easeInOut(clamp((now - this.start) / this.dur, 0, 1)));
  }

  /** Where the pointer is heading: always the latest action's point. */
  target(): XY { return this.stroke ? this.stroke.path[this.stroke.path.length - 1]! : this.to; }

  push(event: CursorEvent, now: number): void {
    const hidden = !this.placed || this.opacityAt(now) === 0;
    const point = event.x !== undefined && event.y !== undefined ? { x: event.x, y: event.y } : null;
    this.lastPush = now;
    if (hidden) this.appearedAt = now;

    // An action with no place (a key, a state, a chip) leaves the pointer to finish what it was doing, and starts when it lands.
    let land = Math.max(now, this.start + this.dur, this.stroke ? this.stroke.start + this.stroke.dur : 0);
    if (point) {
      const here = this.placed && !hidden ? this.position(now) : null;
      // Whatever was waiting for the pointer to land happens now, where it was meant to: nothing is dropped, nothing queues.
      for (const e of this.effects) {
        if (e.at > now) e.at = now;
        // A stroke still being drawn is shown whole, and starts to fade.
        if (e.kind === "trail" && now < e.at + (e.strokeMs ?? 0)) { e.strokeMs = now - e.at; e.life = e.strokeMs + TRAIL_FADE_MS; }
      }
      this.stroke = null;
      // A pointer seen for the first time arrives from just outside its target, not from a corner of the page.
      this.from = here ?? { x: clamp(point.x + 0.035, 0, 1), y: clamp(point.y + 0.05, 0, 1) };
      this.to = point; this.start = now;
      // A burst is pointed actions close together; a state said just before a click is not one.
      this.dur = glideMs(Math.hypot(this.to.x - this.from.x, this.to.y - this.from.y), now - this.lastPointed, this.reduced);
      this.lastPointed = now;
      this.placed = true;
      land = now + this.dur;
    }

    if ((STATE_KINDS as readonly string[]).includes(event.kind)) {
      const state = event.kind as StateKind;
      if (state !== this.mode) { this.mode = state; this.modeAt = now; }
      // A hand that has touched nothing yet rests in the middle of its window, and glides out from there.
      if (!this.placed && state !== "idle") { this.placed = true; this.from = this.to = { x: 0.5, y: 0.5 }; this.dur = 0; }
      this.typed = null;
      this.note = event.caption || STATE_WORDS[state]; this.noteAt = now;
      if (state === "look") this.add({ kind: "scan", at: now, life: SCAN_MS });
      return;
    }

    this.mode = "act"; this.modeAt = now;
    this.typed = null;
    const chip = event.kind === "navigate" || event.kind === "open" || event.kind === "menu";
    this.note = event.caption ?? (chip ? "" : event.kind === "type" ? "" : (event.text ?? "")); this.noteAt = land;
    const where = point ?? (this.placed ? this.to : undefined);
    switch (event.kind) {
      case "click": {
        this.pressAt = land;
        this.add({ kind: "ripple", at: land, life: RIPPLE_MS, ...where, button: event.button ?? "left" });
        if (event.count === 2) this.add({ kind: "ripple", at: land + DOUBLE_GAP_MS, life: RIPPLE_MS, ...where, button: event.button ?? "left" });
        if (event.rect && event.button === "right") this.add({ kind: "rect", at: land, life: RECT_MS, rect: event.rect, tone: "control" });
        break;
      }
      case "type": {
        const text = event.text ?? "";
        this.typed = { text, at: land, ms: this.reduced ? 0 : Math.min(TYPE_REVEAL_MAX_MS, text.length * TYPE_CHAR_MS) };
        if (event.rect) this.add({ kind: "rect", at: land, life: Math.max(RECT_MS, this.typed.ms + 500), rect: event.rect, tone: "type" });
        break;
      }
      case "control":
        if (event.rect) this.add({ kind: "rect", at: land, life: RECT_MS, rect: event.rect, tone: "control" });
        break;
      case "scroll":
        this.add({ kind: "scroll", at: land, life: SCROLL_MS, ...where, text: event.text ?? "down" });
        break;
      case "drag": {
        const path = event.path && event.path.length >= 2 ? event.path : null;
        if (!path) break;
        const total = lengths(path).pop()!, ms = this.reduced ? 0 : clamp(total * 1100, STROKE_MIN_MS, STROKE_MAX_MS);
        this.stroke = { path, start: land, dur: ms };
        this.pressAt = land;
        this.add({ kind: "trail", at: land, life: ms + TRAIL_FADE_MS, path, strokeMs: ms });
        break;
      }
      case "navigate": case "open": case "menu":
        // Nothing in the window was pointed at, so no pointer moves: a chip along the frame's edge says what happened.
        this.add({ kind: "chip", at: now, life: CHIP_MS, text: event.text ?? "", tone: event.kind });
        break;
    }
  }

  private add(effect: Omit<Pending, "id">): void {
    this.effects.push({ id: this.nextId++, ...effect });
    if (this.effects.length > MAX_EFFECTS) this.effects.splice(0, this.effects.length - MAX_EFFECTS);
  }

  /** Forget what has finished. Separate from `pose`, which changes nothing. */
  prune(now: number): void { this.effects = this.effects.filter((e) => now < e.at + e.life); }

  private opacityAt(now: number): number {
    if (!this.placed && this.mode === "idle") return 0;
    const since = now - this.modeAt;
    if (this.mode === "idle") return this.reduced ? 0 : clamp(1 - since / IDLE_FADE_MS, 0, 1) * this.restingAt(this.modeAt);
    if (this.mode === "done" || this.mode === "error") {
      if (this.mode === "error") return 1;
      return since <= DONE_HOLD_MS ? 1 : this.reduced ? 0 : clamp(1 - (since - DONE_HOLD_MS) / DONE_FADE_MS, 0, 1);
    }
    const appear = this.reduced ? 1 : clamp((now - this.appearedAt) / APPEAR_MS, 0, 1);
    return appear * this.restingAt(now);
  }

  private restingAt(now: number): number {
    if (this.mode === "blocked") return 1; // a hand that needs the user never sits back
    const quiet = now - this.lastPush - REST_AFTER_MS;
    return quiet <= 0 ? 1 : this.reduced ? REST_OPACITY : 1 - (1 - REST_OPACITY) * clamp(quiet / 600, 0, 1);
  }

  /** Is anything about this hand still changing at `now`? The feed stops ticking when no hand is. */
  animating(now: number): boolean {
    if (this.effects.some((e) => now < e.at + e.life)) return true;
    if (now < this.start + this.dur || (this.stroke && now < this.stroke.start + this.stroke.dur)) return true;
    const opacity = this.opacityAt(now);
    if (opacity === 0) return false;
    if (!this.reduced && (this.mode === "think" || this.mode === "blocked" || this.mode === "wait" || this.mode === "look")) return true;
    // Fades, the note collapsing, and the moment a quiet hand sits back.
    return now < this.noteAt + NOTE_MS + NOTE_FADE_MS || now < this.pressAt + PRESS_MS || this.mode === "done" || this.mode === "idle"
      || (now - this.lastPush < REST_AFTER_MS + 700) || now < this.appearedAt + APPEAR_MS;
  }

  pose(now: number): Pose {
    const at = this.position(now), color = handColor(this.hand), since = now - this.modeAt;
    const press = now - this.pressAt, stroking = Boolean(this.stroke && now >= this.stroke.start && now < this.stroke.start + this.stroke.dur);
    const scale = stroking ? 0.88 : press >= 0 && press < PRESS_MS && !this.reduced ? 1 - 0.16 * Math.sin(Math.PI * press / PRESS_MS) : 1;

    let halo = 0;
    if (this.mode === "think") halo = this.reduced ? 0.35 : 0.3 + 0.25 * Math.sin(since / 1600 * 2 * Math.PI);
    else if (this.mode === "blocked") halo = this.reduced ? 0.8 : 0.65 + 0.3 * Math.sin(since / 2600 * 2 * Math.PI);
    else if (this.mode === "look") halo = 0.45;
    else if (this.mode === "error") halo = 0.8;
    else if (this.mode === "done") halo = 0.6 * clamp(1 - since / DONE_HOLD_MS, 0, 1);

    let note = this.note, noteOpacity = 0, caret = false, shape: Pose["shape"] = stroking ? "grab" : "arrow";
    if (this.typed && now >= this.typed.at) {
      const p = this.typed.ms > 0 ? clamp((now - this.typed.at) / this.typed.ms, 0, 1) : 1;
      note = this.typed.text.slice(0, Math.ceil(this.typed.text.length * p));
      caret = p < 1 || now < this.typed.at + this.typed.ms + 500;
      if (caret) shape = "ibeam";
      noteOpacity = clamp(1 - (now - (this.typed.at + this.typed.ms) - NOTE_MS) / NOTE_FADE_MS, 0, 1);
    } else if (this.mode !== "act" && this.mode !== "idle") {
      // A state is said for as long as it lasts; "done" leaves with the pointer.
      noteOpacity = note ? 1 : 0;
      if (this.mode === "think" && !this.reduced && note === STATE_WORDS.think) note = `thinking${".".repeat(1 + Math.floor(since / 400) % 3)}`;
    } else if (note && now >= this.noteAt) noteOpacity = clamp(1 - (now - this.noteAt - NOTE_MS) / NOTE_FADE_MS, 0, 1);

    const effects: Effect[] = [];
    for (const e of this.effects) {
      if (now < e.at || now >= e.at + e.life) continue;
      const age = now - e.at, effect: Effect = { id: e.id, kind: e.kind, progress: clamp(age / e.life, 0, 1) };
      if (e.x !== undefined && e.y !== undefined) { effect.x = e.x; effect.y = e.y; }
      if (e.rect) effect.rect = e.rect;
      if (e.text !== undefined) effect.text = e.text;
      if (e.button) effect.button = e.button;
      if (e.tone) effect.tone = e.tone;
      if (e.kind === "trail") {
        effect.path = e.path;
        const strokeMs = e.strokeMs ?? 0;
        effect.drawn = strokeMs > 0 ? easeInOut(clamp(age / strokeMs, 0, 1)) : 1;
        effect.progress = clamp((age - strokeMs) / TRAIL_FADE_MS, 0, 1);
      }
      effects.push(effect);
    }

    return {
      hand: this.hand, color, accent: (this.mode !== "act" && STATE_COLORS[this.mode]) || color,
      x: at.x, y: at.y, opacity: this.opacityAt(now), scale, shape, mode: this.mode, halo,
      spin: this.mode === "wait" && !this.reduced ? (since / 1200) % 1 : null,
      label: `H${this.hand}`, note, noteOpacity, caret, effects,
    };
  }
}

// ---------------------------------------------------------------- every hand

export class Timeline {
  private readonly tracks = new Map<number, HandTrack>();
  constructor(private readonly options: TimelineOptions = {}) {}

  push(event: CursorEvent, now: number): void {
    let track = this.tracks.get(event.hand);
    if (!track) { track = new HandTrack(event.hand, this.options); this.tracks.set(event.hand, track); }
    track.push(event, now);
  }

  /** One pose per hand that can be seen, the hand that acted last on top. */
  poses(now: number): Pose[] {
    for (const track of this.tracks.values()) track.prune(now);
    return [...this.tracks.values()].sort((a, b) => a.touched - b.touched).map((t) => t.pose(now)).filter((p) => p.opacity > 0 || p.effects.length > 0);
  }

  animating(now: number): boolean { return [...this.tracks.values()].some((t) => t.animating(now)); }
  track(hand: number): HandTrack | undefined { return this.tracks.get(hand); }
  clear(): void { this.tracks.clear(); }
}
