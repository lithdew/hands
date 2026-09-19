// kits/papers.ts — a research summary whose every citation is a real paper this run fetched, and says what that paper did.
//
// Who does what here, and why:
//
//   director  LLM    chooses the themes (one research step each) and words the queries
//   sources   code   arXiv's own search, asked once a step (all its queries in one), by relevance, the last two years, whole abstracts
//   sift      JEV    every abstract against its theme's goal (relay.ts), hundreds in a few requests
//   reading   LLM    per theme: what the papers are after, the lines of attack, the open ends. Not a list of papers
//   prepare   JEV    every kept paper, in bulk: which theme is it (a choice over the director's themes), is it a
//             code   contribution of its own, does its abstract say what was found; then the best of each theme pair by pair:
//                    "the same narrow problem?", so a theme shows its breadth. Code then holds the counts:
//                    so many a theme, so many in all, enough of them recent. The writer starts inside the limits
//   write     LLM    the file, from whole abstracts
//   review    code   titles and addresses set back to arXiv's exactly; a paper the run never fetched is taken out;
//             JEV    every description against its own abstract, in bulk: "could this describe another paper?";
//             LLM    only the ones that fail are rewritten, a few sentences each; code holds length and counts
//
// No paper, title or theme is written here. The themes are the director's, the papers are arXiv's answers.

import { choice, noul, type ChoiceResponse, type NoulResponse, type Questions } from "../../jev";
import type { JsonSchema } from "../../openai";
import type { Kit, KitContext, Source } from "../relay";
import { arxiv, arxivByIds, type Result } from "../web";

const FILE = "rl-frontier.md";
/** The standard asks for 600 to 2,500 words, 12 papers, 10 of them recent, 4 themes. Code holds the file to a little more than that, so a near miss is still a pass. */
export const LIMITS = { minWords: 800, maxWords: 2_350, minPapers: 14, minRecent: 12, minThemes: 4, perTheme: 4, most: 20 };
const PER_SEARCH = 150, PAPERS_PER_REQUEST = 20, TOP_FOR_BREADTH = 8, ABSTRACT_CHARS = 1_600, FIX_ROUNDS = 2;

// ---------------------------------------------------------------- arXiv, asked the way it answers

export const arxivId = (url: string): string | null => /arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/.exec(url)?.[1] ?? null;
const isRecent = (id: string, year = new Date().getFullYear()) => Number(id.slice(0, 2)) >= (year - 1) % 100;

const FILLER = new Set("a an and the of in on for to with from by at as or vs via into about using use new recent latest current frontier advances advance progress state art sota paper papers preprint arxiv survey surveys review overview research study studies work works approach approaches method methods towards toward site pdf best top".split(" "));

/** A typed web query as arXiv search terms. arXiv matches every term, so a phrase of ten words finds nothing: keep the few that carry the topic. */
export function arxivTerms(query: string): string[] {
  const words = query.toLowerCase().replace(/\bsite:\S+/g, " ").split(/[^a-z0-9-]+/).map((w) => w.replace(/^-+|-+$/g, "")).filter((w) => w.length > 1 && !/^(19|20)\d\d$/.test(w) && !FILLER.has(w));
  return [...new Set(words)].slice(0, 6);
}

/** One question for a whole step: a paper that has every term of any one of the queries, submitted since the start of `fromYear`. */
export function arxivSearch(queries: string[][], fromYear: number): string {
  const groups = [...new Set(queries.filter((terms) => terms.length).map((terms) => `(${terms.map((t) => `all:${t}`).join(" AND ")})`))];
  return `(${groups.join(" OR ")}) AND submittedDate:[${fromYear}01010000 TO ${fromYear + 9}12312359]`;
}

/** arXiv asks for a request every three seconds (web.ts keeps to it), so a step asks once, for much: all its queries in one search, by relevance, the last two years. */
async function sourcesAtOnce(queries: string[]): Promise<Result[]> {
  const terms = queries.map(arxivTerms).filter((t) => t.length >= 2), fromYear = new Date().getFullYear() - 1;
  if (!terms.length) return [];
  const found = await arxiv(arxivSearch(terms, fromYear), PER_SEARCH, { sort: "relevance" });
  // Too many terms find too little. Asked once more with each query's last term let go.
  return found.length >= 30 ? found : [...found, ...await arxiv(arxivSearch(terms.map((t) => t.slice(0, Math.max(2, t.length - 1))), fromYear), PER_SEARCH, { sort: "relevance" })];
}

