// tasks.eval.ts — whole tasks, real Jev, simulated apps: which contract finishes fastest?
//
//   bun jev/tasks.eval.ts                         every task, every strategy, one round
//   bun jev/tasks.eval.ts --rounds=3 --only=email --strategy=today,recipes --verbose
//
// Strategies:
//   today     quick.ts, else the LLM intent; cua.ts `runIntent`: one action per look, decide + gate each
//   intent    recipes.ts builds the intent (no LLM); the loop is still cua.ts `runIntent`
//   screens   recipes.ts intent; screen.ts `runScreens`: a screen's worth of actions per look
//   recipes   the same, started from the recipe's deep link (the form arrives filled)
//   pilot     pilot.ts: recipes, learned recipes and quick.ts in one Jev round; else ONE text plan from an LLM
//             (link, texts, steps), driven by `runScreens`; a plan that worked is learned for next time
//
// What is real: every Jev request, the intent and compose LLM calls. What is not:
// the apps (sim.ts), and the vision planner, which is an oracle that always gives
// the right next steps and is charged PLANNER_MS. Actions and page loads cost
// nothing here, so wall time is model time. Approval is given at once and counted.
//
// Results go to out/jev-tasks-eval.json.

import { runIntent, type Deps } from "./cua";
import { parseIntent, type Intent } from "./intent";
import { createJev, type Ask } from "./jev";
import { createOpenAI, type Llm } from "./openai";
import { quickIntent } from "./quick";
import { memoryStore } from "./learned";
import { createPilot } from "./pilot";
import { recipeIntent } from "./recipes";
import { describeScreenAction, runScreens, type ScreenAction } from "./screen";
import { CONTACTS, SIM_HAND, SIM_TODAY, World } from "./sim";

// ---------------------------------------------------------------- tasks

type Verdict = { ok: boolean; why: string };
type Task = { id: string; said: string; check(world: World): Verdict; hints(world: World): string[] };

const has = (text: string, ...patterns: RegExp[]) => patterns.every((p) => p.test(text));
const verdict = (problems: (string | false)[]): Verdict => { const bad = problems.filter(Boolean) as string[]; return { ok: bad.length === 0, why: bad.join("; ") || "as asked" }; };

function emailTask(id: string, said: string, to: string, ...body: RegExp[]): Task {
  return { id, said,
    check: (w) => { const [m] = w.gmail.sent; return verdict([w.gmail.sent.length !== 1 && `${w.gmail.sent.length} emails sent`, !!m && m.to.join() !== to && `sent to ${m.to.join()}`, !!m && !has(m.body, ...body) && `body was ${JSON.stringify(m.body)}`]); },
    hints: (w) => (w.gmail.compose ? ["Type the recipient into 'To recipients' and click the matching contact suggestion.", "Type the subject into 'Subject'.", "Type the body into 'Message Body'.", "Click 'Send'."] : ["Open Gmail and click 'Compose'."]) };
}
function tableTask(id: string, said: string, want: { restaurant?: string; cuisine?: string; party: number; date: string; time: string }): Task {
  return { id, said,
    check: (w) => { const b = w.opentable.booked; return verdict([!b && "nothing was booked", !!b && !!want.cuisine && b.cuisine !== want.cuisine && `booked ${b.restaurant} (${b.cuisine})`, !!b && !!want.restaurant && b.restaurant !== want.restaurant && `booked ${b.restaurant}`,
      !!b && b.party !== want.party && `party of ${b.party}`, !!b && b.date !== want.date && `on ${b.date}`, !!b && b.time !== want.time && `at ${b.time}`]); },
    hints: (w) => ({ home: ["Set Date, Time and Party size, type the restaurant or cuisine into the search field, click 'Let's go'."], results: ["Set Date, Time and Party size if they are wrong.", `Click the ${want.time} button of a matching restaurant.`], booking: ["Click 'Complete reservation'."], confirmed: [] })[w.opentable.view] };
}
function noteTask(id: string, said: string, ...content: RegExp[]): Task {
  return { id, said,
    check: (w) => { const n = w.keep.saved[0]; return verdict([w.keep.saved.length !== 1 && `${w.keep.saved.length} notes saved`, !!n && !has(`${n.title} ${n.body}`, ...content) && `note was ${JSON.stringify(n)}`]); },
    hints: (w) => (w.keep.editing ? ["Type the note into the 'Note' field.", "Click 'Close' to save it."] : ["Open Google Keep and click 'Take a note…'."]) };
}
function textTask(id: string, said: string, to: string, ...content: RegExp[]): Task {
  return { id, said,
    check: (w) => { const [m] = w.messages.sent; return verdict([w.messages.sent.length !== 1 && `${w.messages.sent.length} texts sent`, !!m && m.to !== to && `sent to ${m.to}`, !!m && !has(m.text, ...content) && `text was ${JSON.stringify(m.text)}`]); },
    hints: (w) => (w.messages.thread === null ? [`Open Messages and click the conversation with ${to}.`] : ["Type the reply into 'Text message' and press Enter."]) };
}

