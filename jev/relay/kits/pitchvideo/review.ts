// review.ts — after the writer, before the render: is every claim in the script true to its source?
//
// The writer (an LLM) hands over video/script.json. This is the hand back to Jev and to code:
//
//   code   the script's shape, each scene's seconds from its words, and that every number on screen
//          or in the narration stands in a passage the scene cites (script.ts)
//   JEV    for EVERY claim, in bulk: does the cited passage state it, does the claim say more than the
//          passage; for every sentence and card: does it state a fact, and is that fact among the scene's
//          claims; for every scene: which template its content is (from the closed set); for every card:
//          its icon (from the closed set); and for a claim whose source does not hold, which passage of
//          the repository does (a choice over the candidates, then checked like any other)
//   LLM    mends what was found, shown its own script and exactly what is wrong with it (at most MENDS times)
//   code   as the last resort drops what still cannot be tied to a source line: the claim, and the sentences
//          that then state something no claim covers. It writes back the script with seconds, icons and
//          repaired sources, and assembles video/claims.md with each passage quoted from the file itself,
//          so a quotation cannot be misremembered and nothing unverified is left in the video
//
// What is still wrong after that goes back to the relay's writer in words it can act on.

import { choice, noul, type Ask, type Questions } from "../../../jev";
import type { Workspace } from "../../relay";
import { address, resolve, type Passage } from "./docs";
import { ICONS, TEMPLATES, WPM, numbersIn, numbersMissing, parseScript, sentencesOf, shownText, timing, words, type Card, type Claim, type Icon, type Scene, type Script } from "./script";

export type ClaimCheck = { scene: string; claim: Claim; passages: Passage[]; missing: string[]; supported: number; inflated: number; repaired?: string; ok: boolean };
export type Statement = { scene: Scene; text: string; narrated: boolean; says: number; covered: number };
export type Inspection = { problems: string[]; notes: string[]; checks: ClaimCheck[]; statements: Statement[]; templates: { scene: string; wrote: string; jev: string; confidence: number }[] };
export type Reviewed = Inspection & { script?: Script; mends: number; dropped: string[]; jev: { requests: number; questions: number } };
/** Asked to mend: the script as it stands and what is wrong with it; answers the whole script again, or null. */
export type Mend = (script: string, problems: string[]) => Promise<string | null>;

/** One answer, read by the kind of question it answers: a Noul has `noul`, a Choice has `choice` and `confidence`. The contract is checked in jev.ts. */
type Answer = { noul: number; choice: string; confidence: number };

export const THRESHOLDS = { supported: 0.5, inflated: 0.7, says: 0.7, covered: 0.35 };
const SUPPORTED = THRESHOLDS.supported, SAYS = THRESHOLDS.says, COVERED = THRESHOLDS.covered, SWITCH = 0.75, REQUEST_BYTES = 45_000, MENDS = 2;
/** A claim holds when every figure of it is in the passage (code) and Jev finds it supported and not inflated. */
export const claimVerdict = (supported: number, inflated: number, missing: string[]) => missing.length === 0 && supported >= SUPPORTED && inflated < THRESHOLDS.inflated;
const quote = (s: string, n = 600) => JSON.stringify(s.length > n ? `${s.slice(0, n)}…` : s);
const textOf = (ps: Passage[]) => ps.map((p) => p.text).join(" ");
/** The passage as Jev reads it: with the document and section it stands under, because "A voice-driven agent" says what it is about only under its heading. */
const inContext = (ps: Passage[]) => ps.map((p, i) => `${i && ps[i - 1]!.file === p.file && ps[i - 1]!.heading === p.heading ? "" : `(${p.file}, under the headings "${p.heading}") `}${p.text}`).join(" ");
/** Items in groups whose questions stay under what one Jev request takes (a request of 139 KB was refused, one of 73 KB was not: docs/jev-evals.md). Groups go out side by side. */
export function batches<T>(items: T[], bytes: (item: T) => number, max = REQUEST_BYTES): T[][] {
  const out: T[][] = [];
  let size = 0;
  for (const item of items) { const b = bytes(item); if (!out.length || size + b > max) { out.push([]); size = 0; } out[out.length - 1]!.push(item); size += b; }
  return out;
}
const sizeOf = (q: unknown) => JSON.stringify(q).length;

