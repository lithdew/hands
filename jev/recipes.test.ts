import { describe, expect, test } from "bun:test";
import { assertContract, type Ask } from "./jev";
import { dateFor, readRequest, recipeIntent } from "./recipes";

const SATURDAY = new Date(2026, 8, 19, 12);
const CONTACTS = [{ name: "Sam Rivera", email: "sam.rivera@example.com" }, { name: "Samantha Lee", email: "samantha.lee@example.com" }, { name: "Mom" }];
const ctx = { today: SATURDAY, contacts: CONTACTS };

type Reply = string | number | { choice: string; confidence?: number; probabilities?: Record<string, number> };

/** A scripted Jev. Unscripted choices answer "not said", unscripted nouls say no; answers pass through assertContract. */
function fakeJev(replies: Record<string, Reply>) {
  const calls: { state: any; questions: Record<string, any> }[] = [];
  const ask: Ask = async (state, questions) => {
    calls.push({ state, questions });
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(questions) as [string, any][]) {
      if (q.type === "noul") { answers[name] = { type: "noul", noul: typeof replies[name] === "number" ? replies[name] : 0 }; continue; }
      const r = (replies[name] as Exclude<Reply, number> | undefined) ?? (Object.hasOwn(q.criteria, "not_said") ? "not_said" : Object.keys(q.criteria)[0]!);
      const given = typeof r === "string" ? { choice: r } : r;
      answers[name] = { type: "choice", confidence: 0.9, probabilities: { [given.choice]: given.confidence ?? 0.9 }, ...given };
    }
    assertContract(questions, answers);
    return answers as never;
  };
  return { ask, calls };
}

describe("dateFor", () => {
  const iso = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  test("day words become dates in code, counting from today", () => {
    expect(iso(dateFor("today", SATURDAY))).toBe("2026-9-19");
    expect(iso(dateFor("tomorrow", SATURDAY))).toBe("2026-9-20");
    expect(iso(dateFor("friday", SATURDAY))).toBe("2026-9-25");
  });
  test("today's own weekday means next week", () => {
    expect(iso(dateFor("saturday", SATURDAY))).toBe("2026-9-26");
  });
});