const TASKS: Task[] = [
  emailTask("email-remind", "email Sam to remind him about the meeting tomorrow at 10", "sam.rivera@example.com", /meeting/i, /10|ten/i),
  emailTask("email-tell", "send an email to Dana saying lunch on Thursday works for me", "dana.w@example.com", /thursday/i, /lunch/i),
  tableTask("table-steak", "book a table at a steakhouse for two tomorrow at 7", { cuisine: "Steakhouse", party: 2, date: "2026-09-20", time: "7:00 PM" }),
  tableTask("table-named", "get me a table for four at Sakura Sushi House on Friday at 8 pm", { restaurant: "Sakura Sushi House", party: 4, date: "2026-09-25", time: "8:00 PM" }),
  noteTask("note-doctor", "make a note for my doctor's appointment on Tuesday at 3pm", /doctor/i, /tuesday/i, /3/),
  noteTask("note-long", "write down that the plumber is coming Thursday morning between eight and ten and I need to move the car", /plumber/i, /thursday/i, /car/i),
  textTask("text-mom", "reply to mom's text and tell her I'll be there at six", "Mom", /there/i, /six|6/i),
  textTask("text-alex", "text Alex and say yes I can send the deck in an hour", "Alex Chen", /deck/i, /hour/i),
  textTask("text-compose", "answer Alex's text", "Alex Chen", /\w{2,}/),
];

