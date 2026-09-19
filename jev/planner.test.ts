import { describe, expect, test } from "bun:test";
import type { Hand } from "../desktop";
import type { Intent } from "./intent";
import { assertContract, type Ask } from "./jev";
import type { Llm, LlmRequest } from "./openai";
import type { Mark, Marks } from "./marks";
import { choosePlanner, makeMarkedPlan, makePlan, PLANNERS, toMarkedPlan, toPlan } from "./planner";

const hand: Hand = { id: 1, pid: 4242, display: "wayland-7", width: 1280, height: 800 };

const intent: Intent = {
  goal: "Search Wikipedia for capybaras.",
  launcher: "browser",
  url: "https://wikipedia.org/",
  inputs: { search_query: "capybara" },
  doneWhen: "The Capybara article is open.",
  avoid: [],
};

const rawPlan = {
  situation: "A cookie banner covers the page.",
  steps: ["Click 'Accept all'", "Click the search box"],
  elements: [{ role: "button", name: "Accept all", x: 900, y: 700, w: 140, h: 44 }],
  blocked: null,
};

describe("toPlan", () => {
  test("keeps a well formed plan", () => {
    expect(toPlan(rawPlan, hand)).toEqual({
      situation: rawPlan.situation,
      steps: rawPlan.steps,
      elements: [{ role: "button", name: "Accept all", rect: { x: 900, y: 700, w: 140, h: 44 } }],
      blocked: null,
    });
  });

  test("drops any element that is not fully on the hand's screen", () => {
    const plan = toPlan(
      {
        ...rawPlan,
        elements: [
          { role: "button", name: "Past the edge", x: 1250, y: 10, w: 100, h: 20 },
          { role: "button", name: "Negative", x: -5, y: 10, w: 100, h: 20 },
          { role: "button", name: "No size", x: 10, y: 10, w: 0, h: 20 },
          { role: "button", name: "Not a number", x: "12", y: 10, w: 10, h: 20 },
          { role: "button", name: "Infinite", x: Infinity, y: 10, w: 10, h: 20 },
          { role: "button", name: "Fine", x: 10, y: 10, w: 10, h: 20 },
        ],
      },
      hand,
    );
    expect(plan.elements.map((e) => e.name)).toEqual(["Fine"]);
  });

  test("caps the number of steps and treats a blank blocked as not blocked", () => {
    const plan = toPlan({ ...rawPlan, steps: Array(20).fill("step"), blocked: "  " }, hand);
    expect(plan.steps).toHaveLength(8);
    expect(plan.blocked).toBeNull();
  });

  test("rejects a malformed plan", () => {
    expect(() => toPlan({ ...rawPlan, steps: [1] }, hand)).toThrow(/steps malformed/);
    expect(() => toPlan("click stuff", hand)).toThrow();
  });
});

describe("choosePlanner", () => {
  test("offers Jev exactly the configured planners and returns its pick", async () => {
    let offered: string[] = [];
    const ask: Ask = async (_state, questions) => {
      offered = Object.keys((questions as any).planner.criteria);
      const answers = { planner: { type: "choice", choice: "deep", confidence: 0.7, probabilities: {} } };
      assertContract(questions, answers);
      return answers;
    };
    expect(await choosePlanner(ask, { stuck_because: "repeating actions" })).toBe("deep");
    expect(offered).toEqual(Object.keys(PLANNERS));
  });
});

describe("makePlan", () => {
  test("shows the chosen model the screenshot and the reason, and validates the reply", async () => {
    const calls: LlmRequest[] = [];
    const llm: Llm = async (req) => {
      calls.push(req);
      return rawPlan;
    };
    const png = new Uint8Array([137, 80, 78, 71]);
    const plan = await makePlan(llm, "quick", hand, {
      intent,
      history: ["click link \"Home\" -> no visible change"],
      knownElements: ['link "Home" (top left)'],
      reason: "no listed element fits",
      screenshotPng: png,
    });
    expect(plan.elements[0]!.name).toBe("Accept all");
    expect(calls[0]!.model).toBe(PLANNERS.quick.model);
    expect(calls[0]!.imagePng).toBe(png);
    expect(calls[0]!.system).toContain("1280x800");
    const sent = JSON.parse(calls[0]!.user);
    expect(sent.stuck_because).toBe("no listed element fits");
    expect(sent.prepared_inputs).toEqual(["search_query"]); // names only: the planner does not need the values
  });
});