/** Only papers, and each as arXiv has it: a web result that points at arXiv becomes arXiv's record (exact title, whole abstract); anything else cannot be cited and is left out. */
async function gather(results: Result[]): Promise<Result[]> {
  const have = new Map<string, Result>();
  for (const r of results) { const id = arxivId(r.url); if (id && r.text) have.set(id, r); }
  const lacking = [...new Set(results.map((r) => arxivId(r.url)).filter((id): id is string => Boolean(id) && !have.has(id!)))];
  for (const r of await arxivByIds(lacking).catch(() => [])) { const id = arxivId(r.url); if (id) have.set(id, r); }
  return [...have.values()];
}

// ---------------------------------------------------------------- prepare: Jev places and rates, code holds the counts

export type Candidate = { id: string; theme: string; score: number; recent: boolean };

export const pairKey = (a: string, b: string): string => a < b ? `${a}|${b}` : `${b}|${a}`;

/** The papers to write about. Best of each theme in turn, so no theme crowds out another; a paper too like one already ahead of it in its theme (`alike`, pairs Jev judged) waits behind the rest, so a theme shows its breadth; themes too thin to be a theme are let go while four remain; enough recent papers, by exchange if need be. */
export function select(candidates: Candidate[], opts: { perTheme: number; most: number; minRecent: number; minThemes: number } = LIMITS, alike: Set<string> = new Set()): Candidate[] {
  const byTheme = new Map<string, Candidate[]>();
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) if (c.theme !== "none") byTheme.set(c.theme, [...(byTheme.get(c.theme) ?? []), c]);
  for (const [theme, list] of byTheme) { const ahead: Candidate[] = [], behind: Candidate[] = []; for (const c of list) (ahead.some((k) => alike.has(pairKey(k.id, c.id))) ? behind : ahead).push(c); byTheme.set(theme, [...ahead, ...behind]); }
  let themes = [...byTheme.values()].sort((a, b) => b.length - a.length || b[0]!.score - a[0]!.score);
  const full = themes.filter((t) => t.length >= 2);
  themes = full.length >= opts.minThemes ? full : themes.slice(0, Math.max(opts.minThemes, full.length));
  const chosen: Candidate[] = [];
  for (let rank = 0; rank < opts.perTheme; rank++) for (const t of themes) if (t[rank] && chosen.length < opts.most) chosen.push(t[rank]!);
  // Recent enough? Exchange the weakest older paper for the best recent one left in its theme, while that helps.
  const spare = themes.flatMap((t) => t.slice(opts.perTheme)).filter((c) => c.recent).sort((a, b) => b.score - a.score);
  while (chosen.filter((c) => c.recent).length < opts.minRecent && spare.length) {
    const old = chosen.filter((c) => !c.recent).sort((a, b) => a.score - b.score)[0];
    if (!old) break;
    const instead = spare.find((s) => s.theme === old.theme) ?? spare[0]!;
    spare.splice(spare.indexOf(instead), 1);
    chosen.splice(chosen.indexOf(old), 1, instead);
  }
  return chosen;
}

/** Every paper the run fetched, by arXiv id, with the research step that scored it highest. */
function fetched(ws: KitContext["ws"]): Map<string, Source & { step: string }> {
  const all = new Map<string, Source & { step: string }>();
  for (const [step, list] of Object.entries(ws.sources)) for (const s of list) { const id = arxivId(s.url); if (id && (all.get(id)?.score ?? -1) < s.score) all.set(id, { ...s, step }); }
  return all;
}

