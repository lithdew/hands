// kits/py.ts — Python for the kits that need it: a PDF's text (pypdf) and exact mathematics (sympy).
//
// This machine has no pdftotext, and past papers, syllabi and articles are mostly PDFs. The interpreter
// lives in a venv under out/ (gitignored, made on first use, nothing installed system-wide and nothing
// added to package.json). Downloads and extracted text are cached beside the web cache.
//
//   pdfText(url)          -> the PDF's text as paragraphs, one per line, blank lines between ("" if none)
//   reflow(pages)         -> the same from raw page texts (pure; tested)
//   runPython(file, args, stdin) -> stdout of a script next to this file, run in the venv

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const OUT = join(import.meta.dir, "..", "..", "..", "out", "relay");
const VENV = join(OUT, "pyenv"), PY = join(VENV, "bin", "python"), CACHE = join(OUT, "cache");
const PACKAGES = ["pypdf", "sympy"];
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_PDF_BYTES = 30_000_000;

let ready: Promise<string> | null = null;

/** The venv's interpreter, made and provisioned on first use. */
export function python(): Promise<string> {
  return ready ??= (async () => {
    const works = async () => (await Bun.$`${PY} -c ${"import pypdf, sympy"}`.nothrow().quiet()).exitCode === 0;
    if (await Bun.file(PY).exists() && await works()) return PY;
    await mkdir(OUT, { recursive: true });
    const base = Bun.which("python3") ?? Bun.which("python");
    if (!base) throw new Error("no python3 on this machine: PDFs cannot be read and answers cannot be verified");
    await Bun.$`${base} -m venv ${VENV}`.quiet();
    await Bun.$`${PY} -m pip install -q ${PACKAGES}`.quiet();
    if (!(await works())) throw new Error("the Python venv could not be provisioned (pypdf, sympy)");
    return PY;
  })();
}

// Research reads a score of PDFs at once; an interpreter each, all starting together, is slower than six at a time.
const MAX_PROCESSES = 6;
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_PROCESSES) await new Promise<void>((resolve) => waiting.push(resolve)); else running++;
  try { return await work(); } finally { const next = waiting.shift(); if (next) next(); else running--; }
}

/** Run a script that sits next to this file. Never throws on a non-zero exit: the caller reads stdout. */
export function runPython(script: string, args: string[] = [], stdin = "", timeoutMs = 120_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return slot(() => spawnPython(script, args, stdin, timeoutMs));
}

async function spawnPython(script: string, args: string[], stdin: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  const py = await python();
  const proc = Bun.spawn([py, join(import.meta.dir, script), ...args], { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  } finally { clearTimeout(timer); }
}

/**
 * Page texts to paragraphs. An exam's lines are short ("(b) Find dy/dx.") and a sifter judges each
 * passage alone, so lines are gathered into one passage per question: a new passage starts at a blank
 * line or at a line that opens a numbered question, and short passages join the next.
 */
export function reflow(pages: string[], opts: { min?: number; max?: number } = {}): string {
  const min = opts.min ?? 160, max = opts.max ?? 900, out: string[] = [];
  let current = "";
  const flush = () => { const text = current.replace(/\s+/g, " ").trim(); if (text.length >= 40) out.push(text); current = ""; };
  for (const page of pages) {
    for (const raw of page.split(/\r?\n/)) {
      const line = raw.replace(/\s+/g, " ").trim();
      const opens = /^(?:(?:question|problem|q)\s*\d{1,2}\b|\d{1,2}\s*[.)]\s|\(\d{1,2}\)\s)/i.test(line);
      if ((!line || opens) && current.length >= min) flush();
      if (!line) continue;
      if (current.length + line.length + 1 > max) flush();
      current += (current ? " " : "") + line;
    }
    if (current.length >= min) flush();
  }
  flush();
  return out.join("\n\n");
}

/** A PDF's text. "" when it cannot be fetched, is not a PDF, or has no text layer (a scan). Cached. */
export async function pdfText(url: string, opts: { maxPages?: number } = {}): Promise<string> {
  const id = Bun.hash(url).toString(16), textFile = Bun.file(join(CACHE, `pdftext-${id}.json`));
  if (await textFile.exists()) return ((await textFile.json()) as { text: string }).text;
  await mkdir(CACHE, { recursive: true });
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/pdf,*/*;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(45_000) }).catch(() => null);
  if (!res?.ok) return "";
  const bytes = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (bytes.length < 5 || bytes.length > MAX_PDF_BYTES || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return "";
  const pdfFile = join(CACHE, `pdf-${id}.pdf`);
  await Bun.write(pdfFile, bytes);
  const ran = await runPython("pdf_text.py", [pdfFile, String(opts.maxPages ?? 40)]);
  let pages: string[] = [];
  try { pages = (JSON.parse(ran.stdout) as { pages: string[] }).pages ?? []; } catch { pages = []; }
  const text = reflow(pages);
  await Bun.write(textFile, JSON.stringify({ url, pages: pages.length, text }));
  return text;
}
