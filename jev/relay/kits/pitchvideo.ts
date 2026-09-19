// kits/pitchvideo.ts — a hackathon pitch video for the project itself, rendered with Remotion, every claim traceable.
//
// Who does what (the relay's point, for this task):
//   LLM    plans; reads the passages Jev kept and keeps notes; writes the script (scenes, words, which claims);
//          mends it when the review says exactly what is wrong
//   JEV    sifts EVERY passage of the repository's documents against each research goal (four hundred, sixty to a
//          request, the steps side by side); then, on the written script: every claim against its cited passage,
//          every sentence against the scene's claims, each scene's template and each card's icon from closed sets,
//          and the passage that does support a claim whose citation does not (pitchvideo/review.ts)
//   code   splits the documents into addressed passages (pitchvideo/docs.ts), checks every figure against its
//          source, sets each scene's seconds from its words, drops what stays unverified, assembles claims.md with
//          the passages quoted from the files themselves (pitchvideo/script.ts, review.ts), and renders
//          (pitchvideo/render.ts, pitchvideo/remotion)
//
// Nothing about the product is written here. The templates are generic pitch-video building blocks; which
// claims, what narration and which scenes come from the run reading the repository's documents.

import { join } from "node:path";
import type { JsonSchema } from "../../openai";
import type { Kit } from "../relay";
import type { Result } from "../web";
import { address, repoDocs, type Passage } from "./pitchvideo/docs";
import { build } from "./pitchvideo/render";
import { review } from "./pitchvideo/review";
import { LIMITS, TEMPLATES, WPM } from "./pitchvideo/script";

const ROOT = join(import.meta.dir, "..", "..", "..");
let docs: ReturnType<typeof repoDocs> | null = null;
const library = () => (docs ??= repoDocs(ROOT));
export const passageIndex = async (): Promise<Passage[]> => (await library()).flatMap((d) => d.passages);

const FORMAT = `{
  "title": "<the product's name>", "tagline": "<one line>",
  "scenes": [ {
    "id": "<short-kebab-id>", "template": "<one of the templates below>", "kicker": "<one to three words naming the part of the pitch>",
    "headline": "<the scene's line on screen, at most ${LIMITS.headline} characters>",
    "narration": "<what is said over the scene, ${LIMITS.sceneWords[0]} to ${LIMITS.sceneWords[1]} words>",
    "claims": [ { "text": "<one fact the scene states, restating plainly what ONE passage says, with its own figures and scope>", "sources": ["<file.md:line, exactly as the notes and sources give the address>"] } ],
    ...the template's own fields } ] }
Templates (a closed set) and their fields:
${Object.entries(TEMPLATES).map(([name, what]) => `  "${name}": ${what}`).join("\n")}
  title    -> "sub": one line under the name. Used once, as the opening
  problem  -> "pains": two or three of { "title", "detail" }
  stat     -> "stat": { "value": the figure alone, at most 9 characters ("98%", "5.6", "18/18"), "label": what it measures, "scope": on what and how it was measured }
  compare  -> "metric": what is measured; "before": { "value", "label" }; "after": { "value", "label" } (values are figures alone, the same metric twice)
  how      -> "steps": three or four of { "title", "role", "detail" }, in the order work flows
  list     -> "items": three to six of { "title", "detail" }
  demo     -> "task": a request in the user's words; "actions": three to five short things the worker then does, in order; "result": how it ends
  close    -> "ask": what is asked of the audience; "points": up to three short things to remember. Used once, as the last scene
Card titles are at most 30 characters and details at most 110. Icons and seconds are not yours to write: Jev picks each card's icon and code sets each scene's seconds from its narration.`;

