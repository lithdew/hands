/**
 * What a hand says, as the panel shows it. A hand answers in Markdown, and much of what it says came word for word
 * from web pages, so the panel never renders it as HTML: it is read here into a few kinds of block (a paragraph, a
 * heading, a list item), each a run of plain and bold pieces, which the page builds with textContent alone. Links
 * become their words, tables become lines, and a card shows only the gist: the first paragraph, and the list it
 * introduces. No DOM here: this file is in the page's bundle and in the tests.
 */

export interface Run {
  text: string;
  bold: boolean;
}

export interface Block {
  kind: "p" | "h" | "li";
  runs: Run[];
  marker: string; // a list item's bullet, "•", or its number, "2."; empty for the others
}

const URL_CHARS = 40; // a bare address longer than this is cut: a card has no room for a query string
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const HOLD = ""; // stands in for what must come through untouched (an escaped character, code) until the end

/** An address as a person would read it out: no scheme, no www, and cut when it runs long. */
function short(url: string): string {
  const bare = url.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  return bare.length > URL_CHARS ? `${bare.slice(0, URL_CHARS - 1)}…` : bare;
}

/** One line of Markdown as runs of plain and bold text: links, images, code, emphasis and tags reduced to their words. */
export function inline(source: string): Run[] {
  const held: string[] = [];
  const hold = (text: string) => `${HOLD}${held.push(text) - 1}${HOLD}`;
  const text = source
    .replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, (_, char: string) => hold(char))
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code: string) => hold(code.trim()))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\s*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/gi, (_, url: string) => hold(short(url)))
    .replace(/\bhttps?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_]/gi, (url) => hold(short(url)))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:b|strong|i|em|u|s|del|ins|sup|sub|span|p|div|small|mark|code|kbd)(?:\s[^<>]*)?>/gi, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    })
    .replace(/~~([^~]+)~~/g, "$1");
  const runs: Run[] = [];
  const bold = /\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__(?!\w)/g;
  let at = 0;
  for (let found = bold.exec(text); found; found = bold.exec(text)) {
    if (found.index > at) runs.push({ text: text.slice(at, found.index), bold: false });
    runs.push({ text: found[1] ?? found[2] ?? "", bold: true });
    at = found.index + found[0].length;
  }
  if (at < text.length) runs.push({ text: text.slice(at), bold: false });
  const restore = (part: string) => part.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, "g"), (_, index: string) => held[Number(index)] ?? "");
  // Emphasis is dropped, not drawn: a single * or _ around words, never one inside a word (snake_case, 2*3*4).
  const plain = (part: string) => part.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2").replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2");
  return runs.map((run) => ({ text: restore(plain(run.text)), bold: run.bold })).filter((run) => run.text);
}

/** A block's words, without its marker. */
export const words = (block: Block): string => block.runs.map((run) => run.text).join("");

/** A block from its Markdown, with spaces made single and the ends trimmed; null when nothing is left. */
function block(kind: Block["kind"], source: string, marker = "", raw = false): Block | null {
  const runs = (raw ? [{ text: source, bold: false }] : inline(source)).map((run) => ({ ...run, text: run.text.replace(/[ \t ]+/g, " ").replace(/ ?\n ?/g, "\n") }));
  if (runs.length) {
    runs[0]!.text = runs[0]!.text.replace(/^\s+/, "");
    runs[runs.length - 1]!.text = runs[runs.length - 1]!.text.replace(/\s+$/, "");
  }
  const kept = runs.filter((run) => run.text);
  return kept.length ? { kind, runs: kept, marker } : null;
}

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/(^|[^\\])\|$/, "$1")
    .split(/\|/)
    .map((cell) => cell.trim());
const isRule = (line: string) => line.includes("|") && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/** Markdown read into blocks. Single line breaks inside a paragraph are kept: a hand writes "Price: …" lines and means them. */
export function blocks(markdown: string): Block[] {
  const out: Block[] = [];
  let open: { kind: "p" | "li"; marker: string; lines: string[]; raw: boolean } | null = null;
  let fenced = false;
  const close = () => {
    const made = open && block(open.kind, open.lines.join(open.kind === "li" ? " " : "\n"), open.marker, open.raw);
    if (made) out.push(made);
    open = null;
  };
  const push = (made: Block | null) => {
    close();
    if (made) out.push(made);
  };
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*(```|~~~)/.test(line)) {
      close();
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      if (!open) open = { kind: "p", marker: "", lines: [], raw: true };
      open.lines.push(line);
      continue;
    }
    if (!line.trim()) {
      close();
      continue;
    }
    if (open?.kind === "p" && !open.raw && /^\s{0,3}(=+|-+)\s*$/.test(line)) {
      const title = open.lines.join(" ");
      open = null;
      push(block("h", title)); // the line under a title makes it a heading
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      push(block("h", heading[1]!));
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      close(); // a rule: the blank line around it says as much
      continue;
    }
    if (/^\s*\|/.test(line) || (line.includes("|") && isRule(lines[index + 1] ?? ""))) {
      if (isRule(line)) continue;
      const row = cells(line).filter(Boolean).join(" · ");
      if (isRule(lines[index + 1] ?? "")) {
        push(block("p", `**${row}**`)); // the header row names the columns
        index++;
      } else push(block("li", row, "•"));
      continue;
    }
    const listed = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (listed) {
      close();
      open = { kind: "li", marker: /\d/.test(listed[2]!) ? listed[2]!.replace(")", ".") : "•", lines: [listed[3]!], raw: false };
      continue;
    }
    const text = line.replace(/^(\s{0,3}>\s?)+/, "");
    if (open?.kind === "li" && /^\s/.test(line)) {
      open.lines.push(text.trim()); // an item's second line, indented under it
      continue;
    }
    if (open?.kind === "li") close();
    if (!open) open = { kind: "p", marker: "", lines: [], raw: false };
    open.lines.push(text.trim());
  }
  close();
  return out;
}

const written = (block: Block) => (block.marker ? `${block.marker} ${words(block)}` : words(block));

/** All of it as text, a block to a line: for a place that cannot show more than words. */
export const text = (markdown: string): string => blocks(markdown).map(written).join("\n");

/** A paragraph that introduces the list under it: it ends in a colon, or it is a label in bold (a table's header row is one). */
const introduces = (block: Block) => /:\s*$/.test(words(block)) || (block.runs.length === 1 && block.runs[0]!.bold);

/**
 * What a card shows of an answer: a heading that leads in, the first paragraph, and the list that paragraph
 * introduces, or the list the answer opens with. A first paragraph that ends in a colon brings the paragraph it
 * introduces instead, when that is what follows ("wrote the haiku:" and the haiku). Everything else is on the sheet.
 */
export function gist(markdown: string): string {
  const taken: Block[] = [];
  for (const one of blocks(markdown)) {
    const last = taken[taken.length - 1];
    const lead = taken.filter((block) => block.kind !== "h");
    const opener = lead.length === 1 && lead[0]!.kind === "p" && /:\s*$/.test(words(lead[0]!));
    if (one.kind !== "li" && lead.length && !(opener && one.kind === "p")) break;
    if (one.kind === "li" && last?.kind === "p" && !introduces(last)) break;
    taken.push(one);
  }
  return taken.map(written).join("\n");
}
