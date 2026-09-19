// ground.eval.ts — grounding, measured: given a goal and a screen, does Jev pick the right element?
//
//   bun jev/ground.eval.ts                         main presenters, every case, two rounds
//   bun jev/ground.eval.ts --set=look,ocr,wording  the ablations, on --base=bareIds (one round unless --rounds says otherwise)
//   bun jev/ground.eval.ts --variant=criteria,grouped --only=hn --rounds=1 --verbose
//   bun jev/ground.eval.ts cases                   print every case with the words of its gold element(s)
//   bun jev/ground.eval.ts report                  tables again from out/jev-ground-eval.json, no requests
//   bun jev/ground.eval.ts fetch                   rebuild jev/fixtures/*.json from the live pages (gold labels may move)
//
// A case is one decision: a goal (+ prepared inputs and history), one Observation, the acceptable answers.
// Two sources. The simulated apps of sim.ts (25-55 elements, realistic clutter and twins). And real pages,
// fetched once as HTML and read with HTMLRewriter into UiElement-shaped lists saved under jev/fixtures/
// (100-750 elements). Nothing here touches a desktop or a browser.
//
// What is real: every Jev request, its latency and token usage, the HTML of the real pages. What is not:
// the sim apps; the layout of the real pages (there is none: `region` is top/middle/bottom by document order,
// `within` is the nearest landmark or heading); the OCR proxy, which strips DOM labels down to what a
// screenshot would show rather than running an OCR model; the gold labels, which are mine (see `cases`).
//
// Results go to out/jev-ground-eval.json. Answers are cached by request in out/.jev-ground-cache.json
// (round N has its own entries), so `report` and re-runs cost nothing; --fresh ignores the cache.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FOCUSED_FIELD, FULL, NONE, PRESENTERS, WORDINGS, createMeteredJev, describe, inlineWording, labelsFor, prefilter,
  type AskRaw, type Candidate, type Ctx, type Grounded, type Look, type Presenter, type Screen, type Task, type Want } from "./ground";
import { SIM_HAND, World } from "./sim";

const FIXTURES = join(import.meta.dir, "fixtures");
const OUT = join(import.meta.dir, "..", "out", "jev-ground-eval.json");
const CACHE = join(import.meta.dir, "..", "out", ".jev-ground-cache.json");
const HAND = { width: SIM_HAND.width, height: SIM_HAND.height };

// ---------------------------------------------------------------- real pages -> fixtures

const PAGES: Record<string, string> = {
  hn: "https://news.ycombinator.com/",
  github: "https://github.com/oven-sh/bun",
  mdn: "https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement",
  bbc: "https://www.bbc.com/news",
  brave: "https://search.brave.com/search?q=best+espresso+machine",
  craigslist: "https://sfbay.craigslist.org/",
  arxiv: "https://arxiv.org/list/cs.AI/recent",
  wikipedia: "https://en.wikipedia.org/wiki/Moka_pot",
};

type Fixture = { url: string; fetched: string; title: string; texts: string[]; elements: Omit<Candidate, "id" | "rect" | "source" | "frame" | "focused">[] };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·", copy: "©", times: "×", rarr: "→", larr: "←" };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m));
const flat = (s: string) => decode(s).replace(/\s+/g, " ").trim();

/**
 * Links, buttons, inputs and selects of a page, in document order, with the labels a DOM gives without layout:
 * accessible name, whether any text is visible (`icon` when not), the nearest landmark or heading (`within`),
 * and the text of the enclosing list item or table row (`row`).
 */
export function extract(html: string, url: string): Fixture {
  type Raw = Fixture["elements"][number] & { forId?: string };
  const out: Raw[] = [], texts: string[] = [], landmarks: string[] = [], labels = new Map<string, string>();
  const rows: { text: string; members: Raw[] }[] = [];
  let heading = "", title = "", capture: { text: string } | null = null, lastChunk: unknown = null;
  let open: { text: string; alt: string } | null = null;
  const within = () => landmarks.at(-1) || heading;
  const attrs = (el: HTMLRewriterTypes.Element) => Object.fromEntries([...el.attributes]) as Record<string, string | undefined>;
  const emit = (raw: Raw) => { out.push(raw); rows.at(-1)?.members.push(raw); };
  const capturing = (el: HTMLRewriterTypes.Element, done: (text: string) => void) => { const mine = { text: "" }, before = capture; capture = mine; el.onEndTag(() => { capture = before; done(flat(mine.text)); }); };

  new HTMLRewriter()
    .on("head > title", { text(t) { title += t.text; } })
    .on("nav, header, footer, form, aside, dialog, [role=navigation], [role=search], [role=dialog]", { element(el) {
      const a = attrs(el), tag = el.tagName;
      const kind = a.role === "navigation" || tag === "nav" ? "navigation" : a.role === "search" ? "search" : a.role === "dialog" || tag === "dialog" ? "dialog" : tag === "aside" ? "sidebar" : tag;
      const name = a["aria-label"] ? `${flat(a["aria-label"])} ${kind}` : kind === "form" ? `form ${a.name || a.id || ""}`.trim() : kind;
      try { el.onEndTag(() => void landmarks.pop()); landmarks.push(name); } catch { /* a void element */ }
    } })
    .on("li, tr, article, dt, dd, [role=row], [role=listitem]", {
      element(el) { const row = { text: "", members: [] as Raw[] }; try { el.onEndTag(() => { rows.splice(rows.indexOf(row), 1); const text = flat(row.text); if (row.members.length <= 12) for (const m of row.members) m.row ??= text.slice(0, 160); }); rows.push(row); } catch { /* void */ } },
      text(t) { if (t !== lastChunk && rows.length && rows.at(-1)!.text.length < 400) rows.at(-1)!.text += t.text; lastChunk = t; },
    })
    .on("h1, h2, h3, h4", { element(el) { capturing(el, (text) => { if (text) { heading = text.slice(0, 80); texts.push(text.slice(0, 120)); } }); }, text(t) { if (capture) capture.text += t.text; } })
    .on("label", { element(el) { const f = el.getAttribute("for"); capturing(el, (text) => { if (f) labels.set(f, text); }); }, text(t) { if (capture) capture.text += t.text; } })
    .on("a[href], button, summary, [role=button], [role=tab], [role=menuitem]", {
      element(el) {
        const a = attrs(el), mine = { text: "", alt: "" }, before = open;
        const role = el.tagName === "a" ? "link" : a.role === "tab" ? "tab" : a.role === "menuitem" ? "menu item" : "button";
        open = mine;
        const finish = () => {
          open = before;
          if (a.hidden !== undefined || a["aria-hidden"] === "true" || a.disabled !== undefined) return;
          const visible = flat(mine.text), name = flat(a["aria-label"] || visible || mine.alt || a.title || "");
          emit({ role, name: name.slice(0, 120), value: "", editable: false, within: within(), href: role === "link" ? absolute(decode(a.href ?? ""), url) : "", icon: !visible });
        };
        try { el.onEndTag(finish); } catch { finish(); }
      },
      text(t) { if (open) open.text += t.text; },
    })
    .on("a img[alt], button img[alt], a svg[aria-label], button svg[aria-label], a [title], button [title]", { element(el) { if (open) open.alt ||= el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || ""; } })
    .on("input, textarea", { element(el) {
      const a = attrs(el), type = (a.type || "text").toLowerCase();
      if (type === "hidden" || a.hidden !== undefined) return;
      const role = el.tagName === "textarea" ? "text field" : type === "checkbox" ? "checkbox" : type === "radio" ? "radio button" : /^(submit|button|image|reset)$/.test(type) ? "button" : type === "password" ? "password field" : type === "search" ? "search field" : "text field";
      const editable = role.endsWith(" field");
      const name = flat(a["aria-label"] || a.placeholder || (role === "button" ? a.value || a.alt : "") || a.title || a.name || a.id || "");
      emit({ role, name: name.slice(0, 120), value: editable ? a.value ?? "" : "", editable, within: within(), href: "", icon: false, forId: a.id });
    } })
    .on("select", { element(el) { const a = attrs(el); emit({ role: "dropdown", name: flat(a["aria-label"] || a.title || a.name || a.id || ""), value: "", editable: false, within: within(), href: "", icon: false, options: [], forId: a.id }); } })
    .on("select option", { element(el) { const sel = out.findLast((r) => r.role === "dropdown"), chosen = el.getAttribute("selected") !== null; capturing(el, (text) => { if (sel && text) { sel.options!.push(text); if (chosen) sel.value = text; } }); }, text(t) { if (capture) capture.text += t.text; } })
    .transform(html);

  // A <label for> may come after its input. Then what observe.ts does: nothing to tell it apart by, or seen already -> dropped.
  const seen = new Set<string>();
  const elements = out.flatMap(({ forId, ...raw }) => {
    const el = { ...raw, name: (forId && labels.get(forId)?.slice(0, 120)) || raw.name };
    const key = `${el.role}|${el.name}|${el.href}|${el.within}`;
    if ((!el.name && !el.editable) || seen.has(key)) return [];
    seen.add(key);
    if (el.row === el.name || !el.row) delete el.row;
    return [el];
  });
  return { url, fetched: new Date().toISOString(), title: flat(title), texts: [...new Set(texts)].slice(0, 40), elements };
}

