// Jev coordinates live speech: new tasks, refinements, retractions, and optional
// cut points when STT delivers several requests in one delta. One independent
// question batch classifies each newest transcript; stale replies are discarded.
//
// Each free hand starts a cancellable worker immediately. Other tasks queue.
// Job.onUpdate steers a running worker; finish validates the final utterance
// before releasing held consequential actions. Pi is the app's worker. The
// default handWork adapter retains Chi's standalone quick/intent/CUA experiment.
//
// CLI: bun jev/listen.ts say [--wps=3] [--dry] <sentence...>
//      bun jev/listen.ts stdin [--dry]

import { listHands, type Hand } from "../desktop";
import type { Deps, RunResult } from "./cua";
import type { Intent } from "./intent";
import { choice, createJev, noul, type Ask } from "./jev";
import type { Llm } from "./openai";

// ---------------------------------------------------------------- types

export type TaskStatus = "waiting" | "running" | "done" | "failed" | "cancelled";

export type Task = {
  id: number;
  /** The words this task was built from. Grows while the speaker refines it. */
  request: string;
  /** Index of the task's first word in the transcript. */
  startWord: number;
  /** Who built the intent. */
  route: "jev" | "llm";
  intent: Intent;
  status: TaskStatus;
  hand: number | null;
  result: RunResult | null;
};

/** What a hand is given to work on. `intent` is read again at every step. */
export type Job = {
  intent: () => Intent;
  signal: AbortSignal;
  /** This task's spoken context; another independent utterance cannot replace it. */
  transcript: () => string;
  /** A promise while the speaker is still talking, null once they have finished. */
  speechEnds: () => Promise<void> | null;
  /** Notify a running worker when Jev refines this task. */
  onUpdate?: (listener: (intent: Intent) => void) => () => void;
};
export type Work = (hand: Hand, job: Job) => Promise<RunResult>;

export type ListenDeps = {
  ask: Ask;
  llm?: Llm;
  /** An existing agent can own planning; it need not pay for a second intent LLM. */
  buildIntent?: (request: string, route: "jev" | "llm", final: boolean) => Intent | Promise<Intent>;
  hands: () => Promise<Hand[]>;
  /** Work started outside this listener can also own a hand. */
  unavailable?: (hand: Hand) => boolean;
  work: Work;
  log?: (line: string) => void;
};

export type Listener = {
  /** Call when the hotkey goes down. Opens the connection to Jev, so the first word is not a cold start (about 1 s). */
  warm(): void;
  /** The whole transcript so far. Call on every partial result. Returns at once. */
  hear(transcript: string): void;
  /** The speaker has finished. An optional final STT result replaces the partial atomically. */
  finish(transcript?: string): Promise<void>;
  /** Discard only this recording, leaving earlier independent work running. */
  cancelUtterance(): void;
  /** Retry queued work after an external worker releases a hand. */
  schedule(): Promise<void>;
  /** Stop this listener and its queued/running tasks. Late replies are discarded. */
  cancel(): void;
  /** Resolves when no task is waiting or running. */
  idle(): Promise<void>;
  readonly tasks: readonly Task[];
};

type Live = Task & {
  /** Character offsets also work when speech does not contain spaces. */
  startChar: number;
  abort: AbortController;
  run: number;
  settled: Promise<void>;
  stale: boolean;
  /** A loop is on the hand. Outlives `status` briefly when a task is taken back mid-step. */
  working: boolean;
  superseded: boolean;
  listeners: Set<(intent: Intent) => void>;
  utterance: Utterance;
  requestPrefix: string;
  contextPrefix: string;
};

type Utterance = { text: string; speaking: boolean; ended: ReturnType<typeof Promise.withResolvers<void>>; abort: AbortController };
const newUtterance = (): Utterance => ({ text: "", speaking: false, ended: Promise.withResolvers<void>(), abort: new AbortController() });

// ---------------------------------------------------------------- config

/** `startable` at or above this starts a hand before the sentence is over. */
const START_THRESHOLD = 0.6;
/**
 * Below this confidence in `relation`, wait for another word before touching an
 * existing task. Not applied to the final pass, or to the first task: there
 * `startable` is the gate. Real Jev said new_task 0.49, startable 0.75 at
 * "search wikipedia for", which is exactly when a hand should start.
 */
const MIN_RELATION_CONFIDENCE = 0.5;
/** While the intent is still partial, less is needed for the gate to hold an action. */
export const SPEAKING_RISK_THRESHOLD = 0.25;

