// The pure parts of the pitch-video kit: passages and addresses, the script's shape and timing, figures
// against their source, and the review with a scripted Jev. The content here is made up (a plant robot).
import { describe, expect, test } from "bun:test";
import type { Ask } from "../../../jev";
import type { Workspace } from "../../relay";
import { address, passages, resolve, sentences, shown } from "./docs";
import { batches, candidates, claimVerdict, claimsMd, review } from "./review";
import { WPM, numbersIn, numbersMissing, parseScript, secondsFor, sentencesOf, shownText, timing, words, type Script } from "./script";

const DOC = `# Acme

Intro paragraph that is long enough to be kept as a passage of its own, yes.

## Results

| strategy | solved | round trips |
| --- | --- | --- |
| \`old\`: one action per look | 3/18 | 20.4 |
| **new**: one request per screen | 18/18 | 5.6 |

- **Deep links skip the form.** An email is 4 round trips in \`quick.ts\`, and
  the second line continues the item with 4,900 requests.
- short

\`\`\`sh
bun run something --that-is-code and should never be a passage at all
\`\`\`

So:
`;

describe("docs", () => {
  const ps = passages(DOC, "docs/a.md");
  test("paragraphs, list items and tables become passages with file:line addresses; code and scraps do not", () => {
    expect(ps.map(address)).toEqual(["docs/a.md:3", "docs/a.md:7", "docs/a.md:12"]);
    expect(passages(`${"The run in quick.ts took 5.6 round trips. ".repeat(40)}`, "b.md").map(address).slice(0, 3)).toEqual(["b.md:1", "b.md:1b", "b.md:1c"]);
    expect(ps[1]!.text).toBe("Table (strategy). old: one action per look; solved: 3/18; round trips: 20.4 | new: one request per screen; solved: 18/18; round trips: 5.6");
    expect(ps[2]!.text).toContain("An email is 4 round trips in quick.ts, and the second line continues");
    expect(ps[1]!.heading).toBe("Acme > Results");
    expect(shown(ps[1]!)).toStartWith("[docs/a.md:7] (Results) Table");
  });
  test("an address resolves by any line the passage spans, in the forms a model writes", () => {
    expect(resolve(ps, "docs/a.md:10").map(address)).toEqual(["docs/a.md:7"]);
    expect(resolve(ps, "[docs/a.md:13]").map(address)).toEqual(["docs/a.md:12"]);
    expect(resolve(ps, "docs/a.md:12b").map(address)).toEqual(["docs/a.md:12"]);
    expect(resolve(ps, "docs/a.md, line 3")).toHaveLength(1);
    expect(resolve(ps, "docs/a.md#L12")).toHaveLength(1);
    expect(resolve(ps, "docs/a.md")).toEqual([]);
    expect(resolve(ps, "docs/b.md:3")).toEqual([]);
  });
  test("a long paragraph splits at sentences, not at file names or decimals", () => {
    const runs = sentences(`${"The run in quick.ts took 5.6 round trips. ".repeat(10)}`, 120);
    expect(runs.length).toBeGreaterThan(3);
    expect(runs.every((r) => r.endsWith("trips."))).toBe(true);
  });
});

describe("figures", () => {
  test("numbers are read as digits, with thousands, fractions and number words; names are not numbers", () => {
    expect(numbersIn("4,900 requests, 18/18 solved, 98%, nine tasks, 2.3 s, F8 and e7, gpt-5.6")).toEqual(["4900", "18", "18", "98", "2.3", "5.6", "9"]);
  });
  test("a figure the source does not state is missing, however it was derived", () => {
    expect(numbersMissing("from 78% to 98%, 20 points better", "all: 78% ... all: 98%")).toEqual(["20"]);
    expect(numbersMissing("nine tasks, 9/9", "nine spoken tasks; solved: 9/9")).toEqual([]);
    expect(numbersMissing("98.0% of 141", "98% over 141 decisions")).toEqual([]);
  });
});

const scene = (over: Record<string, unknown>) => ({ id: "s", template: "close", headline: "A headline", narration: "word ".repeat(24).trim(), claims: [], ask: "Try it", ...over });
const script = (scenes: unknown[]) => JSON.stringify({ title: "Acme", scenes });
const LIST = { template: "list", items: [{ title: "a", detail: "b" }, { title: "c", detail: "d" }, { title: "e", detail: "f" }] };

