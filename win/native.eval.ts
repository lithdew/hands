#!/usr/bin/env bun
/**
 * Jev drives a native application on a desktop nobody is looking at. `bun win/native.eval.ts`
 *
 * LIVE: opens Paint and Character Map on their own virtual desktop ("Puk uia"), like win/bench.ts, so it
 * runs next to a live server. One text plan (jev/plan.ts, told which application is open), then
 * jev/screen.ts `runScreens` with win/uia.ts as its eyes and hands. Success is read back from the
 * application itself. Nothing is saved, anything the gate flags is declined, and only the windows this
 * run opened are closed (asked to, never killed).
 */
import { createJev } from "../jev/jev";
import { createOpenAI } from "../jev/openai";
import { planTasks } from "../jev/plan";
import { describeScreenAction, runScreens, type ScreenAction } from "../jev/screen";
import { frontOf, helper, windowsDesktop } from "./desktop";
import { observeNative, performNative, releaseNative } from "./uia";

/** Which desktop the user is on and what has their focus. Printed after every phase: a hand must never move either. */
const whereAmI = async (phase: string) => console.log(`   [${phase}] desktop ${await ask("where")}, focus ${await ask("fg")}`);
const only = process.argv.slice(2).map((a) => a.toLowerCase());

const TASKS: { app: string; said: string; done(texts: string, elements: { name: string; value: string }[]): boolean }[] = [
  // A UWP application: frozen by Windows while hidden until win/uia.ts wakes it. Six keys, mapped in one Jev request.
  { app: "Calculator", said: "type in 12*31", done: (texts) => /Display is 372/.test(texts) },
  { app: "Paint", said: "make red the main colour", done: (_t, els) => els.some((e) => /^Color 1: Red/i.test(e.name)) },
  { app: "Character Map", said: "put the word hello in the characters to copy box", done: (_t, els) => els.some((e) => /characters to copy/i.test(e.name) && e.value === "hello") },
];

const ask = (await helper()).ask, jev = createJev(), llm = createOpenAI();
const hand = { id: 97, pid: process.pid, display: "Puk uia", width: 1280, height: 800 };
await ask("ensure Puk uia");
const before = { fg: await ask("fg"), where: await ask("where") };
const mine = new Set<number>();
let requests = 0;
async function cleanUp() {
  await releaseNative(hand).catch(() => {});
  for (const hwnd of mine) await ask(`close ${hwnd}`).catch(() => {});
  await Bun.sleep(800);
  await ask("remove Puk uia").catch(() => {});
}
// Whatever hangs, the windows this run opened are closed and its desktop is removed.
const watchdog = setTimeout(() => { console.log("\ntook too long: cleaning up"); void cleanUp().finally(() => process.exit(3)); }, 150_000);
const counted = (async (state, questions, options) => { requests++; return jev(state, questions, options); }) as typeof jev;
try {
  const catalog = await windowsDesktop.discover();
  for (const task of TASKS.filter((t) => !only.length || only.some((o) => t.app.toLowerCase().includes(o)))) {
    await whereAmI("before launch");
    const app = catalog.find((a) => a.name.toLowerCase() === task.app.toLowerCase());
    if (!app) { console.log(`\n${task.app}: not installed`); continue; }
    const already = new Set((JSON.parse(await ask("state Puk uia")).windows as { containerId: number }[]).map((w) => w.containerId));
    await windowsDesktop.launch(hand, app);
    await Bun.sleep(600);
    // A UWP application is two windows, and it is the frame that closes it: everything new is this run's to close.
    for (const w of JSON.parse(await ask("state Puk uia")).windows as { containerId: number }[]) if (!already.has(w.containerId)) mine.add(w.containerId);
    const front = await frontOf(hand);
    if (!front) { console.log(`\n${task.app}: no window`); continue; }
    mine.add(front.containerId);
    console.log(`\n== ${task.app}: "${task.said}"`);
    await whereAmI("after launch");
    try {
    const started = performance.now();
    requests = 0;
    const [planned] = await planTasks(llm, task.said, { today: new Date(), contacts: [], app: app.name });
    const planMs = Math.round(performance.now() - started);
    console.log(`   plan (${planMs} ms): ${JSON.stringify(planned!.intent.steps)} inputs ${JSON.stringify(planned!.intent.inputs)}${planned!.intent.presses ? ` presses ${JSON.stringify(planned!.intent.presses)}` : ""}`);
    const result = await runScreens({ ...hand, width: front.rect[2], height: front.rect[3] }, planned!.intent, {
      ask: counted, llm, settleMs: 150, log: (line) => console.log(`   ${line.slice(0, 200)}`), screenshot: async () => new Uint8Array(),
      observe: async () => { const seen = await observeNative(hand); await whereAmI("after a look"); return seen; },
      perform: async (_h, action: ScreenAction) => { console.log(`   -> ${describeScreenAction(action).split(" in window")[0]}`); await performNative(hand, action); await whereAmI("after the action"); },
      approve: async ({ action }) => { console.log(`   declined (nobody is here to approve): ${action}`); return false; },
    }, { maxSteps: 8, maxPlans: 0 });
    const seen = await observeNative(hand);
    console.log(`   ${result.status} (${result.reason.slice(0, 100)}); ${requests} Jev requests; ${((performance.now() - started) / 1000).toFixed(1)} s in all, ${((performance.now() - started - planMs) / 1000).toFixed(1)} s after the plan`);
    console.log(`   the application says it is done: ${task.done(seen.texts.join("\n"), seen.elements)}`);
    } catch (error) { console.log(`   failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const after = { fg: await ask("fg"), where: await ask("where") };
  console.log(`\nfocus before ${before.fg} after ${after.fg}; desktop before ${before.where} after ${after.where}`);
} finally {
  clearTimeout(watchdog);
  await cleanUp();
  (await helper()).close();
  process.exit(0);
}
