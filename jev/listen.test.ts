import { describe, expect, test } from "bun:test";
import type { Hand } from "../desktop";
import type { RunResult } from "./cua";
import type { Intent } from "./intent";
import { assertContract, type Ask } from "./jev";
import { createListener, type Job, type ListenDeps } from "./listen";
import type { Llm, LlmRequest } from "./openai";

const hands: Hand[] = [1, 2].map((id) => ({ id, pid: id, display: `wayland-${id}`, width: 1280, height: 800 }));

type Reply = string | number | { choice: string; confidence: number };

/**
 * A scripted Jev for both listen.ts (relation, startable, route) and quick.ts
 * (launcher, site, text). `reply` sees the state, so a script can react to the words.
 */
function fakeJev(reply: (name: string, state: any) => Reply | undefined) {
  const calls: { state: any; questions: Record<string, any> }[] = [];
  const ask: Ask = async (state, questions) => {
    calls.push({ state, questions });
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(questions)) {
      const r = reply(name, state) ?? (name === "cut" ? "none" : undefined);
      if (q.type === "noul") answers[name] = { type: "noul", noul: typeof r === "number" ? r : 0 };
      else answers[name] = { type: "choice", probabilities: {}, ...(typeof r === "object" ? r : { choice: String(r), confidence: 0.9 }) };
    }
    assertContract(questions, answers);
    return answers as never;
  };
  return { ask, calls, triage: () => calls.filter((c) => "relation" in c.questions) };
}

/** Hands that never finish by themselves: the test ends each job. */
function fakeWork() {
  const jobs: { hand: number; job: Job; end: (status?: RunResult["status"]) => void }[] = [];
  const work: ListenDeps["work"] = (hand, job) => {
    const { promise, resolve } = Promise.withResolvers<RunResult>();
    const end = (status: RunResult["status"] = "done") => resolve({ status, reason: status, steps: [] });
    job.signal.addEventListener("abort", () => end("cancelled"));
    jobs.push({ hand: hand.id, job, end });
    return promise;
  };
  return { work, jobs };
}

function fakeLlm(reply: (req: LlmRequest) => unknown) {
  const calls: LlmRequest[] = [];
  const llm: Llm = async (req) => {
    calls.push(req);
    return reply(req);
  };
  return { llm, calls };
}

const noLlm: Llm = async () => {
  throw new Error("no LLM call expected");
};

const emailIntent = (over: Record<string, unknown> = {}) => ({
  goal: "Email sam that I am late.",
  launcher: "browser",
  url: "https://mail.google.com/",
  inputs: [{ name: "body", value: "I am running late." }],
  done_when: "Message sent.",
  avoid: [],
  ...over,
});

/** Let the listener finish the pass it is on. */
const settle = () => Bun.sleep(2);

/** quick.ts answers for a Wikipedia search whose term is the last word, once it has been said. */
const wikipedia = (name: string, state: any): Reply | undefined => {
  const words: string[] = (state.request ?? "").split(" ");
  const term = words.at(-1)!;
  return { launcher: "browser", site: "wikipedia", text: words.length > 3 ? term : "nothing_to_type" }[name];
};

function listener(over: Partial<ListenDeps> & Pick<ListenDeps, "ask">) {
  const w = fakeWork();
  const logs: string[] = [];
  const l = createListener({ llm: noLlm, hands: async () => hands, work: w.work, log: (s) => logs.push(s), ...over });
  return { l, jobs: w.jobs, logs };
}