/** Which passages could hold this claim: those with all its numbers, else those sharing the most of its words. */
export function candidates(index: Passage[], claim: string, max = 40): Passage[] {
  const withNumbers = numbersIn(claim).length ? index.filter((p) => numbersMissing(claim, p.text).length === 0) : [];
  if (withNumbers.length) return withNumbers.slice(0, max);
  const wanted = new Set(claim.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  return index.map((p) => ({ p, n: (p.text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => wanted.has(w)).length })).filter((x) => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, max).map((x) => x.p);
}

export const supportQuestions = (claim: string, passage: string) => ({
  supported: noul(`The passage states what the claim states. The claim: ${quote(claim, 400)}. The passage: ${quote(passage, 1600)}`, {
    true: "Each thing the claim says is said in the passage, in the same or other words, with the same figures.", false: "The passage does not say it, says something else, or is about another thing." }),
  inflated: noul(`The claim says more than the passage does. The claim: ${quote(claim, 400)}. The passage: ${quote(passage, 1600)}`, {
    true: "The claim has a larger figure, a wider scope (every app, always, real users) or more certainty than the passage, or leaves out a limit the passage states that changes what the figure means.", false: "The claim stays within what the passage says." }),
});

export const coverQuestions = (sentence: string, claims: string[]) => ({
  says: noul(`This sentence from a product video tells the viewer a fact about the product: something it does, how it works, or a result that was measured. The sentence: ${quote(sentence, 400)}`, { true: "It asserts a capability, a mechanism or a figure.", false: "It is a question, a greeting, a name, a description of a general problem, a transition, or a request to the audience." }),
  covered: noul(`What the sentence says about the product is also said by the listed claims. The sentence: ${quote(sentence, 400)}. The claims: ${quote(claims.join(" | ") || "(none)", 1400)}`, { true: "The claims say it, in the same or other words.", false: "The sentence asserts a capability, mechanism or figure that no listed claim states." }),
});

const cardsOf = (s: Scene): Card[] => [...(s.pains ?? []), ...(s.steps ?? []), ...(s.items ?? [])];
const uncovered = (st: Statement) => st.says >= SAYS && st.covered < COVERED;

/** One look at a script: what code can count and what Jev can judge, all of it at once. Sets seconds, icons and repaired sources on the script; writes nothing. */
export async function inspect(script: Script, shape: string[], asked: (questions: Questions) => Promise<Record<string, Answer>>, index: Passage[]): Promise<Inspection> {
  const problems = [...shape], notes: string[] = [], scenes = script.scenes.filter((s) => s && Object.hasOwn(TEMPLATES, s.template));
  problems.push(...timing(script).problems);

  // -- every claim against the passage cited for it: numbers by code, meaning by Jev, all claims at once
  const checks: ClaimCheck[] = scenes.flatMap((s) => s.claims.map((claim) => { const passages = [...new Set(claim.sources.flatMap((src) => resolve(index, src)))]; return { scene: s.id, claim, passages, missing: passages.length ? numbersMissing(claim.text, textOf(passages)) : [], supported: 0, inflated: 0, ok: false }; }));
  const judge = async (list: ClaimCheck[]) => { await Promise.all(batches(list.filter((c) => c.passages.length), (c) => 2 * (900 + c.claim.text.length + Math.min(1600, textOf(c.passages).length))).map(async (chunk) => {
    const answers = await asked(Object.fromEntries(chunk.flatMap((c, i) => { const q = supportQuestions(c.claim.text, inContext(c.passages)); return [[`s${i}`, q.supported], [`x${i}`, q.inflated]]; })));
    chunk.forEach((c, i) => { c.supported = answers[`s${i}`]!.noul; c.inflated = answers[`x${i}`]!.noul; });
  })); for (const c of list) c.ok = c.passages.length > 0 && claimVerdict(c.supported, c.inflated, c.missing); };
  await judge(checks);

  // -- a claim whose source does not hold: Jev looks for the passage that does, among those that could
  const weak = checks.filter((c) => !c.ok && (c.passages.length === 0 || c.supported < SUPPORTED || c.missing.length)), pools = weak.map((c) => candidates(index, c.claim.text));
  if (weak.some((_, i) => pools[i]!.length)) {
    const questions = weak.flatMap((c, i) => pools[i]!.length ? [[`p${i}`, choice(`Which passage states what this claim states? The claim: ${quote(c.claim.text, 400)}`, { ...Object.fromEntries(pools[i]!.map((p, k) => [`p${k}`, p.text.slice(0, 320)])), none: "No passage here states it." })] as const] : []);
    const picks = Object.assign({}, ...await Promise.all(batches(questions, sizeOf).map((group) => asked(Object.fromEntries(group))))) as Record<string, Answer>;
    const again: ClaimCheck[] = [];
    weak.forEach((c, i) => { const pick = picks[`p${i}`]; if (!pick || pick.choice === "none") return; const found = resolve(index, address(pools[i]![Number(pick.choice.slice(1))]!)); again.push({ ...c, passages: found, missing: numbersMissing(c.claim.text, textOf(found)), repaired: address(found[0]!) }); });
    await judge(again);
    for (const fixed of again.filter((c) => c.ok)) { const old = checks.find((c) => c.claim === fixed.claim)!; notes.push(`claim "${fixed.claim.text.slice(0, 80)}": cited ${old.claim.sources.join(", ") || "nothing"}; Jev found it in ${fixed.repaired}, and that is now its source`); fixed.claim.sources = [fixed.repaired!]; Object.assign(old, fixed); }
  }
  for (const c of checks.filter((c) => !c.ok)) problems.push(`scene "${c.scene}", claim ${quote(c.claim.text, 160)}: ${
    !c.claim.sources.length ? `it has no source; give "sources": ["file.md:line"] exactly as the notes give the address`
    : !c.passages.length ? `its source ${c.claim.sources.join(", ")} is not a passage of the repository's documents; cite the address exactly as the notes give it (file.md:line)`
    : c.missing.length ? `the number${c.missing.length > 1 ? "s" : ""} ${c.missing.join(", ")} ${c.missing.length > 1 ? "are" : "is"} not in the cited passage (${quote(textOf(c.passages), 300)}); use only figures the passage has, written as it writes them, or cite the passage that has them`
    : c.supported < SUPPORTED ? `the cited passage does not say all of this (${quote(textOf(c.passages), 300)}); split it into one claim per passage, each saying only what its own passage says, or cite the passage that says it, or drop it together with the sentence that states it`
    : `it says more than the cited passage (${quote(textOf(c.passages), 300)}); keep the passage's own scope and limits (simulated, synthetic, one machine, how many cases)`}`);

  // -- every number the viewer sees or hears in a scene stands in a passage that scene cites
  for (const s of scenes) {
    const cited = textOf(checks.filter((c) => c.scene === s.id).flatMap((c) => c.passages)), missing = numbersMissing(shownText(s).join(" "), cited);
    if (missing.length) problems.push(`scene "${s.id}": ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} said or shown there but ${s.claims.length ? "is in none of the passages the scene's claims cite" : "the scene has no claims"}; every figure needs a claim in that scene whose cited passage contains it, written as the passage writes it`);
  }

  // -- every sentence and card: does it state a fact about the product, and do the scene's claims cover it? And the closed choices: each scene's template, each card's icon
  const listed = scenes.flatMap((s) => [...sentencesOf(s.narration ?? "").map((text) => ({ text, narrated: true })), ...[...cardsOf(s).map((c) => `${c.title}: ${c.detail}`), ...(s.stat ? [`${s.stat.value} ${s.stat.label} (${s.stat.scope})`] : []), ...(s.before && s.after ? [`${s.metric}: ${s.before.value} (${s.before.label}) against ${s.after.value} (${s.after.label})`] : []), ...(s.actions ?? []), ...(s.result ? [s.result] : []), ...(s.points ?? [])].map((text) => ({ text, narrated: false }))].filter((t) => words(t.text) >= 4).map((t) => ({ scene: s, ...t })));
  const cards = scenes.flatMap(cardsOf);
  const summary = (s: Scene) => JSON.stringify({ narration: s.narration, headline: s.headline, figure: s.stat?.value ?? (s.before ? `${s.before.value} -> ${s.after?.value}` : undefined), cards: cardsOf(s).map((c) => c.title), actions: s.actions, ask: s.ask }).slice(0, 900);
  const [statements, closed] = await Promise.all([
    Promise.all(batches(listed, (st) => 2 * (700 + st.text.length) + Math.min(1400, st.scene.claims.reduce((n, c) => n + c.text.length + 3, 0))).map(async (chunk) => { const a = await asked(Object.fromEntries(chunk.flatMap((st, i) => { const q = coverQuestions(st.text, st.scene.claims.map((c) => c.text)); return [[`f${i}`, q.says], [`c${i}`, q.covered]]; })));
      return chunk.map((st, i): Statement => ({ ...st, says: a[`f${i}`]!.noul, covered: a[`c${i}`]!.noul })); })).then((r) => r.flat()),
    Promise.all(batches([...scenes.map((s, i) => [`t${i}`, choice(`Which kind of scene is this, by its content? The scene: ${summary(s)}`, TEMPLATES)] as const), ...cards.map((c, i) => [`i${i}`, choice(`Which icon goes with this card? The card: ${quote(`${c.title}: ${c.detail}`, 240)}`, ICONS)] as const)], sizeOf)
      .map((group) => asked(Object.fromEntries(group)))).then((r) => Object.assign({}, ...r) as Record<string, Answer>),
  ]);
  for (const st of statements.filter(uncovered)) problems.push(`scene "${st.scene.id}": ${quote(st.text, 200)} states something about the product that none of the scene's claims covers; add a claim for it with its source, or cut it`);
  cards.forEach((c, i) => { c.icon = closed[`i${i}`]!.choice as Icon; });
  const templates = scenes.map((s, i) => ({ scene: s.id, wrote: s.template, jev: closed[`t${i}`]!.choice, confidence: closed[`t${i}`]!.confidence }));
  for (const t of templates) if (t.jev !== t.wrote && t.confidence >= SWITCH) notes.push(`scene "${t.scene}" uses template "${t.wrote}"; by its content Jev reads it as "${t.jev}" (${t.confidence.toFixed(2)})`);
  return { problems, notes, checks, statements, templates };
}

