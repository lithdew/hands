import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cap, cast, context, dispatch, FRONTEND, glance, isoTime, joined, named, nextShot, notesThatFit, occlusionNotice, runFolder, sameTask, samplesOf, snapshot, steered, usage, voiceSummary } from "../src/live.ts";
import { cushion } from "../src/shell.ts";

const hand = (name: string, extra = {}) => ({ id: name.toLowerCase(), name, status: "working" as const, task: `task of ${name}`, action: "", recent: [] as string[], answer: "", reason: "", since: 0, reported: false, ...extra });

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

test("a new Lefty never writes into an old Lefty's run folder", () => {
  const taken = new Set(["/runs/lefty", "/runs/lefty-2"]);
  expect(runFolder("/runs", "Lefty", (path) => taken.has(path.replaceAll("\\", "/")))).toMatch(/lefty-3$/);
  expect(runFolder("/runs", "Righty", () => false)).toMatch(/righty$/);
});

test("what the voice is told of the hands: the ones still at it first, a line each, and what a finished one said, cut short", () => {
  const told = snapshot(
    [
      hand("Righty", { status: "done", answer: "It is **144**.", since: 0 }),
      hand("Lefty", { action: "click “Search”", recent: ["open arxiv.org", "click “Search”"], since: 0 }),
      hand("Thumbs", { status: "needs_you", answer: "The site wants you to sign in to Google.", since: 0 }),
    ],
    5 * 60_000,
  );
  expect(told).toBe(
    [
      "- Lefty [working, 5 min] task: task of Lefty; now: click “Search”; lately: open arxiv.org > click “Search”",
      "- Thumbs [needs_you, 5 min] task: task of Thumbs; needs: The site wants you to sign in to Google.",
      "- Righty [done] task: task of Righty; it said: It is 144.",
    ].join("\n"),
  );
  expect(snapshot([])).toBe("No hands are out.");
});

test("no hand drops out of the voice's picture, however much another has to say", () => {
  const long = "Funding rounds, in order. ".repeat(250);
  const told = snapshot([hand("Lefty", { status: "done", answer: long, task: "x".repeat(900) }), hand("Righty"), hand("Thumbs", { status: "failed", reason: long })]);
  for (const name of ["Lefty", "Righty", "Thumbs"]) expect(told).toContain(`- ${name} [`);
  for (const line of told.split("\n")) expect(line.length).toBeLessThan(450);
});

test("an answer the voice has already said is marked so, and a failure says why", () => {
  const told = snapshot([hand("Lefty", { status: "done", answer: "Yashima, at 12:30.", reported: true }), hand("Righty", { status: "failed", reason: "the helper went away" })]);
  expect(told).toContain("it said (already told to the user): Yashima, at 12:30.");
  expect(told).toContain("why: the helper went away");
});

test("the voice says a hand's answer from its first paragraph, as plain words: no marks, links, URLs, tables or headings", () => {
  const answer = [
    "## Lunch pick",
    "",
    "**Yashima** has an [omakase](https://example.com/omakase) at 12:30 for `HK$880`, see https://yashima.hk.",
    "",
    "| time | price |",
    "|---|---|",
    "| 12:30 | 880 |",
  ].join("\n");
  expect(voiceSummary(answer)).toBe("Yashima has an omakase at 12:30 for HK$880, see.");
  expect(voiceSummary("Created the workbook:\n- Model.xlsx in Documents\\Hands\n- a chart on its second sheet")).toBe("Created the workbook: Model.xlsx in Documents\\Hands; a chart on its second sheet");
  expect(voiceSummary("Done.\n\nThe message to Kartikay was sent at 3:04 pm, and he has read it.")).toBe("Done. The message to Kartikay was sent at 3:04 pm, and he has read it.");
  expect(voiceSummary("word ".repeat(200)).length).toBeLessThanOrEqual(300);
  expect(voiceSummary("")).toBe("");
});

test("text is cut at a word, with an ellipsis only when something was cut", () => {
  expect(cap("short enough", 20)).toBe("short enough");
  expect(cap("one two three four five six", 16)).toBe("one two three…");
});

