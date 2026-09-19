// kits/exam.ts — a mock exam modelled on past papers.
//
// Past papers are not found by searching for them: they sit in archives, two or three links below a
// department's front page, mostly as PDFs. So this kit gives research the front doors (ARCHIVES: places
// to look, never a paper or a syllabus), lets the relay follow links from them with Jev sifting every
// link (`follow`), and reads the PDFs (py.ts). What the run finds, it finds by reading those pages; a
// door that is shut (a collection behind a login, a scan with no text) is reported as shut.
//
// Then the build holds the exam to what can be checked exactly, and sends what fails back to the writer:
//   code    the shape (numbered questions, marks that add up, an answer and a mapping row for each), and
//           that every address in sources.md is one the research notes hold (none from memory) and opens
//   sympy   the answer key (check_answers.py): derivatives, integrals, limits, sums, Taylor polynomials
//   Jev     every question against the syllabus the exam itself states, in one request: which topic it
//           examines, or none; code then counts the coverage of each course
import { join } from "node:path";
import { choice, type Ask, type Questions } from "../../jev";
import type { Kit, Workspace } from "../relay";
import { alive, type Result } from "../web";
import { pdfText, runPython } from "./py";

/** Front doors only: where universities keep course outlines and old exams. Each is an index to be sifted, not a source to cite unread. */
export const ARCHIVES: Result[] = [
  { title: "HKUST Department of Mathematics: undergraduate programmes and courses", url: "https://www.math.hkust.edu.hk/ug", snippet: "HKUST mathematics department's undergraduate page: courses, course outlines, announcements." },
  { title: "HKUST Department of Mathematics: course outlines by term", url: "https://www.math.hkust.edu.hk/outline/", snippet: "Index of HKUST MATH course outline documents (syllabus, topics, assessment) for each term." },
  { title: "HKUST Program and Course Catalog: MATH undergraduate courses", url: "https://prog-crs.hkust.edu.hk/ugcourse/2025-26/MATH", snippet: "HKUST's official catalogue descriptions of undergraduate MATH courses, including first-year calculus." },
  { title: "MIT OpenCourseWare 18.01SC Single Variable Calculus: exams", url: "https://ocw.mit.edu/courses/18-01sc-single-variable-calculus-fall-2010/pages/final-exam/", snippet: "MIT single variable calculus: unit exams and final exam with solutions." },
  { title: "MIT OpenCourseWare 18.01 Single Variable Calculus (2006): exams", url: "https://ocw.mit.edu/courses/18-01-single-variable-calculus-fall-2006/pages/exams/", snippet: "MIT 18.01 practice and actual exams with solutions." },
  { title: "UC Berkeley Department of Mathematics: exam archive", url: "https://math.berkeley.edu/courses/archives/exams", snippet: "Berkeley mathematics past exams by course, including Math 1A and 1B calculus." },
  { title: "Purdue University Department of Mathematics: past exam archive", url: "https://www.math.purdue.edu/academic/courses/oldexams.php", snippet: "Purdue past exams by course, including first-year calculus (MA 161, 162, 165, 166)." },
  { title: "University of Washington Math 124 (Calculus I): materials and exam archive", url: "https://sites.math.washington.edu/~m124/", snippet: "University of Washington Math 124 course materials, old midterms and finals." },
  { title: "University of Washington Math 125 (Calculus II): materials and exam archive", url: "https://sites.math.washington.edu/~m125/", snippet: "University of Washington Math 125 course materials, old midterms and finals." },
];