// Beyond the recipes: an extra wish, two recipients, a title, two apps. `--only=beyond`. Order matters:
// "note-again" is the same shape as "note-titled" and should need no LLM once that one has been learned.
const custom = (id: string, said: string, check: Task["check"], hint: string): Task => ({ id, said, check, hints: () => [hint] });
const BEYOND: Task[] = [
  custom("beyond-note-titled", "add a note titled Lisbon trip that says book the airport transfer and renew my passport",
    (w) => { const n = w.keep.saved[0]; return verdict([w.keep.saved.length !== 1 && `${w.keep.saved.length} notes saved`, !!n && !/lisbon trip/i.test(n.title) && `title was ${JSON.stringify(n.title)}`, !!n && !has(n.body, /airport transfer/i, /passport/i) && `body was ${JSON.stringify(n.body)}`]); },
    "Click 'Take a note…', type the title into 'Title' and the text into 'Note', then click 'Close'."),
  custom("beyond-note-again", "add a note titled Packing that says bring the charger and the blue jacket",
    (w) => { const n = w.keep.saved[0]; return verdict([w.keep.saved.length !== 1 && `${w.keep.saved.length} notes saved`, !!n && !/packing/i.test(n.title) && `title was ${JSON.stringify(n.title)}`, !!n && !has(n.body, /charger/i, /blue jacket/i) && `body was ${JSON.stringify(n.body)}`]); },
    "Click 'Take a note…', type the title into 'Title' and the text into 'Note', then click 'Close'."),
  custom("beyond-table-wish", "book a table for two at Keens Steakhouse tomorrow at 7, it's our anniversary, and ask for a quiet corner table",
    (w) => { const b = w.opentable.booked; return verdict([!b && "nothing was booked", !!b && b.restaurant !== "Keens Steakhouse" && `booked ${b.restaurant}`, !!b && (b.party !== 2 || b.date !== "2026-09-20" || b.time !== "7:00 PM") && `party ${b.party} on ${b.date} at ${b.time}`,
      !!b && !/quiet/i.test(b.request) && `special request was ${JSON.stringify(b.request)}`, !!b && b.occasion !== "Anniversary" && `occasion was ${JSON.stringify(b.occasion)}`]); },
    "Click the 7:00 PM button of Keens Steakhouse, set the occasion to Anniversary, type the special request, click 'Complete reservation'."),
  custom("beyond-email-two", "email Sam and Dana that the offsite moved to Friday",
    (w) => { const [m] = w.gmail.sent; return verdict([w.gmail.sent.length !== 1 && `${w.gmail.sent.length} emails sent`, !!m && [...m.to].sort().join() !== "dana.w@example.com,sam.rivera@example.com" && `sent to ${m.to.join()}`, !!m && !has(m.body, /offsite/i, /friday/i) && `body was ${JSON.stringify(m.body)}`]); },
    "Fill in both recipients, the subject and the body, then click 'Send'."),
  custom("beyond-two-apps", "text mom I'll be there at six and then make a note to buy flowers",
    (w) => { const [m] = w.messages.sent, n = w.keep.saved[0]; return verdict([w.messages.sent.length !== 1 && `${w.messages.sent.length} texts sent`, !!m && m.to !== "Mom" && `text went to ${m.to}`, !!m && !/six|6/i.test(m.text) && `text was ${JSON.stringify(m.text)}`,
      w.keep.saved.length !== 1 && `${w.keep.saved.length} notes saved`, !!n && !/flowers/i.test(`${n.title} ${n.body}`) && `note was ${JSON.stringify(n)}`]); },
    "Send the text in Messages first, then save the note in Google Keep."),
];

// ---------------------------------------------------------------- metering

/** What the oracle planner is charged. jev/README.md measured 2.3 to 2.9 s on a toy image; real screens took about 10 s. */
const PLANNER_MS = 4000;

type Meter = { jevRequests: number; jevRounds: number; jevMs: number; llm: { what: string; ms: number }[]; planner: number; approvals: number; looks: number; virtualMs: number };

function metered(ask: Ask, llm: Llm, task: Task, world: World) {
  const m: Meter = { jevRequests: 0, jevRounds: 0, jevMs: 0, llm: [], planner: 0, approvals: 0, looks: 0, virtualMs: 0 };
  let inFlight = 0, roundStarted = 0;
  const countedAsk = (async (state, questions, options) => {
    m.jevRequests++;
    if (inFlight++ === 0) { m.jevRounds++; roundStarted = performance.now(); } // requests that overlap are one round trip of waiting
    try { return await ask(state, questions, options); } finally { if (--inFlight === 0) m.jevMs += performance.now() - roundStarted; }
  }) as Ask;
  const countedLlm: Llm = async (req) => {
    if (req.schema.name === "plan") { m.planner++; m.virtualMs += PLANNER_MS; return { situation: "The planner looked at the screen.", steps: task.hints(world), elements: [], blocked: null }; }
    const started = performance.now();
    try { return await llm(req); } finally { m.llm.push({ what: req.schema.name, ms: Math.round(performance.now() - started) }); }
  };
  return { m, ask: countedAsk, llm: countedLlm };
}

// ---------------------------------------------------------------- strategies

