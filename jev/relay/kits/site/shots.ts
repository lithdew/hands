// kits/site/shots.ts — stills of the page at a desktop and a phone width, from a headless Chrome. No window opens.
//
// There is no desktop browser here. Remotion's chrome-headless-shell is on disk (my-video/), and runs once
// it is told where its shared libraries are. Both paths can be given (PUK_CHROME, PUK_CHROME_LIBS); else
// they are looked for in this checkout and, from a git worktree, in the main one.
//
// This build of the shell ignores --screenshot and --dump-dom (it starts and waits for ever), so it is
// driven the way Remotion drives it: a DevTools port, and a few commands over a WebSocket. Everything has
// a deadline, and the browser is killed whatever happens.
//
// The stills in shots/ each show BOTH widths side by side (top of the page, the projects, the last
// section): a still is looked at alone, and "readable on a phone and on a desktop" cannot be seen in a
// picture of one of them. The single views and the whole page at each width are in shots/single/.

import { $ } from "bun";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const CHROME = "my-video/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell";
const LIBS = "out/relay/libs/root/usr/lib/x86_64-linux-gnu";
const FLAGS = ["--headless=old", "--no-sandbox", "--disable-setuid-sandbox", "--no-zygote", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--disable-dev-shm-usage", "--enable-features=NetworkService,NetworkServiceInProcess",
  "--disable-features=IsolateOrigins,site-per-process,Translate", "--disable-extensions", "--disable-background-networking", "--disable-sync", "--mute-audio", "--no-first-run", "--hide-scrollbars", "--force-color-profile=srgb", "--force-device-scale-factor=1", "--remote-debugging-port=0"];

async function roots(): Promise<string[]> {
  const common = (await $`git rev-parse --path-format=absolute --git-common-dir`.cwd(REPO).quiet().nothrow()).stdout.toString().trim();
  return [...new Set([REPO, ...(common ? [dirname(common)] : [])])];
}

export async function findChrome(): Promise<{ chrome: string; libs: string | null } | null> {
  const all = await roots(), there = async (p: string) => (await $`test -e ${p}`.quiet().nothrow()).exitCode === 0;
  const first = async (given: string | undefined, rel: string) => { for (const p of [...(given ? [given] : []), ...all.map((r) => join(r, rel))]) if (await there(p)) return p; return null; };
  const chrome = await first(process.env.PUK_CHROME, CHROME);
  return chrome ? { chrome, libs: await first(process.env.PUK_CHROME_LIBS, LIBS) } : null;
}

export type View = { name: string; width: number; height: number; mobile?: boolean };
export const DESKTOP: View = { name: "desktop", width: 1280, height: 900 }, PHONE: View = { name: "phone", width: 390, height: 844, mobile: true };