describe("createListener", () => {
  test("a hand starts before the sentence is over, and its intent is refined in place", async () => {
    const jev = fakeJev((name, state) => {
      if (name === "relation") return state.tasks.length ? "refines" : "new_task";
      if (name === "startable") return state.new_words.includes("wikipedia") ? 0.8 : 0.1;
      if (name === "route") return "jev";
      return wikipedia(name, state);
    });
    const { l, jobs } = listener({ ask: jev.ask });

    l.hear("search");
    await settle();
    expect(jobs).toHaveLength(0); // "search" alone says nothing about what to open

    l.hear("search wikipedia for");
    await settle();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job.intent()).toMatchObject({ url: "https://www.wikipedia.org/", inputs: {} });
    expect(jobs[0]!.job.speechEnds()).toBeInstanceOf(Promise); // still talking: the hand must not type yet

    l.hear("search wikipedia for capybaras");
    await l.finish();
    expect(jobs).toHaveLength(1); // same hand, same run
    expect(jobs[0]!.job.intent()).toMatchObject({ goal: "search wikipedia for capybaras", inputs: { search_query: "capybaras" } });
    expect(jobs[0]!.job.speechEnds()).toBeNull();
  });

  test("words that ask for nothing are kept, and become part of the request that follows", async () => {
    const jev = fakeJev((name, state) => {
      if (name === "relation") return state.new_words.includes("wikipedia") ? "new_task" : "no_request";
      if (name === "startable") return 0.9;
      if (name === "route") return "jev";
      return { launcher: "browser", site: "wikipedia", text: "nothing_to_type" }[name];
    });
    const { l, jobs } = listener({ ask: jev.ask });
    l.hear("um okay");
    await settle();
    l.hear("um okay open wikipedia");
    await l.finish();
    expect(l.tasks.map((t) => t.request)).toEqual(["um okay open wikipedia"]);
    expect(jobs).toHaveLength(1);
  });

  test("an unclear request still starts once the speaker has finished", async () => {
    const jev = fakeJev((name) => ({ relation: "new_task", startable: 0.2, route: "jev", launcher: "files", site: "no_site", text: "nothing_to_type" })[name]);
    const { l, jobs } = listener({ ask: jev.ask });
    l.hear("find that thing");
    await settle();
    expect(jobs).toHaveLength(0);
    await l.finish();
    expect(jobs).toHaveLength(1);
  });

  test("never mind stops the hand, and the hand is free again only once its loop has stopped", async () => {
    const jev = fakeJev((name, state) => {
      if (name === "relation") return state.new_words.includes("never") ? "retracts" : state.tasks.length ? "new_task" : "new_task";
      if (name === "startable") return 0.9;
      if (name === "route") return "jev";
      return { launcher: "browser", site: "google", text: "nothing_to_type" }[name];
    });
    const w = fakeWork();
    // A hand whose loop takes a moment to notice the abort.
    const slow: ListenDeps["work"] = (hand, job) => {
      const { promise, resolve } = Promise.withResolvers<RunResult>();
      job.signal.addEventListener("abort", () => setTimeout(() => resolve({ status: "cancelled", reason: "x", steps: [] }), 20));
      w.jobs.push({ hand: hand.id, job, end: () => resolve({ status: "done", reason: "x", steps: [] }) });
      return promise;
    };
    const l = createListener({ ask: jev.ask, llm: noLlm, hands: async () => [hands[0]!], work: slow });

    l.hear("open google");
    await settle();
    l.hear("open google never mind");
    await settle();
    expect(w.jobs[0]!.job.signal.aborted).toBe(true);
    expect(l.tasks[0]!.status).toBe("cancelled");

    l.hear("open google never mind open google maps");
    await settle();
    expect(l.tasks[1]!.status).toBe("waiting"); // hand 1 is still winding down
    await Bun.sleep(40);
    expect(l.tasks[1]!).toMatchObject({ status: "running", hand: 1 });
  });

  test("two requests in one breath go to two hands, and a third waits for one to finish", async () => {
    const asked = ["youtube", "weather", "news"];
    const jev = fakeJev((name, state) => {
      if (name === "relation") return asked.some((w) => state.new_words.includes(w)) ? "new_task" : "no_request";
      if (name === "startable") return 0.9;
      if (name === "route") return "jev";
      return { launcher: "browser", site: "google", text: "nothing_to_type" }[name];
    });
    const { l, jobs } = listener({ ask: jev.ask });
    for (const said of ["open youtube", "open youtube and the weather", "open youtube and the weather and the news"]) {
      l.hear(said);
      await settle();
    }
    await l.finish();
    expect(l.tasks.map((t) => [t.request, t.status, t.hand])).toEqual([
      ["open youtube", "running", 1],
      ["and the weather", "running", 2],
      ["and the news", "waiting", null],
    ]);

    jobs[0]!.end();
    await settle();
    expect(l.tasks[2]).toMatchObject({ status: "running", hand: 1 }); // took the hand that came free

    for (const j of jobs) j.end();
    await l.idle();
    expect(l.tasks.map((t) => t.status)).toEqual(["done", "done", "done"]);
  });

  test("a waiting task gets the hand that frees up, and Jev is shown finished tasks as done", async () => {
    const jev = fakeJev((name, state) => {
      if (name === "relation") return state.new_words.match(/youtube|weather|news/) ? "new_task" : "no_request";
      return { startable: 0.9, route: "jev", launcher: "browser", site: "google", text: "nothing_to_type" }[name];
    });
    const { l, jobs } = listener({ ask: jev.ask, hands: async () => [hands[0]!] });
    l.hear("open youtube");
    await settle();
    l.hear("open youtube and the weather");
    await settle();
    expect(l.tasks.map((t) => t.status)).toEqual(["running", "waiting"]);

    jobs[0]!.end("done");
    await settle();
    expect(l.tasks.map((t) => [t.status, t.hand])).toEqual([["done", 1], ["running", 1]]);

    l.hear("open youtube and the weather and the news");
    await settle();
    expect(jev.triage().at(-1)!.state.tasks).toEqual([
      { request: "open youtube", status: "done" },
      { request: "and the weather", status: "running" },
    ]);
  });

  test("a task for the LLM opens with Jev at once, and gets its real intent once, when the sentence has stopped", async () => {
    const jev = fakeJev((name, state) => {
      if (name === "relation") return state.tasks.length ? "refines" : "new_task";
      return { startable: 0.9, route: "llm", launcher: "browser", site: "gmail", text: "nothing_to_type" }[name];
    });
    const model = fakeLlm(() => emailIntent({ url: "null" })); // the LLM knows what to write, not where
    const { l, jobs } = listener({ ask: jev.ask, llm: model.llm });

    l.hear("email sam");
    await settle();
    l.hear("email sam that I am");
    await settle();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job.intent().url).toBe("https://mail.google.com/"); // Jev's opening move
    expect(model.calls).toHaveLength(0); // no LLM while the sentence is still moving

    l.hear("email sam that I am running late");
    await l.finish();
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.user).toBe("email sam that I am running late");
    expect(jobs).toHaveLength(1); // same site, so amended in place, not restarted
    expect(jobs[0]!.job.intent()).toMatchObject({ url: "https://mail.google.com/", inputs: { body: "I am running late." } });
  });

  test("if the final intent cannot be built, the task is cancelled rather than run on a fragment", async () => {
    const jev = fakeJev((name) => ({ relation: "new_task", startable: 0.9, route: "llm", launcher: "browser", site: "gmail", text: "nothing_to_type" })[name]);
    const model = fakeLlm(() => {
      throw new Error("OpenAI is down");
    });
    const { l, jobs, logs } = listener({ ask: jev.ask, llm: model.llm });
    l.hear("email sam that");
    await settle();
    expect(jobs).toHaveLength(1);
    await l.finish();
    expect(model.calls).toHaveLength(2); // one retry
    expect(jobs[0]!.job.signal.aborted).toBe(true);
    expect(logs.join("\n")).toContain("could not work out what was finally asked");
  });

  test("a change of site restarts the task on the same hand", async () => {
    const jev = fakeJev((name, state) => {
      if (name === "relation") return state.tasks.length ? "refines" : "new_task";
      if (name === "site") return state.request.includes("google") ? "google" : "wikipedia";
      return { startable: 0.9, route: "jev", launcher: "browser", text: "nothing_to_type" }[name];
    });
    const { l, jobs } = listener({ ask: jev.ask });
    l.hear("search wikipedia");
    await settle();
    l.hear("search wikipedia no google");
    await l.finish();
    expect(jobs.map((j) => [j.hand, j.job.signal.aborted])).toEqual([[1, true], [1, false]]);
    expect(jobs[1]!.job.intent().url).toBe("https://www.google.com/");
    expect(l.tasks).toHaveLength(1);
  });

  test("while the speaker is talking, an unsure reading does not touch a running task", async () => {
    const jev = fakeJev((name, state) => {
      if (name === "relation") return state.tasks.length ? { choice: "retracts", confidence: 0.3 } : "new_task";
      return { startable: 0.9, route: "jev", launcher: "browser", site: "google", text: "nothing_to_type" }[name];
    });
    const { l, jobs } = listener({ ask: jev.ask });
    l.hear("open google");
    await settle();
    l.hear("open google hmm");
    await settle();
    expect(jobs[0]!.job.signal.aborted).toBe(false);
    expect(l.tasks[0]!.status).toBe("running");
  });

  test("a failed pass is reported once and the next word is still heard", async () => {
    let fail = true;
    const jev = fakeJev((name) => ({ relation: "new_task", startable: 0.9, route: "jev", launcher: "browser", site: "google", text: "nothing_to_type" })[name]);
    let failures = 0;
    const flaky: Ask = async (state, questions) => {
      if (fail) throw new Error(`TypeSafe 529 (${++failures})`);
      return jev.ask(state, questions);
    };
    const { l, jobs, logs } = listener({ ask: flaky });
    l.hear("open");
    l.hear("open goo");
    l.hear("open goog");
    await settle();
    expect(failures).toBe(2); // "open", then the newest of what arrived meanwhile
    expect(logs.filter((s) => s.includes("TypeSafe 529"))).toHaveLength(failures); // once per failure, not once per caller
    fail = false;
    l.hear("open google");
    await l.finish();
    expect(jobs).toHaveLength(1);
  });

  test("words that arrive during a pass are taken together: the newest transcript wins", async () => {
    const jev = fakeJev((name) => ({ relation: "no_request", startable: 0, route: "jev" })[name]);
    const { l } = listener({ ask: jev.ask });
    for (const said of ["a", "a b", "a b c", "a b c d"]) l.hear(said);
    await l.finish();
    // "a b" and "a b c" were never sent, and the newest words and the end of speech share one pass.
    expect(jev.triage().map((c) => [c.state.transcript, c.state.speaker_has_finished])).toEqual([
      ["a", false],
      ["a b c d", true],
    ]);
  });

  test("a second utterance starts from a clean transcript but knows the earlier tasks", async () => {
    const jev = fakeJev((name) => ({ relation: "new_task", startable: 0.9, route: "jev", launcher: "browser", site: "google", text: "nothing_to_type" })[name]);
    const { l } = listener({ ask: jev.ask });
    l.hear("open google");
    await l.finish();
    l.hear("open maps");
    await l.finish();
    expect(l.tasks.map((t) => [t.request, t.startWord])).toEqual([["open google", 0], ["open maps", 0]]);
    expect(jev.triage().at(-1)!.state.tasks).toHaveLength(1);
  });

  test("idle returns, and says so, when a task can never get a hand", async () => {
    const jev = fakeJev((name) => ({ relation: "new_task", startable: 0.9, route: "jev", launcher: "browser", site: "google", text: "nothing_to_type" })[name]);
    const { l, logs } = listener({ ask: jev.ask, hands: async () => [] });
    l.hear("open google");
    await l.finish();
    await l.idle();
    expect(logs.join("\n")).toContain("never got a hand");
  });

  test("warm opens the connection and never throws", async () => {
    const down: Ask = async () => {
      throw new Error("offline");
    };
    const { l } = listener({ ask: down });
    expect(() => l.warm()).not.toThrow();
    await settle();
  });
});

