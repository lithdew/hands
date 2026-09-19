#!/usr/bin/env bun
/**
 * Puk on Windows: `bun win/serve.ts [hands]`.
 *
 * Runs the unchanged panel server from hotkey.ts with Windows parts plugged
 * into its dependency seams: virtual-desktop hands and Cua (win/desktop.ts),
 * a native microphone, a held-key listener and picture-in-picture previews.
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
import { capture, driver, ensureHelper, getHand, handFor, helper, listHands, signInAll, signInStatus, startHands, warmBrowser, windowsDesktop } from "./desktop";
import { loginTargets } from "./session";

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

if (import.meta.main) {
  try {
    const exe = await ensureHelper();
    const hands = await startHands(Math.max(1, Math.min(4, Number(process.argv[2] ?? process.env.PUK_HANDS ?? 2) || 2)));
    const native = (mode: string[]) => Bun.spawn([exe, ...mode], { env: subprocessEnv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });

    // Previews: one line per hand per second; the helper draws, and reports clicks.
    const pip = native(["pip"]);
    const label = (s: string) => s.replace(/\s+/g, " ").slice(0, 60);
    // A short task would otherwise blink its preview on and off: hold the result a moment.
    const busyUntil = new Map<number, number>();
    async function paint(hand: Hand, state: HandState) {
      const front = (await windowsDesktop.state(hand)).windows.find((w) => w.focused);
      if (state !== "idle") busyUntil.set(hand.id, Date.now() + 6000);
      const shown = state === "idle" && Date.now() < (busyUntil.get(hand.id) ?? 0) ? "done" : state;
      pip.stdin.write(`hand ${hand.id} ${front?.containerId ?? 0} ${shown} ${label(front?.title ?? "")}\n`);
      await pip.stdin.flush();
    }

    // The first task should not pay for PowerShell's app listing or a driver starting.
    void windowsDesktop.discover().catch(() => {});
    for (const hand of hands) void driver(hand).catch(() => {});
    if (process.env.PUK_WIN_PREWARM !== "0") void (async () => { for (const hand of hands) await warmBrowser(hand).catch((e) => debugLog("win.prewarm", String(e))); })();

    const inner = await servePuk({
      port: 0, handId: hands[0]!.id,
      dependencies: {
        hand: getHand, hands: listHands, handState: paint,
        // Jev drives the browser itself and opens apps; the vision agent takes what Jev cannot (win/jev.ts).
        agent: (opts) => createJevFirstAgent(opts),
        record: (opts) => startRecording({ ...opts, capture: () => {
          const mic = native(["mic"]);
          // The helper stops when its stdin closes; signals do not cross WSL interop.
          return { stdout: mic.stdout, stderr: mic.stderr, exited: mic.exited, kill: (signal) => { if (signal === "SIGKILL") mic.kill(); else mic.stdin.end(); } };
        } }),
      },
    });
    const local = (path: string, init?: RequestInit) => inner.server.fetch(new Request(`${inner.server.url.origin}${path}`, init));
    const selected = async () => (await getHand(Number(((await (await local("/status")).json()) as { hand?: number }).hand))) ?? hands[0]!;

    // servePuk repaints once a second. A preview that appears the moment a hand
    // starts is most of what makes it feel alive, so look more often.
    type Worker = { hand: number; agent: { running: boolean; error: string | null; approval: unknown } };
    const quick = setInterval(async () => {
      try {
        const { workers } = (await (await local("/status")).json()) as { workers: Worker[] };
        for (const { hand: id, agent } of workers) {
          const hand = hands.find((h) => h.id === id);
          if (hand) await paint(hand, agent.approval ? "review" : agent.running ? "working" : agent.error ? "error" : "idle");
        }
      } catch { /* shutting down */ }
    }, 300);
    quick.unref();

    // Entering a hand is a desktop switch; the same control brings the user back.
    let cameFrom: string | undefined;
    async function enter(hand: Hand) {
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
        if (!isLocalRequest(request)) return new Response("Local requests only", { status: 403 });
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === "/desktop.png") {
          try { return new Response(Buffer.from(await capture(await selected(), true), "base64"), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } }); }
          catch { return new Response("Desktop unavailable", { status: 503 }); }
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

    // Hold to speak. Ctrl+Alt+Esc stops everything, as on Omarchy.
    const key = process.env.PUK_HOTKEY ?? "F8";
    const hotkey = native(["hotkey", String(virtualKey(key))]);
    void (async () => {
      for await (const line of lines(hotkey.stdout)) {
        if (line === "down") inner.controller.down();
        else if (line === "up") inner.controller.up();
        else if (line === "cancel") await local("/stop", { method: "POST" });
      }
    })();

    console.log(`Puk is ready at ${server.url} with ${hands.length} hand${hands.length > 1 ? "s" : ""} (hold ${key} to speak, release to send).`);
    const shutdown = async () => {
      clearInterval(quick);
      server.stop(true);
      for (const proc of [pip, hotkey]) proc.stdin.end();
      await inner.close();
      (await helper()).close();
      process.exit();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) { console.error(error instanceof Error ? error.message : "Puk could not start."); process.exitCode = 1; }
}
