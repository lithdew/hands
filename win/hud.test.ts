import { describe, expect, test } from "bun:test";
import { createHud, hudEnabled, type HudStatus } from "./hud";

const status = (over: Partial<HudStatus> = {}): HudStatus => ({
  state: "idle", held: false, partialTranscript: "", lastError: null, listener: { error: null, tasks: [] }, workers: [], ...over,
});
const task = (id: number, status: string, hand: number | null, request = `request ${id}`) => ({ id, request, status, hand });
function harness(write: ((line: string) => void) | null | undefined = undefined) {
  const lines: string[] = [];
  const hud = createHud(write === undefined ? (line) => { lines.push(line); } : write);
  return { hud, lines, take: () => lines.splice(0) };
}

describe("hotkey hold", () => {
  test("hidden -> listening -> finishing -> hidden through settle", () => {
    const { hud, take } = harness();
    expect(hud.hudPhase()).toBe("hidden");
    hud.hudListening();
    expect(take()).toEqual(["listening"]);
    hud.hudDelta("Open Paint");
    hud.hudDelta(" and draw a capybara");
    expect(take()).toEqual(["transcript Open Paint", "transcript Open Paint and draw a capybara"]);
    // The poll during the hold repeats the same partial: nothing new to say.
    hud.driveHud(status({ state: "recording", held: true, partialTranscript: "Open Paint and draw a capybara" }));
    expect(take()).toEqual([]);
    hud.driveHud(status({ state: "recording", held: true, partialTranscript: "Open Paint and draw a capybara", listener: { error: null, tasks: [task(1, "running", 1, "Open Paint and draw a capybara")] } }));
    expect(take()).toEqual(["task 1 running 1 Open Paint and draw a capybara"]);
    hud.hudFinishing();
    expect(hud.hudPhase()).toBe("finishing");
    expect(take()).toEqual(["finishing"]);
    // The final sentence lands with punctuation, the tool captions appear, then idle settles.
    hud.driveHud(status({ state: "dispatching", partialTranscript: "Open Paint and draw a capybara.", listener: { error: null, tasks: [task(1, "running", 1, "Open Paint and draw a capybara")] }, workers: [{ hand: 1, agent: { running: true, currentTool: "Opening Paint" } }] }));
    expect(take()).toEqual(["transcript Open Paint and draw a capybara.", "progress 1 Opening Paint"]);
    hud.driveHud(status({ state: "idle", partialTranscript: "Open Paint and draw a capybara.", listener: { error: null, tasks: [task(1, "running", 1, "Open Paint and draw a capybara")] }, workers: [{ hand: 1, agent: { running: true, currentTool: "Opening Paint" } }] }));
    expect(take()).toEqual(["settle"]);
    expect(hud.hudPhase()).toBe("hidden");
    // Hidden: later polls say nothing, whatever the hands do.
    hud.driveHud(status({ workers: [{ hand: 1, agent: { running: true, currentTool: "Drawing" } }] }));
    expect(take()).toEqual([]);
  });

  test("no request heard settles as nothing", () => {
    const { hud, take } = harness();
    hud.hudListening(); hud.hudFinishing(); take();
    hud.driveHud(status());
    expect(take()).toEqual(["nothing"]);
    expect(hud.hudPhase()).toBe("hidden");
  });

  test("a failure surfaces as error, controller first then listener", () => {
    const { hud, take } = harness();
    hud.hudListening(); take();
    hud.driveHud(status({ lastError: "Set OPENAI_API_KEY to transcribe speech." }));
    expect(take()).toEqual(["error Set OPENAI_API_KEY to transcribe speech."]);
    expect(hud.hudPhase()).toBe("hidden");
    hud.hudListening(); hud.hudFinishing(); take();
    hud.driveHud(status({ listener: { error: "Jev is not reachable.", tasks: [task(1, "failed", 1)] } }));
    expect(take()).toEqual(["task 1 failed 1 request 1", "error Jev is not reachable."]);
  });

  test("Ctrl+Alt+Esc cancels and the following idle poll stays quiet", () => {
    const { hud, take } = harness();
    hud.hudListening(); take();
    hud.hudCancelled();
    expect(take()).toEqual(["cancelled"]);
    expect(hud.hudPhase()).toBe("hidden");
    hud.driveHud(status());
    expect(take()).toEqual([]);
  });

  test("finishing only follows listening", () => {
    const { hud, take } = harness();
    hud.hudFinishing();
    expect(take()).toEqual([]);
    expect(hud.hudPhase()).toBe("hidden");
  });
});

