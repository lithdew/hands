import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@typesafe-ai/sdk";
import sharp from "sharp";
import * as llm from "../src/llm.ts";
import * as macos from "../src/macos.ts";
import { Abort, type Capture } from "../src/models.ts";
import type { Line } from "../src/perception.ts";
import { type RunConfig, run, STOPPED } from "../src/runner.ts";
import { ANSWER_IMAGE_EDGE, composeAnswer, composeUrl, makeWriter, type Writer, type WriterRequest } from "../src/writer.ts";
import { answer, guardMachine, makeItem, screen } from "./helpers.ts";

const GOAL = "find the next upcoming bruno mars concert";
const MODELS = ["CLICKER_ANSWER_MODEL", "CLICKER_WRITER_MODEL"] as const;
const configured = MODELS.map((name) => process.env[name]);

const dir = mkdtempSync(join(tmpdir(), "hands-answer-"));
const shot: Capture = { path: join(dir, "screen.png"), width: 200, height: 120 }; // what every fake screenshot is a copy of

beforeAll(async () => {
  await sharp({ create: { width: shot.width, height: shot.height, channels: 3, background: "#1e1e1e" } })
    .png()
    .toFile(shot.path);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(guardMachine);
afterEach(() => {
  mock.restore();
  MODELS.forEach((name, i) => (configured[i] === undefined ? delete process.env[name] : (process.env[name] = configured[i])));
});

/** Stands in for the writer model: records each request and replies with one structured object. */
function fakeWriter(reply: Record<string, unknown>) {
  const requests: WriterRequest[] = [];
  const writer: Writer = async (request) => (requests.push(request), reply);
  return { requests, writer };
}

interface Sent {
  model: { provider: string; id: string };
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
}

/** Stands in for pi's model runtime, so the real writer builds its request and nothing leaves the machine. */
function fakeRuntime(reply: Record<string, unknown>): Sent[] {
  const sent: Sent[] = [];
  const runtime = {
    hasConfiguredAuth: () => true,
    getModel: (provider: string, id: string) => ({ provider, id }),
    completeSimple: async (model: Sent["model"], context: { messages: { content: Sent["content"] }[] }) => {
      sent.push({ model, content: context.messages[0]!.content });
      return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(reply) }] };
    },
  };
  spyOn(llm, "runtime").mockImplementation(async () => runtime as never);
  return sent;
}

describe("the writer's requests", () => {
  test("the answer request carries the capture and the run", async () => {
    process.env.CLICKER_ANSWER_MODEL = "test/answer-model";
    const fake = fakeWriter({ achieved: true, answer: " Sep 19, 2026 in Miami. " });
    const captured = screen({ image: shot });

    const told = await composeAnswer(fake.writer, GOAL, captured, [makeItem(0, "SEP 19, 2026")], ["clicked 'TOUR'"], "the goal is achieved");

    expect(told).toEqual({ text: "Sep 19, 2026 in Miami.", achieved: true });
    const request = fake.requests[0]!;
    expect(request.model).toBe("test/answer-model");
    expect(request.image).toBe(shot);
    expect(request.packet).toMatchObject({
      goal: GOAL,
      why_the_run_stopped: "the goal is achieved",
      actions_taken: ["clicked 'TOUR'"],
      screen_text_in_reading_order: ["SEP 19, 2026"],
    });

    const sent = fakeRuntime({ achieved: true, answer: "unused" });
    await (await makeWriter())!(request);
    expect(sent[0]?.model.id).toBe("answer-model");
    const [image, text] = sent[0]!.content;
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(JSON.parse(text!.text!)).toEqual(JSON.parse(JSON.stringify(request.packet)));
  });

  test("the capture is shrunk to the edge the model reads and left intact", async () => {
    const retina: Capture = { path: join(dir, "retina.png"), width: 3456, height: 2234 };
    await sharp({ create: { width: retina.width, height: retina.height, channels: 4, background: "#00000000" } })
      .png({ compressionLevel: 1 })
      .toFile(retina.path);
    const sent = fakeRuntime({ ok: true });

    await (await makeWriter())!({ system: "", packet: {}, properties: { ok: { type: "boolean" } }, image: retina });

    const block = sent[0]!.content[0]!;
    const seen = await sharp(Buffer.from(block.data!, "base64")).metadata();
    expect(seen.format).toBe("png");
    expect(Math.max(seen.width, seen.height)).toBe(ANSWER_IMAGE_EDGE);
    const kept = await sharp(retina.path).metadata();
    expect([kept.width, kept.height]).toEqual([3456, 2234]);
  });

  test("requests without a capture stay text only on the writer model", async () => {
    process.env.CLICKER_WRITER_MODEL = "test/writer-model";
    const fake = fakeWriter({ ok: true, url: "https://www.brunomars.com" });

    expect(await composeUrl(fake.writer, GOAL, [])).toBe("https://www.brunomars.com");

    const request = fake.requests[0]!;
    expect(request.model).toBeUndefined(); // left out, which is how a request asks for the per-step writer model
    expect(request.image).toBeUndefined();
    const sent = fakeRuntime({ ok: true, url: "unused", reason: "unused" });
    await (await makeWriter())!(request);
    expect(sent[0]?.model.id).toBe("writer-model");
    expect(sent[0]?.content.map((block) => block.type)).toEqual(["text"]);
  });
});

