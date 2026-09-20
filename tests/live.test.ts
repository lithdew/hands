import { expect, test } from "bun:test";
import { cast, dispatch, named, samplesOf, snapshot } from "../src/live.ts";
import { cushion } from "../src/shell.ts";

const hand = (name: string, extra = {}) => ({ id: name.toLowerCase(), name, status: "working" as const, task: `task of ${name}`, action: "", recent: [] as string[], answer: "", since: 0, ...extra });

test("a spoken name finds its hand whatever its case, and `all` finds every one", () => {
  const out = [hand("Lefty"), hand("Righty")];
  expect(named(out, [" LEFTY "]).map((h) => h.name)).toEqual(["Lefty"]);
  expect(named(out, ["all"]).length).toBe(2);
  expect(named(out, ["Thumbs"])).toEqual([]);
});

test("the next hand gets the first name and colour nobody is using", () => {
  expect(cast([])).toEqual(["Lefty", "4f8cff"]);
  expect(cast(["lefty"])?.[0]).toBe("Righty");
  expect(cast(new Map([["lefty", 1], ["righty", 1]]).keys())?.[0]).toBe("Thumbs"); // the keys of the map of hands, which can be read once: the third hand was a second Righty
  expect(cast(["lefty", "righty", "thumbs", "pinky", "index", "palm", "knuckles", "digit"])).toBeNull();
});

test("what the voice is told: what a working hand is up to, what a finished one said, and never more than a note holds", () => {
  const told = snapshot(
    [hand("Lefty", { action: "click “Search”", recent: ["open arxiv.org", "click “Search”"] }), hand("Righty", { status: "done", answer: "It is 144.", since: 0 })],
    5 * 60_000,
  );
  expect(told).toBe("- Lefty [working, 5 min] task: task of Lefty; now: click “Search”; lately: open arxiv.org > click “Search”\n- Righty [done, 5 min] task: task of Righty; it said: It is 144.");
  expect(snapshot([])).toBe("No hands are out.");
  expect(snapshot([hand("Lefty", { answer: "x".repeat(5000), status: "done" })]).length).toBe(1500);
});

test("the samples of a WAV are its data chunk, wherever the other chunks have put it", () => {
  const wav = new Uint8Array(12 + 8 + 5 + 1 + 8 + 4); // RIFF header, an odd-sized chunk (padded), then data
  const view = new DataView(wav.buffer);
  wav.set(new TextEncoder().encode("RIFF"), 0);
  wav.set(new TextEncoder().encode("WAVE"), 8);
  wav.set(new TextEncoder().encode("FLLR"), 12);
  view.setUint32(16, 5, true);
  wav.set(new TextEncoder().encode("data"), 26);
  view.setUint32(30, 4, true);
  wav.set([1, 2, 3, 4], 34);
  expect([...samplesOf(wav)]).toEqual([1, 2, 3, 4]);
  expect(() => samplesOf(wav.subarray(0, 20))).toThrow();
});

test("a tool call about a hand that is not out says who is, and does nothing", () => {
  expect(dispatch("get_hands", {}, "/nonexistent")).toBe("No hands are out.");
  expect(dispatch("steer_hand", { hand: "Lefty", message: "go" }, "/nonexistent")).toEqual({ error: "no such hand. Out now: none" });
  expect(dispatch("close_hands", { hands: ["all"] }, "/nonexistent")).toEqual({ error: "no such hand. Out now: none" });
});

test("the speaker's queue rides out the voice's stalls without a gap in speech, and lets a burst down in the pauses", () => {
  // The voice as measured: a 100 ms chunk every 100 ms, two seconds of speech then one of pause, with a stall that is never
  // made up now and then. `until` is when the queue runs out; speech that arrives after that was a gap.
  const play = (stalls: number, burstAt = -1) => {
    let [now, until, gaps, deepest] = [0, 0, 0, 0];
    for (let chunk = 0; chunk < 600; chunk++) {
      const quiet = chunk % 30 >= 20;
      if (chunk % 30 === 5) now += stalls; // in the middle of a sentence, where it would be heard
      const left = Math.max(0, until - now);
      if (!quiet && left === 0 && chunk) gaps++;
      const pad = cushion(left, quiet);
      if (pad !== null) until = Math.max(until, now) + pad + 100;
      deepest = Math.max(deepest, until - now);
      if (chunk !== burstAt) now += 100; // a burst: the next chunk is here already
      else for (let more = 0; more < 10; more++) until += 100;
    }
    return { gaps, deepest, left: until - now };
  };
  expect(play(170).gaps).toBe(0); // one stall a sentence, as long as they come: the pauses restore what it took
  expect(play(170).deepest).toBeLessThanOrEqual(300);
  expect(play(450).gaps).toBeGreaterThan(0); // nothing short of a longer delay hides a stall longer than the cushion
  expect(play(0, 100).left).toBeLessThanOrEqual(500); // a second of backlog is gone again by the end, not carried for good
});