function absolute(href: string, base: string): string { try { return new URL(href, base).href; } catch { return href; } }

async function fetchFixtures(only: string[]) {
  await mkdir(FIXTURES, { recursive: true });
  for (const [name, url] of Object.entries(PAGES)) {
    if (only.length && !only.includes(name)) continue;
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", accept: "text/html" } });
    if (!response.ok) { console.log(`${name}: HTTP ${response.status}, kept the old fixture`); continue; }
    const fixture = extract(await response.text(), url);
    await Bun.write(join(FIXTURES, `${name}.json`), `${JSON.stringify(fixture, null, 1)}\n`);
    console.log(`${name}: ${fixture.elements.length} elements, ${fixture.elements.filter((el) => el.icon).length} without visible text, ${fixture.texts.length} headings`);
  }
}

/** A fixture as a Screen. There is no layout: rects only keep document order, `region` is a third of the page. */
async function realScreen(name: string): Promise<Screen & { fixture: Fixture }> {
  const fixture = (await Bun.file(join(FIXTURES, `${name}.json`)).json()) as Fixture, n = fixture.elements.length;
  const elements = fixture.elements.map((el, i): Candidate => ({ ...el, id: `e${i + 1}`, source: "atspi", focused: false, frame: fixture.title, region: i < n / 3 ? "top" : i < (2 * n) / 3 ? "middle" : "bottom",
    rect: { x: HAND.width / 2 - 60, y: Math.floor((i / n) * (HAND.height - 20)), w: 120, h: 16 } }));
  return { fixture, elements, texts: [`page: ${fixture.title}`, `address: ${fixture.url}`, ...fixture.texts], frames: [fixture.title], fingerprint: Bun.hash(JSON.stringify(fixture.elements)).toString(36) };
}

// ---------------------------------------------------------------- cases

type Kind = "click" | "type" | "none" | "move";
type Case = {
  id: string; source: "sim" | "real"; page: string; kind: Kind; want: Want; hard: string[];
  task: Task; screen: Screen;
  /** Acceptable picks: element ids, and NONE when escalating is right. Empty for `move` cases. */
  gold: string[];
  goldInput: string | null;
  /** Acceptable whole actions, for the presenters that decide one. */
  goldActions: string[];
};

/** Elements the real apps draw as an icon, a blank area, or a value: what a screenshot would NOT show as this name. */
const SIM_ICONS: Record<string, string[]> = {
  "mail.google.com": ["menu", "search_options", "support", "settings", "apps", "account", "refresh", "select_all", "c_minimize", "c_popout", "c_close", "send_options", "formatting", "attach", "insert_link", "emoji", "drive", "confidential", "discard", "body"],
  "keep.google.com": ["menu", "refresh", "list_view", "settings", "account", "pin", "remind", "collaborator", "background", "image", "archive", "more", "undo", "redo", "new_list", "new_drawing", "new_image"],
  "messages.google.com": ["menu", "settings", "account", "call", "details", "attach", "emoji", "send"],
  "www.opentable.com": ["notifications", "profile"],
  "www.google.com": ["apps", "account"],
};

type SimSpec = {
  id: string; url: string; goal: string; inputs?: Record<string, string>; history?: string[]; doneWhen?: string; hard?: string[];
  /** Replayed on a fresh World before the look: [click, key] or [type, key, text]. */
  steps?: (["click", string] | ["type", string, string])[];
  /** Gold by sim key; "none" where escalating is right. */
  click?: string[]; field?: string; input?: string;
  /** Other acceptable whole actions: key_Return, scroll_down, done, none. */
  also?: string[]; move?: boolean;
};

function simCase(spec: SimSpec): Case {
  const world = new World(), host = new URL(spec.url).hostname;
  world.open(spec.url);
  const find = (key: string) => { const el = world.look().elements.find((e) => world.keyOf(e.id) === key); if (!el) throw new Error(`${spec.id}: no element "${key}" on screen`); return el; };
  for (const step of spec.steps ?? []) {
    if (step[0] === "click") world.act({ kind: "click", target: find(step[1]), button: "left", count: 1 }, "");
    else world.act({ kind: "type", target: find(step[1]), input: "", text: step[2], submit: false }, "");
  }
  const obs = world.look(), icons = new Set(SIM_ICONS[host] ?? []);
  const screen: Screen = { ...obs, elements: obs.elements.map((el) => ({ ...el, icon: icons.has(world.keyOf(el.id) ?? "") })) };
  const idOf = (key: string) => (key === "none" ? NONE : screen.elements.find((el) => world.keyOf(el.id) === key)?.id ?? (() => { throw new Error(`${spec.id}: gold "${key}" is not on screen`); })());
  const want: Want = spec.field ? "field" : "click";
  const gold = spec.field ? [idOf(spec.field)] : (spec.click ?? []).map(idOf);
  const goldActions = [...(spec.field ? [`type_${spec.input}_${gold[0]}`] : gold.map((id) => (id === NONE ? "none" : `click_${id}`))), ...(spec.also ?? [])];
  return { id: spec.id, source: "sim", page: host.replace(/^(www|mail|keep|messages)\./, (m) => (m === "www." ? "" : m)), kind: spec.move ? "move" : spec.field ? "type" : gold.includes(NONE) ? "none" : "click", want, hard: spec.hard ?? [],
    task: { goal: spec.goal, inputs: spec.inputs ?? {}, history: spec.history ?? [], doneWhen: spec.doneWhen }, screen, gold: spec.move ? [] : gold, goldInput: spec.input ?? null, goldActions };
}

const GMAIL = "https://mail.google.com/", TABLE = "https://www.opentable.com/", RESULTS = "https://www.opentable.com/s?term=steakhouse&covers=2&dateTime=2026-09-20T19:00";
const KEEP = "https://keep.google.com/", SMS = "https://messages.google.com/web", GOOGLE = "https://www.google.com/";
const MAIL = { recipient: "Sam", subject: "Meeting tomorrow", body: "Hi Sam, a reminder that we meet tomorrow at 10. See you there." };
const MAIL_GOAL = "Send an email to Sam Rivera reminding him about the meeting tomorrow at 10.", MAIL_DONE = "Gmail shows that the message was sent.";
const did = (what: string) => `${what} -> screen changed`;