/** Two stills of the same place on the page, side by side at their true sizes and labelled: one picture that shows the page at both widths. Whoever looks at a single still sees both. */
export const sheet = (desktopPng: string, phonePng: string, where: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#e9e9ec;font:600 15px/1 system-ui,sans-serif;color:#44464d;display:flex;gap:40px;padding:36px 40px;align-items:flex-start}
figure{margin:0}figcaption{margin:0 0 14px;letter-spacing:.04em;text-transform:uppercase;font-size:13px}
img{display:block;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.22)}
</style></head><body>
<figure><figcaption>Desktop, ${DESKTOP.width} px wide &middot; ${where}</figcaption><img src="${desktopPng}" width="${DESKTOP.width}" height="${DESKTOP.height}"></figure>
<figure><figcaption>Phone, ${PHONE.width} px wide &middot; ${where}</figcaption><img src="${phonePng}" width="${PHONE.width}" height="${PHONE.height}"></figure>
</body></html>`;

/** Which places on the page to show: its top, its projects (else its second section), its last section. Exported for tests. */
export function places(sectionIds: string[]): { id: string | null; label: string }[] {
  const middle = sectionIds.find((id) => /project|work/i.test(id)) ?? sectionIds[1], last = sectionIds.at(-1);
  return [{ id: null, label: "top of the page" }, ...[middle, last].filter((id, i, all): id is string => Boolean(id) && all.indexOf(id) === i).map((id) => ({ id, label: `section "${id}"` }))];
}

/** A DevTools connection: send a command, get its result; wait for an event. */
function devtools(ws: WebSocket) {
  let next = 1;
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>(), events: { method: string; sessionId?: string }[] = [], listeners = new Set<() => void>();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; sessionId?: string };
    if (msg.id && waiting.has(msg.id)) { const w = waiting.get(msg.id)!; waiting.delete(msg.id); msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result); }
    else if (msg.method) { events.push({ method: msg.method, sessionId: msg.sessionId }); for (const l of listeners) l(); }
  });
  return {
    send: <T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<T>((resolve, reject) => { const id = next++; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); }),
    event: (method: string, sessionId: string, ms: number) => new Promise<boolean>((resolve) => {
      const seen = () => events.some((e) => e.method === method && e.sessionId === sessionId), timer = setTimeout(() => { listeners.delete(check); resolve(seen()); }, ms);
      const check = () => { if (seen()) { clearTimeout(timer); listeners.delete(check); resolve(true); } };
      listeners.add(check); check();
    }),
  };
}

const within = <T>(ms: number, what: string, p: Promise<T>) => Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms))]);

/** Stills into `<dir>/shots/*.png`. Returns what was made and a log; never throws, never hangs. */
export async function shoot(siteDir: string, file = "index.html"): Promise<{ made: string[]; log: string }> {
  const found = await findChrome();
  if (!found) return { made: [], log: "no stills: no headless Chrome found (set PUK_CHROME and PUK_CHROME_LIBS)" };
  const out = join(siteDir, "shots"), log: string[] = [], made: string[] = [];
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  // The profile lives on the Linux side: Chrome locks files in it, and a Windows drive under WSL does not lock.
  const profile = await mkdtemp(join(tmpdir(), "puk-site-chrome-"));
  const proc = Bun.spawn([found.chrome, ...FLAGS, `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "pipe", env: { ...process.env, ...(found.libs ? { LD_LIBRARY_PATH: [found.libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") } : {}) } });
  try {
    const endpoint = await within(45_000, "Chrome's DevTools port", (async () => { let text = ""; const decoder = new TextDecoder(); for await (const chunk of proc.stderr) { text += decoder.decode(chunk); const m = /DevTools listening on (ws:\/\/\S+)/.exec(text); if (m) return m[1]!; } throw new Error(`Chrome ended without a DevTools port: ${text.slice(-300)}`); })());
    const ws = new WebSocket(endpoint);
    await within(15_000, "the DevTools socket", new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("the DevTools socket would not open"))); }));
    const cdp = devtools(ws);
    const open = async (v: { width: number; height: number; mobile?: boolean }, url: string) => {
      const { targetId } = await within(20_000, "a new tab", cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }));
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: Boolean(v.mobile) }, sessionId);
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Page.navigate", { url }, sessionId);
      if (!(await cdp.event("Page.loadEventFired", sessionId, 30_000))) log.push(`${url.split("/").at(-1)}: never finished loading; taken as it was`);
      await Bun.sleep(300);
      const evaluate = <T>(expression: string, otherwise: T) => cdp.send<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true }, sessionId).then((r) => r.result.value ?? otherwise, () => otherwise);
      const capture = async (to: string, whole = false) => {
        // The whole page, not only the window: the page says how tall it is, and the still is clipped to that.
        const tall = whole ? Math.min(await evaluate("Math.ceil(document.documentElement.scrollHeight)", v.height), 8000) : v.height;
        const { data } = await within(30_000, "the still", cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", ...(whole ? { captureBeyondViewport: true, clip: { x: 0, y: 0, width: v.width, height: tall, scale: 1 } } : {}) }, sessionId));
        await Bun.write(join(out, to), Buffer.from(data, "base64"));
      };
      return { evaluate, capture, close: () => cdp.send("Target.closeTarget", { targetId }).catch(() => {}) };
    };
    const pageUrl = `file://${join(siteDir, file)}`;
    let where: ReturnType<typeof places> = [];
    for (const view of [DESKTOP, PHONE]) {
      const tab = await open(view, pageUrl);
      if (view === DESKTOP) where = places(await tab.evaluate<string[]>("[...document.querySelectorAll('section[id]')].map((s) => s.id)", []));
      const overflow = await tab.evaluate("document.documentElement.scrollWidth - window.innerWidth", 0);
      log.push(`${view.name}, ${view.width}px: ${overflow > 1 ? `WARNING the page is ${overflow}px wider than the window and scrolls sideways` : "nothing scrolls sideways"}`);
      for (const [i, place] of where.entries()) {
        // A page with smooth scrolling would still be on its way when the still is taken: scroll at once, to a computed place.
        await tab.evaluate(`(document.documentElement.style.scrollBehavior = "auto", window.scrollTo(0, ${place.id ? `Math.max(0, (document.getElementById(${JSON.stringify(place.id)})?.getBoundingClientRect().top ?? 0) + window.scrollY - 16)` : "0"}), 1)`, 1);
        await Bun.sleep(150);
        await tab.capture(`single/${view.name}-${i + 1}.png`);
      }
      await tab.evaluate("(window.scrollTo(0, 0), 1)", 1);
      await tab.capture(`single/${view.name}-whole-page.png`, true);
      made.push(`site/shots/single/${view.name}-whole-page.png`);
      await tab.close();
    }
    // Every still in shots/ shows both widths: whoever judges one picture alone can see the page on a desktop and on a phone.
    for (const [i, place] of where.entries()) {
      const name = `${i + 1}-${(place.id ?? "top").replace(/[^a-z0-9-]/gi, "")}-both-widths.png`;
      await Bun.write(join(out, "sheet.html"), sheet(`single/desktop-${i + 1}.png`, `single/phone-${i + 1}.png`, place.label));
      const tab = await open({ width: DESKTOP.width + PHONE.width + 120, height: Math.max(DESKTOP.height, PHONE.height) + 110 }, `file://${join(out, "sheet.html")}`);
      await tab.capture(name); await tab.close();
      made.unshift(`site/shots/${name}`); log.push(`still ${name}: desktop and phone side by side, ${place.label}`);
    }
    ws.close();
  } catch (e) { log.push(`stills stopped: ${e instanceof Error ? e.message : e}`); }
  finally { proc.kill(9); await rm(join(out, "sheet.html"), { force: true }); await rm(profile, { recursive: true, force: true }).catch(() => {}); }
  return { made, log: log.join("\n") };
}