describe("recipeIntent", () => {
  test("a table: every slot is a pick, the date is arithmetic, the deep link carries them all", async () => {
    //            w1   w2 w3    w4 w5 w6         w7  w8  w9       w10 w11
    const said = "book a table at a steakhouse for two tomorrow at 7";
    const jev = fakeJev({ task: "book_table", place_from: "w6", place_to: "w6", party: "2", day: "tomorrow", time: "7:00 PM" });
    const built = (await recipeIntent(jev.ask, said, ctx))!;
    expect(jev.calls).toHaveLength(1);
    expect(built.recipe).toBe("book_table");
    expect(built.deepLink).toBe("https://www.opentable.com/s?term=steakhouse&covers=2&dateTime=2026-09-20T19%3A00");
    expect(built.intent.inputs).toEqual({ restaurant_or_cuisine: "steakhouse" });
    expect(built.intent.goal).toContain("Sunday, September 20, 2026");
  });

  test("an email: the contact gives the address, the words come from what was said", async () => {
    //            w1    w2  w3 w4     w5  w6    w7  w8      w9       w10 w11
    const said = "email Sam to remind him about the meeting tomorrow at 10";
    const jev = fakeJev({ task: "send_email", person: "Sam Rivera", wording: "reminder", message_from: "w8", message_to: "w11" });
    const built = (await recipeIntent(jev.ask, said, ctx))!;
    expect(built.intent.inputs.recipient).toBe("sam.rivera@example.com");
    expect(built.intent.inputs.subject).toBe("Reminder: the meeting tomorrow at 10"); // the article before the span is kept
    expect(built.intent.inputs.body).toContain("Just a reminder about the meeting tomorrow at 10.");
    expect(new URL(built.deepLink!).searchParams.get("to")).toBe("sam.rivera@example.com");
  });

  test("Jev reads literally, so the criteria say that a first name is enough", async () => {
    const jev = fakeJev({ task: "other" });
    await recipeIntent(jev.ask, "email Sam hello there", ctx);
    const people = jev.calls[0]!.questions.person.criteria;
    expect(people["Sam Rivera"]).toContain('or just "Sam"');
    expect(people["Mom"]).toBe('Called "Mom" in `request`.');
  });

  test("a text whose wording is left open has no prepared message: it will be written on screen", async () => {
    const jev = fakeJev({ task: "send_text", person: "Mom", wording: "open" });
    const built = (await recipeIntent(jev.ask, "answer mom's text", ctx))!;
    expect(built.intent.inputs).toEqual({});
    expect(built.intent.goal).toContain("fitting answer");
  });

  test("an edge torn between neighbouring words is not an unsure edge", async () => {
    const said = "make a note for my dentist appointment";
    const torn = { choice: "w5", confidence: 0.4, probabilities: { w5: 0.4, w6: 0.45 } };
    const built = await recipeIntent(fakeJev({ task: "make_note", note_from: torn, note_to: "w7" }).ask, said, ctx);
    expect(built?.intent.inputs.note).toBe("My dentist appointment.");
    const lost = { choice: "w5", confidence: 0.3, probabilities: { w5: 0.3, w1: 0.3 } };
    expect(await recipeIntent(fakeJev({ task: "make_note", note_from: lost, note_to: "w7" }).ask, said, ctx)).toBeNull();
  });

  test("anything else, an unknown person, or an email that must be composed goes back to the caller", async () => {
    expect(await recipeIntent(fakeJev({ task: "other" }).ask, "what is the weather in tokyo", ctx)).toBeNull();
    expect(await recipeIntent(fakeJev({ task: "send_email", person: "not_in_list", wording: "verbatim" }).ask, "email Bob hello there", ctx)).toBeNull();
    expect(await recipeIntent(fakeJev({ task: "send_email", person: "Sam Rivera", wording: "open" }).ask, "answer Sam's email", ctx)).toBeNull();
    expect(await recipeIntent(fakeJev({ task: "send_email", person: "Mom", wording: "verbatim", message_from: "w3", message_to: "w4" }).ask, "email mom hello there", ctx)).toBeNull(); // no address
  });

  test("a request that carries more than the recipe can hold goes back to the caller instead of losing the rest", async () => {
    const table = { task: "book_table", place_from: "w6", place_to: "w6", party: "2", day: "tomorrow", time: "7:00 PM" };
    const said = "book a table at a steakhouse for two tomorrow at 7";
    expect((await readRequest(fakeJev(table).ask, said, ctx)).built?.recipe).toBe("book_table");
    expect(await readRequest(fakeJev({ ...table, table_wish: 0.9 }).ask, `${said} and ask for a quiet corner`, ctx)).toMatchObject({ task: "book_table", built: null, more: 0.9 });
    expect((await readRequest(fakeJev({ ...table, note_title: 0.9, attachment: 0.9 }).ask, said, ctx)).built).not.toBeNull(); // guards of other recipes do not count
    expect(await readRequest(fakeJev({ ...table, two_tasks: 0.8 }).ask, `${said} and email sam`, ctx)).toMatchObject({ built: null, twoTasks: 0.8 });
  });

  test("an address that was said out loud needs no contact", async () => {
    const built = await recipeIntent(fakeJev({ task: "send_email", person: "not_in_list", wording: "verbatim", message_from: "w4", message_to: "w7" }).ask, "email jo@acme.io saying the contract is signed", ctx);
    expect(built?.intent.inputs.recipient).toBe("jo@acme.io");
  });

  test("a table's party, date and time are facts the screen must agree with", async () => {
    const built = await recipeIntent(fakeJev({ task: "book_table", place_from: "w6", place_to: "w6", party: "2", day: "tomorrow", time: "7:00 PM" }).ask, "book a table at a steakhouse for two tomorrow at 7", ctx);
    expect(built?.intent.facts).toEqual(["party size: 2 people", "date: Sunday, September 20, 2026", "time: 7:00 PM"]);
  });

  test("the words to type can only be words that were said", async () => {
    const jev = fakeJev({ task: "make_note", note_from: "w9", note_to: "w9" });
    await expect(recipeIntent(jev.ask, "note buy milk", ctx)).rejects.toThrow(/not one of the offered labels/);
  });
});
