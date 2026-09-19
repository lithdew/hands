// listen.ts — Jev listens while the user is still speaking.
//
// Every time the transcript grows by a word, the whole sentence so far goes to
// Jev. One request, three independent questions:
//
//   relation    how do the new words relate to the tasks we already have?
//               no_request | covered | refines | new_task | retracts
//   startable   has enough been said to start working? ("search wikipedia for"
//               is enough to open Wikipedia; the search term can arrive later)
//   route       can Jev build the intent itself (quick.ts), or does it need
//               the LLM to work out what is meant (intent.ts)?
//
// Code does the rest. A startable new task gets an intent and a free hand at
// once, so the hand is already working while the user talks. Words that refine
// a task rebuild its intent in place, and the running loop in cua.ts picks it
// up at its next step. "Never mind" cancels. A task whose hand finished is
// kept as "done", so Jev sees its words as covered and does not start it again.
//
// A hand that starts on half a sentence must not act on half a sentence.
// While the speaker is talking a hand may open, click and scroll, but it does
// not type, the gate is stricter, and what the gate flags is held. When the
// speaker has finished, the loop decides again against the final intent.
//
// The opening move is always Jev's (quick.ts, about 300 ms), so Gmail is
// already loading while the user is still dictating. A task routed to the LLM
// gets its full intent once, when the sentence has stopped moving. If that
// last build fails, the task is cancelled: a hand never acts on a fragment.
//
//   const listener = createListener(deps);
//   listener.hear("search wiki");  listener.hear("search wikipedia for"); ...
//   await listener.finish();       // hotkey released
//   await listener.idle();         // all hands done
//
// CLI: bun jev/listen.ts say [--wps=3] [--dry] <sentence...>   speak a sentence, word by word
//      bun jev/listen.ts stdin [--dry]     each line is the transcript so far; an empty line ends it
//
// `stdin` is the seam for transcribe.ts: pipe partial transcripts in.

import { listHands, type Hand } from "../desktop";
import { APP_START_MS, openFor, runIntent, type Deps, type RunResult } from "./cua";
import { RISK_THRESHOLD, terminalApprove } from "./gate";
import { parseIntent, type Intent } from "./intent";
import { choice, createJev, noul, type Ask } from "./jev";
import { createOpenAI, type Llm } from "./openai";
import { quickIntent } from "./quick";

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
  /** A promise while the speaker is still talking, null once they have finished. */
  speechEnds: () => Promise<void> | null;
};
export type Work = (hand: Hand, job: Job) => Promise<RunResult>;

export type ListenDeps = {
  ask: Ask;
  llm: Llm;
  hands: () => Promise<Hand[]>;
  work: Work;
  log?: (line: string) => void;
};

export type Listener = {
  /** Call when the hotkey goes down. Opens the connection to Jev, so the first word is not a cold start (about 1 s). */
  warm(): void;
  /** The whole transcript so far. Call on every partial result. Returns at once. */
  hear(transcript: string): void;
  /** The speaker has finished. Resolves once the last words have been dealt with. */
  finish(): Promise<void>;
  /** Resolves when no task is waiting or running. */
  idle(): Promise<void>;
  readonly tasks: readonly Task[];
};

type Live = Task & {
  abort: AbortController;
  run: number;
  settled: Promise<void>;
  stale: boolean;
  /** A loop is on the hand. Outlives `status` briefly when a task is taken back mid-step. */
  working: boolean;
};

// ---------------------------------------------------------------- config

/** `startable` at or above this starts a hand before the sentence is over. */
const START_THRESHOLD = 0.6;
/**
 * Below this confidence in `relation`, wait for another word before touching an
 * existing task. Not applied to the final pass, and not to a new task: there
 * `startable` is the gate. Real Jev said new_task 0.49, startable 0.75 at
 * "search wikipedia for", which is exactly when a hand should start.
 */
const MIN_RELATION_CONFIDENCE = 0.5;
/** While the intent is still partial, less is needed for the gate to hold an action. */
export const SPEAKING_RISK_THRESHOLD = 0.25;

