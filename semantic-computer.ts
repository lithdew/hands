/** Adapted from the supplied pi-cua.ts: compact observations, live references,
 * post-action verification and bounded diffs. Platform input stays in win/.
 * The Pi action gate wraps act/browser mutations before this code runs.
 */
import { z } from "zod";
import type { ImageContent } from "@earendil-works/pi-ai";

const projection = { query: z.string().max(200).describe("Narrow controls/text by a phrase or space-separated alternatives (for example: recipient subject body send).").optional(), screenshot: z.boolean().optional() };
export const LookSchema = z.object({ what: z.enum(["windows", "window", "screen"]), ...projection });
export const ActSchema = z.object({
  action: z.enum(["click", "type", "set_value", "key", "scroll"]),
  ref: z.string().max(100).optional(), text: z.string().max(8000).optional(), key: z.string().max(80).optional(),
  replace: z.boolean().optional(), direction: z.enum(["up", "down"]).optional(), amount: z.int().min(1).max(30).optional(),
  description: z.string().max(1000).optional(), ...projection,
});
export const BrowserSchema = ActSchema.extend({ action: z.enum(["attach", "tabs", "snapshot", "navigate", "click", "type", "key", "scroll"]), url: z.url().optional(),
  mode: z.enum(["existing", "private"]).optional(), window_id: z.int().positive().optional(), pid: z.int().positive().optional() });
export type SemanticAction = z.infer<typeof ActSchema> | z.infer<typeof BrowserSchema>;
export type Element = { key: string; role: string; name: string; value?: string; within?: string; editable?: boolean; address: Record<string, unknown> };
export type PixelCapture = { window: { pid: number; containerId: number; title: string; ownerNonce?: string } | null; width: number; height: number; digest: string };
export type Snapshot = { identity: string; kind: "native" | "browser"; title: string; url?: string; elements: Element[]; texts: string[]; image?: ImageContent; capture?: PixelCapture; binding: Record<string, unknown> };
export type SemanticResult = { content: ({ type: "text"; text: string } | ImageContent)[]; details: Record<string, unknown> };
export type SemanticBackend = {
  windows(): Promise<unknown>;
  observe(options: { screenshot?: boolean; signal?: AbortSignal }): Promise<Snapshot>;
  act(snapshot: Snapshot, action: SemanticAction, element: Element | undefined, signal?: AbortSignal): Promise<void>;
  attach?(target: { mode: "existing" | "private"; window_id?: number; pid?: number }, signal?: AbortSignal): Promise<void>;
};

const clean = (s: string, n = 140) => s.replace(/\s+/g, " ").trim().slice(0, n);
const label = (e: Element) => {
  const limit = e.editable ? 1000 : 140;
  return `${e.role} ${JSON.stringify(clean(e.name))}${e.within ? ` in ${JSON.stringify(clean(e.within))}` : ""}${e.value ? ` =${JSON.stringify(clean(e.value, limit))}${e.value.length >= limit ? " [value may be truncated; do not assume the unseen remainder]" : ""}` : ""}`;
};
function matchesQuery(text: string, query?: string) {
  if (!query?.trim()) return true;
  const haystack = text.toLowerCase(), phrase = query.trim().toLowerCase();
  return haystack.includes(phrase) || phrase.split(/[\s,|]+/u).filter(Boolean).some((part) => haystack.includes(part));
}
function boundedLines(lines: string[], maxBytes: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    used += Buffer.byteLength(line) + 1;
    if (used > maxBytes - 80) { kept.push("More text omitted; use query to narrow the observation."); break; }
    kept.push(line);
  }
  return kept;
}

/** Count duplicates, so removing one of two identically named controls is visible. */
export function diffLines(before: string[], after: string[]) {
  const counts = (lines: string[]) => { const map = new Map<string, number>(); for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1); return map; };
  const old = counts(before), next = counts(after);
  const subtract = (a: Map<string, number>, b: Map<string, number>) => [...a].flatMap(([s, n]) => Array(Math.max(0, n - (b.get(s) ?? 0))).fill(s) as string[]);
  return { added: subtract(next, old), removed: subtract(old, next) };
}

