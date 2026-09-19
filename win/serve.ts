#!/usr/bin/env bun
/**
 * Puk on Windows: `bun win/serve.ts [hands]`.
 *
 * Runs the unchanged panel server from hotkey.ts with Windows parts plugged
 * into its dependency seams: virtual-desktop hands and Cua (win/desktop.ts),
 * a native microphone, a held-key listener, picture-in-picture previews and
 * the caption shown while the key is held (win/hud.ts; PUK_HUD=0 skips it).
 *
 * hotkey.ts serves /desktop.png and /desktop/* through pip.ts (Hyprland), and
 * those routes are not injectable. So the panel server listens on a private
 * port and this file fronts it: the three desktop routes are answered here,
 * everything else is handed to it in-process.
 *
 * /login is answered here too: GET says how each hand's sign-in stands, POST
 * /login?hand=1 (or 1,2 or all) opens that hand's browser on the user's desktop
 * for them to sign in (win/desktop.ts `signIn`). `bun win/desktop.ts login`
 * calls it when this server is running, because the server owns those browsers.
 */
import { debugLog, subprocessEnv, type Hand } from "../desktop";
import { isLocalRequest, servePuk, startRecording } from "../hotkey";
import type { HandState } from "../pip";
import { createJevFirstAgent } from "./jev";
import { attachExistingBrowser, browserTarget, captureBound, closeWindowsDesktop, detachExistingBrowser, driver, ensureHelper, existingBrowserCandidates, focusExistingBrowser, getHand, handFor, helper, listHands, restoreExistingBrowsers, signInAll, signInStatus, startHands, warmBrowser, windowsDesktop, type BrowserTarget } from "./desktop";
import { loginTargets } from "./session";
import { createHud, hudEnabled, type HudStatus } from "./hud";
import { artifactResponse } from "./artifacts";
import { evalsResponse } from "./eval-observer";
import type { AgentStatus } from "../ai";

/** The Windows control page; the shared panel.html stays for Linux. Same CSP as hotkey.ts sends for its page. */
const WIN_PANEL = Bun.file(new URL("./panel.html", import.meta.url));
export const PANEL_CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'";
export async function panelResponse(request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (request.method !== "GET" || (path !== "/" && path !== "/index.html")) return null;
  return new Response(await WIN_PANEL.text(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PANEL_CSP } });
}

/** An image belongs to the hand requested by the client, even if selection changes
 * while it is being captured. Never fall back to another hand's image. */
export async function previewResponse(request: Request, deps: {
  selected(): Promise<Hand>; lookup(id: number): Promise<Hand | null>; capture: typeof captureBound; target?: typeof browserTarget;
}): Promise<Response> {
  const params = new URL(request.url).searchParams, wanted = params.get("hand"), expected = params.get("target");
  if (wanted !== null && !/^[1-9]\d*$/.test(wanted)) return new Response("Invalid hand", { status: 400 });
  const hand = wanted === null ? await deps.selected() : await deps.lookup(Number(wanted));
  if (!hand) return new Response("Hand unavailable", { status: 404 });
  try {
    const target = deps.target?.(hand);
    if (expected !== null && (!target || previewTargetKey(hand.id, target) !== expected)) return new Response("Browser target changed", { status: 409 });
    const frame = await deps.capture(hand, true);
    const current = deps.target?.(hand);
    if (expected !== null && (!current || previewTargetKey(hand.id, current) !== expected)) return new Response("Browser target changed", { status: 409 });
    if (current?.mode === "existing" && (frame.window?.pid !== current.pid || frame.window.containerId !== current.window_id || frame.window.ownerNonce !== current.ownerNonce)) return new Response("Browser target unavailable", { status: 503 });
    return new Response(Buffer.from(frame.data, "base64"), { headers: {
      "Content-Type": "image/png", "Cache-Control": "no-store", "X-Puk-Hand": String(hand.id),
      "X-Puk-Window": String(frame.window?.containerId ?? 0),
      "X-Puk-Pid": String(frame.window?.pid ?? 0), "X-Puk-Owner-Nonce": frame.window?.ownerNonce ?? "",
    } });
  } catch { return new Response("Desktop unavailable", { status: 503 }); }
}

/** Shared wire shape with panel.html: selection includes the browser identity,
 * because changing a hand's target must invalidate its old in-flight image. */
export const previewTargetKey = (hand: number, target: BrowserTarget = { mode: "private" }) => JSON.stringify(target.mode === "existing"
  ? [hand, target.mode, target.pid, target.window_id, target.ownerNonce] : [hand, "private"]);

/** Multiple callers share one expensive observation. Its render reads the
 * newest status after awaiting native state, so an old poll cannot paint over it. */
