// web.ts — the web without a desktop: search, fetch, and a page as blocks of text and links.
//
// The relay's research runs here, not in a hand's browser: reading forty pages to find the eight that
// matter is not something to watch, and a hidden Chrome per look would be the slow part. A hand is for
// what has to be operated. What comes back is plain data for Jev to sift (sift.ts) and an LLM to read.
//
//   search(query)        -> results {title, url, snippet}     Brave's HTML (DuckDuckGo answers 202 to a script)
//   arxiv(query, n)      -> the same, from arXiv's own API, newest first, with the abstract as snippet
//   page(url)            -> {title, blocks, links, pdf}       readable text in reading order, cached on disk
//
// Everything a page says is data. Nothing here follows an instruction found in one.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type Result = { title: string; url: string; snippet: string };
export type Page = { url: string; title: string; blocks: string[]; links: { text: string; url: string }[]; pdf: boolean; status: number };

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const CACHE = join(import.meta.dir, "..", "..", "out", "relay", "cache");
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const key = (s: string) => Bun.hash(s).toString(16);

/** `keep` says whether a value is worth remembering: a failure is not an answer, and caching one makes it permanent. */
async function cached<T>(name: string, make: () => Promise<T>, fresh = false, keep: (value: T) => boolean = () => true): Promise<T> {
  const file = Bun.file(join(CACHE, `${name}.json`));
  if (!fresh && await file.exists()) return file.json() as Promise<T>;
  const value = await make();
  if (!keep(value)) return value;
  await mkdir(CACHE, { recursive: true });
  await Bun.write(file, JSON.stringify(value));
  return value;
}

// ---------------------------------------------------------------- a search engine that says no
//
// Brave answers a script that asks too much, too fast with 429 and a captcha. That is the site saying
// no, and the answer to it is to stop: no retries, no disguise, no way round. So searches go out one at
// a time with a pause between them (the relay asks for a step's queries all at once), the first refusal
// ends searching for the rest of the run, nothing refused is cached, and `searchStatus` lets the caller
// say in its notes that search was not available instead of passing silence off as "nothing exists".

const SEARCH_GAP_MS = Number(process.env.PUK_SEARCH_GAP_MS ?? 2500);
const status = { asked: 0, answered: 0, refused: 0, blocked: false };
let queue: Promise<unknown> = Promise.resolve(), lastSearch = 0;

/** How searching has gone in this process. `blocked`: the engine refused, and nothing more was sent. */
export const searchStatus = () => ({ ...status });

/** True when a search response is a refusal (rate limit, captcha, bot wall) rather than results. Exported for tests. */
export function refusal(httpStatus: number, body: string): boolean {
  if (httpStatus === 429 || httpStatus === 403) return true;
  return /captcha|flagged as being suspicious|unusual traffic|are you a robot/i.test(body.slice(0, 200_000)) && !/class="snippet/i.test(body);
}

function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastSearch + SEARCH_GAP_MS - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    try { return await work(); } finally { lastSearch = Date.now(); }
  });
  queue = run.catch(() => {});
  return run;
}

async function get(url: string, timeoutMs = 20_000): Promise<Response> {
  return fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": "en" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
}