// conclude and resolve are private to runner.ts, so these go the way a run does: through `run`, on a machine that is all fakes.
describe("the end of a run", () => {
  let logged: ReturnType<typeof spyOn<Console, "log">>;
  let shots: ReturnType<typeof spyOn<typeof macos, "screenshot">>;
  let read: Line[];

  beforeEach(() => {
    read = [];
    logged = spyOn(console, "log").mockImplementation(() => {});
    shots = spyOn(macos, "screenshot").mockImplementation(async (_display, path) => {
      await Bun.write(path, Bun.file(shot.path));
      return { ...shot, path };
    });
    spyOn(macos, "checkAbort").mockImplementation(() => {});
    spyOn(macos, "sleepWatching").mockImplementation(async () => {});
    spyOn(macos, "releaseElements").mockImplementation(() => {});
    spyOn(macos, "frontmostAppAndPid").mockImplementation(async () => ["Google Chrome", 123]);
    spyOn(macos, "frontmostWindowBounds").mockImplementation(async () => null);
    spyOn(macos, "displayFor").mockImplementation(() => ({ index: 0, frame: [0, 0, 100, 60] }));
    spyOn(macos, "focusedField").mockImplementation(() => null);
    spyOn(macos, "browserUrl").mockImplementation(async () => null);
    spyOn(macos, "actionableElements").mockImplementation(() => [[], [], false]);
    spyOn(macos, "recognizeText").mockImplementation(() => read);
  });

  const lines = () => logged.mock.calls.map(([line]) => String(line));

  /** One run whose classifier gives the same answer at every step. Resolves to the state and the run folder. */
  async function finish(kind: string, confidence: number, config: Partial<RunConfig> = {}, writer: Writer | null = null) {
    const systemOne = async () => ({ answers: { kind: answer(kind, confidence), site: answer("none", 1) } });
    spyOn(sdk, "TypeSafeClient").mockImplementation(function () {
      return { systemOne };
    } as never);
    const out = config.out ?? mkdtempSync(join(dir, "run-"));
    const state = await run({ goal: GOAL, delay: 0, ...config, out }, (typesafe, history) => ({
      goal: GOAL,
      browser: "Google Chrome",
      email: null,
      typesafe,
      writer,
      history,
    }));
    return { state, out };
  }

  const abort = () => {
    throw new Abort("Ctrl-C");
  };
  const crash = () => {
    throw new Error("Vision fell over");
  };
  const WAYS_OUT_WITH_NOTHING_TO_REPORT: [outcome: string, arrange: () => unknown, thrown: string | null][] = [
    ["dry run", () => {}, null],
    ["aborted (Ctrl-C)", () => spyOn(macos, "checkAbort").mockImplementation(abort), null],
    ["crashed", () => spyOn(macos, "recognizeText").mockImplementation(crash), "Vision fell over"], // thrown on, once the summary is written
  ];

  test.each(WAYS_OUT_WITH_NOTHING_TO_REPORT)("a run that has nothing to report asks for no answer: %s", async (outcome, arrange, thrown) => {
    const fake = fakeWriter({ achieved: true, answer: "unused" });
    const out = mkdtempSync(join(dir, "run-"));
    arrange();

    const finished = finish("scroll_down", 0.9, { out }, fake.writer);
    await (thrown === null ? finished : expect(finished).rejects.toThrow(thrown));

    const summary = await Bun.file(join(out, "run.json")).json();
    expect(summary).toMatchObject({ outcome, answer: null, goal_achieved: null });
    expect(fake.requests).toEqual([]);
    expect(lines().filter((line) => line.includes("answer (") || line.includes("no answer"))).toEqual([]);
  });

  test("without a writer the run says why there is no answer", async () => {
    const { state } = await finish("done", 0.9);

    expect(state.answer).toBeNull();
    const why = lines().find((line) => line.includes("no answer"));
    expect(why).toContain("the writer is disabled");
    expect(why).toContain("credentials");
  });

  test("the last capture is answered from when nothing acted after it", async () => {
    read = [["SEP 19, 2026", 1, [20, 20, 120, 40]]];
    const fake = fakeWriter({ achieved: true, answer: "Sep 19, 2026 in Miami." });

    const { state, out } = await finish("done", 0.9, {}, fake.writer);

    expect(state.answer).toEqual({ text: "Sep 19, 2026 in Miami.", achieved: true });
    const told = lines().find((line) => line.includes("answer ("));
    expect(told).toContain("goal achieved");
    expect(told).toContain("Sep 19, 2026 in Miami.");
    expect(shots).toHaveBeenCalledTimes(1); // the step's own capture, and none after it
    expect(existsSync(join(out, "answer-raw.png"))).toBe(false);
    expect(fake.requests[0]?.packet).toMatchObject({ screen_text_in_reading_order: ["SEP 19, 2026"] });
    expect((fake.requests[0]?.packet as { why_the_run_stopped: string }).why_the_run_stopped).toContain("already achieved");
  });

  test("a run that stops unsure is answered too, from the screen it stopped on", async () => {
    read = [["$129.99", 1, [20, 20, 120, 40]]];
    const fake = fakeWriter({ achieved: true, answer: "It costs $129.99." });

    const { state } = await finish("click_item", 0.9, {}, fake.writer);

    expect(state.outcome).toBe("unsure");
    expect(state.answer).toEqual({ text: "It costs $129.99.", achieved: true });
    expect((fake.requests[0]?.packet as { why_the_run_stopped: string }).why_the_run_stopped).toContain("could not settle");
  });

  test("the screen is captured again when an action made the last capture stale", async () => {
    read = [["TICKETS", 1, [20, 20, 120, 40]]];
    const scrolled = spyOn(macos, "scroll").mockImplementation(async () => {});
    const fake = fakeWriter({ achieved: false, answer: "No dates on screen." });

    const { state, out } = await finish("scroll_down", 0.9, { act: true, steps: 1 }, fake.writer);

    expect(scrolled.mock.calls).toEqual([[-10]]);
    expect(state.outcome).toBe("step limit");
    expect(state.answer).toEqual({ text: "No dates on screen.", achieved: false });
    expect(lines().find((line) => line.includes("answer ("))).toContain("goal not achieved");
    expect(shots.mock.calls.map(([, path]) => path)).toEqual([join(out, "step-001-raw.png"), join(out, "answer-raw.png")]);
    expect(existsSync(join(out, "answer-raw.png"))).toBe(true);
    expect(fake.requests[0]?.packet).toMatchObject({ screen_text_in_reading_order: ["TICKETS"] });
  });

  test("a writer that fails costs the answer and not the run", async () => {
    const refuse: Writer = async () => {
      throw new Error("Connection error.");
    };

    const { state } = await finish("done", 0.9, {}, refuse);

    expect(state.outcome).toBe("done");
    expect(state.answer).toBeNull();
    expect(lines().find((line) => line.includes("no answer"))).toContain("no answer: the writer failed (Connection error.)");
  });

  const STOPS: [string, number, string][] = [
    ["done", 0.9, "done"],
    ["none", 0.9, "nothing helps"],
    ["scroll_down", 0.2, "low confidence"],
    ["click_item", 0.9, "unsure"], // no item answer, and nothing to click
    ["scroll_down", 0.9, "dry run"],
  ];

  test.each(STOPS)("every stop names its outcome: %s at %d is %s", async (kind, confidence, outcome) => {
    const { state } = await finish(kind, confidence, { steps: 3 });

    expect(state.timings).toHaveLength(1); // it did not keep going
    expect(state.outcome).toBe(outcome);
    expect(outcome in STOPPED).toBe(outcome !== "dry run");
  });

  test("an action makes the last capture stale", async () => {
    spyOn(macos, "scroll").mockImplementation(async () => {});

    const { state } = await finish("scroll_down", 0.9, { act: true, steps: 1 });

    expect(state.history).toEqual(["scrolled down"]);
    expect(state.outcome).toBe("step limit"); // no stop rule fired: the run kept going until its steps ran out
    expect(state.view).toBeNull();
  });
});