async function prepare(ctx: KitContext): Promise<Record<string, unknown>> {
  const themes = ctx.plan.steps.filter((s) => s.worker === "research" && ctx.ws.sources[s.id]?.length);
  const pool = [...fetched(ctx.ws)].map(([id, source]) => ({ id, source }));
  if (!themes.length || !pool.length) return { papers: "No paper was found. Say so in the file; cite nothing." };
  const criteria = { ...Object.fromEntries(themes.map((t) => [t.id, t.goal.slice(0, 300)])), none: "None of these fits it, or it is not research on the subject of the request at all." };
  const lots = Array.from({ length: Math.ceil(pool.length / PAPERS_PER_REQUEST) }, (_, i) => pool.slice(i * PAPERS_PER_REQUEST, (i + 1) * PAPERS_PER_REQUEST));
  const rated: (Candidate & { source: Source })[] = (await Promise.all(lots.map(async (lot) => {
    const questions: Questions = {};
    lot.forEach(({ source }, i) => {
      const paper = `The paper: ${JSON.stringify(`${source.title}. ${source.text.slice(0, ABSTRACT_CHARS)}`)}`;
      questions[`theme${i}`] = choice(`Which one theme does this paper belong to most? ${paper}`, criteria);
      questions[`own${i}`] = noul(`This paper makes a contribution of its own to the field of \`request\`: a new method, algorithm, analysis, benchmark or finding. ${paper}`, { true: "It presents its own new method or result, and the field's researchers would count it as work on the field itself.", false: "It is a survey, a tutorial, a position piece, or a routine use of known techniques on some application, with nothing new for the field itself." });
      questions[`found${i}`] = noul(`The abstract says concretely what was done and what was found. ${paper}`, { true: "It names its method and reports a result, a comparison or a proven statement.", false: "It stays with motivation and intentions, and reports nothing definite." });
    });
    const answers = await ctx.ask({ request: ctx.task }, questions) as unknown as Record<string, ChoiceResponse | NoulResponse>;
    const theme = (i: number) => (answers[`theme${i}`] as ChoiceResponse).choice, yes = (name: string) => (answers[name] as NoulResponse).noul;
    return lot.map(({ id, source }, i) => ({ id, source, theme: theme(i), recent: isRecent(id), score: source.score * yes(`own${i}`) * yes(`found${i}`) * (isRecent(id) ? 1 : 0.6) }));
  }))).flat();
  // Breadth: the best few of each theme, every pair of them, one request a theme. Two papers on the same narrow problem are one entry in a short summary.
  const alike = new Set<string>();
  let pairsAsked = 0;
  await Promise.all(themes.map(async (t) => {
    const top = rated.filter((r) => r.theme === t.id).sort((a, b) => b.score - a.score).slice(0, TOP_FOR_BREADTH), questions: Questions = {}, pairs: [string, string][] = [];
    for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++) {
      const text = (i: number) => JSON.stringify(`${top[i]!.source.title}. ${top[i]!.source.text.slice(0, 700)}`);
      questions[`p${pairs.length}`] = noul(`These two papers work on the same narrow problem, so that a short survey would cite only one of them. Paper A: ${text(a)} Paper B: ${text(b)}`, { true: "The same specific problem and the same kind of contribution (two sample-complexity bounds for one setting, a method and its direct follow-up).", false: "They share a broad area at most; their problems or their kinds of contribution differ." });
      pairs.push([top[a]!.id, top[b]!.id]);
    }
    if (!pairs.length) return;
    pairsAsked += pairs.length;
    const answers = await ctx.ask({ task: "Choosing papers for a short survey that should show the breadth of each theme." }, questions) as unknown as Record<string, NoulResponse>;
    pairs.forEach(([a, b], i) => { if (answers[`p${i}`]!.noul >= 0.55) alike.add(pairKey(a, b)); });
  }));
  const chosen = select(rated, LIMITS, alike), byId = new Map(rated.map((r) => [r.id, r]));
  ctx.log(`prepare: Jev placed ${rated.length} papers in ${themes.length} themes and rated each (${lots.length} requests, ${rated.length * 3} questions), then compared ${pairsAsked} pairs of the best for breadth (${alike.size} too alike); code chose ${chosen.length}, ${chosen.filter((c) => c.recent).length} recent, in ${new Set(chosen.map((c) => c.theme)).size} themes`);
  await Bun.write(`${ctx.ws.dir}/notes/chosen.json`, JSON.stringify(rated.sort((a, b) => b.score - a.score).map((r) => ({ chosen: chosen.some((c) => c.id === r.id), theme: r.theme, score: Number(r.score.toFixed(3)), id: r.id, title: r.source.title })), null, 1));
  return {
    themes: themes.filter((t) => chosen.some((c) => c.theme === t.id)).map((t) => ({ theme: t.id, about: t.goal, papers: chosen.filter((c) => c.theme === t.id).map((c) => { const s = byId.get(c.id)!.source; return { title: s.title, address: s.url, submitted: s.date, abstract: s.text }; }) })),
    told: `Cite every paper listed under "themes" (${chosen.length} of them), each under its theme, from its abstract. The themes' names are working labels: give each section a proper heading. The notes are a reader's digest of each theme, for the openings and the closing section.`,
  };
}

