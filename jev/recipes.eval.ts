// recipes.eval.ts — does recipes.ts build the right intent from many phrasings, and decline what is not its job?
//
//   bun jev/recipes.eval.ts [--verbose]
//
// One real Jev request per utterance, no LLM, no desktop. "Today" is Saturday 2026-09-19.
// A case passes when the recipe is right and every slot named in `want` came out right;
// `recipe: null` cases pass when recipeIntent hands the request back (returns null).

import { createJev } from "./jev";
import { recipeIntent, type RecipeName } from "./recipes";
import { CONTACTS, SIM_TODAY } from "./sim";

type Want = { recipe: RecipeName | null; to?: string; has?: RegExp[]; hasNot?: RegExp[]; link?: RegExp[]; noInputs?: boolean };
const CASES: [string, Want][] = [
  // email
  ["email Sam to remind him about the meeting tomorrow at 10", { recipe: "send_email", to: "sam.rivera@example.com", has: [/meeting tomorrow at 10/i], hasNot: [/remind him/i] }],
  ["send an email to Dana saying lunch on Thursday works for me", { recipe: "send_email", to: "dana.w@example.com", has: [/lunch on thursday works for me/i], hasNot: [/saying/i] }],
  ["shoot Priya an email that the slides are ready for review", { recipe: "send_email", to: "priya.n@example.com", has: [/slides are ready for review/i] }],
  ["can you email Jordan and tell him the invoice was paid this morning", { recipe: "send_email", to: "jordan.blake@example.com", has: [/invoice was paid this morning/i], hasNot: [/tell him/i] }],
  ["um email samantha to remind her about the offsite on friday", { recipe: "send_email", to: "samantha.lee@example.com", has: [/offsite on friday/i] }],
  ["write an email to alex chen saying I'll be ten minutes late to standup", { recipe: "send_email", to: "alex.chen@example.com", has: [/ten minutes late to standup/i] }],
  ["email Bob about the contract", { recipe: null }], // not a contact: no address to send to
  ["reply to Sam's email", { recipe: null }], // nothing said to write: the LLM's job
  // table
  ["book a table at a steakhouse for two tomorrow at 7", { recipe: "book_table", link: [/term=steakhouse/, /covers=2/, /2026-09-20T19%3A00/] }],
  ["get me a table for four at Sakura Sushi House on Friday at 8 pm", { recipe: "book_table", link: [/term=Sakura\+Sushi\+House/, /covers=4/, /2026-09-25T20%3A00/] }],
  ["reserve dinner for six at an italian place tonight at seven thirty", { recipe: "book_table", link: [/term=.*italian/i, /covers=6/, /2026-09-19T19%3A30/] }],
  ["I need a reservation at Keens Steakhouse monday at noon for three people", { recipe: "book_table", link: [/term=Keens\+Steakhouse/, /covers=3/, /2026-09-21T12%3A00/] }],
  ["find us a sushi spot for wednesday 6:30, there's five of us", { recipe: "book_table", link: [/term=sushi/i, /covers=5/, /2026-09-23T18%3A30/] }],
  ["book a table for two at a mexican restaurant", { recipe: "book_table", link: [/term=.*mexican/i, /covers=2/, /2026-09-19T19%3A00/] }], // no day, no time: defaults
  // note
  ["make a note for my doctor's appointment on Tuesday at 3pm", { recipe: "make_note", has: [/doctor's appointment on tuesday at 3pm/i] }],
  ["write down that the plumber is coming Thursday morning between eight and ten and I need to move the car", { recipe: "make_note", has: [/plumber is coming thursday morning between eight and ten and i need to move the car/i], hasNot: [/write down/i] }],
  ["note to self buy oat milk and eggs", { recipe: "make_note", has: [/buy oat milk and eggs/i] }],
  ["jot down the wifi password is bluefish42", { recipe: "make_note", has: [/wifi password is bluefish42/i] }],
  ["remind me to call the dentist", { recipe: "make_note", has: [/call the dentist/i] }],
  ["take a note the flight to lisbon leaves at 6 am from terminal two", { recipe: "make_note", has: [/flight to lisbon leaves at 6 am from terminal two/i] }],
  // text
  ["reply to mom's text and tell her I'll be there at six", { recipe: "send_text", to: "Mom", has: [/^I'll be there at six$/i] }],
  ["text Alex and say yes I can send the deck in an hour", { recipe: "send_text", to: "Alex Chen", has: [/^yes I can send the deck in an hour$/i] }],
  ["answer Alex's text", { recipe: "send_text", to: "Alex Chen", noInputs: true }],
  ["message priya that I'm running late", { recipe: "send_text", to: "Priya Natarajan", has: [/I'm running late/i], hasNot: [/that I'm/i] }],
  ["text my mom happy birthday", { recipe: "send_text", to: "Mom", has: [/^happy birthday$/i] }],
  ["respond to the text from jordan", { recipe: "send_text", to: "Jordan Blake", noInputs: true }],
  ["send dana a text saying see you at the gym at five", { recipe: "send_text", to: "Dana Whitfield", has: [/^see you at the gym at five$/i] }],
  // more than a recipe can carry: these must go to the planner, not lose the extra part
  ["book a table for two at Keens Steakhouse tomorrow at 7, it's our anniversary, and ask for a quiet corner table", { recipe: null }],
  ["email Sam and Dana that the offsite moved to Friday", { recipe: null }],
  ["add a note titled Lisbon trip that says book the airport transfer and renew my passport", { recipe: null }],
  ["text mom I'll be there at six and then make a note to buy flowers", { recipe: null }],
  ["email Priya the slides are ready and attach the deck from my downloads folder", { recipe: null }],
  ["email jo@acme.io saying the contract is signed", { recipe: "send_email", to: "jo@acme.io", has: [/contract is signed/i] }],
  // not ours
  ["search wikipedia for capybaras", { recipe: null }],
  ["open youtube", { recipe: null }],
  ["what's the weather in tokyo tomorrow", { recipe: null }],
  ["email Sam about the meeting and then book a table for two at a steakhouse", { recipe: null }],
  ["how many unread emails do I have", { recipe: null }],
  ["play some jazz on spotify", { recipe: null }],
  ["um so I was thinking", { recipe: null }],
];

const verbose = process.argv.includes("--verbose");
const ask = createJev();
await ask("ready", { ready: { type: "noul", instructions: "The text says ready." } });

let passed = 0;
const latencies: number[] = [], wrongButSure: string[] = [];
for (const [said, want] of CASES) {
  const started = performance.now();
  const built = await recipeIntent(ask, said, { today: SIM_TODAY, contacts: CONTACTS });
  latencies.push(performance.now() - started);
  const text = built ? Object.values(built.intent.inputs).join("\n") : "", typed = built?.intent.inputs.message ?? built?.intent.inputs.note ?? text;
  const problems = [
    (built?.recipe ?? null) !== want.recipe && `recipe ${built?.recipe ?? "null"}`,
    !!built && !!want.to && !(`${built.intent.goal}\n${text}`.includes(want.to)) && `not addressed to ${want.to}`,
    !!built && want.has?.some((p) => !p.test(typed)) && `text was ${JSON.stringify(typed)}`,
    !!built && want.hasNot?.some((p) => p.test(typed)) && `text kept the command words: ${JSON.stringify(typed)}`,
    !!built && want.link?.some((p) => !p.test(built.deepLink ?? "")) && `link was ${built.deepLink}`,
    !!built && want.noInputs && Object.keys(built.intent.inputs).length > 0 && `inputs were ${JSON.stringify(built.intent.inputs)}`,
  ].filter(Boolean);
  if (!problems.length) passed++;
  else if (built) wrongButSure.push(`${built.confidence.toFixed(2)}  ${said}`);
  if (verbose || problems.length) console.log(`${problems.length ? "MISS" : "ok  "} ${built ? built.confidence.toFixed(2) : " -- "}  ${said}${problems.length ? `\n       ${problems.join("; ")}` : ""}`);
}
latencies.sort((a, b) => a - b);
console.log(`\n${passed}/${CASES.length} right, one Jev request each, no LLM. Latency p50 ${Math.round(latencies[latencies.length >> 1]!)} ms.`);
if (wrongButSure.length) console.log(`Built an intent that was wrong (these would act):\n  ${wrongButSure.join("\n  ")}`);
