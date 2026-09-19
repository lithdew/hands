import { expect, test } from "bun:test";
import { createSemanticRecovery, semanticFailure, semanticRecoveryTarget, usesSemanticObservation } from "./semantic-recovery";

const mismatch = 'The visible Chrome tab changed while observing it. Take a fresh snapshot. Browser snapshot metadata: {"page_title":"PRIVATE_TITLE","urls_match":false}';
const browser = { mode: "existing", pid: 101, window_id: 202, ownerNonce: "0123456789abcdef" };
const failure = () => semanticFailure("computer_browser", { action: "snapshot" }, mismatch)!;

test("identical structural failures share a budget across observation aliases without storing private text", () => {
  const guard = createSemanticRecovery();
  guard.sync(semanticRecoveryTarget({ browser }));
  expect(guard.failed(failure())).toMatchObject({ attempt: 1, blocked: false });
  const alias = semanticFailure("computer_look", { what: "screen", query: "different projection" }, mismatch)!;
  expect(guard.failed(alias)).toMatchObject({ attempt: 2, blocked: true });
  expect(guard.existing).toBe(true);
  expect(guard.reason()).toContain("pixel input cannot operate");
  expect(JSON.stringify([failure(), alias, guard.failed(alias)])).not.toContain("PRIVATE_TITLE");
});

test("different binding failure metadata does not count as an identical failure", () => {
  const guard = createSemanticRecovery();
  guard.failed(failure());
  const different = semanticFailure("computer_browser", { action: "tabs" }, mismatch.replace('"urls_match":false', '"urls_match":true'))!;
  expect(guard.failed(different)).toMatchObject({ attempt: 1, blocked: false });
  expect(guard.failed(failure()).blocked).toBe(true);
});

test("titles, geometry, availability and temporary missing identities cannot reset a failed target", () => {
  const guard = createSemanticRecovery();
  guard.sync(semanticRecoveryTarget({ browser }));
  guard.failed(failure());
  guard.sync(semanticRecoveryTarget({ browser: { ...browser, title: "new title", ready: false }, width: 400, height: 300 }));
  guard.sync(semanticRecoveryTarget({ browser: { mode: "existing" } }));
  expect(guard.failed(failure()).blocked).toBe(true);
  expect(guard.canChangeTarget("computer_browser", { action: "attach", ...browser })).toBe(false);
  guard.sync(undefined);
  expect(guard.blocked).toBe(true);

  const native = createSemanticRecovery();
  native.sync(semanticRecoveryTarget({ browser: { mode: "private" }, windows: [{ focused: true, pid: 10, containerId: 20 }] }));
  native.failed(failure());
  native.sync(semanticRecoveryTarget({ browser: { mode: "private" }, windows: [] }));
  expect(native.failed(failure()).blocked).toBe(true);
});

test("a verified window, owner or mode change and a valid semantic observation restore the budget", () => {
  for (const next of [
    { browser: { ...browser, pid: 102 } },
    { browser: { ...browser, window_id: 203 } },
    { browser: { ...browser, ownerNonce: "fedcba9876543210" } },
    { browser: { mode: "private" }, windows: [{ focused: true, pid: 101, containerId: 202, ownerNonce: browser.ownerNonce }] },
  ]) {
    const guard = createSemanticRecovery();
    guard.sync(semanticRecoveryTarget({ browser })); guard.failed(failure()); guard.failed(failure());
    guard.sync(semanticRecoveryTarget(next));
    expect(guard.pending).toBe(false); expect(guard.blocked).toBe(false);
    expect(guard.failed(failure()).attempt).toBe(1);
    guard.observed();
    expect(guard.failed(failure())).toMatchObject({ attempt: 1, blocked: false });
  }
});

test("requesting another attachment does not itself restore the failed capability", () => {
  const guard = createSemanticRecovery();
  guard.sync(semanticRecoveryTarget({ browser })); guard.failed(failure()); guard.failed(failure());
  for (const args of [{ action: "attach", mode: "existing" }, { action: "attach", ...browser }]) {
    expect(guard.canChangeTarget("computer_browser", args)).toBe(false);
  }
  expect(guard.canChangeTarget("computer_browser", { action: "attach", mode: "existing", pid: 103, window_id: 204 })).toBe(true);
  expect(guard.canChangeTarget("computer_browser", { action: "attach", mode: "private" })).toBe(true);
  expect(guard.blocked).toBe(true);
});

test("window inventory, pixel input, ordinary errors, stale references and refusals are outside the structural budget", () => {
  for (const [name, args] of [["computer_look", { what: "windows" }], ["computer", { action: "screenshot" }], ["computer", { action: "click" }], ["bash", {}]] as const) {
    expect(usesSemanticObservation(name, args)).toBe(false);
    expect(semanticFailure(name, args, mismatch)).toBeUndefined();
  }
  for (const error of ["Request timed out", "Cua get_browser_state refused: permission denied", "Operation aborted", "That reference is stale or was not shown. Take a fresh observation.", "The page changed since observation. Take a fresh snapshot and use its references.", "This hand has no window. Use open_app first.", "click needs a current ref."]) {
    expect(semanticFailure("computer_browser", { action: "snapshot" }, error)).toBeUndefined();
  }
  expect(semanticFailure("computer_act", { action: "key" }, "Look at this window before acting.")?.failureClass).toBe("semantic-unobserved");
});