const KEY = "notes/answers.check.json";
const BRIEF = `The deliverables are three markdown files and one answer key.
mock-exam.md: a title; a section "Syllabus followed" that names the HKUST courses and lists, one bullet per topic, the topics taken from HKUST's own course pages in the notes, each bullet starting with the course code ("- MATH 1013: limits and continuity") and the section ending with the addresses of those HKUST pages; instructions to candidates; "Time allowed: ..."; "Total marks: N"; then at least 12 questions, each under a heading of exactly this form on its own line: "### Question 7. [8 marks]". Parts are (a), (b) with their own marks in square brackets, adding up to the question's marks; the questions' marks add up to the total. Cover both courses: limits, derivatives and their applications, integration and its techniques, sequences and series. Mix routine questions with a few harder ones. Every question must be well posed and solvable by hand, with every quantity defined.
answers.md: for every question a heading "### Question 7." and a worked solution for each part that ends in a clearly stated final answer. Work each one out step by step and check it (differentiate your antiderivatives, substitute your solutions back).
sources.md: (1) the HKUST course pages used, (2) the past papers used, each as a bullet with what it is (university, course, year or term, which exam) and its address, given exactly as in the notes; only papers and pages that the notes show were opened and read; (3) a table "| Question | Topic | Modelled on | What was taken |" with a row for every question, naming the listed paper or papers whose style or topic inspired it (write new questions in that style: never copy a question's wording or numbers); (4) last, a section "Not found or not opened" that says plainly what the notes report as missing, unreadable, behind a login or not searched. Never write an address that is not in the notes, and never describe a paper beyond what the notes say about it.
${KEY}: a JSON array with one entry for every part whose final answer is a formula or a number: {"question": "7(a)", "kind": ..., "expr": ..., "var": "x", "claimed": ...} in sympy syntax (x**2 or x^2, exp(x), log(x) for ln, sqrt(x), pi, E, oo, asin/atan; variables x y t u; n k m for indices; no equations, no "+ C"). "claimed" must be exactly the final answer given in answers.md. Kinds: "derivative" (expr is the function; optional "order"), "antiderivative" (expr is the integrand; claimed is the antiderivative without + C), "definite_integral" (with "lower", "upper"; claimed may be "diverges"), "limit" (with "point", and "dir" "+" or "-" if one-sided; claimed may be "DNE"), "series_sum" (expr is the general term, with "lower"), "series_converges" (with "lower"; claimed is "converges" or "diverges"), "taylor" (with "point" and "order": claimed is the Taylor polynomial up to that degree), "value" (expr is an arithmetic expression for the quantity, written independently of claimed). Parts that are proofs, sketches or explanations have no entry.`;

const HINTS = `How to plan this kind of task.
Research reads a fixed set of university archives and course-outline indexes and follows their links (web search is often refused to scripts, so do not count on it); the step's goal is what a fast, literal reader sifts every link and passage against. So write each research goal as one concrete sentence naming what to look for (course codes, "course outline", "past midterm or final exam paper", the topics). Use separate research steps for: the HKUST syllabus (official course outlines and catalogue entries of MATH 1013 and MATH 1014, with their topic lists); HKUST past papers of those courses; other universities' past exam papers on differential calculus (limits, derivatives, applications); other universities' past exam papers on integral calculus, sequences and series.
Then two write steps: first the exam and its sources (mock-exam.md, sources.md), needing all research steps; then the answers (answers.md and ${KEY}), which needs the first write step and solves the exam as written. Then one build step.
An accept statement is checked by that same literal reader against the text produced: state one visible thing at a time ("The notes give the address of an HKUST course outline.", "mock-exam.md states the time allowed."). No counts above three, no "every" or "all", nothing about quality or correctness (the build checks those exactly). Where a step may honestly find nothing (HKUST past papers are usually behind a university login), accept either outcome: "The notes give addresses of HKUST past papers, or say plainly that none could be opened."`;

// ---------------------------------------------------------------- the shape of the files (pure; tested)

