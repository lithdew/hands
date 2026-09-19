// kits/site/owner.ts — who "myself" is, and the sources that are the owner's by something exact.
//
// "Create a personal website for myself" names nobody. The one thing this machine knows for certain is
// who owns the repository the system runs in: git's own configuration. Everything else is tied to that
// by an exact match, never by a name (names repeat; "is it the same person" by name is how a namesake's
// biography ends up on someone's site):
//
//   git config            the owner's name and email                 (the email is matched, never printed)
//   git log               what the owner committed, and where         (teammates commit too: they are not the owner)
//   the docs on disk      what the project is
//   GitHub commit search  public commits made with that email belong to an account: that account is the owner's
//   that account          its profile, its repositories, and the main documents in them
//
// All of it comes back as `Result`s that bring their own text (`blocks`), so the relay's research sifts
// their passages with Jev exactly as it sifts a web page's. No fact about anybody is written in this file.

import { $ } from "bun";
import { dirname, join } from "node:path";
import { cached, type Result } from "../../web";

export type Author = { name: string; email: string; commits: number };
export type Commit = { hash: string; date: string; subject: string; body: string; files: string[] };
export type Account = { login: string; url: string; commits: number; repos: string[]; example: string };
export type Owner = { name: string; email: string; remote: string | null; remoteVisible: boolean | null; authors: Author[]; commits: Commit[]; account: Account | null };

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const MAX_DOCS = 14, MAX_REPOS = 8, FILES_PER_REPO = 3, BLOCKS_PER_FILE = 80;

// ---------------------------------------------------------------- pure parts (tested)

