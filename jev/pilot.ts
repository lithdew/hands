// pilot.ts — from what was said to a finished task, asking the slowest model last.
//
//   understand   ONE round of Jev, three requests side by side (they cost the time of one):
//                  recipes.ts   an everyday shape, slots and all          -> Intent, no LLM
//                  learned.ts   a shape an LLM planned before             -> Intent, no LLM
//                  quick.ts     open or search one site (only trusted when Jev says the request is that simple)
//   plan         otherwise ONE text call to a language model (plan.ts): start link, texts, steps.
//                Several tasks when the request is several things.
//   drive        screen.ts `runScreens`, a screen's worth of actions per request, for each task in order
//   learn        a plan that worked is generalised in the background (learned.ts), so next time it is tier one
//
// The vision planner (planner.ts) is still there inside the loop, for a screen
// that is not what anybody expected. It is no longer how ordinary tasks get done.
//
//   const pilot = createPilot({ ask, llm, contacts, store, open, ...screenDeps });
//   const early = await pilot.read(said);                 // tier one only: safe on a sentence still being spoken
//   const understood = await pilot.understand(said);      // tier one, else the plan
//   const result = await pilot.run(hand, said, opts);

import type { Hand } from "../desktop";
import type { RunOptions, RunResult } from "./cua";
import type { Intent } from "./intent";
import { generalise, learnedIntent, memoryStore, type LearnedStore } from "./learned";
import { planTasks } from "./plan";
import { quickIntent } from "./quick";
import type { Account } from "./accounts";
import { readRequest, type Contact, type Here } from "./recipes";
import { runScreens, type ScreenDeps } from "./screen";

// ---------------------------------------------------------------- types

export type Tier = "recipe" | "learned" | "quick" | "plan";
/** `start`: where to go first, or null to work on whatever the hand has open. */
export type PilotTask = { intent: Intent; start: string | null; shape: string; wantsAnswer: boolean };
export type Understood = { by: Tier; detail: string; tasks: PilotTask[]; /** The request named an account of the user's that nobody knows yet. */ unknownAccount?: boolean; /** Set when a plan could be learned from once it has worked. */ teach?: () => Promise<void> };
export type PilotResult = { by: Tier; detail: string; status: RunResult["status"]; reason: string; runs: RunResult[]; wantsAnswer: boolean; /** Resolves when background learning is over. Never rejects. */ learning: Promise<void> };

export type PilotDeps = ScreenDeps & {
  contacts: readonly Contact[];
  store?: LearnedStore;
  /** Go to a url in the hand. The start of every task; a deep link is most of some tasks. */
  open: (hand: Hand, url: string) => Promise<void>;
  today?: () => Date;
  /** The loop that drives a task. Default: screen.ts `runScreens`. A seam for tests. */
  drive?: typeof runScreens;
  /** The user's own accounts, as known right now (a hand learns more as it sees them). */
  accounts?: () => readonly Account[];
  /** What the hand's browser shows right now, so a request can carry on from it and an account can stay. */
  here?: () => Promise<Here | null>;
  /** Title of the window the user is looking at, for requests that point at it. Only the planner is told. */
  onScreen?: () => Promise<string | null>;
};

// ---------------------------------------------------------------- config

const SIMPLE_ENOUGH = 0.6;

// ---------------------------------------------------------------- pilot