test("a task the backend gives again is the same task; another destination, or a detail added, is another", () => {
  expect(sameTask("Find the cheapest flight from Hong Kong to Tokyo next Friday", "find the cheapest flights from Hong Kong to Tokyo, next friday")).toBe(true);
  expect(sameTask("Find the cheapest flight from Hong Kong to Tokyo next Friday", "Find the cheapest flight from Hong Kong to Paris next Friday")).toBe(false);
  expect(sameTask("Find the cheapest flight from Hong Kong to Tokyo", "Find the cheapest flight from Hong Kong to Tokyo and book it")).toBe(false);
  expect(sameTask("Open the calculator and work out 12 times 12", "Summarize the YouTube Shorts you watched")).toBe(false);
});

test("a steer to a hand at work keeps its task and says what is wanted now; to one that has finished, it is its task", () => {
  expect(steered("find flights to Tokyo", "only direct ones", true)).toBe("find flights to Tokyo → now: only direct ones");
  expect(steered("find flights to Tokyo → now: only direct ones", "make it Osaka", true)).toBe("find flights to Tokyo → now: make it Osaka");
  expect(steered("find flights to Tokyo", "book a table at Yashima", false)).toBe("book a table at Yashima");
  expect(steered("t", "x".repeat(500), true).length).toBeLessThan(215);
});

test("the voice's transcript runs replies together with a space where a sentence ended without one", () => {
  expect(joined("Okay, I'll have that set up.", "Sure")).toBe("Okay, I'll have that set up. Sure");
  expect(joined("Okay", ", sure")).toBe("Okay, sure");
  expect(joined("", "Hi")).toBe("Hi");
  expect(joined("Hi.", " there")).toBe("Hi. there");
});

test("a new session is told the conversation so far and how the hands stand, as context and not to be answered", () => {
  expect(context([], "")).toBeNull();
  const told = context(["User: find me flights to Tokyo", "Backend: start_hands … -> Lefty", "You: On it."], "- Lefty [working, 1 min] task: flights");
  expect(told).toContain("do not answer it again");
  expect(told).toContain("User: find me flights to Tokyo\nBackend: start_hands … -> Lefty\nYou: On it.");
  expect(told).toContain("The hands now, for you to know:\n- Lefty");
});

test("the camera films only cards that show a picture: one alone four times a second, several once a second each in turn", () => {
  const card = (id: string, shot: number, extra = {}) => ({ id, window: 1, viewing: false, last: false, shot, ...extra });
  expect(nextShot([card("lefty", 0)], null, 200)?.id).toBeUndefined();
  expect(nextShot([card("lefty", 0)], null, 250)?.id).toBe("lefty");
  const three = [card("lefty", 500), card("righty", 100), card("thumbs", 0, { window: null }), card("pinky", 0, { viewing: true }), card("index", 0, { last: true })];
  expect(nextShot(three, null, 1050)).toBeNull(); // two cards with windows: each waits its second
  expect(nextShot(three, null, 1100)?.id).toBe("righty");
  expect(nextShot(three, new Set(["lefty"]), 1100)?.id).toBe("lefty"); // the only card showing a picture: four times a second
  expect(nextShot(three, new Set([]), 5000)).toBeNull();
});

test("the card under the pointer is filmed first, four times a second, and the others keep their turns", () => {
  const card = (id: string, shot: number, extra = {}) => ({ id, window: 1, viewing: false, last: false, shot, ...extra });
  const two = [card("lefty", 800), card("righty", 0)];
  expect(nextShot(two, null, 1050, ["lefty"])?.id).toBe("lefty"); // 250 ms since its last: due, ahead of Righty
  expect(nextShot(two, null, 1000, ["lefty"])?.id).toBe("righty"); // not due yet: Righty, waiting its second, goes
  expect(nextShot([card("lefty", 800), card("righty", 500)], null, 1000, ["lefty"])).toBeNull();
  // One that is not shown, or is gone, or is nobody, changes nothing.
  expect(nextShot(two, new Set(["righty"]), 1050, ["lefty"])?.id).toBe("righty");
  expect(nextShot(two, null, 1050, [null])?.id).toBe("righty");
  expect(nextShot([card("lefty", 800, { viewing: true }), card("righty", 900)], null, 1050, ["lefty"])).toBeNull();
});

