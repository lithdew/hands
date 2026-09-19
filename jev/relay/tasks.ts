// tasks.ts — the five requests, in the user's words, and what "up to standard" means for each.
//
// THE STANDARD IS FIXED. Whoever improves the relay until a task passes does not edit this file or
// judge.ts: a task that passes because its rubric was softened has not been done. A `must` that fails
// fails the task. `code` checks are run by judge.ts from the files; the rest are judged by a stronger
// model that sees the files (and, for videos, stills).

export type Check = { id: string; must: boolean; by: "code" | "judge" | "eyes"; text: string };
export type TaskSpec = { id: string; said: string; kit: string; deliverable: string; rubric: Check[] };

const c = (id: string, must: boolean, by: Check["by"], text: string): Check => ({ id, must, by, text });

export const TASKS: TaskSpec[] = [
  { id: "mock-exam", kit: "exam", deliverable: "mock-exam.md, answers.md, sources.md",
    said: "Find me exam past papers from previous classes and other universities and make me a mock exam based on the syllabus of calc 1 and calc 2 on hkust",
    rubric: [
      c("files", true, "code", "mock-exam.md, answers.md and sources.md exist and are not stubs."),
      c("sources", true, "code", "sources.md lists at least 8 distinct addresses of past papers or course pages: at least 2 on an HKUST domain and at least 2 from other universities, and most of a sample of them open."),
      c("questions", true, "code", "mock-exam.md has at least 12 numbered questions, with marks."),
      c("syllabus", true, "judge", "The exam states the HKUST syllabus it follows (MATH 1013 Calculus IB and MATH 1014 Calculus II, or the equivalent HKUST first-year calculus courses) with the topics taken from HKUST's own course pages, and the questions cover both courses: limits, derivatives and applications, integration and techniques, series or sequences."),
      c("modelled", true, "judge", "Questions are modelled on the found papers: a table or notes map questions to the past papers that inspired their style or topic, and nothing long is copied word for word."),
      c("correct", true, "judge", "The questions are well posed and the answers in answers.md are mathematically correct for the questions sampled."),
      c("exam-like", false, "judge", "It reads like a real exam: instructions, time allowed, marks that add up, a mix of routine and harder questions."),
      c("honest", false, "judge", "Where something could not be found (a paper that would not open, a syllabus detail) the files say so instead of inventing it."),
    ] },
  { id: "rl-summary", kit: "papers", deliverable: "rl-frontier.md",
    said: "Make a summary of relevant frontier research in reinforcement learning",
    rubric: [
      c("files", true, "code", "rl-frontier.md exists, between 600 and 2500 words."),
      c("real", true, "code", "It cites at least 12 distinct arXiv papers as links, and for a sample of them the linked arXiv page's title matches the cited title."),
      c("recent", true, "code", "At least 10 of the cited arXiv papers are from 2025 or 2026."),
      c("themes", true, "judge", "The papers are organised into at least four themes that are recognisably current in reinforcement learning, each with a sentence or two on why it matters now."),
      c("says-what", true, "judge", "Each cited paper has one or two sentences on what it actually contributes, specific enough that they could not describe a different paper."),
      c("synthesis", false, "judge", "There is synthesis beyond a list: what the field is converging on, tensions, and open problems."),
      c("honest", false, "judge", "Claims are tied to the cited papers; nothing is asserted as a finding without a source."),
    ] },
  { id: "personal-site", kit: "site", deliverable: "site/index.html (self-contained), site/SOURCES.md",
    said: "create a personal website for myself (and also look up things about me as it goes)",
    rubric: [
      c("files", true, "code", "site/index.html and site/SOURCES.md exist; the page has a title, a viewport meta tag, one h1 and at least three sections."),
      c("no-filler", true, "code", "No placeholder text (lorem ipsum, TODO, 'Your Name', example.com, John Doe), and every local link or asset the page refers to exists."),
      c("sourced", true, "judge", "Every biographical fact on the page (name, school, projects, roles, links) is traceable to an entry in SOURCES.md, which names where it was found (a public page, or this repository and its git history). Nothing about the person is invented."),
      c("right-person", true, "judge", "The facts are about the repository's owner, not a namesake: where a web result could be someone else with the same name, it was left out or marked as unconfirmed."),
      c("sections", true, "judge", "It has an introduction, projects (including this project, Puk / Hands) and a way to get in touch."),
      c("designed", false, "eyes", "It looks like a designed personal site: clear hierarchy, consistent spacing and type, readable on a phone width and a desktop width."),
      c("private", false, "judge", "Nothing private is published: no home address, phone number, or anything not already public or in the repository."),
    ] },
  { id: "matrix-video", kit: "mathvideo", deliverable: "video/out.mp4, video/script.json, video/stills/*.png",
    said: "use three blue one browns tool to create a video on matrix inversion using remotion",
    rubric: [
      c("files", true, "code", "video/out.mp4 exists, is at least 45 seconds long, and at least four stills are in video/stills."),
      c("script", true, "code", "video/script.json exists and lists the scenes with their narration text."),
      c("maths", true, "judge", "The mathematics is right: what an inverse is (AB = BA = I), the 2x2 formula with the determinant, a worked example whose arithmetic is correct, and that a matrix with determinant zero has no inverse."),
      c("intuition", true, "judge", "It explains inversion the way 3Blue1Brown would: as undoing a linear transformation of space, with the determinant as the scaling of area, not only as a formula."),
      c("style", false, "eyes", "The stills look like a 3Blue1Brown-style explainer: dark background, grid or vectors, typeset matrices, restrained colour."),
      c("paced", false, "judge", "The script is paced for a viewer: one idea per scene, narration that matches what is on screen."),
      c("tooling", false, "judge", "The files say honestly which tools made it (manim, Remotion, or Remotion alone in manim's style) and why."),
    ] },
  { id: "pitch-video", kit: "pitchvideo", deliverable: "video/out.mp4, video/script.json, video/claims.md, video/stills/*.png",
    said: "create a presentation video pitching itself (its name is hands) using remotion and showcasing the best things it could do, pitching as if it is for a hackathon",
    rubric: [
      c("files", true, "code", "video/out.mp4 exists, is between 60 and 180 seconds long, and at least five stills are in video/stills."),
      c("script", true, "code", "video/script.json lists the scenes with their narration, and video/claims.md exists."),
      c("traceable", true, "judge", "Every number or capability claimed in the video appears in claims.md with the file in this repository it comes from (a README, an eval), and none is invented or inflated."),
      c("pitch", true, "judge", "It is a hackathon pitch: the problem, what Hands is, how it works (a fast typed model for the many small decisions, language models for the few big ones, working in the background), what it demonstrably does, and a close."),
      c("best", true, "judge", "It shows the strongest real results rather than generic claims: for example tasks finished in a few round trips, native applications driven on a hidden desktop, the measured gains from how the screen is shown to the model."),
      c("polish", false, "eyes", "The stills look like a finished pitch video: consistent brand, legible type, motion-graphics layout rather than slides of bullet points."),
      c("length", false, "judge", "The narration fits the length: about 140 to 170 words a minute."),
    ] },
];
