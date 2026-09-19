/** The feed against a fake helper: what it is told to show, when, and that none of it can hold a hand up. */

import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { MASK } from "../src/cursor.ts";
import { type Feed, openFeed } from "../src/feed.ts";
import * as macos from "../src/macos.ts";
import type { NativeSession } from "../src/macos.ts";
import { type Step, stepLine, toCursorEvent } from "../src/steps.ts";
import * as windows from "../src/windows.ts";

const text = (base64: string) => Buffer.from(base64, "base64").toString("utf8");
const settle = (ms = 80) => Bun.sleep(ms);

/** feed.cs replaced by a pipe: what was written to it, and a way to say what it would say. */
function helper() {
  let say!: (line: string) => void;
  let hangUp!: () => void;
  const written: string[] = [];
  const exited = Promise.withResolvers<number>();
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      say = (line) => controller.enqueue(new TextEncoder().encode(`${line}\n`));
      hangUp = () => (controller.close(), exited.resolve(0));
    },
  });
  const session: NativeSession = { stdout, stderr: new ReadableStream(), exited: exited.promise, write: (line) => void written.push(line.trimEnd()), end: () => hangUp(), kill: () => hangUp() };
  return { session, written, say: (line: string) => say(line), hangUp: () => hangUp(), sent: (command: string) => written.filter((line) => line.startsWith(`${command} `) || line === command) };
}

const click: Step = { hand: 1, kind: "click", label: "click Search", hwnd: 4242, frame: [1920, 1040], rect: [900, 500, 120, 40], tier: "recipe" };

let saved: string | undefined;
let feed: Feed | undefined;
beforeEach(() => {
  saved = process.env.HANDS_FEED;
  delete process.env.HANDS_FEED;
});
afterEach(async () => {
  mock.restore();
  await feed?.close();
  feed = undefined;
  if (saved === undefined) delete process.env.HANDS_FEED;
  else process.env.HANDS_FEED = saved;
});

// ------------------------------------------------------------------ steps

test("a step becomes the pointer's event in shares of the window, with what was typed cut short", () => {
  const event = toCursorEvent({ ...click, kind: "type", text: "quarterly numbers ".repeat(10) }, undefined, 7);
  expect(event).toMatchObject({ hand: 1, kind: "type", t: 7, x: 0.5, y: 0.5, rect: [0.4688, 0.4808, 0.0625, 0.0385], frame: [1920, 1040], caption: "click Search" });
  expect(event.text!.length).toBeLessThanOrEqual(80);
});

test("a step with no frame of its own uses the hand's last one, and one with no place moves no pointer", () => {
  expect(toCursorEvent({ hand: 2, kind: "click", label: "click OK", point: [50, 50] }, [100, 200])).toMatchObject({ x: 0.5, y: 0.25 });
  const nowhere = toCursorEvent({ hand: 2, kind: "navigate", label: "open the inbox", text: "https://mail.example.com/" });
  expect(nowhere.x).toBeUndefined();
  expect(nowhere.text).toBe("https://mail.example.com/");
});

test("a drag carries its stroke", () => {
  const event = toCursorEvent({ hand: 1, kind: "drag", label: "draw a line", frame: [100, 100], path: [[10, 10], [50, 50], [90, 10]] }); // prettier-ignore
  expect(event.path).toEqual([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.1 }]); // prettier-ignore
  expect(event).toMatchObject({ x: 0.1, y: 0.1 });
});

test("a secret is never shown and never read to the narrator", () => {
  const secret: Step = { hand: 1, kind: "type", label: "type the password", text: "hunter2", secret: true, tier: "screen" };
  expect(toCursorEvent(secret).text).toBe(MASK);
  expect(stepLine(secret)).toBe(`[screen] type the password: ${JSON.stringify(MASK)}`);
  expect(stepLine({ hand: 1, kind: "type", label: "type the subject", text: "Lunch on Friday" })).toBe('type the subject: "Lunch on Friday"');
  expect(stepLine(click)).toBe("[recipe] click Search");
  // A driver that quotes what it types in its label: masked there too, on the tag, the strip and the narrator's line.
  const quoted: Step = { ...secret, label: 'type "hunter2" into Password' };
  expect(toCursorEvent(quoted).caption).toBe(`type "${MASK}" into Password`);
  expect(stepLine(quoted)).toBe(`[screen] type "${MASK}" into Password`);
});

// ------------------------------------------------------------------ tiles and pointers

