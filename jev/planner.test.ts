import { describe, expect, test } from "bun:test";
import type { Hand } from "../desktop";
import type { Intent } from "./intent";
import { assertContract, type Ask } from "./jev";
import type { Llm, LlmRequest } from "./openai";
import { choosePlanner, makePlan, PLANNERS, toPlan } from "./planner";

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