const QUESTIONS = {
  relation: choice(
    "The speaker is talking to a computer assistant. `new_words` are what they said since the last task was recorded. How do `new_words` relate to `tasks`?",
    {
      no_request:
        "`new_words` ask for nothing: filler, a greeting, thinking aloud, or the first words of a sentence that does not yet say what to do.",
      covered: "`new_words` only repeat what a task in `tasks` already says.",
      refines:
        "`new_words` continue or correct the latest task in `tasks` that is not done: they finish its sentence, add a detail, or change one.",
      new_task: "`new_words` ask for something that no task in `tasks` covers.",
      retracts: "`new_words` take the latest task back: never mind, stop, cancel that, do not do it.",
    },
  ),
  startable: noul("Enough has been said to start working: it is clear what to open first, even if details are still to come.", {
    true: "For example 'search wikipedia for': Wikipedia can be opened already. 'email sam': the mail site can be opened already. 'find my tax': the file manager can be opened already.",
    false: "For example 'can you please', 'I need to' or 'search for': nothing says what to open yet.",
  }),
  route: choice("Who can work out what the speaker wants?", {
    jev: "A simple request: open a well-known website, an app or a folder, and perhaps type words the speaker said literally, such as a search term.",
    llm: "It needs writing or planning: a message or email to compose, a reply, several steps, or text to type that the speaker did not say word for word.",
  }),
};

// ---------------------------------------------------------------- listener

