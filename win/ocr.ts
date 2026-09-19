/**
 * Text off a screenshot with nothing installed: the OCR engine that ships in Windows (Windows.Media.Ocr).
 *
 * It is a WinRT API, which Windows PowerShell 5.1 can load by type name (PowerShell 7 and a C# 5 helper cannot, not
 * without reference assemblies). So win/ocr.ps1 runs as one long-lived powershell.exe per process, the same
 * line-in, line-out shape as win/helper.cs: starting it costs about two seconds once, a screenshot after that a few
 * hundred milliseconds. It is its own process, never helper.cs, so a slow recognition cannot hold up window state or capture.
 *
 * jev/marks.ts uses it only where the DOM or the accessibility tree is blind (canvas, iframe, an app with no tree),
 * and starts it beside the vision planner's round trip, which is ten times slower.
 *
 * Measured here (jev/marks.eval.ts, 1280x800 screenshots): scale 1 misreads small UI text ("702" as "7€2") and drops
 * glyph-sized labels; scale 2 reads them. Icons are not text: it returns nothing for them, which is what marks are for.
 */
import { join } from "node:path";
import type { Ocr, OcrLine } from "../jev/marks";

const WSL = process.platform === "linux";
const SCRIPT = join(import.meta.dir, "ocr.ps1");
/** UI text is 11 to 14 px; the engine was made for documents. Enlarging first is what makes it usable on a screen. */
const SCALE = Number(process.env.PUK_OCR_SCALE ?? 2);

export type OcrReply = { ms: number; lang: string; scale: number; width: number; height: number; lines: OcrLine[] };
export type OcrProcess = { stdin: { write(data: string): unknown; flush(): unknown; end(): unknown }; stdout: ReadableStream<Uint8Array>; kill(): void };
export type OcrEngine = Ocr & { recognize(png: Uint8Array, scale?: number): Promise<OcrReply>; ready(): Promise<{ ready: boolean; lang: string | null }>; close(): void };

async function spawnPowerShell(): Promise<OcrProcess> {
  const script = WSL ? (await new Response(Bun.spawn(["wslpath", "-w", SCRIPT], { stdout: "pipe" }).stdout).text()).trim() : SCRIPT;
  // Windows PowerShell, by name: `pwsh` is PowerShell 7, which cannot load WinRT types.
  return Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
}

/** PowerShell 5.1 writes a single-element array as the element itself; a line with one word arrives as an object. */
const list = <T>(value: T | T[] | null | undefined): T[] => (value == null ? [] : Array.isArray(value) ? value : [value]);

/** Pure: one reply line as lines of words. Exported for tests. */
export function parseReply(line: string): OcrReply {
  const raw = JSON.parse(line) as { error?: string; ms?: number; lang?: string; scale?: number; width?: number; height?: number; lines?: unknown };
  if (raw.error) throw new Error(`Windows OCR: ${raw.error}`);
  const lines = list(raw.lines as { text: string; words: unknown }[]).map((l) => ({ text: String(l.text ?? ""), words: list(l.words as OcrLine["words"]).map((w) => ({ t: String(w.t), x: Number(w.x), y: Number(w.y), w: Number(w.w), h: Number(w.h) })) }));
  return { ms: raw.ms ?? 0, lang: raw.lang ?? "", scale: raw.scale ?? 1, width: raw.width ?? 0, height: raw.height ?? 0, lines };
}

/**
 * Lines of the enlarged pass, plus whatever only the plain pass saw. Measured on the fixtures of jev/marks.eval.ts: at
 * scale 2 the engine reads small grey labels right but skipped a whole row of bold coloured buttons ("6:30 PM" ...)
 * that it reads at scale 1 and 3; at scale 1 it splits and misreads small text ("GU ESTS", "7€2").
 */
export function unite(fine: OcrLine[], plain: OcrLine[]): OcrLine[] {
  const seen = fine.flatMap((l) => l.words);
  const covered = (w: OcrLine["words"][number]) => seen.some((s) => w.x + w.w / 2 >= s.x - 2 && w.x + w.w / 2 <= s.x + s.w + 2 && w.y + w.h / 2 >= s.y - 2 && w.y + w.h / 2 <= s.y + s.h + 2);
  const extra = plain.map((l) => l.words.filter((w) => !covered(w))).filter((ws) => ws.length).map((ws) => ({ text: ws.map((w) => w.t).join(" "), words: ws }));
  return [...fine, ...extra];
}

/** One OCR process, started on first use. Requests queue: the engine recognises one image at a time anyway. */
export function createOcr(spawn: () => Promise<OcrProcess> = spawnPowerShell): OcrEngine {
  let started: Promise<{ proc: OcrProcess; line: () => Promise<string>; hello: { ready: boolean; lang: string | null } }> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const start = () => started ??= (async () => {
    const proc = await spawn(), reader = proc.stdout.getReader(), decoder = new TextDecoder();
    let buffered = "";
    const line = async () => {
      for (;;) {
        const end = buffered.indexOf("\n");
        if (end >= 0) { const out = buffered.slice(0, end).replace(/\r$/, ""); buffered = buffered.slice(end + 1); return out; }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("The Windows OCR process stopped.");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    };
    return { proc, line, hello: JSON.parse(await line()) as { ready: boolean; lang: string | null } };
  })();
  const recognize = (png: Uint8Array, scale = SCALE) => {
    const reply = queue.then(async () => {
      const { proc, line } = await start();
      proc.stdin.write(`png ${Math.max(1, Math.min(4, Math.round(scale)))} ${Buffer.from(png).toString("base64")}\n`); await proc.stdin.flush();
      return parseReply(await line());
    });
    queue = reply.catch(() => {});
    return reply;
  };
  // No one scale reads everything (see `unite`). Two passes on one process: about 40 ms and 130 ms for 1280x800.
  const ocr = (async (png: Uint8Array) => { const [fine, plain] = await Promise.all([recognize(png), recognize(png, 1)]); return unite(fine.lines, plain.lines); }) as OcrEngine;
  ocr.recognize = recognize;
  ocr.ready = async () => (await start()).hello;
  ocr.close = () => { void started?.then(({ proc }) => { try { proc.stdin.end(); } catch { /* already gone */ } }); started = undefined; };
  return ocr;
}

let shared: OcrEngine | undefined;
/** The process-wide engine. `void sharedOcr().ready()` at start-up takes the two seconds off the first stuck look. */
export const sharedOcr = () => shared ??= createOcr();

// bun win/ocr.ts <png> [scale]   what the engine reads on one image, and how long it takes warm
if (import.meta.main) {
  const path = process.argv[2], scale = Number(process.argv[3] ?? SCALE);
  if (!path) { console.log("usage: bun win/ocr.ts <png> [scale]"); process.exit(1); }
  const ocr = createOcr(), png = new Uint8Array(await Bun.file(path).arrayBuffer());
  let t = performance.now();
  console.log(`started: ${JSON.stringify(await ocr.ready())} in ${Math.round(performance.now() - t)} ms`);
  for (const round of ["first", "warm", "warm"]) {
    t = performance.now();
    const reply = await ocr.recognize(png, scale);
    console.log(`${round}: ${Math.round(performance.now() - t)} ms round trip, ${reply.ms} ms in the engine, ${reply.lines.length} lines at scale ${reply.scale} (${reply.lang})`);
    if (round === "first") for (const l of reply.lines) console.log(`  ${JSON.stringify(l.text)}  @ ${l.words[0]?.x},${l.words[0]?.y}`);
  }
  ocr.close();
}