const STRATEGIES = ["today", "intent", "screens", "recipes", "pilot"] as const;
/** What the pilot has learned so far in this process, as it would on a user's machine. */
const LEARNED = memoryStore();
type Strategy = (typeof STRATEGIES)[number];
type Run = { task: string; strategy: Strategy; round: number; ok: boolean; why: string; status: string; reason: string; intentBy: string; ms: number; meter: Meter; acted: string[]; intent: Intent | null };

const LIMITS = { maxSteps: 16, maxPlans: 2 }; // what win/jev.ts gives Jev before handing over

async function runOne(task: Task, strategy: Strategy, round: number, ask: Ask, llm: Llm, verbose: boolean): Promise<Run> {
  const world = new World(), { m, ask: jev, llm: model } = metered(ask, llm, task, world);
  const log = verbose ? (line: string) => console.log(`      ${line}`) : () => {};
  const started = performance.now();
  let intent: Intent | null = null, intentBy = "", status = "error", reason = "";
  const deps: Deps = { ask: jev, llm: model, log, settleMs: 0, sleep: async () => {},
    approve: async () => { m.approvals++; return true; },
    observe: async () => { m.looks++; return world.look(); },
    perform: async (_hand, action) => world.act(action, ""),
    screenshot: async () => new Uint8Array() };
  const screenDeps = { ...deps, perform: async (_hand: unknown, action: ScreenAction) => world.act(action, describeScreenAction(action)) };
  if (strategy === "pilot") {
    try {
      const pilot = createPilot({ ...screenDeps, contacts: CONTACTS, store: LEARNED, today: () => SIM_TODAY, open: async (_hand, url) => world.open(url) });
      const result = await pilot.run(SIM_HAND, task.said, LIMITS);
      status = result.status; reason = result.reason; intentBy = `${result.by}: ${result.detail}`;
      const taken = Math.round(performance.now() - started + m.virtualMs);
      await result.learning; // off the clock: it happens after the user has their result
      const { ok, why } = task.check(world);
      return { task: task.id, strategy, round, ok, why, status, reason, intentBy, ms: taken, meter: m, acted: world.acted, intent: null };
    } catch (error) { reason = error instanceof Error ? error.message : String(error); const { ok, why } = task.check(world); return { task: task.id, strategy, round, ok, why, status, reason, intentBy, ms: Math.round(performance.now() - started + m.virtualMs), meter: m, acted: world.acted, intent: null }; }
  }
  try {
    let start: string | null = null;
    if (strategy !== "today") {
      const built = await recipeIntent(jev, task.said, { today: SIM_TODAY, contacts: CONTACTS });
      if (built) { intent = built.intent; intentBy = `jev recipe ${built.recipe} (${built.confidence.toFixed(2)})`; start = strategy === "recipes" ? built.deepLink : null; }
    }
    if (!intent) { intent = await quickIntent(jev, task.said).catch(() => null); if (intent) intentBy = "jev quick"; }
    if (!intent) { intent = await parseIntent(model, task.said); intentBy = "llm"; }
    log(`intent by ${intentBy}: ${JSON.stringify({ url: start ?? intent.url, inputs: intent.inputs })}`);
    world.open(start ?? intent.url ?? "https://www.google.com/");

    const result = strategy === "today" || strategy === "intent"
      ? await runIntent(SIM_HAND, intent, deps, LIMITS)
      : await runScreens(SIM_HAND, intent, screenDeps, LIMITS);
    status = result.status; reason = result.reason;
    if (strategy === "today" || strategy === "intent") world.acted = result.steps.map((s) => s.did);
  } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  const { ok, why } = task.check(world);
  return { task: task.id, strategy, round, ok, why, status, reason, intentBy, ms: Math.round(performance.now() - started + m.virtualMs), meter: m, acted: world.acted, intent };
}

// ---------------------------------------------------------------- report

