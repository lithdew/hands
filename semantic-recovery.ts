import { createHash } from "node:crypto";

type Args = { action?: unknown; what?: unknown; mode?: unknown; pid?: unknown; window_id?: unknown };
export type SemanticRecoveryTarget = { key?: string; existing: boolean; pid?: number; windowId?: number };
export type SemanticFailure = { key: string; failureClass: "semantic-observation" | "semantic-unobserved"; diagnostic: string };

export function usesSemanticObservation(tool: string, args: unknown) {
  const action = args as Args | undefined;
  return tool === "computer_act" || tool === "computer_browser" || tool === "computer_look" && action?.what !== "windows";
}

/** Only known adapter contract failures count. Timeouts, refusals, stale refs,
 * changing pages and ordinary command errors retain their normal recovery. */
export function semanticFailure(tool: string, args: unknown, message: string): SemanticFailure | undefined {
  if (!usesSemanticObservation(tool, args)) return;
  const missing = message === "Look at this window before acting.";
  const diagnostic = missing ? "No current semantic observation is available."
    : message.startsWith("The visible Chrome tab changed while observing it. Take a fresh snapshot.") ? "Chrome snapshot binding verification failed."
    : message.startsWith("Cua get_browser_state did not return a verified browser result.") ? "Cua returned an invalid browser observation."
    : message === "Cua could not bind this exact Chrome window for input. No other browser was selected." ? "Cua could not verify the selected Chrome binding."
    : message === "Cua returned no structured window state." ? "Cua returned no structured window observation."
    : /session (?:has ended|'[^']*' has ended)/i.test(message) ? "The Cua browser session ended; explicitly attach to refresh its binding."
    : undefined;
  if (!diagnostic) return;
  // Keep private titles/URLs in error metadata out of recovery state and traces.
  // Different metadata is a different failure, even within the same category.
  return { key: createHash("sha256").update(message).digest("hex"), failureClass: missing ? "semantic-unobserved" : "semantic-observation", diagnostic };
}

/** Verified platform identity, never requested arguments or changing page text. */
export function semanticRecoveryTarget(state: unknown): SemanticRecoveryTarget | undefined {
  if (!state || typeof state !== "object") return;
  const value = state as { browser?: { mode?: string; pid?: number; window_id?: number; ownerNonce?: string }; windows?: { focused?: boolean; pid?: number; containerId?: number; ownerNonce?: string }[] };
  const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
  if (value.browser?.mode === "existing") {
    const { pid, window_id, ownerNonce } = value.browser;
    const verified = positive(pid) && positive(window_id) && typeof ownerNonce === "string" && /^[a-f0-9]{16}$/.test(ownerNonce);
    return { existing: true, ...(verified ? { key: `existing:${pid}:${window_id}:${ownerNonce}`, pid, windowId: window_id } : {}) };
  }
  const focused = Array.isArray(value.windows) ? value.windows.filter((window) => window.focused) : [];
  const window = focused.length === 1 ? focused[0] : undefined;
  return { existing: false, ...(window && positive(window.pid) && positive(window.containerId)
    ? { key: `desktop:${window.pid}:${window.containerId}:${window.ownerNonce ?? ""}`, pid: window.pid, windowId: window.containerId }
    : {}) };
}

/** Per-agent budget survives new prompts/refinements. Only verified target
 * changes or successful semantic observations restore a failed capability. */
export function createSemanticRecovery() {
  let target: SemanticRecoveryTarget | undefined;
  const failures = new Map<string, number>();
  let blocked: SemanticFailure | undefined;
  const clear = () => { failures.clear(); blocked = undefined; };
  const reason = () => `${blocked?.diagnostic ?? "Semantic observation failed."} Stopped after two identical failures for this target. ${target?.existing
    ? "The attached Chrome window requires valid semantic references; pixel input cannot operate that connection. Select a different browser target or restart the hand after repairing the connection."
    : "Use computer screenshot and pixel input for this native/private target, or select a different window. Do not retry equivalent semantic tools on the same target."} Earlier input may already have completed; inspect its result before repeating it.`;
  return {
    get pending() { return failures.size > 0; },
    get blocked() { return Boolean(blocked); },
    get existing() { return target?.existing === true; },
    sync(next: SemanticRecoveryTarget | undefined) {
      if (!next) return;
      if (next.key && target?.key && next.key !== target.key) clear();
      // A temporary absence of identity is not proof that the target changed.
      target = next.key ? next : { ...target, ...next, key: target?.key };
    },
    observed() { clear(); },
    failed(failure: SemanticFailure) {
      const attempt = Math.min(2, (failures.get(failure.key) ?? 0) + 1);
      if (failures.size >= 16 && !failures.has(failure.key)) failures.delete(failures.keys().next().value!);
      failures.set(failure.key, attempt);
      if (attempt === 2) blocked = failure;
      return { attempt, blocked: Boolean(blocked), reason: reason() };
    },
    canChangeTarget(tool: string, args: unknown) {
      const action = args as Args | undefined;
      if (tool !== "computer_browser" || action?.action !== "attach") return false;
      if (action.mode === "private") return target?.existing === true;
      if (action.mode !== "existing") return false;
      if (target && !target.existing) return true;
      return typeof action.pid === "number" && typeof action.window_id === "number"
        && (action.pid !== target?.pid || action.window_id !== target?.windowId);
    },
    reason,
  };
}
