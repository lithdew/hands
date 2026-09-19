#!/usr/bin/env bun
// review.eval.ts — how well does Jev tell a claim its passage supports from one it does not?
//
//   bun jev/relay/kits/pitchvideo/review.eval.ts        real Jev, two requests; passages are read from this repository
//
// The cases are test data about this repository's documents, written to be right or wrong on purpose.
// They are not the pitch: the pitch's claims come from a run.

import { createJev } from "../../../jev";
import { repoDocs, resolve } from "./docs";
import { claimVerdict, coverQuestions, supportQuestions, THRESHOLDS } from "./review";
import { numbersMissing } from "./script";

const CLAIMS: [holds: boolean, claim: string, sources: string[]][] = [
  [true, "On simulated apps, the nine everyday tasks were solved 9/9 with 5.6 Jev round trips, 0.1 LLM calls on the path and 2.3 s of model time.", ["jev/README.md:180"]],
  [true, "On 141 single decisions, offering elements once in state with ids and a question that says what a match is scored 98%, against 78% for the old decide.", ["jev/README.md:107", "jev/README.md:101"]],
  [true, "A warm Jev request is about 330 ms from this machine.", ["jev/README.md:29"]],
  [true, "In Paint and Character Map on a hidden desktop, each task took one plan, one look, one action and 3 Jev requests, about 3 s after the plan, with the user's desktop and focus unchanged.", ["win/README.md:92"]],
  [true, "Each hand is a Windows virtual desktop, and you keep your desktop, pointer and keyboard.", ["win/README.md:29"]],
  [true, "The previews never take focus.", ["win/README.md:46"]],
  [true, "On 12 held-out synthetic screens repeated three times, the production evidence contract passed 36/36 checks versus 33/36 for the baseline.", ["docs/jev-evals.md:3"]],
  [true, "The recipes intent builder got 33 of 34 phrasings right at the first attempt, in 351 ms.", ["jev/README.md:62"]],
  [true, "An email went from 12 round trips to 6 with one request per screen.", ["jev/README.md:72"]],
  [false, "Hands solves every real-world task with 5.6 round trips.", ["jev/README.md:180"]],
  [false, "98% of real Gmail tasks are completed successfully.", ["jev/README.md:107"]],
  [false, "Hands drives every Windows application in the background, including Calculator and Settings.", ["win/README.md:92"]],
  [false, "Hands is ten times faster than any other computer-use agent.", ["jev/README.md:44"]],
  [false, "The nine everyday tasks were solved 9/9 on real Gmail and OpenTable accounts.", ["jev/README.md:180", "jev/README.md:37"]],
  [false, "Users reported saving two hours a day with Hands.", ["README.md:3"]],
  [false, "The evidence contract passed 36/36 held-out checks, which proves that whole tasks complete reliably.", ["docs/jev-evals.md:3"]],
  [false, "Native canvases such as Paint can be drawn on from the background.", ["win/README.md:172"]],
  [false, "Hands works on macOS.", ["README.md:106"]],
];
const COVER: [covered: boolean, sentence: string, claims: string[]][] = [
  [true, "Each hand works on its own virtual desktop, so your screen stays yours.", ["Each hand is a Windows virtual desktop, and you keep your desktop, pointer and keyboard."]],
  [true, "What if your computer had more hands?", []],
  [true, "Give it a try and tell us what breaks.", ["The previews never take focus."]],
  [true, "Nine everyday tasks, 9 of 9 solved, in 5.6 Jev round trips.", ["On simulated apps, the nine everyday tasks were solved 9/9 with 5.6 Jev round trips, 0.1 LLM calls on the path and 2.3 s of model time."]],
  [false, "It also books flights and files your taxes.", ["Each hand is a Windows virtual desktop, and you keep your desktop, pointer and keyboard."]],
  [false, "Every action is checked by a separate safety gate before it runs.", ["A warm Jev request is about 330 ms from this machine."]],
  [false, "Hands learns a new recipe after a plan has worked.", []],
];

const ask = createJev(), index = (await repoDocs(`${import.meta.dir}/../../../..`)).flatMap((d) => d.passages);
const cases = CLAIMS.map(([holds, claim, sources]) => ({ holds, claim, passage: sources.flatMap((s) => resolve(index, s)).map((p) => p.text).join(" ") }));
const t = performance.now();
const [a, b] = await Promise.all([
  ask({ task: "eval" }, Object.fromEntries(cases.flatMap((c, i) => { const q = supportQuestions(c.claim, c.passage); return [[`s${i}`, q.supported], [`x${i}`, q.inflated]]; }))) as unknown as Promise<Record<string, { noul: number }>>,
  ask({ task: "eval" }, Object.fromEntries(COVER.flatMap(([, sentence, claims], i) => { const q = coverQuestions(sentence, claims); return [[`f${i}`, q.says], [`c${i}`, q.covered]]; }))) as unknown as Promise<Record<string, { noul: number }>>,
]);
console.log(`two requests, ${Math.round(performance.now() - t)} ms\n`);
let right = 0;
cases.forEach((c, i) => { const missing = numbersMissing(c.claim, c.passage), ok = claimVerdict(a[`s${i}`]!.noul, a[`x${i}`]!.noul, missing); if (ok === c.holds) right++; console.log(`${ok === c.holds ? "  " : "XX"} ${c.holds ? "holds " : "wrong "} supported ${a[`s${i}`]!.noul.toFixed(2)} inflated ${a[`x${i}`]!.noul.toFixed(2)} ${missing.length ? `numbers missing ${missing.join(",")} ` : ""}| ${c.claim.slice(0, 90)}${c.passage ? "" : "  (NO PASSAGE)"}`); });
console.log(`\nclaims: ${right}/${cases.length} judged as intended (thresholds ${JSON.stringify(THRESHOLDS)})\n`);
let covered = 0;
COVER.forEach(([want, sentence], i) => { const flagged = b[`f${i}`]!.noul >= THRESHOLDS.says && b[`c${i}`]!.noul < THRESHOLDS.covered; if (flagged !== want) covered++; console.log(`${flagged !== want ? "  " : "XX"} ${want ? "fine   " : "uncovered"} says ${b[`f${i}`]!.noul.toFixed(2)} covered ${b[`c${i}`]!.noul.toFixed(2)} | ${sentence}`); });
console.log(`\nsentences: ${covered}/${COVER.length} judged as intended`);