const SIM_CASES: SimSpec[] = [
  // Gmail, inbox
  { id: "gmail-compose", url: GMAIL, goal: MAIL_GOAL, inputs: MAIL, doneWhen: MAIL_DONE, click: ["compose"] },
  { id: "gmail-open-alex", url: GMAIL, goal: "Open the email from Alex Chen about the deck for Monday.", click: ["mail_1"] },
  { id: "gmail-open-invoice", url: GMAIL, goal: "Open the email with the invoice for August.", click: ["mail_7"], hard: ["far down"] },
  { id: "gmail-sent", url: GMAIL, goal: "Show the emails I have already sent.", click: ["sent"], hard: ["near-duplicate names"] },
  { id: "gmail-drafts", url: GMAIL, goal: "Go to my drafts.", click: ["drafts"] },
  { id: "gmail-search", url: GMAIL, goal: "Find all emails about the dentist.", inputs: { query: "dentist" }, field: "search", input: "query" },
  { id: "gmail-settings", url: GMAIL, goal: "Open the Gmail settings.", click: ["settings"], hard: ["icon"] },
  { id: "gmail-no-undo", url: GMAIL, goal: "Click Undo to take back the email that was just sent.", click: ["none"] },
  { id: "gmail-no-netflix", url: GMAIL, goal: "Open the email from Netflix about the failed payment.", click: ["none", "search"], also: ["scroll_down"], hard: ["absent"] },
  // Gmail, composing
  { id: "gmail-to", url: GMAIL, goal: MAIL_GOAL, inputs: MAIL, doneWhen: MAIL_DONE, steps: [["click", "compose"]], history: [did('click button "Compose"')], field: "to", input: "recipient" },
  { id: "gmail-suggest-sam", url: GMAIL, goal: MAIL_GOAL, inputs: MAIL, doneWhen: MAIL_DONE, steps: [["click", "compose"], ["type", "to", "Sam"]], history: [did('click button "Compose"'), did('type recipient ("Sam") into text field "To recipients"')], click: ["suggest_0"], hard: ["near-duplicate names"] },
  { id: "gmail-suggest-samantha", url: GMAIL, goal: "Send an email to Samantha Lee asking if she got the contract.", inputs: { recipient: "Sam", subject: "Contract", body: "Hi Samantha, did you get the contract?" }, steps: [["click", "compose"], ["type", "to", "Sam"]],
    history: [did('click button "Compose"'), did('type recipient ("Sam") into text field "To recipients"')], click: ["suggest_1"], hard: ["near-duplicate names"] },
  { id: "gmail-subject", url: GMAIL, goal: MAIL_GOAL, inputs: MAIL, doneWhen: MAIL_DONE, steps: [["click", "compose"], ["type", "to", "Sam"], ["click", "suggest_0"]],
    history: [did('click button "Compose"'), did('type recipient ("Sam") into text field "To recipients"'), did('click option "Sam Rivera sam.rivera@example.com"')], field: "subject", input: "subject" },
  { id: "gmail-body", url: GMAIL, goal: MAIL_GOAL, inputs: MAIL, doneWhen: MAIL_DONE, steps: [["click", "compose"], ["type", "to", "Sam"], ["click", "suggest_0"], ["type", "subject", MAIL.subject]],
    history: [did('click button "Compose"'), did('type recipient ("Sam") into text field "To recipients"'), did('click option "Sam Rivera sam.rivera@example.com"'), did('type subject ("Meeting tomorrow") into text field "Subject"')], field: "body", input: "body" },
  { id: "gmail-send", url: `${GMAIL}?view=cm&to=sam.rivera@example.com&su=Meeting+tomorrow&body=${encodeURIComponent(MAIL.body)}`, goal: MAIL_GOAL, inputs: MAIL, doneWhen: MAIL_DONE,
    history: [did('type recipient ("Sam") into text field "To recipients"'), did('type subject ("Meeting tomorrow") into text field "Subject"'), did('type body ("Hi Sam, a reminder that we meet tomorrow at 10. See you there.") into text field "Message Body"')], click: ["send"], hard: ["near-duplicate names"] },
  { id: "gmail-discard", url: `${GMAIL}?view=cm`, goal: "Throw away the draft that is open.", click: ["discard"], hard: ["icon"] },
  { id: "gmail-cc", url: `${GMAIL}?view=cm&to=sam.rivera@example.com`, goal: "Put Dana Whitfield in copy on this email.", inputs: { cc: "dana.w@example.com" }, click: ["cc"], hard: ["near-duplicate names"] },
  { id: "gmail-schedule", url: `${GMAIL}?view=cm&to=sam.rivera@example.com&su=Hi&body=Hello`, goal: "Schedule this email to go out tomorrow morning instead of now.", click: ["send_options"], hard: ["icon", "poor name"] },
  { id: "gmail-attach", url: `${GMAIL}?view=cm&to=sam.rivera@example.com`, goal: "Attach the quarterly report PDF from this computer to the email.", click: ["attach"], hard: ["icon", "near-duplicate names"] },
  { id: "gmail-error-ok", url: GMAIL, goal: MAIL_GOAL, inputs: MAIL, doneWhen: MAIL_DONE, steps: [["click", "compose"], ["type", "to", "Sam"], ["click", "send"]],
    history: [did('click button "Compose"'), did('type recipient ("Sam") into text field "To recipients"'), did('click button "Send"')], click: ["error_ok"] },
  // OpenTable
  { id: "table-term", url: TABLE, goal: "Book a table at a steakhouse for two tomorrow at 7 pm.", inputs: { search: "steakhouse" }, field: "term", input: "search" },
  { id: "table-date", url: TABLE, goal: "Change the reservation date to Friday, September 25.", click: ["date"] },
  { id: "table-day", url: TABLE, goal: "Book a table for Friday, September 25.", steps: [["click", "date"]], history: [did('click dropdown "Date"')], click: ["day_6"], hard: ["twins", "numbers"] },
  { id: "table-day-tomorrow", url: TABLE, goal: "Book a table for Sunday, September 20.", steps: [["click", "date"]], history: [did('click dropdown "Date"')], click: ["day_1"], hard: ["twins", "numbers"] },
  { id: "table-time", url: TABLE, goal: "Book a table at 8:30 PM.", steps: [["click", "time"]], history: [did('click dropdown "Time"')], click: ["time_7"], hard: ["twins", "numbers"] },
  { id: "table-party", url: TABLE, goal: "Book a table for six people.", steps: [["click", "party"]], history: [did('click dropdown "Party size"')], click: ["party_5"], hard: ["numbers"] },
  { id: "table-sushi", url: TABLE, goal: "Browse sushi restaurants.", click: ["cuisine_Sushi"], hard: ["near-duplicate names"] },
  { id: "table-casa", url: TABLE, goal: "Look at Casa Oaxaca.", click: ["promo_5"] },
  { id: "table-gift", url: TABLE, goal: "Buy a gift card.", click: ["f_gift"], hard: ["far down"] },
  { id: "slot-keens-7", url: RESULTS, goal: "Book a table at Keens Steakhouse at 7:00 PM.", click: ["slot_2_0"], hard: ["twins"] },
  { id: "slot-steakhouse-7", url: RESULTS, goal: "Book a table at a steakhouse for two tomorrow at 7 pm. Not a promoted restaurant of another cuisine.", click: ["slot_2_0", "slot_3_0"], hard: ["twins"] },
  { id: "slot-capital-730", url: RESULTS, goal: "Book The Capital Grille at 7:30 PM.", click: ["slot_3_30"], hard: ["twins"] },
  { id: "slot-prime-645", url: RESULTS, goal: "Book Prime & Provisions at 6:45 PM.", click: ["slot_1_-15"], hard: ["twins"] },
  { id: "slot-bella-715", url: RESULTS, goal: "Book Bella Napoli at 7:15 PM.", click: ["slot_0_15"], hard: ["twins"] },
  { id: "slot-no-930", url: RESULTS, goal: "Book Keens Steakhouse at 9:30 PM.", click: ["none", "time", "r_2"], hard: ["absent", "twins"] },
  { id: "slot-no-nobu", url: RESULTS, goal: "Book a table at Nobu at 7:00 PM.", click: ["none", "term"], hard: ["absent", "twins"] },
  { id: "results-outdoor", url: RESULTS, goal: "Only show restaurants with outdoor seating.", click: ["filter_Outdoor seating"] },
  { id: "booking-complete", url: RESULTS, goal: "Book a table at Keens Steakhouse at 7:00 PM.", doneWhen: "OpenTable shows the reservation as confirmed.", steps: [["click", "slot_2_0"]], history: [did('click button "7:00 PM" in window "steakhouse near you - OpenTable"')], click: ["complete"] },
  { id: "booking-request", url: RESULTS, goal: "Book Keens Steakhouse at 7:00 PM and ask for a quiet table by the window.", inputs: { request: "A quiet table by the window, please." }, steps: [["click", "slot_2_0"]], history: [did('click button "7:00 PM"')], field: "request", input: "request" },
  { id: "booking-terms", url: RESULTS, goal: "Read the terms of use before booking.", steps: [["click", "slot_2_0"]], click: ["b_terms", "f_terms"], hard: ["twins"] },
  { id: "confirmed-calendar", url: RESULTS, goal: "Add the reservation to my calendar.", steps: [["click", "slot_2_0"], ["click", "complete"]], click: ["add_calendar"] },
  { id: "confirmed-no-rating", url: RESULTS, goal: "Rate the restaurant five stars.", steps: [["click", "slot_2_0"], ["click", "complete"]], click: ["none"], hard: ["absent"] },
  // Keep
  { id: "keep-take", url: KEEP, goal: "Make a note about the doctor's appointment on Tuesday at 3 pm.", inputs: { note: "Doctor's appointment on Tuesday at 3 pm" }, field: "take", input: "note" },
  { id: "keep-title", url: KEEP, goal: "Make a note titled Doctor about the appointment on Tuesday at 3 pm.", inputs: { title: "Doctor", note: "Appointment on Tuesday at 3 pm" }, steps: [["type", "take", "Appointment on Tuesday at 3 pm"]],
    history: [did('type note ("Appointment on Tuesday at 3 pm") into text field "Take a note…"')], field: "title", input: "title" },
  { id: "keep-close", url: KEEP, goal: "Make a note about the doctor's appointment on Tuesday at 3 pm.", inputs: { note: "Doctor's appointment on Tuesday at 3 pm" }, doneWhen: "The note is saved and listed under Notes.", steps: [["type", "take", "Doctor's appointment on Tuesday at 3 pm"]],
    history: [did('type note ("Doctor\'s appointment on Tuesday at 3 pm") into text field "Take a note…"')], click: ["close"] },
  { id: "keep-open-lisbon", url: KEEP, goal: "Open my packing list for Lisbon.", click: ["note_3"] },
  { id: "keep-pin", url: KEEP, goal: "Pin the note that is being written.", steps: [["click", "take"]], click: ["pin"], hard: ["icon"] },
  { id: "keep-archive-note", url: KEEP, goal: "Archive the note that is being written.", steps: [["click", "take"]], click: ["archive"], hard: ["twins", "icon"] },
  { id: "keep-archived-list", url: KEEP, goal: "Show the list of notes I archived earlier.", steps: [["click", "take"]], click: ["nav_archive"], hard: ["twins"] },
  { id: "keep-no-insurance", url: KEEP, goal: "Open the note about the car insurance renewal.", click: ["none", "search"], hard: ["absent"] },
  // Messages
  { id: "sms-mom", url: SMS, goal: "Reply to mom's text and tell her I'll be there at six.", inputs: { reply: "I'll be there at six." }, click: ["thread_0"] },
  { id: "sms-alex", url: SMS, goal: "Text Alex and say yes, I can send the deck in an hour.", inputs: { reply: "Yes, I can send the deck in an hour." }, click: ["thread_1"] },
  { id: "sms-patel", url: SMS, goal: "Confirm the appointment with the doctor's office by text.", inputs: { reply: "C" }, click: ["thread_2"] },
  { id: "sms-draft", url: SMS, goal: "Reply to mom's text and tell her I'll be there at six.", inputs: { reply: "I'll be there at six." }, steps: [["click", "thread_0"]], history: [did('click link "Mom. Are you coming for dinner tonight? We eat at six thirty. 5:42 PM. Unread."')], field: "draft", input: "reply" },
  { id: "sms-send", url: SMS, goal: "Reply to mom's text and tell her I'll be there at six.", inputs: { reply: "I'll be there at six." }, doneWhen: "The reply shows in the conversation with Mom.", steps: [["click", "thread_0"], ["type", "draft", "I'll be there at six."]],
    history: [did('click link "Mom. Are you coming for dinner tonight? ..."'), did('type reply ("I\'ll be there at six.") into text field "Text message"')], click: ["send"], also: ["key_Return"], hard: ["icon"] },
  { id: "sms-start", url: SMS, goal: "Start a new conversation with a number that is not in the list.", click: ["start"] },
  { id: "sms-no-grandma", url: SMS, goal: "Open the existing conversation with Grandma.", click: ["none", "start"], hard: ["absent"] },
  // Google, and a page that leads nowhere
  { id: "google-q", url: GOOGLE, goal: "Search the web for OpenTable.", inputs: { query: "opentable" }, field: "q", input: "query" },
  { id: "google-hit", url: `${GOOGLE}search?q=book+a+table`, goal: "Book a table on OpenTable.", click: ["hit_0"] },
  { id: "google-gmail", url: GOOGLE, goal: "Open Gmail.", click: ["gmail"] },
  { id: "yelp-signin", url: "https://www.yelp.com/", goal: "Sign in to the site.", click: ["signin"] },
  { id: "yelp-no-cookies", url: "https://www.yelp.com/", goal: "Accept the cookie banner.", click: ["none"], hard: ["absent"] },
  // The right move is not a click on an element: only presenters that decide whole actions are scored on these.
  { id: "move-enter-search", url: GOOGLE, goal: "Search the web for OpenTable.", inputs: { query: "opentable" }, steps: [["type", "q", "opentable"]], history: [did('type query ("opentable") into text field "Search"')], move: true, click: ["search"], also: ["key_Return"] },
  { id: "move-done-booked", url: RESULTS, goal: "Book a table at Keens Steakhouse at 7:00 PM.", doneWhen: "OpenTable shows the reservation as confirmed.", steps: [["click", "slot_2_0"], ["click", "complete"]],
    history: [did('click button "7:00 PM"'), did('click button "Complete reservation"')], move: true, also: ["done"] },
  { id: "move-done-sent", url: SMS, goal: "Reply to mom's text and tell her I'll be there at six.", inputs: { reply: "I'll be there at six." }, doneWhen: "The reply shows in the conversation with Mom.", steps: [["click", "thread_0"], ["type", "draft", "I'll be there at six."], ["click", "send"]],
    history: [did('click link "Mom. ..."'), did('type reply ("I\'ll be there at six.") into text field "Text message"'), did('click button "Send SMS message"')], move: true, also: ["done"] },
];