const QUESTIONS = {
  relation: choice(
    "How does the FIRST request in new_words relate to the existing tasks? Consider the first request if several arrived together. Opening an app followed by saying what to do in that app is one continuing task: opening notes then drafting, or opening a browser then searching/viewing something.",
    {
      no_request:
        "`new_words` ask for nothing: filler, a greeting, thinking aloud, or the first words of a sentence that does not yet say what to do.",
      covered: "`new_words` only repeat what a task in `tasks` already says.",
      refines:
        "The new words continue or correct the latest task: finish its sentence, add a detail, or add a step using that task's app or output.",
      new_task: "The new words ask for a separate, independent job with its own target and purpose. Another desktop could work on it in parallel.",
      retracts: "`new_words` take the latest task back: never mind, stop, cancel that, do not do it.",
    },
  ),
  startable: noul("Enough of the FIRST request in new_words has been said to start working: it is clear what to open first, even if details are still to come.", {
    true: "For example 'search wikipedia for': Wikipedia can be opened already. 'email sam': the mail site can be opened already. 'find my tax': the file manager can be opened already.",
    false: "For example 'can you please', 'I need to' or 'search for': nothing says what to open yet.",
  }),
  route: choice("Who can work out the FIRST request in new_words?", {
    jev: "A simple request: open a well-known website, an app or a folder, and perhaps type words the speaker said literally, such as a search term.",
    llm: "It needs writing or planning: a message or email to compose, a reply, several steps, or text to type that the speaker did not say word for word.",
  }),
};

/** Candidate boundaries are only options. Jev decides whether the following
 * phrase is independent, or is another step/detail/correction of the same task. */
function cutPoints(text: string, isFinal: boolean) {
  // Streaming STT uses sentence punctuation for pauses and repairs, such as
  // "Open Pay? Paint". Only the final transcript may split on those marks.
  const boundaries = isFinal
    ? /\s+(?:and|also|then|meanwhile|separately|plus)\b|[.!?;,。！？；，]\s*|另外|然后|同时/giu
    : /\s+(?:and|also|then|meanwhile|separately|plus)\b|[;,；，]\s*|另外|然后|同时/giu;
  return [...text.matchAll(boundaries)]
    .map((match) => ({ at: match.index, before: text.slice(0, match.index).trim(), after: text.slice(match.index).trim() }))
    .filter((cut) => {
      const content = cut.before.replace(/\b(?:and|also|then|meanwhile|separately|plus|please)\b|另外|然后|同时/giu, "");
      return /[\p{L}\p{N}]/u.test(content) && /[\p{L}\p{N}]/u.test(cut.after);
    })
    .slice(0, 12).map((cut, i) => ({ id: `cut_${i}`, ...cut }));
}

function hasUnsettledSentence(text: string) {
  // A bare sentence boundary needs final STT confirmation. Explicit connectors
  // can still start independent work before release. Keep the words pending so
  // finish() can split genuine sentences even when no new words arrive then.
  return [...text.matchAll(/[.!?。！？]+\s*([^.!?。！？]*)/gu)].some((match) => {
    const after = match[1]!.trim();
    return /[\p{L}\p{N}]/u.test(after) && !/^(?:(?:and|also|then|meanwhile|separately|plus)\b|另外|然后|同时)/iu.test(after);
  });
}

// ---------------------------------------------------------------- listener

