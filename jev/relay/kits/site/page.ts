// kits/site/page.ts — the written page, taken apart by code so that Jev can read it a sentence at a time.
//
// Exact things are code's: is there one h1, does every local link exist, is there a word that marks an
// unfinished page, is a phone number printed. Whether a sentence says more than the evidence does is a
// closed question per sentence, and there are dozens of sentences: that is Jev's (see ../site.ts).

export type Link = { text: string; href: string };

const decode = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;|&lsquo;|&apos;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&mdash;|&ndash;/g, "-").replace(/&middot;|&bull;/g, "-").replace(/&rarr;/g, "->").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
const body = (html: string) => html.replace(/<!--[\s\S]*?-->|<(script|style|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, " ");

/** What a visitor reads, one line per block element. */
export function visibleLines(html: string): string[] {
  return decode(body(html).replace(/<\/(p|li|h[1-6]|div|section|header|footer|tr|ul|ol|dd|dt|figcaption|blockquote|article|main|nav)\s*>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** The lines, as sentences worth checking: four words or more. Abbreviations and initials do not end a sentence. */
export function sentences(html: string): string[] {
  const seen = new Set<string>();
  return visibleLines(html).flatMap((line) => line.replace(/\b(Prof|Dr|Mr|Ms|Mrs|St|vs|etc|e\.g|i\.e|No|Fig|[A-Z])\./g, "$1\u0000").split(/(?<=[.!?]["'\u201d\u2019)\]]?)\s+(?=[A-Z0-9"'\u201c\u2018(\[])/).map((s) => s.replace(/\u0000/g, ".").trim()))
    .filter((s) => s.split(/\s+/).length >= 4 && !seen.has(s) && seen.add(s));
}

export function links(html: string): Link[] {
  return [...body(html).matchAll(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi)].map((m) => ({ href: decode(m[1]!), text: decode(m[2]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() }));
}

export const urlsIn = (text: string) => [...new Set([...text.matchAll(/https?:\/\/[^\s)>\]"'`|]+/g)].map((m) => m[0].replace(/[.,;:]+$/, "")))];

const STOP = new Set("the and for with that this from are was were has have had its his her their they you your our not but also into over under about than then when what which who whom how why can will would could should may might more most some any all each every one two three here there them these those been being very much many such only own same other its it's i'm i've".split(" "));
export const keywords = (s: string) => s.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2 && !STOP.has(w));

/** The evidence lines closest to a claim, by shared words, rare words counting for more. Retrieval is arithmetic, so it is code's. */
export function evidenceFor(claim: string, lines: string[], k = 4): string[] {
  const words = new Set(keywords(claim));
  if (!words.size) return [];
  const df = new Map<string, number>(), bags = lines.map((l) => new Set(keywords(l)));
  for (const bag of bags) for (const w of bag) df.set(w, (df.get(w) ?? 0) + 1);
  return bags.map((bag, i) => ({ i, score: [...words].reduce((sum, w) => sum + (bag.has(w) ? 1 / Math.log(2 + (df.get(w) ?? 0)) : 0), 0) }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k).map((x) => lines[x.i]!);
}

/** Notes and SOURCES.md as evidence lines: a line is a bullet, a table row or a paragraph. */
export const evidenceLines = (text: string) => text.split("\n").map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim()).filter((l) => l.length > 20 && !/^\|?\s*:?-{3,}/.test(l)).map((l) => l.slice(0, 600));

const FILLER = /lorem ipsum|\bTODO\b|\bTBD\b|your name|john doe|jane doe|example\.(?:com|org)|placeholder|coming soon/i;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3}[\s.-]\d{3,4}[\s.-]\d{3,4}\b/;
const EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const CONTAINERS = new Set("html head body header main section article footer nav div ul ol table a h1 h2 h3 h4 h5 h6 span style title".split(" "));

/** Tags that are opened and not closed, or closed and never opened, among those that must pair. */
export function unbalanced(html: string): string[] {
  const stack: string[] = [], wrong: string[] = [];
  for (const m of html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "").matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>/gi)) {
    const tag = m[2]!.toLowerCase();
    if (!CONTAINERS.has(tag) || m[3]) continue;
    if (!m[1]) { stack.push(tag); continue; }
    const at = stack.lastIndexOf(tag);
    if (at < 0) { wrong.push(`</${tag}> closes nothing`); continue; }
    for (const open of stack.splice(at).slice(1)) wrong.push(`<${open}> is not closed before </${tag}>`);
  }
  return [...wrong, ...stack.map((t) => `<${t}> is never closed`)].slice(0, 6);
}

/** Everything about the two files that is exact. `exists` answers for a local path the page refers to; `allowedEmails` are addresses the evidence itself makes public. */
export async function lint(html: string, sourcesMd: string, exists: (path: string) => Promise<boolean>, allowedEmails: string[] = []): Promise<string[]> {
  const wrong: string[] = [], text = visibleLines(html).join("\n"), count = (re: RegExp) => (html.match(re) ?? []).length;
  if (!html.trim()) return ["site/index.html was not written."];
  if (!/^\s*<!doctype html>/i.test(html)) wrong.push("index.html must begin with <!DOCTYPE html>.");
  if (!/<html[^>]*\blang=/i.test(html)) wrong.push("The <html> element needs a lang attribute.");
  if (!/<title>[^<]{3,}/i.test(html)) wrong.push("The page needs a <title> of at least three characters.");
  if (!/name=["']viewport["']/i.test(html)) wrong.push('The page needs <meta name="viewport" content="width=device-width, initial-scale=1">.');
  if (count(/<h1[\s>]/gi) !== 1) wrong.push(`The page must have exactly one <h1>; it has ${count(/<h1[\s>]/gi)}.`);
  if (count(/<section[\s>]/gi) < 3) wrong.push(`The page needs at least three <section> elements (introduction, projects, contact); it has ${count(/<section[\s>]/gi)}.`);
  const filler = FILLER.exec(html);
  if (filler) wrong.push(`Remove "${filler[0]}" everywhere in index.html, including class names, comments and CSS (say nothing rather than mark a gap).`);
  if (/<script[^>]+src=["'](?:https?:)?\/\/|<link[^>]+href=["'](?:https?:)?\/\/|@import\s+url\(\s*["']?(?:https?:)?\/\/|<img[^>]+src=["'](?:https?:)?\/\//i.test(html)) wrong.push("The page must be self-contained: no remote scripts, stylesheets, fonts or images.");
  const local = [...html.matchAll(/(?:href|src)=["']([^"'#]+)["']/gi)].map((m) => m[1]!).filter((u) => !/^(https?:|mailto:|tel:|data:|\/\/)/i.test(u));
  for (const u of new Set(local)) if (!(await exists(u))) wrong.push(`The page refers to "${u}", which does not exist in site/. Write that file or remove the reference.`);
  const issues = unbalanced(html);
  if (issues.length) wrong.push(`The HTML is not well formed: ${issues.join("; ")}.`);
  if (PHONE.test(text) || /href=["']tel:/i.test(html)) wrong.push("A phone number is printed on the page. Remove it: nothing private is published.");
  const emails = [...new Set([...(html.match(EMAIL) ?? []), ...(sourcesMd.match(EMAIL) ?? [])].map((e) => e.toLowerCase()))].filter((e) => !allowedEmails.includes(e) && !/\.(png|jpg|svg|css|js)$/.test(e));
  if (emails.length) wrong.push(`An email address is printed (${emails.map((e) => e.replace(/^[^@]+/, "...")).join(", ")}) that no public source shows. Remove it from the page and from SOURCES.md; the way to get in touch is a public profile.`);
  if (sourcesMd.split(/\s+/).filter(Boolean).length <= 30) wrong.push("site/SOURCES.md is missing or too short: it must list every fact the page states and where it was found.");
  const unlisted = links(html).map((l) => l.href).filter((h) => /^https?:/i.test(h) && !sourcesMd.includes(h.replace(/\/$/, "")));
  if (unlisted.length) wrong.push(`These links are on the page but not in SOURCES.md: ${[...new Set(unlisted)].slice(0, 6).join(", ")}. List each with where it was found.`);
  return wrong;
}
