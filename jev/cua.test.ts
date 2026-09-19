import { describe, expect, test } from "bun:test";
import { describeAction, elementLabels, isLooping, jevState, runIntent, type Deps } from "./cua";
import type { Exec, Hand } from "../desktop";
import type { Approve } from "./gate";
import { COMPOSE_LABEL, type Intent } from "./intent";
import { assertContract, type Ask } from "./jev";
import type { Observation, UiElement } from "./observe";
import type { Llm, LlmRequest } from "./openai";

const hand: Hand = { id: 1, pid: 4242, display: "wayland-7", width: 1200, height: 900 };

const intent: Intent = {
  goal: "Search Wikipedia for capybaras.",
  launcher: "browser",
  url: "https://wikipedia.org/",
  inputs: { search_query: "capybara" },
  doneWhen: "The Capybara article is open.",
  avoid: [],
};

const el = (id: string, role: string, name: string, x: number, y: number, over: Partial<UiElement> = {}): UiElement => ({
  id,
  source: "atspi",
  role,
  name,
  value: "",
  editable: role === "text field",
  focused: false,
  within: "",
  frame: "Wikipedia - Chromium",
  rect: { x, y, w: 100, h: 40 },
  ...over,
});

const screen = (fingerprint: string, elements: UiElement[], texts: string[] = []): Observation => ({
  elements,
  texts,
  frames: ["Wikipedia - Chromium"],
  fingerprint,
});

const home = screen("home", [el("e1", "text field", "Search Wikipedia", 500, 100), el("e2", "button", "Search", 620, 100)]);
const article = screen("article", [el("e1", "link", "Main page", 0, 0)], ["Capybara"]);

type Reply = string | number | { choice: string; confidence: number };

/**
 * A scripted Jev. `reply` answers one question by name. Every answer goes
 * through assertContract, so a test can only pick labels the loop really offered.
 */
function fakeJev(reply: (name: string, ctx: { state: any; question: any }) => Reply | undefined) {
  const calls: { state: any; questions: Record<string, any> }[] = [];
  const ask: Ask = async (state, questions) => {
    calls.push({ state, questions });
    const answers: Record<string, unknown> = {};
    for (const [name, question] of Object.entries(questions)) {
      const r = reply(name, { state, question });
      if (question.type === "noul") answers[name] = { type: "noul", noul: typeof r === "number" ? r : 0 };
      else {
        const picked = typeof r === "object" ? r : { choice: String(r), confidence: 0.9 };
        answers[name] = { type: "choice", ...picked, probabilities: {} };
      }
    }
    assertContract(questions, answers);
    return answers as never;
  };
  return { ask, calls, asked: (name: string) => calls.filter((c) => name in c.questions) };
}

/** Records the commands that would reach the hand. */
function fakeExec() {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    return { exitCode: 0, stdout: new TextEncoder().encode("PNG"), stderr: "" };
  };
  return { exec, calls, input: () => calls.filter((c) => c[0] === "wlrctl" || c[0] === "wtype") };
}

/** Serves the given screens in order, then repeats the last one. */
function screens(...list: Observation[]) {
  let i = 0;
  return async () => list[Math.min(i++, list.length - 1)]!;
}

function fakeLlm(reply: unknown) {
  const calls: LlmRequest[] = [];
  const llm: Llm = async (req) => {
    calls.push(req);
    return reply;
  };
  return { llm, calls };
}

const noLlm: Llm = async () => {
  throw new Error("no model call expected");
};
const never: Approve = async () => {
  throw new Error("no approval expected");
};

function deps(over: Partial<Deps> & Pick<Deps, "ask" | "observe">, exec: Exec): Deps {
  return { llm: noLlm, approve: never, exec, sleep: async () => {}, ...over };
}

