import { describe, expect, test } from "bun:test";
import { arxivId, arxivSearch, arxivTerms, countProblems, mendCitations, paperBullets, select, wordCount, type Candidate } from "./papers";

describe("arXiv asked the way it answers", () => {
  test("a typed query becomes the few terms that carry its topic", () => {
    expect(arxivTerms("site:arxiv.org reinforcement learning verifiable rewards reasoning 2025 2026")).toEqual(["reinforcement", "learning", "verifiable", "rewards", "reasoning"]);
    expect(arxivTerms("Recent survey of offline-to-online RL papers")).toEqual(["offline-to-online", "rl"]);
    expect(arxivTerms("world models, model-based reinforcement learning: Dreamer and beyond in robotics control planning")).toHaveLength(6);
  });
  test("one search for all of a step's queries: every term of any one of them, and only the last two years", () => {
    expect(arxivSearch([["world", "models"], ["latent", "planning"], ["world", "models"], []], 2025)).toBe("((all:world AND all:models) OR (all:latent AND all:planning)) AND submittedDate:[202501010000 TO 203412312359]");
  });
  test("the id of any arXiv address, or none", () => {
    expect(arxivId("https://arxiv.org/abs/2505.24760v2")).toBe("2505.24760");
    expect(arxivId("http://arxiv.org/pdf/2401.03301")).toBe("2401.03301");
    expect(arxivId("https://arxiv.org/html/2605.00416v2#S3")).toBe("2605.00416");
    expect(arxivId("https://openreview.net/forum?id=abc")).toBeNull();
  });
});

describe("select", () => {
  const c = (id: string, theme: string, score: number, recent = true): Candidate => ({ id, theme, score, recent });
  const opts = { perTheme: 2, most: 6, minRecent: 4, minThemes: 2 };
  test("the best of each theme in turn, within the most", () => {
    const got = select([c("a1", "a", 0.9), c("a2", "a", 0.8), c("a3", "a", 0.7), c("b1", "b", 0.5), c("b2", "b", 0.4), c("n1", "none", 0.99)], opts);
    expect(got.map((g) => g.id)).toEqual(["a1", "b1", "a2", "b2"]);
  });
  test("a theme of one paper is let go while enough themes remain", () => {
    const got = select([c("a1", "a", 0.9), c("a2", "a", 0.8), c("b1", "b", 0.5), c("b2", "b", 0.4), c("z1", "z", 0.95)], opts);
    expect(got.map((g) => g.theme)).not.toContain("z");
  });
  test("an old paper gives way to a recent one when too few are recent", () => {
    const got = select([c("a1", "a", 0.9, false), c("a2", "a", 0.8), c("a3", "a", 0.7), c("b1", "b", 0.6), c("b2", "b", 0.5), c("b3", "b", 0.4)], opts);
    expect(got.map((g) => g.id).sort()).toEqual(["a2", "a3", "b1", "b2"]);
  });
  test("never more than the most", () => {
    const many = ["a", "b", "c", "d"].flatMap((t) => [1, 2, 3].map((n) => c(`${t}${n}`, t, 1 - n / 10)));
    expect(select(many, { ...opts, perTheme: 3, most: 7 })).toHaveLength(7);
  });
});

const records = new Map([
  ["2505.24760", { title: "REASONING GYM: Reasoning Environments for RL [with Verifiable Rewards]", url: "https://arxiv.org/abs/2505.24760" }],
  ["2510.01460", { title: "The Three Regimes of Offline-to-Online Reinforcement Learning", url: "https://arxiv.org/abs/2510.01460" }],
]);
const file = `# Title

## Reasoning
Opening that mentions [Reasoning Gym](https://arxiv.org/abs/2505.24760) early.

- [Reasoning gym](https://arxiv.org/pdf/2505.24760v2) (2025): Supplies over 100 generators
  with verifiers.
- [An Invented Paper](https://arxiv.org/abs/2599.00001) (2025): Never fetched.
  It continues here.
- [The Three Regimes of Offline-to-Online Reinforcement Learning](https://arxiv.org/abs/2510.01460) (2025): Three regimes.

## Where the field is heading
See again [Three Regimes](https://arxiv.org/abs/2510.01460).
`;

describe("mendCitations", () => {
  const mended = mendCitations(file, records);
  test("the link stays in the bullet, with arXiv's exact title and abstract address; brackets cannot break the link", () => {
    expect(mended.text).toContain("- [REASONING GYM: Reasoning Environments for RL (with Verifiable Rewards)](https://arxiv.org/abs/2505.24760) (2025): Supplies");
    expect(mended.text).toContain("Opening that mentions Reasoning Gym early.");
    expect(mended.text).toContain("See again Three Regimes.");
  });
  test("a paper the run never fetched loses its whole bullet", () => {
    expect(mended.unknown).toEqual(["2599.00001"]);
    expect(mended.text).not.toContain("Invented");
    expect(mended.text).not.toContain("It continues here.");
  });
  test("a file that is already right is left alone", () => {
    expect(mendCitations(mended.text, records)).toEqual({ text: mended.text, unknown: [], mended: 0 });
  });
});

describe("paperBullets", () => {
  test("each bullet with its continuation lines, described without link or year", () => {
    const bullets = paperBullets(file);
    expect(bullets.map((b) => b.id)).toEqual(["2505.24760", "2599.00001", "2510.01460"]);
    expect(bullets[0]!.description).toBe("Supplies over 100 generators with verifiers.");
    expect([bullets[0]!.from, bullets[0]!.to]).toEqual([5, 6]);
    expect(bullets[2]!.description).toBe("Three regimes.");
  });
});

describe("countProblems", () => {
  const limits = { minWords: 10, maxWords: 60, minPapers: 2, minRecent: 1, minThemes: 1, perTheme: 4, most: 20 };
  const good = mendCitations(file, records).text;
  test("nothing to say about a file inside its limits", () => expect(countProblems(good, limits)).toEqual([]));
  test("too long, too few papers, too few themes, a paper with no bullet", () => {
    expect(countProblems(good, { ...limits, maxWords: 20 })[0]).toContain(`${wordCount(good)} words`);
    expect(countProblems(good, { ...limits, minPapers: 5 }).join(" ")).toContain("Only 2 distinct papers");
    expect(countProblems(good, { ...limits, minThemes: 2 }).join(" ")).toContain("Only 1 '## ' sections");
    expect(countProblems(`${good}\nAnd [Loose Paper Title](https://arxiv.org/abs/2601.00002) in passing.`, limits).join(" ")).toContain("2601.00002");
  });
});
