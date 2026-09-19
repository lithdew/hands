import { expect, test } from "bun:test";
import { readable } from "../relay";
import { duckResults } from "../web";
import { record } from "./site";
import { anchorsOf, entryFiles, foldersTouched, maskEmail, parseAuthors, remoteSlug, texReadable, textBlocks, tieIn, type Owner } from "./site/owner";
import { evidenceFor, evidenceLines, links, lint, sentences, unbalanced, urlsIn, visibleLines } from "./site/page";
import { places, sheet } from "./site/shots";

// An invented person: no fact about the real owner belongs in code, tests included.
const owner: Owner = { name: "Ada Quill", email: "ada.quill@mail.test", remote: "github.com/someteam/widget", remoteVisible: false, authors: [{ name: "Ada Quill", email: "ada.quill@mail.test", commits: 4 }, { name: "Bo Reed", email: "bo@mail.test", commits: 9 }],
  commits: [{ hash: "abc1234", date: "2030-01-02", subject: "feat: parser", body: "", files: ["core/parse.ts", "core/lex.ts", "README.md"] }], account: { login: "adaquill7", url: "https://github.com/adaquill7", commits: 12, repos: ["thesis", "notes"], example: "https://github.com/adaquill7/notes/commit/1" } };

test("a remote becomes host/owner/name, whichever way it is written", () => {
  expect(remoteSlug("git@github.com:someteam/widget.git")).toBe("github.com/someteam/widget");
  expect(remoteSlug("https://github.com/someteam/widget")).toBe("github.com/someteam/widget");
  expect(remoteSlug("https://token@github.com/someteam/widget.git/")).toBe("github.com/someteam/widget");
  expect(remoteSlug("not a remote")).toBeNull();
});

test("an email shown to a model keeps its domain and nothing else", () => {
  expect(maskEmail("ada.quill@mail.test")).not.toContain("ada");
  expect(maskEmail("ada.quill@mail.test")).toContain("mail.test");
});

test("shortlog lines become authors; folders are counted over files", () => {
  expect(parseAuthors("    25\tBo Reed <bo@mail.test>\n     4\tAda Quill <ada.quill@mail.test>\n")).toEqual([{ commits: 25, name: "Bo Reed", email: "bo@mail.test" }, { commits: 4, name: "Ada Quill", email: "ada.quill@mail.test" }]);
  expect(foldersTouched(owner.commits)).toEqual([["core/", 2], ["(top level)", 1]]);
});

test("a TeX document gives its title page and body, not its set-up", () => {
  const tex = "\\documentclass{book}\n\\usepackage{amsmath}\n% \\author{Someone Else}\n\\title{On Widgets}\n\\author{Ada Quill}\n\\date{}\n\\begin{document}\n\\maketitle\n\nSubmitted for Honors in Widgetry\\\\\n\nSome University\n\nThis thesis studies widgets and the ways in which they fail under load.\n\\end{document}";
  expect(texReadable(tex)).toStartWith("From this document's title page -- title: On Widgets; author: Ada Quill.");
  const blocks = textBlocks(tex);
  expect(blocks[0]).toContain("author: Ada Quill");
  expect(blocks.join("\n")).not.toContain("usepackage");
  expect(blocks.join("\n")).not.toContain("Someone Else");
  // The short line joins the passage before it instead of vanishing.
  expect(blocks.find((b) => b.includes("Honors in Widgetry"))).toContain("Some University");
});

test("markdown passages carry their heading; code fences are dropped", () => {
  const blocks = textBlocks("# Widget\n\nA widget is a small thing that does one job well.\n\n## Run\n\n```sh\nbun start\n```\n\nStart it with the command above and wait for the panel.");
  expect(blocks).toEqual(["[Widget] A widget is a small thing that does one job well.", "[Run] Start it with the command above and wait for the panel."]);
});

test("entry files: a readme and main documents, small text only", () => {
  const listing = [{ name: "main.pdf", type: "file", size: 9e5 }, { name: "chapter3.tex", type: "file", size: 9000 }, { name: "main.tex", type: "file", size: 5000 }, { name: "README.md", type: "file", size: 900 }, { name: "Ada_Thesis.tex", type: "file", size: 5600 }, { name: "main copy.tex", type: "file", size: 5000 }, { name: "Lectures", type: "dir", size: 0 }];
  expect(entryFiles(listing).map((f) => f.name)).toEqual(["README.md", "main.tex", "Ada_Thesis.tex"]);
});

test("a tie is exact: the account's address, a repository of theirs, never the name", () => {
  expect(anchorsOf(owner)).toContain("github.com/adaquill7");
  expect(tieIn("Ada Quill is a professor of widgets at Some University.", owner)).toBeNull();
  expect(tieIn("See https://GitHub.com/adaquill7/thesis for the source.", owner)).toBe("github.com/adaquill7");
  expect(tieIn("written by adaquill7, 2030", owner)).toBe("the account name adaquill7");
  expect(tieIn("the user xadaquill77 is someone else", owner)).toBeNull();
  expect(tieIn("contact: ada.quill@mail.test", owner)).toBe("the owner's git email");
});

const PAGE = `<!DOCTYPE html><html lang="en"><head><title>Ada Quill</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>.card{color:red}</style></head><body>
<header><h1>Ada Quill</h1><p>I build parsers. I wrote a thesis on widgets at Some University.</p></header>
<main><section id="about"><h2>About</h2><p>Advised by Prof. B. Reed, who is kind. Say hello!</p></section>
<section id="projects"><h2>Projects</h2><p><a href="https://github.com/adaquill7/thesis">Thesis &amp; notes</a></p></section>
<section id="contact"><h2>Contact</h2><p><a href="SOURCES.md">Sources</a></p></section></main></body></html>`;
const SOURCES = `# Sources\n\n| What the page says | Where it was found | Why it is the owner's |\n| --- | --- | --- |\n| Thesis on widgets at Some University | https://github.com/adaquill7/thesis | under the owner's account |\n${"More words to make this list long enough to count as a real list of sources. ".repeat(3)}`;

