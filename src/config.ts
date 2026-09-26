/** Tunables, the site catalog, and environment. Bun loads .env on its own. */

import { homedir } from "node:os";
import { join } from "node:path";

export const MIN_OCR_CONFIDENCE = 0.3;
export const MAX_OPTIONS = 255; // TypeSafe Choice ceiling
export const ABORT_CORNER_PX = 4;
export const DEFAULT_MIN_CONFIDENCE = 0.4; // the kind of action; the item and field have bars of their own, below
export const DEFAULT_STEPS = 100;
export const DEFAULT_DELAY = 2.0;

// Jev, TypeSafe's classifier, as the clicker asks it. The bars are the teammate's measured ones (D:/projects/puk/jev
// ground.eval.ts: a click at 0.5 left 1-2% wrong clicks; no field pick was wrong at 0.3; done at goal_met 0.8, or 0.5
// when the kind agrees), set on DOM elements and kept until hands' own items are measured.
export const DEFAULT_JEV_MODEL = "jev-1.13.0"; // pinned, so the bars keep meaning what they were measured to mean
export const JEV_TIMEOUT_MS = 4000; // one attempt: a warm answer takes about 330 ms, a cold one about a second
export const JEV_RETRIES = 1;
export const CLICK_AT = 0.5; // the item to click, and the off-screen control to press
export const FIELD_AT = 0.3; // the field to type into
export const DONE_AT = 0.8; // goal_met alone ends the run
export const DONE_AGREED = 0.5; // goal_met, when the kind says done too
export const SUBMIT_AT = 0.5; // Return after typing
export const STUCK_AT = 0.7; // the stuck noul, which counts only after STUCK_AFTER actions
export const STUCK_AFTER = 3;
export const GATE_AT = 0.5; // a consequence of a click (src/gate.ts) that stops the run for the user's approval
export const MAX_ITEMS = 600; // items a step shows Jev; past PER_CHOICE the item question is asked in parts
export const PER_CHOICE = 250; // item ids per Choice, leaving room for none_of_these under the ceiling
export const ITEM_CHARS = 100; // an item's text as Jev reads it
export const OFFSCREEN_SHOWN = 40; // off-screen controls a step offers, the ones sharing most words with the goal
export const OFFSCREEN_CHARS = 80;
export const RETRY_ITEMS = 120; // a request over Jev's token limit is sent once more with this many items and no off-screen controls
export const WAIT_S = 1; // the `wait` action
export const HISTORY_SHOWN = 10;
export const SHOW_PAGE_MS = 400; // how long a blank page's window is held in front, with nothing sent to it, for its browser to draw it
export const SHOW_PAGE_WAIT_MS = 5000; // how long that waits for the user to pause
/** Jev's model: pinned, unless TYPESAFE_DEFAULT_MODEL names another. */
export const jevModel = (): string => process.env.TYPESAFE_DEFAULT_MODEL?.trim() || DEFAULT_JEV_MODEL;

// Jev's reflexes (src/reflex.ts): a look at a page of the hand's own, and at its last screen when it says it is done,
// each one request with no model turn. The bars are set here, not yet measured on hands' own pages.
export const REFLEX_MS = 1500; // one attempt, no retry: a warm answer takes about 330 ms, a cold one about a second
export const WALL_AT = 0.8; // the page wants the user: a sign-in, a CAPTCHA, a code, payment details
export const BANNER_AT = 0.8; // a cookie banner is showing
export const DECLINE_AT = 0.7; // the button Jev picked to turn it down is pressed
export const SEEN_AT = 0.8; // a done hand's check the voice says was seen on its screen
export const REFLEX_ITEMS = 250; // items a page's question shows Jev: those its word triggers matched first, then the rest in reading order
export const CHECK_ITEMS = 200; // items the done check shows Jev: those that share most words with the answer
export const CHECK_CHARS = 200; // an item's text as the done check reads it
/** Whether the reflexes run: HANDS_REFLEXES is not off, and there is a TypeSafe key to ask Jev with. */
export const reflexes = (): boolean => !["off", "0", "false", "no"].includes((process.env.HANDS_REFLEXES ?? "").trim().toLowerCase()) && Boolean(process.env.TYPESAFE_API_KEY);
export const DEFAULT_MODEL = "openai-codex/gpt-6-astra"; // provider/model, resolved through pi-ai
export const DEFAULT_THINKING = "low";
export const DEFAULT_SERVICE_TIER = "priority";
export const DEFAULT_BROWSER = "Google Chrome";

// Sites the classifier can pick by name, in `bun clicker` (a hand opens pages with its own `browser`). Anything else goes through the writer.
export const SITES: Record<string, string> = {
  github: "https://github.com/",
  gmail: "https://mail.google.com/",
  google_calendar: "https://calendar.google.com/",
  launchdarkly: "https://app.launchdarkly.com/",
  linear: "https://linear.app/",
  notion: "https://www.notion.so/",
  slack: "https://app.slack.com/",
  typesafe_console: "https://console.typesafe.ai/",
};

