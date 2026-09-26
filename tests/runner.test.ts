import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestError, RateLimitError, type TypeSafeClient } from "@typesafe-ai/sdk";
import sharp from "sharp";
import type { Context, Drive } from "../src/actions.ts";
import * as macos from "../src/macos.ts";
import { Abort, type AxNode, type Screen } from "../src/models.ts";
import { BLANK, type RunConfig, run } from "../src/runner.ts";
import type { Writer } from "../src/writer.ts";
import { guardMachine } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "hands-runner-"));
const picture = join(dir, "window.png");
beforeAll(async () => {
  await sharp({ create: { width: 800, height: 600, channels: 3, background: "#ffffff" } }).png().toFile(picture);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let controls: AxNode[]; // what the window shows now
let slept: number[];
beforeEach(() => {
  guardMachine();
  controls = [];
  slept = [];
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(macos, "checkAbort").mockImplementation(() => {});
  spyOn(macos, "sleepWatching").mockImplementation(async (seconds) => void slept.push(seconds));
  spyOn(macos, "releaseElements").mockImplementation(() => {});
  spyOn(macos, "recognizeText").mockImplementation(() => []);
  spyOn(macos, "actionableElements").mockImplementation(() => [controls, [], false]);
});
afterEach(() => mock.restore());

const control = (label: string, role = "AXButton", extra: Partial<AxNode> = {}): AxNode => ({ role, label, x: 100, y: 50 + 30 * label.length, w: 120, h: 20, pressable: true, ref: { label }, ...extra });
const choice = (label: string, confidence = 0.95, probabilities: Record<string, number> = { [label]: confidence }) => ({ type: "choice", choice: label, confidence, probabilities });
const noul = (p: number) => ({ type: "noul", noul: p });

/** The hand's window, as a look gives it: a fresh Screen each time, over the same picture. */
const window = (url: string | null = "https://shop.example.com/", extra: Partial<Screen> = {}): Screen => ({
  image: { path: picture, width: 800, height: 600 },
  scale: 1,
  app: "Google Chrome",
  field: null,
  url,
  pid: 1,
  window: [0, 0, 800, 600],
  origin: [0, 0],
  windowId: 5,
  axRefs: new Map(),
  offscreen: [],
  ...extra,
});

type State = { elements: string[]; already_tried_on_this_screen?: string[] };
type Questions = Record<string, { type: string; criteria?: Record<string, unknown> }>;
type Reply = (state: State, questions: Questions, n: number) => Record<string, unknown> | Promise<Record<string, unknown>>;
const idOf = (state: State, text: string) => state.elements.find((line) => line.includes(`'${text}'`))!.split(":")[0]!;

/** Jev as a script: every request kept, answered by `reply`, which may throw as the SDK does. */
function jev(reply: Reply) {
  const sent: { state: State; questions: Questions; signal?: AbortSignal }[] = [];
  const listed: unknown[] = [];
  const client = {
    systemOne: async ({ state, questions }: { state: State; questions: Questions }, options?: { signal?: AbortSignal }) => {
      sent.push({ state, questions, signal: options?.signal });
      return { model: "jev-1.13.0", usage: { input_tokens: 777, output_tokens: 0 }, answers: await reply(state, questions, sent.length) };
    },
    models: { list: (options: unknown) => (listed.push(options), Promise.resolve([])) },
  } as unknown as TypeSafeClient;
  return { client, sent, listed };
}

/** A drive that does what it is told and says so, recording each action. */
function drive(did: string[] = []): Drive {
  return {
    click: async (it) => (did.push(`click ${it.text}`), `pressed '${it.text}' via accessibility`),
    offscreen: async (key) => (did.push(`offscreen ${key}`), `pressed off-screen control ${key}`),
    fill: async (field, text) => (did.push(`fill ${field.label}=${text}`), "via accessibility"),
    reread: (field) => ({ ...field, value: did.findLast((line) => line.startsWith(`fill ${field.label}=`))?.split("=")[1] ?? "" }),
    key: async (name) => void did.push(`key ${name}`),
    scroll: async (lines) => void did.push(`scroll ${lines}`),
  };
}

/** One run from behind, as the clicker makes it: its own look, no fixed delay, no closing answer. */
async function behind(client: TypeSafeClient, config: Partial<RunConfig> = {}, extra: Partial<Context> = {}) {
  const did: string[] = [];
  const out = mkdtempSync(join(dir, "run-"));
  const state = await run(
    { goal: "open the Pricing page", out, act: true, steps: 10, delay: 0, answer: false, typesafe: client, look: async () => window(), ...config },
    (typesafe, history) => ({ goal: "open the Pricing page", browser: "Google Chrome", email: null, typesafe, writer: null, history, drive: drive(did), ...extra }),
  );
  return { state, did, out };
}

test("an action that left the screen as it was is told so, what was tried there goes back to Jev, and a third time is a loop", async () => {
  controls = [control("Pricing")];
  const { client, sent } = jev(() => ({ kind: choice("scroll_down"), goal_met: noul(0.02) }));
  const { state, did } = await behind(client);
  expect(state.outcome).toBe("stalled");
  expect(state.reason).toBe("the same action 3 times, and the screen did not change: scrolled down");
  expect(state.history).toEqual(Array(3).fill("scrolled down -> no visible change"));
  expect(did).toEqual(["scroll -10", "scroll -10", "scroll -10"]);
  expect(sent).toHaveLength(3);
  expect(sent[0]!.state).not.toHaveProperty("already_tried_on_this_screen");
  expect(sent[2]!.state.already_tried_on_this_screen).toEqual(Array(2).fill("scrolled down -> no visible change"));
});

test("a changed screen resets the count, a first wait is waiting (for a whole second), and actions of every kind that change nothing end the run", async () => {
  controls = [control("Pricing")];
  const kinds = ["wait", "scroll_down", "press_escape", "scroll_up", "wait", "wait", "scroll_down", "press_escape", "scroll_up"];
  const { client } = jev((_state, _questions, n) => {
    if (n === 3) controls = [control("Pricing"), control("Plans")]; // the escape closed something
    return { kind: choice(kinds[n - 1]!), goal_met: noul(0) };
  });
  const { state } = await behind(client);
  expect(slept).toEqual([1, 1, 1]); // the waits, and no fixed delay after the other actions
  expect(state.history.slice(0, 3)).toEqual(["waited 1s -> no visible change", "scrolled down -> no visible change", "pressed Escape -> screen changed"]);
  expect(state.outcome).toBe("stalled");
  expect(state.reason).toBe("4 actions in a row changed nothing on the screen"); // scroll up; a wait after it, which is waiting; a second wait, scroll down, escape
  expect(state.history).toHaveLength(8);
});

test("Jev's answers decide the ending: the screen must show the goal met, none and a target it could not find are said, and a label never offered is not acted on", async () => {
  controls = [control("Pricing"), control("Plans")];
  const cases: [Record<string, unknown> | ((state: State) => Record<string, unknown>), string, string | null][] = [
    [(s) => ({ kind: choice("click_item"), item_0: choice(idOf(s, "Pricing")), goal_met: noul(0.86) }), "done", "goal_met 0.86"],
    [{ kind: choice("done"), goal_met: noul(0.62) }, "done", "goal_met 0.62"],
    [{ kind: choice("done"), goal_met: noul(0.3) }, "unsure", "Jev would stop, but does not see the goal met on this screen (goal_met 0.30)"],
    [{ kind: choice("none"), goal_met: noul(0.1) }, "nothing helps", "Jev found nothing on this screen that helps with the goal"],
    [{ kind: choice("click_item"), item_0: choice("none_of_these"), goal_met: noul(0.1) }, "unsure", "Jev would click item, but found nothing listed that fits the goal"],
    [{ kind: choice("use_browser"), site: choice("github"), goal_met: noul(0.1) }, "unsure", "the kind 'use_browser' was not offered"],
    [{ kind: choice("click_item"), goal_met: noul(0.1) }, "unsure", "the reply has no item answer"],
    [(s) => ({ kind: choice("click_item"), item_0: choice(idOf(s, "Plans"), 0.44), goal_met: noul(0.1) }), "low confidence", "item '0' at 0.44, below 0.5"], // Plans lies above Pricing
  ];
  for (const [reply, outcome, reason] of cases) {
    const { client } = jev((state) => (typeof reply === "function" ? reply(state) : reply));
    const { state, did } = await behind(client);
    expect([state.outcome, state.reason]).toEqual([outcome, reason]);
    expect(did).toEqual([]);
  }
});

test("Jev saying the run is stuck counts only after three actions", async () => {
  let n = 0;
  controls = [control("Page 0")];
  const { client } = jev(() => {
    controls = [control(`Page ${++n}`)]; // every step a new screen: no loop
    return { kind: choice("scroll_down"), goal_met: noul(0), stuck: noul(0.9) };
  });
  const { state } = await behind(client);
  expect(state.history).toHaveLength(3);
  expect(state.outcome).toBe("stalled");
  expect(state.reason).toBe("Jev says the run repeats itself or makes no progress (stuck 0.90)");
});

test("a request over Jev's token limit is asked once more, smaller: fewer items and no off-screen controls", async () => {
  controls = Array.from({ length: 200 }, (_, i) => ({ ...control(`Row ${i}`), y: 10 + 2.5 * i }));
  const hidden = [control("Footer", "AXLink", { y: 4000 })];
  spyOn(macos, "actionableElements").mockImplementation(() => [controls, hidden, false]);
  const { client, sent } = jev((_state, _questions, n) => {
    if (n === 1) throw new BadRequestError(400, { detail: { error_type: "max_tokens_exceeded" } }, new Headers());
    return { kind: choice("done"), goal_met: noul(0.9) };
  });
  const { state, out } = await behind(client);
  expect(state.outcome).toBe("done");
  expect(sent.map((request) => request.state.elements.length)).toEqual([200, 120]);
  expect(sent[0]!.questions).toHaveProperty("offscreen");
  expect(sent[1]!.questions).not.toHaveProperty("offscreen");
  expect(existsSync(join(out, "step-001-payload-smaller.txt"))).toBe(true);
});

test("a request Jev fails on ends the run with the failure said, never as an exception", async () => {
  controls = [control("Pricing")];
  const tooLarge = jev(() => {
    throw new BadRequestError(400, { detail: { error_type: "max_tokens_exceeded" } }, new Headers());
  });
  expect((await behind(tooLarge.client)).state.outcome).toBe("classifier failed: 400 max_tokens_exceeded");
  expect(tooLarge.sent).toHaveLength(2);
  const limited = jev(() => {
    throw new RateLimitError(429, {}, new Headers());
  });
  expect((await behind(limited.client)).state.outcome).toBe("classifier failed: 429");
});

test("a click whose label commits something is put to Jev's gate first, and a likely consequence stops the run for approval", async () => {
  controls = [control("Place order"), control("Pricing")];
  const risky = { irreversible: noul(0.92), spends_money: noul(0.88), destroys_data: noul(0.05), handles_secret: noul(0.02), off_goal: noul(0.1) };
  const { client, sent } = jev((state, questions) => ("irreversible" in questions ? risky : { kind: choice("click_item"), item_0: choice(idOf(state, "Place order")), goal_met: noul(0) }));
  const { state, did } = await behind(client);
  expect(state.outcome).toBe("needs approval: click button 'Place order'");
  expect(state.reason).toBe("irreversible 0.92");
  expect(did).toEqual([]);
  expect(sent[1]!.state as unknown).toEqual({ goal: "open the Pricing page", action: "click button 'Place order'", app: "Google Chrome", url: "https://shop.example.com/" });
  // An ordinary label is not asked about: one request a step.
  const plain = jev((state, _questions, n) => (n === 1 ? { kind: choice("click_item"), item_0: choice(idOf(state, "Pricing")), goal_met: noul(0) } : { kind: choice("done"), goal_met: noul(0.9) }));
  const { did: pressed } = await behind(plain.client);
  expect(pressed).toEqual(["click Pricing"]);
  expect(plain.sent).toHaveLength(2);
});

test("each step's answers record the model that answered and the tokens it read", async () => {
  controls = [control("Pricing")];
  const { client } = jev(() => ({ kind: choice("done"), goal_met: noul(0.9) }));
  const { out } = await behind(client);
  expect(await Bun.file(join(out, "step-001-answers.json")).json()).toMatchObject({ model: "jev-1.13.0", input_tokens: 777, goal_met: 0.9, chosen: "done" });
});

test("the user's stop ends a request that is out, as the stop it was", async () => {
  controls = [control("Pricing")];
  let stopped = false;
  spyOn(macos, "checkAbort").mockImplementation(() => {
    if (stopped) throw new Abort("stopped");
  });
  const { client } = jev(
    (_state, _questions) =>
      new Promise((_, reject) => {
        setTimeout(() => (stopped = true), 20);
        setTimeout(() => reject(new Error("the request was never stopped")), 2000);
      }),
  );
  const began = performance.now();
  const { state } = await behind(client);
  expect(state.outcome).toBe("aborted (stopped)");
  expect(performance.now() - began).toBeLessThan(1000);
});

test("a blank page is shown to its browser once per address, looked at again within the step, and a page still blank ends the run saying why", async () => {
  const { client, sent } = jev(() => ({ kind: choice("done"), goal_met: noul(0.9) }));
  const shown: string[] = [];
  const { state } = await behind(client, { prime: async (screen) => (shown.push(screen.url!), false) });
  expect(shown).toEqual(["https://shop.example.com/"]);
  expect(state.outcome).toBe("blank");
  expect(state.reason).toBe(BLANK);
  expect(sent).toEqual([]);
  // Brought up by the showing, the same step goes on to ask.
  const later = jev(() => ({ kind: choice("done"), goal_met: noul(0.9) }));
  const { state: after } = await behind(later.client, { prime: async () => ((controls = [control("Pricing")]), true) });
  expect(after.outcome).toBe("done");
  expect(after.timings).toHaveLength(1);
});

test("the first step can start from a capture the caller holds: no look of its own, and no warm-up racing its question", async () => {
  controls = [control("Pricing")];
  const looks: string[] = [];
  const held = window();
  const reused = jev(() => ({ kind: choice("done"), goal_met: noul(0.9) }));
  await behind(reused.client, { first: [held, []], look: async (out) => (looks.push(out), window()) });
  expect(looks).toEqual([]);
  expect(reused.listed).toEqual([]);
  const fresh = jev(() => ({ kind: choice("done"), goal_met: noul(0.9) }));
  await behind(fresh.client, { look: async (out) => (looks.push(out), window()) });
  expect(looks).toHaveLength(1);
  expect(fresh.listed).toHaveLength(1); // the connection opens while the first capture is taken
});

test("typing goes into the field Jev chose with the hand's own text, then Return when it says the field submits", async () => {
  controls = [control("Search", "AXTextField", { value: "" }), control("Go")];
  const { client } = jev((state, _questions, n) =>
    n === 1 ? { kind: choice("type_text"), field: choice(idOf(state, "Search"), 0.35), submit: noul(0.8), goal_met: noul(0) } : { kind: choice("done"), goal_met: noul(0.9) },
  );
  const { state, did } = await behind(client, {}, { text: "Grace Hopper" });
  expect(did).toEqual(["fill Search=Grace Hopper", "key return"]);
  expect(state.history[0]).toStartWith("typed 'Grace Hopper' into 'Search' via accessibility, and pressed Return");
});

test("without a writer's answer asked for, none is written", async () => {
  controls = [control("Pricing")];
  const asked: unknown[] = [];
  const writer: Writer = async (request) => (asked.push(request), { achieved: true, answer: "x" });
  const { client } = jev(() => ({ kind: choice("done"), goal_met: noul(0.9) }));
  const out = mkdtempSync(join(dir, "run-"));
  await run({ goal: "g", out, act: true, delay: 0, answer: false, typesafe: client, look: async () => window() }, (typesafe, history) => ({ goal: "g", browser: "Google Chrome", email: null, typesafe, writer, history, drive: drive() }));
  expect(asked).toEqual([]);
});
