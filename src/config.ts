/** Tunables, the site catalog, and environment. Bun loads .env on its own. */

export const MIN_OCR_CONFIDENCE = 0.3;
export const MAX_OPTIONS = 255; // TypeSafe Choice ceiling
export const ABORT_CORNER_PX = 4;
export const DEFAULT_MIN_CONFIDENCE = 0.4;
export const DEFAULT_STEPS = 100;
export const DEFAULT_DELAY = 2.0;
export const DEFAULT_MODEL = "openai-codex/gpt-6-astra"; // provider/model, resolved through pi-ai
export const DEFAULT_THINKING = "low";
export const DEFAULT_SERVICE_TIER = "priority";
export const DEFAULT_BROWSER = "Google Chrome";
export const DEFAULT_HOTKEY = "F8";
export const DEFAULT_TRANSCRIBE_MODEL = "gpt-live-transcribe";
export const DEFAULT_NARRATOR_MODEL = "openai/gpt-5.6-luna"; // fast, and an API-key provider like the plan model
export const DEFAULT_PLAN_MODEL = "openai/gpt-5.6-luna"; // an API-key provider, so the Jev driver runs without a `pi` sign-in

// Sites the classifier can pick by name. Anything else goes through the writer.
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
/** Who drives a task: Jev's loop (pilot.ts), which asks a model last, or the pi agent alone. Jev reads Windows only so far. */
export const driver = (): "jev" | "pi" => (process.env.HANDS_DRIVER === "pi" || process.env.HANDS_DRIVER === "jev" ? process.env.HANDS_DRIVER : process.platform === "darwin" ? "pi" : "jev");
/** HANDS_DRIVER=jev said out loud: Jev alone, and what it gives up on is not handed to the pi agent. */
export const jevOnly = (): boolean => process.env.HANDS_DRIVER === "jev";
/** The one text call the Jev driver makes when no recipe fits, and the text it writes for a field. */
export const planModel = (): string => process.env.HANDS_PLAN_MODEL || DEFAULT_PLAN_MODEL;
/** The key held to speak under `hands --listen`. */
export const hotkey = (): string => process.env.HANDS_HOTKEY || DEFAULT_HOTKEY;
export const transcribeModel = (): string => process.env.TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL;
/** Transcription is OpenAI's Realtime API, which takes a key of its own: pi's subscription sign-in does not reach it. */
export const openaiKey = (): string | null => process.env.OPENAI_API_KEY?.trim() || null;
/** Who reads the step log against the request and says how the task is going. "off" says nothing. */
export const narratorModel = (): string => process.env.HANDS_NARRATOR_MODEL || DEFAULT_NARRATOR_MODEL;
/** The tiles, the pointers and the card on screen. "off" keeps everything in the terminal. */
export const feedWanted = (): boolean => process.env.HANDS_FEED !== "off";
