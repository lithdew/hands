import { afterEach, beforeEach, expect, test } from "bun:test";
import { APITimeoutError, type ChoiceQuestion } from "@typesafe-ai/sdk";
import { type Item, item } from "../src/models.ts";
import { CHECK, COOKIE_BANNER, DECLINE, declining, doneCheck, PageReflex, pageRequest, signs, type Verdict, wallNote, WALL_QUESTIONS } from "../src/reflex.ts";
import { screen } from "./helpers.ts";

// Jev here is a fake client: each request is kept with its options, and answered by the test's own function.

const control = (index: number, text: string, role: string): Item => item(index, text, 1, [100, 100 + index * 40, 400, 130 + index * 40], role, "ax");
const words = (index: number, text: string): Item => item(index, text, 0.9, [100, 100 + index * 40, 900, 130 + index * 40]);
const noul = (value: number) => ({ type: "noul", noul: value });
const picked = (choice: string, confidence: number) => ({ type: "choice", choice, confidence, probabilities: { [choice]: confidence } });

interface Sent {
  state: { url?: string; title?: string; claim?: string; elements: string[] };
  questions: Record<string, { type: string; instructions?: string; criteria?: Record<string, unknown> }>;
  options: { timeout?: number; retry?: { maxRetries?: number }; signal?: AbortSignal };
}

function fakeJev(reply: (sent: Sent) => Record<string, unknown> | Promise<Record<string, unknown>>) {
  const sent: Sent[] = [];
  const client = {
    systemOne: async (request: unknown, options: unknown) => {
      const one = { ...(request as Omit<Sent, "options">), options: options as Sent["options"] };
      sent.push(one);
      return { model: "jev-1.13.0", usage: { input_tokens: 400, output_tokens: 0 }, answers: await reply(one) };
    },
  };
  return { sent, client: () => client as never };
}

const quiet = { cookie_banner: noul(0.02), sign_in_wall: noul(0.03), captcha: noul(0.01), code_needed: noul(0.01), payment_form: noul(0.01) };