type RealSpec = { id: string; page: string; goal: string; inputs?: Record<string, string>; hard?: string[];
  /** Gold: every element this matches. None at all means the right answer is NONE. */
  match?: (el: Candidate) => boolean; field?: boolean; input?: string;
  /** When the thing is absent: a harmless step that is also fine, like putting the cursor in the page's search box. */
  orElse?: (el: Candidate) => boolean };

const named = (name: string, within?: string) => (el: Candidate) => el.name === name && (within === undefined || el.within === within);
const to = (part: string) => (el: Candidate) => (el.href ?? "").includes(part);
const searchBox = (el: Candidate) => (el.editable && /search|^q$/i.test(el.name)) || el.name === "Search the site";

const REAL_CASES: RealSpec[] = [
  // Hacker News: no landmarks, no headings, thirty rows of twins
  { id: "hn-story-git", page: "hn", goal: "Open the story about running Git on object storage.", match: (el) => el.name.startsWith("You can run Git on object storage") },
  { id: "hn-story-cloudflare-ram", page: "hn", goal: "Open the Cloudflare post about saving RAM.", match: (el) => el.name === "Saving another 100TB of RAM", hard: ["near-duplicate names"] },
  { id: "hn-comments-llm", page: "hn", goal: "Open the comments on the story 'How to Write with an LLM'.", match: to("item?id=49747070"), hard: ["twins", "nearby text"] },
  { id: "hn-upvote-cat", page: "hn", goal: "Upvote the story about the new cat species.", match: to("vote?id=49744704"), hard: ["twins", "icon", "nearby text", "far down"] },
  { id: "hn-more", page: "hn", goal: "Go to the second page of stories.", match: named("More"), hard: ["poor name", "far down"] },
  { id: "hn-login", page: "hn", goal: "Log in to Hacker News.", match: named("login") },
  { id: "hn-newest", page: "hn", goal: "Show the newest submissions.", match: named("new"), hard: ["poor name"] },
  { id: "hn-search", page: "hn", goal: "Search Hacker News for posts about rust async.", inputs: { query: "rust async" }, field: true, input: "query", match: (el) => el.editable, hard: ["poor name", "far down"] },
  { id: "hn-no-sqlite", page: "hn", goal: "Open the story about SQLite.", hard: ["absent"], orElse: searchBox },
  // GitHub repository page: 528 elements, the same word in four containers
  { id: "gh-pulls", page: "github", goal: "Open this repository's pull requests.", match: (el) => (el.href ?? "").endsWith("/oven-sh/bun/pulls") },
  { id: "gh-src", page: "github", goal: "Open the src directory.", match: to("/tree/main/src") },
  { id: "gh-package-json", page: "github", goal: "Open the file package.json.", match: to("/blob/main/package.json") },
  { id: "gh-license-file", page: "github", goal: "Open the file LICENSE.md in the list of files.", match: to("/blob/main/LICENSE.md"), hard: ["near-duplicate names"] },
  { id: "gh-sqlite-docs", page: "github", goal: "Read the documentation of Bun's SQLite API.", match: to("bun.com/docs/runtime/sqlite"), hard: ["far down"] },
  { id: "gh-forks", page: "github", goal: "See the list of forks of this repository.", match: (el) => (el.href ?? "").endsWith("/oven-sh/bun/forks"), hard: ["near-duplicate names", "far down"] },
  { id: "gh-footer-security", page: "github", goal: "Open GitHub's Security page from the footer of the page.", match: named("Security", "Footer navigation"), hard: ["twins", "far down"] },
  { id: "gh-branch", page: "github", goal: "Switch to a different branch.", match: (el) => el.name === "main branch" || (el.href ?? "").endsWith("/oven-sh/bun/branches"), hard: ["poor name"] },
  { id: "gh-signup", page: "github", goal: "Create a GitHub account.", match: named("Sign up") },
  { id: "gh-go-to-file", page: "github", goal: "Find the file bunfig.toml in this repository.", inputs: { filename: "bunfig.toml" }, field: true, input: "filename", match: (el) => el.editable && el.name === "Go to file" },
  { id: "gh-no-wiki", page: "github", goal: "Open the Wiki tab of this repository.", hard: ["absent"] },
  // MDN reference page: a sidebar that repeats the article's links under shorter names
  { id: "mdn-click-method", page: "mdn", goal: "Open the reference page of the click() method.", match: (el) => (el.href ?? "").endsWith("/HTMLElement/click"), hard: ["near-duplicate names"] },
  { id: "mdn-offsetwidth", page: "mdn", goal: "Open the reference page of the offsetWidth property.", match: (el) => (el.href ?? "").endsWith("/HTMLElement/offsetWidth"), hard: ["near-duplicate names"] },
  { id: "mdn-showpopover", page: "mdn", goal: "Open the reference page of showPopover().", match: (el) => (el.href ?? "").endsWith("/HTMLElement/showPopover"), hard: ["near-duplicate names"] },
  { id: "mdn-beforetoggle", page: "mdn", goal: "Open the reference page of the beforetoggle event.", match: to("/beforetoggle_event") },
  { id: "mdn-dark", page: "mdn", goal: "Switch the site to the dark theme.", match: named("Dark") },
  { id: "mdn-french", page: "mdn", goal: "Read this page in French.", match: named("Français") },
  { id: "mdn-careers", page: "mdn", goal: "See the job openings at Mozilla.", match: named("Mozilla careers"), hard: ["far down"] },
  { id: "mdn-filter", page: "mdn", goal: "Filter the sidebar down to the offset properties.", inputs: { filter: "offset" }, field: true, input: "filter", match: (el) => el.editable && el.name === "Filter sidebar" },
  { id: "mdn-no-scrollto", page: "mdn", goal: "Open the reference page of HTMLElement.scrollTo().", hard: ["absent", "near-duplicate names"], orElse: searchBox },
  // BBC News front page
  { id: "bbc-technology", page: "bbc", goal: "Open the Technology section.", match: named("Technology"), hard: ["twins"] },
  { id: "bbc-cuba", page: "bbc", goal: "Read the story about the blackout in Cuba.", match: to("c6j9x4387lzxo") },
  { id: "bbc-shark", page: "bbc", goal: "Read the article about the shark attack in Western Australia.", match: to("cqwyzdnk442lo") },
  { id: "bbc-spanish", page: "bbc", goal: "Open the BBC's Spanish-language edition.", match: to("bbc.com/mundo"), hard: ["far down"] },
  { id: "bbc-privacy", page: "bbc", goal: "Read the BBC's privacy policy.", match: named("Privacy Policy"), hard: ["far down"] },
  { id: "bbc-instagram", page: "bbc", goal: "Follow the BBC on Instagram.", match: named("Follow BBC on instagram"), hard: ["icon", "far down"] },
  { id: "bbc-search", page: "bbc", goal: "Search the BBC site for interest rates.", inputs: { query: "interest rates" }, field: true, input: "query", match: (el) => el.editable },
  { id: "bbc-no-horoscopes", page: "bbc", goal: "Open the horoscopes page.", hard: ["absent"], orElse: searchBox },
  // Brave Search results
  { id: "brave-nyt", page: "brave", goal: "Open the New York Times review.", match: to("nytimes.com") },
  { id: "brave-seriouseats", page: "brave", goal: "Open the Serious Eats result.", match: to("seriouseats.com") },
  { id: "brave-images", page: "brave", goal: "Show image results for this search.", match: named("Images") },
  { id: "brave-news-tab", page: "brave", goal: "Show news results for this search.", match: named("News"), hard: ["near-duplicate names"] },
  { id: "brave-next", page: "brave", goal: "Go to the next page of results.", match: named("Next"), hard: ["far down"] },
  { id: "brave-clear", page: "brave", goal: "Empty the search box.", match: named("Clear"), hard: ["icon"] },
  { id: "brave-google", page: "brave", goal: "Run the same search on Google instead.", match: named("Google") },
  { id: "brave-search", page: "brave", goal: "Search for the best burr grinder instead.", inputs: { query: "best burr grinder" }, field: true, input: "query", match: (el) => el.editable },
  { id: "brave-no-consumer-reports", page: "brave", goal: "Open the result from Consumer Reports.", hard: ["absent"], orElse: searchBox },
  // craigslist: 439 one-word links; the same word under community, services, forums, for sale, gigs
  { id: "cl-bikes-for-sale", page: "craigslist", goal: "Browse bicycles that are for sale.", match: named("bikes", "for sale"), hard: ["twins"] },
  { id: "cl-general-community", page: "craigslist", goal: "Open the general category of the community section.", match: named("general", "community"), hard: ["twins"] },
  { id: "cl-legal-services", page: "craigslist", goal: "Find a lawyer: open legal services.", match: named("legal", "services"), hard: ["twins"] },
  { id: "cl-pets-forum", page: "craigslist", goal: "Open the discussion forum about pets.", match: named("pets", "discussion forums"), hard: ["twins"] },
  { id: "cl-computer-gigs", page: "craigslist", goal: "Find short computer gigs.", match: named("computer", "gigs"), hard: ["twins"] },
  { id: "cl-software-jobs", page: "craigslist", goal: "Browse software engineering jobs.", match: named("software / qa / dba") },
  { id: "cl-rooms", page: "craigslist", goal: "Look for a room in a shared apartment.", match: named("rooms / shared"), hard: ["near-duplicate names"] },
  { id: "cl-japan", page: "craigslist", goal: "Switch to the craigslist site for Japan.", match: named("japan"), hard: ["far down"] },
  { id: "cl-post", page: "craigslist", goal: "Post a new ad.", match: to("post.craigslist.org") },
  { id: "cl-no-drones", page: "craigslist", goal: "Open the category named drones under for sale.", hard: ["absent"] },
  // arXiv listing: fifty "pdf" links told apart only by the id next to them
  { id: "arxiv-pdf-5", page: "arxiv", goal: "Download the PDF of arXiv:2609.20658.", match: to("/pdf/2609.20658"), hard: ["twins", "numbers", "nearby text"] },
  { id: "arxiv-pdf-35", page: "arxiv", goal: "Download the PDF of arXiv:2609.20057.", match: to("/pdf/2609.20057"), hard: ["twins", "numbers", "nearby text", "far down"] },
  { id: "arxiv-html-1", page: "arxiv", goal: "Open the HTML version of arXiv:2609.20804.", match: to("/html/2609.20804"), hard: ["twins", "numbers", "nearby text"] },
  { id: "arxiv-abs-last", page: "arxiv", goal: "Open the abstract page of arXiv:2609.19866.", match: to("/abs/2609.19866"), hard: ["numbers", "far down"] },
  { id: "arxiv-author", page: "arxiv", goal: "Show other papers by Marc Jeanmougin.", match: named("Marc Jeanmougin"), hard: ["far down"] },
  { id: "arxiv-wednesday", page: "arxiv", goal: "Jump to the submissions of Wednesday, 16 September.", match: named("Wed, 16 Sep 2026"), hard: ["numbers"] },
  { id: "arxiv-show-100", page: "arxiv", goal: "Show 100 entries per page instead of 50.", match: to("show=100"), hard: ["poor name", "twins"] },
  { id: "arxiv-search", page: "arxiv", goal: "Search arXiv for speculative decoding.", inputs: { query: "speculative decoding" }, field: true, input: "query", match: (el) => el.editable },
  { id: "arxiv-no-id", page: "arxiv", goal: "Download the PDF of arXiv:2609.31415.", hard: ["absent", "numbers", "twins"], orElse: searchBox },
  // Wikipedia article: 704 elements, three Choices' worth
  { id: "wiki-history", page: "wikipedia", goal: "See the edit history of this article.", match: to("action=history"), hard: ["near-duplicate names"] },
  { id: "wiki-italian", page: "wikipedia", goal: "Read this article in Italian.", match: named("Italiano") },
  { id: "wiki-alfonso", page: "wikipedia", goal: "Open the article about Alfonso Bialetti, the inventor.", match: to("/wiki/Alfonso_Bialetti"), hard: ["near-duplicate names"] },
  { id: "wiki-edit-maintenance", page: "wikipedia", goal: "Edit the Maintenance section of the article.", match: named("edit", "Maintenance"), hard: ["twins"] },
  { id: "wiki-pdf", page: "wikipedia", goal: "Download this article as a PDF.", match: named("Download as PDF") },
  { id: "wiki-sapper", page: "wikipedia", goal: "Open the article about Richard Sapper.", match: to("/wiki/Richard_Sapper"), hard: ["near-duplicate names"] },
  { id: "wiki-ristretto", page: "wikipedia", goal: "Open the article about ristretto.", match: named("Ristretto"), hard: ["far down"] },
  { id: "wiki-category", page: "wikipedia", goal: "Open the category of Italian inventions.", match: named("Italian inventions"), hard: ["far down"] },
  { id: "wiki-search", page: "wikipedia", goal: "Search Wikipedia for the AeroPress.", inputs: { query: "AeroPress" }, field: true, input: "query", match: (el) => el.editable, hard: ["twins"] },
  { id: "wiki-aeropress", page: "wikipedia", goal: "Open the article about the AeroPress.", match: named("AeroPress"), hard: ["far down"] },
  { id: "wiki-no-nespresso", page: "wikipedia", goal: "Open the article about Nespresso.", hard: ["absent", "near-duplicate names"], orElse: searchBox },
];