// ---------------------------------------------------------------- review: code mends and counts, Jev reads every description

const LINK = /\[([^\]]+)\]\((https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})[^)\s]*)\)/g;
const isBullet = (line: string) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
export const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

export type Bullet = { id: string; from: number; to: number; description: string };

/** Each paper's own bullet: the list item that links it, with the lines that continue it. `description` is the item without its link. */
export function paperBullets(md: string): Bullet[] {
  const lines = md.split("\n"), out: Bullet[] = [];
  for (let i = 0; i < lines.length; i++) {
    const id = isBullet(lines[i]!) ? [...lines[i]!.matchAll(LINK)][0]?.[3] : undefined;
    if (!id) continue;
    let to = i;
    while (to + 1 < lines.length && lines[to + 1]!.trim() && !isBullet(lines[to + 1]!) && !/^#{1,6}\s/.test(lines[to + 1]!)) to++;
    const item = lines.slice(i, to + 1).join(" ");
    out.push({ id, from: i, to, description: item.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(LINK, "").replace(/^\s*(?:\*\*)?\s*\(?\d{4}\)?\s*(?:\*\*)?\s*/, "").replace(/^[\s:—–.,-]+/, "").replace(/\s+/g, " ").trim() });
    i = to;
  }
  return out;
}

/** Titles and addresses as arXiv has them. A paper is linked once, in its bullet if it has one; said again, it is plain text. A paper the run never fetched loses its bullet, or its link. */
export function mendCitations(md: string, records: Map<string, { title: string; url: string }>): { text: string; unknown: string[]; mended: number } {
  const lines = md.split("\n"), unknown = new Set<string>(), keeper = new Map<string, number>();
  lines.forEach((line, i) => { for (const m of line.matchAll(LINK)) { const id = m[3]!; if (!keeper.has(id) || (isBullet(line) && !isBullet(lines[keeper.get(id)!]!))) keeper.set(id, i); } });
  let mended = 0;
  const linked = new Set<string>(), drop = new Set<number>();
  const text = lines.map((line, i) => {
    const first = [...line.matchAll(LINK)][0];
    if (first && isBullet(line) && !records.has(first[3]!)) { unknown.add(first[3]!); drop.add(i); return line; }
    return line.replace(LINK, (whole, label: string, _url: string, id: string) => {
      const record = records.get(id);
      if (!record) { unknown.add(id); mended++; return label; }
      if (keeper.get(id) !== i || linked.has(id)) { mended++; return label; }
      linked.add(id);
      const exact = `[${record.title.replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ").trim()}](https://arxiv.org/abs/${id})`;
      if (exact !== whole) mended++;
      return exact;
    });
  });
  // A dropped bullet takes its continuation lines with it.
  for (const i of [...drop]) for (let j = i + 1; j < lines.length && lines[j]!.trim() && !isBullet(lines[j]!) && !/^#{1,6}\s/.test(lines[j]!); j++) drop.add(j);
  return { text: text.filter((_, i) => !drop.has(i)).join("\n"), unknown: [...unknown], mended: mended + drop.size };
}

/** What code can count, against the limits. Each line is an instruction the writer can act on. */
export function countProblems(md: string, limits = LIMITS): string[] {
  const problems: string[] = [], words = wordCount(md), bullets = paperBullets(md), inBullets = new Set(bullets.map((b) => b.id));
  const cited = new Set([...md.matchAll(LINK)].map((m) => m[3]!));
  if (words > limits.maxWords) problems.push(`The file has ${words} words, links included; the limit is ${limits.maxWords}. Cut about ${words - limits.maxWords + 150} words from the openings and the closing section, not from the papers' descriptions.`);
  if (words < limits.minWords) problems.push(`The file has only ${words} words; it needs at least ${limits.minWords}.`);
  if (cited.size < limits.minPapers) problems.push(`Only ${cited.size} distinct papers are cited as [title](arXiv address); cite at least ${limits.minPapers} of the papers you were given.`);
  const recent = [...cited].filter((id) => isRecent(id)).length;
  if (cited.size >= limits.minPapers && recent < limits.minRecent) problems.push(`Only ${recent} of the cited papers are from the last two years; at least ${limits.minRecent} must be.`);
  const loose = [...cited].filter((id) => !inBullets.has(id));
  if (loose.length) problems.push(`These papers are linked in running text but have no bullet of their own saying what they contribute: ${loose.join(", ")}. Give each its own bullet under its theme.`);
  const lines = md.split("\n"), sections = lines.map((l, i) => /^##\s/.test(l) ? i : -1).filter((i) => i >= 0);
  const themed = sections.filter((from, k) => bullets.filter((b) => b.from > from && b.from < (sections[k + 1] ?? lines.length)).length >= 2).length;
  if (themed < limits.minThemes) problems.push(`Only ${themed} '## ' sections hold two or more papers; at least ${limits.minThemes} themes are needed, each a '## ' section with its papers as bullets.`);
  return problems;
}

const FIX_SCHEMA: JsonSchema = { name: "descriptions", schema: { type: "object", additionalProperties: false, required: ["descriptions"], properties: { descriptions: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "description"], properties: { id: { type: "string" }, description: { type: "string" } } } } } } };