const env = { key: process.env.TYPESAFE_API_KEY, reflexes: process.env.HANDS_REFLEXES };
beforeEach(() => {
  process.env.TYPESAFE_API_KEY = "test-key";
  delete process.env.HANDS_REFLEXES;
});
afterEach(() => {
  for (const [name, value] of [["TYPESAFE_API_KEY", env.key], ["HANDS_REFLEXES", env.reflexes]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const news = screen({ url: "https://news.example.com/today", tabs: { count: 1, active: "Today's news" } });
const banner = (): Item[] => [
  words(0, "Today's headline: the river rises"),
  words(1, "We use cookies to improve your experience. Choose which ones to allow."),
  control(2, "Accept all", "button"),
  control(3, "Reject all", "button"),
  control(4, "Manage options", "button"),
];

// ------------------------------------------------------------------ the words

test("the words that make a page worth asking about: a bare Sign in link, a footer's cookie statement or plain text ask nothing", () => {
  expect(signs([control(0, "Log in", "link"), control(1, "Search Wikipedia", "field"), words(2, "Cookie statement")])).toEqual(new Set());
  expect(signs(banner())).toEqual(new Set(["cookie"]));
  expect(signs([words(0, "We use cookies."), control(1, "Accept all", "button")])).toEqual(new Set()); // nothing to turn it down with
  expect(signs([control(0, "Password", "field")])).toEqual(new Set(["sign_in"]));
  expect(signs([words(0, "Sign in to continue to YouTube")])).toEqual(new Set(["sign_in"]));
  expect(signs([control(0, "Sign in", "button"), control(1, "Email or phone", "field")])).toEqual(new Set(["sign_in"]));
  expect(signs([words(0, "Verify you are human by completing the action below.")])).toEqual(new Set(["captcha"]));
  expect(signs([words(0, "I'm not a robot")])).toEqual(new Set(["captcha"]));
  expect(signs([words(0, "Enter the 6-digit code we sent to your phone"), words(1, "2-Step Verification")])).toEqual(new Set(["code"]));
  expect(signs([control(0, "Card number", "field"), control(1, "MM / YY", "field")])).toEqual(new Set(["payment"]));
});

test("a banner's buttons that may be pressed read as declining and never as accepting, and are buttons or links", () => {
  const labels = [
    "Reject all", "Decline", "Necessary cookies only", "Use essential cookies only", "Only allow essential cookies", "Continue without accepting",
    "Refuse", "Deny", "Disagree and close", "Close", "×", "Accept all", "Agree and close", "Allow all", "OK", "Got it", "Accept only essential cookies", "Manage options",
  ]; // prettier-ignore
  const items = labels.map((label, i) => control(i, label, "button"));
  expect(declining(items).map((it) => it.text)).toEqual([
    "Reject all", "Decline", "Necessary cookies only", "Use essential cookies only", "Only allow essential cookies", "Continue without accepting", "Refuse", "Deny", "Disagree and close", "Close", "×",
  ]); // prettier-ignore
  expect(declining([words(0, "Reject all"), control(1, "Reject all", "link"), control(2, "Reject all", "checkbox")]).map((it) => it.index)).toEqual([1]); // words off the picture are not a control
});

// ------------------------------------------------------------------ the page's question

test("the page's one request: the items once in state with bare ids, the five questions, and a pick among the declining buttons alone", () => {
  const { state, questions } = pageRequest(news, banner(), declining(banner()));
  expect(state).toMatchObject({ url: "https://news.example.com/today", title: "Today's news" });
  expect(state.elements).toEqual([
    "0: text \"Today's headline: the river rises\" (top-left)",
    "1: text 'We use cookies to improve your experience. Choose which ones to allow.' (top-left)",
    "2: button 'Accept all' (top-left)",
    "3: button 'Reject all' (top-left)",
    "4: button 'Manage options' (top-left)",
  ]);
  expect(Object.keys(questions)).toEqual(["cookie_banner", "sign_in_wall", "captcha", "code_needed", "payment_form", "decline"]);
  expect(questions.cookie_banner).toMatchObject({ type: "noul", instructions: COOKIE_BANNER });
  expect(questions.sign_in_wall).toMatchObject({ type: "noul", instructions: WALL_QUESTIONS.sign_in_wall });
  expect(questions.decline).toMatchObject({ type: "choice", instructions: DECLINE });
  expect(Object.keys((questions.decline as ChoiceQuestion).criteria)).toEqual(["3", "none_of_these"]);
  expect(Object.keys(pageRequest(news, [control(0, "Password", "field")], []).questions)).not.toContain("decline");
});

test("a page with more items than a question shows keeps the ones that tell first, then the rest in reading order", () => {
  const many = Array.from({ length: 400 }, (_, i) => words(i, `paragraph ${i}`));
  many[390] = control(390, "Reject all", "button");
  many[380] = words(380, "This site uses cookies");
  const { state } = pageRequest(news, many, declining(many));
  expect(state.elements).toHaveLength(250);
  expect(state.elements.at(-2)).toStartWith("380: text 'This site uses cookies'");
  expect(state.elements.at(-1)).toStartWith("390: button 'Reject all'");
  expect(state.elements[0]).toStartWith("0: text 'paragraph 0'");
});

test("a wall is said at 0.8 or more, the likeliest one, with what to do; below that, nothing", () => {
  const verdict = (scores: Verdict["scores"]): Verdict => ({ scores, decline: null, ms: 300 });
  expect(wallNote(verdict({ sign_in_wall: 0.93, captcha: 0.2 }))).toBe(
    "Jev: this page wants a sign-in (0.93). If the task did not give you the credentials, finish with needs_you and say what the user must do.",
  );
  expect(wallNote(verdict({ sign_in_wall: 0.85, code_needed: 0.91 }))).toStartWith("Jev: this page asks for a verification code (0.91). It is a code the user has");
  expect(wallNote(verdict({ captcha: 0.8 }))).toBe("Jev: this page shows a CAPTCHA (0.80). Only the user can solve it: finish with needs_you and say what the user must do.");
  expect(wallNote(verdict({ payment_form: 0.97 }))).toBe(
    "Jev: this page asks for payment details (0.97). Payment details are never typed by a hand: finish with needs_you and say what the user must do.",
  );
  expect(wallNote(verdict({ sign_in_wall: 0.79, cookie_banner: 0.99 }))).toBeNull();
  expect(wallNote(verdict({}))).toBeNull();
});

test("a sign-in wall: one short request with no retry, its line for the listing, and nothing to press", async () => {
  const logged: Record<string, unknown>[] = [];
  const jev = fakeJev(() => ({ ...quiet, sign_in_wall: noul(0.93) }));
  const reflex = new PageReflex({ client: jev.client, log: (record) => void logged.push(record) });
  const wall = [words(0, "Sign in to continue to Mail"), control(1, "Email or phone", "field"), control(2, "Next", "button")];
  const seen = await reflex.look(news, wall);
  expect(seen?.note).toStartWith("Jev: this page wants a sign-in (0.93).");
  expect(seen?.press).toBeNull();
  expect(jev.sent).toHaveLength(1);
  expect(jev.sent[0]!.options).toMatchObject({ timeout: 1500, retry: { maxRetries: 0 } });
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ reflex: "page", url: news.url, signs: ["sign_in"], scores: { sign_in_wall: 0.93 } });
  expect(typeof logged[0]!.ms).toBe("number");
});

test("a page is asked about once: the same page again costs nothing and says the same; changed items are a new page", async () => {
  const jev = fakeJev(() => ({ ...quiet, captcha: noul(0.9) }));
  const reflex = new PageReflex({ client: jev.client });
  const check = [words(0, "Verify you are human"), control(1, "Verify", "button")];
  expect((await reflex.look(news, check))?.note).toStartWith("Jev: this page shows a CAPTCHA (0.90)");
  expect((await reflex.look(news, check))?.note).toStartWith("Jev: this page shows a CAPTCHA (0.90)");
  expect(jev.sent).toHaveLength(1);
  await reflex.look(news, [...check, words(2, "Checking your browser before accessing news.example.com")]);
  expect(jev.sent).toHaveLength(2);
  await reflex.look(screen({ url: "https://other.example.com/" }), check);
  expect(jev.sent).toHaveLength(3);
});

test("nothing is asked without a key, with HANDS_REFLEXES=off, without a trigger, or of a page that is not on the web", async () => {
  const jev = fakeJev(() => ({ ...quiet, sign_in_wall: noul(0.99) }));
  const reflex = new PageReflex({ client: jev.client });
  const wall = [control(0, "Password", "field")];
  process.env.HANDS_REFLEXES = "off";
  expect(await reflex.look(news, wall)).toBeNull();
  delete process.env.HANDS_REFLEXES;
  delete process.env.TYPESAFE_API_KEY;
  expect(await reflex.look(news, wall)).toBeNull();
  process.env.TYPESAFE_API_KEY = "test-key";
  expect(await reflex.look(news, [control(0, "Log in", "link"), words(1, "Today's headline")])).toBeNull();
  expect(await reflex.look(screen({ url: "file:///C:/Users/u/page.html" }), wall)).toBeNull();
  expect(await reflex.look(screen({ url: null }), wall)).toBeNull();
  expect(jev.sent).toEqual([]);
});

test("a request that fails or times out says nothing and throws nothing, and the page is not asked again", async () => {
  const logged: Record<string, unknown>[] = [];
  const jev = fakeJev(() => {
    throw new APITimeoutError(1500);
  });
  const reflex = new PageReflex({ client: jev.client, log: (record) => void logged.push(record) });
  expect(await reflex.look(news, banner())).toMatchObject({ note: null, press: null });
  expect(logged[0]).toMatchObject({ reflex: "page", error: "no answer within 1500 ms" });
  await reflex.look(news, banner());
  expect(jev.sent).toHaveLength(1);
  // A client that cannot even be made (no key where the SDK reads it) is the same.
  const broken = new PageReflex({
    client: () => {
      throw new Error("TYPESAFE_API_KEY is not set");
    },
  });
  expect(await broken.look(news, banner())).toMatchObject({ note: null, press: null });
});

// ------------------------------------------------------------------ the cookie banner

test("a cookie banner at 0.8 with Jev's pick at 0.7 names the declining button to press, once a URL, and never an accepting one", async () => {
  const jev = fakeJev((sent) => ({ ...quiet, cookie_banner: noul(0.96), decline: picked(Object.keys(sent.questions.decline!.criteria!)[0]!, 0.91) }));
  const reflex = new PageReflex({ client: jev.client });
  const seen = await reflex.look(news, banner());
  expect(seen?.press?.text).toBe("Reject all");
  expect(seen?.note).toBeNull();
  // The banner again on the same URL (a changed page, so Jev is asked again): nothing more is pressed there.
  const again = await reflex.look(screen({ url: "https://news.example.com/today#top" }), [...banner(), words(5, "Live: the river at noon")]);
  expect(jev.sent).toHaveLength(2);
  expect(again?.press).toBeNull();
  // Another URL is another page.
  expect((await reflex.look(screen({ url: "https://news.example.com/sport" }), banner()))?.press?.text).toBe("Reject all");
});

test("no press below the bars, on none_of_these, on a pick that was not offered, or when told not to", async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ cookie_banner: noul(0.7), decline: picked("3", 0.95) }, "banner below 0.8"],
    [{ cookie_banner: noul(0.95), decline: picked("3", 0.6) }, "pick below 0.7"],
    [{ cookie_banner: noul(0.95), decline: picked("none_of_these", 0.9) }, "none_of_these"],
    [{ cookie_banner: noul(0.95), decline: picked("2", 0.99) }, "Accept all, never offered"],
  ];
  for (const [answers, why] of cases) {
    const jev = fakeJev(() => ({ ...quiet, ...answers }));
    expect({ why, press: (await new PageReflex({ client: jev.client }).look(news, banner()))?.press ?? null }).toEqual({ why, press: null });
  }
  const jev = fakeJev(() => ({ ...quiet, cookie_banner: noul(0.95), decline: picked("3", 0.95) }));
  const reflex = new PageReflex({ client: jev.client });
  expect((await reflex.look(news, banner(), false))?.press).toBeNull();
  expect((await reflex.look(news, banner()))?.press?.text).toBe("Reject all"); // not pressed before, so still due
});

