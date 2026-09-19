import { describe, expect, test } from "bun:test";
import { EXAM_SCHEMA_PROMPT, EXAM_TOPICS, ExamSchema, materializeExamBundle, type Exam } from "./exam";

/** Structural fixture only. These deliberately are not real exam deliverables. */
const examFixture = (): Exam => ({
  title: "Calculus I and II structural test fixture",
  academicScope: "HKUST MATH1013 and MATH1014 ordinary stream; current2026-27 catalog with older section outlines labeled separately.",
  durationMinutes: 180, totalMarks: 100,
  instructions: ["Show the intermediate steps and state any conditions."],
  questions: EXAM_TOPICS.map((topic, index) => {
    const marks = index < 4 ? 10 : index < 8 ? 8 : 7;
    return { id: `Q${index + 1}`, course: index < 4 ? "MATH1013" : "MATH1014", topic, marks,
      prompt: `Fixture prompt ${index + 1}: content is supplied by the author, never invented by the renderer.`,
      solution: `Fixture solution ${index + 1}: an independent reviewer must check mathematical reasoning; this fixture tests data bookkeeping only.`,
      markingGuide: [{ marks: marks - 2, criterion: "Credit the stated intermediate reasoning." }, { marks: 2, criterion: "Credit the final result and its conditions." }],
    };
  }),
  coverage: EXAM_TOPICS.map((topic, index) => ({ topic, questionIds: [`Q${index + 1}`], sourceIds: ["catalog"] })),
  sources: [{ id: "catalog", url: "https://prog-crs.hkust.edu.hk/ugcourse/2026-27/MATH", title: "Official HKUST undergraduate catalog", kind: "current_catalog", academicYear: "2026-27", usedFor: "Fixture provenance reference; actual retrieval and mathematical quality are reviewed separately." }],
  limitations: ["Structural test fixture; not a complete sourced exam and not a mathematical correctness verdict."],
});
const bundle = (exam = examFixture()) => ({ title: "Test bundle", entrypoint: "mock-exam.html", files: [{ path: "exam.json", content: JSON.stringify(exam) }, { path: "README.md", content: "Fixture notes remain unchanged." }] });

describe("single-source exam materialization", () => {
  test("creates printable HTML from authored data while retaining data and other files", () => {
    const input = bundle(), output = materializeExamBundle(input);
    expect(output.entrypoint).toBe("mock-exam.html");
    expect(output.files).toHaveLength(3);
    expect(output.files[0]).toEqual(input.files[0]);
    expect(output.files[1]).toEqual(input.files[1]);
    expect(input.files).toHaveLength(2);
    const html = output.files.find(file => file.path === "mock-exam.html")!.content;
    for (const text of ["Fixture prompt 1:", "Fixture solution 12:", 'id="questions"', 'id="solutions"', 'id="coverage"', 'id="sources"', "Marking guidance", "@media print", "break-before:page", "100", "180 min", "40 / 60", "not an official HKUST examination"]) expect(html).toContain(text);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick=");
    expect(EXAM_SCHEMA_PROMPT).toContain("Do not also generate mock-exam.html");
  });

  test("is a no-op for non-exam bundles and regenerates rather than trusting returned HTML", () => {
    const plain = { entrypoint: "index.html", files: [{ path: "index.html", content: "<h1>Another artifact</h1>" }] };
    expect(materializeExamBundle(plain)).toBe(plain);
    const input = bundle(); input.files.push({ path: "mock-exam.html", content: '<script src="https://evil.test/"></script>' });
    const output = materializeExamBundle(input);
    expect(output.files.filter(file => file.path === "mock-exam.html")).toHaveLength(1);
    expect(output.files.find(file => file.path === "mock-exam.html")!.content).not.toContain("evil.test");
  });

  test("escapes arbitrary authored text, links and math instead of executing markup", () => {
    const exam = examFixture();
    exam.title = 'Unsafe <img src=x onerror="alert(1)"> title';
    exam.questions[0]!.prompt = 'For x < 1 & y > 2, inspect <script>alert("oops")</script> as text.';
    exam.questions[0]!.solution = 'The literal inequality x < 1 stays readable. <math><mi>x</mi></math> is text, not executable markup.';
    exam.sources[0]!.title = '<svg onload="alert(2)">source</svg>';
    const html = materializeExamBundle(bundle(exam)).files.at(-1)!.content;
    expect(html).toContain("x &lt; 1 &amp; y &gt; 2");
    expect(html).toContain("&lt;script&gt;alert(&quot;oops&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;math&gt;&lt;mi&gt;x&lt;/mi&gt;&lt;/math&gt;");
    expect(html).not.toContain("<script"); expect(html).not.toContain("<svg"); expect(html).not.toContain("<img");
    exam.sources[0]!.url = "javascript:alert(1)";
    expect(() => ExamSchema.parse(exam)).toThrow("HTTP(S)");
  });

  test("requires exact total, time, question count and meaningful marking bookkeeping", () => {
    const wrongTotal = examFixture(); wrongTotal.questions[0]!.marks = 9;
    expect(() => ExamSchema.parse(wrongTotal)).toThrow("exactly 100");
    const wrongGuide = examFixture(); wrongGuide.questions[0]!.markingGuide[0]!.marks--;
    expect(() => ExamSchema.parse(wrongGuide)).toThrow("question is worth 10");
    expect(ExamSchema.safeParse({ ...examFixture(), durationMinutes: 90 }).success).toBe(false);
    expect(ExamSchema.safeParse({ ...examFixture(), totalMarks: 80 }).success).toBe(false);
    expect(ExamSchema.safeParse({ ...examFixture(), questions: examFixture().questions.slice(0, 11) }).success).toBe(false);
    const wrongSplit = examFixture(); wrongSplit.questions[4]!.course = "MATH1013";
    expect(() => ExamSchema.parse(wrongSplit)).toThrow("35–45");
    const emptyAnswer = examFixture(); emptyAnswer.questions[0]!.solution = "TODO";
    expect(ExamSchema.safeParse(emptyAnswer).success).toBe(false);
  });

  test("rejects missing topics, nonexistent references, duplicate IDs and unknown fields", () => {
    const missingTopic = examFixture(); missingTopic.questions[11]!.topic = EXAM_TOPICS[10];
    expect(() => ExamSchema.parse(missingTopic)).toThrow("No question has required primary topic simple_differential_equation_model");
    const badQuestion = examFixture(); badQuestion.coverage[0]!.questionIds = ["Q99"];
    expect(() => ExamSchema.parse(badQuestion)).toThrow("existing question IDs");
    const badSource = examFixture(); badSource.coverage[0]!.sourceIds = ["invented"];
    expect(() => ExamSchema.parse(badSource)).toThrow("existing source IDs");
    const duplicate = examFixture(); duplicate.questions[1]!.id = "Q1";
    expect(() => ExamSchema.parse(duplicate)).toThrow("Question IDs must be unique");
    expect(ExamSchema.safeParse({ ...examFixture(), script: "alert(1)" }).success).toBe(false);
  });

  test("malformed JSON and multiple exam files fail before materialization", () => {
    expect(() => materializeExamBundle({ entrypoint: "mock-exam.html", files: [{ path: "exam.json", content: "{" }] })).toThrow();
    const duplicate = bundle(); duplicate.files.push({ ...duplicate.files[0]! });
    expect(() => materializeExamBundle(duplicate)).toThrow("Exactly one exam.json");
  });
});
