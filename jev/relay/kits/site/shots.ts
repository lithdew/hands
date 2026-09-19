// kits/site/shots.ts — stills of the page at a desktop and a phone width, from a headless Chrome. No window opens.
//
// There is no desktop browser here. Remotion's chrome-headless-shell is on disk (my-video/), and runs once
// it is told where its shared libraries are. Both paths can be given (PUK_CHROME, PUK_CHROME_LIBS); else
// they are looked for in this checkout and, from a git worktree, in the main one.
//
// This build of the shell ignores --screenshot and --dump-dom (it starts and waits for ever), so it is
// driven the way Remotion drives it: a DevTools port, and four commands over a WebSocket. Everything has
// a deadline, and the browser is killed whatever happens.

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

export type Shot = { name: string; width: number; height: number; mobile?: boolean; whole?: boolean };
export const DESKTOP: Shot = { name: "1-desktop", width: 1280, height: 900 }, PHONE: Shot = { name: "2-phone", width: 390, height: 844, mobile: true };

/** The two stills side by side at their true sizes, labelled: one picture that shows the page at both widths. */
export const sheet = (desktop: Shot, phone: Shot) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#e9e9ec;font:600 15px/1 system-ui,sans-serif;color:#44464d;display:flex;gap:40px;padding:36px 40px;align-items:flex-start}
figure{margin:0}figcaption{margin:0 0 14px;letter-spacing:.04em;text-transform:uppercase;font-size:13px}
img{display:block;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.22)}
</style></head><body>
<figure><figcaption>Desktop, ${desktop.width} px wide</figcaption><img src="${desktop.name}.png" width="${desktop.width}" height="${desktop.height}"></figure>
<figure><figcaption>Phone, ${phone.width} px wide</figcaption><img src="${phone.name}.png" width="${phone.width}" height="${phone.height}"></figure>
</body></html>`;

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
    const still = async (s: Shot, url: string) => {
      const { targetId } = await within(20_000, "a new tab", cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }));
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: s.width, height: s.height, deviceScaleFactor: 1, mobile: Boolean(s.mobile) }, sessionId);
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Page.navigate", { url }, sessionId);
      if (!(await cdp.event("Page.loadEventFired", sessionId, 30_000))) log.push(`still ${s.name}: the page never finished loading; taken as it was`);
      await Bun.sleep(300);
      const overflow = await cdp.send<{ result: { value: number } }>("Runtime.evaluate", { expression: "document.documentElement.scrollWidth - window.innerWidth", returnByValue: true }, sessionId).then((r) => r.result.value, () => 0);
      // The whole page, not only the window: the page says how tall it is, and the still is clipped to that.
      const tall = s.whole ? await cdp.send<{ result: { value: number } }>("Runtime.evaluate", { expression: "Math.ceil(document.documentElement.scrollHeight)", returnByValue: true }, sessionId).then((r) => Math.min(r.result.value, 8000), () => s.height) : s.height;
      const { data } = await within(30_000, "the still", cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", ...(s.whole ? { captureBeyondViewport: true, clip: { x: 0, y: 0, width: s.width, height: tall, scale: 1 } } : {}) }, sessionId));
      await Bun.write(join(out, `${s.name}.png`), Buffer.from(data, "base64"));
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      made.push(`site/shots/${s.name}.png`); log.push(`still ${s.name}: ${s.width}x${s.height}${overflow > 1 ? `; WARNING the page is ${overflow}px wider than the window and scrolls sideways` : "; nothing scrolls sideways"}`);
    };
    const pageUrl = `file://${join(siteDir, file)}`;
    await still(DESKTOP, pageUrl); await still(PHONE, pageUrl);
    await Bun.write(join(out, "sheet.html"), sheet(DESKTOP, PHONE));
    await still({ name: "3-both-widths", width: DESKTOP.width + PHONE.width + 120, height: Math.max(DESKTOP.height, PHONE.height) + 110 }, `file://${join(out, "sheet.html")}`);
    await still({ ...DESKTOP, name: "4-desktop-whole-page", whole: true }, pageUrl); await still({ ...PHONE, name: "5-phone-whole-page", whole: true }, pageUrl);
    ws.close();
  } catch (e) { log.push(`stills stopped: ${e instanceof Error ? e.message : e}`); }
  finally { proc.kill(9); await rm(join(out, "sheet.html"), { force: true }); await rm(profile, { recursive: true, force: true }).catch(() => {}); }
  return { made, log: log.join("\n") };
}