// ------------------------------------------------------------------ the done check

const article = [words(0, "Charles Babbage"), words(1, "Born 26 December 1791, London, England"), words(2, "Died 18 October 1871 (aged 79)"), control(3, "Talk", "link")];

test("the done check: one noul over the claim and the items once in state, in a short request, read as 0 to 1", async () => {
  const logged: Record<string, unknown>[] = [];
  const jev = fakeJev(() => ({ shows: noul(0.94) }));
  const page = screen({ url: "https://en.wikipedia.org/wiki/Charles_Babbage" });
  expect(await doneCheck(page, article, " Charles Babbage was born in 1791. ", { client: jev.client, log: (record) => void logged.push(record) })).toBe(0.94);
  const [{ state, questions, options }] = jev.sent as [Sent];
  expect(state.claim).toBe("Charles Babbage was born in 1791.");
  expect(state.elements[1]).toBe("1: text 'Born 26 December 1791, London, England' (top-left)");
  expect(questions).toEqual({ shows: { type: "noul", instructions: CHECK } } as never);
  expect(options).toMatchObject({ timeout: 1500, retry: { maxRetries: 0 } });
  expect(logged[0]).toMatchObject({ reflex: "check", checked: 0.94, items: 4 });
});

test("the done check is absent without a key, with reflexes off, with nothing to read or claim, and when the request fails", async () => {
  const jev = fakeJev(() => ({ shows: noul(0.9) }));
  const page = screen({ url: "https://en.wikipedia.org/wiki/Charles_Babbage" });
  process.env.HANDS_REFLEXES = "off";
  expect(await doneCheck(page, article, "Born in 1791.", { client: jev.client })).toBeNull();
  delete process.env.HANDS_REFLEXES;
  delete process.env.TYPESAFE_API_KEY;
  expect(await doneCheck(page, article, "Born in 1791.", { client: jev.client })).toBeNull();
  process.env.TYPESAFE_API_KEY = "test-key";
  expect(await doneCheck(page, [], "Born in 1791.", { client: jev.client })).toBeNull();
  expect(await doneCheck(page, article, "  ", { client: jev.client })).toBeNull();
  expect(jev.sent).toEqual([]);
  const failing = fakeJev(() => {
    throw new APITimeoutError(1500);
  });
  expect(await doneCheck(page, article, "Born in 1791.", { client: failing.client })).toBeNull();
  expect(await doneCheck(page, article, "Born in 1791.", { client: fakeJev(() => ({})).client })).toBeNull(); // a reply with no answer
});

test("a long screen shows the done check the items that share most words with the claim, in reading order", async () => {
  const many = Array.from({ length: 300 }, (_, i) => words(i, `line ${i} of the article`));
  many[250] = words(250, "Babbage was born on 26 December 1791");
  const jev = fakeJev(() => ({ shows: noul(0.8) }));
  await doneCheck(news, many, "Babbage was born in 1791", { client: jev.client });
  const shown = jev.sent[0]!.state.elements;
  expect(shown).toHaveLength(200);
  expect(shown.some((line) => line.startsWith("250: text 'Babbage was born on 26 December 1791'"))).toBe(true);
});