/** "git@github.com:owner/name.git" or "https://github.com/owner/name" -> "github.com/owner/name". */
export function remoteSlug(remote: string): string | null {
  const m = /^(?:git@|ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** An address shown to a model or a reader: the domain says what kind of account it is, the rest is withheld. */
export const maskEmail = (email: string) => `an address at ${email.split("@")[1] ?? "an unknown domain"} (withheld)`;

/** `git shortlog -sne` lines. */
export function parseAuthors(shortlog: string): Author[] {
  return shortlog.split("\n").map((line) => /^\s*(\d+)\s+(.*?)\s+<([^>]*)>\s*$/.exec(line)).filter(Boolean).map((m) => ({ commits: Number(m![1]), name: m![2]!, email: m![3]! }));
}

/** Where someone's commits landed: top-level folders by files touched, most first. */
export function foldersTouched(commits: Commit[]): [string, number][] {
  const tally = new Map<string, number>();
  for (const c of commits) for (const f of c.files) { const top = f.includes("/") ? `${f.split("/")[0]}/` : "(top level)"; tally.set(top, (tally.get(top) ?? 0) + 1); }
  return [...tally].sort((a, b) => b[1] - a[1]);
}

const TEX_SETUP = /^\s*\\(usepackage|documentclass|newcommand|renewcommand|providecommand|newtheorem|newtcbtheorem|tcbuselibrary|DeclareMathOperator|def|let|geometry|pagestyle|theoremstyle|input|include|bibliography\w*|addbibresource|hypersetup|titleformat|titlespacing|makeatletter|makeatother|setlength|setcounter|numberwithin|maketitle|tableofcontents|newpage|clearpage)\b/;

/** A TeX document without its set-up: what the preamble says about the work (title, author, date, institute), then the document itself. */
export function texReadable(text: string): string {
  const at = text.indexOf("\\begin{document}");
  if (at < 0) return text;
  const about = [...text.slice(0, at).replace(/^\s*%.*$/gm, "").matchAll(/\\(title|subtitle|author|date|institute|affiliation)\s*(?:\[[^\]]*\])?\{((?:[^{}]|\{[^{}]*\})*)\}/g)].filter((m) => m[2]!.trim()).map((m) => `${m[1]}: ${m[2]!.trim()}`);
  return `${about.length ? `From this document's title page -- ${about.join("; ")}.\n\n` : ""}${text.slice(at + "\\begin{document}".length)}`;
}

/** A text file (markdown, TeX, plain) as passages: split on blank lines, code fences and comment or set-up lines dropped, the nearest markdown heading kept with its paragraph. */
export function textBlocks(text: string, max = BLOCKS_PER_FILE): string[] {
  const blocks: string[] = [], seen = new Set<string>();
  let heading = "";
  for (const raw of texReadable(text.replace(/\r/g, "")).replace(/^```[\s\S]*?^```[^\n]*$/gm, "").replace(/<!--[\s\S]*?-->/g, "").split(/\n\s*\n/)) {
    const lines = raw.split("\n").filter((l) => !/^\s*%/.test(l) && !TEX_SETUP.test(l));
    const block = lines.join(" ").replace(/\s+/g, " ").trim();
    const h = /^#{1,6}\s+(.*)$/.exec(block);
    if (h && block.length < 120) { heading = h[1]!.replace(/[#*`]/g, "").trim(); continue; }
    // A short line (a name or a university on a title page) is no passage of its own, but it is not noise: it joins the passage before it.
    if (block.length <= 25) { if (/[a-z]{3}/i.test(block) && blocks.length && blocks.at(-1)!.length < 900) blocks[blocks.length - 1] += ` ${block}`; continue; }
    if (seen.has(block)) continue;
    seen.add(block);
    blocks.push((heading && !block.startsWith("#") ? `[${heading}] ${block}` : block).slice(0, 1200));
    if (blocks.length >= max) break;
  }
  return blocks;
}

/** Which files of a repository listing are worth reading for what the work is: a readme, then main documents, small text files only. */
export function entryFiles<T extends { name: string; type: string; size: number }>(listing: T[], max = FILES_PER_REPO): T[] {
  const rank = (name: string) => /^readme/i.test(name) ? 0 : /^(main|index|notes|paper|report|abstract|about)\b|thesis|dissertation/i.test(name) ? 1 : 2;
  return listing.filter((f) => f.type === "file" && /\.(md|tex|txt|rst|org|typ)$/i.test(f.name) && f.size > 200 && f.size < 150_000 && !/copy|backup|old/i.test(f.name))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.length - b.name.length).filter((f) => rank(f.name) < 2).slice(0, max);
}

/** The exact strings that tie a page to the owner. A name is not one of them. */
export function anchorsOf(owner: Owner): string[] {
  const a = owner.account;
  return [owner.email, ...(a ? [`github.com/${a.login}`, ...a.repos.map((r) => `${a.login}/${r}`)] : []), ...(owner.remote ? [owner.remote] : [])].map((s) => s.toLowerCase());
}

/** Does this text carry one of the ties? The account name alone counts when it is distinctive enough to be a word of its own. */
export function tieIn(text: string, owner: Owner): string | null {
  const hay = text.toLowerCase();
  const hit = anchorsOf(owner).find((a) => hay.includes(a));
  if (hit) return hit === owner.email.toLowerCase() ? "the owner's git email" : hit;
  const login = owner.account?.login.toLowerCase();
  return login && login.length >= 5 && new RegExp(`(^|[^a-z0-9])${login.replace(/[^a-z0-9]/g, "\\$&")}([^a-z0-9]|$)`).test(hay) ? `the account name ${owner.account!.login}` : null;
}

// ---------------------------------------------------------------- this machine

const git = async (...args: string[]) => (await $`git ${args}`.cwd(REPO).quiet().nothrow()).stdout.toString().trim();

async function identity(): Promise<{ name: string; email: string } | null> {
  let name = await git("config", "user.name"), email = await git("config", "user.email");
  // Under WSL the repository often lives on the Windows side, and so does the identity that commits to it.
  const winHome = /^(\/mnt\/[a-z]\/Users\/[^/]+)\//.exec(`${REPO}/`)?.[1];
  if ((!name || !email) && winHome && await Bun.file(join(winHome, ".gitconfig")).exists()) {
    name ||= await git("config", "-f", join(winHome, ".gitconfig"), "user.name"); email ||= await git("config", "-f", join(winHome, ".gitconfig"), "user.email");
  }
  return name && email ? { name, email } : null;
}

async function ownerCommits(email: string): Promise<Commit[]> {
  const log = await git("log", `--author=<${email}>`, "--date=short", "--name-only", "--format=%x1e%h%x1f%ad%x1f%s%x1f%b%x1f");
  return log.split("\x1e").filter((c) => c.trim()).map((c) => { const [hash, date, subject, body, files] = c.split("\x1f"); return { hash: hash!.trim(), date: date!, subject: subject!, body: (body ?? "").trim(), files: (files ?? "").split("\n").map((f) => f.trim()).filter(Boolean) }; });
}

// ---------------------------------------------------------------- GitHub, without signing in

type GhCommit = { html_url: string; author: { login: string } | null; commit: { author: { email: string } }; repository: { name: string; full_name: string; private: boolean } };
type GhUser = { login: string; html_url: string; name: string | null; bio: string | null; company: string | null; location: string | null; blog: string | null; twitter_username: string | null; public_repos: number; created_at: string };
type GhRepo = { name: string; full_name: string; html_url: string; description: string | null; language: string | null; fork: boolean; stargazers_count: number; created_at: string; pushed_at: string; homepage: string | null; default_branch: string };
type GhFile = { name: string; type: string; size: number; html_url: string; download_url: string | null };

const hash = (s: string) => Bun.hash(s).toString(16);
const UA = { "user-agent": "puk-relay", accept: "application/vnd.github+json" };

/** One GitHub API answer, cached on disk; a refusal (rate limit, 404) is null and is not remembered. Sixty requests an hour are allowed without a key: a fresh run uses about a dozen. */
async function gh<T>(path: string): Promise<T | null> {
  return cached<T | null>(`site-gh-${hash(path)}`, async () => { const res = await fetch(`https://api.github.com${path}`, { headers: UA, signal: AbortSignal.timeout(20_000) }).catch(() => null); return res?.ok ? await res.json() as T : null; }, false, (v) => v !== null);
}
const raw = (url: string) => cached<string>(`site-raw-${hash(url)}`, async () => { const res = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null); return res?.ok ? (await res.text()).slice(0, 200_000) : ""; }, false, (v) => v.length > 0);

/** The account GitHub itself attributes this email's public commits to. Exact: GitHub links a commit to an account only when the email is verified on it. */
async function accountOf(email: string): Promise<Account | null> {
  const found = await gh<{ total_count: number; items: GhCommit[] }>(`/search/commits?q=${encodeURIComponent(`author-email:${email}`)}&per_page=100&sort=author-date`);
  const mine = (found?.items ?? []).filter((c) => c.author?.login && c.commit.author.email.toLowerCase() === email.toLowerCase() && !c.repository.private);
  const byLogin = new Map<string, GhCommit[]>();
  for (const c of mine) byLogin.set(c.author!.login, [...(byLogin.get(c.author!.login) ?? []), c]);
  const best = [...byLogin].sort((a, b) => b[1].length - a[1].length)[0];
  if (!best) return null;
  const [login, commits] = best;
  return { login, url: `https://github.com/${login}`, commits: byLogin.size === 1 ? Math.max(found!.total_count, commits.length) : commits.length, repos: [...new Set(commits.filter((c) => c.repository.full_name.toLowerCase().startsWith(`${login.toLowerCase()}/`)).map((c) => c.repository.name))], example: commits[0]!.html_url };
}

// ---------------------------------------------------------------- the owner, once per run

let ownerOnce: Promise<Owner | null> | null = null;
export function theOwner(): Promise<Owner | null> {
  return ownerOnce ??= (async () => {
    const id = await identity();
    if (!id) return null;
    const remote = remoteSlug(await git("remote", "get-url", "origin"));
    const [authors, commits, account, visible] = await Promise.all([
      git("shortlog", "-sne", "HEAD").then(parseAuthors), ownerCommits(id.email), accountOf(id.email),
      remote?.startsWith("github.com/") ? fetch(`https://${remote}`, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15_000) }).then((r) => r.status < 400, () => null) : Promise.resolve(null)]);
    return { ...id, remote, remoteVisible: visible, authors, commits, account };
  })();
}

