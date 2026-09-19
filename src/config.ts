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