function report(runs: Run[]) {
  const cell = (s: string | number, w: number) => String(s).padEnd(w);
  console.log(`\n${cell("task", 19)}${cell("strategy", 9)}${cell("ok", 5)}${cell("status", 13)}${cell("looks", 6)}${cell("jev rq", 7)}${cell("rounds", 7)}${cell("llm", 5)}${cell("vision", 7)}${cell("actions", 8)}${cell("model s", 8)}intent by`);
  for (const r of runs) {
    console.log(`${cell(r.task, 19)}${cell(r.strategy, 9)}${cell(r.ok ? "yes" : "NO", 5)}${cell(r.status, 13)}${cell(r.meter.looks, 6)}${cell(r.meter.jevRequests, 7)}${cell(r.meter.jevRounds, 7)}${cell(`${r.meter.llm.filter((c) => c.what !== "general_plan").length}${r.meter.llm.some((c) => c.what === "general_plan") ? "+bg" : ""}`, 5)}${cell(r.meter.planner, 7)}${cell(r.acted.length, 8)}${cell((r.ms / 1000).toFixed(1), 8)}${r.intentBy.slice(0, 70)}${r.ok ? "" : `   <- ${r.why}${r.status === "done" ? "" : ` (${r.reason})`}`}`);
  }
  console.log(`\n${cell("strategy", 10)}${cell("solved", 9)}${cell("said done", 10)}${cell("jev rounds", 11)}${cell("llm calls", 10)}${cell("vision", 7)}${cell("model s/task", 13)}at 100 ms a round`);
  for (const s of STRATEGIES) {
    const mine = runs.filter((r) => r.strategy === s);
    if (!mine.length) continue;
    const mean = (f: (r: Run) => number) => mine.reduce((sum, r) => sum + f(r), 0) / mine.length;
    // Learning (general_plan) happens after the user has their result, so it is not on the clock.
    const onPath = (r: Run) => r.meter.llm.filter((c) => c.what !== "general_plan");
    const llmMs = (r: Run) => onPath(r).reduce((sum, c) => sum + c.ms, 0) + r.meter.virtualMs;
    console.log(`${cell(s, 10)}${cell(`${mine.filter((r) => r.ok).length}/${mine.length}`, 9)}${cell(`${mine.filter((r) => r.ok && r.status === "done").length}/${mine.length}`, 10)}${cell(mean((r) => r.meter.jevRounds).toFixed(1), 11)}${cell(mean((r) => onPath(r).length).toFixed(1), 10)}${cell(mean((r) => r.meter.planner).toFixed(1), 7)}${cell((mean((r) => r.ms) / 1000).toFixed(1), 13)}${((mean((r) => r.meter.jevRounds * 100 + llmMs(r))) / 1000).toFixed(1)} s`);
  }
}

// ---------------------------------------------------------------- CLI

if (import.meta.main) {
  const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const rounds = Number(flag("rounds") ?? 1), only = flag("only"), verbose = process.argv.includes("--verbose");
  const strategies = (flag("strategy")?.split(",") ?? [...STRATEGIES]) as Strategy[];
  const tasks = [...TASKS, ...BEYOND].filter((t) => (only ? only.split(",").some((o) => t.id.includes(o)) : !t.id.startsWith("beyond")));
  const ask = createJev(), llm = createOpenAI();
  await ask("ready", { ready: { type: "noul", instructions: "The text says ready." } }); // the first request opens the connection

  const runs: Run[] = [];
  for (let round = 1; round <= rounds; round++) for (const task of tasks) for (const strategy of strategies) {
    console.log(`\n[${round}] ${task.id} / ${strategy}: "${task.said}"`);
    const run = await runOne(task, strategy, round, ask, llm, verbose);
    runs.push(run);
    console.log(`    ${run.ok ? "solved" : "NOT solved"} (${run.why}); ${run.status}; ${run.meter.jevRounds} Jev rounds, ${run.meter.llm.length} LLM, ${run.meter.planner} vision, ${(run.ms / 1000).toFixed(1)} s`);
    if (verbose || !run.ok) for (const did of run.acted) console.log(`      - ${did}`);
  }
  report(runs);
  await Bun.write("out/jev-tasks-eval.json", JSON.stringify(runs, null, 2));
}