async function allCases(): Promise<Case[]> {
  const cases = SIM_CASES.map(simCase), screens = new Map<string, Screen>();
  for (const spec of REAL_CASES) {
    if (!screens.has(spec.page)) screens.set(spec.page, await realScreen(spec.page));
    const screen = screens.get(spec.page)!, gold = spec.match ? screen.elements.filter(spec.match).map((el) => el.id) : [];
    if (spec.match && !gold.length) throw new Error(`${spec.id}: the gold element is not in the fixture`);
    const fine = spec.orElse ? screen.elements.filter(spec.orElse).map((el) => el.id) : [];
    cases.push({ id: spec.id, source: "real", page: spec.page, kind: spec.field ? "type" : gold.length ? "click" : "none", want: spec.field ? "field" : "click", hard: spec.hard ?? [],
      task: { goal: spec.goal, inputs: spec.inputs ?? {}, history: [] }, screen, gold: gold.length ? gold : [NONE, ...fine], goldInput: spec.input ?? null,
      goldActions: gold.length ? gold.map((id) => (spec.field ? `type_${spec.input}_${id}` : `click_${id}`)) : ["none", ...fine.map((id) => `click_${id}`)] });
  }
  return cases;
}

// ---------------------------------------------------------------- variants

type Variant = { name: string; set: "main" | "look" | "ocr" | "wording"; run: Presenter; ctx?: Partial<Ctx>; wording?: (task: Task) => Ctx["wording"]; onlyIf?: (c: Case) => boolean };
const OCR: Look = { role: false, region: true, within: false, state: false, twins: "ordinal", ocr: true, caption: false };
const P = PRESENTERS;