/** The last resort, by code: what could not be tied to a source line leaves the video. The claim goes, and with it the narrated sentences that stated something no claim covers, or a figure no cited passage has. */
export function prune(script: Script, seen: Inspection): string[] {
  const dropped: string[] = [];
  for (const s of script.scenes) {
    const bad = new Set(seen.checks.filter((c) => c.scene === s.id && !c.ok).map((c) => c.claim));
    for (const c of bad) dropped.push(`scene "${s.id}": the claim ${quote(c.text, 120)} (not tied to a source line)`);
    s.claims = s.claims.filter((c) => !bad.has(c));
    const cited = textOf(seen.checks.filter((c) => c.scene === s.id && c.ok).flatMap((c) => c.passages)), loose = new Set(seen.statements.filter((st) => st.scene === s && st.narrated && uncovered(st)).map((st) => st.text));
    const kept = sentencesOf(s.narration ?? "").filter((sentence) => { const out = loose.has(sentence) || numbersMissing(sentence, cited).length > 0; if (out) dropped.push(`scene "${s.id}": the sentence ${quote(sentence, 120)}`); return !out; });
    if (kept.length) s.narration = kept.join(" ");
  }
  return dropped;
}

export async function review(ws: Workspace, ask: Ask, index: Passage[], mend?: Mend): Promise<Reviewed> {
  const jev = { requests: 0, questions: 0 };
  const asked = async (questions: Questions) => { jev.requests++; jev.questions += Object.keys(questions).length; return await ask({ task: "Checking a pitch video's script against the documents it cites." }, questions) as unknown as Record<string, Answer>; };
  let parsed = parseScript(ws.files["video/script.json"] ?? "");
  if (!parsed.script) return { problems: ws.files["video/script.json"] ? parsed.problems : ["video/script.json was not written"], notes: [], checks: [], statements: [], templates: [], mends: 0, dropped: [], jev };
  let seen = await inspect(parsed.script, parsed.problems, asked, index), mends = 0;
  const notes = [...seen.notes];
  // Mended by its writer while that helps: each round it is shown its script as it stands and exactly what is wrong with it.
  while (seen.problems.length && mend && mends < MENDS) {
    const again = await mend(`${JSON.stringify(parsed.script, null, 2)}\n`, seen.problems.slice(0, 14)).catch(() => null), next = again ? parseScript(again) : null;
    mends++;
    if (!next?.script) break;
    parsed = next;
    seen = await inspect(parsed.script!, parsed.problems, asked, index);
    notes.push(...seen.notes);
  }
  // Then nothing unverified stays: what still cannot be tied to a source line is dropped by code, and what is left is looked at once more.
  let dropped: string[] = [];
  if (seen.problems.length) {
    dropped = prune(parsed.script!, seen);
    if (dropped.length) { seen = await inspect(parsed.script!, parsed.problems, asked, index); notes.push(...seen.notes); }
  }
  const script = parsed.script!;
  // For whoever improves this: every score Jev gave, outside what the judge reads.
  await ws.write("cache/review.json", JSON.stringify({ mends, dropped, claims: seen.checks.map((c) => ({ scene: c.scene, claim: c.claim.text, sources: c.claim.sources, missing: c.missing, supported: c.supported, inflated: c.inflated, repaired: c.repaired, ok: c.ok })), statements: seen.statements.map((st) => ({ scene: st.scene.id, text: st.text, says: st.says, covered: st.covered })), templates: seen.templates, problems: seen.problems, notes, jev }, null, 2));
  await ws.write("video/script.json", `${JSON.stringify(script, null, 2)}\n`);
  await ws.write("video/claims.md", claimsMd(script, seen.checks, jev));
  return { ...seen, notes, problems: seen.problems.slice(0, 14), script, mends, dropped, jev };
}

