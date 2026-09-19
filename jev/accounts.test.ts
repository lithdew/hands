import { describe, expect, test } from "bun:test";
import { accountShown, describeAccount, gmailUrl, kindOf, wrongAccount } from "./accounts";
import { assertContract, type Ask } from "./jev";
import { planTasks } from "./plan";
import { readRequest } from "./recipes";

const SCHOOL = "chi.li@u.northwestern.edu", OWN = "yc@gmail.com";
const ctx = { today: new Date(2026, 8, 19, 12), contacts: [{ name: "Sam Rivera", email: "sam.rivera@example.com" }], accounts: [{ email: OWN }, { email: SCHOOL }] };

/** A scripted Jev. Unscripted choices say "not said" or take the first label; unscripted nouls say no. */
function fakeJev(replies: Record<string, string | number>) {
  const calls: { state: any; questions: Record<string, any> }[] = [];
  const ask: Ask = async (state, questions) => {
    calls.push({ state, questions });
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(questions) as [string, any][]) {
      if (q.type === "noul") { answers[name] = { type: "noul", noul: typeof replies[name] === "number" ? replies[name] : 0 }; continue; }
      const pick = typeof replies[name] === "string" ? replies[name] as string : Object.hasOwn(q.criteria, "not_said") ? "not_said" : Object.keys(q.criteria)[0]!;
      answers[name] = { type: "choice", choice: pick, confidence: 0.9, probabilities: { [pick]: 0.9 } };
    }
    assertContract(questions, answers);
    return answers as never;
  };
  return { ask, calls };
}

describe("accounts", () => {
  test("an account is school, work or personal by lookup, and Jev is given the words a speaker would use", () => {
    expect([kindOf({ email: SCHOOL }), kindOf({ email: OWN }), kindOf({ email: "chi@acme.io" }), kindOf({ email: "chi@acme.io", label: "personal" })]).toEqual(["school", "personal", "work", "personal"]);
    expect(describeAccount({ email: SCHOOL })).toBe(`${SCHOOL}: a school, college or university account, also called by the name "northwestern".`);
  });
  test("Gmail opens in an account by its address, with nothing to click", () => {
    expect(gmailUrl(SCHOOL, { search: "from:ananth" })).toBe("https://mail.google.com/mail/u/?authuser=chi.li%40u.northwestern.edu#search/from%3Aananth");
    expect(gmailUrl(null, { search: "from:ananth" })).toBe("https://mail.google.com/mail/#search/from%3Aananth");
    expect(new URL(gmailUrl(SCHOOL, { compose: { to: "a@b.co", subject: "Hi", body: "x" } })).searchParams.get("authuser")).toBe(SCHOOL);
  });
  test("which account a page is in is read off its title, never off the address that was asked for", () => {
    expect(accountShown(["page: Search results - YC@gmail.com - Gmail", "address: https://mail.google.com/mail/u/0/"])).toBe(OWN);
    expect(accountShown([`address: https://mail.google.com/mail/u/?authuser=${SCHOOL}`, "page: Gmail"])).toBeNull();
    expect(wrongAccount(SCHOOL, [`page: Inbox - ${OWN} - Gmail`])).toBe(OWN);
    expect(wrongAccount(SCHOOL, [`page: Inbox - ${SCHOOL} - Gmail`])).toBeNull();
    expect(wrongAccount(undefined, [`page: Inbox - ${OWN} - Gmail`])).toBeNull();
    expect(wrongAccount(SCHOOL, ["page: OpenTable"])).toBeNull();
  });
});