test("a hand's tile follows the window it works, and its pointer is drawn once the tile says how big it is", async () => {
  const fake = helper();
  let clock = 1000;
  feed = openFeed({ open: () => fake.session, print: () => {}, now: () => clock, summarize: async () => "NO_UPDATE" });
  feed.step(click);
  expect(fake.sent("pip")).toEqual(["pip 1 4242"]);
  expect(fake.sent("label")).toEqual(["label 1 working click Search"]);
  expect(fake.sent("draw")).toEqual([]); // no well yet: nothing to fit the picture into

  clock += 100; // the pointer has begun to appear, and is still on its way
  fake.say("tile 1 310 193 1920 1040");
  await settle();
  const first = fake.sent("draw").at(-1)!;
  expect(first).toStartWith("draw 1 ");
  expect(first).toContain("pointer ");
  expect(first).not.toContain("ring "); // the ripple waits for the pointer to land

  clock += 400;
  await settle();
  const landed = fake.sent("draw").at(-1)!;
  expect(landed).toContain("ring 155 96 "); // the middle of the control, through the letterbox: 310 x 168, 12 px down the well
  const tag = landed.split(";").find((primitive) => primitive.startsWith("tag "))!.split(" ");
  expect([text(tag[9]!), text(tag[10]!)]).toEqual(["H1", "click Search"]);

  feed.step({ ...click, label: "click Search again" }); // the same window: the tile stays
  expect(fake.sent("pip")).toHaveLength(1);
});

test("a still picture is sent once", async () => {
  const fake = helper();
  let clock = 1000;
  feed = openFeed({ open: () => fake.session, print: () => {}, now: () => clock, summarize: async () => "NO_UPDATE" });
  feed.step(click);
  clock = 60_000; // long after the glide, the ripple and the caption: a pointer at rest
  fake.say("tile 1 310 193 1920 1040");
  await settle(200);
  expect(fake.sent("draw")).toHaveLength(1);
});

test("a resized window moves the letterbox, so the same pose is drawn again", async () => {
  const fake = helper();
  let clock = 1000;
  feed = openFeed({ open: () => fake.session, print: () => {}, now: () => clock, summarize: async () => "NO_UPDATE" });
  feed.step(click);
  clock = 60_000;
  fake.say("tile 1 310 193 1920 1040");
  await settle();
  fake.say("tile 1 310 193 800 800");
  await settle();
  expect(fake.sent("draw")).toHaveLength(2);
  expect(fake.sent("draw")[1]).not.toBe(fake.sent("draw")[0]);
});

// ------------------------------------------------------------------ the card

test("the words go to the card as they are said, as one line", () => {
  const fake = helper();
  feed = openFeed({ open: () => fake.session, print: () => {} });
  feed.listening();
  feed.transcript("open the\ncalculator;  and");
  feed.finishing();
  expect(fake.written).toEqual(["listening", "transcript open the calculator; and", "finishing"]);
});

test("the words leave the card after the key comes up, the card leaves with the last task, and neither while the key is held", async () => {
  const fake = helper();
  feed = openFeed({ open: () => fake.session, print: () => {}, cardLingerMs: 20, tileLingerMs: 20, summarize: async () => "NO_UPDATE" });
  feed.task(1, "running", "find me a lofi video");
  feed.step(click);
  feed.listening();
  feed.finishing(); // a follow-up said while the hand works
  await settle(60);
  expect(fake.written.at(-1)).toBe("rows");
  expect(fake.sent("hide")).toEqual([]);

  feed.listening();
  feed.task(1, "done", "find me a lofi video");
  await settle(60);
  expect(fake.sent("hide")).toEqual([]); // still speaking: the card stays under the words
  expect(fake.sent("pip").at(-1)).toBe("pip 1 off"); // the tile had its look at the result
  feed.finishing();
  await settle(60);
  expect(fake.written.at(-1)).toBe("hide");

  // The next task's tile comes back on the window the hand was working, before its first step says where.
  feed.task(1, "running", "and the next one");
  expect(fake.sent("pip").at(-1)).toBe("pip 1 4242");
});

test("with no windows the words are one line of the terminal, and what is printed meanwhile goes above it", async () => {
  process.env.HANDS_FEED = "off";
  const terminal: string[] = [];
  feed = openFeed({ print: (line) => terminal.push(`print ${line}`), live: (line) => terminal.push(`live ${line}`), narrateEveryMs: 0, summarize: async () => "Searching YouTube." });
  feed.task(1, "running", "find me a lofi video");
  feed.listening();
  feed.transcript("and then\nplay it");
  feed.step(click);
  await settle();
  feed.finishing();
  expect(terminal).toEqual(["live … listening", "live … and then play it", "live ", "print H1: Searching YouTube.", "live … and then play it", "live "]);
});

test("a running task gets a row and a narrator, which reads the steps against the request", async () => {
  const fake = helper();
  const printed: string[] = [];
  const asked: { task: string; steps: string[] }[] = [];
  feed = openFeed({
    open: () => fake.session,
    print: (line) => printed.push(line),
    narrateEveryMs: 0,
    summarize: async (input) => (asked.push({ task: input.task, steps: input.steps.map((step) => step.text) }), "Searching YouTube for lofi."),
  });
  feed.task(1, "running", "find me a lofi video");
  feed.step(click);
  feed.step({ hand: 1, kind: "type", label: "type the password", text: "hunter2", secret: true });
  await settle();
  expect(fake.sent("task")).toEqual(["task 1 running find me a lofi video"]);
  expect(asked[0]!.task).toBe("find me a lofi video");
  expect(asked.at(-1)!.steps.join(" ")).not.toContain("hunter2");
  expect(fake.sent("progress")).toEqual(["progress 1 Searching YouTube for lofi."]);
  expect(printed).toContain("H1: Searching YouTube for lofi.");

  feed.task(1, "done", "find me a lofi video");
  expect(fake.sent("task").at(-1)).toBe("task 1 done find me a lofi video");
  expect(fake.sent("label").at(-1)).toBe("label 1 done done");
});

