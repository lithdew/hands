/**
 * Jev builds the whole Intent for an everyday task, with no language model.
 *
 * Most spoken tasks are one of a few shapes, and every part of those shapes is something Jev can pick:
 *
 *   the task        one of RECIPES                             choice
 *   who             one of the user's contacts                 choice
 *   when, how many  a day word, a clock time, a party size     choice (the date is computed in code)
 *   what to type    a literal run of what was said             two choices: first word, last word
 *
 * All of it is asked in ONE request, for every recipe at once: questions are answered side by side, so the ones
 * that turn out not to matter cost nothing. Code reads the answers for the recipe Jev chose.
 *
 *   readRequest(ask, "book a table at a steakhouse for two tomorrow at 7", ctx)
 *     -> built: { recipe: "book_table", intent, deepLink: "https://www.opentable.com/s?term=steakhouse&covers=2&dateTime=..." }
 *
 * `deepLink` opens the site with the form already filled, where the site has such a url. `built` is null when the
 * request is not one of these, or asks for more than a recipe's slots can carry: the caller goes on to plan.ts.
 */

import { type Ask, choice, noul } from "./ask.ts";
import type { Intent } from "./intent.ts";

// ------------------------------------------------------------------ types

export type RecipeName = "send_email" | "find_email" | "book_table" | "make_note" | "send_text";
export type Contact = { name: string; email?: string };
/** What the hand's browser shows right now. A request may continue from it ("reply to that email"). */
export type Here = { url: string; title: string };
export type RecipeContext = { today: Date; contacts: readonly Contact[]; here?: Here | null };
export type Built = {
  recipe: RecipeName;
  intent: Intent;
  /** A url that starts the task with its form filled in, or null. */
  deepLink: string | null;
  /** Lowest confidence among the picks that were used. */
  confidence: number;
};

// ------------------------------------------------------------------ config

const MIN_CONFIDENCE = 0.5;
const OTHER = "other", NOT_SAID = "not_said", NOT_LISTED = "not_in_list";
const MAX_WORDS = 120;
const GMAIL = "https://mail.google.com/mail/";

const RECIPES = {
  send_email: "Write and send an email to someone.",
  book_table: "Reserve a table at a restaurant.",
  make_note: "Write something down for the speaker's own use: a note, a memo, a reminder to self.",
  find_email: "Find, look up, search for, open or read an email that was received: one that someone sent to the user.",
  send_text: "Send a text message (SMS or chat) to someone, or answer a text message they sent.",
  [OTHER]: "Anything else: a web search, opening a site or an app, a question, or more than one of these tasks at once.",
} as const;

const WORDING = {
  verbatim: "The speaker said the message's own words, usually after 'say', 'saying', 'tell her', 'tell him', 'that'.",
  reminder: "The speaker asks to remind the person about something, and names the thing.",
  open: "The speaker did not say what the message should say. It has to be written, for example as an answer to what the other person wrote.",
} as const;

const DAY_WORDS = ["today", "tomorrow", "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** Restaurants take bookings from late morning to late evening, so "at 7" can only mean the evening. */
const TABLE_TIMES = Array.from({ length: 24 }, (_, i) => 11 * 60 + i * 30);

const clock = (m: number) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${m >= 720 ? "PM" : "AM"}`;
const pad = (n: number) => String(n).padStart(2, "0");

// ------------------------------------------------------------------ spans

/** Two Choice questions that mark a literal run of `words`. Jev cannot write, but it can point. */
function spanQuestions(words: string[], what: string, before: string) {
  const around = (i: number) => `"${words[i]}" in: ${words.slice(Math.max(0, i - 2), i).join(" ")} [${words[i]}] ${words.slice(i + 1, i + 3).join(" ")}`.trim();
  const labels = Object.fromEntries(words.map((_, i) => [`w${i + 1}`, around(i)]));
  return {
    from: choice(`Part of \`request\` is ${what}. Which word is the FIRST word of that part? ${before}`, labels),
    to: choice(`Part of \`request\` is ${what}. Which word is the LAST word of that part?`, labels),
  };
}

type Edge = { choice: string; confidence: number; probabilities: Record<string, number> };

/**
 * An edge that is torn between two neighbouring words ("the" or "meeting"?) is not an
 * unsure edge: either reading is a fine span. So an edge's confidence is the
 * probability of the chosen word together with the words next to it.
 */
function edgeConfidence(edge: Edge): number {
  const i = Number(edge.choice.slice(1));
  return Math.min(1, [i - 1, i, i + 1].reduce((sum, k) => sum + (edge.probabilities[`w${k}`] ?? 0), 0));
}

