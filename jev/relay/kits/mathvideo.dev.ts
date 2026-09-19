#!/usr/bin/env bun
// mathvideo.dev.ts — work on the templates without a run: check and build ANY script.json, no LLM involved.
//
//   bun jev/relay/kits/mathvideo.dev.ts build <script.json> [dir]    check it, render it into dir/video (default out/relay/dev-mathvideo)
//   bun jev/relay/kits/mathvideo.dev.ts review <script.json>         code's check, then Jev's per-scene review (live Jev), printed
//
// PUK_MATHVIDEO_ONLY=stills renders the stills alone (seconds, not minutes).

import { join } from "node:path";
import { createJev } from "../../jev";
import { workspace } from "../relay";
import { build, jevReview, problemsFrom } from "./mathvideo";
import { check, type Script } from "./mathvideo/src/script";

const [command, file, dir] = process.argv.slice(2);
if (!command || !file) { console.error("usage: bun jev/relay/kits/mathvideo.dev.ts build|review <script.json> [dir]"); process.exit(2); }
const text = await Bun.file(file).text();

if (command === "review") {
  const checked = check(JSON.parse(text));
  for (const p of checked.problems) console.log(`${p.hard ? "HARD" : "soft"} ${p.text}`);
  if (checked.script) {
    const t = performance.now(), verdicts = await jevReview(createJev(), checked.script as Script);
    console.log(`\nJev: ${verdicts.length} requests in ${Math.round(performance.now() - t)} ms`);
    for (const v of verdicts) console.log(`  ${v.id.padEnd(22)} ${v.template.padEnd(15)} picked ${v.picked.padEnd(15)} ${v.confidence.toFixed(2)}  matches ${v.matches.toFixed(2)}  numbers ${v.numbers?.toFixed(2) ?? " -  "}  one idea ${v.oneIdea.toFixed(2)}`);
    for (const p of problemsFrom(verdicts, checked.script as Script)) console.log(`JEV  ${p}`);
  }
} else {
  const ws = await workspace(dir ?? join(import.meta.dir, "..", "..", "..", "out", "relay", "dev-mathvideo"), (line) => console.log(`  ${line}`));
  await ws.write("video/script.json", text);
  const t = performance.now(), made = await build(ws);
  console.log(`${made.ok ? "ok" : "FAILED"} in ${Math.round((performance.now() - t) / 1000)} s\n${made.log}\n${made.outputs.join("\n")}`);
}