describe("double listening guard", () => {
  test("a hotkey hold does not re-enter listening from the poll", () => {
    const { hud, take } = harness();
    hud.hudListening();
    hud.hudDelta("Open");
    hud.driveHud(status({ state: "starting", held: true }));
    hud.driveHud(status({ state: "recording", held: true, partialTranscript: "Open" }));
    expect(take()).toEqual(["listening", "transcript Open"]);
  });
  test("a hold from the panel button enters listening once and finishes on release", () => {
    const { hud, take } = harness();
    hud.driveHud(status({ state: "starting", held: true }));
    hud.driveHud(status({ state: "recording", held: true }));
    expect(take()).toEqual(["listening"]);
    hud.driveHud(status({ state: "transcribing", held: false }));
    expect(take()).toEqual(["finishing"]);
    hud.driveHud(status({ state: "idle", partialTranscript: "Open Paint", listener: { error: null, tasks: [task(1, "waiting", null, "Open Paint")] } }));
    expect(take()).toEqual(["transcript Open Paint", "task 1 waiting 0 Open Paint", "settle"]);
  });
  test("a /status snapshot fetched before the hold began cannot settle the new card", () => {
    const { hud, take } = harness();
    const at = hud.hudEpoch();
    hud.hudListening(); take();
    hud.driveHud(status(), at);
    expect(take()).toEqual([]);
    expect(hud.hudPhase()).toBe("listening");
  });
  test("a second listening clears the tasks and progress it remembers", () => {
    const { hud, take } = harness();
    hud.hudListening();
    hud.driveHud(status({ state: "recording", held: true, listener: { error: null, tasks: [task(1, "running", 1)] }, workers: [{ hand: 1, agent: { running: true, currentTool: "Opening Paint" } }] }));
    take();
    hud.hudListening();
    hud.driveHud(status({ state: "recording", held: true, listener: { error: null, tasks: [task(1, "running", 1)] }, workers: [{ hand: 1, agent: { running: true, currentTool: "Opening Paint" } }] }));
    expect(take()).toEqual(["listening", "task 1 running 1 request 1", "progress 1 Opening Paint"]);
  });
});

describe("rows and captions", () => {
  test("a task row is upserted only when its status or hand changes", () => {
    const { hud, take } = harness();
    hud.hudListening(); take();
    const poll = (s: string, hand: number | null) => hud.driveHud(status({ state: "recording", held: true, listener: { error: null, tasks: [task(2, s, hand, "search Wikipedia")] } }));
    poll("waiting", null); poll("waiting", null);
    poll("running", 2); poll("running", 2);
    poll("done", 2);
    expect(take()).toEqual(["task 2 waiting 0 search Wikipedia", "task 2 running 2 search Wikipedia", "task 2 done 2 search Wikipedia"]);
  });
  test("progress follows only running hands and only on change", () => {
    const { hud, take } = harness();
    hud.hudListening(); take();
    const poll = (running: boolean, tool: string | null) => hud.driveHud(status({ state: "recording", held: true, workers: [{ hand: 1, agent: { running, currentTool: tool } }] }));
    poll(false, "Opening Paint");
    poll(true, null);
    poll(true, "Opening Paint"); poll(true, "Opening Paint");
    poll(true, "Drawing");
    expect(take()).toEqual(["progress 1 Opening Paint", "progress 1 Drawing"]);
  });
  test("deltas are ignored while hidden and capped at 16 000 characters", () => {
    const { hud, take } = harness();
    hud.hudDelta("stray");
    expect(take()).toEqual([]);
    hud.hudListening(); take();
    hud.hudDelta("x".repeat(15_999));
    hud.hudDelta("yz");
    expect(take().at(-1)).toHaveLength("transcript ".length + 16_000);
  });
});

describe("the wire", () => {
  test("line breaks inside text become spaces", () => {
    const { hud, take } = harness();
    hud.hudLine("error line one\r\nline two\nthree");
    expect(take()).toEqual(["error line one line two three"]);
  });
  test("a failing writer is swallowed", () => {
    const { hud } = harness(() => { throw new Error("EPIPE"); });
    expect(() => { hud.hudListening(); hud.hudDelta("hi"); }).not.toThrow();
    expect(hud.hudPhase()).toBe("listening");
  });
  test("PUK_HUD=0 writes nothing", () => {
    expect(hudEnabled({ PUK_HUD: "0" })).toBe(false);
    expect(hudEnabled({})).toBe(true);
    expect(hudEnabled({ PUK_HUD: "1" })).toBe(true);
    const sink: string[] = [];
    const { hud } = harness(hudEnabled({ PUK_HUD: "0" }) ? (line) => { sink.push(line); } : null);
    hud.hudListening(); hud.hudDelta("Open Paint"); hud.hudFinishing();
    hud.driveHud(status({ listener: { error: null, tasks: [task(1, "running", 1)] } }));
    expect(sink).toEqual([]);
  });
});