function spanOf(words: string[], from: Edge, to: Edge, withArticle = false): { text: string; confidence: number } | null {
  let i = Number(from.choice.slice(1)) - 1;
  const j = Number(to.choice.slice(1)) - 1;
  if (!(i >= 0 && j >= i && j < words.length)) return null;
  if (withArticle && i > 0 && /^(the|a|an|our)$/i.test(words[i - 1]!)) i--; // "about the [meeting": the article belongs to the span
  const text = words.slice(i, j + 1).join(" ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.!?)]+$/gu, "");
  return text ? { text, confidence: Math.min(edgeConfidence(from), edgeConfidence(to)) } : null;
}

const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".") : s);

// ------------------------------------------------------------------ build

/** The next date that is `day`, counting from `today`. Dates are arithmetic, so they are code's job, not Jev's. */
export function dateFor(day: (typeof DAY_WORDS)[number], today: Date): Date {
  const at = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n, 12);
  if (day === "today") return at(0);
  if (day === "tomorrow") return at(1);
  const ahead = (DAY_WORDS.indexOf(day) - 2 - today.getDay() + 7) % 7;
  return at(ahead === 0 ? 7 : ahead);
}

/** What one request told us about `said`: the recipe Jev chose, the intent if one could be built, and two guards. */
export type Reading = {
  task: RecipeName | typeof OTHER;
  built: Built | null;
  /** `said` asks for more than the recipe's slots can carry: a second person, an extra wish, a second task. */
  more: number;
  /** `said` is two or more separate tasks. */
  twoTasks: number;
  /** `said` carries on with what the hand already has open ("that email", "reply to it"). Such a task must not start by going somewhere else. */
  continues: number;
  /** `said` only opens or searches one site. The one case quick.ts may be trusted with. */
  simple: number;
};

export async function readRequest(ask: Ask, said: string, ctx: RecipeContext): Promise<Reading> {
  const request = said.trim(), words = request.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  if (words.length < 2) return { task: OTHER, built: null, more: 0, twoTasks: 0, continues: 0, simple: 0 };
  // Jev reads literally: "Sam" is not "Sam Rivera" unless the criteria say a first name is enough.
  const firstNames = ctx.contacts.map((c) => c.name.split(/\s+/)[0]!.toLowerCase());
  const people = Object.fromEntries(ctx.contacts.map((c, i) => {
    const first = c.name.split(/\s+/)[0]!, shared = firstNames.filter((f) => f === firstNames[i]).length > 1;
    return [c.name, first === c.name ? `Called "${c.name}" in \`request\`.` : `Called "${c.name}"${shared ? "" : ` or just "${first}"`} in \`request\`.`];
  }));

  const message = spanQuestions(words, "what the message should say or be about", 'Words that only give the order ("email Sam", "tell her", "say", "saying", "to remind him about") come before it and are not part of it.');
  const note = spanQuestions(words, "the content to write down in the note", 'Words that only give the order ("make a note for", "write down that", "note that") come before it and are not part of it.');
  const sender = spanQuestions(words, "the name of the person or sender whose email is wanted", 'Only the name. Words such as "the email from" and "sent to" are not part of it.');
  const topic = spanQuestions(words, "what the wanted email is about: its subject or topic", "The sender's name is not part of it.");
  const place = spanQuestions(words, "the name of the restaurant, or the kind of food or restaurant wanted", "Give only the name or the kind, without the party size, the day or the time.");

  const a = await ask({ request, ...(ctx.here ? { on_screen: ctx.here.title.slice(0, 160) } : {}) }, {
    task: choice("What is `request` asking the worker to do?", RECIPES),
    person: choice("Who is the email or text message in `request` for? A first name or a nickname is enough to pick a contact.", { ...people, [NOT_LISTED]: "`request` names a person, and no contact above has that name.", [NOT_SAID]: "`request` names no person." }),
    wording: choice("How does `request` say what the message should contain?", WORDING),
    message_from: message.from, message_to: message.to,
    note_from: note.from, note_to: note.to,
    sender_from: sender.from, sender_to: sender.to, topic_from: topic.from, topic_to: topic.to,
    has_topic: noul("`request` says what the wanted email is about: a subject or a topic. Who sent it does not count."),
    place_from: place.from, place_to: place.to,
    party: choice("For how many people is the table in `request`?", { ...Object.fromEntries(NUMBER_WORDS.map((w, i) => [String(i + 1), `${w} ${i ? "people" : "person"}`])), [NOT_SAID]: "`request` does not say how many people." }),
    day: choice("On which day is the table in `request` wanted?", { ...Object.fromEntries(DAY_WORDS.map((d) => [d, null])), [NOT_SAID]: "`request` does not name a day." }),
    time: choice("At what time is the table in `request` wanted?", { ...Object.fromEntries(TABLE_TIMES.map((m) => [clock(m), null])), [NOT_SAID]: "`request` does not name a time." }),
    // A recipe carries only its own slots. What it cannot carry has to go to a planner, not be dropped.
    // One plain positive question per way of overflowing: Jev reads a long "anything but these" badly.
    two_tasks: noul("`request` asks for two or more separate tasks, such as sending a message AND making a note, or emailing AND booking."),
    two_people: noul("`request` names two or more different people who should all get the message."),
    attachment: noul("`request` tells the worker to attach a file, a photo or a document to the message, or to forward something.", {
      true: "The worker itself has to find and attach or forward something.", false: "Nothing has to be attached. A message that only talks about slides, a deck, an invoice or a file counts as false." }),
    table_wish: noul("`request` says something about the restaurant visit besides the restaurant or kind of food, the number of people, the day and the time: an occasion such as a birthday or anniversary, where to sit, a special request."),
    note_title: noul("`request` gives the note a title or a name, separately from what the note says."),
    continues: noul(ctx.here
      ? "`request` is about the very thing `on_screen` already shows: it says 'this', 'that', 'it', 'the email', 'the one I just found', or asks to reply to, open, forward or continue with what is open, without saying where to find it."
      : "`request` points at something that is already open on a screen, with words like 'this', 'that email', 'reply to it'."),
    simple: noul("`request` only asks to open one website, or to search one website for something, and nothing else.", {
      true: "A website is opened or searched, and that is all.", false: "Anything else, including opening or using an application on the computer (Calculator, Paint, Notepad), and making, writing or drawing something." }),
  });
  const built = build(words, a, ctx);
  const overflow: Record<RecipeName, number[]> = {
    send_email: [a.two_tasks.noul, a.two_people.noul, a.attachment.noul], send_text: [a.two_tasks.noul, a.two_people.noul, a.attachment.noul],
    book_table: [a.two_tasks.noul, a.table_wish.noul], make_note: [a.two_tasks.noul, a.note_title.noul], find_email: [a.two_tasks.noul],
  };
  const more = built ? Math.max(...overflow[built.recipe]) : a.two_tasks.noul;
  // A recipe starts from its own link. A request that carries on from the open page has to be planned from that page instead.
  const continues = ctx.here ? a.continues.noul : 0;
  return { task: a.task.choice, built: more < 0.5 && continues < 0.6 ? built : null, more, twoTasks: a.two_tasks.noul, continues, simple: a.simple.noul };
}

