/**
 * Jev builds the simplest Intent by itself: open a site, or search one.
 *
 * Jev cannot write, so the intent is assembled from things it can pick:
 *
 *   site   one of SITES, or a url that was said out loud (never one Jev made up)
 *   text   a literal run of words from what was said, e.g. "capybaras"
 *
 *   quickIntent(ask, "search wikipedia for capybaras")
 *     -> { url: "https://www.wikipedia.org/", inputs: { search_query: "capybaras" }, ... }
 *
 * One request. Anything that needs writing (a message body, a reply) is not for this file: it returns null, and
 * pilot.ts only trusts what it returns when Jev also says the request is that simple.
 */

import { type Ask, choice, MAX_CHOICES } from "./ask.ts";
import type { Intent } from "./intent.ts";

/** Sites Jev can open by itself. The descriptions are what it reads to choose. */
export const SITES = {
  wikipedia: { url: "https://www.wikipedia.org/", description: "Wikipedia, the encyclopedia." },
  google: { url: "https://www.google.com/", description: "Google web search. Also for 'search for' or 'look up' when no site is named." },
  youtube: { url: "https://www.youtube.com/", description: "YouTube, for videos and music." },
  google_maps: { url: "https://www.google.com/maps", description: "Google Maps: places, directions, how far something is." },
  gmail: { url: "https://mail.google.com/", description: "Gmail: email. Reading, finding, writing and sending a message. Right for 'email someone' when no mail service is named." },
  google_calendar: { url: "https://calendar.google.com/", description: "Google Calendar: look at the schedule." },
  google_drive: { url: "https://drive.google.com/", description: "Google Drive: find a document or file stored online." },
  github: { url: "https://github.com/", description: "GitHub: code repositories, issues, pull requests." },
  amazon: { url: "https://www.amazon.com/", description: "Amazon: look for a product." },
  reddit: { url: "https://www.reddit.com/", description: "Reddit." },
  hacker_news: { url: "https://news.ycombinator.com/", description: "Hacker News." },
} as const;

const [OTHER_SITE, NO_SITE, NOTHING, NEEDS_WRITER] = ["other_site", "no_site", "nothing_to_type", "needs_writer"];
const MIN_CONFIDENCE = 0.5; // below this in any pick, Jev does not get to build the intent alone
const [MAX_SPAN_WORDS, SPAN_WINDOW] = [6, 30];

/** Every literal run Jev may pick: quoted phrases and whole tails first, so a cap never costs the long ones. Spacing and programming punctuation (C++, std::vector) are kept. */
export function literalSpansOf(text: string, limit = MAX_CHOICES - 2): string[] {
  const spans = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim().replace(/^["“”]+|["“”.,!?]+$/gu, "");
    if (spans.size < limit && /[\p{L}\p{N}]/u.test(trimmed)) spans.add(trimmed);
  };
  for (const quoted of text.matchAll(/"([^"\n]+)"|“([^”\n]+)”|'([^'\n]+)'/gu)) add(quoted[1] ?? quoted[2] ?? quoted[3]!);
  const words = [...text.matchAll(/\S+/gu)].slice(-SPAN_WINDOW);
  for (const word of words) add(text.slice(word.index));
  for (let n = 1; n <= MAX_SPAN_WORDS; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const [first, last] = [words[i]!, words[i + n - 1]!];
      add(text.slice(first.index, last.index! + last[0].length));
    }
  }
  return [...spans];
}

/** Only explicit http(s) URLs. Jev selects among these; it never invents one. */
export function suppliedUrls(text: string): Record<string, { url: string; description: string }> {
  const urls = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"“”]+/giu)) {
    const url = URL.parse(match[0].replace(/[.,!?;)'\]]+$/u, ""));
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
    if (urls.size >= 8) break;
    urls.add(url.href);
  }
  return Object.fromEntries([...urls].map((url, i) => [`supplied_url_${i}`, { url, description: `The URL explicitly supplied in request: ${url}` }]));
}

/** An explicit writing command needs no classifier round trip to be refused. */
function isWritingCommand(request: string): boolean {
  let command = request.trim();
  for (let n = 0; n < 4; n++) command = command.replace(/^(?:(?:please|actually|now|okay|ok)\b[:,]?\s*|(?:can|could|would|will)\s+you\s+|i\s+(?:want|need)\s+(?:you\s+)?to\s+|help\s+me\s+)/i, "");
  return (
    /^(?:draft|compose|reply|respond|email|e-mail|message|forward)\b/i.test(command) ||
    /^send\b.{0,160}\b(?:e-?mail|messages?|reply|response|note|text)\b/i.test(command) ||
    /^write\b.{0,120}\b(?:e-?mail|messages?|reply|response|post|letter|note|summary)\b/i.test(command)
  );
}

/** An Intent from Jev's picks alone, or null when the request is not that simple. */
export async function quickIntent(ask: Ask, said: string): Promise<Intent | null> {
  const request = said.trim();
  const spans = literalSpansOf(request);
  if (isWritingCommand(request) || spans.length === 0) return null;
  const sites: Record<string, { url: string; description: string }> = { ...SITES, ...suppliedUrls(request) };

  const a = await ask(
    { request },
    {
      site: choice("Which website should be opened to carry out `request`? A URL to visit is the destination; a URL mentioned as a search query is not the destination.", {
        ...Object.fromEntries(Object.entries(sites).map(([name, s]) => [name, s.description])),
        [OTHER_SITE]: "A specific website or web app that is not in this list.",
        [NO_SITE]: "No website. The request is not about the web: it is about an application on this computer, a file, or what is already open.",
      }),
      text: choice(
        "Can this request use a single literal search or field value? For composing/replying to a message, generating prose, assigning recipient/subject/body or other multiple fields, choose needs_writer even if some words are supplied. Otherwise select the exact complete query to enter AFTER opening the destination, without command words. A URL to visit is navigation: choose nothing_to_type.",
        {
          ...Object.fromEntries(spans.map((s) => [s, null])),
          [NOTHING]: "Nothing. The request only names a site to open.",
          [NEEDS_WRITER]: "Writing or structured fields are required: an email/message/reply, recipient and subject/body, generated prose. Do not turn this into one search query.",
        },
      ),
    },
  );
  const [site, picked] = [a.site.choice as string, a.text.choice as string]; // span labels are only known at run time
  // Only a model can come up with a url, and only a plan can carry more than one text.
  if (a.site.confidence < MIN_CONFIDENCE || !sites[site] || picked === NEEDS_WRITER) return null;
  let typed = picked !== NOTHING && a.text.confidence >= MIN_CONFIDENCE ? picked : null;
  // "open youtube": Jev tends to pick the site's own name as the words to type. Nobody searches YouTube for "youtube".
  if (typed && (site.replace(/_/g, " ") === typed.toLowerCase() || sites[site]!.url === URL.parse(typed)?.href)) typed = null;
  return {
    goal: request,
    url: sites[site]!.url,
    inputs: typed ? { search_query: typed } : {},
    doneWhen: `The screen shows the result of what was asked: ${JSON.stringify(request)}`,
    avoid: [],
  };
}
