// accounts.ts — which of the user's accounts a request means.
//
// "search up the email from ananth sent to my northwestern email" was run in the hand's first Gmail
// account, the private one, as the search `from:ananth (northwestern OR @northwestern.edu)`, and then
// again and again with other words. Nothing knew that "my northwestern email" names an ACCOUNT. It is
// not something to look for on the page, and it is not something a model should guess an address for.
//
//   Jev picks    the account, from a closed list of the user's addresses described in words
//                ("chi@u.northwestern.edu: a school or university account, northwestern")
//   code builds  the url: Google takes `authuser=<address>` and lands in that account with no
//                account switcher to operate (`gmailUrl`)
//   code checks  the page: a Gmail title carries the address it belongs to, and comparing two
//                addresses is not a judgment (`accountShown`, `wrongAccount`)
//
// The list is `accounts.json` (PUK_ACCOUNTS) plus every address a hand has seen in a Gmail title.

// ---------------------------------------------------------------- types

export type Account = {
  email: string;
  /** What the user calls it: "school", "work", "personal". Optional; the address usually says enough. */
  label?: string;
};

// ---------------------------------------------------------------- words

const PERSONAL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail|pm)\./i;
const EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;

export type AccountKind = "school" | "work" | "personal";

/** School, work or personal: from what the user called it, else from the address. Code's job: it is a lookup, not a judgment. */
export function kindOf(account: Account): AccountKind {
  const label = account.label?.toLowerCase() ?? "", domain = account.email.split("@")[1]?.toLowerCase() ?? "";
  if (/school|universit|college|student|campus/.test(label)) return "school";
  if (/personal|private|home|own/.test(label)) return "personal";
  if (/work|job|office|company/.test(label)) return "work";
  return /\.edu$|\.ac\.[a-z]{2}$|\.edu\.[a-z]{2}$/.test(domain) ? "school" : PERSONAL.test(domain) ? "personal" : "work";
}

/** What Jev reads to tell the accounts apart. It reads literally, so the words a speaker would use are spelled out. */
export function describeAccount(account: Account): string {
  const domain = account.email.split("@")[1]?.toLowerCase() ?? "";
  const names = domain.split(".").filter((part) => part.length > 2 && !/^(com|org|net|edu|gov|mail|www)$/.test(part));
  const kind = { school: "a school, college or university account", personal: "a personal, private account", work: "a work or organisation account" }[kindOf(account)];
  return `${account.email}: ${account.label ? `the user's ${account.label} account, ` : ""}${kind}${names.length ? `, also called by the name ${names.map((n) => JSON.stringify(n)).join(" or ")}` : ""}.`;
}

// ---------------------------------------------------------------- urls

/** Gmail in one account, with no switcher to operate. `search` is Gmail's own query syntax; `compose` fills a draft. */
export function gmailUrl(email: string | null, to: { search?: string; compose?: { to: string; subject: string; body: string } } = {}): string {
  const base = `https://mail.google.com/mail/${email ? `u/?authuser=${encodeURIComponent(email)}` : ""}`;
  if (to.compose) return `${base}${email ? "&" : "?"}${new URLSearchParams({ view: "cm", fs: "1", to: to.compose.to, su: to.compose.subject, body: to.compose.body })}`;
  return to.search ? `${base}#search/${encodeURIComponent(to.search)}` : base;
}

// ---------------------------------------------------------------- the page

/** The address a page says it belongs to ("Inbox (3) - me@x.com - Gmail"), lower-cased, or null. */
export function accountShown(texts: readonly string[]): string | null {
  for (const line of texts) {
    if (!/^(page|window|address):/i.test(line)) continue;
    const found = EMAIL.exec(line.replace(/authuser=[^&#\s]*/gi, "")); // the url names the account that was asked for, not the one that is open
    if (found) return found[0].toLowerCase();
  }
  return null;
}

/** The page is in another account than the task needs. Null when it matches, or when the page names no account. */
export function wrongAccount(wanted: string | undefined, texts: readonly string[]): string | null {
  const shown = accountShown(texts);
  return wanted && shown && shown !== wanted.toLowerCase() ? shown : null;
}

// ---------------------------------------------------------------- the list

const clean = (raw: unknown): Account[] => (Array.isArray(raw) ? raw : [])
  .filter((a): a is Account => typeof a?.email === "string" && EMAIL.test(a.email) && (a.label === undefined || typeof a.label === "string"))
  .map((a) => ({ email: a.email.trim().toLowerCase(), ...(a.label?.trim() ? { label: a.label.trim().slice(0, 40) } : {}) }));

/** The user's accounts: what they wrote down, then what the hands have seen. `seen` adds an address and keeps it. */
export async function accountBook(written = process.env.PUK_ACCOUNTS ?? "accounts.json", learned = "out/jev-accounts.json") {
  const accounts = new Map<string, Account>();
  for (const a of [...clean(await Bun.file(written).json().catch(() => [])), ...clean(await Bun.file(learned).json().catch(() => []))]) if (!accounts.has(a.email)) accounts.set(a.email, a);
  const mine = new Set(clean(await Bun.file(learned).json().catch(() => [])).map((a) => a.email));
  return {
    all: (): Account[] => [...accounts.values()],
    /** A hand saw this address in a Gmail title: it is one of the user's. True when it is news. */
    seen(email: string): boolean {
      const key = email.trim().toLowerCase();
      if (!EMAIL.test(key) || accounts.has(key)) return false;
      accounts.set(key, { email: key }); mine.add(key);
      void Bun.write(learned, JSON.stringify([...mine].map((e) => ({ email: e })), null, 2)).catch(() => {});
      return true;
    },
  };
}
export type AccountBook = Awaited<ReturnType<typeof accountBook>>;
