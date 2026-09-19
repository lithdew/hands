#!/usr/bin/env bun
/**
 * Time real tasks on a private desktop: `bun win/bench.ts "go to youtube" "open paint"`.
 *
 * Uses its own virtual desktop ("Puk bench"), not a hand, so it can run next to a
 * live `win/serve.ts`. Nobody is there to approve, so a paused action is declined.
 * `PUK_DEBUG=1 ... 2> out/win/bench.log` adds every Jev request and look with its cost.
 */
import { helper, warmBrowser, windowsDesktop } from "./desktop";
import { createJevFirstAgent } from "./jev";

const tasks = process.argv.slice(2);
if (!tasks.length) { console.log('usage: bun win/bench.ts "<task>" ["<task>" ...]'); process.exit(2); }
const ask = (await helper()).ask;
await ask("ensure Puk bench");
const hand = { id: 99, pid: process.pid, display: "Puk bench", width: 1280, height: 800 };
const focus = await ask("fg");
await Promise.all([windowsDesktop.discover(), warmBrowser(hand)]);
const agent = await createJevFirstAgent({ hand });
try {
  for (const task of tasks) {
    const started = performance.now(), running = agent.prompt(task);
    const decline = setInterval(() => {
      const waiting = agent.status().approval;
      if (waiting) { console.log(`   declined: ${JSON.stringify(waiting.args)} (${waiting.reason})`); agent.approve(waiting.id, false); }
    }, 300);
    await running; await agent.idle(); clearInterval(decline);
    const status = agent.status(), first = status.events[0]?.time ?? 0;
    console.log(`\n"${task}"  ${((performance.now() - started) / 1000).toFixed(1)} s, finished by ${status.model}${status.error ? `, error: ${status.error}` : ""}`);
    for (const event of status.events) console.log(`   +${((event.time - first) / 1000).toFixed(1).padStart(5)}s  ${event.text.slice(0, 140)}`);
    if (status.text) console.log(`   = ${status.text.replace(/\s+/g, " ").slice(0, 200)}`);
  }
  console.log(`\nyour focus was kept: ${(await ask("fg")) === focus}, you stayed on ${await ask("where")}`);
} finally {
  await agent.close();
  // Windows are asked to close, never killed: a process can host other apps' windows too.
  for (const window of JSON.parse(await ask("state Puk bench")).windows as { containerId: number }[]) await ask(`close ${window.containerId}`);
  await Bun.sleep(600);
  await ask("remove Puk bench");
  (await helper()).close();
  process.exit(0);
}
