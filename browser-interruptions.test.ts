import { describe, expect, test } from "bun:test";
import { BROWSER_INTERRUPTION_POLICY, classifyBrowserInterruption, createBrowserInterruptionTracker, type BrowserInterruptionInput } from "./browser-interruptions";

const observed = (extra: Partial<BrowserInterruptionInput> = {}): BrowserInterruptionInput => ({ taskId: "task-revision-4", targetKey: "hand1:pid20:hwnd30:nonce40", observationId: "snapshot-1", ...extra });
const checkbox = { role: "checkbox", name: "I'm not a robot", visible: true };

describe("grounded browser interruptions", () => {
  test("research mentions, hidden widgets and passive CAPTCHA badges do not block a task", () => {
    for (const input of [
      observed({ pageTitle: "CAPTCHA and login research", visibleText: ["This paper studies CAPTCHA, popup blocked errors, and login forms."] }),
      observed({ controls: [{ ...checkbox, visible: false }] }),
      observed({ controls: [{ role: "iframe", name: "reCAPTCHA", visible: true }] }),
      observed({ controls: [{ role: "link", name: "Sign in", visible: true }] }),
      observed({ controls: [{ role: "dialog", name: "New message", visible: true }, { role: "button", name: "Send", visible: true }] }),
      observed({ visibleText: ["Verify you are human. Select all images with bicycles."] }),
    ]) expect(classifyBrowserInterruption(input).kind).toBe("none");
  });

  test("visible grounded CAPTCHA receives an ordinary UI attempt, never an automatic bypass", () => {
    const check = classifyBrowserInterruption(observed({ controls: [checkbox] }));
    expect(check.kind).toBe("captcha"); expect(check.action).toBe("attempt_challenge"); expect(check.challengeAttemptsRemaining).toBe(2);
    expect(check.guidance).toContain("normal exact-action gate");
    expect(check.guidance).toContain("Do not use external solver services");
    const grid = classifyBrowserInterruption(observed({ visibleText: ["Select all images containing buses"], controls: [
      { role: "dialog", name: "reCAPTCHA challenge", visible: true, within: "verification" },
      { role: "button", name: "Verify", visible: true, within: "verification" },
    ] }));
    expect(grid.kind).toBe("captcha");
    expect(classifyBrowserInterruption(observed({ challenge: { visible: true, blocking: true, type: "captcha", evidence: "Visible image grid asks for all tiles containing bicycles." } })).action).toBe("attempt_challenge");
    expect(BROWSER_INTERRUPTION_POLICY).toContain("Astra low");
  });

  test("driver dialogs require fresh IDs and effect review, without blind acceptance", () => {
    const dialog = classifyBrowserInterruption(observed({ dialog: { present: true, dialog_id: "dialog-5", kind: "confirm", message: "Delete everything?" } }));
    expect(dialog.action).toBe("review_dialog"); expect(dialog.dialogId).toBe("dialog-5");
    expect(dialog.guidance).toContain("Never automatically accept");
    expect(classifyBrowserInterruption(observed({ dialog: { present: true, kind: "alert" } })).action).toBe("inspect_dialog");
    expect(classifyBrowserInterruption(observed({ lastToolError: "Observation blocked by page-owned JavaScript dialog" })).action).toBe("inspect_dialog");
  });

  test("authentication and browser verification restrictions remain user steps", () => {
    const login = observed({ pageTitle: "Sign in — Example", controls: [{ role: "textbox", name: "Password", type: "password", visible: true }, { role: "button", name: "Sign in", visible: true }] });
    expect(classifyBrowserInterruption(login).kind).toBe("login");
    expect(classifyBrowserInterruption(login).action).toBe("user_takeover");
    const mfa = observed({ pageTitle: "Verify your identity", controls: [{ role: "textbox", name: "Verification code", visible: true }] });
    expect(classifyBrowserInterruption(mfa).kind).toBe("mfa"); expect(classifyBrowserInterruption(mfa).action).toBe("user_takeover");
    const blocked = classifyBrowserInterruption(observed({ lastToolError: "Computer Use could not verify whether the current browser URL is allowed." }));
    expect(blocked.kind).toBe("verification_blocked"); expect(blocked.action).toBe("user_takeover");
    expect(blocked.guidance).toContain("Do not switch tools");
  });

  test("popup recovery preserves confirmed or uncertain sends and exact checkpoints", () => {
    const input = observed({ browserNotice: { kind: "popup_blocked", visible: true }, lastAction: { consequential: true, outcome: "confirmed" } });
    const decision = classifyBrowserInterruption(input);
    expect(decision.action).toBe("same_tab_recovery"); expect(decision.replayConsequentialAction).toBe(false);
    expect(decision.guidance).toContain("already confirmed; never replay");
    expect(decision.checkpoint).toEqual({ taskId: input.taskId, targetKey: input.targetKey, observationId: input.observationId });
    const uncertain = classifyBrowserInterruption(observed({ lastAction: { consequential: true, outcome: "uncertain" } }));
    expect(uncertain.action).toBe("verify_outcome"); expect(uncertain.guidance).toContain("Never resend");
    expect(classifyBrowserInterruption(observed({ lastToolError: "Browser snapshot timed out" })).kind).toBe("observation_failed");
    expect(classifyBrowserInterruption(observed({ controls: [{ role: "status", name: "Pop-up blocked", visible: true }] })).kind).toBe("popup_blocked");
  });
});

