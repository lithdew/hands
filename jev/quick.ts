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

// ---------------------------------------------------------------- build

/** An Intent from Jev's picks alone, or null when the request is not that simple. */
export async function quickIntent(ask: Ask, said: string): Promise<Intent | null> {
  const request = said.trim();
  const spans = spansOf(request);
  if (spans.length === 0) return null;

  const a = await ask(
    { request },
    {
      launcher: choice("What does the worker need to open first to do `request`?", {
        browser: "A website or web app, or a search of the web.",
        terminal: "A terminal, to run a command.",
        files: "The file manager, to find or open a file or folder on this computer.",
        none: "Nothing. The request is about what is already open on screen.",
      }),
      site: choice("Which website is `request` about?", {
        ...Object.fromEntries(Object.entries(SITES).map(([name, s]) => [name, s.description])),
        [OTHER_SITE]: "A specific website or web app that is not in this list.",
        [NO_SITE]: "No website. The request is not about the web.",
      }),
      text: choice(
        "Which exact words of `request` would be typed into a search box or field? Pick the thing being searched for or entered, without the command words around it.",
        {
          ...Object.fromEntries(spans.map((s) => [s, null])),
          [NOTHING]: "Nothing. The request only names a site or app to open, or the speaker has not yet said the words to type.",
        },
      ),
    },
  );

  if (a.launcher.confidence < MIN_CONFIDENCE || a.site.confidence < MIN_CONFIDENCE) return null;
  const launcher: Launcher = a.launcher.choice;
  const site = a.site.choice;
  if (launcher === "browser" && site === OTHER_SITE) return null; // only the LLM can come up with a url

  const picked: string = a.text.choice; // span labels are only known at run time, so the type is a plain string
  let typed = picked !== NOTHING && a.text.confidence >= MIN_CONFIDENCE ? picked : null;
  // "open youtube": Jev tends to pick the site's own name as the words to type. Nobody searches YouTube for "youtube".
  if (typed && site.replace(/_/g, " ").includes(typed.toLowerCase())) typed = null;
  return {
    goal: request,
    launcher,
    url: launcher === "browser" && site in SITES ? SITES[site as keyof typeof SITES].url : null,
    inputs: typed ? { search_query: typed } : {},
    doneWhen: `The screen shows the result of what was asked: ${JSON.stringify(request)}`,
    avoid: [],
  };
}