describe("script", () => {
  test("each template says what it needs, in words for the writer", () => {
    const r = parseScript(script([scene({ template: "stat" }), scene({ template: "stat", stat: { value: "98% of all cases", label: "l", scope: "s" } }), scene({ template: "poster" }), scene({ template: "list", items: [{ title: "a", detail: "b" }] })]));
    expect(r.problems).toEqual([
      `scene 1 (s), template "stat": needs "stat": { value, label, scope }`,
      `scene 2 (s), template "stat": "stat.value" must be the figure alone, at most 9 characters ("98%", "5.6", "18/18"); put the rest in "stat.label"`,
      `scene 3 (s): "template" must be one of title, problem, stat, compare, how, list, demo, close`,
      `scene 4 (s), template "list": needs "items": three to six of { title, detail }`]);
  });
  test("not JSON, fenced JSON, a claim with one `source`", () => {
    expect(parseScript("{").problems[0]).toStartWith("video/script.json is not valid JSON");
    const r = parseScript("```json\n" + script([scene({ claims: [{ text: "c", source: "docs/a.md:3" }, { text: "" }] })]) + "\n```");
    expect(r.problems).toEqual([]);
    expect(r.script!.scenes[0]!.claims).toEqual([{ text: "c", sources: ["docs/a.md:3"] }]);
  });
  test("code sets the seconds from the words, so the pace is always the speaking rate", () => {
    expect(secondsFor("word ".repeat(155))).toBe(60);
    const s = parseScript(script(Array.from({ length: 8 }, (_, i) => scene({ id: `s${i}`, narration: "word ".repeat(30).trim(), ...(i < 7 ? LIST : {}) })))).script!;
    const t = timing(s);
    expect(t).toMatchObject({ problems: [], words: 240, wpm: WPM });
    expect(s.scenes[0]!.seconds).toBe(11.6);
    expect(timing(parseScript(script([scene({ narration: "too short" })])).script!).problems).toHaveLength(3);
    expect(timing(parseScript(script([scene({ template: "title", sub: "s" }), scene({ template: "title", sub: "s" }), scene({}), scene({ ...LIST })])).script!).problems.slice(0, 2)).toEqual([
      `the "title" template is used 2 times; it is the opening and is used once (introduce the product with "list", "how" or "problem" instead)`, `the last scene, and only the last, uses the "close" template`]);
  });
  test("words, sentences and everything a scene shows", () => {
    expect(words("Nine tasks — 9/9, in 5.6 round trips.")).toBe(7);
    expect(sentencesOf("It took 5.6 trips. \"Then\" it stopped! Why?")).toEqual(["It took 5.6 trips.", "\"Then\" it stopped!", "Why?"]);
    expect(shownText(parseScript(script([scene({ template: "stat", stat: { value: "98%", label: "right", scope: "141 cases" } })])).script!.scenes[0]!)).toContain("141 cases");
  });
});

// ---------------------------------------------------------------- review, with a scripted Jev

const index = passages(DOC, "docs/a.md");
const fakeWs = (json: string): Workspace => { const ws: Workspace = { dir: "/nowhere", notes: {}, sources: {}, counts: {}, files: { "video/script.json": json }, log: () => {}, async write(path, content) { ws.files[path] = content; } }; return ws; };
/** Supports a claim when its passage contains the claim's first long word; never inflated; every sentence covered; picks the first label. */
const jev = (seen: string[][]): Ask => (async (_state: unknown, questions: Record<string, { type: string; instructions: string; criteria?: Record<string, string> }>) => {
  seen.push(Object.keys(questions));
  return Object.fromEntries(Object.entries(questions).map(([name, q]) => {
    if (q.type === "choice") { const labels = Object.keys(q.criteria!), hit = labels.find((l) => /^p\d+$/.test(l) && q.criteria![l]!.includes("Deep links")); return [name, { type: "choice", choice: hit ?? labels[0]!, confidence: 0.9 }]; }
    const claim = /The claim: "([^"]*)"/.exec(q.instructions)?.[1] ?? "", passage = /The passage: "(.*)"$/.exec(q.instructions)?.[1] ?? "", key = claim.match(/[a-z]{6,}/i)?.[0] ?? "";
    return [name, { type: "noul", noul: name.startsWith("s") ? (passage.includes(key) ? 0.9 : 0.1) : name.startsWith("x") ? 0.1 : name.startsWith("f") ? 0.9 : 0.9 }];
  }));
}) as unknown as Ask;

const body = (n: number) => `${"word ".repeat(n - 1)}end.`;
const good = (claims: unknown[], narration = body(30)) => script(Array.from({ length: 8 }, (_, i) => scene({ id: `s${i}`, narration: i ? body(30) : narration, claims: i ? [] : claims, ...(i < 7 ? LIST : {}) })));

