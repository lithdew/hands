// recipes.ts — Jev builds the whole Intent for everyday tasks, with no language model.
//
// intent.ts asks an LLM (about two seconds) for anything quick.ts cannot do, and
// quick.ts can only open a site and search it. Most spoken tasks are one of a few
// shapes, and every part of those shapes is something Jev can pick:
//
//   the task      one of RECIPES                              choice
//   who           one of the user's contacts                  choice
//   when, how many  a day word, a clock time, a party size    choice (the date is computed in code)
//   what to type  a literal run of what was said              two choices: first word, last word
//
// All of it is asked in ONE request, for every recipe at once (speculative
// fan-out: questions are answered in parallel, so the ones that turn out not to
// matter cost nothing). Code reads the answers for the recipe Jev chose.
//
//   recipeIntent(ask, "book a table at a steakhouse for two tomorrow at 7", ctx)
//     -> { recipe: "book_table", intent, deepLink: "https://www.opentable.com/s?term=steakhouse&covers=2&dateTime=2026-09-20T19:00" }
//
// `deepLink` opens the site with the form already filled, where the site has
// such a url. `intent.url` is the site's front page, for when it does not.
// Returns null when the request is not one of these: the caller falls back to
// quick.ts, then intent.ts.

import type { Intent } from "./intent";
import { choice, noul, type Ask } from "./jev";

// ---------------------------------------------------------------- types

export type RecipeName = "send_email" | "book_table" | "make_note" | "send_text";
export type Contact = { name: string; email?: string };
export type RecipeContext = { today: Date; contacts: readonly Contact[] };
export type Built = {
  recipe: RecipeName;
  intent: Intent;
  /** A url that starts the task with its form filled in, or null. */
  deepLink: string | null;
  /** Lowest confidence among the picks that were used. */
  confidence: number;
};

// ---------------------------------------------------------------- config

const MIN_CONFIDENCE = 0.5;
const OTHER = "other", NOT_SAID = "not_said", NOT_LISTED = "not_in_list";
const MAX_WORDS = 120;

const RECIPES = {
  send_email: "Write and send an email to someone.",
  book_table: "Reserve a table at a restaurant.",
  make_note: "Write something down for the speaker's own use: a note, a memo, a reminder to self.",
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

// ---------------------------------------------------------------- spans

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

// ---------------------------------------------------------------- build

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
  /** `said` only opens or searches one site. The one case quick.ts may be trusted with. */
  simple: number;
};

export async function recipeIntent(ask: Ask, said: string, ctx: RecipeContext): Promise<Built | null> {
  return (await readRequest(ask, said, ctx)).built;
}

export async function readRequest(ask: Ask, said: string, ctx: RecipeContext): Promise<Reading> {
  const request = said.trim(), words = request.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  if (words.length < 2) return { task: OTHER, built: null, more: 0, twoTasks: 0, simple: 0 };
  // Jev reads literally: "Sam" is not "Sam Rivera" unless the criteria say a first name is enough.
  const firstNames = ctx.contacts.map((c) => c.name.split(/\s+/)[0]!.toLowerCase());
  const people = Object.fromEntries(ctx.contacts.map((c, i) => {
    const first = c.name.split(/\s+/)[0]!, shared = firstNames.filter((f) => f === firstNames[i]).length > 1;
    return [c.name, first === c.name ? `Called "${c.name}" in \`request\`.` : `Called "${c.name}"${shared ? "" : ` or just "${first}"`} in \`request\`.`];
  }));

  const message = spanQuestions(words, "what the message should say or be about", 'Words that only give the order ("email Sam", "tell her", "say", "saying", "to remind him about") come before it and are not part of it.');
  const note = spanQuestions(words, "the content to write down in the note", 'Words that only give the order ("make a note for", "write down that", "note that") come before it and are not part of it.');
  const place = spanQuestions(words, "the name of the restaurant, or the kind of food or restaurant wanted", "Give only the name or the kind, without the party size, the day or the time.");

  const a = await ask({ request }, {
    task: choice("What is `request` asking the worker to do?", RECIPES),
    person: choice("Who is the email or text message in `request` for? A first name or a nickname is enough to pick a contact.", { ...people, [NOT_LISTED]: "`request` names a person, and no contact above has that name.", [NOT_SAID]: "`request` names no person." }),
    wording: choice("How does `request` say what the message should contain?", WORDING),
    message_from: message.from, message_to: message.to,
    note_from: note.from, note_to: note.to,
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
    simple: noul("`request` only asks to open one website, or to search one website for something, and nothing else.", {
      true: "A website is opened or searched, and that is all.", false: "Anything else, including opening or using an application on the computer (Calculator, Paint, Notepad), and making, writing or drawing something." }),
  });
  const built = build(words, a, ctx);
  const overflow: Record<RecipeName, number[]> = {
    send_email: [a.two_tasks.noul, a.two_people.noul, a.attachment.noul], send_text: [a.two_tasks.noul, a.two_people.noul, a.attachment.noul],
    book_table: [a.two_tasks.noul, a.table_wish.noul], make_note: [a.two_tasks.noul, a.note_title.noul],
  };
  const more = built ? Math.max(...overflow[built.recipe]) : a.two_tasks.noul;
  return { task: a.task.choice, built: more < 0.5 ? built : null, more, twoTasks: a.two_tasks.noul, simple: a.simple.noul };
}

type RecipeAnswers = Record<"person" | "wording" | "party" | "day" | "time", { choice: string; confidence: number }> & Record<"task", { choice: RecipeName | typeof OTHER; confidence: number }>
  & Record<"message_from" | "message_to" | "note_from" | "note_to" | "place_from" | "place_to", Edge>;

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
      goal: `Save a new note that says: ${text.text}`, launcher: "browser", url: "https://keep.google.com/", inputs: { note: sentence(text.text) },
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
      launcher: "browser", url: "https://www.opentable.com/", inputs: { restaurant_or_cuisine: where.text },
      facts: [`party size: ${party} ${party === 1 ? "person" : "people"}`, `date: ${spoken}`, `time: ${time}`],
      doneWhen: "The screen says the reservation is confirmed.", avoid: ["restaurants marked Promoted that are not what was asked for", "optional fields such as special requests or occasions"] } };
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
      launcher: "browser", url: "https://messages.google.com/web", inputs,
      doneWhen: `The conversation with ${contact.name} shows the new message as sent.`, avoid: ["conversations with other people"] } };
  }

  if (!contact.email || !said_) return null; // an email with no address, or one that must be composed, is the LLM's
  const subject = wording === "reminder" ? `Reminder: ${said_.text}` : sentence(said_.text.split(/\s+/).slice(0, 8).join(" ")).replace(/\.$/, "");
  const body = wording === "reminder" ? `Hi ${first},\n\nJust a reminder about ${said_.text}.\n\nThanks!` : `Hi ${first},\n\n${sentence(said_.text)}\n\nThanks!`;
  return { recipe, confidence: Math.min(...sure), deepLink: `https://mail.google.com/mail/?${new URLSearchParams({ view: "cm", fs: "1", to: contact.email, su: subject, body })}`, intent: {
    goal: `Send an email to ${contact.name} (${contact.email}) with the prepared subject and body.`, launcher: "browser", url: "https://mail.google.com/",
    inputs: { recipient: contact.email, subject, body }, doneWhen: "The screen says the message was sent.", avoid: [] } };
}
