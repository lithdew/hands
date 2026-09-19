import path from "node:path";

type ProcessOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string>;
  onStdout?: (text: string) => void;
  onAbort?: () => Promise<unknown> | void;
  abortGraceMs?: number;
  /** Only the Python owned-job supervisor may enable this. */
  supervisor?: boolean;
};

/** Bounded logs and lifetime. The supervisor's Windows job owns descendants;
 * on POSIX its isolated process group provides the corresponding boundary. */
export async function runOwned(args: string[], cwd: string, options: ProcessOptions = {}) {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("A finite positive subprocess timeout is required");
  const child = Bun.spawn(args, { cwd, env: { ...process.env, ...options.env }, stdout: "pipe", stderr: "pipe", windowsHide: true,
    detached: options.supervisor && process.platform !== "win32" });
  let failure: unknown, exited = false, stopTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    if (exited) return;
    try {
      if (options.supervisor && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill(); // Actual owned handle; closing supervisor kills its Windows job.
    } catch { /* The captured child may have exited concurrently. */ }
  };
  const stop = (reason: unknown) => {
    if (exited || failure !== undefined) return;
    failure = reason;
    try { Promise.resolve(options.onAbort?.()).catch(() => terminate()); } catch { terminate(); }
    if (options.abortGraceMs) stopTimer = setTimeout(terminate, options.abortGraceMs);
    else terminate();
  };
  const aborted = () => stop(options.signal?.reason ?? new DOMException("Media render cancelled", "AbortError"));
  options.signal?.addEventListener("abort", aborted, { once: true });
  if (options.signal?.aborted) aborted();
  const deadline = setTimeout(() => stop(new DOMException(`${path.basename(args[0]!)} timed out after ${timeoutMs}ms`, "TimeoutError")), timeoutMs);
  const readers: { cancel(reason?: unknown): Promise<void> }[] = [];
  const capture = async (stream: ReadableStream<Uint8Array>, onChunk?: (text: string) => void) => {
    const reader = stream.getReader(); readers.push(reader);
    const decoder = new TextDecoder(); let tail = "";
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        const text = decoder.decode(value, { stream: true }); tail = (tail + text).slice(-65_536);
        try { onChunk?.(text); } catch { /* Progress callbacks do not change process ownership. */ }
      }
      return (tail + decoder.decode()).slice(-65_536);
    } finally { reader.releaseLock(); }
  };
  const stdout = capture(child.stdout, options.onStdout), stderr = capture(child.stderr);
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await child.exited; exited = true;
    // A misbehaving descendant must not keep inherited pipe handles open forever.
    drainTimer = setTimeout(() => { for (const reader of readers) void reader.cancel().catch(() => {}); }, 1000);
    const [out, err] = await Promise.all([stdout, stderr]);
    if (failure !== undefined) throw failure;
    options.signal?.throwIfAborted();
    if (code !== 0) throw new Error(`${path.basename(args[0]!)} exited ${code}: ${(err || out).slice(-5000)}`);
    return { stdout: out, stderr: err };
  } finally {
    clearTimeout(deadline); if (stopTimer) clearTimeout(stopTimer); if (drainTimer) clearTimeout(drainTimer);
    options.signal?.removeEventListener("abort", aborted);
    if (!exited) terminate();
  }
}