export function createListener(deps: ListenDeps): Listener {
  const log = deps.log ?? (() => {});
  const tasks: Live[] = [];
  const abort = new AbortController();
  const ask: Ask = (state, questions, options) => deps.ask(state, questions, {
    ...options, signal: AbortSignal.any([abort.signal, utterance.abort.signal, ...(options?.signal ? [options.signal] : [])]),
  });

  // One utterance: from the first word to finish().
  let latest = "";
  let finished = false;
  let handled = { text: "", finished: false };
  let consumed = ""; // transcript prefix already turned into a task, or taken back
  let utterance = newUtterance();
  let pump: Promise<void> | null = null;
  let ending: Promise<void> | null = null;
  let scheduling = Promise.resolve();
  let epoch = 0;
  let finalError: Error | null = null;
  const currentPass = (version: number) => !abort.signal.aborted && version === epoch;

  const open = () => tasks.findLast((t) => t.status === "waiting" || t.status === "running");
  const job = (task: Live): Job => ({
    intent: () => task.intent,
    signal: task.abort.signal,
    transcript: () => task.contextPrefix + task.utterance.text,
    speechEnds: () => (task.utterance.speaking ? task.utterance.ended.promise : null),
    onUpdate: (listener) => { task.listeners.add(listener); return () => { task.listeners.delete(listener); }; },
  });

  // ---- hands

  async function freeHand(): Promise<Hand | undefined> {
    const hands = await deps.hands();
    const busy = new Set(tasks.filter((t) => t.working).map((t) => t.hand));
    return hands.find((h) => !busy.has(h.id) && !deps.unavailable?.(h));
  }

  function start(task: Live, hand: Hand) {
    if (abort.signal.aborted || task.abort.signal.aborted || task.status !== "waiting") return;
    const run = ++task.run;
    task.status = "running";
    task.working = true;
    task.hand = hand.id;
    log(`task ${task.id} -> hand ${hand.id}: ${task.intent.goal}`);
    task.settled = Promise.resolve()
      .then(() => deps.work(hand, job(task)))
      .then((result) => {
        if (run !== task.run) return; // restarted since; this result is of the old run
        task.working = false;
        task.result = result;
        if (task.status === "running") task.status = result.status === "done" || result.status === "dry_run" ? "done" : result.status === "cancelled" ? "cancelled" : "failed";
        log(`task ${task.id} ${task.status}: ${result.reason}`);
      })
      .catch((err) => {
        if (run !== task.run) return;
        task.working = false;
        if (task.status === "running") task.status = task.abort.signal.aborted ? "cancelled" : "failed";
        log(`task ${task.id} failed: ${err instanceof Error ? err.message : err}`);
      })
      .then(startWaiting)
      .catch((err) => log(`Could not reserve a hand: ${err instanceof Error ? err.message : err}`));
  }

  function startWaiting(): Promise<void> {
    // Creating a task and finishing a worker can race across the hands() await.
    // Reserve each hand in one queue before starting another worker on it.
    const next = scheduling.then(async () => {
      for (const task of tasks.filter((t) => t.status === "waiting")) {
        if (abort.signal.aborted) return;
        const hand = await freeHand();
        if (!hand) return;
        start(task, hand);
      }
    });
    scheduling = next.catch(() => {}); // A failed lookup must not poison later reservations.
    return next;
  }

  /** Same hand, from the top: what to open changed, so amending in place is not enough. */
  async function restart(task: Live, version: number) {
    const hand = (await deps.hands()).find((h) => h.id === task.hand);
    task.abort.abort();
    task.run++; // the old run's result no longer counts
    await task.settled;
    task.working = false;
    if (!currentPass(version) || task.status !== "running") return;
    task.abort = new AbortController();
    task.status = "waiting";
    if (hand) start(task, hand);
    else await startWaiting();
  }

  // ---- intents

  /** Jev's own intent when it can make one. The LLM when it cannot, or when `full` is asked of an llm task. */
  async function build(request: string, route: "jev" | "llm", full: boolean): Promise<{ intent: Intent; route: "jev" | "llm" }> {
    if (deps.buildIntent) return { intent: await deps.buildIntent(request, route, full), route };
    if (route === "jev" || !full) {
      const { quickIntent } = await import("./quick");
      const quick = await quickIntent(ask, request);
      if (quick) return { intent: quick, route };
    }
    if (!deps.llm) throw new Error("This listener needs an intent builder or an LLM to plan the task.");
    const { parseIntent } = await import("./intent");
    return { intent: await parseIntent(deps.llm, request), route: "llm" };
  }

  async function create(request: string, startWord: number, startChar: number, route: "jev" | "llm", isFinal: boolean, version: number) {
    const built = await build(request, route, isFinal);
    if (!currentPass(version)) return;
    const task: Live = {
      id: tasks.length + 1,
      request,
      startWord,
      startChar,
      ...built,
      status: "waiting",
      hand: null,
      result: null,
      abort: new AbortController(),
      run: 0,
      settled: Promise.resolve(),
      // An llm task that started on Jev's opening move still owes the real intent.
      stale: !deps.buildIntent && built.route === "llm" && !isFinal,
      working: false,
      superseded: false,
      listeners: new Set(),
      utterance,
      requestPrefix: "",
      contextPrefix: "",
    };
    tasks.push(task);
    log(`task ${task.id} (${task.route}): ${JSON.stringify(task.intent.inputs)} ${task.intent.url ?? task.intent.launcher}`);
    await startWaiting();
    if (task.status === "waiting") log(`task ${task.id} is waiting for a free hand`);
  }

  async function refine(task: Live, request: string, isFinal: boolean, version: number) {
    if (task.utterance !== utterance) {
      task.contextPrefix += task.utterance.text + "\n";
      task.requestPrefix = task.request + "\n";
      task.startChar = 0;
      task.utterance = utterance;
    }
    task.request = request;
    // The LLM is slow and the sentence is still moving: rebuild once, when it has stopped.
    if (!deps.buildIntent && task.route === "llm" && !isFinal) return void (task.stale = true);
    const before = task.intent;
    let built: Awaited<ReturnType<typeof build>>;
    try {
      built = await build(request, task.route, isFinal).catch((err) => {
        if (!isFinal || !currentPass(version)) throw err;
        log(`task ${task.id}: building the final intent failed, trying once more: ${err instanceof Error ? err.message : err}`);
        return build(request, task.route, true);
      });
    } catch (err) {
      if (!currentPass(version)) return;
      if (!isFinal) return void (task.stale = true); // the next word, or the end of the sentence, tries again
      // What the task holds is a guess made on a fragment. Better no action than that one.
      task.abort.abort();
      task.status = "failed";
      log(`task ${task.id} cancelled: could not work out what was finally asked (${err instanceof Error ? err.message : err})`);
      return;
    }
    if (!currentPass(version) || task.abort.signal.aborted) return;
    // The LLM knows what to write but sometimes not where to start. Jev's opening move already picked a site.
    if (built.intent.launcher === "browser" && !built.intent.url && before.launcher === "browser") built.intent.url = before.url;
    task.intent = built.intent; // the running loop reads this at its next step
    task.route = built.route;
    task.stale = false;
    log(`task ${task.id} refined (${task.route}): ${JSON.stringify(task.intent.inputs)}`);
    const site = (i: Intent) => (i.url ? new URL(i.url).host : null);
    const moved = before.launcher !== task.intent.launcher || site(before) !== site(task.intent);
    if (moved && task.status === "running") await restart(task, version);
    else for (const listener of task.listeners) listener(task.intent);
  }

  // ---- one pass over the transcript

  async function pass(text: string, isFinal: boolean, version: number) {
    const deferNewTask = !isFinal && hasUnsettledSentence(text);
    let newWords = text.slice(consumed.length).trim();
    const pendingFrom = text.indexOf(newWords, consumed.length);
    const cuts = cutPoints(newWords, isFinal);
    const beforeConsumed = consumed;
    let boundary: number | undefined;
    if (newWords) {
      const answers = await ask(
        {
          transcript: text,
          new_words: newWords,
          speaker_has_finished: isFinal,
          tasks: tasks.filter((t) => !t.superseded).map((t) => ({ request: t.request, status: t.status })),
        },
        {
          ...QUESTIONS,
          ...(cuts.length ? { cut: choice(
            "Does new_words contain MORE THAN ONE independent task that different desktops could work on at once? Choose the earliest offered boundary between them, otherwise none. A later step using the same app, a detail, a correction, quoted content or a dependency is ONE task. For example 'open notes and write a plan' stays together; 'open notes and also find a capybara photo' may split. Do not split a dependent step such as saving what was just written.",
            { none: "Keep these words together as one task.", ...Object.fromEntries(cuts.map((cut) => [cut.id, `Independent tasks: first ${JSON.stringify(cut.before)}, then ${JSON.stringify(cut.after)}.`])) },
          ) } : {}),
        },
      );
      if (!currentPass(version)) return;
      const cut = answers.cut && answers.cut.confidence >= 0.6 ? cuts.find((cut) => cut.id === answers.cut?.choice) : undefined;
      if (cut) {
        boundary = pendingFrom + cut.at;
        text = text.slice(0, boundary).trimEnd();
        newWords = text.slice(consumed.length).trim();
      }
      const relation = answers.relation.choice;
      const sure = isFinal || answers.relation.confidence >= MIN_RELATION_CONFIDENCE;
      const current = open();
      log(
        `heard ${JSON.stringify(newWords)}: ${relation} ${answers.relation.confidence.toFixed(2)}, startable ${answers.startable.noul.toFixed(2)}, route ${answers.route.choice}`,
      );

      const startable = isFinal || answers.startable.noul >= START_THRESHOLD;
      if (relation === "no_request") {
        // keep the words: they may turn out to be the start of a request
      } else if (relation === "new_task" || (relation === "refines" && !current)) {
        if (!deferNewTask && startable && (!current || sure)) {
          const startWord = consumed.split(/\s+/).filter(Boolean).length;
          await create(newWords, startWord, consumed.length, answers.route.choice, isFinal, version);
          if (currentPass(version)) consumed = text;
        }
      } else if (!sure) {
        // not sure enough to change or drop a task on: wait for another word
      } else if (relation === "covered") {
        consumed = text;
      } else if (relation === "retracts") {
        consumed = text;
        if (current) {
          current.abort.abort();
          current.status = "cancelled";
          log(`task ${current.id} taken back`);
          // Its hand is free once the loop on it has stopped; `settled` ends in startWaiting.
        }
      } else if (current) {
        const request = current.utterance === utterance
          ? current.requestPrefix + text.slice(current.startChar).trim()
          : current.request + "\n" + text.trim();
        await refine(current, request, isFinal, version);
        if (currentPass(version)) consumed = text;
      }
    }

    // STT can deliver several sentences in one delta. Consume only the first
    // task and let Jev classify the remainder against the updated task list.
    if (boundary !== undefined && consumed !== beforeConsumed && currentPass(version)) {
      await pass(latest, isFinal, version);
      return;
    }

    if (isFinal && currentPass(version)) {
      for (const task of tasks.filter((t) => t.stale && (t.status === "waiting" || t.status === "running"))) {
        await refine(task, task.request, true, version);
      }
    }
  }

  async function drain() {
    while (!abort.signal.aborted && (handled.text !== latest || handled.finished !== finished)) {
      const now = { text: latest, finished };
      const version = epoch;
      try {
        await pass(now.text, now.finished, version);
      } catch (err) {
        if (!currentPass(version)) continue;
        log(`listen: ${err instanceof Error ? err.message : err}`); // the next word gets another try
        if (now.finished) {
          finalError = err instanceof Error ? err : new Error(String(err));
          stopTasks(tasks.filter((task) => task.utterance === utterance), "failed"); // Do not release partial intents, or stop an earlier independent utterance.
        }
      }
      if (currentPass(version)) handled = now;
    }
  }

  /** At most one pass at a time. Words that arrive meanwhile are taken together: the newest transcript wins. */
  function kick(): Promise<void> {
    pump ??= drain().finally(() => {
      pump = null;
      if (!abort.signal.aborted && (handled.text !== latest || handled.finished !== finished)) void kick();
    });
    return pump;
  }

  function stopTasks(targets: Live[], status: "cancelled" | "failed" = "cancelled") {
    for (const task of targets) {
      if (task.status === "waiting" || task.status === "running") {
        task.status = status;
        task.abort.abort();
      }
    }
  }

  async function finishUtterance() {
    if (abort.signal.aborted) return;
    const completing = utterance;
    finished = true;
    try {
      while (!abort.signal.aborted && utterance === completing && (handled.text !== latest || !handled.finished)) await kick();
      if (utterance !== completing) return;
      if (finalError) throw finalError;
      for (const task of tasks.filter((t) => t.status === "running" && t.utterance === completing)) {
        for (const listener of task.listeners) listener(task.intent);
      }
    } finally {
      // Only validated final intents reach workers; failed/cancelled ones are aborted first.
      complete(completing);
    }
  }

  function complete(completing = utterance) {
    completing.speaking = false;
    completing.ended.resolve();
    completing.abort.abort();
    if (utterance !== completing) return;
    utterance = newUtterance();
    latest = "";
    finished = false;
    handled = { text: "", finished: false };
    consumed = "";
    finalError = null;
  }

  function receive(transcript: string) {
    if (finished || abort.signal.aborted) return;
    transcript = transcript.trim().replace(/\s+/g, " ");
    if (latest && !transcript.startsWith(latest)) {
      // STT can revise earlier words, not just append. Their old word offsets
      // are no longer meaningful; rebuild from the corrected utterance.
      epoch++;
      utterance.abort.abort();
      utterance.abort = new AbortController();
      const old = tasks.filter((task) => task.utterance === utterance);
      stopTasks(old);
      for (const task of old) task.superseded = true;
      consumed = "";
      handled = { text: "", finished: false };
    }
    utterance.speaking = true;
    utterance.text = transcript;
    latest = transcript;
  }

  return {
    tasks,
    warm() {
      if (!abort.signal.aborted) void ask("ready", { ready: noul("The text says ready.") }).catch(() => {});
    },
    hear(transcript) {
      receive(transcript);
      if (finished || abort.signal.aborted) return;
      void kick();
    },
    finish(transcript) {
      if (transcript !== undefined && !ending) receive(transcript);
      return ending ??= finishUtterance().finally(() => { ending = null; });
    },
    cancelUtterance() {
      epoch++;
      stopTasks(tasks.filter((task) => task.utterance === utterance));
      complete();
    },
    schedule: () => startWaiting(),
    cancel() {
      epoch++;
      abort.abort();
      stopTasks(tasks);
      complete();
    },
    async idle() {
      while (tasks.some((t) => t.working)) await Promise.all(tasks.filter((t) => t.working).map((t) => t.settled));
      // Nothing is working, so nothing will free a hand for these.
      for (const t of tasks.filter((t) => t.status === "waiting")) log(`task ${t.id} never got a hand: is one running? (bun desktop.ts up 1)`);
    },
  };
}