describe("review", () => {
  test("a claim whose figures are in its passage and that Jev finds supported holds; claims.md quotes the file", async () => {
    const ws = fakeWs(good([{ text: "The new strategy solved 18/18 in 5.6 round trips", sources: ["docs/a.md:7"] }], `The new strategy solved 18/18 in 5.6 round trips. ${body(20)}`)), seen: string[][] = [];
    const r = await review(ws, jev(seen), index);
    expect(r.problems).toEqual([]);
    expect(r.checks[0]).toMatchObject({ ok: true, missing: [] });
    expect(ws.files["video/claims.md"]).toContain("`docs/a.md` line 7 to 10");
    expect(ws.files["video/claims.md"]).toContain("new: one request per screen; solved: 18/18; round trips: 5.6");
    expect(JSON.parse(ws.files["video/script.json"]!).scenes[0].seconds).toBe(secondsFor(`The new strategy solved 18/18 in 5.6 round trips. ${body(20)}`));
    expect(r.jev.requests).toBe(seen.length);
  });
  test("a figure that is not in the cited passage: the writer is asked to mend it, shown its script and what is wrong", async () => {
    const bad = good([{ text: "The new strategy is 4 times better at 18/18", sources: ["docs/a.md:3"] }], `It is 7 times better. ${body(24)}`), asked: string[][] = [];
    const fixed = good([{ text: "The new strategy solved 18/18", sources: ["docs/a.md:7"] }], `The new strategy solved 18/18. ${body(24)}`);
    const r = await review(fakeWs(bad), jev([]), index, async (mine, problems) => { asked.push(problems); expect(JSON.parse(mine).scenes[0].narration).toStartWith("It is 7 times"); return fixed; });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.some((p) => p.includes("the numbers 4, 18 are not in the cited passage"))).toBe(true);
    expect(asked[0]!.some((p) => p.startsWith(`scene "s0": 7 is said or shown there`))).toBe(true);
    expect(r).toMatchObject({ problems: [], mends: 1, dropped: [] });
  });
  test("what still cannot be tied to a source line is dropped by code: the claim, and the sentence with its figure", async () => {
    const ws = fakeWs(good([{ text: "The new strategy is 4 times better at 18/18", sources: ["docs/a.md:3"] }, { text: "The new strategy solved 18/18", sources: ["docs/a.md:7"] }], `It is 7 times better. It solved 18/18. ${body(24)}`));
    const r = await review(ws, jev([]), index, async () => null);
    expect(r.dropped).toEqual([`scene "s0": the claim "The new strategy is 4 times better at 18/18" (not tied to a source line)`, `scene "s0": the sentence "It is 7 times better."`]);
    expect(r.problems).toEqual([]);
    const s0 = JSON.parse(ws.files["video/script.json"]!).scenes[0];
    expect(s0.claims.map((c: { text: string }) => c.text)).toEqual(["The new strategy solved 18/18"]);
    expect(s0.narration).toStartWith("It solved 18/18.");
    expect(ws.files["video/claims.md"]).not.toContain("NOT VERIFIED");
  });
  test("a wrong citation is repaired by Jev's choice among the passages that could hold the claim, then checked again", async () => {
    const ws = fakeWs(good([{ text: "Deep links make an email 4 round trips", sources: ["docs/a.md:3"] }], `Deep links make an email 4 round trips. ${body(22)}`));
    const r = await review(ws, jev([]), index);
    expect(r.notes[0]).toContain("Jev found it in docs/a.md:12");
    expect(r.checks[0]).toMatchObject({ ok: true, repaired: "docs/a.md:12" });
    expect(JSON.parse(ws.files["video/script.json"]!).scenes[0].claims[0].sources).toEqual(["docs/a.md:12"]);
    expect(r.problems).toEqual([]);
  });
  test("no source, an address that is no passage, no script", async () => {
    const r = await review(fakeWs(good([{ text: "Something unsourced about gardens", sources: [] }, { text: "Something else about gardens", sources: ["README.md:999"] }])), jev([]), index);
    expect(r.dropped).toHaveLength(2);
    expect(r.checks).toEqual([]);
    expect((await review(fakeWs(""), jev([]), index)).problems).toEqual(["video/script.json was not written"]);
  });
  test("verdict, candidates, batches, claims.md for an unverified claim", () => {
    expect([claimVerdict(0.9, 0.1, []), claimVerdict(0.9, 0.1, ["7"]), claimVerdict(0.4, 0.1, []), claimVerdict(0.9, 0.8, [])]).toEqual([true, false, false, false]);
    expect(candidates(index, "solved 18/18 in 5.6").map(address)).toEqual(["docs/a.md:7"]);
    expect(candidates(index, "deep links skip the email form").map(address)).toEqual(["docs/a.md:12"]);
    expect(batches([10, 10, 10, 25, 1], (n) => n, 25)).toEqual([[10, 10], [10], [25], [1]]);
    const s = parseScript(good([])).script as Script;
    expect(claimsMd(s, [{ scene: "s0", claim: { text: "c", sources: ["x.md:1"] }, passages: [], missing: [], supported: 0, inflated: 0, ok: false }], { requests: 1, questions: 2 })).toContain("NOT VERIFIED");
  });
});
