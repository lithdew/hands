// web.ts — the web without a desktop: search, fetch, and a page as blocks of text and links.
//
// The relay's research runs here, not in a hand's browser: reading forty pages to find the eight that
// matter is not something to watch, and a hidden Chrome per look would be the slow part. A hand is for
// what has to be operated. What comes back is plain data for Jev to sift (sift.ts) and an LLM to read.
//
//   search(query)        -> results {title, url, snippet}     Brave's HTML, and DuckDuckGo's when Brave refuses or finds nothing
//   searchLog            -> every search this process ran, how many results, and from where
//   arxiv(query, n)      -> the same, from arXiv's own API, with the whole abstract as `text` (newest first, or by relevance)
//   arxivByIds(ids)      -> arXiv's own record of papers whose ids turned up somewhere else
//   page(url)            -> {title, blocks, links, pdf}       readable text in reading order, cached on disk
//   cached(name, make)   -> the disk cache itself, for a kit's own requests (an API's answers)
//
// Everything a page says is data. Nothing here follows an instruction found in one.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * A result may bring what it says, and then it is never fetched. Two shapes, because they are read differently:
 * `text`: ONE whole text (an abstract). Jev judges it once, as a search result, and it is kept or dropped as a whole.
 * `blocks`: a document in passages (a local file, an API's answer). It skips the sift of results and the budget of
 * pages to open; Jev sifts its passages one by one, like a fetched page's. With both, `blocks` decides.
 */
export type Result = { title: string; url: string; snippet: string; text?: string; blocks?: string[]; date?: string };
export type Page = { url: string; title: string; blocks: string[]; links: { text: string; url: string }[]; pdf: boolean; status: number };

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const CACHE = join(import.meta.dir, "..", "..", "out", "relay", "cache");
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const key = (s: string) => Bun.hash(s).toString(16);

// A failure is not an answer. An empty listing or a page that did not come (a 429, a timeout) is not kept:
// one bad minute would otherwise empty that query for every later run. Callers asking for the same thing
// at the same moment share one fetch. `worthKeeping` is the rule for this file's own values; a kit that
// caches its own requests says with `keep` what a failure looks like for it (null, an empty string).
const pending = new Map<string, Promise<unknown>>();
export function worthKeeping(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  const status = (value as { status?: unknown } | null)?.status;
  return typeof status !== "number" || !(status === 0 || status === 429 || status >= 500);
}

/** The disk cache. `keep` says whether a value is an answer (kept, and believed when read back) or a failure (returned, never remembered). */
export async function cached<T>(name: string, make: () => Promise<T>, fresh = false, keep: (value: T) => boolean = worthKeeping): Promise<T> {
  const file = Bun.file(join(CACHE, `${name}.json`));
  if (!fresh && await file.exists()) { const kept = await (file.json() as Promise<T>).catch(() => undefined); if (kept !== undefined && keep(kept)) return kept; }
  if (pending.has(name)) return pending.get(name) as Promise<T>;
  const work = (async () => {
    const value = await make();
    if (keep(value)) { await mkdir(CACHE, { recursive: true }); await Bun.write(file, JSON.stringify(value)); }
    return value;
  })().finally(() => pending.delete(name));
  pending.set(name, work);
  return work;
}

/** At most `n` of these run at once; the rest wait their turn. An engine that sees thirty requests in a second answers 429 to all of them. */
export function limiter(n: number): <T>(work: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (work) => {
    // A finished piece of work hands its place straight to the next in line, so nothing arriving in between can take it.
    if (running >= n) await new Promise<void>((go) => waiting.push(go)); else running++;
    try { return await work(); } finally { const next = waiting.shift(); if (next) next(); else running--; }
  };
}
/** One at a time, and no sooner than `gapMs` after the one before began. */
export function paced(gapMs: number): <T>(work: () => Promise<T>) => Promise<T> {
  let next = 0, line: Promise<unknown> = Promise.resolve();
  return (work) => {
    const mine = line.then(async () => { const wait = next - Date.now(); if (wait > 0) await Bun.sleep(wait); next = Date.now() + gapMs; return work(); });
    line = mine.catch(() => {});
    return mine;
  };
}
// arXiv asks for one request every three seconds over one connection. Measured: twenty-five in four seconds were all
// answered, and then every request for the next five minutes got 429, the judge's among them. So: few, large, slow.
const searchTurn = limiter(2), duckTurn = limiter(2), arxivTurn = paced(3_100);
let searchRefusedUntil = 0, duckRefusedUntil = 0, arxivRefusedUntil = 0;
async function arxivGet(url: string): Promise<Result[]> {
  if (Date.now() < arxivRefusedUntil) return [];
  const res = await arxivTurn(async () => Date.now() < arxivRefusedUntil ? null : get(url, 40_000).catch(() => null));
  if (res?.status === 429) arxivRefusedUntil = Date.now() + 120_000;
  return res?.ok ? arxivEntries(await res.text()) : [];
}

async function get(url: string, timeoutMs = 20_000): Promise<Response> {
  return fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": "en" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
}

/** Every search this process ran, and where its results came from. "nothing" is no results, or every engine refusing (429, a captcha): the two look the same from here, so neither is cached, and a kit can say honestly what was and was not searched. */
export type SearchRecord = { query: string; results: number; from: "cache" | "brave" | "duckduckgo" | "nothing" };
export const searchLog: SearchRecord[] = [];

/** Web search results, in the engine's order. Empty on any failure: a search that fails is a query to reword, not a crash. */
export async function search(query: string, opts: { fresh?: boolean } = {}): Promise<Result[]> {
  // Brave first; when it refuses (429 and a captcha, once a few runs share an address) or finds nothing, DuckDuckGo's HTML.
  let from: SearchRecord["from"] = "cache";
  const results = await cached(`search-${key(query)}`, async () => {
    const brave = await braveSearch(query);
    if (brave.length) { from = "brave"; return brave; }
    const duck = await duckSearch(query);
    from = duck.length ? "duckduckgo" : "nothing";
    return duck;
  }, opts.fresh);
  searchLog.push({ query, results: results.length, from: results.length ? from : "nothing" });
  return results;
}

const tidy = (results: Result[]): Result[] => { const seen = new Set<string>(); return results.map((r) => ({ title: clean(r.title).slice(0, 200), url: r.url, snippet: clean(r.snippet).slice(0, 400) })).filter((r) => r.url && r.title && !seen.has(r.url) && seen.add(r.url)).slice(0, 20); };

async function braveSearch(query: string): Promise<Result[]> {
  // Two at a time. And once the engine refuses (429), asking again at once only lengthens the refusal: leave it alone for a while.
  const res = await searchTurn(async () => Date.now() < searchRefusedUntil ? null : get(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`).catch(() => null));
  if (res?.status === 429) searchRefusedUntil = Date.now() + 45_000;
  if (!res?.ok) return [];
  const results: Result[] = [];
  let current: Result | null = null, inTitle = false, inSnippet = false;
  await new HTMLRewriter()
    .on("div.snippet[data-type='web'], div.snippet[data-pos]", { element() { current = { title: "", url: "", snippet: "" }; results.push(current); } })
    .on("div.snippet a[href^='http']", { element(el) { const href = el.getAttribute("href") ?? ""; if (current && !current.url && !/brave\.com/.test(href)) current.url = href; } })
    .on("div.snippet .title, div.snippet .snippet-title", { element(el) { inTitle = true; el.onEndTag(() => { inTitle = false; }); }, text(t) { if (inTitle && current) current.title += t.text; } })
    .on("div.snippet .snippet-description, div.snippet .snippet-content", { element(el) { inSnippet = true; el.onEndTag(() => { inSnippet = false; }); }, text(t) { if (inSnippet && current) current.snippet += t.text; } })
    .transform(res).text();
  return tidy(results);
}

const unescapeHtml = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** DuckDuckGo's HTML results: a link's real address is the `uddg` parameter of a redirect. Exported for tests. */
export async function duckResults(html: string): Promise<Result[]> {
  const results: Result[] = [];
  let current: Result | null = null, inTitle = false, inSnippet = false;
  await new HTMLRewriter()
    .on("a.result__a", { element(el) {
      const href = el.getAttribute("href") ?? "", real = URL.parse(unescapeHtml(href), "https://duckduckgo.com")?.searchParams.get("uddg") ?? href;
      current = { title: "", url: /^https?:/.test(real) && !/duckduckgo\.com\/y\.js/.test(real) ? real : "", snippet: "" }; results.push(current);
      inTitle = true; el.onEndTag(() => { inTitle = false; });
    }, text(t) { if (inTitle && current) current.title += t.text; } })
    .on("a.result__snippet", { element(el) { inSnippet = true; el.onEndTag(() => { inSnippet = false; }); }, text(t) { if (inSnippet && current) current.snippet += t.text; } })
    .transform(new Response(html)).text();
  return tidy(results.map((r) => ({ ...r, title: unescapeHtml(r.title), snippet: unescapeHtml(r.snippet) })));
}

/** The engine behind the first: asked the same careful way, two at a time, and left alone for a while once it refuses (a 202 is its refusal to a script). */
async function duckSearch(query: string): Promise<Result[]> {
  const res = await duckTurn(async () => Date.now() < duckRefusedUntil ? null : get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`).catch(() => null));
  if (res && (res.status === 429 || res.status === 202 || res.status === 403)) duckRefusedUntil = Date.now() + 45_000;
  return res?.status === 200 ? duckResults(await res.text()) : [];
}

/** The entries of an arXiv API answer. `text` is the whole abstract: a writer needs all of it to say what the paper did. */
export function arxivEntries(xml: string): Result[] {
  const plain = (s: string) => clean(s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&"));
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const pick = (tag: string) => plain(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(m[1]!)?.[1] ?? "");
    const date = pick("published").slice(0, 10), text = pick("summary");
    return { title: pick("title"), url: pick("id").replace(/^http:/, "https:").replace(/v\d+$/, ""), snippet: `${date}. ${text}`.slice(0, 900), text, date };
  }).filter((r) => r.title && /arxiv\.org\/abs\//.test(r.url));
}

/** arXiv's own listing: real papers with their abstracts, newest first unless `sort` says by relevance. The id in the url is what a citation is checked against. */
export async function arxiv(query: string, max = 25, opts: { fresh?: boolean; sort?: "submittedDate" | "relevance" } = {}): Promise<Result[]> {
  const sort = opts.sort ?? "submittedDate";
  return cached(`arxiv-${key(`${query}|${max}|${sort}|text`)}`, () => arxivGet(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=${max}&sortBy=${sort}&sortOrder=descending`), opts.fresh);
}

/** arXiv's own record of these ids (the 2501.01234 of arxiv.org/abs/2501.01234): the exact title and whole abstract of a paper that turned up somewhere else. */
export async function arxivByIds(ids: string[], opts: { fresh?: boolean } = {}): Promise<Result[]> {
  const wanted = [...new Set(ids)].sort();
  const lots = Array.from({ length: Math.ceil(wanted.length / 50) }, (_, i) => wanted.slice(i * 50, (i + 1) * 50));
  return (await Promise.all(lots.map((lot) => cached(`arxiv-ids-${key(lot.join(","))}`, () => arxivGet(`https://export.arxiv.org/api/query?id_list=${lot.join(",")}&max_results=${lot.length}`), opts.fresh)))).flat();
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
  }, opts.fresh);
}

/** Does this address answer? For citations: a source that does not open is not a source. */
export async function alive(url: string): Promise<boolean> {
  const res = await get(url, 15_000).catch(() => null);
  return Boolean(res && res.status < 400);
}