/** Jev reads each description beside its own abstract, all of them at once. Returns the arXiv ids whose description would fit another paper, or says what its abstract does not. */
async function weakDescriptions(ctx: KitContext, bullets: Bullet[], records: Map<string, Source>): Promise<Map<string, string>> {
  const lots = Array.from({ length: Math.ceil(bullets.length / 30) }, (_, i) => bullets.slice(i * 30, (i + 1) * 30)), weak = new Map<string, string>();
  await Promise.all(lots.map(async (lot) => {
    const questions: Questions = {};
    lot.forEach((b, i) => {
      const pair = `The abstract: ${JSON.stringify(records.get(b.id)!.text.slice(0, ABSTRACT_CHARS))} The description: ${JSON.stringify(b.description.slice(0, 900))}`;
      questions[`own${i}`] = noul(`The description says what this one paper did, in particulars taken from its abstract. ${pair}`, { true: "It names the paper's own method, setting or reported result, so it could not be describing a different paper on the same topic.", false: "It stays general (a topic, a direction, a definition), says that details are missing, or would fit many papers." });
      questions[`true${i}`] = noul(`The description reports the paper as its abstract does. ${pair}`, { true: "What it says the paper does and finds is what the abstract says.", false: "It gives the paper a method, a number or a result that the abstract does not state, or contradicts the abstract." });
    });
    const answers = await ctx.ask({ task: "Checking short descriptions of research papers against the papers' own abstracts." }, questions) as unknown as Record<string, NoulResponse>;
    lot.forEach((b, i) => {
      if (answers[`own${i}`]!.noul < 0.5) weak.set(b.id, "It is too general: it could describe another paper on the same topic.");
      else if (answers[`true${i}`]!.noul < 0.25) weak.set(b.id, "It says something the abstract does not state.");
    });
  }));
  return weak;
}