// ---------------------------------------------------------------- work

/** Open what the intent needs, then let Jev drive, careful while the speaker is still talking. */
export function handWork(deps: Deps): Work {
  return async (hand, job) => {
    const [{ APP_START_MS, openFor, runIntent }, { RISK_THRESHOLD }] = await Promise.all([import("./cua"), import("./gate")]);
    if (job.signal.aborted) return { status: "cancelled", reason: "the task was taken back", steps: [] };
    await openFor(hand, job.intent());
    if (job.intent().launcher !== "none") await (deps.sleep ?? Bun.sleep)(APP_START_MS);
    return runIntent(hand, job.intent, deps, {
      signal: job.signal,
      settles: job.speechEnds,
      riskThreshold: () => (job.speechEnds() ? SPEAKING_RISK_THRESHOLD : RISK_THRESHOLD),
    });
  };
}

/** Touches no hand: shows what would start, and the intent as it stands once the speaker has finished. */
const dryWork: Work = async (hand, job) => {
  await job.speechEnds();
  if (job.signal.aborted) return { status: "cancelled", reason: "the task was taken back", steps: [] };
  return { status: "dry_run", reason: `hand ${hand.id} would work on ${JSON.stringify(job.intent())}`, steps: [] };
};

// ---------------------------------------------------------------- CLI

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (cmd !== "say" && cmd !== "stdin") {
    console.log(
      [
        "usage: bun jev/listen.ts <command>",
        "  say [--wps=3] [--dry] <sentence...>   speak a sentence word by word",
        "  stdin [--dry]                         each line is the transcript so far; an empty line ends the utterance",
        "  --dry                                 touch no hand; show what would be started",
      ].join("\n"),
    );
    return;
  }
  const dry = rest.includes("--dry");
  const started = performance.now();
  const log = (line: string) => console.log(`${((performance.now() - started) / 1000).toFixed(2).padStart(6)}s  ${line}`);
  const ask = createJev();
  const [{ createOpenAI }, { terminalApprove }] = await Promise.all([import("./openai"), import("./gate")]);
  const llm = createOpenAI();
  const fakeHands = [1, 2, 3].map((id) => ({ id, pid: 0, display: "", width: 1280, height: 800 }));
  const listener = createListener({
    ask,
    llm,
    log,
    hands: dry ? async () => fakeHands : listHands,
    work: dry ? dryWork : handWork({ ask, llm, approve: terminalApprove, log }),
  });

  listener.warm();
  await Bun.sleep(1200); // the hotkey is down a moment before the first word
  if (cmd === "say") {
    const wps = Number(rest.find((a) => a.startsWith("--wps="))?.slice(6) ?? 3);
    const words = rest.filter((a) => !a.startsWith("--")).join(" ").split(/\s+/).filter(Boolean);
    for (let i = 1; i <= words.length; i++) {
      log(`"${words.slice(0, i).join(" ")}"`);
      listener.hear(words.slice(0, i).join(" "));
      await Bun.sleep(1000 / wps);
    }
    log("(speaker finished)");
    await listener.finish();
  } else {
    for await (const line of console) {
      if (line.trim()) listener.hear(line);
      else await listener.finish();
    }
    await listener.finish();
  }
  await listener.idle();
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
