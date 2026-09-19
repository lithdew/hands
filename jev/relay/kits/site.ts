// kits/site.ts — a static personal site for the owner of this repository, every fact on it sourced.
//
// The request names nobody ("for myself") and the owner's name is a common one, so the kit's work is
// mostly about WHO. What each part does:
//
//   context   code   who the owner is: git's configuration, the history, and the GitHub account that
//                    GitHub itself ties to the owner's commit email (site/owner.ts). Told to the director.
//   sources   code   the repository's docs, the owner's commits, the account, its repositories and the
//                    main documents in them, as passages. JEV sifts them all, per research step.
//   admit     JEV    every passage from the web: "is this about the same person as `owner`?", and code
//             code   requires an exact tie on its page (the account's address, a repository of theirs).
//                    Both, or it is listed as unconfirmed and no LLM ever reads it.
//   review    JEV    the written page, sentence by sentence: does it state a fact; does the evidence say
//             code   all of it; is it in SOURCES.md. Code: structure, links that open, nothing private.
//                    Only what fails goes back to the writer.
//   build     code   the same checks again, the record of how the owner was identified and what was
//                    left out (appended to SOURCES.md from the run's own records), and stills at a
//                    desktop and a phone width from a headless Chrome (site/shots.ts).

import { join } from "node:path";
import { noul, type Ask, type NoulResponse, type Questions } from "../../jev";
import type { Kit, Passage, Workspace } from "../relay";
import { alive, page, searchLog, type SearchRecord } from "../web";
import { anchorsOf, isOwn, maskEmail, ownerContext, ownSources, theOwner, tieIn, type Owner } from "./site/owner";
import { evidenceFor, evidenceLines, links, lint, sentences, urlsIn } from "./site/page";
import { shoot } from "./site/shots";

const PER_REQUEST = 60, SAME_PERSON = 0.5, IS_FACT = 0.6, SUPPORTED = 0.4, SUPPORTED_ROW = 0.2, MAX_PROBLEMS = 12;
const MARK = "<!-- written by the build, from the run's records -->";