describe("marked plans", () => {
  const mark = (label: string, kind: Mark["kind"], rect: Mark["rect"], extra: Partial<Mark> = {}): Mark => ({ label, id: kind === "known" ? `e${label}` : `m${label}`, kind, rect, role: kind === "known" ? "link" : "button", name: "", within: "", editable: false, ...extra });
  const marks: Marks = {
    marks: [mark("1", "known", { x: 10, y: 10, w: 80, h: 20 }, { name: "report-q3.pdf" }), mark("2", "unnamed", { x: 900, y: 10, w: 34, h: 34 }, { within: "report-q3.pdf" }),
      mark("3", "unnamed", { x: 900, y: 60, w: 34, h: 34 }, { sameAs: "2", within: "invoice.pdf" }), mark("4", "text", { x: 20, y: 300, w: 90, h: 30 }, { name: "Export PNG", role: "text" }), mark("C4", "cell", { x: 320, y: 399, w: 160, h: 133 })],
    image: new Uint8Array([1]), clean: new Uint8Array([2]), drawn: true, screen: { width: 1280, height: 800 },
    timings: { decodeMs: 0, ocrMs: 0, regionsMs: 0, drawMs: 0, encodeMs: 0, totalMs: 0 },
  };
  const raw = {
    situation: "A file list. Nothing is deleted yet.",
    steps: [{ say: "Click the trash icon in the report-q3.pdf row.", mark: "2" }, { say: "Click Export PNG.", mark: "m4" }, { say: "Press Enter.", mark: null }, { say: "Click the ghost.", mark: "77" }],
    captions: [{ mark: "2", name: "Delete", role: "button", container: "report-q3.pdf", editable: false, at: null }, { mark: "1", name: "Renamed", role: "link", container: "", editable: false, at: null },
      { mark: "77", name: "Ghost", role: "button", container: "", editable: false, at: null }, { mark: "C4", name: "Canvas centre", role: "region", container: "canvas", editable: false, at: "top left" }],
    blocked: null,
  };

  test("references become ids Jev will find, rectangles are the measured ones, and what does not exist is dropped", () => {
    const plan = toMarkedPlan(raw, marks);
    expect(plan.cited).toEqual(["m2", "m4", null, null]);
    expect(plan.steps[0]).toBe("Click the trash icon in the report-q3.pdf row. (element m2)");
    expect(plan.steps[2]).toBe("Press Enter.");
    expect(plan.captions.map((c) => c.mark)).toEqual(["2", "C4", "4"]);   // not the known link, not the ghost; the cited text mark is added
    expect(plan.captions.find((c) => c.mark === "4")!.name).toBe("Export PNG");
    expect(plan.elements).toContainEqual({ role: "button", name: "Delete", rect: { x: 900, y: 10, w: 34, h: 34 } });
    expect(plan.elements).toContainEqual({ role: "region", name: "Canvas centre", rect: { x: 320, y: 399, w: 53, h: 44 } });
  });
  test("a mark a step acts on reaches Jev even when the model did not caption it: named by the step, minus its verb", () => {
    const plan = toMarkedPlan({ ...raw, steps: [{ say: "Click the trash icon of invoice.pdf.", mark: "3" }], captions: [] }, marks);
    expect(plan.captions).toEqual([{ mark: "3", name: "trash icon of invoice.pdf", role: "button", container: "", editable: false, at: null }]);
  });
  test("a bot check is blocked, and a malformed answer is an error", () => {
    expect(toMarkedPlan({ ...raw, blocked: "A verify-you-are-human check needs the user." }, marks).blocked).toContain("needs the user");
    expect(() => toMarkedPlan({ ...raw, captions: "none" }, marks)).toThrow(/malformed/);
  });
  test("the model gets the drawn screenshot and a legend without coordinates; with nothing drawn, the clean one and coordinates", async () => {
    const calls: LlmRequest[] = [];
    const llm: Llm = async (req) => { calls.push(req); return raw; };
    await makeMarkedPlan(llm, "quick", hand, { intent, history: [], reason: "no listed element fits", marks });
    await makeMarkedPlan(llm, "quick", hand, { intent, history: [], reason: "no listed element fits", marks: { ...marks, drawn: false } });
    expect(calls[0]!.imagePng).toBe(marks.image);
    expect(JSON.parse(calls[0]!.user).marks).toContain('3: looks the same as 2, in "invoice.pdf"');
    expect(calls[0]!.system).toContain("You never give coordinates");
    expect(calls[1]!.imagePng).toBe(marks.clean);
    expect(JSON.parse(calls[1]!.user).marks[1]).toContain("at x=900 y=10 w=34 h=34");
  });
});
