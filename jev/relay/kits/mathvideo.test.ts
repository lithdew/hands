import { expect, test } from "bun:test";
import { det, identity, inverse, parseMatrix, parseQ, product, q, sameMatrix, show, showMatrix, steps2x2, tex, texMatrix } from "./mathvideo/src/matrix";
import { FPS, TEMPLATE_NAMES, briefOfTemplates, check, facts, screen, stillsOf, storyboard, type Scene, type Script } from "./mathvideo/src/script";
import { problemsFrom, type SceneVerdict } from "./mathvideo";

const M = (rows: unknown) => parseMatrix(rows, 2)!;

// ---------------------------------------------------------------- matrix.ts: exact arithmetic

test("rationals parse from numbers, decimals and fraction strings, in lowest terms", () => {
  expect(parseQ(3)).toEqual(q(3));
  expect(parseQ(-0.25)).toEqual(q(-1, 4));
  expect(parseQ("2/4")).toEqual(q(1, 2));
  expect(parseQ("−3/6")).toEqual(q(-1, 2)); // a typographic minus
  expect(parseQ("1/0")).toBeNull();
  expect(parseQ("two")).toBeNull();
  expect(parseQ(Math.PI)).toBeNull();
  expect(q(2, -4)).toEqual({ n: -1, d: 2 });
  expect(show(q(-1, 2))).toBe("−1/2");
  expect(tex(q(-3, 4))).toBe("-\\frac{3}{4}");
});

test("a matrix must be square, of the wanted size, and all numbers", () => {
  expect(parseMatrix([[1, 2], [3, 4]], 2)).not.toBeNull();
  expect(parseMatrix([[1, 2, 3], [4, 5, 6]], 2)).toBeNull();
  expect(parseMatrix([[1, 2], [3, "x"]], 2)).toBeNull();
  expect(parseMatrix([[1, 0, 0], [0, 1, 0], [0, 0, 1]], 2)).toBeNull();
  expect(parseMatrix("[[1,2],[3,4]]", 2)).toBeNull();
});

test("determinant, inverse and product are exact", () => {
  const A = M([[3, 1], [2, 2]]), inv = inverse(A)!;
  expect(det(A)).toEqual(q(4));
  expect(showMatrix(inv)).toBe("[[1/2, −1/4], [−1/2, 3/4]]");
  expect(sameMatrix(product(A, inv), identity(2))).toBe(true);
  expect(sameMatrix(product(inv, A), identity(2))).toBe(true);
  expect(inverse(M([[2, 1], [4, 2]]))).toBeNull();
  expect(det(M([["1/2", "1/3"], ["1/4", "1/5"]]))).toEqual(q(1, 60));
  const three = parseMatrix([[2, 0, 1], [1, 3, 2], [1, 1, 1]])!;
  expect(det(three)).toEqual(q(0 + 2 * (3 - 2) - 0 + 1 * (1 - 3)));
  const invertible = parseMatrix([[2, 0, 1], [1, 3, 2], [1, 1, 2]])!;
  expect(sameMatrix(product(invertible, inverse(invertible)!), identity(3))).toBe(true);
  expect(inverse(M([[0, 1], [1, 0]]))).toEqual(M([[0, 1], [1, 0]])); // needs a row swap
});

test("the steps of a 2x2 inverse are the ones the worked example shows", () => {
  const s = steps2x2(M([[2, 1], [1, 1]]));
  expect([s.ad, s.bc, s.det]).toEqual([q(2), q(1), q(1)]);
  expect(showMatrix(s.adjugate)).toBe("[[1, −1], [−1, 2]]");
  expect(showMatrix(s.inverse!)).toBe("[[1, −1], [−1, 2]]");
  expect(texMatrix(M([["1/2", 0], [0, 1]]))).toContain("\\\\[0.45em]");
});

// ---------------------------------------------------------------- script.ts: code's review