export type ExamQuestion = { n: number; marks: number | null; text: string };
const urlsIn = (text: string) => [...new Set([...text.matchAll(/https?:\/\/[^\s)>\]"'|]+/g)].map((m) => m[0].replace(/[.,;:]+$/, "")))];

/** The questions under "### Question N. [m marks]" headings, with their text. */
export function questionsIn(examMd: string): ExamQuestion[] {
  const heads = [...examMd.matchAll(/^#{1,4}\s*Question\s+(\d{1,2})\s*[.):]?\s*(?:\[\s*(\d{1,3})\s*marks?\s*\])?.*$/gim)];
  return heads.map((m, i) => ({ n: Number(m[1]), marks: m[2] ? Number(m[2]) : null, text: examMd.slice(m.index! + m[0].length, heads[i + 1]?.index ?? examMd.length).trim() }));
}

/** The topics the exam says it follows: the bullets of its "Syllabus followed" section. */
export function syllabusTopics(examMd: string): string[] {
  const head = /^#{1,4}\s*Syllabus followed.*$/im.exec(examMd);
  if (!head) return [];
  const rest = examMd.slice(head.index + head[0].length), section = rest.slice(0, rest.search(/^#{1,4}\s/m) < 0 ? rest.length : rest.search(/^#{1,4}\s/m));
  return [...section.matchAll(/^\s*[-*]\s+(.{6,200})$/gm)].map((m) => m[1]!.trim()).filter((t) => !/^https?:/i.test(t)).slice(0, 80);
}

/** What is wrong with the files' shape, by file. Exact things only; nothing here judges mathematics. */
export function shapeProblems(files: Record<string, string>, notes: Record<string, string>): { file: string; problem: string }[] {
  const out: { file: string; problem: string }[] = [], say = (file: string, problem: string) => out.push({ file, problem });
  const examMd = files["mock-exam.md"] ?? "", answersMd = files["answers.md"] ?? "", sourcesMd = files["sources.md"] ?? "";
  if (!examMd) say("mock-exam.md", "The file is missing.");
  if (!answersMd) say("answers.md", "The file is missing.");
  if (!sourcesMd) say("sources.md", "The file is missing.");
  if (!examMd) return out;

  const questions = questionsIn(examMd);
  if (questions.length < 12) say("mock-exam.md", `Only ${questions.length} questions have a heading of the form "### Question 7. [8 marks]"; at least 12 are needed.`);
  questions.forEach((q, i) => { if (q.n !== i + 1) say("mock-exam.md", `Question headings are not numbered 1, 2, 3, ... in order (found ${q.n} in position ${i + 1}).`); });
  for (const q of questions) {
    if (q.marks === null) { say("mock-exam.md", `Question ${q.n} has no marks in its heading ("### Question ${q.n}. [8 marks]").`); continue; }
    const parts = [...q.text.matchAll(/^\s*\(([a-h])\)[^\n]*?\[\s*(\d{1,3})\s*marks?\s*\]/gim)].map((m) => Number(m[2]));
    const sum = parts.reduce((a, b) => a + b, 0);
    if (parts.length > 1 && sum !== q.marks) say("mock-exam.md", `Question ${q.n}: its parts carry ${parts.join(" + ")} = ${sum} marks but its heading says ${q.marks}.`);
  }
  const total = /total(?:\s+marks)?\s*[:=]?\s*\**\s*(\d{2,3})/i.exec(examMd)?.[1], sum = questions.reduce((a, q) => a + (q.marks ?? 0), 0);
  if (!total) say("mock-exam.md", `The exam does not state its total ("Total marks: ${sum}").`);
  else if (Number(total) !== sum) say("mock-exam.md", `The questions' marks add up to ${sum} but the exam states a total of ${total}.`);
  if (!/time allowed/i.test(examMd)) say("mock-exam.md", `The exam does not state "Time allowed: ...".`);
  if (syllabusTopics(examMd).length < 6) say("mock-exam.md", `The "Syllabus followed" section must list the syllabus topics from the notes, one bullet per topic, each starting with its course code.`);

  for (const q of questions) if (answersMd && !new RegExp(`^#{1,4}\\s*Question\\s+${q.n}\\b`, "im").test(answersMd)) say("answers.md", `There is no "### Question ${q.n}." heading with a solution.`);
  if (sourcesMd) {
    for (const q of questions) if (!new RegExp(`^\\|\\s*(?:Q(?:uestion)?\\s*)?${q.n}\\s*\\|`, "im").test(sourcesMd)) say("sources.md", `The mapping table has no row for question ${q.n} (rows start "| ${q.n} |").`);
    // An address the research never saw is an address from memory.
    const known = new Set(urlsIn(Object.values(notes).join("\n")));
    for (const url of urlsIn(`${sourcesMd}\n${examMd}`)) if (!known.has(url)) say(sourcesMd.includes(url) ? "sources.md" : "mock-exam.md", `The address ${url} is not in the research notes. Remove it, or replace it with the address exactly as the notes give it.`);
  }
  return out;
}

// ---------------------------------------------------------------- the build

type KeyResult = { question: string; verdict: "ok" | "wrong" | "unverified"; detail: string };

/** Every question against the syllabus the exam states, in one Jev request. Returns the topic label per question, or null for "none of these". */
export async function topicsOf(ask: Ask, questions: ExamQuestion[], topics: string[]): Promise<(string | null)[]> {
  if (!questions.length || !topics.length) return questions.map(() => null);
  const labels = Object.fromEntries(topics.map((t, i) => [`t${i}`, t]));
  const asked: Questions = Object.fromEntries(questions.map((q) => [`q${q.n}`, choice(`Which syllabus topic does this exam question mainly examine? The question: ${JSON.stringify(q.text.slice(0, 700))}`, { ...labels, none: "None of these topics: the question needs something that is not on this list." })]));
  const answers = await ask({ syllabus: topics }, asked) as unknown as Record<string, { choice: string }>;
  return questions.map((q) => { const picked = answers[`q${q.n}`]!.choice; return picked === "none" ? null : labels[picked] ?? null; });
}

/** The relay hands the build its own counted `ask`, so what Jev does here shows in the trace. */
export async function build(ws: Workspace, tools: { ask: Ask }) {
  {
    const lines: string[] = [], repair = shapeProblems(ws.files, ws.notes);
    lines.push(`shape: ${repair.length ? `${repair.length} problems` : "ok"}`);
    const examMd = ws.files["mock-exam.md"] ?? "", sourcesMd = ws.files["sources.md"] ?? "", questions = questionsIn(examMd);

    // Addresses that are cited must open. One that does not belongs under "Not found or not opened", or nowhere.
    const cited = urlsIn(sourcesMd.split(/^#{1,4}\s*Not found or not opened/im)[0] ?? "");
    const dead = (await Promise.all(cited.map(async (url) => (await alive(url)) ? null : url))).filter((u): u is string => u !== null);
    for (const url of dead) repair.push({ file: "sources.md", problem: `The address ${url} does not open now. Move it under "Not found or not opened" and do not model a question on it alone.` });
    lines.push(`addresses: ${cited.length} cited, ${dead.length} do not open`);
    // Too few sources is not something a writer can repair, and padding the list would be worse than a short one. It is said, loudly.
    const host = (u: string) => URL.parse(u)?.hostname ?? "", hkust = cited.filter((u) => /(^|\.)(hkust\.edu\.hk|ust\.hk)$/.test(host(u))).length;
    const others = cited.filter((u) => /\.edu$|\.edu\.[a-z]{2}$|\.ac\.[a-z]{2}$/.test(host(u)) && !/hkust|ust\.hk/.test(host(u))).length;
    if (cited.length < 8 || hkust < 2 || others < 2) lines.push(`WARNING: sources.md cites ${cited.length} addresses (${hkust} HKUST, ${others} other universities); the request wants at least 8, 2 and 2. The research did not find more; none were added.`);

    // sympy on the key
    let key: unknown = null;
    try { key = JSON.parse(ws.files[KEY] ?? "null"); } catch { key = null; }
    // A missing key is a repair for whoever wrote the answers: the relay sends a problem to the step that wrote the named file.
    if (!Array.isArray(key) || !key.length) repair.push({ file: ws.files[KEY] === undefined && ws.files["answers.md"] !== undefined ? "answers.md" : KEY, problem: `${KEY} is missing or is not a JSON array; write it as the brief describes so the answers can be verified.` });
    else {
      const ran = await runPython("check_answers.py", [], JSON.stringify(key), 600_000);
      let results: KeyResult[] = [];
      try { results = JSON.parse(ran.stdout) as KeyResult[]; } catch { lines.push(`sympy: the checker failed: ${ran.stderr.slice(-300)}`); }
      const wrong = results.filter((r) => r.verdict === "wrong"), unverified = results.filter((r) => r.verdict === "unverified");
      lines.push(`sympy: ${results.filter((r) => r.verdict === "ok").length} answers verified, ${wrong.length} wrong, ${unverified.length} could not be checked (of ${key.length} in the key; ${questions.length} questions)`);
      for (const r of wrong) { const entry = (key as Record<string, unknown>[]).find((k) => String(k.question) === r.question); repair.push({ file: "answers.md", problem: `Question ${r.question}: the key claims ${JSON.stringify(entry?.claimed)} for ${entry?.kind} of ${JSON.stringify(entry?.expr)}, but ${r.detail}. Rework this part by hand; correct answers.md and the key (or the key's transcription, if answers.md was right).` }); }
      for (const r of unverified) lines.push(`  unverified ${r.question}: ${r.detail}`);
      await Bun.write(join(ws.dir, "notes", "answers.verified.json"), JSON.stringify(results, null, 2));
    }

    // Jev: each question against the syllabus the exam states
    const topics = syllabusTopics(examMd);
    if (questions.length && topics.length) {
      const picked = await topicsOf(tools.ask, questions, topics).catch(() => null);
      if (picked) {
        const courseOf = (topic: string) => /\b(MATH\s*\d{4})\b/i.exec(topic)?.[1]?.replace(/\s+/g, " ").toUpperCase() ?? "unlabelled";
        const tally: Record<string, number> = {};
        picked.forEach((topic, i) => { if (topic) tally[courseOf(topic)] = (tally[courseOf(topic)] ?? 0) + 1; else repair.push({ file: "mock-exam.md", problem: `Question ${questions[i]!.n} does not examine any topic in the exam's own "Syllabus followed" list. Replace it with a question on a listed topic (and update its answer, key entry and mapping row).` }); });
        lines.push(`syllabus (Jev, one request for ${questions.length} questions over ${topics.length} topics): ${Object.entries(tally).map(([c, n]) => `${c} ${n}`).join(", ") || "no question matched"}`);
        const courses = [...new Set(topics.map(courseOf))].filter((c) => c !== "unlabelled");
        for (const c of courses) if ((tally[c] ?? 0) < 3) repair.push({ file: "mock-exam.md", problem: `Only ${tally[c] ?? 0} questions examine ${c} topics; both courses must be covered. Replace some questions with ${c} questions.` });
      }
    }
    for (const r of repair) lines.push(`  REPAIR ${r.file}: ${r.problem}`);
    return { ok: repair.length === 0, log: lines.join("\n"), outputs: Object.keys(ws.files).filter((p) => !p.startsWith("notes/")), repair };
  }
}

export const exam: Kit = {
  name: "exam",
  brief: BRIEF,
  hints: HINTS,
  sources: async () => ARCHIVES,
  pdfText,
  follow: 2,
  repairs: 2,
  build,
};