describe("listener integration races", () => {
  const literal = (goal: string): Intent => ({ goal, launcher: "none", url: null, inputs: {}, doneWhen: "done", avoid: [] });

  test("cancellation appended without spaces is heard before the worker is released", async () => {
    const jev = fakeJev((name, state) => ({ relation: state.new_words?.includes("不要") ? "retracts" : "new_task", startable: 0.99, route: "jev" })[name]);
    const { l, jobs } = listener({ ask: jev.ask, buildIntent: literal });
    l.hear("打开笔记");
    await settle();
    expect(jobs).toHaveLength(1);
    await l.finish("打开笔记，不，先不要打开");
    await l.idle();
    expect(jev.triage().at(-1)!.state.new_words).toBe("，不，先不要打开");
    expect(l.tasks[0]!.status).toBe("cancelled");
    expect(jobs[0]!.job.signal.aborted).toBe(true);
  });

  test("text that completes a word refines the intent even without a new space", async () => {
    const jev = fakeJev((name, state) => ({ relation: state.tasks?.length ? "refines" : "new_task", startable: 0.99, route: "jev" })[name]);
    const { l, jobs } = listener({ ask: jev.ask, buildIntent: literal });
    l.hear("Search for capy");
    await settle();
    await l.finish("Search for capybaras");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job.intent().goal).toBe("Search for capybaras");
    jobs[0]!.end();
    await l.idle();
  });

  test("Stop during intent building prevents the late build from reserving a hand", async () => {
    const built = Promise.withResolvers<Intent>();
    let building = false;
    const jev = fakeJev((name) => ({ relation: "new_task", startable: 0.99, route: "jev" })[name]);
    const { l, jobs } = listener({ ask: jev.ask, buildIntent: () => { building = true; return built.promise; } });
    l.hear("Open notes");
    await settle();
    expect(building).toBe(true);
    l.cancel();
    built.resolve(literal("Open notes"));
    await settle();
    await l.finish();
    expect(jobs).toHaveLength(0);
    expect(l.tasks).toHaveLength(0);
  });

  test("new creation and worker completion cannot reserve the same hand", async () => {
    const jev = fakeJev((name) => ({ relation: "new_task", startable: 0.99, route: "jev" })[name]);
    const available = Promise.withResolvers<Hand[]>();
    let listings = 0;
    const { l, jobs } = listener({ ask: jev.ask, buildIntent: literal, hands: async () => ++listings === 1 ? [hands[0]!] : available.promise });
    l.hear("Open notes");
    await settle();
    expect(jobs).toHaveLength(1);
    l.hear("Open notes and open files");
    await settle();
    jobs[0]!.end();
    available.resolve([hands[0]!]);
    await l.finish();
    expect(jobs).toHaveLength(2);
    expect(l.tasks.map((t) => t.status)).toEqual(["done", "running"]);
    jobs[1]!.end();
    await l.idle();
  });
});