export function coalesceLatest<T>(work: (latest: () => T) => Promise<void>) {
  let latest: T, active: Promise<void> | undefined;
  return (value: T) => {
    latest = value;
    return active ??= work(() => latest).finally(() => { active = undefined; });
  };
}

/** Preview caption: `task · title`, the dot omitted when either half is empty. PipForm splits on the
 * wire-inserted middle dot, so any U+00B7 inside the halves becomes a hyphen first. */
export function previewLabel(task: string, title: string): string {
  const clean = (s: string) => s.replace(/·/g, "-").replace(/\s+/g, " ").trim();
  return [clean(task), clean(title)].filter(Boolean).join(" · ").slice(0, 120);
}

/** F1..F24, or a Windows virtual-key number. */
export function virtualKey(name = "F8"): number {
  const f = /^f(\d{1,2})$/i.exec(name.trim());
  const vk = f ? 0x6f + Number(f[1]) : Number(name);
  if (!Number.isInteger(vk) || vk < 1 || vk > 254 || (f && (Number(f[1]) < 1 || Number(f[1]) > 24))) throw new Error("PUK_HOTKEY must be F1 to F24 or a virtual-key number.");
  return vk;
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  let buffered = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    for (let end; (end = buffered.indexOf("\n")) >= 0; buffered = buffered.slice(end + 1)) yield buffered.slice(0, end).trim();
  }
}

/** Register cleanup immediately after acquiring each resource, so a failure in
 * any later startup stage closes the same resources as normal shutdown. */
export function serverResources(closeDesktop: () => void | Promise<void> = closeWindowsDesktop) {
  const close: (() => void | Promise<void>)[] = [closeDesktop];
  let closing: Promise<void> | undefined;
  return {
    add(dispose: () => void | Promise<void>) { close.push(dispose); },
    close() {
      return closing ??= (async () => {
        for (const dispose of close.toReversed()) {
          try { await dispose(); } catch (error) { debugLog("win.shutdown", String(error)); }
        }
      })();
    },
  };
}