test("a card knows its window is in front only once that has lasted a second, and the same going back", () => {
  const one = { window: 7, viewing: false, front: { value: false, since: 0 } };
  expect(glance(one, 7, 1000)).toBe(false);
  expect(glance(one, 7, 1500)).toBe(false);
  expect(glance(one, 7, 2000)).toBe(true);
  expect(one.viewing).toBe(true);
  expect(glance(one, 9, 2100)).toBe(false); // passed through another window
  expect(glance(one, 7, 2200)).toBe(false);
  expect(glance(one, null, 3000)).toBe(false);
  expect(glance(one, null, 4000)).toBe(true);
  const gone = { window: null, viewing: true, front: { value: true, since: 0 } }; // its window went while it was in front
  glance(gone, null, 100);
  expect(glance(gone, null, 1200)).toBe(true);
  expect(gone.viewing).toBe(false);
});

test("the log's time is local ISO 8601 to the millisecond, with its offset", () => {
  expect(isoTime(new Date(2026, 8, 26, 9, 5, 7, 42))).toMatch(/^2026-09-26T09:05:07\.042[+-]\d\d:\d\d$/);
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

test("the voice sends a question about how things are going to the backend, and then tells the user what it answered", () => {
  expect(FRONTEND).toContain("The user asks how things are going, or how a hand is doing. Delegate it so the backend can look");
  // What it may say of a backend's reply: not only who is on it, whatever was asked.
  const replies = FRONTEND.slice(FRONTEND.indexOf("When the backend replies"), FRONTEND.indexOf("Nothing else about a delegation."));
  expect(replies).toContain("It answered a question about how things are going: tell the user its answer");
  expect(replies).toContain("It asked hands to stop, or dismissed them: say so");
  // And a result it may give: from a note that a hand finished, or from that answer.
  const results = FRONTEND.split("\n").find((line) => line.includes("any other result may come only from"))!;
  expect(results).toContain("the backend's answer to a question about how things are going");
});

test("notes go to the voice whole, the oldest first, as many as fit in one, and never none", () => {
  const note = (n: number) => "x".repeat(n);
  expect(notesThatFit([note(500), note(500), note(498)])).toBe(3); // 1498 with the two line breaks
  expect(notesThatFit([note(500), note(500), note(499)])).toBe(2);
  expect(notesThatFit([note(1600), note(10)])).toBe(1);
  expect(notesThatFit([])).toBe(0);
});

test("the startup notice gives the line that turns occlusion tracking off, as the README gives it", () => {
  const notice = occlusionNotice("Google Chrome");
  const line = notice.match(/`([^`]+)`/)?.[1];
  expect(line).toBe("reg add HKCU\\Software\\Policies\\Google\\Chrome /v NativeWindowOcclusionEnabled /t REG_DWORD /d 0 /f");
  const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
  expect(readme).toContain(line!);
  expect(readme).toMatch(/^## Windows\r?$/m);
  expect(readme).toContain("**Browsing fully out of sight**");
  expect(notice).toContain('"Browsing fully out of sight"');
  expect(occlusionNotice("Microsoft Edge")).toContain("HKCU\\Software\\Policies\\Microsoft\\Edge");
});

test("--cold-mic says what a press loses: on Windows the arming too, a quarter of a second in all", () => {
  const flat = (text: string) => text.replace(/\s+/g, " ");
  expect(flat(usage())).toContain("Cold, about a tenth of a second at the start of each press is lost.");
  process.env.HANDS_PLATFORM = "windows";
  try {
    expect(flat(usage())).toContain("Cold, about a quarter of a second at the start of each press is lost: the key counts only once it has been held for a fifth of a second");
  } finally {
    delete process.env.HANDS_PLATFORM;
  }
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
