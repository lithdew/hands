/**
 * Whose browser is signed in, and what the user is looking at. All pure.
 *
 * A hand's browser runs on Puk's own profile (win/desktop.ts), never on the
 * user's Chrome, so it holds only the sessions someone signed in to inside it:
 * `bun win/desktop.ts login`. Until then Gmail, Keep and the rest open signed
 * out, and a hand that lands on a sign-in page should stop and say so instead
 * of spending its step budget on a form it cannot fill.
 */

export type Wall = { site: string; how: string };

const tell = (site: string, hand?: number, what = `is not signed in to ${site}`, fix = "sign in once") =>
  ({ site, how: `${hand === undefined ? "This hand's" : `Hand ${hand}'s`} browser ${what}. Run \`bun win/desktop.ts login${hand === undefined ? "" : ` ${hand}`}\` and ${fix}.` });

/** Google pages only someone signed out (or asked for their password again) gets to see. The account
 * chooser and the "Sign in with Google" consent pages are not here: a signed-in hand clicks through them. */
const GOOGLE_WALL = /\/(identifier|challenge|rejected|deniedsigninrejected)\b|^\/(ServiceLogin|InteractiveLogin|AddSession|Login)\b/i;
const GOOGLE_PASSES = /accountchooser|chooseaccount|\/gsi\/|consent|SignOutOptions|\/Logout/i;
/** Where Google sends a signed-out visitor to Gmail, Drive and the rest instead of the product. */
const GOOGLE_BROCHURE = /^\/(intl\/[^/]+\/)?(gmail|docs|sheets|slides|forms|drive|keep|calendar)\/about\b/i;
const WORKSPACE_BROCHURE = /^\/(intl\/[^/]+\/)?(gmail|products\/(gmail|drive|docs|sheets|slides|forms|calendar|keep|meet|chat))\b/i;

/** Sites whose sign-in page has an address of its own. `path` missing means the whole host is one. */
const NAMED: { site: string; host: RegExp; path?: RegExp }[] = [
  { site: "Microsoft", host: /^login\.(live|microsoftonline|microsoft)\.com$/, path: /^(?!.*logout)/i },
  { site: "GitHub", host: /^github\.com$/, path: /^\/(login|session|sessions)\b/ },
  { site: "LinkedIn", host: /(^|\.)linkedin\.com$/, path: /^\/(login|uas\/login|checkpoint|authwall)\b/ },
  { site: "Facebook", host: /(^|\.)facebook\.com$/, path: /^\/login/ },
  { site: "Instagram", host: /(^|\.)instagram\.com$/, path: /^\/accounts\/login\b/ },
  { site: "X", host: /^(x|twitter)\.com$/, path: /^\/(login|i\/flow\/login)\b/ },
  { site: "Amazon", host: /(^|\.)amazon\.[a-z.]+$/, path: /^\/ap\/signin\b/ },
  { site: "Apple", host: /^(appleid|idmsa)\.apple\.com$/ },
  { site: "Yahoo", host: /^login\.yahoo\.com$/ },
  { site: "ChatGPT", host: /^auth\.openai\.com$/ },
  { site: "Slack", host: /(^|\.)slack\.com$/, path: /^\/(signin|ssb\/signin|workspace-signin)\b/ },
  { site: "Atlassian", host: /^id\.atlassian\.com$/, path: /^\/login\b/ },
  { site: "Notion", host: /^www\.notion\.(so|com)$/, path: /^\/login\b/ },
  { site: "Discord", host: /^discord\.com$/, path: /^\/login\b/ },
  { site: "Reddit", host: /(^|\.)reddit\.com$/, path: /^\/login\b/ },
  { site: "Spotify", host: /^accounts\.spotify\.com$/ },
  { site: "Dropbox", host: /^www\.dropbox\.com$/, path: /^\/login\b/ },
  { site: "Zoom", host: /(^|\.)zoom\.us$/, path: /^\/signin\b/ },
];
const LOGIN_PATH = /\/(log[-_]?in|sign[-_]?in)(\/|\.[a-z]+$|$)/i;
const LOGIN_TITLE = /\b(sign[ -]?in|log[ -]?in|login)\b/i;

/**
 * The sign-in wall this page is, or null. Judged from the address and the title
 * alone, so it costs nothing to ask after every navigation and every look.
 * `hand` only words the message.
 */
export function signInWall(url: string, title = "", hand?: number): Wall | null {
  let at: URL | undefined;
  try { at = new URL(url); } catch { /* a window title is all there is */ }
  if (!at || !/^https?:$/.test(at.protocol)) {
    if (/^sign in\s+[-\u2013\u2014]\s+google accounts/i.test(title)) return tell("Google", hand);
    if (/^sign in to (your( microsoft)? account|outlook|microsoft)/i.test(title)) return tell("Microsoft", hand);
    return null;
  }
  const host = at.hostname.toLowerCase(), path = at.pathname;
  if (/^accounts\.google\.[a-z.]+$/.test(host)) {
    if (GOOGLE_PASSES.test(path)) return null;
    return GOOGLE_WALL.test(path) || /^sign in\s+[-\u2013\u2014]\s+google accounts/i.test(title) ? tell("Google", hand) : null;
  }
  if ((host === "www.google.com" && GOOGLE_BROCHURE.test(path)) || (host === "workspace.google.com" && WORKSPACE_BROCHURE.test(path))) return tell("Google", hand);
  if (host === "messages.google.com" && /^\/web\/authentication\b/.test(path)) return tell("Google Messages", hand, "is not paired with your phone for Google Messages", "pair it once (Messages on the phone, Device pairing, scan the code)");
  const named = NAMED.find((n) => n.host.test(host) && (!n.path || n.path.test(path)));
  if (named) return tell(named.site, hand);
  // Anywhere else: an address that says login under a title that says so too. Either alone is too common.
  if (LOGIN_PATH.test(path) && LOGIN_TITLE.test(title)) return tell(host.replace(/^(www|login|signin|accounts?|auth|id|sso)\./, ""), hand);
  return null;
}

/** The same, from the `page:` and `address:` lines win/observe.ts puts at the top of what Jev reads. */
export function wallInTexts(texts: readonly string[], hand?: number): Wall | null {
  const line = (prefix: string) => texts.find((t) => t.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
  return signInWall(line("address:"), line("page:"), hand);
}

// ---------------------------------------------------------------- sessions

export type Cookie = { name: string; domain: string; expires?: number };

/** The cookie that means "somebody is signed in here". Names only; values are never looked at. */
const SESSIONS: { site: string; domain: RegExp; names: string[] }[] = [
  { site: "Google", domain: /(^|\.)google\.com$/, names: ["SID", "__Secure-1PSID"] },
  { site: "Microsoft", domain: /(^|\.)(live|microsoftonline|microsoft)\.com$/, names: ["__Host-MSAAUTHP", "ESTSAUTHPERSISTENT", "ESTSAUTH"] },
  { site: "GitHub", domain: /(^|\.)github\.com$/, names: ["user_session"] },
  { site: "LinkedIn", domain: /(^|\.)linkedin\.com$/, names: ["li_at"] },
  { site: "Facebook", domain: /(^|\.)facebook\.com$/, names: ["c_user"] },
  { site: "Instagram", domain: /(^|\.)instagram\.com$/, names: ["sessionid"] },
  { site: "X", domain: /(^|\.)(x|twitter)\.com$/, names: ["auth_token"] },
  { site: "Amazon", domain: /(^|\.)amazon\.[a-z.]+$/, names: ["at-main", "x-main"] },
  { site: "Reddit", domain: /(^|\.)reddit\.com$/, names: ["reddit_session"] },
  { site: "Slack", domain: /(^|\.)slack\.com$/, names: ["d"] },
  { site: "Notion", domain: /(^|\.)notion\.(so|com)$/, names: ["token_v2"] },
  { site: "Spotify", domain: /(^|\.)spotify\.com$/, names: ["sp_dc"] },
  { site: "ChatGPT", domain: /(^|\.)chatgpt\.com$/, names: ["__Secure-next-auth.session-token", "__Secure-next-auth.session-token.0"] },
];

/** Which well-known sites this cookie jar is signed in to. `now` is in seconds, like a cookie's `expires`. */
export function signedInSites(cookies: readonly Cookie[], now = Date.now() / 1000): string[] {
  // DevTools gives a cookie that lasts until the browser closes an `expires` of -1.
  const live = cookies.filter((c) => !c.expires || c.expires <= 0 || c.expires > now);
  return SESSIONS.filter((s) => live.some((c) => s.names.includes(c.name) && s.domain.test(c.domain.replace(/^\./, "").toLowerCase()))).map((s) => s.site);
}

// ---------------------------------------------------------------- what the user is looking at

export type SeenWindow = { app: string; title: string; focused: boolean; containerId: number; iconic?: boolean };
export type Foreground = { title: string; app: string; browser: boolean };

const BROWSER_SUFFIX = /\s[-\u2013\u2014]\s(Google Chrome|Chromium|Microsoft\u200b? Edge|Mozilla Firefox|Brave|Opera|Vivaldi|Arc)(\s[-\u2013\u2014]\s[^-\u2013\u2014]*)?$/;
const BROWSER_APP = /^(chrome|msedge|firefox|brave|opera|vivaldi|arc)$/i;
/** The shell's own surfaces, and Puk's panel: being in front of those says nothing about what "that email" is. */
const NOT_CONTENT = (w: SeenWindow) => !w.title.trim() || /^(Program Manager|Task Switching|Search|Start)$/.test(w.title)
  || /^(SearchHost|StartMenuExperienceHost|ShellExperienceHost|TextInputHost)$/i.test(w.app) || /^Puk\b/.test(w.title) || /^puk-win/i.test(w.app);

/**
 * Pure: what is on the user's own desktop, front to back, from the helper's `state`
 * of it. Hands' windows, minimized ones, the shell and Puk's panel are left out.
 * Empty when they are looking at a hand (`desktop` is a Puk desktop).
 */
export function seenByUser(windows: readonly SeenWindow[], owned: ReadonlySet<number> = new Set(), desktop = ""): Foreground[] {
  if (/^Puk (hand \d+|bench)$/.test(desktop)) return [];
  const front = Math.max(0, windows.findIndex((w) => w.focused));
  return [...windows.slice(front), ...windows.slice(0, front)].filter((w) => !owned.has(w.containerId) && !w.iconic && !NOT_CONTENT(w)).map((seen) => {
    const browser = BROWSER_APP.test(seen.app) || BROWSER_SUFFIX.test(seen.title);
    return { title: (browser ? seen.title.replace(BROWSER_SUFFIX, "") : seen.title).replace(/\s+/g, " ").trim().slice(0, 200), app: seen.app, browser };
  });
}

/** Pure: the window the user means by "that": their foreground window, or the one right
 * behind it when the foreground is Puk's panel or the shell. Null when there is none. */
export const foregroundOf = (windows: readonly SeenWindow[], owned: ReadonlySet<number> = new Set(), desktop = ""): Foreground | null =>
  seenByUser(windows, owned, desktop)[0] ?? null;

// ---------------------------------------------------------------- the sign-in window

/** Pure: `DevToolsActivePort` holds the port, then the browser's own DevTools path. */
export function parseDevToolsFile(text: string): { port: number; browser: string } | null {
  const [first = "", second = ""] = text.replaceAll("\r", "").split("\n").map((l) => l.trim());
  const port = Number(first);
  return Number.isInteger(port) && port > 0 && port < 65536 && /^\/devtools\/browser\/[\w-]+$/.test(second) ? { port, browser: second } : null;
}

/** Pure: which hands `login`'s arguments name. `known` are the hands that exist. */
export function loginTargets(args: readonly string[], known: readonly number[], fallback = 2): number[] {
  const asked = args.flatMap((a) => a.split(",")).map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (!asked.length || asked.includes("all")) return known.length ? [...known] : Array.from({ length: fallback }, (_, i) => i + 1);
  const ids = asked.map((a) => a === "bench" ? 99 : Number(a));
  const bad = asked.find((_, i) => !Number.isInteger(ids[i]) || ids[i]! < 1 || ids[i]! > 99);
  if (bad !== undefined) throw new Error(`"${bad}" is not a hand. Use a hand's number, "bench" or "all".`);
  return [...new Set(ids)];
}

export const LOGIN_SITES = [
  { name: "Google (Gmail, Keep, Calendar, Drive)", url: "https://accounts.google.com/" },
  { name: "Google Messages", url: "https://messages.google.com/web/" },
  { name: "Microsoft (Outlook)", url: "https://login.live.com/" },
  { name: "OpenTable", url: "https://www.opentable.com/" },
  { name: "GitHub", url: "https://github.com/login" },
];

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
/** Pure: the page the sign-in window opens on, so the user knows which hand this is and what to do. */
export function loginPage(hand: number, sites: readonly { name: string; url: string }[] = LOGIN_SITES): string {
  return `<!doctype html><meta charset="utf-8"><title>Puk hand ${hand}: sign in</title>
<style>body{font:16px/1.5 "Segoe UI",system-ui,sans-serif;background:#1a1b26;color:#c0caf5;max-width:42em;margin:12vh auto;padding:0 1em}a{color:#7aa2f7;display:inline-block;margin:.2em 1em .2em 0}h1{color:#fff;font-size:1.5em}</style>
<h1>This is hand ${hand}'s own browser</h1>
<p>Puk's hands never touch your everyday Chrome, so this browser starts signed out. Sign in here to whatever hand ${hand} should be able to use. It stays signed in.</p>
<p>${sites.map((s) => `<a href="${escape(s.url)}">${escape(s.name)}</a>`).join("")}</p>
<p>When you are done, <b>close this window</b>. The hand takes its browser back and works in the background again.</p>`;
}