/** `--base` names the presenter the ablations vary. */
function variants(base: Presenter): Variant[] {
  const look = (name: string, change: Partial<Look>): Variant => ({ name, set: "look", run: base, ctx: { look: { ...FULL, ...change } } });
  const ocr = (name: string, change: Partial<Look>): Variant => ({ name, set: "ocr", run: base, ctx: { look: { ...OCR, ...change } } });
  return [
    { name: "today", set: "main", run: P.today },
    { name: "criteria_only", set: "main", run: P.criteria },
    { name: "bare_ids", set: "main", run: P.bareIds },
    { name: "ids+described_criteria", set: "main", run: P.bareIds, ctx: { describeCriteria: true } },
    { name: "pruned_30_bare_ids", set: "main", run: P.prunedBare, ctx: { k: 30 } },
    { name: "pruned_15", set: "main", run: P.pruned, ctx: { k: 15 } },
    { name: "pruned_30", set: "main", run: P.pruned, ctx: { k: 30 } },
    { name: "per_element_nouls", set: "main", run: P.nouls },
    { name: "grouped_within", set: "main", run: P.grouped, ctx: { by: "within" } },
    { name: "grouped_chunk20", set: "main", run: P.grouped, ctx: { by: "chunk" } },
    { name: "chunks_parallel", set: "main", run: P.parallel, onlyIf: (c) => c.screen.elements.length > 250 },
    { name: "flattened_actions", set: "main", run: P.flattened },
    look("no_region", { region: false }), look("no_within", { within: false }), look("no_role", { role: false }),
    look("twins_by_container_only", { twins: "none" }), look("twins_by_nearby_text", { twins: "near" }),
    ocr("ocr_only", {}), ocr("ocr+icon_captions", { caption: true }), ocr("ocr+role", { role: true }), ocr("ocr+container", { within: true }), ocr("ocr+editable", { state: true }),
    ocr("ocr+all_four", { caption: true, role: true, within: true, state: true }),
    { name: "wording_direct", set: "wording", run: base, ctx: { wording: WORDINGS.direct } },
    { name: "wording_inline_goal", set: "wording", run: base, wording: inlineWording },
    { name: "wording_direct+no_region", set: "wording", run: base, ctx: { wording: WORDINGS.direct, look: { ...FULL, region: false } } },
  ];
}

// ---------------------------------------------------------------- run

type Row = {
  variant: string; set: string; case: string; round: number; source: Case["source"]; page: string; kind: Kind; want: Want; n: number;
  pick: string; input: string | null; action: string | null; confidence: number; prob: number; ranked: [string, number][]; checks?: Record<string, number>;
  ok: boolean; okField: boolean; okInput: boolean; top3: boolean; okAction: boolean | null; reachable: boolean;
  rounds: number; requests: number; ms: number; tokens: number; note?: string; error?: string;
};

/** Answers by request, so tables can be rebuilt and a crashed run resumed without asking again. */
async function cachedAsk(fresh: boolean, round: () => number): Promise<{ ask: AskRaw; save: () => Promise<void>; stats: { asked: number; cached: number } }> {
  const file = Bun.file(CACHE), store: Record<string, Awaited<ReturnType<AskRaw>>> = !fresh && (await file.exists()) ? await file.json() : {};
  const live = createMeteredJev(6), stats = { asked: 0, cached: 0 };
  return { stats, save: async () => void (await Bun.write(CACHE, JSON.stringify(store))),
    ask: async (state, questions) => {
      const key = `${round()}:${Bun.hash(JSON.stringify([state, questions])).toString(36)}`;
      if (store[key]) { stats.cached++; return store[key]!; }
      stats.asked++;
      return (store[key] = await live(state, questions));
    } };
}

function judge(c: Case, g: Pick<Grounded, "pick" | "input" | "action" | "ranked">, variant: { name: string }): Pick<Row, "ok" | "okField" | "okInput" | "top3" | "okAction" | "reachable"> {
  const focused = c.screen.elements.find((el) => el.focused)?.id;
  const hit = (id: string) => c.gold.includes(id) || (id === FOCUSED_FIELD && !!focused && c.gold.includes(focused));
  const okField = hit(g.pick), okInput = c.goldInput === null || g.input === c.goldInput;
  // Flattened labels are whole actions; map them back to the element for top-3.
  const ids = g.ranked.map(([label]) => /^click_(.+)$/.exec(label)?.[1] ?? /^type_.+_([^_]+)$/.exec(label)?.[1] ?? (label === "none" ? NONE : label));
  const reachable = variant.name !== "today" || c.gold.includes(NONE) || c.gold.some((id) => Number(id.slice(1)) <= 150);
  return { okField, okInput, ok: c.kind !== "move" && okField && okInput, top3: c.kind !== "move" && okInput && ids.slice(0, 3).some(hit), okAction: g.action === null ? null : c.goldActions.includes(g.action), reachable };
}

