// docs.ts — the repository's own documents as research material: passages with an address.
//
// A pitch may claim only what the repository has measured and written down, so the research of this
// kit reads local markdown, not the web. A document becomes passages small enough for Jev to judge
// one by one (a paragraph, a list item, a table), each with the address a claim will later cite:
// `jev/README.md:112` is a file in this repository and the line the passage starts on. Pure, except
// `repoDocs`, which reads the files.

import { join } from "node:path";

/** `part`: a long paragraph is several passages on one line; the second is part 1, and its address ends in "b". */
export type Passage = { file: string; line: number; end: number; part: number; heading: string; text: string };

const MAX_CHARS = 700;
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
/** Markdown furniture that is not content: emphasis marks, link targets, code ticks. The words stay. */
export const plain = (s: string) => clean(s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`]+/g, "").replace(/^#+\s*/, ""));

const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => plain(c));
const isRule = (row: string) => /^\s*\|?\s*:?-{2,}/.test(row);

/** A long paragraph as runs of whole sentences. Every run keeps the paragraph's line as its address. */
export function sentences(text: string, max = MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const parts = text.split(/(?<=[.!?][")\]]?)\s+(?=["(\[]?[A-Z])/).map(clean).filter(Boolean);   // "quick.ts" and "5.6" are not ends of sentences
  const runs: string[] = [];
  for (const part of parts) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.length + part.length + 1 <= max) runs[runs.length - 1] = `${last} ${part}`; else runs.push(part);
  }
  return runs;
}

/** Markdown as passages: paragraphs, list items (with what they continue onto), and tables row by row under their header. */
export function passages(markdown: string, file: string): Passage[] {
  const lines = markdown.split("\n"), out: Passage[] = [], path: string[] = [];
  const push = (line: number, end: number, text: string, whole = false) => { const t = clean(text); if (t.length >= 40) (whole ? [t] : sentences(t)).forEach((run, part) => out.push({ file, line, end, part, heading: path.filter(Boolean).join(" > "), text: run })); };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^```/.test(line.trim())) { i++; while (i < lines.length && !/^```/.test(lines[i]!.trim())) i++; i++; continue; }   // code and diagrams are not claims
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) { path.length = head[1]!.length; path[head[1]!.length - 1] = plain(head[2]!); for (let k = 0; k < path.length; k++) path[k] ??= ""; i++; continue; }
    if (/^\s*\|/.test(line)) {
      const start = i, rows: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) rows.push(lines[i++]!);
      const header = cells(rows[0]!), body = rows.slice(1).filter((r) => !isRule(r));
      // Each row says what its columns are, so a row reads alone: "solved: 18/18; Jev round trips: 5.6".
      const asText = (row: string) => cells(row).map((c, k) => (k === 0 ? c : `${header[k] ?? ""}: ${c}`)).join("; ");
      let chunk: string[] = [], from = start;   // the first chunk starts at the header, so a claim may cite the table's first line
      body.forEach((row, k) => {
        const text = asText(row);
        if (chunk.length && chunk.join(" | ").length + text.length > MAX_CHARS) { push(from + 1, start + 2 + k, `Table (${header[0]}). ${chunk.join(" | ")}`, true); chunk = []; from = start + 2 + k; }
        chunk.push(text);
      });
      if (chunk.length) push(from + 1, i, `Table (${header[0]}). ${chunk.join(" | ")}`, true);
      continue;
    }
    const start = i, item = /^\s*(?:[-*+]|\d+[.)])\s+/.test(line), buf = [line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]!) && !/^(#{1,6}\s|```|\s*\|)/.test(lines[i]!) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]!)) buf.push(lines[i++]!);
    void item;
    push(start + 1, i, plain(buf.join(" ")));
  }
  return out;
}

/** What a passage looks like to Jev, to the note taker and in the notes: its address first. */
export const address = (p: Pick<Passage, "file" | "line"> & { part?: number }) => `${p.file}:${p.line}${p.part ? "abcdefghijklmnopqrstuvwxyz"[p.part] ?? "z" : ""}`;
export const shown = (p: Passage) => `[${address(p)}] ${p.heading ? `(${p.heading.split(" > ").pop()!.slice(0, 60)}) ` : ""}${p.text}`;

/** `jev/README.md:112`, `jev/README.md:112b`, `jev/README.md, line 112`, `jev/README.md#L112` -> the passages that start on or span that line: a paragraph whole, whichever part was cited. */
export function resolve(index: Passage[], cited: string): Passage[] {
  const m = /([\w./-]+\.md)\s*(?:[:#,]\s*(?:L|lines?\s*)?(\d+)(?:\s*[-–]\s*(\d+))?)?/i.exec(cited);
  if (!m) return [];
  const file = m[1]!.replace(/^\.?\//, ""), from = m[2] ? Number(m[2]) : 0, to = m[3] ? Number(m[3]) : from;
  if (!from) return [];
  return index.filter((p) => p.file === file && p.line <= to && p.end >= from);
}

/** The repository's documents: every tracked markdown file that describes the project, as passages. */
export async function repoDocs(root: string, globs = ["README.md", "jev/README.md", "win/README.md", "docs/*.md"]): Promise<{ file: string; title: string; passages: Passage[] }[]> {
  const files = [...new Set(globs.flatMap((g) => [...new Bun.Glob(g).scanSync(root)].sort()))];
  return (await Promise.all(files.map(async (file) => {
    const text = await Bun.file(join(root, file)).text().catch(() => "");
    return { file: file.replace(/\\/g, "/"), title: plain(/^#\s+(.*)$/m.exec(text)?.[1] ?? file), passages: passages(text, file.replace(/\\/g, "/")) };
  }))).filter((d) => d.passages.length);
}