test("the page as a visitor reads it: lines, sentences, links", () => {
  expect(visibleLines(PAGE)).not.toContain(".card{color:red}");
  expect(visibleLines(PAGE)).toContain("Thesis & notes");
  const said = sentences(PAGE);
  expect(said).toContain("I wrote a thesis on widgets at Some University.");
  expect(said).toContain("Advised by Prof. B. Reed, who is kind.");
  expect(said).not.toContain("Say hello!");
  // A sentence that ends inside quotation marks still ends.
  expect(sentences("<p>I wrote \u201cOn Widgets and Their Failure.\u201d I also wrote notes for a course on gears.</p>")).toEqual(["I wrote \u201cOn Widgets and Their Failure.\u201d", "I also wrote notes for a course on gears."]);
  expect(links(PAGE)).toEqual([{ href: "https://github.com/adaquill7/thesis", text: "Thesis & notes" }, { href: "SOURCES.md", text: "Sources" }]);
  expect(urlsIn("see (https://a.test/x), and https://b.test/y.")).toEqual(["https://a.test/x", "https://b.test/y"]);
});

test("the closest evidence is found by shared, rarer words", () => {
  const lines = evidenceLines("- The thesis is about widgets and was written at Some University [https://github.com/adaquill7/thesis]\n- The project is a parser for a small language [repo:README.md]\n| --- | --- |\n- short");
  expect(lines).toHaveLength(2);
  expect(evidenceFor("I wrote a thesis on widgets at Some University.", lines, 1)[0]).toContain("Some University");
  expect(evidenceFor("zzz qqq", lines)).toEqual([]);
});

test("lint passes a sound page and names what is wrong with an unsound one", async () => {
  const exists = async (p: string) => p === "SOURCES.md";
  expect(await lint(PAGE, SOURCES, exists)).toEqual([]);
  const bad = PAGE.replace("<h1>Ada Quill</h1>", "<h1>Ada</h1><h1>Quill</h1>").replace('<section id="contact">', '<section id="contact" class="placeholder">').replace("Say hello!", "Call 312-555-0188 or ada.quill@mail.test. <a href='cv.pdf'>CV</a> <a href='https://elsewhere.test/me'>me</a>").replace("</header>", "");
  const wrong = (await lint(bad, SOURCES, exists)).join("\n");
  for (const expected of ["exactly one <h1>", 'Remove "placeholder"', "phone number", "email address", '"cv.pdf"', "not in SOURCES.md: https://elsewhere.test/me", "not well formed"]) expect(wrong).toContain(expected);
  expect(wrong).not.toContain("ada.quill@");
  expect(await lint(bad, SOURCES, exists, ["ada.quill@mail.test"])).not.toContain("email address");
  expect(unbalanced("<div><section><h2>x</h2></div>")).toEqual(["<section> is not closed before </div>"]);
});

test("the build's record says how the owner was identified and what was left out, without the email", () => {
  const text = record(owner, [{ url: "https://uni.test/people/quill", title: "Ada Quill | Professor", tie: null, best: 0.12, passages: 3 }], [["https://blog.test/post", "github.com/adaquill7"]]);
  expect(text).toContain("## How the owner was identified");
  expect(text).toContain("[adaquill7](https://github.com/adaquill7)");
  expect(text).toContain("| https://uni.test/people/quill (Ada Quill / Professor) | No exact tie");
  expect(text).toContain("https://blog.test/post (tie: github.com/adaquill7)");
  expect(text).not.toContain("ada.quill@");
  expect(record(null, [], [])).toContain("Nothing on the machine said who the owner is");
});

test("the checker is shown a page as text with link addresses, not its stylesheet", () => {
  const shown = readable("site/index.html", PAGE);
  expect(shown).not.toContain("color:red");
  expect(shown).toContain("# Ada Quill");
  expect(shown).toContain("Thesis & notes (https://github.com/adaquill7/thesis)");
  expect(readable("notes.md", "<b>kept</b>")).toBe("<b>kept</b>");
});

test("DuckDuckGo's results: the real address is inside the redirect", async () => {
  const html = `<div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fpage%3Fx%3D1&amp;rut=abc">A &amp; B</a></h2><a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fpage">Some <b>bold</b> words</a></div>`;
  expect(await duckResults(html)).toEqual([{ title: "A & B", url: "https://a.test/page?x=1", snippet: "Some bold words" }]);
});

test("every still shows both widths, at the top, the projects and the last section", () => {
  expect(sheet("single/desktop-1.png", "single/phone-1.png", "top of the page")).toContain('src="single/desktop-1.png" width="1280"');
  expect(sheet("single/desktop-1.png", "single/phone-1.png", "top of the page")).toContain('src="single/phone-1.png" width="390"');
  expect(places(["about", "projects", "writing", "contact"]).map((p) => p.id)).toEqual([null, "projects", "contact"]);
  expect(places(["intro", "things", "reach"]).map((p) => p.id)).toEqual([null, "things", "reach"]);
  expect(places(["only"]).map((p) => p.id)).toEqual([null, "only"]);
  expect(places([]).map((p) => p.id)).toEqual([null]);
});