async function run(opts: { sets: string[]; names: string[]; only: string[]; rounds: number | null; fresh: boolean; verbose: boolean; base: keyof typeof PRESENTERS }) {
  const cases = (await allCases()).filter((c) => !opts.only.length || opts.only.some((o) => c.id.includes(o) || c.page.includes(o)));
  const chosen = variants(PRESENTERS[opts.base]).filter((v) => (opts.names.length ? opts.names.includes(v.name) : opts.sets.includes(v.set)));
  let currentRound = 1;
  const { ask, save, stats } = await cachedAsk(opts.fresh, () => currentRound);
  const old = (await Bun.file(OUT).exists()) ? ((await Bun.file(OUT).json()) as { rows: Row[] }).rows : [];
  const rows: Row[] = old.filter((r) => !chosen.some((v) => v.name === r.variant) || !cases.some((c) => c.id === r.case));
  console.log(`${cases.length} cases x ${chosen.length} variants (${chosen.map((v) => v.name).join(", ")})`);

  for (const variant of chosen) {
    const rounds = opts.rounds ?? (variant.set === "main" ? 2 : 1);
    for (currentRound = 1; currentRound <= rounds; currentRound++) {
      const round = currentRound, started = performance.now();
      // The limiter inside `ask` holds requests to six at a time; cases are started together and wait their turn.
      const done = await Promise.all(cases.filter((c) => (variant.onlyIf?.(c) ?? true) && (c.kind !== "move" || variant.run === P.today || variant.run === P.flattened)).map(async (c): Promise<Row> => {
        const head = { variant: variant.name, set: variant.set, case: c.id, round, source: c.source, page: c.page, kind: c.kind, want: c.want, n: c.screen.elements.length };
        try {
          const g = await variant.run(c.task, c.screen, c.want, { ask, hand: HAND, ...variant.ctx, ...(variant.wording ? { wording: variant.wording(c.task) } : {}) });
          return { ...head, pick: g.pick, input: g.input, action: g.action, confidence: g.confidence, prob: g.prob, ranked: g.ranked.slice(0, 8), checks: g.checks, ...judge(c, g, variant), ...g.meter, ms: Math.round(g.meter.ms), note: g.note };
        } catch (error) {
          return { ...head, pick: "error", input: null, action: null, confidence: 0, prob: 0, ranked: [], ok: false, okField: false, okInput: false, top3: false, okAction: null, reachable: true, rounds: 1, requests: 1, ms: 0, tokens: 0, error: error instanceof Error ? error.message : String(error) };
        }
      }));
      rows.push(...done);
      const scored = done.filter((r) => r.kind !== "move");
      console.log(`${variant.name.padEnd(26)} round ${round}: ${scored.filter((r) => r.ok).length}/${scored.length} right, ${done.filter((r) => r.error).length} errors, ${Math.round((performance.now() - started) / 1000)} s`);
      if (opts.verbose) for (const r of done.filter((r) => !r.ok && r.kind !== "move")) console.log(`    ${r.case}: picked ${r.pick}${r.input ? `/${r.input}` : ""} (${r.confidence.toFixed(2)}) ${r.error ?? ""}`);
      await save();
    }
  }
  await mkdir(join(import.meta.dir, "..", "out"), { recursive: true });
  await Bun.write(OUT, JSON.stringify({ at: new Date().toISOString(), model: process.env.JEV_MODEL ?? "jev-latest", cases: cases.length, rows }, null, 1));
  console.log(`${stats.asked} Jev requests sent, ${stats.cached} answered from the cache. Wrote ${OUT}\n`);
  await report();
}

// ---------------------------------------------------------------- report

const pct = (hits: number, of: number) => (of ? `${Math.round((100 * hits) / of)}%`.padStart(4) : "   -");
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function table(title: string, head: string[], lines: string[][]) {
  const width = head.map((h, i) => Math.max(h.length, ...lines.map((l) => (l[i] ?? "").length)));
  console.log(`\n${title}`);
  for (const line of [head, ...lines]) console.log(line.map((cell, i) => (i === 0 ? cell.padEnd(width[i]!) : cell.padStart(width[i]!))).join("  "));
}

/** The presenter the calibration, the failure list and the derived rows are about. */
const BEST = "bare_ids";

/** Choice and Nouls are independent questions and fit one request, so their combinations are computed here, from the two runs. */
function derived(rows: Row[], cases: Map<string, Case>): Row[] {
  const out: Row[] = [], noulsOf = new Map(rows.filter((r) => r.variant === "per_element_nouls").map((r) => [`${r.case}:${r.round}`, r]));
  for (const r of rows.filter((x) => x.variant === BEST)) {
    const n = noulsOf.get(`${r.case}:${r.round}`), c = cases.get(r.case);
    if (!n || !c) continue;
    const noulOf = new Map(n.ranked), top5 = r.ranked.filter(([id]) => id !== NONE).slice(0, 5).map(([id]) => [id, noulOf.get(id) ?? 0] as [string, number]).sort((a, b) => b[1] - a[1]);
    const focused = c.screen.elements.find((el) => el.focused)?.id, hit = (id: string) => c.gold.includes(id) || (id === FOCUSED_FIELD && !!focused && c.gold.includes(focused));
    const make = (variant: string, pick: string, confidence: number): Row => ({ ...r, variant, set: "derived", pick, confidence, prob: confidence, okField: hit(pick), ok: hit(pick) && r.okInput, tokens: r.tokens + n.tokens, ms: Math.max(r.ms, n.ms), note: undefined });
    // Re-rank: the Choice proposes five, the per-element Nouls (absolute) pick among them; all five low means nothing fits.
    const best = top5[0];
    out.push(make(`${BEST}_top5_x_nouls`, r.pick === NONE || !best || best[1] < 0.3 ? NONE : best[0], best?.[1] ?? 0));
    // Veto: keep the Choice's pick, but its own Noul has to agree.
    out.push(make(`${BEST}+element_noul>=0.3`, r.pick !== NONE && r.pick !== FOCUSED_FIELD && (noulOf.get(r.pick) ?? 0) < 0.3 ? NONE : r.pick, r.confidence));
  }
  return out;
}