describe("the account a request names", () => {
  //            w1     w2 w3  w4    w5   w6     w7   w8 w9 w10          w11
  const said = "search up the email from ananth sent to my northwestern email";
  const found = { task: "find_email", sender_from: "w6", sender_to: "w6" };

  test("named by name: it goes into the url, and never into the search", async () => {
    const r = await readRequest(fakeJev({ ...found, account: SCHOOL, account_kind: "by_name" }).ask, said, ctx);
    expect(r.built?.deepLink).toBe(gmailUrl(SCHOOL, { search: "from:ananth" }));
    expect(r.built?.intent).toMatchObject({ account: SCHOOL, inputs: { search_query: "from:ananth" } });
  });
  test("named by kind: code gets from 'school' to the address, which Jev was torn on", async () => {
    const r = await readRequest(fakeJev({ ...found, account_kind: "school" }).ask, said, ctx);
    expect(r.built?.intent.account).toBe(SCHOOL);
  });
  test("a kind nobody has, or two of, is not guessed: the request is handed back as naming an unknown account", async () => {
    expect(await readRequest(fakeJev({ ...found, account_kind: "work" }).ask, said, ctx)).toMatchObject({ built: null, unknownAccount: true });
    const two = { ...ctx, accounts: [...ctx.accounts, { email: "chi@uchicago.edu" }] };
    expect(await readRequest(fakeJev({ ...found, account_kind: "school" }).ask, said, two)).toMatchObject({ built: null, unknownAccount: true });
    expect(await readRequest(fakeJev({ ...found, account_kind: "by_name" }).ask, said, ctx)).toMatchObject({ built: null, unknownAccount: true });
  });
  test("no account named: the one the hand is in stays", async () => {
    const here = { url: "https://mail.google.com/mail/u/1/#search/from%3Aananth", title: `Search results - ${SCHOOL} - Gmail` };
    expect((await readRequest(fakeJev(found).ask, "find the email from the registrar", { ...ctx, here })).built?.intent.account).toBe(SCHOOL);
    expect((await readRequest(fakeJev(found).ask, "find the email from the registrar", ctx)).built?.intent.account).toBeUndefined();
    expect((await readRequest(fakeJev(found).ask, "find the email from the registrar", { ...ctx, here: { url: "https://www.opentable.com/", title: `Table for ${SCHOOL}` } })).built?.intent.account).toBeUndefined();
  });
  test("a request that carries on from the open page is not given a recipe's link to go to", async () => {
    const here = { url: "https://mail.google.com/mail/u/1/#inbox/1", title: `Lab meeting - ${SCHOOL} - Gmail` };
    const jev = fakeJev({ ...found, continues: 0.9 });
    expect(await readRequest(jev.ask, "reply to that email from ananth", { ...ctx, here })).toMatchObject({ built: null, continues: 0.9 });
    expect(jev.calls[0]!.state.on_screen).toContain("Lab meeting");
    expect((await readRequest(fakeJev({ ...found, continues: 0.9 }).ask, "reply to that email from ananth", ctx)).built).not.toBeNull(); // nothing is open: nothing to carry on from
  });
});

describe("planning with accounts and an open page", () => {
  const task = { goal: "Reply to the email about the lab meeting.", url: "", inputs: [{ name: "reply", value: "Thanks" }], presses: [], facts: [`account: ${SCHOOL}`], steps: ["Click 'Reply'."], done_when: "Sent.", avoid: [], wants_answer: false };
  test("the planner is told the accounts and the page, and may stay on it: no url, no navigation", async () => {
    let system = "";
    const here = { url: "https://mail.google.com/mail/u/1/#inbox/1", title: `Lab meeting - ${SCHOOL} - Gmail` };
    const [planned] = await planTasks(async (req) => { system = req.system; return { can_do: true, tasks: [task] }; }, "reply to that email", { ...ctx, here });
    expect(system).toContain("names one of these ACCOUNTS");
    expect(system).toContain("set url to an empty string");
    expect(planned!.intent).toMatchObject({ url: null, account: SCHOOL });
  });
  test("with nothing open a plan still needs somewhere to start, and an address that is not the user's is not an account", async () => {
    await expect(planTasks(async () => ({ can_do: true, tasks: [task] }), "reply to that email", ctx)).rejects.toThrow(/no start url/);
    const [planned] = await planTasks(async () => ({ can_do: true, tasks: [{ ...task, url: "https://mail.google.com/", facts: ["account: someone@else.com"] }] }), "x y", ctx);
    expect(planned!.intent.account).toBeUndefined();
  });
});