const BRIEF = `The deliverables are site/index.html and site/SOURCES.md, written together in ONE write step, followed by a build step (the kit's build checks the page and takes stills of it at a desktop and a phone width).
WHOSE SITE: the owner of the repository this system runs in (see what is known before planning).
PLAN exactly three research steps, then the write step (it needs all three), then the build. (1) What this project is, under each of its names, and which parts of it the owner built: from the repository's docs and the owner's OWN commits; teammates' work is not the owner's; a merge commit brings in other people's work. (2) Needing the first: what the owner's public account and the documents in its repositories say about their studies, writing and other work, each fact with its address. (3) Needing the first two: the owner on the public web beyond their own account, searched by name TOGETHER WITH what the earlier notes found (a school, a thesis title, a project or event name, an account name); most results will be namesakes, and the kit leaves those out, so this step is acceptable when its notes say plainly what was confirmed and what was not. Acceptance statements must be short, positive, and checkable from the text alone ("The notes give the title of the thesis and its address."): the checker reads text and cannot see a rendering, so none about styling or layout, none that say what must be absent, and none with "every" or "all". For the third research step give exactly these two: "The notes say which web searches were run." and "The notes say what was confirmed about the owner beyond their own account, or that nothing was." For the write step give exactly these two: "site/index.html has one h1 with the owner's name and sections for about, projects and contact." and "site/SOURCES.md has a table of facts, each with where it was found." (the kit's own review checks every sentence against the notes, the structure and the links). For the build step give exactly: "The build succeeded and made stills."
TRUTH: state only what the notes tie to the owner. What the owner's own commits did, the owner did; a document under the owner's own account that names them as its author is theirs, and the page may say so plainly in the first person ("I wrote ...", "my notes for ..."), with the title, course or institution exactly as the document gives them. Do not go beyond the document: a thesis that names a university and an honours programme says that, and does not say a degree, a graduation year, a major or a current occupation. No guesses, no adjectives about skill or passion, no dates or numbers the notes lack. If the notes are thin, the page is short. The page never talks about the research ("the notes", "the title page names", "the sources say"): it says what is true, in the first person, and SOURCES.md says how it is known; where a document gives the owner's name in a longer form, say once that it was written under that name. A repository about which only its name and file names are known gets its name, what its file names plainly show, and its link. Nothing private: no phone, no street address, no email address unless a public page of the owner's own shows it; do not name teammates, and give nobody's contact details. Never link to a repository the notes say is private or answers 404.
index.html: <!DOCTYPE html>, <html lang="en">, a <title>, <meta name="viewport" content="width=device-width, initial-scale=1">, all CSS in one <style> element, no scripts, nothing remote (no web fonts, no images from other hosts). Exactly one <h1> (the owner's name as git gives it). At least four <section> elements with ids, each with an <h2>: about (an introduction in the first person, three to five sentences: what they build in this project, and what they studied and wrote, as far as the notes go), projects (first this project, under both of its names, Puk and its workers called Hands, with what it is and the two or three main things the owner built in it; then each public repository that the notes describe, as a card linking to it and saying what it is, not which file types it holds), optionally writing or notes, and contact (how to get in touch: the owner's confirmed public profile, as a prominent link). A footer that links to SOURCES.md ("every fact on this page, with where it was found"). The words "placeholder", "TODO", "lorem" and "coming soon" appear nowhere, not even in class names or comments.
DESIGN, so that it looks designed and not generated: CSS custom properties for a restrained palette (a warm off-white background, near-black text, one muted grey, ONE accent colour used for links, buttons and small details, hairline borders); system font stacks only (a serif stack such as "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif for the h1 and h2; ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif for text; ui-monospace for small labels); a modular type scale (body 17-18px with line-height 1.65 and lines no longer than 68ch; h2 about 1.9rem; h1 clamp(2.6rem, 7vw, 4.5rem) with line-height 1.05 and slight negative letter-spacing); one spacing scale (4, 8, 12, 16, 24, 32, 48, 72, 112px) used everywhere; a centred container of max-width 1080px with 24px side padding; sections separated by generous vertical space (112px desktop, 64px phone) and a hairline rule; a simple top bar with the name at left and anchor links at right; a hero with a small uppercase monospace eyebrow line, the h1, a lead paragraph of larger text, and two buttons (primary: see projects; secondary: the public profile); each section heading with a small uppercase eyebrow label above it; project cards in a grid (grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)), gap 24px) with 1px border, 14px radius, 28px padding, a small monospace kind label, a title, two or three sentences, pill tags, and a link with an arrow; the first project card spans the full width; a contact panel with a tinted background. Mobile first: at widths under 640px everything is one column, the top bar's links wrap or shrink, buttons are full width, nothing scrolls sideways, tap targets are at least 44px high. Visible :focus-visible outlines, text contrast of at least 4.5:1, header/main/section/footer landmarks.
SOURCES.md: a heading; one sentence on how to read it; then a table with a row for EVERY fact the page states (the name, each project, each thing built, each school or course, each document, each link), the fact worded as the page words it: "What the page says | Where it was found (the address, or the file or commit in this repository) | Why it is the owner's". Then "Looked for and not found". Do not write about how the owner was identified or about unconfirmed pages: the build appends both from the run's records.`;

// ---------------------------------------------------------------- admit: is this the same person? (Jev, and an exact tie)

type Unconfirmed = { url: string; title: string; tie: string | null; best: number; passages: number };
const unconfirmed = new Map<string, Unconfirmed>();
const admittedWeb = new Map<string, string>();

const describe = (owner: Owner) => ({
  name: owner.name,
  repository_they_own: owner.remote ?? "a local repository",
  github_account: owner.account ? `${owner.account.login} (${owner.account.url})` : "none known",
  their_public_repositories: owner.account?.repos ?? [],
});