describe("runIntent", () => {
  test("types an intent input into the field Jev picked, submits, and stops when the goal is met", async () => {
    const jev = fakeJev((name, { state }) => {
      if (name === "goal_met") return state.screen.text.includes("Capybara") ? 0.95 : 0.02;
      return { move: "type", input: "search_query", field: "e1", submit: 0.9 }[name];
    });
    const sh = fakeExec();
    const result = await runIntent(hand, intent, deps({ ask: jev.ask, observe: screens(home, article, article) }, sh.exec));

    expect(result.status).toBe("done");
    expect(result.steps.map((s) => s.did)).toEqual([
      'type search_query ("capybara") into text field "Search Wikipedia" in window "Wikipedia - Chromium", then press Enter',
    ]);
    expect(result.steps[0]!.outcome).toBe("screen changed");
    expect(sh.input()).toEqual([
      ["wlrctl", "pointer", "move", "-100000", "-100000"],
      ["wlrctl", "pointer", "move", "550", "120"], // centre of e1, computed here, never by a model
      ["wlrctl", "pointer", "click", "left"],
      ["wtype", "-s", "40", "-d", "8", "capybara"],
      ["wtype", "-s", "40", "-k", "Return"],
    ]);
  });

  test("clicks the centre of the chosen element", async () => {
    const jev = fakeJev((name, { state }) => {
      if (name === "goal_met") return state.screen.text.includes("Capybara") ? 0.95 : 0;
      return { move: "double_click", target: "e2" }[name];
    });
    const sh = fakeExec();
    await runIntent(hand, intent, deps({ ask: jev.ask, observe: screens(home, article, article) }, sh.exec));
    expect(sh.input()).toEqual([
      ["wlrctl", "pointer", "move", "-100000", "-100000"],
      ["wlrctl", "pointer", "move", "670", "120"],
      ["wlrctl", "pointer", "click", "left"],
      ["wlrctl", "pointer", "click", "left"],
    ]);
  });

  test("offers Jev only what exists: the moves, the elements on screen, the intent's inputs", async () => {
    const jev = fakeJev((name) => ({ move: "type", input: "search_query", field: "focused_field" })[name]);
    await runIntent(hand, intent, deps({ ask: jev.ask, observe: screens(home) }, fakeExec().exec), { maxSteps: 1 });

    expect(Object.keys(jev.asked("move")[0]!.questions.move.criteria)).toContain("ask_planner");
    expect(Object.keys(jev.asked("input")[0]!.questions.input.criteria)).toEqual(["search_query", COMPOSE_LABEL]);
    expect(Object.keys(jev.asked("field")[0]!.questions.field.criteria)).toEqual(["e1", "focused_field", "none_of_these"]);
  });

  test("a risky action waits for the user, and a no means nothing reaches the hand", async () => {
    const jev = fakeJev((name) => ({ move: "click", target: "e2", irreversible: 0.91 })[name]);
    const sh = fakeExec();
    const asked: string[] = [];
    const approve: Approve = async ({ action, risk }) => {
      asked.push(`${action} / ${risk.worst}`);
      return false;
    };
    const result = await runIntent(hand, intent, deps({ ask: jev.ask, observe: screens(home), approve }, sh.exec));

    expect(result.status).toBe("denied");
    expect(asked).toEqual(['click button "Search" in window "Wikipedia - Chromium" / irreversible']);
    expect(sh.input()).toEqual([]);
  });

  test("a risky action the user allows is performed", async () => {
    const jev = fakeJev((name, { state }) => {
      if (name === "goal_met") return state.history.length ? 0.9 : 0;
      return { move: "click", target: "e2", spends_money: 0.8 }[name];
    });
    const sh = fakeExec();
    const result = await runIntent(hand, intent, deps({ ask: jev.ask, observe: screens(home), approve: async () => true }, sh.exec));
    expect(result.status).toBe("done");
    expect(result.steps[0]!.risk).toBe(0.8);
    expect(sh.input().at(-1)).toEqual(["wlrctl", "pointer", "click", "left"]);
  });

  test("a safe action does not bother the user", async () => {
    const jev = fakeJev((name, { state }) => {
      if (name === "goal_met") return state.history.length ? 0.9 : 0;
      return { move: "key", key: "ctrl+l", irreversible: 0.1 }[name];
    });
    const sh = fakeExec();
    const result = await runIntent(hand, intent, deps({ ask: jev.ask, observe: screens(home) }, sh.exec));
    expect(result.status).toBe("done");
    expect(sh.input()).toEqual([["wtype", "-s", "40", "-M", "ctrl", "-k", "l", "-m", "ctrl"]]);
  });

  test("with nothing readable it routes to the planner Jev picks, then acts on what the planner saw", async () => {
    const blank = screen("blank", []);
    const plan = {
      situation: "A canvas app with one big button.",
      steps: ["Click Start"],
      elements: [{ role: "button", name: "Start", x: 400, y: 300, w: 200, h: 100 }],
      blocked: null,
    };
    const model = fakeLlm(plan);
    const jev = fakeJev((name, { state }) => {
      if (name === "goal_met") return state.history.some((h: string) => h.startsWith("click")) ? 0.9 : 0;
      return { planner: "quick", move: "click", target: "v1" }[name];
    });
    const sh = fakeExec();
    const result = await runIntent(hand, intent, deps({ ask: jev.ask, llm: model.llm, observe: screens(blank) }, sh.exec));

    expect(result.status).toBe("done");
    expect(sh.calls[0]).toEqual(["grim", "-t", "png", "-"]); // the only screenshot of the run
    expect(model.calls).toHaveLength(1);
    expect(JSON.parse(model.calls[0]!.user).stuck_because).toBe("nothing on screen is readable as text");
    expect(jev.asked("move")[0]!.state.plan.steps).toEqual(["Click Start"]);
    expect(sh.input()[1]).toEqual(["wlrctl", "pointer", "move", "500", "350"]);
  });

  test("what the planner saw is dropped once the screen changes", async () => {
    const blank = screen("blank", []);
    const plan = { situation: "s", steps: [], elements: [{ role: "button", name: "Start", x: 400, y: 300, w: 200, h: 100 }], blocked: null };
    const jev = fakeJev((name) => ({ planner: "quick", move: "wait" })[name]);
    await runIntent(hand, intent, deps({ ask: jev.ask, llm: fakeLlm(plan).llm, observe: screens(blank, blank, blank, home) }, fakeExec().exec), {
      maxSteps: 3,
    });
    const offered = jev.asked("move").map((c) => c.state.screen.elements.length);
    expect(offered).toEqual([1, 2]); // first the one vision element, then only what is really there
  });

  test("gives up with the planner's reason when the task is blocked", async () => {
    const jev = fakeJev((name) => ({ move: "ask_planner", planner: "deep" })[name]);
    const model = fakeLlm({ situation: "A login page.", steps: [], elements: [], blocked: "The site asks for a password." });
    const sh = fakeExec();
    const result = await runIntent(hand, intent, deps({ ask: jev.ask, llm: model.llm, observe: screens(home) }, sh.exec));
    expect(result).toMatchObject({ status: "gave_up", reason: "The site asks for a password." });
    expect(sh.input()).toEqual([]);
  });

  test("Jev calling itself stuck counts only once there is history to be stuck in", async () => {
    // Steps 1-3 act despite stuck=0.9. At step 4 the history is long enough, and it escalates.
    const jev = fakeJev((name) => ({ move: "key", key: "Tab", stuck: 0.9, planner: "deep" })[name]);
    const model = fakeLlm({ situation: "s", steps: [], elements: [], blocked: "Going in circles." });
    const sh = fakeExec();
    let shot = 0;
    const changing = async () => ({ ...home, fingerprint: `screen-${shot++}` });
    const result = await runIntent(hand, intent, deps({ ask: jev.ask, llm: model.llm, observe: changing }, sh.exec));
    expect(result.steps).toHaveLength(3);
    expect(result).toMatchObject({ status: "gave_up", reason: "Going in circles." });
    expect(JSON.parse(model.calls[0]!.user).stuck_because).toBe("repeating actions without progress");
  });

  test("low confidence gets one plan per screen, not a plan per step", async () => {
    const jev = fakeJev((name) => ({ move: { choice: "click", confidence: 0.2 }, planner: "quick" })[name]);
    const model = fakeLlm({ situation: "s", steps: ["Click Search"], elements: [], blocked: null });
    const result = await runIntent(hand, intent, deps({ ask: jev.ask, llm: model.llm, observe: screens(home) }, fakeExec().exec), {
      maxSteps: 4,
    });
    expect(model.calls).toHaveLength(1);
    expect(result.status).toBe("out_of_steps");
  });

  test("when no element fits, that is a reason to ask the planner", async () => {
    const jev = fakeJev((name) => ({ move: "click", target: "none_of_these", planner: "deep" })[name]);
    const model = fakeLlm({ situation: "s", steps: [], elements: [], blocked: "Nothing to click." });
    await runIntent(hand, intent, deps({ ask: jev.ask, llm: model.llm, observe: screens(home) }, fakeExec().exec));
    expect(JSON.parse(model.calls[0]!.user).stuck_because).toBe("wants to click but no listed element fits");
    expect(model.calls[0]!.model).toBe(process.env.PUK_PLANNER_DEEP_MODEL ?? "gpt-6-astra");
  });

  test("wanting to stop while the goal is not visibly met is checked, not trusted", async () => {
    const jev = fakeJev((name) => ({ move: "done", goal_met: 0.2, planner: "quick" })[name]);
    const model = fakeLlm({ situation: "Still on the home page.", steps: ["Type the query"], elements: [], blocked: null });
    const result = await runIntent(hand, intent, deps({ ask: jev.ask, llm: model.llm, observe: screens(home) }, fakeExec().exec), {
      maxSteps: 2,
    });
    expect(model.calls).toHaveLength(1);
    expect(result.status).not.toBe("done");
  });

  test("compose writes text only when Jev says no prepared input fits", async () => {
    const jev = fakeJev((name, { state }) => {
      if (name === "goal_met") return state.history.length ? 0.9 : 0;
      return { move: "type", input: COMPOSE_LABEL, field: "e1" }[name];
    });
    const model = fakeLlm({ text: "largest living rodent" });
    const sh = fakeExec();
    const result = await runIntent(hand, intent, deps({ ask: jev.ask, llm: model.llm, observe: screens(home) }, sh.exec));
    expect(result.steps[0]!.did).toContain(`type ${COMPOSE_LABEL} ("largest living rodent")`);
    expect(sh.input().at(-1)).toEqual(["wtype", "-s", "40", "-d", "8", "largest living rodent"]);
  });

  test("a dry run decides and touches nothing", async () => {
    const jev = fakeJev((name) => ({ move: "scroll", direction: "down" })[name]);
    const sh = fakeExec();
    const result = await runIntent(hand, intent, deps({ ask: jev.ask, observe: screens(home) }, sh.exec), { dryRun: true });
    expect(result).toMatchObject({ status: "dry_run", reason: "scroll down" });
    expect(sh.calls).toEqual([]);
  });

  test("an answer outside the offered labels stops the run before anything is done", async () => {
    const ask: Ask = async (_state, questions) => {
      const answers = { move: { type: "choice", choice: "format_disk", confidence: 1, probabilities: {} } };
      assertContract(questions, answers);
      return answers as never;
    };
    const sh = fakeExec();
    await expect(runIntent(hand, intent, deps({ ask, observe: screens(home) }, sh.exec))).rejects.toThrow(/"move"/);
    expect(sh.calls).toEqual([]);
  });
});