async function report() {
  const { rows: stored } = (await Bun.file(OUT).json()) as { rows: Row[] };
  const cases = new Map((await allCases()).map((c) => [c.id, c]));
  // Judged again against the labels as they are now: fixing a gold label costs no requests.
  const current = stored.filter((r) => cases.has(r.case)).map((r) => (r.error ? r : { ...r, ...judge(cases.get(r.case)!, r, { name: r.variant }) }));
  const rows = [...current, ...derived(current, cases)];
  const names = [...new Set(rows.map((r) => r.variant))];
  const of = (name: string) => rows.filter((r) => r.variant === name && r.kind !== "move");
  const acc = (rs: Row[]) => pct(rs.filter((r) => r.ok).length, rs.length);

  table("Grounding: top-1 accuracy by split (all rounds pooled). n = decisions. 'none' = the right element is NOT on screen.",
    ["variant", "n", "all", "sim", "real", "click", "type", "none", ">250 el", "top-3", "rounds", "req", "med ms", "tokens"],
    names.map((name) => { const rs = of(name); return [name, String(rs.length), acc(rs), acc(rs.filter((r) => r.source === "sim")), acc(rs.filter((r) => r.source === "real")), acc(rs.filter((r) => r.kind === "click")), acc(rs.filter((r) => r.kind === "type")),
      acc(rs.filter((r) => r.kind === "none")), acc(rs.filter((r) => r.n > 250)), pct(rs.filter((r) => r.top3).length, rs.length), mean(rs.map((r) => r.rounds)).toFixed(1), mean(rs.map((r) => r.requests)).toFixed(1), String(median(rs.map((r) => r.ms))), String(Math.round(mean(rs.map((r) => r.tokens))))]; }));

  const big = rows.filter((r) => r.n > 250 && r.kind !== "move" && ["criteria_only", "bare_ids", "wording_direct", "pruned_30_bare_ids", "chunks_parallel", "grouped_within", "grouped_chunk20", "pruned_30", "today"].includes(r.variant));
  table("Dense pages only (more than 250 elements: github, mdn, craigslist, arxiv, wikipedia).", ["variant", "n", "all", "positive", "none", "med ms", "tokens"],
    [...new Set(big.map((r) => r.variant))].map((name) => { const rs = big.filter((r) => r.variant === name); return [name, String(rs.length), acc(rs), acc(rs.filter((r) => r.kind !== "none")), acc(rs.filter((r) => r.kind === "none")), String(median(rs.map((r) => r.ms))), String(Math.round(mean(rs.map((r) => r.tokens))))]; }));

  const todayRows = of("today");
  console.log(`\ntoday: observe.ts reads at most 150 elements, so the gold element was out of reach in ${todayRows.filter((r) => !r.reachable).length} of ${todayRows.length} decisions; on the rest it was right ${acc(todayRows.filter((r) => r.reachable))}.`);

  // The prefilter alone: did the gold element survive?
  for (const k of [15, 30, 60]) {
    const positive = [...cases.values()].filter((c) => c.kind === "click" || c.kind === "type");
    const kept = positive.filter((c) => { const survivors = new Set(prefilter(c.task, c.screen.elements, k).map((el) => el.id)); return c.gold.some((id) => survivors.has(id)); });
    const real = positive.filter((c) => c.source === "real");
    console.log(`prefilter recall, K=${k}: ${pct(kept.length, positive.length)} of ${positive.length} positive cases (sim ${pct(kept.filter((c) => c.source === "sim").length, positive.length - real.length)}, real ${pct(kept.filter((c) => c.source === "real").length, real.length)}). Lost: ${positive.filter((c) => !kept.includes(c)).map((c) => c.id).join(", ") || "none"}`);
  }

  const acting = names.filter((name) => rows.some((r) => r.variant === name && r.okAction !== null));
  table("Whole actions (move + arguments), every case including the ones where the right move is a key, or stopping.", ["variant", "n", "action right", "click", "type", "none", "move"],
    acting.map((name) => { const rs = rows.filter((r) => r.variant === name && r.okAction !== null), a = (x: Row[]) => pct(x.filter((r) => r.okAction).length, x.length);
      return [name, String(rs.length), a(rs), a(rs.filter((r) => r.kind === "click")), a(rs.filter((r) => r.kind === "type")), a(rs.filter((r) => r.kind === "none")), a(rs.filter((r) => r.kind === "move"))]; }));

  const twice = names.map((name) => { const byCase = new Map<string, Set<string>>(); for (const r of of(name)) byCase.set(r.case, (byCase.get(r.case) ?? new Set()).add(`${r.pick}/${r.input}`)); const multi = [...byCase.values()]; return { name, same: multi.filter((s) => s.size === 1).length, total: multi.length, rounds: Math.max(0, ...of(name).map((r) => r.round)) }; }).filter((t) => t.rounds > 1);
  console.log(`\nConsistency across rounds (same pick every round): ${twice.map((t) => `${t.name} ${t.same}/${t.total}`).join(", ") || "one round only"}`);

  for (const name of ["wording_direct", BEST, "criteria_only", "flattened_actions", "today"].filter((n) => names.includes(n))) {
    for (const want of ["click", "field"] as const) {
      const rs = of(name).filter((r) => r.want === want && !r.error);
      if (!rs.length) continue;
      const buckets = [[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.01]] as const;
      table(`Calibration, ${name}, "${want}" questions (${rs.length} decisions): confidence vs being right`, ["confidence", "n", "right"],
        buckets.map(([lo, hi]) => { const b = rs.filter((r) => r.confidence >= lo && r.confidence < hi); return [`${lo.toFixed(1)}-${Math.min(hi, 1).toFixed(1)}`, String(b.length), acc(b)]; }));
      // Saying "none" escalates by itself. What a threshold adds is catching wrong ELEMENT picks.
      const picks = rs.filter((r) => r.pick !== NONE), wrong = picks.filter((r) => !r.ok), right = picks.filter((r) => r.ok), ghost = wrong.filter((r) => r.kind === "none").length;
      const rules: [string, (r: Row, x: number) => boolean][] = [["confidence >= X", (r, x) => r.confidence >= x]];
      if (want === "click" && rs.some((r) => r.checks)) rules.push(["confidence >= X and the `named` Noul >= 0.5", (r, x) => r.confidence >= x && (r.checks?.named ?? 1) >= 0.5]);
      for (const [rule, acts] of rules) {
        table(`Act when ${rule}, else escalate. ${name}, "${want}": ${picks.length} element picks, ${wrong.length} wrong (${ghost} of them on a screen that did not have the element); ${rs.length - picks.length} said none_of_these.`,
          ["X", "wrong picks caught", "right picks escalated", "wrong clicks left", "of all decisions", "escalated in total"],
          [0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95].map((x) => { const left = wrong.filter((r) => acts(r, x)).length, held = right.filter((r) => !acts(r, x)).length;
            return [x.toFixed(2), `${wrong.length - left}/${wrong.length}`, `${held}/${right.length} (${pct(held, right.length).trim()})`, String(left), pct(left, rs.length), pct(rs.length - picks.filter((r) => acts(r, x)).length, rs.length)]; }));
      }
    }
  }

  for (const name of ["wording_direct", BEST]) {
    const checked = of(name).filter((r) => r.checks && r.round === 1);
    if (!checked.length) continue;
    const present = checked.filter((r) => r.kind !== "none"), absent = checked.filter((r) => r.kind === "none");
    table(`Presence Nouls asked next to the ${name} Choice (round 1): mean answer when the element is on screen (${present.length}) and when it is not (${absent.length}).`, ["noul", "present", "absent", "present >= 0.5", "absent < 0.5"],
      Object.keys(checked[0]!.checks!).map((k) => [k, mean(present.map((r) => r.checks![k]!)).toFixed(2), mean(absent.map((r) => r.checks![k]!)).toFixed(2), pct(present.filter((r) => r.checks![k]! >= 0.5).length, present.length), pct(absent.filter((r) => r.checks![k]! < 0.5).length, absent.length)]));
  }

  const hardTags = [...new Set([...cases.values()].flatMap((c) => c.hard))].sort();
  const compare = names.filter((n) => !/x_nouls|element_noul|chunks_parallel|chunk20|pruned_15/.test(n));
  table("Accuracy by what makes a case hard (round 1).", ["variant", ...hardTags],
    compare.map((name) => [name, ...hardTags.map((tag) => { const rs = of(name).filter((r) => r.round === 1 && cases.get(r.case)!.hard.includes(tag)); return `${rs.filter((r) => r.ok).length}/${rs.length}`; })]));

  for (const name of ["wording_direct", BEST].filter((n) => names.includes(n))) {
  console.log(`\nWhat ${name} got wrong (round 1):`);
  for (const r of of(name).filter((r) => r.round === 1 && !r.ok)) {
    const c = cases.get(r.case)!, words = labelsFor(c.screen.elements, HAND), say = (id: string) => (id === NONE || id === FOCUSED_FIELD || id === "error" ? id : `${id} ${words[id] ?? "?"}`);
    console.log(`  ${r.case} [${r.n} el] "${c.task.goal}"\n      picked ${say(r.pick)}${r.input ? ` / input ${r.input}` : ""} (conf ${r.confidence.toFixed(2)})\n      gold   ${c.gold.slice(0, 2).map(say).join(" | ")}${c.goldInput ? ` / input ${c.goldInput}` : ""}${r.error ? `\n      ${r.error}` : ""}`);
  }
  }
}

// ---------------------------------------------------------------- CLI

if (import.meta.main) {
  const argv = process.argv.slice(2), cmd = argv.find((a) => !a.startsWith("--")), flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const list = (name: string) => flag(name)?.split(",").filter(Boolean) ?? [];
  if (cmd === "fetch") await fetchFixtures(argv.filter((a) => !a.startsWith("--")).slice(1));
  else if (cmd === "list") { const s = await realScreen(argv[1]!); for (const el of s.elements) console.log(`${el.id}\t${describe(el, HAND)}\t${el.icon ? "ICON " : ""}${el.href ?? ""}${el.row ? `\trow=${el.row.slice(0, 80)}` : ""}`); }
  else if (cmd === "cases") {
    for (const c of await allCases()) {
      const words = labelsFor(c.screen.elements, HAND);
      console.log(`${c.id}  [${c.source} ${c.page}, ${c.screen.elements.length} elements, ${c.kind}${c.hard.length ? `, ${c.hard.join("+")}` : ""}]\n    goal: ${c.task.goal}${Object.keys(c.task.inputs).length ? `\n    inputs: ${JSON.stringify(c.task.inputs)}` : ""}`);
      for (const id of c.gold) console.log(`    gold: ${id === NONE ? NONE : `${id} ${words[id]}`}${c.goldInput ? `  <- ${c.goldInput}` : ""}`);
      if (c.kind === "move" || c.goldActions.some((a) => !/^(click|type)_/.test(a))) console.log(`    gold actions: ${c.goldActions.join(", ")}`);
    }
  } else if (cmd === "report") await report();
  else await run({ sets: list("set").length ? list("set") : ["main"], names: list("variant"), only: list("only"), rounds: flag("rounds") ? Number(flag("rounds")) : null, fresh: argv.includes("--fresh"), verbose: argv.includes("--verbose"), base: (flag("base") ?? "bareIds") as keyof typeof PRESENTERS });
}