const BRIEF = `DELIVERABLES: video/script.json (written in the write step), video/claims.md (assembled by this kit's code from the claims inside script.json, with each source passage quoted from the repository's file: plan no step for it and never write it), video/out.mp4 and video/stills/*.png (rendered by the build step from script.json with Remotion).
PLANNING: research here reads THIS REPOSITORY'S OWN DOCUMENTS (its READMEs and evaluation reports), never the web; queries are not used. The kit supplies the documents as some four hundred passages, each with an address such as docs/report.md:57, and a fast reader scores every passage against the step's goal, so a goal names ONE kind of passage, narrowly. Plan four research steps that do not need each other: (1) what the product is and the problem it answers for its user; (2) how it works: each model or component, which kind of decision it takes, how many of them and how fast, what is left to the slower models and how often, and where the work runs while the user keeps working; (3) its strongest measured results from its evaluations: whole tasks solved and with how few model calls and how little time, accuracy before and after a design change, time per request, each with what was measured, on what, and how many cases; (4) what it has demonstrably done live on real applications, and how that was confirmed. Then exactly ONE write step that needs all four and writes video/script.json, then ONE build step.
THE SCRIPT is a pitch as for a hackathon jury, spoken by the team about its own project: a hook, the problem, what the product is, how it works (who decides what and how fast, what is left to the slower models, and where the work happens), then the proof, one task shown being done, and a close with an ask. Choose the proof by strength: whole tasks finished, with how few model calls and how little time; a before-and-after gain from a design decision; live runs on real applications. One figure to a scene, never generic praise, and not a scene of limitations. ${LIMITS.scenes[0]} to ${LIMITS.scenes[1]} scenes, ${LIMITS.words[0]} to ${LIMITS.words[1]} words of narration in all (the video runs at ${WPM} words a minute, so that is a minute and a half to two minutes). The narration is shown as captions: write it to be read aloud, in plain confident sentences ("we", the product's name, active verbs). Be honest through precision, not through hedging: say "on simulated apps" or "on 12 held-out synthetic screens" where that is the scope, and never talk about "the documents", "the repository" or "the evidence" in the narration.
HONESTY RULES, checked after you write by code and by a literal-minded model, claim by claim: (1) every figure and every capability said in a scene's narration or shown on its screen is backed by one of THAT scene's claims; (2) a claim's "sources" are passage addresses copied exactly (file.md:line), and the claim restates what that one passage says, close to its wording: two facts from two passages are two claims; (3) figures are written as digits exactly as the source writes them, and no figure is computed (no differences, ratios, "x times faster", rounded totals) unless the source itself states it; (4) scope is kept: what was measured on simulated apps, synthetic screens, a handful of cases or one machine is said to be so, in the claim and in the scene; (5) what cannot be tied to a passage is left out of the video, not kept with a caveat. A scene that states no fact (a hook that is a question, the ask) has an empty "claims" list.
FORMAT of video/script.json:
${FORMAT}`;

const MEND_SCHEMA: JsonSchema = { name: "script", schema: { type: "object", additionalProperties: false, required: ["script_json"], properties: { script_json: { type: "string" } } } };

export const pitchvideo: Kit = {
  name: "pitchvideo",
  brief: BRIEF,
  web: false, inHand: 110,
  reading: `Each SOURCE is one passage of the repository's documents and its address (such as docs/report.md:57) is the address to put after every fact taken from it, exactly; never a bare file name. Copy every figure with its unit, with what it counts, and with the conditions it was measured under (simulated or real, how many cases, which machine), in the source's own words, and keep a limit the authors state next to the result it qualifies.`,
  // The repository's documents, passage by passage: each arrives with its text, so nothing is fetched and Jev scores every one of them against the goal.
  sources: async (): Promise<Result[]> => (await passageIndex()).map((p) => ({ title: `${p.file}, ${p.heading.split(" > ").pop() ?? ""}`.slice(0, 90), url: address(p), snippet: p.text.slice(0, 380), text: p.text })),
  // Only this repository speaks in a pitch of it: whatever else a search brought is dropped.
  gather: async (results) => { const mine = new Set((await passageIndex()).map(address)); return results.filter((r) => mine.has(r.url)); },
  review: async (ctx) => {
    const t = performance.now();
    const r = await review(ctx.ws, ctx.ask, await passageIndex(), async (script, problems) => ((await ctx.llm("mend:script", { model: ctx.deepModel, effort: "low", schema: MEND_SCHEMA, user: JSON.stringify({ your_script_as_it_stands: script, wrong_with_it: problems, notes: ctx.ws.notes }), system:
      `You wrote video/script.json, and it was checked claim by claim against the passages it cites. ${BRIEF}
Mend exactly what is listed as wrong and keep everything else word for word: the rest was checked and holds. Where a claim says more than one passage does, split it or reword it to what the passage says; where nothing in the notes supports a sentence, a card or a figure, take it out. Answer with the whole file, as JSON text, in "script_json".` })) as { script_json: string }).script_json);
    for (const note of r.notes) ctx.log(`review: ${note}`);
    for (const d of r.dropped) ctx.log(`review: dropped by code, ${d}`);
    ctx.log(`review: ${r.checks.filter((c) => c.ok).length}/${r.checks.length} claims hold, ${r.statements.length} sentences and cards checked; ${r.jev.questions} questions to Jev in ${r.jev.requests} requests; mended ${r.mends} times; ${r.problems.length} problems left; ${Math.round(performance.now() - t)} ms`);
    return r.problems;
  },
  // PUK_PITCH_ONLY=stills renders the stills alone (under a minute): for working on the script without paying for the video each time.
  build: (ws) => build(ws, process.env.PUK_PITCH_ONLY === "stills" || process.env.PUK_PITCH_ONLY === "video" ? { only: process.env.PUK_PITCH_ONLY } : {}),
};