const scene = (extra: Partial<Scene> & { id: string; template: Scene["template"] }): Scene => ({ seconds: 10, narration: "Twenty two words of narration, give or take, so that ten seconds is a comfortable pace for a viewer to read along with.", ...extra });
const good = (): Script => ({ title: "t", scenes: [
  scene({ id: "open", template: "title", title: "A title", seconds: 10 }),
  scene({ id: "move", template: "transform", matrix: [[2, 1], [1, 1]] }),
  scene({ id: "back", template: "undo", matrix: [[2, 1], [1, 1]], inverse: [[1, -1], [-1, 2]] }),
  scene({ id: "size", template: "area", matrix: [[3, 1], [0, 2]], det: 6 }),
  scene({ id: "flat", template: "collapse", matrix: [[2, 1], [-2, -1]] }),
  scene({ id: "law", template: "equation", lines: ["AB = BA = I"] }),
  scene({ id: "work", template: "worked_inverse", matrix: [[3, 1], [2, 2]], det: 4, inverse: [["1/2", "-1/4"], ["-1/2", "3/4"]] }),
  scene({ id: "close", template: "recap", points: ["one", "two", "three"] }),
] });
const texts = (raw: unknown, tex?: (s: string) => string | null) => check(raw, tex).problems.map((p) => `${p.hard ? "HARD" : "soft"} ${p.text}`);

test("a correct script has no problems", () => {
  expect(texts(good())).toEqual([]);
  expect(check(good()).seconds).toBe(80);
});

test("wrong arithmetic comes back with the right value", () => {
  const s = good();
  s.scenes[3]!.det = 5;
  s.scenes[2]!.inverse = [[1, -1], [-1, 1]];
  s.scenes[6]!.inverse = [[0.5, -0.25], [-0.5, 0.7]];
  const found = texts(s).join("\n");
  expect(found).toContain(`HARD Scene 4 ("size"): "det" is wrong: the determinant of [[3, 1], [0, 2]] is 6, not 5.`);
  expect(found).toContain(`Scene 3 ("back"): "inverse" is wrong: the inverse of [[2, 1], [1, 1]] is [[1, −1], [−1, 2]]`);
  expect(found).toContain(`Scene 7 ("work"): "inverse" is wrong`);
});

test("templates get the matrices they can show", () => {
  const s = good();
  s.scenes[4]!.matrix = [[2, 1], [1, 1]];       // collapse needs determinant 0
  s.scenes[2]!.matrix = [[1, 2], [2, 4]];       // undo needs an inverse
  s.scenes[1]!.matrix = [[5, 1], [1, 1]];       // leaves the screen
  s.scenes[3] = scene({ id: "size", template: "area", matrix: [[1, 2], [2, 4]], det: 0 });
  const found = texts(s).join("\n");
  expect(found).toContain(`the "collapse" template needs a matrix with determinant 0; [[2, 1], [1, 1]] has determinant 1`);
  expect(found).toContain(`[[1, 2], [2, 4]] has determinant 0 and no inverse`);
  expect(found).toContain(`must lie between -3 and 3`);
  expect(found).toContain(`the "collapse" template shows that case`);
});

test("shape: unknown templates, missing and unknown parameters, bad LaTeX, never a throw", () => {
  expect(texts(null)[0]).toStartWith("HARD video/script.json must be a JSON object");
  expect(texts({ scenes: "no" })[0]).toStartWith("HARD");
  const s = good();
  (s.scenes[1] as Record<string, unknown>).template = "zoom";
  delete s.scenes[5]!.lines;
  s.scenes[7]!.colour = "red";
  s.scenes[0]!.id = "move";
  const found = texts(s).join("\n");
  expect(found).toContain(`"template" is "zoom"; it must be one of ${TEMPLATE_NAMES.join(", ")}`);
  expect(found).toContain(`HARD Scene 6 ("law"): the "equation" template needs "lines"`);
  expect(found).toContain(`soft Scene 8 ("close"): the "recap" template has no parameter "colour"`);
  const bad = good(); bad.scenes[5]!.lines = ["\\frac{1}{"];
  expect(texts(bad, (latex) => latex.includes("\\frac{1}{") && !latex.includes("}}") ? "Expected '}'" : null).join("\n")).toContain("KaTeX cannot typeset");
  const twice = good(); twice.scenes[1]!.id = "open";
  expect(texts(twice).join("\n")).toContain("the id is used twice");
});

