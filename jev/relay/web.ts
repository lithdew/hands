// web.ts — the web without a desktop: search, fetch, and a page as blocks of text and links.
//
// The relay's research runs here, not in a hand's browser: reading forty pages to find the eight that
// matter is not something to watch, and a hidden Chrome per look would be the slow part. A hand is for
// what has to be operated. What comes back is plain data for Jev to sift (sift.ts) and an LLM to read.
//
//   search(query)        -> results {title, url, snippet}     Brave's HTML, and DuckDuckGo's when Brave refuses
//   arxiv(query, n)      -> the same, from arXiv's own API, newest first, with the abstract as snippet
//   page(url)            -> {title, blocks, links, pdf}       readable text in reading order, cached on disk
//
// Everything a page says is data. Nothing here follows an instruction found in one.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** `blocks`: a source that comes with its text (a local file, an API's answer). It is not fetched again; its passages are sifted like any page's. */
export type Result = { title: string; url: string; snippet: string; blocks?: string[] };
export type Page = { url: string; title: string; blocks: string[]; links: { text: string; url: string }[]; pdf: boolean; status: number };

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const CACHE = join(import.meta.dir, "..", "..", "out", "relay", "cache");
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const key = (s: string) => Bun.hash(s).toString(16);

/** `keep` says whether a value is worth keeping: a search that was refused (429, a captcha) must not be remembered as "no results". */
export async function cached<T>(name: string, make: () => Promise<T>, fresh = false, keep: (value: T) => boolean = () => true): Promise<T> {
  const file = Bun.file(join(CACHE, `${name}.json`));
  if (!fresh && await file.exists()) return file.json() as Promise<T>;
  const value = await make();
  if (!keep(value)) return value;
  await mkdir(CACHE, { recursive: true });
  await Bun.write(file, JSON.stringify(value));
  return value;
}

async function get(url: string, timeoutMs = 20_000): Promise<Response> {
  return fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": "en" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
}

/** Web search results, in the engine's order. Empty on any failure: a search that fails is a query to reword, not a crash. */
export async function search(query: string, opts: { fresh?: boolean } = {}): Promise<Result[]> {
  // Brave first; when it refuses (429 and a captcha, once a few runs share an address) DuckDuckGo's HTML. A refusal is not cached.
  let from: SearchRecord["from"] = "cache";
  const results = await cached(`search-${key(query)}`, async () => {
    const brave = await braveSearch(query);
    if (brave.length) { from = "brave"; return brave; }
    const duck = await duckSearch(query);
    from = duck.length ? "duckduckgo" : "nothing";
    return duck;
  }, opts.fresh, (found) => found.length > 0);
  searchLog.push({ query, results: results.length, from });
  return results;
}

/** Every search this process ran, and where its results came from. "nothing" is no results, or every engine refusing (429, a captcha): the two look the same from here, so neither is cached, and a kit can say honestly what was and was not searched. */
export type SearchRecord = { query: string; results: number; from: "cache" | "brave" | "duckduckgo" | "nothing" };
export const searchLog: SearchRecord[] = [];

const tidy = (results: Result[]): Result[] => { const seen = new Set<string>(); return results.map((r) => ({ title: clean(r.title).slice(0, 200), url: r.url, snippet: clean(r.snippet).slice(0, 400) })).filter((r) => r.url && r.title && !seen.has(r.url) && seen.add(r.url)).slice(0, 20); };

async function braveSearch(query: string): Promise<Result[]> {
  const res = await get(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`).catch(() => null);
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

async function duckSearch(query: string): Promise<Result[]> {
  const res = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`).catch(() => null);
  return res?.ok ? duckResults(await res.text()) : [];
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
  }, opts.fresh);
}

/** Does this address answer? For citations: a source that does not open is not a source. */
export async function alive(url: string): Promise<boolean> {
  const res = await get(url, 15_000).catch(() => null);
  return Boolean(res && res.status < 400);
}
