// quick.ts — Jev builds a simple Intent by itself, with no language model.
//
// Jev cannot write, so the intent is assembled from things it can pick:
//
//   launcher   one of LAUNCHERS
//   site       one of SITES (or "a site that is not listed", which means: ask the LLM)
//   text       a literal run of words from what was said, e.g. "capybaras"
//
//   quickIntent(ask, "search wikipedia for capybaras")
//     -> { launcher: "browser", url: "https://www.wikipedia.org/",
//          inputs: { search_query: "capybaras" }, ... }
//
// One request, about 250 ms, so listen.ts can rebuild it on every new word.
// Anything that needs writing (a message body, a reply) is not for this file:
// `quickIntent` returns null and the caller uses intent.ts.

import type { Intent, Launcher } from "./intent";
import { choice, MAX_CHOICES, type Ask } from "./jev";

// ---------------------------------------------------------------- config

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

const OTHER_SITE = "other_site";
const NO_SITE = "no_site";
const NOTHING = "nothing_to_type";
const NEEDS_WRITER = "needs_writer";

/** Below this confidence in any pick, Jev does not get to build the intent alone. */
const MIN_CONFIDENCE = 0.5;
const MAX_SPAN_WORDS = 6;
const SPAN_WINDOW = 30;

// ---------------------------------------------------------------- spans

/** Every run of up to `MAX_SPAN_WORDS` words from the end of `text`. Exported for tests. */
export function spansOf(text: string, limit = MAX_CHOICES - 1): string[] {
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}@#]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean)
    .slice(-SPAN_WINDOW);
  const spans = new Set<string>();
  // Short runs first: if the limit bites, it is the long ones that go.
  for (let n = 1; n <= MAX_SPAN_WORDS; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      if (spans.size >= limit) return [...spans];
      spans.add(words.slice(i, i + n).join(" "));
    }
  }
  return [...spans];
}

/** Literal alternatives include long suffixes and quoted phrases, so code does
 * not silently make queries longer than six words impossible for Jev to select.
 * Keep programming punctuation (C++, std::vector) and original internal spacing.
 */
export function literalSpansOf(text: string, limit = MAX_CHOICES - 1): string[] {
  const spans = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim().replace(/^["“”]+|["“”.,!?]+$/gu, "");
    if (spans.size < limit && /[\p{L}\p{N}]/u.test(trimmed)) spans.add(trimmed);
  };
  for (const quoted of text.matchAll(/"([^"\n]+)"|“([^”\n]+)”|'([^'\n]+)'/gu)) add(quoted[1] ?? quoted[2] ?? quoted[3]!);
  const words = [...text.matchAll(/\S+/gu)].slice(-SPAN_WINDOW);
  // Preserve whole queries first, before a cap can discard the long options.
  for (const word of words) add(text.slice(word.index));
  for (let n = 1; n <= MAX_SPAN_WORDS; n++) for (let i = 0; i + n <= words.length; i++) {
    const first = words[i]!, last = words[i + n - 1]!;
    add(text.slice(first.index, last.index! + last[0].length));
  }
  return [...spans];
}

/** Only explicit http(s) URLs; Jev selects among these, it never invents one. */
export function suppliedUrls(text: string): Record<string, { url: string; description: string }> {
  const urls = new Map<string, string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"“”]+/giu)) {
    const literal = match[0].replace(/[.,!?;)'\]]+$/u, "");
    const url = URL.parse(literal);
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
    if (urls.size >= 8) break;
    urls.set(url.href, literal);
  }
  return Object.fromEntries([...urls].map(([url], i) => [`supplied_url_${i}`, { url, description: `The URL explicitly supplied in request: ${url}` }]));
}

// ---------------------------------------------------------------- build

/** Skip an unnecessary classifier round trip for explicit writing commands.
 * Search/open/read requests remain eligible, including quoted writing phrases.
 * The text choice below handles less explicit wording in the same Jev call. */
function isWritingCommand(request: string): boolean {
  let command = request.trim();
  for (let n = 0; n < 4; n++) command = command.replace(/^(?:(?:please|actually|now|okay|ok)\b[:,]?\s*|(?:can|could|would|will)\s+you\s+|i\s+(?:want|need)\s+(?:you\s+)?to\s+|help\s+me\s+)/i, "");
  return /^(?:draft|compose|reply|respond|email|e-mail|message|forward)\b/i.test(command)
    || /^send\b.{0,160}\b(?:e-?mail|messages?|reply|response|note|text)\b/i.test(command)
    || /^write\b.{0,120}\b(?:e-?mail|messages?|reply|response|post|letter|note|summary)\b/i.test(command);
}