test("timing is code's arithmetic: pace per scene and the total", () => {
  const s = good();
  s.scenes[1]!.seconds = 5;                                      // 23 words in 5 s
  s.scenes[5]!.narration = "Only six words are said here.";      // 6 words in 10 s
  const found = texts(s).join("\n");
  expect(found).toContain(`soft Scene 2 ("move"): 23 words of narration in 5 seconds is 4.6 words a second, too fast to follow. Give it at least 10 seconds`);
  expect(found).toContain(`Scene 6 ("law"): 6 words of narration in 10 seconds leaves the viewer waiting`);
  const short = good(); short.scenes = short.scenes.slice(0, 4);
  expect(texts(short).join("\n")).toContain("HARD The scenes add up to 40 seconds");
  const latex = good(); latex.scenes[1]!.narration += " So $A^{-1}$ exists.";
  expect(texts(latex).join("\n")).toContain("must not contain LaTeX");
});

test("facts and the screen description carry code's numbers, not the script's", () => {
  const s = scene({ id: "work", template: "worked_inverse", matrix: [[3, 1], [2, 2]], det: 99, inverse: [[9, 9], [9, 9]] });
  expect(facts(s).join(" ")).toContain("Its determinant is 3·2 − 1·2 = 6 − 2 = 4.");
  expect(facts(s).join(" ")).toContain("Its inverse is [[1/2, −1/4], [−1/2, 3/4]]");
  expect(screen(s)).toContain("A⁻¹ = [[1/2, −1/4], [−1/2, 3/4]]");
  expect(screen(s)).not.toContain("99");
  expect(facts(scene({ id: "flat", template: "collapse", matrix: [[2, 1], [-2, -1]] })).join(" ")).toContain("no inverse");
  expect(facts(scene({ id: "flip", template: "area", matrix: [[1, 2], [2, 1]], det: -3 })).join(" ")).toContain("area 3; the determinant is negative");
  expect(facts(scene({ id: "v", template: "transform", matrix: [[1, -1], [1, 2]], vector: [1, 1] })).join(" ")).toContain("The vector (1, 1) lands on (0, 3).");
  expect(facts(scene({ id: "law", template: "equation", lines: ["x"] }))).toEqual([]);
});

test("stills: one per scene that shows mathematics, inside its scene, named in order", () => {
  const stills = stillsOf(good());
  expect(stills.map((s) => s.name)).toEqual(["02-move.png", "03-back.png", "04-size.png", "05-flat.png", "06-law.png", "07-work.png", "08-close.png"]);
  expect(stills[0]!.frame).toBe(10 * FPS + Math.floor(10 * FPS * 0.8));
  expect(stills.every((s, i) => s.frame >= (i + 1) * 10 * FPS && s.frame < (i + 2) * 10 * FPS)).toBe(true);
});

test("the brief and the storyboard are generated from the same table the checker uses", () => {
  for (const name of TEMPLATE_NAMES) expect(briefOfTemplates()).toContain(`"${name}"`);
  const board = storyboard(good());
  expect(board).toContain("8 scenes, 80 seconds");
  expect(board).toContain("## 7. work — template `worked_inverse`, 60–70 s");
  expect(board).toContain("**Computed by code, not by a model.**");
});

// ---------------------------------------------------------------- Jev's verdicts become feedback only when they are firm

test("Jev's review: a firm mismatch is reported; near-templates and weak doubts are not", () => {
  const script = good(), v = (id: string, template: SceneVerdict["template"], over: Partial<SceneVerdict>): SceneVerdict => ({ id, template, picked: template, confidence: 0.9, matches: 0.9, numbers: null, oneIdea: 0.9, ...over });
  expect(problemsFrom(script.scenes.map((s) => v(s.id, s.template, {})), script)).toEqual([]);
  expect(problemsFrom([v("move", "transform", { picked: "area", confidence: 0.95, matches: 0.5 })], script)).toEqual([]);          // both are a plane under one matrix
  expect(problemsFrom([v("law", "equation", { picked: "collapse", confidence: 0.6, matches: 0.5 })], script)).toEqual([]);         // not firm
  expect(problemsFrom([v("law", "equation", { picked: "collapse", confidence: 0.95, matches: 0.2 })], script)[0]).toContain(`reads like a "collapse" scene`);
  expect(problemsFrom([v("size", "area", { matches: 0.1 })], script)[0]).toContain("does not talk about what is on screen");
  expect(problemsFrom([v("size", "area", { numbers: 0.05 })], script)[0]).toContain("Its determinant is 3·2 − 1·0 = 6 − 0 = 6.");
  expect(problemsFrom([v("size", "area", { oneIdea: 0.1 })], script)[0]).toContain("more than one point");
});