if (import.meta.main) {
  const resources = serverResources();
  const shutdown = async (code = 0) => {
    // A blocked RPC must not keep a failed server alive through helper pipes.
    await Promise.race([resources.close(), Bun.sleep(2000)]);
    process.exit(code);
  };
  try {
    const exe = await ensureHelper();
    const hands = await startHands(Math.max(1, Math.min(4, Number(process.argv[2] ?? process.env.PUK_HANDS ?? 2) || 2)));
    await restoreExistingBrowsers(hands);
    const native = (mode: string[]) => {
      const proc = Bun.spawn([exe, ...mode], { env: subprocessEnv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      resources.add(() => { try { proc.stdin.end(); } catch { /* already stopped */ } });
      return proc;
    };

    // Previews: one line per hand per second; the helper draws, and reports clicks.
    const pip = native(["pip"]);
    // A short task would otherwise blink its preview on and off: hold the result a moment.
    const busyUntil = new Map<number, number>();
    const captions = new Map<number, string>(), tasks = new Map<number, string>(), tools = new Map<number, string>();
    const artifacts = new Map<number, NonNullable<AgentStatus["artifact"]>>();
    const painters = new Map<number, ReturnType<typeof coalesceLatest<{ hand: Hand; state: HandState }>>>();
    function paint(hand: Hand, state: HandState) {
      let painter = painters.get(hand.id);
      if (!painter) {
        painter = coalesceLatest(async (latest: () => { hand: Hand; state: HandState }) => {
          const hand = latest().hand, expected = previewTargetKey(hand.id, browserTarget(hand));
          let front = artifacts.has(hand.id) ? undefined : (await windowsDesktop.state(hand)).windows.find((w) => w.focused);
          const target = browserTarget(hand);
          if (previewTargetKey(hand.id, target) !== expected || target.mode === "existing" && (front?.pid !== target.pid || front.containerId !== target.window_id || front.ownerNonce !== target.ownerNonce)) front = undefined;
          // A long observation started before artifact generation may complete
          // afterward. Recheck before publishing its old browser thumbnail.
          const artifact = artifacts.get(hand.id);
          if (artifact) front = undefined;
          const state = latest().state;
          if (state !== "idle") busyUntil.set(hand.id, Date.now() + 6000);
          const shown = state === "idle" && Date.now() < (busyUntil.get(hand.id) ?? 0) ? "done" : state;
          // Before the hand has a window, the current tool is the only thing to say about it.
          // An artifact hand reads "video · rendering 40%" (previewLabel turns the dot into a hyphen); the bare phase is the fallback.
          const title = artifact ? (artifact.progress ? `${artifact.kind} · ${artifact.progress}` : `${artifact.kind}: ${artifact.phase}`) : captions.get(hand.id) || front?.title || (front ? "" : tools.get(hand.id)) || "";
          pip.stdin.write(`hand ${hand.id} ${front?.containerId ?? 0} ${shown} ${previewLabel(shown === "idle" ? "" : tasks.get(hand.id) ?? "", title)}\n`);
          await pip.stdin.flush();
        });
        painters.set(hand.id, painter);
      }
      return painter({ hand, state });
    }
    // The F8 caption: what the user sees while holding the key, without looking at the browser.
    const hudProc = hudEnabled() ? native(["hud"]) : null;
    // flush() can reject once the card has exited; an unhandled rejection would take the whole server down with it.
    const { hudLine, hudListening, hudDelta, hudFinishing, hudCancelled, driveHud, hudEpoch } = createHud(hudProc && ((line) => { hudProc.stdin.write(line + "\n"); Promise.resolve(hudProc.stdin.flush()).catch(() => {}); }));

    const inner = await servePuk({
      port: 0, handId: hands[0]!.id,
      dependencies: {
        hand: getHand, hands: listHands, handState: paint,
        // Jev drives the browser and opens apps; Pi takes the remaining work.
        agent: (opts) => createJevFirstAgent(opts),
        // Words reach the caption the moment they arrive, not on the next poll.
        record: (opts) => startRecording({ ...opts, onDelta: (delta) => { opts?.onDelta?.(delta); hudDelta(delta); }, capture: () => {
          const mic = native(["mic"]);
          // The helper stops when its stdin closes; signals do not cross WSL interop.
          return { stdout: mic.stdout, stderr: mic.stderr, exited: mic.exited, kill: (signal) => { if (signal === "SIGKILL") mic.kill(); else mic.stdin.end(); } };
        } }),
      },
    });
    resources.add(() => inner.close());
    const local = (path: string, init?: RequestInit) => inner.server.fetch(new Request(`${inner.server.url.origin}${path}`, init));
    const selected = async () => (await getHand(Number(((await (await local("/status")).json()) as { hand?: number }).hand))) ?? hands[0]!;

    // servePuk repaints once a second. A preview that appears the moment a hand
    // starts is most of what makes it feel alive, so look more often.
    type Worker = { hand: number; agent: Pick<AgentStatus, "running" | "error" | "approval" | "narration" | "task" | "currentTool" | "artifact"> };
    let quickRunning = false;
    const quick = setInterval(async () => {
      if (quickRunning) return;
      quickRunning = true;
      try {
        const at = hudEpoch();
        const status = (await (await local("/status")).json()) as HudStatus & { workers: Worker[] };
        for (const { hand: id, agent } of status.workers) {
          if (agent.artifact) artifacts.set(id, agent.artifact); else artifacts.delete(id);
          if (agent.narration) captions.set(id, agent.narration); else captions.delete(id);
          if (agent.currentTool) tools.set(id, agent.currentTool); else tools.delete(id);
          // agent.task outlives the run; keep the last one so the 6 s done hold still names it.
          if (agent.running || agent.approval) tasks.set(id, agent.task);
          const hand = hands.find((h) => h.id === id);
          if (hand) await paint(hand, agent.approval ? "review" : agent.running ? "working" : agent.error ? "error" : "idle");
        }
        driveHud(status, at);
      } catch { /* shutting down */ }
      finally { quickRunning = false; }
    }, 300);
    quick.unref();
    resources.add(() => clearInterval(quick));

    // Entering a hand is a desktop switch; the same control brings the user back.
    let cameFrom: string | undefined;
    async function enter(hand: Hand) {
      if (browserTarget(hand).mode === "existing") { await focusExistingBrowser(hand); return; }
      const ask = (await helper()).ask, here = JSON.parse(await ask("where"));
      if (here === hand.display) return leave();
      if (!/^Puk hand \d+$/.test(here)) cameFrom = here;
      await ask(`goto ${hand.display}`);
    }
    async function leave() {
      if (cameFrom) await (await helper()).ask(`goto ${cameFrom}`);
    }
    void (async () => { for await (const line of lines(pip.stdout)) { const hand = await getHand(Number(line.split(" ")[1])); if (line.startsWith("enter ") && hand) await enter(hand).catch((e) => debugLog("win.pip", String(e))); } })();

    const server = Bun.serve({
      hostname: "127.0.0.1", port: Number(process.env.PUK_PORT ?? 7777), maxRequestBodySize: 20_000,
      async fetch(request) {
        const artifact = await artifactResponse(request);
        if (artifact) return artifact;
        if (!isLocalRequest(request)) return new Response("Local requests only", { status: 403 });
        const path = new URL(request.url).pathname;
        const page = await panelResponse(request);
        if (page) return page;
        const evals = await evalsResponse(request);
        if (evals) return evals;
        if (request.method === "GET" && path === "/status") {
          const state = await (await local("/status")).json() as { hand: number; workers: { hand: number }[] };
          return Response.json({ ...state, workers: state.workers.map(worker => {
            const hand = hands.find(hand => hand.id === worker.hand);
            return { ...worker, browser: hand ? browserTarget(hand) : { mode: "private" } };
          }) });
        }
        if (path === "/browser") {
          try {
            if (request.method === "GET") return Response.json({ candidates: await existingBrowserCandidates(), target: browserTarget(await selected()) });
            if (request.method !== "POST") return new Response("Use POST", { status: 405 });
            const body = await request.json() as { mode?: string; hand?: number; window_id?: number; pid?: number };
            if (!["existing", "private"].includes(body.mode ?? "") || body.hand !== undefined && (!Number.isInteger(body.hand) || body.hand < 1)
              || body.window_id !== undefined && (!Number.isInteger(body.window_id) || body.window_id < 1) || body.pid !== undefined && (!Number.isInteger(body.pid) || body.pid < 1)) return Response.json({ error: "Choose a valid browser target." }, { status: 400 });
            const hand = body.hand === undefined ? await selected() : await getHand(body.hand);
            if (!hand) return Response.json({ error: "Hand unavailable." }, { status: 404 });
            const status = await (await local("/status")).json() as { workers: { hand: number; agent: { running: boolean } }[] };
            if (status.workers.find(worker => worker.hand === hand.id)?.agent.running) return Response.json({ error: "Correct this hand's task to change its browser while it is working." }, { status: 409 });
            const target = body.mode === "existing" ? await attachExistingBrowser(hand, { window_id: body.window_id, pid: body.pid }) : await detachExistingBrowser(hand);
            return Response.json({ target });
          } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Browser connection failed." }, { status: 400 }); }
        }
        if (request.method === "GET" && path === "/desktop.png") {
          return previewResponse(request, { selected, lookup: getHand, capture: captureBound, target: browserTarget });
        }
        if (request.method === "POST" && path.startsWith("/desktop/")) {
          try {
            if (path === "/desktop/enter") await enter(await selected());
            else if (path === "/desktop/back") await leave();
            return Response.json({ ok: true });
          } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Desktop switch failed." }, { status: 400 }); }
        }
        if (path === "/login" && (request.method === "GET" || request.method === "POST")) {
          if (request.method === "GET") return Response.json({ puk: "login", hands: signInStatus() });
          try {
            const ids = loginTargets([new URL(request.url).searchParams.get("hand") ?? "all"], hands.map((h) => h.id));
            // Its browser is about to be closed: not under a task that is using it.
            const { workers } = (await (await local("/status")).json()) as { workers: Worker[] };
            const busy = ids.filter((id) => workers.some((w) => w.hand === id && (w.agent.running || w.agent.approval)));
            if (busy.length) return Response.json({ error: `Hand ${busy.join(" and ")} is working. Stop it or let it finish, then sign in.` }, { status: 409 });
            void signInAll(ids.map(handFor));
            return Response.json({ puk: "login", hands: signInStatus() });
          } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Signing in could not start." }, { status: 400 }); }
        }
        return inner.server.fetch(request);
      },
    });
    resources.add(() => { server.stop(true); });

    // Hold to speak. Ctrl+Alt+Esc stops everything, as on Omarchy.
    const key = process.env.PUK_HOTKEY ?? "F8";
    const hotkey = native(["hotkey", String(virtualKey(key))]);
    void (async () => {
      for await (const line of lines(hotkey.stdout)) {
        // A refused hold (previous recording still finishing, no key) used to be silent; the caption says why.
        if (line === "down") { if (inner.controller.down()) hudListening(); else hudLine(`error ${inner.controller.status().lastError ?? "Voice capture is not ready."}`); }
        else if (line === "up") { if (inner.controller.up()) hudFinishing(); }
        else if (line === "cancel") { hudCancelled(); await local("/stop", { method: "POST" }); }
      }
    })();

    // Do not launch background work until all startup resources are ready. A
    // failed bind or hotkey must not leave a browser-prewarm task still spawning.
    void windowsDesktop.discover().catch(() => {});
    for (const hand of hands) void driver(hand).catch(() => {});
    if (process.env.PUK_WIN_PREWARM !== "0") void (async () => { for (const hand of hands) await warmBrowser(hand).catch((e) => debugLog("win.prewarm", String(e))); })();

    console.log(`Puk is ready at ${server.url} with ${hands.length} hand${hands.length > 1 ? "s" : ""} (hold ${key} to speak, release to send).`);
    process.on("SIGINT", () => { void shutdown(); });
    process.on("SIGTERM", () => { void shutdown(); });
  } catch (error) { console.error(error instanceof Error ? error.message : "Puk could not start."); await shutdown(1); }
}
