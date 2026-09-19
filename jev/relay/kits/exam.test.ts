import { expect, test } from "bun:test";
import type { Ask } from "../../jev";
import { groupBy } from "../relay";
import { ARCHIVES, questionsIn, shapeProblems, syllabusTopics, topicsOf } from "./exam";
import { reflow } from "./py";

const question = (n: number, marks: number) => `### Question ${n}. [${marks} marks]\n(a) Find the limit. [${marks - 2} marks]\n(b) Explain. [2 marks]\n`;
const examOf = (marks: number[], total: number) => `# Mock exam\n\n## Syllabus followed\n${["limits", "continuity", "derivatives", "applications"].map((t) => `- MATH 1013: ${t}`).join("\n")}\n${["integration", "series", "Taylor series"].map((t) => `- MATH 1014: ${t}`).join("\n")}\nhttps://www.math.hkust.edu.hk/outline/a.pdf\n\n## Instructions\nTime allowed: 3 hours\nTotal marks: ${total}\n\n${marks.map((m, i) => question(i + 1, m)).join("\n")}`;
const answersOf = (n: number) => Array.from({ length: n }, (_, i) => `### Question ${i + 1}.\nWorked.`).join("\n\n");
const sourcesOf = (n: number, urls: string[]) => `# Sources\n${urls.map((u) => `- paper ${u}`).join("\n")}\n\n| Question | Topic | Modelled on | What was taken |\n|---|---|---|---|\n${Array.from({ length: n }, (_, i) => `| ${i + 1} | limits | MIT | style |`).join("\n")}\n`;
const NOTES = { syllabus: "outline [https://www.math.hkust.edu.hk/outline/a.pdf]", papers: "MIT final [https://ocw.mit.edu/final.pdf]." };

test("questions are read from their headings, with marks and text", () => {
  const qs = questionsIn(examOf([8, 10, 6], 24));
  expect(qs.map((q) => [q.n, q.marks])).toEqual([[1, 8], [2, 10], [3, 6]]);
  expect(qs[0]!.text).toContain("Find the limit");
  expect(questionsIn("1. Answer all questions.\n2. No calculators.")).toEqual([]);
});

test("the syllabus section's bullets are the topics, and addresses are not topics", () => {
  const topics = syllabusTopics(examOf([8], 8));
  expect(topics).toHaveLength(7);
  expect(topics[0]).toBe("MATH 1013: limits");
  expect(syllabusTopics("# No such section")).toEqual([]);
});

test("a well-formed set of files has no shape problems", () => {
  const marks = Array.from({ length: 12 }, () => 8);
  const files = { "mock-exam.md": examOf(marks, 96), "answers.md": answersOf(12), "sources.md": sourcesOf(12, ["https://ocw.mit.edu/final.pdf"]) };
  expect(shapeProblems(files, NOTES)).toEqual([]);
});

test("marks that do not add up, a missing answer, a missing row and an address from memory are each named", () => {
  const marks = Array.from({ length: 12 }, () => 8);
  const files = { "mock-exam.md": examOf(marks, 100), "answers.md": answersOf(11), "sources.md": sourcesOf(11, ["https://ocw.mit.edu/final.pdf", "https://invented.example.edu/exam.pdf"]) };
  const problems = shapeProblems(files, NOTES).map((p) => `${p.file}: ${p.problem}`).join("\n");
  expect(problems).toContain("add up to 96 but the exam states a total of 100");
  expect(problems).toContain(`answers.md: There is no "### Question 12."`);
  expect(problems).toContain("sources.md: The mapping table has no row for question 12");
  expect(problems).toContain("https://invented.example.edu/exam.pdf is not in the research notes");
  expect(problems).not.toContain("https://ocw.mit.edu/final.pdf is not");
});

test("too few questions and parts that disagree with their heading are named", () => {
  const broken = examOf([8, 8], 16).replace("(b) Explain. [2 marks]", "(b) Explain. [5 marks]");
  const problems = shapeProblems({ "mock-exam.md": broken, "answers.md": answersOf(2), "sources.md": sourcesOf(2, []) }, NOTES).map((p) => p.problem).join("\n");
  expect(problems).toContain("Only 2 questions");
  expect(problems).toContain("Question 1: its parts carry 6 + 5 = 11 marks but its heading says 8");
});

test("Jev's topic per question comes back as the topic's text, or null for none", async () => {
  const fake: Ask = (async (_state: unknown, questions: Record<string, { criteria: Record<string, string> }>) =>
    Object.fromEntries(Object.entries(questions).map(([name, q], i) => [name, { type: "choice", choice: i === 0 ? Object.keys(q.criteria)[1] : "none", confidence: 0.9 }]))) as unknown as Ask;
  const picked = await topicsOf(fake, questionsIn(examOf([8, 8], 16)), ["MATH 1013: limits", "MATH 1014: series"]);
  expect(picked).toEqual(["MATH 1014: series", null]);
});

test("the archives are front doors, not papers", () => {
  for (const a of ARCHIVES) expect(a.url).not.toMatch(/\.pdf($|\?)/i);
});

test("groupBy keeps first-seen order", () => {
  expect(groupBy([{ f: "b" }, { f: "a" }, { f: "b" }], (x) => x.f)).toEqual({ b: [{ f: "b" }, { f: "b" }], a: [{ f: "a" }] });
});

test("reflow gathers an exam's short lines into one passage per question", () => {
  const page = ["1. (10 points) Compute the following derivatives.", "(a) f(x) = x^3 e^x", "(b) the seventh derivative of sin(2x)", "and simplify your answer as far as you can, showing every step of the work.", "",
    "2. (10 points) Find the tangent line to y = 3x^2 - 5x + 2 at x = 2.", "Express your answer in the form y = mx + b, with slope m and intercept b, and justify each step you take."].join("\n");
  const passages = reflow([page]).split("\n\n");
  expect(passages).toHaveLength(2);
  expect(passages[0]).toStartWith("1. (10 points)");
  expect(passages[1]).toStartWith("2. (10 points)");
  expect(reflow(["", "   "])).toBe("");
});
