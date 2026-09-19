import { describe, expect, test } from "bun:test";
import { assertContract, type Ask } from "./jev";
import { literalSpansOf, quickIntent, SITES, spansOf, suppliedUrls } from "./quick";

type Reply = string | { choice: string; confidence: number };

/** A scripted Jev. Answers pass through assertContract, so only offered labels can be picked. */
function fakeJev(replies: Record<string, Reply>) {
  const calls: { state: any; questions: Record<string, any> }[] = [];
  const ask: Ask = async (state, questions) => {
    calls.push({ state, questions });
    const answers: Record<string, unknown> = {};
    for (const name of Object.keys(questions)) {
      const r = replies[name]!;
      answers[name] = { type: "choice", probabilities: {}, ...(typeof r === "string" ? { choice: r, confidence: 0.9 } : r) };
    }
    assertContract(questions, answers);
    return answers as never;
  };
  return { ask, calls };
}

describe("spansOf", () => {
  test("offers every run of words, short ones first, without the punctuation around them", () => {
    expect(spansOf("search for capybaras, please!")).toEqual([
      "search", "for", "capybaras", "please",
      "search for", "for capybaras", "capybaras please",
      "search for capybaras", "for capybaras please",
      "search for capybaras please",
    ]);
  });

  test("keeps an email address whole", () => {
    expect(spansOf("email sam@example.com")).toContain("sam@example.com");
  });

  test("never offers more labels than a Choice can take", () => {
    const long = Array.from({ length: 80 }, (_, i) => `w${i}`).join(" ");
    expect(spansOf(long).length).toBeLessThanOrEqual(254);
    expect(spansOf(long, 10)).toHaveLength(10);
  });
});

describe("quickIntent", () => {
  test("offers full long queries, quoted phrases and programming punctuation without inventing text", async () => {
    const phrase = "why do leaves change color in the autumn";
    expect(literalSpansOf(`search google for ${phrase}`)).toContain(phrase);
    expect(literalSpansOf('search google for "red pandas in the eastern Himalayas during winter"')).toContain("red pandas in the eastern Himalayas during winter");
    expect(literalSpansOf("search google for C++ std::vector")).toContain("C++ std::vector");
    expect(literalSpansOf(Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ")).length).toBeLessThanOrEqual(254);
    const jev = fakeJev({ launcher: "browser", site: "google", text: phrase });
    expect((await quickIntent(jev.ask, `search google for ${phrase}`))?.inputs.search_query).toBe(phrase);
  });

  test("offers an explicitly supplied URL without requiring an intent writer", async () => {
    const url = "https://developer.mozilla.org/en-US/docs/Web/JavaScript";
    const jev = fakeJev({ launcher: "browser", site: "supplied_url_0", text: "nothing_to_type" });
    expect((await quickIntent(jev.ask, `open ${url}`))?.url).toBe(url);
    const address = fakeJev({ launcher: "browser", site: "supplied_url_0", text: url });
    expect((await quickIntent(address.ask, `open ${url}`))?.inputs).toEqual({});
    const search = fakeJev({ launcher: "browser", site: "google", text: url });
    expect((await quickIntent(search.ask, `search google for ${url}`))?.inputs.search_query).toBe(url);
    expect(suppliedUrls("open javascript:alert(1) or file:///tmp/a")).toEqual({});
    expect(suppliedUrls("open https://name:password@example.test/")).toEqual({});
  });

  test("a short query that is a substring of the site name is not discarded", async () => {
    const jev = fakeJev({ launcher: "browser", site: "google", text: "go" });
    expect((await quickIntent(jev.ask, "search google for go"))?.inputs.search_query).toBe("go");
  });

  test("assembles an intent from Jev's picks alone", async () => {
    const jev = fakeJev({ launcher: "browser", site: "wikipedia", text: "capybaras" });
    expect(await quickIntent(jev.ask, " search wikipedia for capybaras ")).toEqual({
      goal: "search wikipedia for capybaras",
      launcher: "browser",
      url: SITES.wikipedia.url,
      inputs: { search_query: "capybaras" },
      doneWhen: 'The screen shows the result of what was asked: "search wikipedia for capybaras"',
      avoid: [],
    });
    expect(jev.calls).toHaveLength(1);
  });

  test("the text to type can only be words that were said", async () => {
    const jev = fakeJev({ launcher: "browser", site: "google", text: "drop all tables" });
    await expect(quickIntent(jev.ask, "look up the weather")).rejects.toThrow(/not one of the offered labels/);
  });

  test("half a sentence gives an intent with nothing to type yet", async () => {
    const jev = fakeJev({ launcher: "browser", site: "wikipedia", text: "nothing_to_type" });
    const intent = await quickIntent(jev.ask, "search wikipedia for");
    expect(intent).toMatchObject({ url: SITES.wikipedia.url, inputs: {} });
  });

  test("does not type a site's own name into that site", async () => {
    const jev = fakeJev({ launcher: "browser", site: "youtube", text: "youtube" });
    expect((await quickIntent(jev.ask, "open youtube"))!.inputs).toEqual({});
    const maps = fakeJev({ launcher: "browser", site: "google_maps", text: "Google Maps" });
    expect((await quickIntent(maps.ask, "open Google Maps"))!.inputs).toEqual({});
  });

  test("leaves a site it does not know to the LLM", async () => {
    const jev = fakeJev({ launcher: "browser", site: "other_site", text: "nothing_to_type" });
    expect(await quickIntent(jev.ask, "open the new york times")).toBeNull();
  });

  test("leaves it to the LLM when unsure what to open", async () => {
    const jev = fakeJev({ launcher: { choice: "terminal", confidence: 0.3 }, site: "no_site", text: "nothing_to_type" });
    expect(await quickIntent(jev.ask, "do the thing")).toBeNull();
  });

  test("an unsure pick of words is dropped, not typed", async () => {
    const jev = fakeJev({ launcher: "browser", site: "google", text: { choice: "the", confidence: 0.2 } });
    expect((await quickIntent(jev.ask, "look up the"))!.inputs).toEqual({});
  });

  test("a local task has no url", async () => {
    const jev = fakeJev({ launcher: "files", site: "no_site", text: "tax return" });
    expect(await quickIntent(jev.ask, "find my tax return")).toMatchObject({ launcher: "files", url: null, inputs: { search_query: "tax return" } });
  });

  test("says nothing about nothing", async () => {
    const jev = fakeJev({});
    expect(await quickIntent(jev.ask, "  ... ")).toBeNull();
    expect(jev.calls).toHaveLength(0);
  });
});