// ---------------------------------------------------------------- sources that bring their own text

const LOCAL = "repo:";

async function localSources(owner: Owner): Promise<Result[]> {
  const all = owner.authors.reduce((n, a) => n + a.commits, 0), mine = owner.commits, others = owner.authors.filter((a) => a.email.toLowerCase() !== owner.email.toLowerCase());
  const otherNames = [...new Set(others.map((a) => a.name))];
  const dates = mine.map((c) => c.date).sort(), folders = foldersTouched(mine);
  const gitBlocks = [
    `The owner of this repository, from git's own configuration on this machine (user.name): ${owner.name}. Their git email is ${maskEmail(owner.email)}; it is used only to match commits and is never printed.`,
    `This repository's history has ${all} commits. ${owner.name} (the owner) authored ${mine.length} of them, from ${dates[0] ?? "?"} to ${dates.at(-1) ?? "?"}. ${otherNames.length ? `The other authors are teammates, not the owner: ${otherNames.map((n) => `${n} (${others.filter((a) => a.name === n).reduce((s, a) => s + a.commits, 0)} commits)`).join(", ")}. Work in their commits is theirs.` : "There are no other authors."}`,
    ...(folders.length ? [`Counted over the files changed in ${owner.name}'s own commits, by top-level folder: ${folders.slice(0, 8).map(([f, n]) => `${f} ${n} files`).join(", ")}. This shows which parts of the project the owner worked on.`] : []),
    ...(owner.remote ? [`The remote "origin" is ${owner.remote}. ${owner.remoteVisible === false ? "Asked without signing in, it answers 404: the repository is private or not visible to the public, so a link to it would not open for a visitor. Do not link to it." : owner.remoteVisible ? "It opens without signing in." : "Whether it is public was not checked."}${owner.account && !owner.remote.toLowerCase().includes(`/${owner.account.login.toLowerCase()}/`) ? " It is under someone else's account, not the owner's." : ""}`] : []),
    ...mine.map((c) => `Commit ${c.hash} on ${c.date} by ${owner.name} (the owner)${/^merge\b/i.test(c.subject) ? ", a MERGE commit (it brings a teammate's branch together with the owner's: what it calls upstream or names as someone else's is not the owner's work; only how the two were reconciled is)" : ""}: ${c.subject}${c.body ? ` -- ${c.body.replace(/\s+/g, " ").slice(0, 700)}` : ""}${c.files.length ? ` [${c.files.length} files changed, in: ${foldersTouched([c]).slice(0, 5).map(([f, n]) => `${f} ${n}`).join(", ")}]` : ""}`.slice(0, 1200)),
  ];
  const paths = [...new Set([...new Bun.Glob("*.md").scanSync(REPO), ...new Bun.Glob("*/README.md").scanSync(REPO), ...new Bun.Glob("docs/**/*.md").scanSync(REPO)])]
    .filter((p) => !/^(node_modules|out|dist|my-video|\.claude)\//.test(p) && !/^(CLAUDE|AGENTS)\.md$/i.test(p)).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)).slice(0, MAX_DOCS);
  const docs = await Promise.all(paths.map(async (p): Promise<Result> => {
    const text = await Bun.file(join(REPO, p)).text().catch(() => ""), blocks = textBlocks(text, 120);
    return { title: `${p} in the owner's repository: ${/^#\s+(.+)$/m.exec(text)?.[1] ?? p}`, url: `${LOCAL}${p}`, snippet: blocks[0] ?? "", blocks };
  }));
  return [{ title: "git configuration and history of the owner's repository", url: `${LOCAL}git-history`, snippet: gitBlocks[0]!, blocks: gitBlocks }, ...docs.filter((d) => d.blocks?.length)];
}

async function accountSources(owner: Owner): Promise<Result[]> {
  const a = owner.account;
  if (!a) return [];
  const [user, repos] = await Promise.all([gh<GhUser>(`/users/${a.login}`), gh<GhRepo[]>(`/users/${a.login}/repos?per_page=100&sort=pushed`)]);
  const own = (repos ?? []).filter((r) => !r.fork);
  const profile = user ? Object.entries({ "display name": user.name, bio: user.bio, company: user.company, location: user.location, website: user.blog, "Twitter/X": user.twitter_username }).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`) : [];
  const blocks = [
    `GitHub attributes ${a.commits} public commits made with the owner's git email to the account ${a.login} (${a.url})${a.repos.length ? `, in its repositories ${a.repos.join(", ")}` : ""}. One of them: ${a.example}. GitHub links a commit to an account only when the email is verified on that account, so ${a.login} is the repository owner's own GitHub account, and what is under it is theirs.`,
    ...(user ? [`The public GitHub profile ${a.url} (account made ${user.created_at.slice(0, 10)}, ${user.public_repos} public repositories) shows: ${profile.length ? profile.join("; ") : "no display name, bio, company, location, website or email"}.`] : []),
    ...own.map((r) => `Public repository ${r.full_name} (${r.html_url}), the owner's own: ${r.description ? `described as "${r.description}"` : "no description"}; main language ${r.language ?? "not detected"}; made ${r.created_at.slice(0, 10)}, last pushed ${r.pushed_at.slice(0, 10)}; ${r.stargazers_count} stars${r.homepage ? `; homepage ${r.homepage}` : ""}.`),
  ];
  const files = (await Promise.all(own.slice(0, MAX_REPOS).map(async (r) => {
    const listing = (await gh<GhFile[]>(`/repos/${r.full_name}/contents/`)) ?? [];
    if (!Array.isArray(listing) || !listing.length) return [];
    blocks.push(`At the top of ${r.full_name} (${r.html_url}): ${listing.slice(0, 40).map((f) => f.type === "dir" ? `${f.name}/` : f.name).join(", ")}.`.slice(0, 1200));
    return Promise.all(entryFiles(listing).map(async (f): Promise<Result> => {
      const found = f.download_url ? textBlocks(await raw(f.download_url)) : [];
      return { title: `${f.name} in ${r.full_name}, the owner's own public repository`, url: f.html_url, snippet: found[0] ?? "", blocks: found };
    }));
  }))).flat();
  return [{ title: `${a.login} on GitHub: the owner's account, profile and repositories`, url: a.url, snippet: blocks[0]!, blocks }, ...files.filter((f) => f.blocks?.length)];
}

