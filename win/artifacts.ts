import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

/** Artifact documents run with an opaque origin even when opened directly.
 * They can render local assets but cannot fetch or submit to Hands controls. */
export const ARTIFACT_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'self'";
export const ARTIFACT_ROOT = resolve(import.meta.dir, "../out/artifacts");
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".pdf": "application/pdf",
  ".srt": "text/plain; charset=utf-8", ".vtt": "text/vtt; charset=utf-8",
};

function parts(pathname: string): { runId: string; files: string[] } | null {
  const path = pathname.split("/");
  if (path[1] !== "artifacts" || !RUN_ID.test(path[2] ?? "") || path.length < 4) return null;
  const files: string[] = [];
  for (const encoded of path.slice(3)) {
    let part: string;
    try { part = decodeURIComponent(encoded); } catch { return null; }
    // Windows ADS, device aliases, alternate separators and dot/space trimming
    // can turn an apparently ordinary name into a different filesystem target.
    if (!part || part === "." || part === ".." || /[\\/:%\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) return null;
    files.push(part);
  }
  return { runId: path[2]!, files };
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};

/** Every existing component must be a real directory, never a link/junction. */
async function checkedFile(root: string, runId: string, files: string[]) {
  const absolute = resolve(root);
  // Include ancestors of the configured root so a symlinked out/ or artifacts/
  // cannot redirect the whole route outside its intended directory.
  const ancestors: string[] = [];
  for (let current = absolute; ; current = resolve(current, "..")) {
    ancestors.unshift(current);
    if (resolve(current, "..") === current) break;
  }
  const leaf = join(absolute, runId, "files", ...files);
  if (!inside(absolute, leaf)) throw new Error("Invalid artifact path");
  const paths = [...ancestors, join(absolute, runId), join(absolute, runId, "files")];
  let current = join(absolute, runId, "files");
  for (const part of files) { current = join(current, part); paths.push(current); }
  for (const [index, path] of paths.entries()) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (index === paths.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error("Artifact path is not a regular file");
  }
  const canonicalRoot = await realpath(absolute), canonicalLeaf = await realpath(leaf);
  if (!inside(canonicalRoot, canonicalLeaf)) throw new Error("Artifact escaped its directory");
  const expected = await lstat(leaf);
  const handle = await open(canonicalLeaf, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error("Artifact changed while opening");
    return { handle, size: actual.size };
  } catch (error) { await handle.close(); throw error; }
}

/** Kept separate from control routes: opaque sandbox origins need to load their
 * read-only assets, but remain rejected by the normal /task and /status guard. */
export async function artifactResponse(request: Request, root = ARTIFACT_ROOT): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/artifacts/")) return null;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || request.headers.get("host") && request.headers.get("host") !== url.host) return new Response("Local artifacts only", { status: 403 });
  const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site"), destination = request.headers.get("sec-fetch-dest");
  // Opaque frames omit Origin on no-cors images/styles/media. Permit only those
  // read-only asset requests, never cross-site document navigation or fetch.
  const opaqueAsset = !origin && ["image", "style", "script", "font", "audio", "video", "track"].includes(destination ?? "")
    && request.headers.get("sec-fetch-mode") === "no-cors";
  if (origin && origin !== "null" && origin !== url.origin || site && ["cross-site", "same-site"].includes(site) && origin !== "null" && !opaqueAsset) return new Response("Local artifacts only", { status: 403 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Use GET or HEAD", { status: 405, headers: { Allow: "GET, HEAD" } });
  const requested = parts(url.pathname);
  if (!requested) return new Response("Invalid artifact path", { status: 400 });
  const mime = MIME[extname(requested.files.at(-1)!).toLowerCase()];
  if (!mime) return new Response("Unsupported artifact type", { status: 415 });
  try {
    const { handle, size } = await checkedFile(root, requested.runId, requested.files);
    const headers = new Headers({
      "Content-Type": mime, "Content-Security-Policy": ARTIFACT_CSP,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Accept-Ranges": "bytes", "Content-Length": String(size),
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      // Module scripts/fonts inside a sandbox have the literal opaque origin.
      "Access-Control-Allow-Origin": "null", "Vary": "Origin",
    });
    let start = 0, end = size - 1, status = 200;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || !match[1] && !match[2]) { await handle.close(); return new Response("Invalid byte range", { status: 416, headers: { "Content-Range": `bytes */${size}` } }); }
      if (match[1]) { start = Number(match[1]); end = match[2] ? Number(match[2]) : end; }
      else start = Math.max(0, size - Number(match[2]));
      end = Math.min(end, size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
        await handle.close(); return new Response("Byte range unavailable", { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      status = 206;
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
      headers.set("Content-Length", String(end - start + 1));
    }
    if (request.method === "HEAD" || size === 0) { await handle.close(); return new Response(null, { status, headers }); }
    const body = Readable.toWeb(handle.createReadStream({ start, end, autoClose: true })) as ReadableStream<Uint8Array>;
    return new Response(body, { status, headers });
  } catch { return new Response("Artifact unavailable", { status: 404 }); }
}