/** video/claims.md: every claim, the file and line it comes from, the passage as the file has it, and how it was checked. */
export function claimsMd(script: Script, checks: ClaimCheck[], jev: { requests: number; questions: number }): string {
  const lines = [`# ${script.title}: every claim in the video, and the file it comes from`, "",
    `Each number and capability stated in \`video/script.json\` (in the narration or on screen) is listed below with the file in this repository it comes from, as \`file:line\`. The quotation under each claim was copied from that file by code, not written by a model. Checks: code looked for every figure of the claim in the quoted passage; Jev (TypeSafe's typed model) was asked, per claim, whether the passage states what the claim states and whether the claim says more than the passage, and, per sentence, whether it states anything that no claim covers (${jev.questions} closed questions in ${jev.requests} requests for this script). A claim that could not be tied to a source line was taken out of the video, not kept with a caveat. Nothing here comes from outside the repository's documents.`, "",
    `| # | Scene | Claim | Source |`, `| --- | --- | --- | --- |`,
    ...checks.map((c, i) => `| ${i + 1} | ${c.scene} | ${c.claim.text.replace(/\|/g, "/")} | ${c.claim.sources.map((s) => `\`${s}\``).join(", ") || "none"} |`), ""];
  let n = 0;
  for (const scene of script.scenes) {
    lines.push(`## Scene ${script.scenes.indexOf(scene) + 1}: ${scene.id} (${scene.template})`, "", `Narration: "${scene.narration}"`, "");
    const mine = checks.filter((c) => c.scene === scene.id);
    if (!mine.length) lines.push("No number or capability is claimed in this scene.", "");
    for (const c of mine) {
      n++;
      lines.push(`${n}. **${c.claim.text}**`, `   - Source: ${c.passages.length ? [...new Set(c.passages.map((p) => `\`${p.file}\` line ${p.line}${p.end > p.line ? ` to ${p.end}` : ""}${p.heading ? ` (section "${p.heading.split(" > ").pop()}")` : ""}`))].join("; ") : `${c.claim.sources.join(", ") || "none given"} (NOT FOUND in the repository's documents)`}`);
      for (const p of c.passages.slice(0, 4)) lines.push(`   - The file says: "${p.text}"`);
      lines.push(`   - Checked: ${c.passages.length ? `${numbersIn(c.claim.text).length ? (c.missing.length ? `figures NOT in the passage: ${c.missing.join(", ")}` : `every figure of the claim (${[...new Set(numbersIn(c.claim.text))].join(", ")}) is in the passage`) : "no figures"}; Jev: supported ${c.supported.toFixed(2)}, says more than the passage ${c.inflated.toFixed(2)}${c.repaired ? "; source found by Jev among the repository's passages" : ""}. ${c.ok ? "Holds." : "NOT VERIFIED: treat this claim as unsupported."}` : "NOT VERIFIED: no passage to check against."}`, "");
    }
  }
  lines.push(`Length: ${script.scenes.reduce((sum, s) => sum + words(s.narration), 0)} words of narration over ${(Math.round(script.scenes.reduce((sum, s) => sum + (s.seconds ?? 0), 0) * 10) / 10).toFixed(1)} seconds (each scene lasts as long as its narration takes at ${WPM} words a minute).`, "");
  return lines.join("\n");
}