describe("Jev task cut points", () => {
  const buildIntent: NonNullable<ListenDeps["buildIntent"]> = (goal) => ({ goal, launcher: "none", url: null, inputs: {}, doneWhen: "Done", avoid: [] });
  async function until(check: () => boolean) {
    for (let i = 0; !check() && i < 100; i++) await Bun.sleep(5);
    expect(check()).toBe(true);
  }
  test("two independent requests in one STT delta reserve different hands before release", async () => {
    const jev = fakeJev((name, state) => name === "relation" ? "new_task" : name === "route" ? "llm" : name === "startable" ? 1 : name === "cut" && state.new_words.startsWith("Open notes.") ? "cut_0" : undefined);
    const { l, jobs } = listener({ ask: jev.ask, buildIntent });
    l.hear("Open notes. Also find a capybara photo in the browser.");
    await until(() => jobs.length === 2);
    expect(jobs.map((j) => j.hand)).toEqual([1, 2]);
    expect(jobs.map((j) => j.job.intent().goal)).toEqual(["Open notes", ". Also find a capybara photo in the browser."]);
    expect(jobs.every((j) => j.job.speechEnds())).toBe(true);
    await l.finish(); jobs.forEach((j) => j.end()); await l.idle();
  });
  test("a connector alone is never offered as a task to split off", async () => {
    const jev = fakeJev((name) => name === "relation" ? "new_task" : name === "route" ? "jev" : name === "startable" ? 1 : undefined);
    const { l, jobs } = listener({ ask: jev.ask, buildIntent });
    l.hear("Open notes"); await until(() => jobs.length === 1);
    l.hear("Open notes and separately open calculator"); await until(() => jobs.length === 2);
    expect(jev.triage().at(-1)!.questions).not.toHaveProperty("cut");
    expect(jobs[1]!.job.intent().goal).toBe("and separately open calculator");
    await l.finish(); jobs.forEach((j) => j.end()); await l.idle();
  });
  test("Jev can keep dependent steps together and notify the worker of refinements", async () => {
    const jev = fakeJev((name, state) => name === "relation" ? state.tasks.length ? "refines" : "new_task" : name === "route" ? "llm" : name === "startable" ? 1 : undefined);
    const { l, jobs } = listener({ ask: jev.ask, buildIntent });
    l.hear("Open notes and write a plan"); await until(() => jobs.length === 1);
    const updates: string[] = [];
    const unsubscribe = jobs[0]!.job.onUpdate!((intent) => updates.push(intent.goal));
    l.hear("Open notes and write a plan for tomorrow"); await until(() => updates.length === 1);
    expect(updates[0]).toContain("for tomorrow"); expect(jobs).toHaveLength(1);
    await l.finish(); expect(updates).toHaveLength(2);
    unsubscribe(); jobs[0]!.end(); await l.idle();
  });
});
