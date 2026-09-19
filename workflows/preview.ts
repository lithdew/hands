import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ARTIFACT_CSP } from "../win/artifacts";

export type PreviewResult = { checks: { name: string; passed: boolean; detail: string }[]; screenshots: string[] };
export type PreviewOptions = { directory: string; entrypoint: string; outputDir: string; videoTimeSeconds?: number; signal?: AbortSignal };
const ROOT = resolve(import.meta.dir, "..");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".pdf": "application/pdf", ".vtt": "text/vtt", ".txt": "text/plain", ".md": "text/plain", ".srt": "text/plain",
};
const contained = (directory: string, file: string) => {
  const rel = relative(directory, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

function fileParts(path: string) {
  const result = path.split("/").map(part => decodeURIComponent(part));
  if (!result.length || result.some(part => !part || part === "." || part === ".." || /[\\/:%\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Invalid local artifact path");
  return result;
}

async function regularFile(directory: string, parts: string[]) {
  let current = directory;
  const rootStat = await lstat(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Artifact directory must be a real directory");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error("Artifact links are not served");
  }
  if (!contained(await realpath(directory), await realpath(current))) throw new Error("Artifact escaped its directory");
  return current;
}

/** Fresh contexts only: this selects a binary, never a running browser/profile. */
export function previewBrowserExecutable(): string | undefined {
  const candidates = [
    process.env.PUK_PREVIEW_CHROMIUM,
    process.platform === "win32" ? join(ROOT, "node_modules/.remotion/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe") : undefined,
    process.platform === "linux" ? join(ROOT, "node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell") : undefined,
    chromium.executablePath(),
  ];
  return candidates.find((path): path is string => Boolean(path && existsSync(path)));
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const doc = (globalThis as any).document, viewport = (globalThis as any).innerWidth as number;
    const root = doc.documentElement, body = doc.body;
    const overflow = Math.max(root.scrollWidth, body?.scrollWidth ?? 0) - viewport;
    const visible = (element: any) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const overflowing = [...doc.querySelectorAll("body *")].filter((element: any) => {
      if (!visible(element)) return false;
      const rect = element.getBoundingClientRect(), style = (globalThis as any).getComputedStyle(element);
      return style.position !== "fixed" && (rect.right > viewport + 2 || rect.left < -2);
    }).slice(0, 8).map((element: any) => `${element.tagName.toLowerCase()}${element.id ? "#" + element.id : ""}: ${String(element.textContent ?? "").trim().slice(0, 65)}`);
    const links = [...doc.querySelectorAll("a[href]")].slice(0, 120).map((element: any) => ({ href: element.getAttribute("href") as string, text: String(element.textContent ?? "").trim().slice(0, 80) }));
    const images = [...doc.images].filter((image: any) => { const rect = image.getBoundingClientRect(); return visible(image) && rect.bottom > 0 && rect.top < (globalThis as any).innerHeight && rect.right > 0 && rect.left < viewport; }).map((image: any) => ({ src: String(image.getAttribute("src") ?? "").slice(0, 160), loaded: image.complete && image.naturalWidth > 0 }));
    const anchors = [...doc.querySelectorAll("[id], a[name]")].map((element: any) => element.id || element.getAttribute("name"));
    return { overflow, overflowing, links, images, anchors, title: doc.title as string, text: String(body?.innerText ?? "").trim().slice(0, 1000) };
  });
}

/** Render generated files in an isolated headless browser. This is automated
 * layout/runtime evidence; callers must still inspect the saved screenshots. */
export async function previewArtifacts(options: PreviewOptions): Promise<PreviewResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  const result: PreviewResult = { checks: [], screenshots: [] };
  const check = (name: string, passed: boolean, detail: string) => result.checks.push({ name, passed, detail });
  const directory = resolve(options.directory), outputDir = resolve(options.outputDir);
  let entryParts: string[];
  try {
    entryParts = fileParts(options.entrypoint.replaceAll("\\", "/"));
    await regularFile(directory, entryParts);
    if (![".html", ".htm"].includes(extname(entryParts.at(-1)!).toLowerCase())) throw new Error("Preview entrypoint must be HTML");
    await mkdir(outputDir, { recursive: true });
  } catch (error) { check("preview-entrypoint", false, String(error)); return result; }
  const executablePath = previewBrowserExecutable();
  if (!executablePath) { check("preview-browser", false, "No isolated Chromium binary found. Install the Remotion browser or configure PUK_PREVIEW_CHROMIUM with a browser executable."); return result; }
  const prefix = `/preview/${randomUUID()}/`;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Read-only artifact preview", { status: 405 });
      if (!url.pathname.startsWith(prefix)) return new Response("Artifact only", { status: 404 });
      try {
        const parts = fileParts(url.pathname.slice(prefix.length));
        const mime = MIME[extname(parts.at(-1)!).toLowerCase()];
        if (!mime) return new Response("Unsupported artifact type", { status: 415 });
        const path = await regularFile(directory, parts);
        const file = Bun.file(path);
        return new Response(request.method === "HEAD" ? null : file, { headers: {
          "Content-Type": mime, "Content-Length": String(file.size), "Content-Security-Policy": ARTIFACT_CSP,
          "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Access-Control-Allow-Origin": "null",
        } });
      } catch { return new Response("Artifact unavailable", { status: 404 }); }
    },
  });
  const origin = server.url.origin;
  let browser: Browser | undefined;
  const cancel = () => { void browser?.close().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const deadline = setTimeout(cancel, 90_000);
  try {
    browser = await chromium.launch({ executablePath, headless: true, timeout: 20_000 });
    signal?.throwIfAborted();
    // The response sandbox itself disables service workers. Playwright's
    // serviceWorkers:block init script accesses navigator.serviceWorker and
    // throws in an opaque-origin document, creating a spurious page error.
    const context = await browser.newContext({ acceptDownloads: false, reducedMotion: "reduce", colorScheme: "light" });
    const blocked = new Set<string>(), failures = new Set<string>(), errors = new Set<string>();
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin || !url.pathname.startsWith(prefix) || request.method() !== "GET" && request.method() !== "HEAD") {
        blocked.add(`${request.method()} ${url.origin}${url.pathname}`.slice(0, 220)); await route.abort("blockedbyclient");
      } else await route.continue();
    });
    context.on("page", page => {
      page.on("pageerror", error => errors.add(error.message.slice(0, 240)));
      page.on("console", message => { if (message.type() === "error") errors.add(message.text().slice(0, 240)); });
      page.on("response", response => { if (response.status() >= 400) failures.add(`${response.status()} ${new URL(response.url()).pathname.slice(prefix.length)}`); });
      page.on("requestfailed", request => {
        // Chromium cancels superseded range downloads on seek/navigation and
        // after sufficient buffering. Actual load/decode/time advancement is
        // checked below; a cancellation alone is not a broken media resource.
        if(request.resourceType()==="media"&&request.failure()?.errorText==="net::ERR_ABORTED")return;
        failures.add(`${request.failure()?.errorText ?? "failed"} ${new URL(request.url()).pathname.slice(0, 160)}`);
      });
      page.on("dialog", dialog => { errors.add(`Unexpected ${dialog.type()} dialog`); void dialog.dismiss(); });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(15_000);
    const paths = [entryParts.map(encodeURIComponent).join("/")], discovered = new Set(paths), visited = new Set<string>();
    const linkFailures = new Set<string>();
    const anchorsByPath = new Map<string, Set<string>>(), wantedAnchors: { path: string; id: string; source: string }[] = [];
    const maxPages = 6;
    for (let index = 0; index < paths.length && index < maxPages; index++) {
      const path = paths[index]!;
      visited.add(path);
      for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
        signal?.throwIfAborted();
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const response = await page.goto(`${origin}${prefix}${path}`, { waitUntil: "load" });
        await page.evaluate(async () => { await (globalThis as any).document.fonts.ready; });
        // Let layout effects and lazy images settle without a network-idle wait.
        await page.waitForTimeout(200);
        const state = await snapshot(page);
        anchorsByPath.set(path, new Set(state.anchors));
        const label = `${viewport.name}${index ? `-page${index + 1}` : ""}`;
        const videos = await page.evaluate(async(previewTime)=>{
          const doc=(globalThis as any).document;
          const wait=(element:any,event:string,predicate:()=>boolean)=>new Promise<void>((resolve,reject)=>{
            if(predicate()){resolve();return;}
            const clean=()=>{clearTimeout(timer);element.removeEventListener(event,ready);element.removeEventListener("error",failed);};
            const ready=()=>{if(predicate()){clean();resolve();}},failed=()=>{clean();reject(new Error("Video decode or loading failed"));};
            const timer=setTimeout(()=>{clean();reject(new Error(`Video ${event} timed out`));},8000);
            element.addEventListener(event,ready);element.addEventListener("error",failed);
          });
          const observed=[];
          for(const video of [...doc.querySelectorAll("video")].slice(0,3) as any[]){
            try{
              video.muted=true;video.preload="auto";video.load();await wait(video,"loadeddata",()=>video.readyState>=2);
              const target=typeof previewTime==="number"&&Number.isFinite(previewTime)?Math.min(Math.max(0,previewTime),Math.max(0,video.duration-.5)):Math.min(15,video.duration*.2);
              video.currentTime=target;await wait(video,"seeked",()=>!video.seeking&&video.readyState>=2);
              const before=video.currentTime;await video.play();await wait(video,"timeupdate",()=>video.currentTime>before+.1);video.pause();
              const tracks=[];for(const track of [...video.querySelectorAll("track")] as any[]){track.track.mode="hidden";await wait(track,"load",()=>track.readyState===2);tracks.push({loaded:track.readyState===2,cues:track.track.cues?.length??0});}
              observed.push({passed:video.videoWidth>0&&video.videoHeight>0,duration:video.duration,width:video.videoWidth,height:video.videoHeight,time:video.currentTime,tracks});
            }catch(error){video.pause();observed.push({passed:false,error:String(error)});}
          }return observed;
        }, options.videoTimeSeconds);
        if(videos.length)check(`${label}-video-playback`,videos.every(video=>video.passed),JSON.stringify(videos));
        check(`${label}-loaded`, response?.status() === 200 && Boolean(state.text || state.images.length), `${path}: HTTP ${response?.status() ?? "none"}; title ${state.title || "(untitled)"}`);
        check(`${label}-overflow`, state.overflow <= 2 && state.overflowing.length === 0, state.overflow > 2 || state.overflowing.length ? `${state.overflow}px document overflow; ${state.overflowing.join("; ")}` : `No horizontal overflow at ${viewport.width}×${viewport.height}`);
        check(`${label}-images`, state.images.every(image => image.loaded), state.images.some(image => !image.loaded) ? `Unloaded visible images: ${state.images.filter(image => !image.loaded).map(image => image.src).join(", ")}` : `${state.images.length} visible image(s) loaded`);
        const screenshot = join(outputDir, `${label}.png`);
        await page.screenshot({ path: screenshot, fullPage: false, animations: "disabled" });
        result.screenshots.push(screenshot);
        for (const link of state.links) {
          if (!link.href || /^(?:mailto:|tel:)/i.test(link.href)) continue;
          const url = new URL(link.href, page.url());
          if (!["http:", "https:"].includes(url.protocol)) { linkFailures.add(`Unsupported navigation ${link.href.slice(0, 120)}`); continue; }
          if (url.origin !== origin) continue; // Citations are not followed by this local-only validator.
          if (!url.pathname.startsWith(prefix)) { linkFailures.add(`Link leaves the artifact: ${link.href}`); continue; }
          const next = url.pathname.slice(prefix.length);
          if (url.hash) {
            let id = url.hash.slice(1); try { id = decodeURIComponent(id); } catch { /* malformed fragment fails its lookup */ }
            if (next === path && !state.anchors.includes(id)) linkFailures.add(`Missing anchor ${link.href} in ${path}`);
            else if (next !== path) wantedAnchors.push({ path: next, id, source: `${link.href} from ${path}` });
          }
          if (!discovered.has(next)) {
            discovered.add(next);
            const local = await server.fetch(new Request(url.toString(), { method: "HEAD" }));
            if (!local.ok) linkFailures.add(`${local.status} local link ${link.href}`);
            else if ([".html", ".htm"].includes(extname(next).toLowerCase())) paths.push(next);
          }
        }
      }
    }
    for (const anchor of wantedAnchors) {
      if (anchorsByPath.has(anchor.path) && !anchorsByPath.get(anchor.path)!.has(anchor.id)) linkFailures.add(`Missing cross-page anchor ${anchor.source}`);
    }
    check("local-navigation", linkFailures.size === 0, linkFailures.size ? [...linkFailures].join("; ") : `${discovered.size} local file target(s) checked; ${visited.size} HTML page(s) rendered at both sizes`);
    check("local-page-coverage", paths.length <= maxPages, paths.length > maxPages ? `Only ${maxPages} of ${paths.length} discovered HTML pages inspected; reduce the bundle or extend the explicit bound` : "All discovered local HTML pages within the six-page bound were rendered");
    check("loaded-assets", failures.size === 0, failures.size ? [...failures].slice(0, 12).join("; ") : "No failed local asset or page requests");
    check("runtime-errors", errors.size === 0, errors.size ? [...errors].slice(0, 8).join("; ") : "No browser JavaScript or console errors during the inspected pages");
    check("local-only-resources", blocked.size === 0, blocked.size ? `Blocked external or control requests: ${[...blocked].slice(0, 8).join("; ")}` : "The preview required no external network or control API requests");
    check("automated-preview-scope", true, "Screenshots are saved for human/model visual inspection. These checks establish observed layout, links, asset loading and runtime behavior only; they are not a visual quality or task-correctness verdict.");
  } catch (error) {
    signal?.throwIfAborted();
    check("preview-runtime", false, String(error).slice(0, 800));
  } finally {
    clearTimeout(deadline); signal?.removeEventListener("abort", cancel);
    await browser?.close().catch(() => {}); server.stop(true);
  }
  return result;
}
