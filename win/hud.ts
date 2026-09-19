/**
 * The F8 caption on Windows: what `puk-win hud` shows while the hotkey is held.
 *
 * Pure state. win/serve.ts feeds it the hotkey lines, the recorder's transcript
 * deltas and the 300 ms /status poll; it answers with protocol lines through an
 * injected writer, so every transition is testable without a helper process.
 * The card (win/helper.cs, HudForm) reads one command per line: `listening`,
 * `transcript <text>`, `finishing`, `task <id> <status> <hand> <text>`,
 * `progress <hand> <text>`, `settle`, `nothing`, `error <text>`, `cancelled`, `hide`.
 */
export type HudPhase = "hidden" | "listening" | "finishing";
/** The slice of GET /status the caption reads (hotkey.ts status() plus servePuk's extraStatus). */
export type HudStatus = {
  state: string; held: boolean; partialTranscript: string; lastError: string | null;
  listener: { error: string | null; tasks: { id: number; request: string; status: string; hand: number | null }[] };
  workers: { hand: number; agent: { running: boolean; currentTool?: string | null } }[];
};

/** PUK_HUD=0 is the escape hatch: no fourth helper process, no lines. */
export const hudEnabled = (env: Record<string, string | undefined> = process.env) => env.PUK_HUD !== "0";

export function createHud(write: ((line: string) => void) | null) {
  let heard = "", phase: HudPhase = "hidden", epoch = 0;
  const tasks = new Map<number, string>(), progress = new Map<number, string>();

  /** One protocol line. `<text>` runs to the end of the line, so breaks inside it become spaces. */
  function hudLine(line: string) {
    if (!write) return;
    try { write(line.replace(/[\r\n]+/g, " ")); } catch { /* the card is optional; Puk works without it */ }
  }
  /** A hold began: clear what the card remembers and show it. */
  function hudListening() {
    heard = ""; tasks.clear(); progress.clear(); phase = "listening"; epoch++;
    hudLine("listening");
  }
  /** A transcript delta straight from the recorder, so words land before the next poll.
   * The last words of a sentence often arrive after release, hence finishing too. */
  function hudDelta(delta: string) {
    if (phase === "hidden") return;
    heard = (heard + delta).slice(0, 16_000);
    hudLine(`transcript ${heard}`);
  }
  function hudFinishing() {
    if (phase !== "listening") return;
    phase = "finishing"; hudLine("finishing");
  }
  function hudCancelled() { hudLine("cancelled"); phase = "hidden"; }

  /** The poll. `at` is hudEpoch() read before the /status fetch: a snapshot taken
   * before the hotkey went down still reads idle, and must not settle the new card. */
  function driveHud(s: HudStatus, at = epoch) {
    if (at !== epoch) return;
    // A hold begun from the panel button never passes through the hotkey loop. The
    // hotkey path has already called hudListening(), so only a hidden card enters here.
    if (phase === "hidden" && s.held) hudListening();
    if (phase === "hidden") return;
    if (s.partialTranscript && s.partialTranscript !== heard) { heard = s.partialTranscript; hudLine(`transcript ${heard}`); }
    for (const t of s.listener.tasks) {
      const key = `${t.status} ${t.hand ?? 0}`;
      if (tasks.get(t.id) !== key) { tasks.set(t.id, key); hudLine(`task ${t.id} ${t.status} ${t.hand ?? 0} ${t.request}`); }
    }
    for (const w of s.workers) {
      const tool = w.agent.running ? w.agent.currentTool ?? "" : "";
      if (tool && progress.get(w.hand) !== tool) { progress.set(w.hand, tool); hudLine(`progress ${w.hand} ${tool}`); }
    }
    if (s.state === "idle" && !s.held) {
      const error = s.lastError ?? s.listener.error;
      hudLine(error ? `error ${error}` : s.listener.tasks.length ? "settle" : "nothing");
      phase = "hidden";
    } else if (!s.held && s.state !== "starting" && s.state !== "recording") hudFinishing(); // released from the panel button
  }

  return { hudLine, hudListening, hudDelta, hudFinishing, hudCancelled, driveHud, hudEpoch: () => epoch, hudPhase: () => phase };
}
