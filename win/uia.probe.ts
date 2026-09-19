#!/usr/bin/env bun
/**
 * Does UI Automation see, and act on, a window on a hidden virtual desktop? `bun win/uia.probe.ts [app ...]`
 *
 * Its own desktop ("Puk uia"), like win/bench.ts, so it runs next to a live server. Opens the named
 * applications there (default: Calculator, Notepad) and reads each one's tree with win/uia.cs. Where it is
 * harmless it also acts: a field in Character Map, never a document that may hold your text. It checks
 * that your focus and desktop never moved, then closes only the windows it opened and removes the desktop.
 */
import { createHelper, helper, windowsDesktop } from "./desktop";
import { ensureUia } from "./uia";

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ["Calculator", "Notepad"];
const ask = (await helper()).ask, uia = createHelper(await ensureUia());
const hand = { id: 97, pid: process.pid, display: "Puk uia", width: 1280, height: 800 };
type Node = { n: number; role: string; name: string; value: string; within: string; editable: boolean; setValue: boolean; can: string; rect: number[] };
type Dump = { elements: Node[]; texts: string[]; seen: number; ms: number };
const tree = async (hwnd: number) => JSON.parse(await uia.ask(`tree ${hwnd}`)) as Dump;

await ask("ensure Puk uia");
const focus = await ask("fg"), where = await ask("where");
const mine = new Set<number>();
try {
  const catalog = await windowsDesktop.discover();
  for (const name of wanted) {
    const app = catalog.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? catalog.find((a) => a.name.toLowerCase().includes(name.toLowerCase()));
    if (!app) { console.log(`\n${name}: not installed`); continue; }
    const before = new Set((JSON.parse(await ask("state Puk uia")).windows as { containerId: number }[]).map((w) => w.containerId));
    const started = performance.now();
    await windowsDesktop.launch(hand, app);
    const window = (JSON.parse(await ask("state Puk uia")).windows as { containerId: number; title: string; cloaked?: number }[]).find((w) => !before.has(w.containerId));
    if (!window) { console.log(`\n${app.name}: no window appeared`); continue; }
    mine.add(window.containerId);
    console.log(`\n== ${app.name}: window ${window.containerId} "${window.title}" after ${Math.round(performance.now() - started)} ms, cloaked=${window.cloaked}`);

    let dump = await tree(window.containerId);
    const again = await tree(window.containerId);
    console.log(`   tree: ${dump.elements.length} controls of ${dump.seen} nodes, ${dump.texts.length} texts, ${dump.ms} ms first read, ${again.ms} ms second`);
    for (const el of dump.elements.slice(0, 40)) console.log(`     n${el.n} ${el.role} ${JSON.stringify(el.name)}${el.value ? ` = ${JSON.stringify(el.value.slice(0, 40))}` : ""}${el.within ? ` in ${JSON.stringify(el.within)}` : ""} [${el.can}${el.setValue ? " set" : ""}]`);
    if (dump.elements.length > 40) console.log(`     ... ${dump.elements.length - 40} more`);
    console.log(`   texts: ${JSON.stringify(dump.texts.slice(0, 6))}`);

    if (/calc/i.test(app.name)) {
      for (const label of ["Five", "Plus", "Three", "Equals"]) {
        const el = dump.elements.find((e) => e.name === label);
        const t = performance.now();
        console.log(`   press ${label}: ${el ? await uia.ask(`act ${window.containerId} ${el.n} invoke`) : "no such button"} (${Math.round(performance.now() - t)} ms)`);
      }
      dump = await tree(window.containerId);
      console.log(`   display now: ${JSON.stringify(dump.texts.filter((x) => /display|expression/i.test(x)))}`);
    }
    if (/paint/i.test(app.name)) {
      // A tool is a toggle or a selection: nothing is drawn, nothing is saved.
      const tool = dump.elements.find((e) => /^(Fill|Eraser|Text)$/i.test(e.name) && e.can);
      if (tool) {
        const t = performance.now();
        console.log(`   choose ${tool.name} (${tool.can}): ${await uia.ask(`act ${window.containerId} ${tool.n} ${tool.can}`)} (${Math.round(performance.now() - t)} ms)`);
        const after = (await tree(window.containerId)).elements.find((e) => e.name === tool.name);
        console.log(`   ${tool.name} is now: ${JSON.stringify(after?.value)} (was ${JSON.stringify(tool.value)})`);
      }
    }
    if (/character map/i.test(app.name)) {
      // A harmless field: nothing of the user's lives in it, and nothing is saved.
      const box = dump.elements.find((e) => e.setValue);
      if (box) {
        const t = performance.now();
        console.log(`   set ${JSON.stringify(box.name)}: ${await uia.ask(`set ${window.containerId} ${box.n} ${Buffer.from("abc").toString("base64")}`)} (${Math.round(performance.now() - t)} ms)`);
        console.log(`   it now holds: ${JSON.stringify((await tree(window.containerId)).elements.find((e) => e.name === box.name)?.value)}`);
      }
    }
    if (/notepad/i.test(app.name)) {
      // Notepad restores unsaved tabs from earlier sessions. Only an empty, untitled document is written to, and it is emptied again.
      const doc = dump.elements.find((e) => e.editable);
      if (!doc || doc.value !== "" || !/^Untitled/i.test(window.title)) console.log(`   not writing: ${doc ? "the document is not an empty untitled one (it may be yours)" : "no editable control"}`);
      else {
        const t = performance.now();
        console.log(`   set text: ${await uia.ask(`set ${window.containerId} ${doc.n} ${Buffer.from("buy oat milk and eggs").toString("base64")}`)} (${Math.round(performance.now() - t)} ms)`);
        dump = await tree(window.containerId);
        const now = dump.elements.find((e) => e.editable);
        console.log(`   document now: ${JSON.stringify(now?.value)}`);
        if (now) console.log(`   emptied again: ${await uia.ask(`set ${window.containerId} ${now.n} -`)}`);
      }
    }
    const stillThere = (JSON.parse(await ask("state Puk uia")).windows as { containerId: number }[]).some((w) => w.containerId === window.containerId);
    console.log(`   the window is still on its own desktop: ${stillThere}`);
  }
  console.log(`\nyour focus was kept: ${(await ask("fg")) === focus}, you stayed on: ${(await ask("where")) === where}`);
} finally {
  // Asked to close, never killed, and only what this run opened: a process can host other apps' windows too.
  for (const hwnd of mine) await ask(`close ${hwnd}`).catch(() => {});
  await Bun.sleep(800);
  await ask("remove Puk uia").catch(() => {});
  uia.close(); (await helper()).close();
  process.exit(0);
}