/** Web search results, in the engine's order. Empty on any failure: a search that fails is a query to reword, not a crash. */
export async function search(query: string, opts: { fresh?: boolean } = {}): Promise<Result[]> {
  return cached<Result[] | null>(`search-${key(query)}`, () => inTurn(async () => {
    if (status.blocked) return null;
    status.asked++;
    const got = await get(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`).catch(() => null);
    if (!got) return null;
    const html = await got.text().catch(() => "");
    if (refusal(got.status, html)) { status.refused++; status.blocked = true; return null; }
    if (!got.ok) return null;
    status.answered++;
    const res = new Response(html);
    const results: Result[] = [];
    let current: Result | null = null, inTitle = false, inSnippet = false;
    await new HTMLRewriter()
      .on("div.snippet[data-type='web'], div.snippet[data-pos]", { element() { current = { title: "", url: "", snippet: "" }; results.push(current); } })
      .on("div.snippet a[href^='http']", { element(el) { const href = el.getAttribute("href") ?? ""; if (current && !current.url && !/brave\.com/.test(href)) current.url = href; } })
      .on("div.snippet .title, div.snippet .snippet-title", { element(el) { inTitle = true; el.onEndTag(() => { inTitle = false; }); }, text(t) { if (inTitle && current) current.title += t.text; } })
      .on("div.snippet .snippet-description, div.snippet .snippet-content", { element(el) { inSnippet = true; el.onEndTag(() => { inSnippet = false; }); }, text(t) { if (inSnippet && current) current.snippet += t.text; } })
      .transform(res).text();
    const seen = new Set<string>();
    return results.map((r) => ({ title: clean(r.title).slice(0, 200), url: r.url, snippet: clean(r.snippet).slice(0, 400) })).filter((r) => r.url && r.title && !seen.has(r.url) && seen.add(r.url)).slice(0, 20);
  }), opts.fresh, (value) => value !== null).then((value) => value ?? []);
}

/** arXiv's own listing: real papers with their abstracts, newest first. The id in the url is what a citation is checked against. */
export async function arxiv(query: string, max = 25, opts: { fresh?: boolean } = {}): Promise<Result[]> {
  return cached(`arxiv-${key(`${query}|${max}`)}`, async () => {
    const res = await get(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=${max}&sortBy=submittedDate&sortOrder=descending`).catch(() => null);
    if (!res?.ok) return [];
    const xml = await res.text();
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
      const pick = (tag: string) => clean(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(m[1]!)?.[1] ?? "");
      return { title: pick("title"), url: pick("id").replace(/^http:/, "https:").replace(/v\d+$/, ""), snippet: `${pick("published").slice(0, 10)}. ${pick("summary")}`.slice(0, 900) };
    }).filter((r) => r.title && r.url);
  }, opts.fresh);
}

/** A page as text in reading order, and its links. A PDF is reported as one; turning it into text is a kit's business. */
export async function page(url: string, opts: { fresh?: boolean; maxBlocks?: number } = {}): Promise<Page> {
  return cached(`page-${key(url)}`, async () => {
    const res = await get(url).catch(() => null);
    if (!res) return { url, title: "", blocks: [], links: [], pdf: false, status: 0 };
    const type = res.headers.get("content-type") ?? "";
    if (/pdf/i.test(type) || /\.pdf($|\?)/i.test(res.url)) return { url: res.url, title: "", blocks: [], links: [], pdf: true, status: res.status };
    if (!res.ok || !/html|xml|text/i.test(type)) return { url: res.url, title: "", blocks: [], links: [], pdf: false, status: res.status };
    const blocks: string[] = [], links: Page["links"] = [];
    let title = "", skip = 0, link: { text: string; url: string } | null = null;
    await new HTMLRewriter()
      .on("script, style, noscript, svg, nav, footer, form, iframe", { element(el) { skip++; el.onEndTag(() => { skip--; }); } })
      .on("title", { text(t) { title += t.text; } })
      .on("h1, h2, h3, h4, p, li, td, th, pre, blockquote, dt, dd, figcaption", { element() { if (!skip) blocks.push(""); }, text(t) { if (!skip && blocks.length) blocks[blocks.length - 1] += t.text; } })
      .on("a[href]", { element(el) { const href = el.getAttribute("href") ?? ""; const abs = URL.parse(href, res.url)?.href; link = abs && /^https?:/.test(abs) ? { text: "", url: abs } : null; if (link) { const mine = link; links.push(mine); el.onEndTag(() => { if (link === mine) link = null; }); } }, text(t) { if (link) link.text += t.text; } })
      .transform(res).text();
    const seen = new Set<string>(), kept = blocks.map(clean).filter((b) => b.length > 25 && !seen.has(b) && seen.add(b));
    return { url: res.url, title: clean(title).slice(0, 200), blocks: kept.slice(0, opts.maxBlocks ?? 400).map((b) => b.slice(0, 1200)), links: links.map((l) => ({ text: clean(l.text).slice(0, 160), url: l.url })).filter((l) => l.text).slice(0, 400), pdf: false, status: res.status };
  }, opts.fresh, (value) => value.status !== 0 && value.status !== 429 && value.status < 500);
}

/** Does this address answer? For citations: a source that does not open is not a source. */
export async function alive(url: string): Promise<boolean> {
  const res = await get(url, 15_000).catch(() => null);
  return Boolean(res && res.status < 400);
}