export function createListener(deps: ListenDeps): Listener {
  const log = deps.log ?? (() => {});
  const tasks: Live[] = [];

  // One utterance: from the first word to finish().
  let latest = "";
  let finished = false;
  let handled = { text: "", finished: false };
  let consumed = 0; // words already turned into a task, or taken back
  let speech = Promise.withResolvers<void>();
  let speaking = false;
  let pump: Promise<void> | null = null;

  const open = () => tasks.findLast((t) => t.status === "waiting" || t.status === "running");
  const job = (task: Live): Job => ({
    intent: () => task.intent,
    signal: task.abort.signal,
    speechEnds: () => (speaking ? speech.promise : null),
  });

  // ---- hands

  async function freeHand(): Promise<Hand | undefined> {
    const busy = new Set(tasks.filter((t) => t.working).map((t) => t.hand));
    return (await deps.hands()).find((h) => !busy.has(h.id));
  }

  function start(task: Live, hand: Hand) {
    const run = ++task.run;
    task.status = "running";
    task.working = true;
    task.hand = hand.id;
    log(`task ${task.id} -> hand ${hand.id}: ${task.intent.goal}`);
    task.settled = deps
      .work(hand, job(task))
      .then((result) => {
        if (run !== task.run) return; // restarted since; this result is of the old run
        task.working = false;
        task.result = result;
        task.status = result.status === "done" || result.status === "dry_run" ? "done" : result.status === "cancelled" ? "cancelled" : "failed";
        log(`task ${task.id} ${task.status}: ${result.reason}`);
      })
      .catch((err) => {
        if (run !== task.run) return;
        task.working = false;
        task.status = "failed";
        log(`task ${task.id} failed: ${err instanceof Error ? err.message : err}`);
      })
      .then(startWaiting);
  }

  async function startWaiting() {
    for (const task of tasks.filter((t) => t.status === "waiting")) {
      const hand = await freeHand();
      if (!hand) return;
      start(task, hand);
    }
  }

  /** Same hand, from the top: what to open changed, so amending in place is not enough. */
  async function restart(task: Live) {
    const hand = (await deps.hands()).find((h) => h.id === task.hand);
    task.abort.abort();
    task.run++; // the old run's result no longer counts
    await task.settled;
    task.working = false;
    task.abort = new AbortController();
    if (hand) start(task, hand);
  }

  // ---- intents

  /** Jev's own intent when it can make one. The LLM when it cannot, or when `full` is asked of an llm task. */
  async function build(request: string, route: "jev" | "llm", full: boolean): Promise<{ intent: Intent; route: "jev" | "llm" }> {
    if (route === "jev" || !full) {
      const quick = await quickIntent(deps.ask, request);
      if (quick) return { intent: quick, route };
    }
    return { intent: await parseIntent(deps.llm, request), route: "llm" };
  }

  async function create(request: string, startWord: number, route: "jev" | "llm", isFinal: boolean) {
    const built = await build(request, route, isFinal);
    const task: Live = {
      id: tasks.length + 1,
      request,
      startWord,
      ...built,
      status: "waiting",
      hand: null,
      result: null,
      abort: new AbortController(),
      run: 0,
      settled: Promise.resolve(),
      // An llm task that started on Jev's opening move still owes the real intent.
      stale: built.route === "llm" && !isFinal,
      working: false,
    };
    tasks.push(task);
    log(`task ${task.id} (${task.route}): ${JSON.stringify(task.intent.inputs)} ${task.intent.url ?? task.intent.launcher}`);
    const hand = await freeHand();
    if (hand) start(task, hand);
    else log(`task ${task.id} is waiting for a free hand`);
  }

  async function refine(task: Live, request: string, isFinal: boolean) {
    task.request = request;
    // The LLM is slow and the sentence is still moving: rebuild once, when it has stopped.
    if (task.route === "llm" && !isFinal) return void (task.stale = true);
    const before = task.intent;
    let built: Awaited<ReturnType<typeof build>>;
    try {
      built = await build(request, task.route, isFinal).catch((err) => {
        if (!isFinal) throw err;
        log(`task ${task.id}: building the final intent failed, trying once more: ${err instanceof Error ? err.message : err}`);
        return build(request, task.route, true);
      });
    } catch (err) {
      if (!isFinal) return void (task.stale = true); // the next word, or the end of the sentence, tries again
      // What the task holds is a guess made on a fragment. Better no action than that one.
      task.abort.abort();
      task.status = "failed";
      log(`task ${task.id} cancelled: could not work out what was finally asked (${err instanceof Error ? err.message : err})`);
      return;
    }
    // The LLM knows what to write but sometimes not where to start. Jev's opening move already picked a site.
    if (built.intent.launcher === "browser" && !built.intent.url && before.launcher === "browser") built.intent.url = before.url;
    task.intent = built.intent; // the running loop reads this at its next step
    task.route = built.route;
    task.stale = false;
    log(`task ${task.id} refined (${task.route}): ${JSON.stringify(task.intent.inputs)}`);
    const site = (i: Intent) => (i.url ? new URL(i.url).host : null);
    const moved = before.launcher !== task.intent.launcher || site(before) !== site(task.intent);
    if (moved && task.status === "running") await restart(task);
  }

  // ---- one pass over the transcript

  async function pass(text: string, isFinal: boolean) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const newWords = words.slice(consumed).join(" ");
    if (newWords) {
      const answers = await deps.ask(
        {
          transcript: words.join(" "),
          new_words: newWords,
          speaker_has_finished: isFinal,
          tasks: tasks.map((t) => ({ request: t.request, status: t.status })),
        },
        QUESTIONS,
      );
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
        if (startable) {
          const startWord = consumed;
          consumed = words.length;
          await create(newWords, startWord, answers.route.choice, isFinal);
        }
      } else if (!sure) {
        // not sure enough to change or drop a task on: wait for another word
      } else if (relation === "covered") {
        consumed = words.length;
      } else if (relation === "retracts") {
        consumed = words.length;
        if (current) {
          current.abort.abort();
          current.status = "cancelled";
          log(`task ${current.id} taken back`);
          // Its hand is free once the loop on it has stopped; `settled` ends in startWaiting.
        }
      } else if (current) {
        consumed = words.length;
        await refine(current, words.slice(current.startWord).join(" "), isFinal);
      }
    }

    if (isFinal) {
      for (const task of tasks.filter((t) => t.stale && (t.status === "waiting" || t.status === "running"))) {
        await refine(task, task.request, true);
      }
    }
  }

  async function drain() {
    while (handled.text !== latest || handled.finished !== finished) {
      const now = { text: latest, finished };
      try {
        await pass(now.text, now.finished);
      } catch (err) {
        log(`listen: ${err instanceof Error ? err.message : err}`); // the next word gets another try
      }
      handled = now;
    }
  }

  /** At most one pass at a time. Words that arrive meanwhile are taken together: the newest transcript wins. */
  function kick(): Promise<void> {
    pump ??= drain().finally(() => {
      pump = null;
      if (handled.text !== latest || handled.finished !== finished) void kick();
    });
    return pump;
  }

  return {
    tasks,
    warm() {
      void deps.ask("ready", { ready: noul("The text says ready.") }).catch(() => {});
    },
    hear(transcript) {
      if (finished) return;
      speaking = true;
      latest = transcript;
      void kick();
    },
    async finish() {
      finished = true;
      try {
        while (handled.text !== latest || !handled.finished) await kick();
      } finally {
        // The intent is final now. Release what the gate was holding, and be ready for the next utterance.
        speaking = false;
        speech.resolve();
        speech = Promise.withResolvers<void>();
        latest = "";
        finished = false;
        handled = { text: "", finished: false };
        consumed = 0;
      }
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
