import { z } from "zod";

export const EXAM_TOPICS = [
  "limits_and_continuity", "derivatives_and_chain_rule", "derivative_application_or_optimization", "fundamental_theorem_and_basic_integral",
  "integration_techniques", "integral_application_area_volume_or_work", "improper_integral", "sequence_and_series_convergence",
  "power_or_taylor_series_with_interval_or_error", "vectors_dot_and_cross_product", "parametric_or_polar_curve", "simple_differential_equation_model",
] as const;
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,59}$/);
const topic = z.enum(EXAM_TOPICS);
const source = z.object({
  id, url: z.url().refine(value => /^https?:\/\//i.test(value) && !new URL(value).username && !new URL(value).password, "Use a direct HTTP(S) source without credentials"),
  title: text(5, 300), kind: z.enum(["current_catalog", "historical_section_outline", "past_exam", "past_exam_with_solutions", "sample_exam"]),
  academicYear: text(4, 80), usedFor: text(12, 700),
}).strict();
const question = z.object({
  id, course: z.enum(["MATH1013", "MATH1014"]), topic, marks: z.number().int().min(1).max(25),
  prompt: text(12, 3000), solution: text(24, 7000),
  markingGuide: z.array(z.object({ marks: z.number().int().min(1).max(25), criterion: text(8, 900) }).strict()).min(1).max(12),
}).strict();

/** Content is authored by the generation agent. This validates its bookkeeping,
 * never its mathematical truth or source provenance; those need separate review. */
export const ExamSchema = z.object({
  title: text(8, 200), academicScope: text(30, 1500), durationMinutes: z.literal(180), totalMarks: z.literal(100),
  instructions: z.array(text(8, 350)).min(1).max(10).optional(),
  questions: z.array(question).min(12).max(24),
  coverage: z.array(z.object({ topic, questionIds: z.array(id).min(1).max(24), sourceIds: z.array(id).min(1).max(12) }).strict()).length(EXAM_TOPICS.length),
  sources: z.array(source).min(1).max(16), limitations: z.array(text(8, 1000)).min(1).max(15),
}).strict().superRefine((exam, ctx) => {
  const error = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const ids = new Set(exam.questions.map(q => q.id)), sourceIds = new Set(exam.sources.map(s => s.id));
  if (ids.size !== exam.questions.length) error(["questions"], "Question IDs must be unique");
  if (sourceIds.size !== exam.sources.length) error(["sources"], "Source IDs must be unique");
  const total = exam.questions.reduce((sum, q) => sum + q.marks, 0);
  if (total !== exam.totalMarks) error(["questions"], `Question marks sum to ${total}; exactly 100 are required`);
  const calc1 = exam.questions.filter(q => q.course === "MATH1013").reduce((sum, q) => sum + q.marks, 0);
  if (calc1 < 35 || calc1 > 45) error(["questions"], `MATH1013 has ${calc1} marks; use 35–45, with 55–65 for MATH1014`);
  for (const [index, q] of exam.questions.entries()) {
    const awarded = q.markingGuide.reduce((sum, item) => sum + item.marks, 0);
    if (awarded !== q.marks) error(["questions", index, "markingGuide"], `Marking guide awards ${awarded}; question is worth ${q.marks}`);
    if (!exam.coverage.some(row => row.topic === q.topic && row.questionIds.includes(q.id))) error(["questions", index, "topic"], "Every question must appear under its primary topic in coverage");
  }
  for (const name of EXAM_TOPICS) {
    if (exam.coverage.filter(row => row.topic === name).length !== 1) error(["coverage"], `Include exactly one coverage row for ${name}`);
    if (!exam.questions.some(q => q.topic === name)) error(["questions"], `No question has required primary topic ${name}`);
  }
  for (const [index, row] of exam.coverage.entries()) {
    if (new Set(row.questionIds).size !== row.questionIds.length || row.questionIds.some(value => !ids.has(value))) error(["coverage", index, "questionIds"], "Coverage must refer to unique existing question IDs");
    if (new Set(row.sourceIds).size !== row.sourceIds.length || row.sourceIds.some(value => !sourceIds.has(value))) error(["coverage", index, "sourceIds"], "Coverage must refer to unique existing source IDs");
  }
});
export type Exam = z.infer<typeof ExamSchema>;

export const EXAM_SCHEMA_PROMPT = `For this calculus exam, write the complete original content ONCE in exam.json. Do not also generate mock-exam.html; the trusted runtime renders it from exam.json and sets that entrypoint. Return the usual bundle with entrypoint "mock-exam.html", files [{path:"exam.json",content:<JSON string>},{path:"README.md",content:<brief usage/provenance notes>}], sources and limitations. Runtime materializes HTML before checking required files.
Exact exam.json schema (no extra fields):
{title:string,academicScope:string,durationMinutes:180,totalMarks:100,instructions?:string[],questions:[{id:string,course:"MATH1013"|"MATH1014",topic:TOPIC_ID,marks:integer,prompt:string,solution:string,markingGuide:[{marks:positive_integer,criterion:string}]}],coverage:[{topic:TOPIC_ID,questionIds:[string],sourceIds:[string]}],sources:[{id:string,url:string,title:string,kind:"current_catalog"|"historical_section_outline"|"past_exam"|"past_exam_with_solutions"|"sample_exam",academicYear:string,usedFor:string}],limitations:[string]}
Use 12–24 substantive original questions, total exactly100 marks, 180minutes, MATH1013 35–45marks and MATH1014 55–65marks. Every question's markingGuide marks must sum to its marks. Each question needs a worked solution with intermediate reasoning, domain/endpoints/convergence/constants/units as relevant; the renderer never supplies mathematical content. Use readable Unicode/plain-text math: ∫, Σ, lim, →, ∞, √, ×, ·, x², fractions such as (x+1)/(x−1), and clearly stated bounds. Do not use raw TeX delimiters, HTML, MathML markup or Markdown formatting in text fields; text is safely escaped, not interpreted. Newlines are supported. Use short IDs made of letters, digits, hyphen or underscore, starting with a letter.
Each of these12 TOPIC_IDs must be the primary topic of at least one question, and must have exactly one coverage row referencing existing question and source IDs: ${EXAM_TOPICS.join(", ")}.
Source kind and academicYear must distinguish the current2026-27 catalog, older section-specific outlines, actual past sittings, solutions containing questions, and sample exams. Source usedFor explains its actual influence on original topic/difficulty design, never copied questions. Limitations must state specific source/scope uncertainties; never claim an official HKUST exam, a prediction, current-section rules, or verified math merely because the renderer accepted JSON. Keep the data compact without shortening away necessary worked reasoning. An independent agent reviews content after rendering.`;

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const label = (value: string) => value.replaceAll("_", " ");
const paragraphs = (value: string) => value.split(/\n\s*\n/).map(part => `<p class="math-text">${escape(part)}</p>`).join("");

export function renderExam(exam: Exam): string {
  const calc1 = exam.questions.filter(q => q.course === "MATH1013").reduce((sum, q) => sum + q.marks, 0);
  const ids = new Map(exam.questions.map((q, index) => [q.id, index + 1]));
  const questions = exam.questions.map((q, index) => `<article class="question" id="q-${escape(q.id)}"><header><span class="number">${String(index + 1).padStart(2, "0")}</span><div><h3>${escape(label(q.topic))}</h3><p class="meta">${q.course} · ${q.marks} marks</p></div></header>${paragraphs(q.prompt)}<div class="answer-space" aria-hidden="true"></div></article>`).join("");
  const solutions = exam.questions.map((q, index) => `<article class="solution" id="solution-${escape(q.id)}"><header><span class="number">${String(index + 1).padStart(2, "0")}</span><div><h3>${escape(label(q.topic))}</h3><p class="meta"><a href="#q-${escape(q.id)}">Back to question ${index + 1}</a> · ${q.marks} marks</p></div></header>${paragraphs(q.solution)}<div class="marking"><h4>Marking guidance</h4><ol>${q.markingGuide.map(item => `<li><span>${escape(item.criterion)}</span><strong>${item.marks} ${item.marks === 1 ? "mark" : "marks"}</strong></li>`).join("")}</ol></div></article>`).join("");
  const coverage = exam.coverage.map(row => `<li><strong>${escape(label(row.topic))}</strong><span>${row.questionIds.map(qid => `<a href="#q-${escape(qid)}">Q${ids.get(qid)}</a>`).join(" · ")}<small>Scope sources: ${row.sourceIds.map(sourceId => `<a href="#source-${escape(sourceId)}">${escape(sourceId)}</a>`).join(", ")}</small></span></li>`).join("");
  const sources = exam.sources.map(s => `<li id="source-${escape(s.id)}"><div class="source-meta">${escape(label(s.kind))} · ${escape(s.academicYear)}</div><h3><a href="${escape(s.url)}" rel="noopener noreferrer">${escape(s.title)}</a></h3>${paragraphs(s.usedFor)}</li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(exam.title)}</title>
<style>
:root{color-scheme:light;--ink:#172b35;--muted:#566974;--paper:#fffefa;--line:#d7dfdd;--accent:#177b70;--wash:#ecf4f1}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#e7eeec;color:var(--ink);font:17px/1.65 "Segoe UI",system-ui,sans-serif}a{color:#08695f;text-underline-offset:3px}a:focus-visible{outline:3px solid #db7c30;outline-offset:4px}.sheet{max-width:1020px;margin:36px auto;background:var(--paper);box-shadow:0 18px 70px #15372d12;border:1px solid var(--line)}.cover{padding:56px 64px 38px;border-top:8px solid var(--accent)}.eyebrow{margin:0 0 12px;color:var(--accent);font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}h1{font:600 clamp(32px,4vw,48px)/1.12 Georgia,serif;letter-spacing:-.035em;margin:0 0 22px;max-width:18ch}h2{font:600 31px/1.2 Georgia,serif;letter-spacing:-.025em;margin:0 0 12px}h3{font-size:19px;line-height:1.3;margin:0;text-transform:capitalize}h4{font-size:14px;margin:0 0 10px}.scope{max-width:75ch;color:var(--muted);font-size:15px}.metrics{display:flex;flex-wrap:wrap;gap:12px 30px;margin:28px 0}.metrics span{display:grid;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.metrics b{font-size:26px;line-height:1.4;color:var(--ink);letter-spacing:-.03em}.notice{padding:14px 18px;border-left:3px solid var(--accent);background:var(--wash);font-size:14px}.nav{display:flex;flex-wrap:wrap;gap:12px 22px;border-block:1px solid var(--line);padding:17px 64px;font-size:14px;font-weight:600}.section{padding:40px 64px}.section+.section{border-top:1px solid var(--line)}.intro{margin:0 0 28px;color:var(--muted);font-size:15px}.instructions{padding-left:22px;font-size:15px}.question,.solution{margin:0;padding:30px 0;border-top:1px solid var(--line)}.question:first-of-type,.solution:first-of-type{border-top:0}.question header,.solution header{display:flex;gap:18px;align-items:flex-start;margin-bottom:18px}.number{font-size:23px;font-weight:600;line-height:1.3;color:var(--accent);font-variant-numeric:tabular-nums}.meta{margin:5px 0 0;color:var(--muted);font-size:12px}.math-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.85;margin:12px 0;font-family:"Cambria Math",Cambria,Georgia,serif;font-size:18px}.answer-space{height:70px;margin-top:18px;background:repeating-linear-gradient(transparent 0 32px,#cbd5d14d 32px 33px);border-bottom:1px solid #cbd5d14d}.marking{background:var(--wash);border-radius:6px;padding:18px 20px;margin-top:22px}.marking ol{margin:0;padding-left:20px}.marking li{padding:5px 0;font-size:14px}.marking li span{overflow-wrap:anywhere}.marking strong{display:block;font-size:12px;color:var(--accent)}.coverage{list-style:none;padding:0;margin:24px 0}.coverage>li{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:12px 26px;padding:15px 0;border-bottom:1px solid var(--line);font-size:14px}.coverage strong{text-transform:capitalize}.coverage small{display:block;margin-top:4px;font-size:12px;overflow-wrap:anywhere;color:var(--muted)}.sources{list-style:none;padding:0;margin:24px 0}.sources>li{border-top:1px solid var(--line);padding:20px 0}.source-meta{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:7px}.sources h3{font-size:16px;text-transform:none}.sources p{font:14px/1.7 "Segoe UI",system-ui,sans-serif}.limitations{padding-left:20px;color:var(--muted);font-size:14px}.footer{padding:24px 64px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}.page-break{break-before:page}
@media(max-width:640px){body{font-size:16px}.sheet{margin:0;border:0;box-shadow:none}.cover{padding:32px 22px 28px}.nav{padding:16px 22px;gap:10px 16px}.section{padding:30px 22px}.footer{padding:22px}.coverage>li{grid-template-columns:1fr;gap:5px}.question header,.solution header{gap:12px}.math-text{font-size:17px}.marking{padding:14px}.metrics{gap:15px 24px}h2{font-size:28px}}
@media print{@page{size:A4;margin:16mm 17mm}html{scroll-behavior:auto}body{background:white;font-size:11pt}.sheet{max-width:none;margin:0;border:0;box-shadow:none}.cover{padding:0 0 20px;border-top:4px solid var(--accent)}h1{font-size:29pt;max-width:22ch}h2{font-size:22pt}.nav{display:none}.section{padding:18px 0}.footer{padding:16px 0}.question,.solution{break-inside:avoid;padding:18px 0}.math-text{font-size:11.5pt;line-height:1.6}.answer-space{height:38mm}.marking{border:1px solid var(--line)}.marking li,.sources p,.limitations{font-size:9pt}.coverage>li{font-size:9pt}.notice,.scope,.instructions,.intro{font-size:10pt}.metrics b{font-size:19pt}.sources>li{break-inside:avoid}a{color:inherit;text-decoration:none}.page-break{break-before:page}}
</style></head><body><main class="sheet"><header class="cover"><p class="eyebrow">Hands · original diagnostic mock</p><h1>${escape(exam.title)}</h1><p class="scope">${escape(exam.academicScope)}</p><div class="metrics"><span><b>180 min</b>Suggested time</span><span><b>100</b>Total marks</span><span><b>${exam.questions.length}</b>Questions</span><span><b>${calc1} / ${100 - calc1}</b>Calc I / Calc II marks</span></div><p class="notice">Original practice material. This is not an official HKUST examination, a prediction of an upcoming paper, or a statement of your section’s current exam rules.</p></header><nav class="nav" aria-label="Exam sections"><a href="#questions">Question paper</a><a href="#solutions">Worked solutions</a><a href="#coverage">Topic coverage</a><a href="#sources">Past papers &amp; sources</a><a href="exam.json">Exam data</a></nav><section class="section" id="questions"><h2>Question paper</h2><p class="intro">Complete the questions before consulting the separate solution section. Show your method and state relevant conditions.</p>${exam.instructions?.length ? `<ul class="instructions">${exam.instructions.map(item => `<li>${escape(item)}</li>`).join("")}</ul>` : ""}${questions}</section><section class="section page-break" id="solutions"><p class="eyebrow">Answer key · consult after attempting</p><h2>Worked solutions</h2><p class="intro">Reasoning and marking guidance for the original questions. Equivalent valid methods can receive the corresponding credit.</p>${solutions}</section><section class="section page-break" id="coverage"><h2>Topic coverage</h2><p class="intro">Use this map to locate assessed topics and the source material informing their scope.</p><ul class="coverage">${coverage}</ul></section><section class="section" id="sources"><h2>Past papers &amp; syllabus guide</h2><p class="intro">Dates and resource types matter: a sample paper is distinct from a verified past sitting, and a prior section’s outline may differ from the current catalog.</p><ul class="sources">${sources}</ul><h3>Scope and limitations</h3><ul class="limitations">${exam.limitations.map(item => `<li>${escape(item)}</li>`).join("")}</ul></section><footer class="footer">Generated by Hands from the accompanying exam.json. Layout validation checks marks, references and required topic bookkeeping; mathematical correctness and source claims require independent review. Use your browser’s print command for an A4 copy.</footer></main></body></html>`;
}

/** Synchronous data materialization: no network, filesystem, model calls or
 * executable generated code. Apply before the general bundle schema check. */
export function materializeExamBundle<T extends { entrypoint: string; files: { path: string; content: string }[] }>(bundle: T): T {
  const files = bundle.files.filter(file => file.path === "exam.json");
  if (!files.length) return bundle;
  if (files.length !== 1) throw new Error("Exactly one exam.json is required");
  const exam = ExamSchema.parse(JSON.parse(files[0]!.content));
  return { ...bundle, entrypoint: "mock-exam.html", files: [...bundle.files.filter(file => file.path !== "mock-exam.html"), { path: "mock-exam.html", content: renderExam(exam) }] };
}