export function createPilot(deps: PilotDeps) {
  const store = deps.store ?? memoryStore(), log = deps.log ?? (() => {}), today = deps.today ?? (() => new Date());

  /** Tier one alone: one round of Jev, or null when only a plan will do. Cheap enough to run on a sentence that is still being spoken. */
  const context = async () => ({ today: today(), contacts: deps.contacts, accounts: deps.accounts?.() ?? [], here: await deps.here?.().catch(() => null) ?? null });

  async function read(said: string): Promise<Understood | null> {
    const ctx = await context();
    const [reading, learned, quick] = await Promise.all([
      readRequest(deps.ask, said, ctx),
      learnedIntent(deps.ask, said, store).catch(() => null),
      quickIntent(deps.ask, said).catch(() => null),
    ]);
    const one = (intent: Intent, start: string | null, shape: string): PilotTask[] => [{ intent, start: start ?? intent.url ?? "https://www.google.com/", shape, wantsAnswer: false }];
    if (reading.built) return { by: "recipe", detail: `${reading.built.recipe} (${reading.built.confidence.toFixed(2)})`, tasks: one(reading.built.intent, reading.built.deepLink, reading.built.recipe) };
    if (learned) return { by: "learned", detail: `${learned.shape} (${learned.confidence.toFixed(2)})`, tasks: one(learned.intent, null, learned.shape) };
    // quick.ts will claim anything that mentions a site. Jev's own word that the request is only that is what makes it safe.
    // And only for a site it knows: for "open calculator" it answers "nothing to open, type calculator", which is not a task.
    if (reading.unknownAccount) return { by: "recipe", detail: "an account nobody knows yet", tasks: [], unknownAccount: true };
    if (quick?.launcher === "browser" && quick.url && reading.task === "other" && reading.simple >= SIMPLE_ENOUGH && reading.twoTasks < 0.5 && reading.continues < 0.6) return { by: "quick", detail: `simple ${reading.simple.toFixed(2)}`, tasks: one(quick, null, "open or search a site") };

    return null;
  }

  async function understand(said: string): Promise<Understood> {
    const first = await read(said);
    if (first && !first.unknownAccount) return first;
    // The quick model planned every request tried, two-app ones included, in 2 to 4 s; the deep one took 5 to 8.
    const onScreen = await deps.onScreen?.().catch(() => null);
    const planned = await planTasks(deps.llm, said, { ...(await context()), onScreen }, "quick");
    return { by: "plan", detail: `${planned.length} task${planned.length === 1 ? "" : "s"}`,
      // No url: the plan carries on from the page the hand is on.
      tasks: planned.map((t) => ({ intent: t.intent, start: t.intent.url, shape: t.intent.goal, wantsAnswer: t.wantsAnswer })),
      teach: async () => { for (const task of planned) { const recipe = await generalise(deps.llm, said, task).catch(() => null); if (recipe) { store.add(recipe); log(`learned: ${recipe.shape}`); } } } };
  }

  async function run(hand: Hand, said: string, opts: RunOptions = {}, understood?: Understood): Promise<PilotResult> {
    const u = understood ?? (await understand(said));
    log(`understood by ${u.by}: ${u.detail}`);
    const runs: RunResult[] = [];
    for (const task of u.tasks) {
      if (opts.signal?.aborted) break;
      log(`task: ${task.intent.goal}`);
      if (task.start) await deps.open(hand, task.start);
      runs.push(await (deps.drive ?? runScreens)(hand, () => task.intent, deps, opts)); // read at every look: a caller may refine `task.intent` in place
      if (runs.at(-1)!.status !== "done") break;
    }
    const last = runs.at(-1), done = runs.length === u.tasks.length && last?.status === "done";
    return { by: u.by, detail: u.detail, runs, status: last?.status ?? "cancelled", reason: last?.reason ?? "the task was taken back", wantsAnswer: u.tasks.some((t) => t.wantsAnswer),
      learning: done && u.teach ? u.teach().catch(() => {}) : Promise.resolve() };
  }

  return { read, understand, run, store };
}

/** The user's contacts: a JSON list of {name, email?}. No file means no contacts, and requests that name people are planned by the LLM. */
export async function loadContacts(path = process.env.PUK_CONTACTS ?? "contacts.json"): Promise<Contact[]> {
  const raw = await Bun.file(path).json().catch(() => []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is Contact => typeof c?.name === "string" && Boolean(c.name.trim()) && (c.email === undefined || typeof c.email === "string")).slice(0, 200).map((c) => ({ name: c.name.trim(), ...(c.email ? { email: c.email.trim() } : {}) }));
}