export function createSemanticComputer(backend: SemanticBackend, beforeInput: () => void = () => {}) {
  let generation = 0, current: Snapshot | undefined;
  let references = new Map<string, Element>();
  const reply = (text: string, details: Record<string, unknown> = {}, image?: ImageContent): SemanticResult => ({ content: [{ type: "text", text }, ...(image ? [image] : [])], details });

  async function look(options: { query?: string; screenshot?: boolean; signal?: AbortSignal }, afterAction = false): Promise<SemanticResult> {
    const started = performance.now(), previous = current;
    // Any failed refresh invalidates the old references too.
    current = undefined; references.clear();
    const snapshot = await backend.observe(options);
    options.signal?.throwIfAborted();
    current = snapshot; generation++;
    const query = options.query;
    const selected = snapshot.elements.filter((e) => matchesQuery(label(e), query));
    const lines: string[] = [], maxBytes = 13_000;
    let used = 0;
    for (const [index, element] of selected.entries()) {
      const ref = `p${generation}:${index}`, line = `[${ref}] ${label(element)}`;
      used += Buffer.byteLength(line) + 1;
      if (used > maxBytes) { lines.push("More controls omitted; use query to narrow the observation."); break; }
      references.set(ref, element); lines.push(line);
    }
    const text = boundedLines(snapshot.texts.map((t) => clean(t, 500)).filter((t) => matchesQuery(t, query)).slice(0, 40), 6000);
    let changes = "";
    if (afterAction && previous?.identity === snapshot.identity) {
      const diff = diffLines([...previous.elements.map(label), ...previous.texts], [...snapshot.elements.map(label), ...snapshot.texts]);
      changes = diff.added.length || diff.removed.length
        ? `State changed: +${diff.added.length}, -${diff.removed.length}.\n${boundedLines(diff.added.slice(0, 12).map((s) => `+ ${clean(s, 240)}`), 2500).join("\n")}\n`
        : "No semantic change observed; this does not prove the action worked.\n";
    }
    const header = `${snapshot.kind} window: ${clean(snapshot.title, 200)}${snapshot.url ? `\nURL: ${clean(snapshot.url, 400)}` : ""}`;
    return reply(`${header}\n${changes}Current references (replace all previous references):\n${lines.join("\n")}\nVisible text:\n${text.join("\n")}${!references.size ? snapshot.image ? "\nNo labelled controls. Inspect the attached screenshot for visual input." : "\nNo labelled controls. Request screenshot=true or use computer screenshot for visual input." : ""}`, { observationMs: Math.round(performance.now() - started), refs: references.size, kind: snapshot.kind, ...(snapshot.image && snapshot.capture ? { puk_snapshot: snapshot.capture } : {}) }, snapshot.image);
  }

  function resolved(action: SemanticAction) {
    if (!current) throw new Error("Look at this window before acting.");
    const element = action.ref ? references.get(action.ref) : undefined;
    if (action.ref && !element) throw new Error("That reference is stale or was not shown. Take a fresh observation.");
    if (["click", "type", "set_value"].includes(action.action) && !element) throw new Error(`${action.action} needs a current ref.`);
    if (["type", "set_value"].includes(action.action) && action.text === undefined) throw new Error(`${action.action} needs text.`);
    if (["type", "set_value"].includes(action.action) && !element?.editable) throw new Error("The selected control is not editable.");
    if (action.action === "key" && !action.key?.trim()) throw new Error("key needs a key or chord.");
    if (action.action === "navigate" && (!action.url || !/^https?:\/\//i.test(action.url))) throw new Error("navigate needs an http(s) URL.");
    return { snapshot: current, element };
  }

  async function act(action: SemanticAction, signal?: AbortSignal, browserOnly = false) {
    const { snapshot, element } = resolved(action);
    if (browserOnly && snapshot.kind !== "browser") throw new Error("This is a native window. Use computer_act.");
    const started = performance.now();
    try {
      beforeInput(); signal?.throwIfAborted();
      await backend.act(snapshot, action, element, signal);
      beforeInput(); signal?.throwIfAborted();
    } catch (error) { current = undefined; references.clear(); throw error; }
    const actionMs = Math.round(performance.now() - started);
    const result = await look({ query: action.query, screenshot: action.screenshot, signal }, true);
    result.details.actionMs = actionMs;
    return result;
  }

  return {
    reset() { current = undefined; references.clear(); },
    describe(tool: string, args: unknown) {
      if (tool !== "computer_act" && tool !== "computer_browser") return undefined;
      const action = (tool === "computer_act" ? ActSchema : BrowserSchema).parse(args);
      if (["tabs", "snapshot"].includes(action.action)) return undefined;
      if (action.action === "attach" && "mode" in action) return { browserMode: action.mode, window_id: action.window_id, pid: action.pid };
      const { snapshot, element } = resolved(action);
      return { window: snapshot.title, url: snapshot.url, ...(element ? { control: label(element) } : {}) };
    },
    async look(params: z.infer<typeof LookSchema>, signal?: AbortSignal) {
      if (params.what === "windows") {
        current = undefined; references.clear();
        signal?.throwIfAborted();
        return reply(JSON.stringify(await backend.windows()));
      }
      return look({ ...params, screenshot: params.what === "screen" || params.screenshot, signal });
    },
    act: (params: z.infer<typeof ActSchema>, signal?: AbortSignal) => act(params, signal),
    async browser(params: z.infer<typeof BrowserSchema>, signal?: AbortSignal) {
      if (params.action === "attach") {
        current = undefined; references.clear();
        if (!backend.attach) throw new Error("Connecting an existing browser is unavailable on this desktop.");
        if (!params.mode) throw new Error("attach requires mode: existing or private.");
        beforeInput(); signal?.throwIfAborted();
        await backend.attach({ mode: params.mode, window_id: params.window_id, pid: params.pid }, signal);
        beforeInput(); signal?.throwIfAborted();
        return look({ ...params, signal });
      }
      if (["tabs", "snapshot"].includes(params.action)) {
        const result = await look({ ...params, signal });
        if (current?.kind !== "browser") throw new Error("The hand's active window is not its browser. Open the browser first.");
        return result; // This adapter exposes the hand's current page; no arbitrary tab fallback.
      }
      return act(params, signal, true);
    },
  };
}
export type SemanticComputer = ReturnType<typeof createSemanticComputer>;