export const browser = (): string => process.env.CLICKER_BROWSER || DEFAULT_BROWSER;
export const agentModel = (): string => process.env.HANDS_MODEL || DEFAULT_MODEL;
export const writerModel = (): string => process.env.CLICKER_WRITER_MODEL || agentModel();
export const answerModel = (): string => process.env.CLICKER_ANSWER_MODEL || agentModel();
export const thinking = (): string => process.env.HANDS_THINKING || DEFAULT_THINKING;
/** "off" sends no service_tier at all. */
export const serviceTier = (): string => process.env.HANDS_SERVICE_TIER || DEFAULT_SERVICE_TIER;
export const email = (): string | null => process.env.CLICKER_EMAIL || null;
/** What the hand on screen is called, and its colour as hex (none: the emoji's own yellow). */
export const handName = (): string => process.env.HANDS_NAME || "Hands";
export const handColor = (): string | undefined => process.env.HANDS_COLOR || undefined;
/** `hands live`: the voice, how it sounds, and the Responses model behind it that turns what was said into tool calls. */
export const liveModel = (): string => process.env.HANDS_LIVE_MODEL || "gpt-live-1";
export const liveVoice = (): string => process.env.HANDS_LIVE_VOICE || "marin";
export const liveBackend = (): string => process.env.HANDS_LIVE_BACKEND || "gpt-5.6-luna";
/** Lookups (src/web.ts): the model that answers a question from a web search, and the one tried once when the account does not have it. */
export const DEFAULT_WEB_MODEL = "gpt-6-luna";
export const FALLBACK_WEB_MODEL = "gpt-5.6-luna";
export const webModel = (): string => process.env.HANDS_WEB_MODEL || DEFAULT_WEB_MODEL;
/**
 * Where a task the voice sends out goes (src/route.ts). jev, the default: Jev decides between a web lookup, a hand, or
 * a hand with the facts looked up alongside. off: every task to a hand, and hands without the `web` tool, for when the
 * computer use is what is to be seen. always: every task looked up first, without Jev, for trying lookups out.
 */
export type WebMode = "off" | "jev" | "always";
export function webMode(): WebMode {
  const mode = (process.env.HANDS_WEB ?? "").trim().toLowerCase();
  if (["off", "0", "false", "no"].includes(mode)) return "off";
  return mode === "always" ? "always" : "jev";
}
/** Roughly where the user is, for a search that depends on it (the weather, opening hours): HANDS_LOCATION, as "Hong Kong" or "Hong Kong, HK". The time zone always goes with a search. */
export function webLocation(): { city?: string; country?: string } {
  const parts = (process.env.HANDS_LOCATION ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const country = parts.length > 1 && /^[a-z]{2}$/i.test(parts.at(-1)!) ? parts.pop()!.toUpperCase() : undefined;
  const city = parts.join(", ") || undefined;
  return { ...(city ? { city } : {}), ...(country ? { country } : {}) };
}

/** Where the hands `hands live` sends out keep what they make: Hands in the user's Documents (~/Documents/Hands on a Mac), or HANDS_WORK. */
export const workFolder = (): string => process.env.HANDS_WORK || join(documentsFolder(), "Hands");

const SHELL_FOLDERS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";
let documents: string | undefined;

/**
 * The user's Documents folder, where Explorer shows it. On Windows that is wherever the user's shell folders say (a
 * OneDrive backup moves it to OneDrive\Documents, for one), read from the registry once; on a Mac, and whenever that
 * cannot be read, ~/Documents.
 */
export function documentsFolder(): string {
  if (documents === undefined) {
    let found: string | null = null;
    if (process.platform === "win32") {
      try {
        const query = Bun.spawnSync(["reg.exe", "query", SHELL_FOLDERS, "/v", "Personal"], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
        found = shellFolder(query.stdout.toString());
      } catch {
        // no reg.exe to ask: the folder in the user's profile, then
      }
    }
    documents = found ?? join(homedir(), "Documents");
  }
  return documents;
}

/**
 * The Documents folder in what `reg query` says of the user's shell folders: its value, with the variables in it
 * (%USERPROFILE%, as Windows writes it) filled in from `env`. Null when there is none, when a variable in it is not
 * set, or when it is not a whole path.
 */
export function shellFolder(query: string, env: Record<string, string | undefined> = process.env): string | null {
  const value = query.match(/^\s*Personal\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m)?.[1];
  if (!value) return null;
  const names = Object.keys(env);
  let missing = false;
  const path = value.replace(/%([^%]+)%/g, (_, name: string) => {
    const key = names.find((one) => one.toLowerCase() === name.toLowerCase()); // Windows' variables are the same in any case
    const found = key === undefined ? undefined : env[key];
    if (!found) missing = true;
    return found ?? "";
  });
  return !missing && /^(?:[A-Za-z]:\\|\\\\)/.test(path) ? path : null;
}

/** What the voice knows about the user, one line each (names, contacts, words it would mishear): ~/.hands/profile.md, or HANDS_PROFILE. */
export const profilePath = (): string => process.env.HANDS_PROFILE || join(homedir(), ".hands", "profile.md");
