/**
 * From what was said to a finished task, asking the slowest model last.
 *
 *   understand   ONE round of Jev, three requests side by side (they cost the time of one):
 *                  recipes.ts   an everyday shape, slots and all          -> Intent, no model
 *                  learned.ts   a shape a model planned before            -> Intent, no model
 *                  quick.ts     open or search one site (only trusted when Jev says the request is that simple)
 *   plan         otherwise ONE text call to a language model (plan.ts): start link, texts, steps.
 *                Several tasks when the request is several things.
 *   drive        screen.ts `runScreens`, a screen's worth of actions per request, for each task in order
 *   learn        a plan that worked is generalised in the background (learned.ts), so next time it is tier one
 */

import type { Intent } from "./intent.ts";
import { filledIn, generalise, type LearnedStore, learnedIntent, memoryStore } from "./learned.ts";
import { planTasks } from "./plan.ts";
import { quickIntent } from "./quick.ts";
import { type Contact, type Here, readRequest } from "./recipes.ts";
import { type RunOptions, type RunResult, runScreens, type ScreenDeps } from "./screen.ts";

export type Tier = "recipe" | "learned" | "quick" | "plan";
/** `start`: where to go first, or null to work on whatever the hand has open. */
export interface PilotTask {
  intent: Intent;
  start: string | null;
  shape: string;
  wantsAnswer: boolean;
}
export interface Understood {
  by: Tier;
  detail: string;
  tasks: PilotTask[];
  /** Set when a plan could be learned from once it has worked. */
  teach?: () => Promise<void>;
}
export interface PilotResult {
  by: Tier;
  detail: string;
  status: RunResult["status"];
  reason: string;
  runs: RunResult[];
  wantsAnswer: boolean;
  /** Resolves when background learning is over. Never rejects. */
  learning: Promise<void>;
}

export interface PilotDeps extends ScreenDeps {
  contacts: readonly Contact[];
  store?: LearnedStore;
  /** Go to a url in the hand's browser. The start of every task; a deep link is most of some tasks. */
  open: (url: string, by: Tier) => Promise<void>;
  today?: () => Date;
  /** The loop that drives a task. A seam for tests. */
  drive?: typeof runScreens;
  /** What the hand's browser shows right now, so a request can carry on from it. */
  here?: () => Promise<Here | null>;
  /** Title of the window the user is looking at, for requests that point at it. Only the planner is told. */
  onScreen?: () => Promise<string | null>;
}

const SIMPLE_ENOUGH = 0.6;

export function createPilot(deps: PilotDeps) {
  const [store, log, today] = [deps.store ?? memoryStore(), deps.log ?? (() => {}), deps.today ?? (() => new Date())];
  const context = async () => ({ today: today(), contacts: deps.contacts, here: (await deps.here?.().catch(() => null)) ?? null });

  /** Tier one alone: one round of Jev, or null when only a plan will do. */
  async function read(said: string): Promise<Understood | null> {
    const [reading, learned, quick] = await Promise.all([
      readRequest(deps.ask, said, await context()),
      learnedIntent(deps.ask, said, store).catch(() => null),
      quickIntent(deps.ask, said).catch(() => null),
    ]);
    const one = (intent: Intent, start: string | null, shape: string): PilotTask[] => [{ intent, start: start ?? intent.url ?? "https://www.google.com/", shape, wantsAnswer: false }];
    // A template with a part still in braces is not a task. One reached a hand as "Find {what to search for} on YouTube"; the plan is asked instead.
    if (reading.built && filledIn(reading.built.intent)) return { by: "recipe", detail: `${reading.built.recipe} (${reading.built.confidence.toFixed(2)})`, tasks: one(reading.built.intent, reading.built.deepLink, reading.built.recipe) };
    if (learned && filledIn(learned.intent)) return { by: "learned", detail: `${learned.shape} (${learned.confidence.toFixed(2)})`, tasks: one(learned.intent, null, learned.shape) };
    if (reading.built || learned) return null;
    // quick.ts will claim anything that mentions a site. Jev's own word that the request is only that is what makes it safe.
    if (quick?.url && reading.task === "other" && reading.simple >= SIMPLE_ENOUGH && reading.twoTasks < 0.5 && reading.continues < 0.6) return { by: "quick", detail: `simple ${reading.simple.toFixed(2)}`, tasks: one(quick, null, "open or search a site") };
    return null;
  }

  /** `first`: a reading the caller already made (null: it found nothing), so Jev is not asked the same round twice. */
  async function understand(said: string, first?: Understood | null): Promise<Understood> {
    if (first === undefined) first = await read(said);
    if (first) return first;
    const planned = await planTasks(deps.llm, said, { ...(await context()), onScreen: await deps.onScreen?.().catch(() => null) });
    return {
      by: "plan",
      detail: `${planned.length} task${planned.length === 1 ? "" : "s"}`,
      // No url: the plan carries on from the page the hand is on.
      tasks: planned.map((t) => ({ intent: t.intent, start: t.intent.url, shape: t.intent.goal, wantsAnswer: t.wantsAnswer })),
      teach: async () => {
        for (const task of planned) {
          const recipe = await generalise(deps.llm, said, task).catch(() => null);
          if (!recipe) continue;
          store.add(recipe);
          log(`learned: ${recipe.shape}`);
        }
      },
    };
  }

  async function run(said: string, options: RunOptions = {}, understood?: Understood): Promise<PilotResult> {
    const u = understood ?? (await understand(said));
    log(`understood by ${u.by}: ${u.detail}`);
    const runs: RunResult[] = [];
    for (const task of u.tasks) {
      if (options.signal?.aborted) break;
      log(`task: ${task.intent.goal}`);
      if (task.start) await deps.open(task.start, u.by);
      runs.push(await (deps.drive ?? runScreens)(task.intent, deps, options));
      if (runs.at(-1)!.status !== "done") break;
    }
    const last = runs.at(-1);
    const done = runs.length === u.tasks.length && last?.status === "done";
    return {
      by: u.by, detail: u.detail, runs, status: last?.status ?? "cancelled", reason: last?.reason ?? "the task was taken back", wantsAnswer: u.tasks.some((t) => t.wantsAnswer),
      learning: done && u.teach ? u.teach().catch(() => {}) : Promise.resolve(),
    }; // prettier-ignore
  }

  return { read, understand, run, store };
}

/** The user's contacts: a JSON list of {name, email?}. No file means no contacts, and a request that names a person is planned by the model. */
export async function loadContacts(path = process.env.HANDS_CONTACTS ?? "contacts.json"): Promise<Contact[]> {
  const raw = await Bun.file(path).json().catch(() => []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Contact => typeof c?.name === "string" && Boolean(c.name.trim()) && (c.email === undefined || typeof c.email === "string"))
    .slice(0, 200)
    .map((c) => ({ name: c.name.trim(), ...(c.email ? { email: c.email.trim() } : {}) }));
}