type RecipeAnswers = Record<"person" | "wording" | "party" | "day" | "time", { choice: string; confidence: number }> & Record<"task", { choice: RecipeName | typeof OTHER; confidence: number }>
  & Record<"message_from" | "message_to" | "note_from" | "note_to" | "place_from" | "place_to" | "sender_from" | "sender_to" | "topic_from" | "topic_to", Edge> & Record<"has_topic", { noul: number }>;

function build(words: string[], a: RecipeAnswers, ctx: RecipeContext): Built | null {
  const recipe = a.task.choice;
  if (recipe === OTHER || a.task.confidence < MIN_CONFIDENCE) return null;
  const sure = [a.task.confidence];
  const used = <T extends { confidence: number }>(answer: T) => (sure.push(answer.confidence), answer);

  if (recipe === "make_note") {
    const text = spanOf(words, a.note_from, a.note_to);
    if (!text || text.confidence < MIN_CONFIDENCE) return null;
    sure.push(text.confidence);
    return { recipe, deepLink: null, confidence: Math.min(...sure), intent: {
      goal: `Save a new note that says: ${text.text}`, url: "https://keep.google.com/", inputs: { note: sentence(text.text) },
      doneWhen: "The new note is saved: it shows in the list of notes and the note editor is closed.", avoid: [] } };
  }

  if (recipe === "book_table") {
    const where = spanOf(words, a.place_from, a.place_to);
    if (!where || where.confidence < MIN_CONFIDENCE) return null;
    sure.push(where.confidence);
    const party = a.party.choice !== NOT_SAID && used(a.party).confidence >= MIN_CONFIDENCE ? Number(a.party.choice) : 2;
    const day = a.day.choice !== NOT_SAID && used(a.day).confidence >= MIN_CONFIDENCE ? dateFor(a.day.choice as (typeof DAY_WORDS)[number], ctx.today) : dateFor("today", ctx.today);
    const time = a.time.choice !== NOT_SAID && used(a.time).confidence >= MIN_CONFIDENCE ? (a.time.choice as string) : "7:00 PM";
    const [, h, m, half] = /^(\d+):(\d+) (AM|PM)$/.exec(time)!;
    const iso = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${pad((Number(h) % 12) + (half === "PM" ? 12 : 0))}:${m}`;
    const spoken = day.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    return { recipe, confidence: Math.min(...sure), deepLink: `https://www.opentable.com/s?${new URLSearchParams({ term: where.text, covers: String(party), dateTime: iso })}`, intent: {
      goal: `Reserve a table at ${where.text}: party size ${party} people, date ${spoken}, time ${time}. Pick a restaurant that is ${where.text} and a time slot of exactly ${time}.`,
      url: "https://www.opentable.com/", inputs: { restaurant_or_cuisine: where.text },
      facts: [`party size: ${party} ${party === 1 ? "person" : "people"}`, `date: ${spoken}`, `time: ${time}`],
      doneWhen: "The screen says the reservation is confirmed.", avoid: ["restaurants marked Promoted that are not what was asked for", "optional fields such as special requests or occasions"] } };
  }

  if (recipe === "find_email") {
    const from = spanOf(words, a.sender_from, a.sender_to);
    if (!from || from.confidence < MIN_CONFIDENCE) return null;
    sure.push(from.confidence);
    const about = a.has_topic.noul >= 0.6 ? spanOf(words, a.topic_from, a.topic_to) : null;
    const query = `from:${/\s/.test(from.text) ? `(${from.text})` : from.text}${about && about.confidence >= MIN_CONFIDENCE ? ` ${about.text}` : ""}`;
    return { recipe, confidence: Math.min(...sure), deepLink: `${GMAIL}#search/${encodeURIComponent(query)}`, intent: {
      goal: `Search the mail for the email from ${from.text}${about ? ` about ${about.text}` : ""}, so that the matching emails are listed.`,
      url: GMAIL, inputs: { search_query: query },
      doneWhen: `The mail shows the search results for ${JSON.stringify(query)}: the matching emails, or a line saying none were found.`, avoid: ["changing the search to other words", "other accounts"] } };
  }

  // send_email, send_text
  const person = a.person.choice as string;
  // An address that was said out loud needs no contact. Finding it is a pattern, so it is code's job.
  const address = recipe === "send_email" ? words.map((w) => w.replace(/^[^\w]+|[^\w]+$/g, "")).find((w) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(w)) : undefined;
  const contact = ctx.contacts.find((c) => c.name === person) ?? (address ? { name: address.split("@")[0]!, email: address } : undefined);
  if (!contact || (!address && used(a.person).confidence < MIN_CONFIDENCE)) return null;
  const first = contact.name.split(/\s+/)[0]!;
  const wording = used(a.wording).choice;
  const said_ = wording === "open" ? null : spanOf(words, a.message_from, a.message_to, true);
  if (wording !== "open" && (!said_ || said_.confidence < MIN_CONFIDENCE)) return null;
  if (said_) sure.push(said_.confidence);

  if (recipe === "send_text") {
    const inputs: Record<string, string> = said_ ? { message: wording === "reminder" ? `Reminder: ${said_.text}` : sentence(said_.text).replace(/\.$/, "") } : {};
    return { recipe, deepLink: null, confidence: Math.min(...sure), intent: {
      goal: said_ ? `Send ${contact.name} this text message: ${inputs.message}` : `Read the latest text message from ${contact.name} and send ${contact.name} a fitting answer.`,
      url: "https://messages.google.com/web", inputs,
      doneWhen: `The conversation with ${contact.name} shows the new message as sent.`, avoid: ["conversations with other people"] } };
  }

  if (!contact.email || !said_) return null; // an email with no address, or one that must be composed, is the LLM's
  const subject = wording === "reminder" ? `Reminder: ${said_.text}` : sentence(said_.text.split(/\s+/).slice(0, 8).join(" ")).replace(/\.$/, "");
  const body = wording === "reminder" ? `Hi ${first},\n\nJust a reminder about ${said_.text}.\n\nThanks!` : `Hi ${first},\n\n${sentence(said_.text)}\n\nThanks!`;
  return { recipe, confidence: Math.min(...sure), deepLink: `${GMAIL}?${new URLSearchParams({ view: "cm", fs: "1", to: contact.email, su: subject, body })}`, intent: {
    goal: `Send an email to ${contact.name} (${contact.email}) with the prepared subject and body.`, url: GMAIL,
    inputs: { recipient: contact.email, subject, body }, doneWhen: "The screen says the message was sent.", avoid: [] } };
}