// ------------------------------------------------------------------ the question

test("a sensitive action waits for the chord, and the card says who wants what", async () => {
  const fake = helper();
  const printed: string[] = [];
  feed = openFeed({ open: () => fake.session, print: (line) => printed.push(line) });
  const answer = feed.approve({ hand: 2, what: "send the email to Dana", target: "Send button; Gmail" });
  await settle(20);
  const ask = fake.sent("ask")[0]!.split(" ");
  expect(ask.slice(0, 4)).toEqual(["ask", "1", "2", "30"]);
  expect([text(ask[4]!), text(ask[5]!)]).toEqual(["send the email to Dana", "Send button; Gmail"]);
  expect(fake.sent("label")).toEqual(["label 2 blocked send the email to Dana"]);
  fake.say("answer 1 yes");
  expect(await answer).toBe(true);
  expect(fake.sent("answered")).toEqual(["answered 1"]);
  expect(printed[0]).toContain("H2 wants to send the email to Dana");
});

test("no answer is a no, and so is a helper that has gone", async () => {
  const fake = helper();
  feed = openFeed({ open: () => fake.session, print: () => {} });
  expect(await feed.approve({ hand: 1, what: "delete the draft", timeoutMs: 30 })).toBe(false);
  expect(fake.sent("answered")).toEqual(["answered 1"]);
  const asked = feed.approve({ hand: 1, what: "delete the draft" });
  await settle(20);
  fake.hangUp();
  expect(await asked).toBe(false);
});

test("two hands ask one at a time, the second's clock starts when it is shown, and a closed feed answers no", async () => {
  const fake = helper();
  feed = openFeed({ open: () => fake.session, print: () => {} });
  const first = feed.approve({ hand: 1, what: "send the email" });
  const second = feed.approve({ hand: 2, what: "delete the draft" });
  const third = feed.approve({ hand: 1, what: "pay the invoice" });
  await settle(20);
  expect(fake.sent("ask").map((line) => line.split(" ")[1])).toEqual(["1"]);
  fake.say("answer 1 yes");
  expect(await first).toBe(true);
  await settle(20);
  expect(fake.sent("ask").map((line) => line.split(" ").slice(1, 3).join(" "))).toEqual(["1 1", "2 2"]);
  await feed.close();
  expect(await second).toBe(false);
  expect(await third).toBe(false);
  expect(fake.sent("ask")).toHaveLength(2); // the third was never shown
  expect(await feed.approve({ hand: 1, what: "anything" })).toBe(false);
});

test("an answer to another question is not an answer to this one", async () => {
  const fake = helper();
  feed = openFeed({ open: () => fake.session, print: () => {} });
  const asked = feed.approve({ hand: 1, what: "buy the ticket", timeoutMs: 120 });
  await settle(20);
  fake.say("answer 7 yes");
  expect(await asked).toBe(false);
});

// ------------------------------------------------------------------ never in the way

test("with the feed off the same calls go to the terminal, and the question is asked there", async () => {
  process.env.HANDS_FEED = "off";
  const questions: string[] = [];
  let opened = false;
  feed = openFeed({ open: () => ((opened = true), helper().session), print: () => {}, askTerminal: async (question) => (questions.push(question), true) });
  feed.task(1, "running", "anything");
  feed.step(click);
  expect(await feed.approve({ hand: 1, what: "send it", target: "Send" })).toBe(true);
  expect(opened).toBe(false);
  expect(questions).toEqual(["H1 wants to send it (Send)"]);
});

test("a feed that cannot start says so once and takes every call", async () => {
  const printed: string[] = [];
  feed = openFeed({ open: () => { throw new Error("the on-screen feed runs on Windows only so far"); }, print: (line) => printed.push(line), askTerminal: async () => false }); // prettier-ignore
  feed.listening();
  feed.step(click);
  feed.task(1, "done", "anything");
  expect(await feed.approve({ hand: 1, what: "send it" })).toBe(false);
  expect(printed.filter((line) => line.startsWith("feed:"))).toEqual(["feed: the on-screen feed runs on Windows only so far; progress stays in this terminal"]);
});

test("a helper that dies mid-task costs the hand nothing", () => {
  const fake = helper();
  fake.session.write = () => {
    throw new Error("EPIPE");
  };
  feed = openFeed({ open: () => fake.session, print: () => {}, summarize: async () => "NO_UPDATE" });
  expect(() => (feed!.step(click), feed!.task(1, "running", "x"), feed!.transcript("y"))).not.toThrow();
});

// ------------------------------------------------------------------ the platform

test("on Windows the feed is one more mode of the helper, and the Mac says it has none yet", () => {
  const fake = helper();
  const asked = spyOn(windows.native, "session").mockImplementation(() => fake.session);
  expect(windows.feed()).toBe(fake.session);
  expect(asked.mock.calls).toEqual([["feed"]]);
  expect(() => macos.feed()).toThrow("the on-screen feed runs on Windows only so far");
});