async function review(ctx: KitContext): Promise<string[]> {
  const { ws } = ctx, records = fetched(ws);
  if (!ws.files[FILE]) return [`${FILE} was not written. Write the summary to exactly that path.`];
  const mended = mendCitations(ws.files[FILE]!, records);
  let text = mended.text;
  if (mended.mended) ctx.log(`review: code set ${mended.mended} citations right${mended.unknown.length ? `; taken out, not fetched by this run: ${mended.unknown.join(", ")}` : ""}`);
  // Jev reads every description against its abstract; the LLM rewrites only those that fail; Jev reads those again.
  const report: { round: number; checked: number; weak: Record<string, string> }[] = [];
  for (let round = 0; round <= FIX_ROUNDS; round++) {
    const bullets = paperBullets(text).filter((b) => records.has(b.id) && (round === 0 || report[round - 1]!.weak[b.id]));
    const weak = bullets.length ? await weakDescriptions(ctx, bullets, records) : new Map<string, string>();
    report.push({ round, checked: bullets.length, weak: Object.fromEntries(weak) });
    ctx.log(`review: Jev read ${bullets.length} descriptions against their abstracts; ${weak.size ? `${weak.size} sent back${round === FIX_ROUNDS ? " and left as they are" : ""}: ${[...weak.keys()].join(", ")}` : "all specific"}`);
    if (!weak.size || round === FIX_ROUNDS) break;
    const fixes = (await ctx.llm(`fix:${weak.size} descriptions`, { model: ctx.deepModel, effort: "low", schema: FIX_SCHEMA, user: JSON.stringify({ papers: bullets.filter((b) => weak.has(b.id)).map((b) => ({ id: b.id, title: records.get(b.id)!.title, abstract: records.get(b.id)!.text, description_now: b.description, wrong_with_it: weak.get(b.id) })) }), system:
      `Each of these descriptions of a research paper failed a check against the paper's abstract. Rewrite each: one or two sentences, at most 55 words, saying what THIS paper contributes in its abstract's own particulars: the named method or idea and how it works, the setting, and the result the abstract reports (with its number, where the abstract gives one). Nothing that is not in the abstract, no remark about what the abstract leaves out, no title, no link. Return the same ids.` })) as { descriptions: { id: string; description: string }[] };
    const lines = text.split("\n");
    for (const b of [...paperBullets(text)].reverse()) {
      const fix = fixes.descriptions.find((f) => f.id === b.id && weak.has(b.id))?.description.replace(/\s+/g, " ").trim();
      if (!fix) continue;
      const head = /^(\s*(?:[-*+]|\d+[.)])\s+.*?\[[^\]]+\]\([^)]+\)(?:\s*\(?\d{4}\)?)?)/.exec(lines[b.from]!)?.[1] ?? `- [${records.get(b.id)!.title}](https://arxiv.org/abs/${b.id})`;
      lines.splice(b.from, b.to - b.from + 1, `${head}: ${fix}`);
    }
    text = lines.join("\n");
  }
  if (text !== ws.files[FILE]) await ws.write(FILE, text);
  await Bun.write(`${ws.dir}/notes/review.json`, JSON.stringify({ words: wordCount(text), papers: paperBullets(text).length, mended: mended.mended, unknown: mended.unknown, rounds: report }, null, 1));
  return countProblems(text);
}

// ---------------------------------------------------------------- the kit

export const papers: Kit = {
  name: "papers",
  brief: `The deliverable is one markdown file, ${FILE}: a summary of current research by theme, in which every paper cited is a real arXiv paper that this run fetched, and is said to have done what its abstract says it did.
THE PLAN: one research step for each theme, five or six themes that are current in the field now and together show its breadth rather than one corner of it (the themes are yours to choose, and each step's id names its theme), then one write step that needs them all. The queries also go to arXiv's own search, which matches every word: three to five topic keywords each, no site: filters, no years, no words like "survey", "recent" or "paper"; spread a step's queries over the sub-topics of its theme.
THE FILE: a title; a short opening on what was looked at and how (arXiv search results of the last two years, read from their abstracts, a selection and not a census); then one "## " section for each theme, which opens with two or three sentences on what the theme is and why it matters now, and then lists its papers, each as its own bullet in exactly this form: "- [Exact Title](https://arxiv.org/abs/2501.01234) (2025): one or two sentences." The sentences say what THIS paper contributes: its named method or idea and how it works, and the result its abstract reports, with the number where the abstract gives one. They must be impossible to mistake for a description of any other paper: no "explores", "advances the field" or "proposes a novel framework", nothing the abstract does not say, and no remarks about what the abstract leaves out. Then a section "## Where the field is heading": what the themes are converging on, the tensions between them, and open problems, each point tied by name to the papers above that support it (say a paper again by its short name, without a second link). Close with one line on the limits of the summary.
HARD LIMITS, checked by code: ${LIMITS.minWords + 700} to ${LIMITS.maxWords - 250} words in all, links included; at least ${LIMITS.minPapers + 1} distinct papers, in at least ${LIMITS.minThemes} themes of three or more papers; each paper linked once, in its bullet, its exact title as the link's text and its arXiv abstract page as the address; only papers you were given, titles and addresses exactly as given.`,
  reading: `The writer will have the chosen papers' abstracts in full, so do not restate the papers one by one. For this theme, in at most 300 words: what the papers are after and why it matters now; the distinct lines of attack among them, naming the papers that take each (exact title, address); where they disagree or what they trade off; what they leave open.`,
  sourcesAtOnce,
  gather,
  prepare,
  review,
};
