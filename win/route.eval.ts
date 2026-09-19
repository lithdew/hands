#!/usr/bin/env bun
/**
 * Who does a request go to? `bun win/route.eval.ts`
 *
 * Real Jev, no desktop: the same triage questions and the same first tier of the pilot that
 * win/jev.ts uses, against a made-up list of installed applications. Written after "open
 * calculator" went to Google: quick.ts had answered "nothing to open, type calculator", the
 * pilot took that for understanding, and that switched the native path off.
 */
import { createJev } from "../jev/jev";
import { memoryStore } from "../jev/learned";
import { createPilot } from "../jev/pilot";
import { routeRequest, triageQuestions } from "./jev";

const ask = createJev(), never = async () => { throw new Error("routing needs no hand"); };
const pilot = createPilot({ ask, llm: never, approve: never, observe: never, perform: never, open: never, store: memoryStore(), contacts: [{ name: "Mom" }, { name: "Sam Rivera", email: "sam.rivera@example.com" }] });
const catalog = ["Calculator", "Paint", "Notepad", "Sticky Notes", "Spotify", "Excel", "Word", "Settings", "File Explorer", "Photos", "Clock", "Snipping Tool", "Visual Studio Code", "Microsoft Edge"].map((name) => ({ id: name.toLowerCase().replace(/\s+/g, "_"), name }));

/** Request, and every route that would be right for it. */
const CASES: [string, string][] = [
  ["open calculator", "native:calculator"], ["open paint", "native:paint"], ["can you open spotify", "native:spotify"], ["open notepad and write a haiku about autumn", "native:notepad"],
  ["draw a cat in paint", "native:paint"], ["draw me a sunset", "native:paint|vision"], ["write a short poem about my dog", "native:notepad|native:word|vision"], ["make a birthday card for my mom", "native:paint|native:word|vision"],
  ["play some jazz", "native:spotify|browser"], ["what is 15 percent of 240", "native:calculator|browser"], ["set a timer for ten minutes", "native:clock"], ["turn on dark mode", "native:settings|browser"], // as "browser" it needs a plan, and the planner answers that a browser cannot do it: vision agent
  ["open youtube", "browser"], ["search wikipedia for capybaras", "browser"], ["book a table at a steakhouse for two tomorrow at 7", "browser"], ["text mom I'll be there at six", "browser"],
  ["email sam to remind him about the meeting tomorrow at 10", "browser"], ["make a note for my doctor's appointment on Tuesday at 3pm", "browser"], ["find the cheapest flight to lisbon next friday", "browser"],
];

let right = 0;
for (const [said, want] of CASES) {
  const [answers, understood] = await Promise.all([ask({ request: said }, triageQuestions(catalog)), pilot.read(said).catch(() => null)]);
  const kind = { app: answers.app.choice as string, sure: answers.app.confidence, onlyOpen: answers.only_open.noul, wantsAnswer: answers.wants_answer.noul, creative: answers.creative.noul };
  const route = routeRequest(kind, understood?.by ?? null), got = route.to === "native" ? `native:${route.app}` : route.to;
  const good = want.split("|").includes(got);
  if (good) right++;
  console.log(`${good ? "ok  " : "MISS"} ${said.padEnd(60)} ${`${got}${route.to === "browser" ? ` (${understood?.by ?? "plan"})` : ""}`.padEnd(26)} app ${kind.app} ${kind.sure.toFixed(2)}, creative ${kind.creative.toFixed(2)}${good ? "" : `   wanted ${want}`}`);
}
console.log(`\n${right}/${CASES.length} routed right`);