let sourcesOnce: Promise<Result[]> | null = null;
/** Everything that is the owner's by an exact tie, as sources for research. Gathered once per run. */
export function ownSources(): Promise<Result[]> {
  return sourcesOnce ??= (async () => { const owner = await theOwner(); return owner ? [...await localSources(owner), ...await accountSources(owner)] : []; })();
}

/** Is this address one of the owner's own sources (the repository, or under the tied account)? */
export const isOwn = (url: string, owner: Owner) => url.startsWith(LOCAL) || (owner.account !== null && new RegExp(`^https://github\\.com/${owner.account.login}(/|$)`, "i").test(url));

/** For the director: what is known before anything is planned. */
export async function ownerContext(): Promise<string> {
  const owner = await theOwner();
  if (!owner) return "Nothing on this machine says who the user is (git has no user.name and user.email). Do not guess: the page must say that it could not establish whose site it is.";
  const sources = await ownSources(), a = owner.account, mine = owner.commits, folders = foldersTouched(mine);
  const teammates = [...new Set(owner.authors.filter((x) => x.email.toLowerCase() !== owner.email.toLowerCase()).map((x) => x.name))];
  return [
    `"Myself" is the owner of the repository this system runs in. git's configuration on this machine names them: ${owner.name}. Their email is ${maskEmail(owner.email)}: matched by code, never shown to you, never to be printed.`,
    `The repository: ${owner.remote ? `remote ${owner.remote}${owner.remoteVisible === false ? " (answers 404 without signing in: private, never link to it)" : ""}` : "no remote"}. ${owner.name} authored ${mine.length} of its ${owner.authors.reduce((n, x) => n + x.commits, 0)} commits${folders.length ? `, mostly under ${folders.slice(0, 3).map(([f]) => f).join(", ")}` : ""}${teammates.length ? `; the other authors (${teammates.join(", ")}) are teammates, and their work is not the owner's` : ""}.`,
    a ? `GitHub attributes ${a.commits} public commits made with that email to the account ${a.login} (${a.url}); its public repositories include ${a.repos.join(", ") || "none seen"}. That tie is exact, so the account and what is under it are the owner's.` : "No GitHub account could be tied to that email through public commits.",
    `The kit gives EVERY research step these sources with their text, and the fast reader sifts their passages: ${sources.map((s) => s.url).join(", ")}. Research steps need web queries only for what is beyond them.`,
    `"${owner.name}" may be a common name. After the sift, a web page is used only if it carries an exact tie to the owner (${anchorsOf(owner).filter((x) => x !== owner.email.toLowerCase()).slice(0, 6).join(", ")}) and the fast reader judges the passage to be about the same person; every other page found is listed as unconfirmed and never reaches a writer. So word web queries with those ties, or with exact titles and spellings found in earlier notes, not with the bare name.`,
  ].join("\n");
}