async function admit(ask: Ask, passages: Passage[], _step: unknown, ws: Workspace): Promise<Passage[]> {
  const owner = await theOwner();
  if (!owner) return [];
  const own = passages.filter((p) => isOwn(p.url, owner)), web = passages.filter((p) => !isOwn(p.url, owner));
  if (!web.length) return own;
  // Code: does the page carry an exact tie? Its whole text and every link on it, from the cache the relay just filled.
  const ties = new Map<string, string | null>();
  await Promise.all([...new Set(web.map((p) => p.url))].map(async (url) => { const p = await page(url); ties.set(url, tieIn([p.url, p.title, ...p.blocks, ...p.links.map((l) => l.url)].join("\n"), owner)); }));
  // Jev: every passage alone, against who the owner is. Sixty to a request, the requests side by side.
  const chunks = Array.from({ length: Math.ceil(web.length / PER_REQUEST) }, (_, i) => web.slice(i * PER_REQUEST, (i + 1) * PER_REQUEST));
  const scores = (await Promise.all(chunks.map(async (chunk) => {
    const questions: Questions = Object.fromEntries(chunk.map((p, i) => [`p${i}`, noul(`This passage is about the same person as \`owner\`, and not about someone else who has the same name. The passage, from "${p.title.slice(0, 120)}" (${p.url.slice(0, 160)}): ${JSON.stringify(p.text.slice(0, 500))}`, {
      true: "It names or describes the owner together with something `owner` lists: their account, one of their repositories, the repository they own.", false: "It is about another person, or about nobody in particular, or it shares nothing with `owner` but the name." })]));
    const answers = await ask({ owner: describe(owner) }, questions) as unknown as Record<string, NoulResponse>;
    return chunk.map((_, i) => answers[`p${i}`]!.noul);
  }))).flat();
  const kept = web.filter((p, i) => {
    const tie = ties.get(p.url) ?? null, same = scores[i]!, ok = tie !== null && same >= SAME_PERSON;
    if (ok) admittedWeb.set(p.url, tie!);
    const seen = unconfirmed.get(p.url) ?? { url: p.url, title: p.title, tie, best: 0, passages: 0 };
    unconfirmed.set(p.url, { ...seen, best: Math.max(seen.best, same), passages: seen.passages + 1 });
    return ok;
  });
  for (const url of admittedWeb.keys()) unconfirmed.delete(url);
  ws.counts.identity_passages_checked = (ws.counts.identity_passages_checked ?? 0) + web.length;
  ws.counts.identity_passages_admitted = (ws.counts.identity_passages_admitted ?? 0) + kept.length;
  ws.counts.pages_left_unconfirmed = unconfirmed.size;
  ws.log(`identity: ${web.length} web passages from ${ties.size} pages read by Jev; ${kept.length} admitted (exact tie and same person), ${unconfirmed.size} pages unconfirmed so far${unconfirmed.size ? ` (same-person scores of those: ${[...unconfirmed.values()].map((u) => u.best.toFixed(2)).slice(0, 12).join(", ")})` : ""}`);
  return [...own, ...kept].sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------- review: the page against the evidence (Jev), and what is exact (code)

const EMAILS = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

async function review(ask: Ask, ws: Workspace): Promise<string[]> {
  const html = ws.files["site/index.html"] ?? "", sourcesMd = ws.files["site/SOURCES.md"] ?? "";
  if (!html) return ["site/index.html was not written."];
  const notes = Object.values(ws.notes).join("\n"), publicEmails = [...new Set((notes.match(EMAILS) ?? []).map((e) => e.toLowerCase()))];
  const wrong = await lint(html, sourcesMd, (p) => Bun.file(join(ws.dir, "site", p)).exists(), publicEmails);
  // Links that do not open are not links. Code asks each address once.
  const addresses = [...new Set([...links(html).map((l) => l.href), ...urlsIn(sourcesMd)].filter((u) => /^https?:/i.test(u)))].slice(0, 40);
  const dead = (await Promise.all(addresses.map(async (u) => (await alive(u)) ? null : u))).filter(Boolean);
  if (dead.length) wrong.push(`These addresses do not open for a visitor (private, moved, or need signing in): ${dead.join(", ")}. Remove them, or name the thing without a link.`);

  // Jev: each sentence of the page alone. Does it state a fact; does the evidence say all of it; is it in SOURCES.md.
  const noteLines = evidenceLines(notes), sourceLines = evidenceLines(sourcesMd), said = sentences(html).slice(0, 150);
  // Of SOURCES.md, the fact each table row records (its first cell): the other cells are about the fact, not the person.
  const rows = [...new Set(sourcesMd.split("\n").filter((l) => /^\s*\|/.test(l) && !/^\s*\|\s*:?-{3,}/.test(l)).slice(1).map((l) => l.split("|")[1]?.replace(/\s+/g, " ").trim() ?? "").filter((cell) => cell.split(" ").length >= 3))].slice(0, 80);
  const items = [...said.map((s) => ({ kind: "page" as const, text: s })), ...rows.map((r) => ({ kind: "row" as const, text: r }))];
  const chunks = Array.from({ length: Math.ceil(items.length / 20) }, (_, i) => items.slice(i * 20, (i + 1) * 20));
  const supported = { true: "Every name, school, title, role, tool, date and number in it appears in the evidence, in the same or plainly equivalent words.", false: "It states something the evidence does not say: an extra detail, a stronger claim, a guess, or a different name, date or number." };
  const verdicts = (await Promise.all(chunks.map(async (chunk) => {
    const questions: Questions = {};
    chunk.forEach((item, i) => {
      const quoted = JSON.stringify(item.text.slice(0, 400)), inNotes = evidenceFor(item.text, noteLines, 6), inSources = evidenceFor(item.text, sourceLines, 5);
      questions[`f${i}`] = noul(`This sentence from someone's personal website states a fact about the person or their work that could be checked: a name, a school, a course, a project, a role, a tool, a date, a number. The sentence: ${quoted}`, { true: "It states at least one such fact.", false: "It is a heading, a label, navigation, an invitation to get in touch, or a remark that claims nothing that could be checked." });
      questions[`n${i}`] = noul(`The evidence says everything that this sentence states. The sentence: ${quoted}. The evidence, from research notes: ${JSON.stringify(inNotes.join(" // ").slice(0, 2000))}`, supported);
      if (item.kind === "page") questions[`s${i}`] = noul(`The evidence says everything that this sentence states. The sentence: ${quoted}. The evidence, from the site's list of sources: ${JSON.stringify(inSources.join(" // ").slice(0, 2000))}`, supported);
    });
    const answers = await ask({ task: "Checking a personal website against its evidence, one sentence at a time. Anything about the person that the evidence does not say must not be on the page." }, questions) as unknown as Record<string, NoulResponse>;
    return chunk.map((item, i) => ({ item, fact: answers[`f${i}`]?.noul ?? 1, notes: answers[`n${i}`]!.noul, sources: answers[`s${i}`]?.noul ?? 1, closest: evidenceFor(item.text, noteLines, 1)[0] ?? "" }));
  }))).flat();
  const claims = verdicts.filter((v) => v.fact >= IS_FACT);
  const unsupported = claims.filter((v) => v.notes < (v.item.kind === "page" ? SUPPORTED : SUPPORTED_ROW)).sort((a, b) => a.notes - b.notes), unlisted = claims.filter((v) => v.item.kind === "page" && v.notes >= SUPPORTED && v.sources < SUPPORTED).sort((a, b) => a.sources - b.sources);
  ws.counts.sentences_checked = (ws.counts.sentences_checked ?? 0) + said.length; ws.counts.source_rows_checked = (ws.counts.source_rows_checked ?? 0) + rows.length;
  ws.counts.claims_found = (ws.counts.claims_found ?? 0) + claims.length; ws.counts.claims_sent_back = (ws.counts.claims_sent_back ?? 0) + unsupported.length + unlisted.length;
  ws.log(`review: Jev read ${said.length} sentences and ${rows.length} source rows in ${chunks.length} requests; ${claims.length} state facts, ${unsupported.length} not supported by the notes, ${unlisted.length} not in SOURCES.md; code found ${wrong.length} other problems`);
  await Bun.write(join(ws.dir, "notes", "review.json"), JSON.stringify(verdicts.map((v) => ({ kind: v.item.kind, text: v.item.text, states_a_fact: +v.fact.toFixed(2), in_notes: +v.notes.toFixed(2), in_sources: +v.sources.toFixed(2) })), null, 1));
  for (const v of unsupported.slice(0, 7)) wrong.push(`${v.item.kind === "page" ? "The page says" : "SOURCES.md records the fact"} ${JSON.stringify(v.item.text.slice(0, 260))}, and the notes do not say all of that${v.closest ? ` (the closest note: ${JSON.stringify(v.closest.slice(0, 220))})` : ""}. Say only what the notes say, or remove it.`);
  for (const v of unlisted.slice(0, 5)) wrong.push(`The page says ${JSON.stringify(v.item.text.slice(0, 260))}, and SOURCES.md has no row for that fact. Add the row with where it was found.`);
  return wrong.slice(0, MAX_PROBLEMS);
}

// ---------------------------------------------------------------- build: the record, the checks again, the stills

/** What the run itself knows about who the owner is and what it left out. Exact, so code writes it. */
export function record(owner: Owner | null, left: Unconfirmed[], admitted: [string, string][], searches: SearchRecord[] = []): string {
  const asked = [...new Map(searches.map((q) => [q.query, q])).values()], answered = asked.filter((q) => q.results > 0);
  const a = owner?.account;
  const lines = [MARK, "", "## How the owner was identified", "",
    ...(owner ? [
      `- git's configuration on the machine this ran on names the repository's owner: **${owner.name}**. Their git email is ${maskEmail(owner.email)}; it was used only to match commits and is deliberately not printed here or on the page.`,
      `- ${owner.name} authored ${owner.commits.length} of the ${owner.authors.reduce((n, x) => n + x.commits, 0)} commits in this repository's history${owner.remote ? ` (remote: ${owner.remote}${owner.remoteVisible === false ? ", which is not public and is therefore not linked" : ""})` : ""}. Other authors are teammates; their work is not presented as the owner's.`,
      a ? `- GitHub's public commit search attributes ${a.commits} public commits made with that same email to the account [${a.login}](${a.url}), for example ${a.example}. GitHub links a commit to an account only when the email is verified on it, so that account, its repositories and the documents in them are the owner's own.` : "- No GitHub account could be tied to that email through public commits, so no account is presented as the owner's.",
      `- A page found on the web was used only if BOTH held: its text or links carry an exact tie to the owner (${anchorsOf(owner).filter((x) => x !== owner.email.toLowerCase()).slice(0, 5).map((x) => `\`${x}\``).join(", ") || "none available"}), and Jev judged the passage to be about the same person. The name alone never counted.`,
      ...(admitted.length ? [`- Web pages that passed: ${admitted.map(([url, tie]) => `${url} (tie: ${tie})`).join("; ")}.`] : []),
    ] : ["- Nothing on the machine said who the owner is, so the page states nothing about them."]),
    "", "## What was searched on the web", "",
    asked.length ? `${asked.length} searches were run; ${answered.length} returned results${asked.length > answered.length ? ` (the others returned nothing: no match, or the search engine refused the request, which from here looks the same)` : ""}.\n\n${asked.slice(0, 30).map((q) => `- \`${q.query.replace(/`/g, "'")}\`: ${q.results} results`).join("\n")}` : "No web search was run: everything on the page comes from the repository and the owner's own account.",
    "", "## Found but unconfirmed: not used", "",
    left.length ? "These pages came up in the searches and passed the first sift, but could not be tied to the owner. Nothing from them was shown to a writer, and nothing from them is on the page. People who merely share the owner's name are among them.\n" : (answered.length ? "Every page that the searches returned and that passed the first sift was the owner's own. None was left unconfirmed." : "The searches returned no pages, so there was nothing to confirm or to leave out."),
    ...(left.length ? ["| Page | Why it was not used |", "| --- | --- |", ...left.sort((x, y) => y.best - x.best).slice(0, 40).map((u) => `| ${u.url} (${u.title.replace(/\|/g, "/").slice(0, 90) || "untitled"}) | ${u.tie ? `Carries a tie (${u.tie}), but no passage was judged to be about the owner (same-person score at most ${u.best.toFixed(2)}).` : `No exact tie to the owner on the page; same-person score at most ${u.best.toFixed(2)}. ${u.best >= SAME_PERSON ? "Possibly the owner, but unproven." : "Probably someone else with the same name, or unrelated."}`} |`)] : []),
  ];
  return lines.join("\n");
}

async function build(ws: Workspace): Promise<{ ok: boolean; log: string; outputs: string[] }> {
  const dir = join(ws.dir, "site"), read = (p: string) => Bun.file(join(dir, p)).text().catch(() => "");
  const html = await read("index.html"), written = (await read("SOURCES.md")).split(MARK)[0]!.trimEnd();
  if (!html) return { ok: false, log: "site/index.html does not exist: nothing to build.", outputs: [] };
  const notes = Object.values(ws.notes).join("\n"), problems = await lint(html, written, (p) => Bun.file(join(dir, p)).exists(), [...new Set((notes.match(EMAILS) ?? []).map((e) => e.toLowerCase()))]);
  await ws.write("site/SOURCES.md", `${written}\n\n${record(await theOwner(), [...unconfirmed.values()], [...admittedWeb], searchLog)}\n`);
  const shots = await shoot(dir);
  const ok = problems.length === 0 && shots.made.length >= 2;
  return { ok, outputs: ["site/index.html", "site/SOURCES.md", ...shots.made], log: [`checks: ${problems.length ? problems.join(" | ") : "structure, local links, nothing private, links listed in SOURCES.md: all fine"}`, `SOURCES.md: appended how the owner was identified and ${unconfirmed.size} unconfirmed pages`, shots.log].join("\n") };
}

export const site: Kit = { name: "site", brief: BRIEF, context: ownerContext, sources: () => ownSources(), requery: true, admit, review: (ask, ws) => review(ask, ws), build };