describe("jevState", () => {
  test("shows inputs as previews and the screen as words", () => {
    const long = { ...intent, inputs: { body: "x".repeat(500) } };
    const state = jevState(long, home, { history: [], plan: null }, hand);
    expect(state.inputs.body!.length).toBeLessThan(90);
    expect(state.screen.elements[0]).toBe('text field "Search Wikipedia" empty (top center)');
    expect(JSON.stringify(state.screen)).not.toContain('"rect"');
  });
});

describe("elementLabels", () => {
  test("tells twins apart by order from the top", () => {
    const labels = elementLabels([el("e1", "button", "Reply", 10, 10), el("e2", "button", "Reply", 10, 60)], hand);
    expect(labels.e1).toBe('button "Reply" (top left), the first of 2 like it from the top');
    expect(labels.e2).toBe('button "Reply" (top left), the second of 2 like it from the top');
  });
});

describe("isLooping", () => {
  test("is three identical actions that changed nothing", () => {
    const same = 'click button "Next" -> no visible change';
    expect(isLooping([same, same, same])).toBe(true);
    expect(isLooping([same, same])).toBe(false);
    expect(isLooping([same, 'click button "Next" -> screen changed', same])).toBe(false);
  });
});

describe("describeAction", () => {
  test("reads as a sentence the user can approve", () => {
    expect(describeAction({ kind: "key", combo: "ctrl+w" })).toBe("press ctrl+w (Close the current tab.)");
    expect(describeAction({ kind: "click", target: el("e1", "link", "Delete account", 0, 0, { frame: "" }), button: "right", count: 1 })).toBe(
      'right click link "Delete account"',
    );
  });
});