/** An Intent from Jev's picks alone, or null when the request is not that simple. */
export async function quickIntent(ask: Ask, said: string, options: { legacy?: boolean; openingOnly?: boolean } = {}): Promise<Intent | null> {
  const request = said.trim();
  if (!options.legacy && !options.openingOnly && isWritingCommand(request)) return null;
  const spans = options.legacy ? spansOf(request) : literalSpansOf(request, MAX_CHOICES - 2);
  if (spans.length === 0) return null;
  const sites: Record<string, { url: string; description: string }> = { ...SITES, ...(options.legacy ? {} : suppliedUrls(request)) };

  const a = await ask(
    { request },
    {
      launcher: choice("What does the worker need to open first to do `request`?", {
        browser: "A website or web app, or a search of the web.",
        terminal: "A terminal, to run a command.",
        files: "The file manager, to find or open a file or folder on this computer.",
        none: "Nothing. The request is about what is already open on screen.",
      }),
      site: choice(options.legacy ? "Which website is `request` about?" : "Which website should be opened to carry out `request`? A URL to visit is the destination; a URL mentioned as a search query is not the destination.", {
        ...Object.fromEntries(Object.entries(sites).map(([name, s]) => [name, s.description])),
        [OTHER_SITE]: "A specific website or web app that is not in this list.",
        [NO_SITE]: "No website. The request is not about the web.",
      }),
      text: choice(
        options.legacy
          ? "Which exact words of `request` would be typed into a search box or field? Pick the thing being searched for or entered, without the command words around it."
          : "Can this request use a single literal search or field value? For composing/replying to a message, generating prose, assigning recipient/subject/body or other multiple fields, or resolving a writing correction, choose needs_writer even if some words are supplied. Otherwise select the exact complete query to enter AFTER opening the destination, without command words. A URL to visit is navigation: choose nothing_to_type.",
        {
          ...Object.fromEntries(spans.map((s) => [s, null])),
          [NOTHING]: "Nothing. The request only names a site or app to open, or the speaker has not yet said the words to type.",
          ...(!options.legacy ? { [NEEDS_WRITER]: "Writing or structured fields are required: an email/message/reply, recipient and subject/body, generated prose, or a correction needing context. Use the bounded intent parser; do not turn this into one search query." } : {}),
        },
      ),
    },
  );

  if (a.launcher.confidence < MIN_CONFIDENCE || a.site.confidence < MIN_CONFIDENCE) return null;
  const launcher: Launcher = a.launcher.choice;
  const site = a.site.choice;
  if (launcher === "browser" && site === OTHER_SITE) return null; // only the LLM can come up with a url
  const url = launcher === "browser" && site in sites ? sites[site]!.url : null;

  // A listener may open the app while speech is moving, but this is never the
  // completed writing intent and no picked span is allowed to become an input.
  if (options.openingOnly) return {
    goal: `Open the requested application or website and wait for the completed instruction. Pending request: ${request}`,
    launcher, url, inputs: {},
    doneWhen: "The completed instruction has replaced this temporary opening-only intent. This provisional intent cannot finish the user's task.",
    avoid: ["Do not enter text, send, submit, publish or delete anything while the completed instruction is pending."],
  };

  const picked: string = a.text.choice; // span labels are only known at run time, so the type is a plain string
  if (!options.legacy && picked === NEEDS_WRITER) return null;
  let typed = picked !== NOTHING && a.text.confidence >= MIN_CONFIDENCE ? picked : null;
  // "open youtube": Jev tends to pick the site's own name as the words to type. Nobody searches YouTube for "youtube".
  if (typed && (options.legacy ? site.replace(/_/g, " ").includes(typed.toLowerCase()) : site.replace(/_/g, " ") === typed.toLowerCase())) typed = null;
  // A selected destination is already handled by navigation, not by a page field.
  if (!options.legacy && typed && sites[site] && sites[site].url === URL.parse(typed)?.href) typed = null;
  return {
    goal: request,
    launcher,
    url,
    inputs: typed ? { search_query: typed } : {},
    doneWhen: `The screen shows the result of what was asked: ${JSON.stringify(request)}`,
    avoid: [],
  };
}