describe("bounded interruption recovery", () => {
  test("two meaningful submitted challenge attempts exhaust the exact task/target budget", () => {
    const tracker = createBrowserInterruptionTracker();
    const first = observed({ controls: [checkbox] });
    expect(tracker.inspect(first).action).toBe("attempt_challenge");
    const submission = { taskId: first.taskId, targetKey: first.targetKey, observationId: first.observationId, kind: "challenge_submit" as const };
    expect(tracker.recordAttempt(submission).recorded).toBe(true);
    expect(tracker.recordAttempt(submission).recorded).toBe(false);
    expect(tracker.inspect(first).action).toBe("inspect_once");
    expect(tracker.recordAttempt(submission).recorded).toBe(false);
    const second = { ...first, observationId: "snapshot-2" };
    expect(tracker.inspect(second).challengeAttemptsRemaining).toBe(1);
    expect(tracker.recordAttempt({ ...submission, observationId: second.observationId }).recorded).toBe(true);
    const third = tracker.inspect({ ...first, observationId: "snapshot-3" });
    expect(third.action).toBe("user_takeover"); expect(third.challengeAttemptsRemaining).toBe(0);
    tracker.resumeAfterUser(first.taskId, first.targetKey);
    expect(tracker.inspect({ ...first, observationId: "snapshot-4" }).action).toBe("user_takeover");
    expect(tracker.inspect({ ...first, observationId: "snapshot-5", controls: [] }).action).toBe("continue");
    expect(tracker.inspect({ ...first, taskId: "corrected-task", observationId: "snapshot-6" }).challengeAttemptsRemaining).toBe(2);
  });

  test("new reads cannot become an unbounded passive polling loop", () => {
    const tracker = createBrowserInterruptionTracker(), first = observed({ controls: [checkbox] });
    expect(tracker.inspect(first).action).toBe("attempt_challenge");
    expect(tracker.inspect(first).action).toBe("attempt_challenge"); // Status reuse is not a new read.
    expect(tracker.inspect({ ...first, observationId: "snapshot-2" }).action).toBe("attempt_challenge");
    expect(tracker.inspect({ ...first, observationId: "snapshot-3" }).action).toBe("user_takeover");
  });

  test("recovery dispatch requires matching target and cannot repeat after an unchanged result", () => {
    const tracker = createBrowserInterruptionTracker(), input = observed({ browserNotice: { kind: "popup_blocked", visible: true } });
    tracker.inspect(input);
    const attempt = { taskId: input.taskId, targetKey: input.targetKey, observationId: input.observationId, kind: "recovery" as const };
    expect(tracker.recordAttempt({ ...attempt, targetKey: "other-window" }).recorded).toBe(false);
    expect(tracker.recordAttempt({ ...attempt, observationId: "old" }).recorded).toBe(false);
    expect(tracker.recordAttempt(attempt).recorded).toBe(true);
    expect(tracker.inspect({ ...input, observationId: "snapshot-2" }).action).toBe("user_takeover");
    const other = tracker.inspect({ ...input, targetKey: "other-verified-window", observationId: "snapshot-3" });
    expect(other.action).toBe("same_tab_recovery");
  });
});
