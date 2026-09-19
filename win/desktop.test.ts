import { describe, expect, test } from "bun:test";
import { adoptable, bindWindowCapture, captureExistingWindow, capturedImage, createDriverPool, createExistingBrowserTargets, createWindowTracker, frontWindow, handFor, helperReply, isPrivateBrowser, launchedBrowserWindow, selectedExistingWindow, signInLine, type BrowserActivity, type RawWindow, type WindowOwner } from "./desktop";
import { serverResources, virtualKey } from "./serve";
import type { CuaConnection, Hand } from "../desktop";

test("Explorer RPC recovery re-observes once without replaying window mutations", async () => {
  const failure = "error The RPC server is unavailable. (Exception from HRESULT: 0x800706BA)";
  const sent: string[] = [];
  expect(await helperReply("external-read Puk hand 1|7:20:0000000000000001", async request => {
    sent.push(request); return sent.length === 1 ? failure : request === "desktop-reconnect" ? "ok" : '{"pid":20}';
  })).toBe('{"pid":20}');
  expect(sent).toHaveLength(3); expect(sent[1]).toBe("desktop-reconnect"); expect(sent[2]).toBe(sent[0]);
  for (const request of ["move 7 Puk hand 1", "external-focus Puk hand 1|7:20:0000000000000001", "ensure Puk hand 1"]) {
    let count = 0;
    await expect(helperReply(request, async () => { count++; return failure; })).rejects.toThrow("RPC server");
    expect(count).toBe(1);
  }
  let count = 0;
  await expect(helperReply("desktops", async request => {count++;return request === "desktop-reconnect" ? "ok" : failure;})).rejects.toThrow("RPC server");
  expect(count).toBe(3);
});

describe("frontWindow", () => {
  const had = (...ids: number[]) => new Set(ids);

  test("stays on the window the hand is working in, whatever the stacking says", () => {
    // Switching desktops put Paint (7) above Chrome (3); the hand was in Chrome.
    expect(frontWindow([7, 3], had(3, 7), 3)).toBe(3);
  });
  test("a window the hand did not have a moment ago takes over: a dialog, a new page", () => {
    expect(frontWindow([9, 3, 7], had(3, 7), 3)).toBe(9);
  });
  test("the first window of an empty hand is not mistaken for a dialog over another", () => {
    expect(frontWindow([3], had(), undefined)).toBe(3);
  });
  test("a temporarily omitted active owner does not give focus to another app", () => {
    expect(frontWindow([7], had(3, 7), 3)).toBe(3);
    expect(frontWindow([], had(3), 3)).toBe(3);
  });
  test("can select another window after the helper confirms the active owner retired", () => {
    expect(frontWindow([7], had(7), 3)).toBe(7);
    expect(frontWindow([], had(), 3)).toBeUndefined();
  });
});

describe("window ownership", () => {
  const hand: Hand = { id: 1, pid: 1, display: "test", width: 800, height: 600 };
  const window = (id: number): RawWindow => ({ app: id === 7 ? "mspaint" : "chrome", title: `Window ${id}`, pid: id * 10,
    containerId: id, ownerNonce: id.toString(16).padStart(16, "0"), focused: false, rect: [40, 40, 1360, 900] });
  const reply = (windows: RawWindow[], retired_window_ids: number[] = []) => ({ windows, retired_window_ids });
  const focused = (windows: RawWindow[]) => windows.find((w) => w.focused)?.containerId;
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  };

  test("omission retains exact ownership and keeps Paint selected when it returns", async () => {
    let found = [window(7), window(3)];
    const requests: Map<number, WindowOwner>[] = [];
    const tracker = createWindowTracker(async (_hand, owners) => { requests.push(new Map(owners)); return reply(found); });
    expect(focused(await tracker.read(hand))).toBe(7);
    found = [window(3)];
    expect(focused(await tracker.read(hand))).toBeUndefined();
    expect(focused(await tracker.read(hand))).toBeUndefined();
    expect(requests[2]?.get(7)).toEqual({ pid: 70, nonce: "0000000000000007" });
    found = [window(3), window(7)];
    expect(focused(await tracker.read(hand))).toBe(7);
  });

  test("only confirmed retirement removes an owner and allows selecting another known app", async () => {
    let response = reply([window(7), window(3)]);
    const requests: Map<number, WindowOwner>[] = [];
    const tracker = createWindowTracker(async (_hand, owners) => { requests.push(new Map(owners)); return response; });
    await tracker.read(hand);
    response = reply([window(3)], [7]);
    expect(focused(await tracker.read(hand))).toBe(3);
    response = reply([window(3)]);
    await tracker.read(hand);
    expect(requests[2]?.has(7)).toBe(false);
  });

  test("a new dialog may take over while the prior target is temporarily omitted", async () => {
    let found = [window(7), window(3)];
    const tracker = createWindowTracker(async () => reply(found));
    await tracker.read(hand);
    found = [window(3), window(9)];
    expect(focused(await tracker.read(hand))).toBe(9);
  });

  test("concurrent reads serialize enumeration and commit; another hand remains independent", async () => {
    const first = deferred<ReturnType<typeof reply>>(), entered = deferred<void>();
    const requests: { hand: number; owners: Map<number, WindowOwner> }[] = [];
    const tracker = createWindowTracker(async (requested, owners) => {
      requests.push({ hand: requested.id, owners: new Map(owners) });
      if (requests.length === 1) { entered.resolve(); return first.promise; }
      return reply([window(3), window(7)]);
    });
    const a = tracker.read(hand);
    await entered.promise;
    const b = tracker.read(hand);
    await tracker.read({ ...hand, id: 2 });
    expect(requests.map((r) => r.hand)).toEqual([1, 2]);
    first.resolve(reply([window(7), window(3)]));
    expect(focused(await a)).toBe(7);
    expect(focused(await b)).toBe(7);
    expect(requests[2]?.owners.get(7)).toEqual({ pid: 70, nonce: "0000000000000007" });
  });

  test("app selection shares the queue and cannot be overwritten by an earlier read", async () => {
    const pending = deferred<ReturnType<typeof reply>>(), entered = deferred<void>();
    let count = 0;
    const tracker = createWindowTracker(async () => {
      if (++count === 2) { entered.resolve(); return pending.promise; }
      return reply([window(7), window(3)]);
    });
    await tracker.read(hand);
    const reading = tracker.read(hand);
    await entered.promise;
    const selecting = tracker.select(hand, window(3));
    pending.resolve(reply([window(7), window(3)]));
    expect(focused(await reading)).toBe(7);
    expect(focused(await selecting)).toBe(3);
    expect(focused(await tracker.read(hand))).toBe(3);
  });

  test("a changed PID, recycled HWND nonce or absent identity is rejected without poisoning the queue", async () => {
    let found = [window(7), window(3)];
    const tracker = createWindowTracker(async () => reply(found));
    await tracker.read(hand);
    for (const invalid of [{ ...window(7), pid: 71 }, { ...window(7), ownerNonce: "0000000000000008" },
      { ...window(7), ownerNonce: undefined }, { ...window(7), ownerNonce: "0000000000000000" }]) {
      found = [window(3), invalid];
      await expect(tracker.read(hand)).rejects.toThrow("changed or unverified window identity");
    }
    found = [window(3)];
    expect(focused(await tracker.read(hand))).toBeUndefined();
    found = [window(3), window(7)];
    expect(focused(await tracker.read(hand))).toBe(7);
  });

  test("retirement forbids immediate re-adoption, and an older image cannot select a recycled window", async () => {
    let response = reply([window(7), window(3)]);
    const tracker = createWindowTracker(async () => response);
    await tracker.read(hand);
    const reused = { ...window(7), ownerNonce: "0000000000000008" };
    response = reply([reused, window(3)], [7]);
    await expect(tracker.read(hand)).rejects.toThrow("changed or unverified window identity");
    response = reply([window(3)], [7]);
    expect(focused(await tracker.read(hand))).toBe(3);
    response = reply([window(3), reused]);
    expect(focused(await tracker.read(hand))).toBe(7);
    await expect(tracker.select(hand, window(7))).rejects.toThrow("no longer available");
  });
});

describe("virtualKey", () => {
  test("function keys and raw virtual-key numbers", () => {
    expect(virtualKey()).toBe(0x77);
    expect(virtualKey("f9")).toBe(0x78);
    expect(virtualKey("F24")).toBe(0x87);
    expect(virtualKey("19")).toBe(19);
  });
  test("refuses what would poll a key that does not exist", () => {
    expect(() => virtualKey("F25")).toThrow("PUK_HOTKEY");
    expect(() => virtualKey("space")).toThrow("PUK_HOTKEY");
  });
});

describe("capture binding", () => {
  const paint = (): RawWindow => ({ app: "mspaint", title: "Untitled - Paint", focused: true, pid: 82, containerId: 901, ownerNonce: "0000000000000901", rect: [40, 40, 1360, 900] });
  const png = () => {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(1342, 16); bytes.writeUInt32BE(891, 20);
    return bytes.toString("base64");
  };

  test("same-size focus changes never bind old pixels to the new window", async () => {
    let current = paint();
    const before = { ...current };
    let grabbed: RawWindow | null | undefined;
    await expect(bindWindowCapture(async () => current, async (window) => {
      grabbed = window;
      current = { ...paint(), pid: 99, containerId: 902, app: "chrome", title: "Browser" };
      return png();
    })).rejects.toThrow("changed while capturing");
    expect(grabbed).toEqual(before);
  });

  test("PID/HWND reuse, title changes, resizing and closed windows invalidate a capture", async () => {
    const replacements: (RawWindow | null)[] = [
      { ...paint(), pid: 99 }, { ...paint(), ownerNonce: "0000000000000902" }, { ...paint(), title: "Saved - Paint" },
      { ...paint(), rect: [40, 40, 1600, 900] }, null,
    ];
    for (const after of replacements) {
      let current: RawWindow | null = paint();
      await expect(bindWindowCapture(async () => current, async () => { current = after; return png(); })).rejects.toThrow("changed while capturing");
    }
  });

  test("a backend cannot relabel captured pixels by mutating the original object", async () => {
    const current = paint();
    await expect(bindWindowCapture(async () => current, async () => { current.title = "Different document"; current.rect[2] = 1500; return png(); })).rejects.toThrow("changed while capturing");
  });

  test("a window opening while the blank placeholder is captured invalidates it", async () => {
    let current: RawWindow | null = null;
    await expect(bindWindowCapture(async () => current, async () => { current = paint(); return png(); })).rejects.toThrow("changed while capturing");
  });

  test("metadata identifies the image's exact target and actual PNG size", async () => {
    let current = paint();
    const before = paint(), data = png();
    const bound = await bindWindowCapture(async () => current, async (window) => {
      expect(window).toEqual(before);
      current = { ...paint(), rect: [120, 70, 1360, 900] }; // Moving does not change window-local pixels.
      return data;
    });
    const response = capturedImage(bound);
    expect(response.structuredContent).toEqual({ puk_snapshot: { window: before, width: 1342, height: 891, digest: Bun.hash(data).toString(16) } });
    expect(response.content).toEqual([{ type: "image", data, mimeType: "image/png" }]);
    expect(await bindWindowCapture(async () => null, async () => data)).toEqual({ data, window: null });
  });

  test("minimized Chrome falls back only to its healthy direct viewport, retaining native owner and PNG dimensions", async () => {
    const window: RawWindow = { ...paint(), app: "chrome", title: "Fixture - Google Chrome", iconic: true, focused: false, rect: [-32000, -32000, 219, 30] };
    let nativeCalls = 0, previewCalls = 0;
    const preview = async () => { previewCalls++; return { window, image: { type: "image" as const, mimeType: "image/png" as const, data: png() }, width: 1342, height: 891 }; };
    const result = await bindWindowCapture(async () => window, async captured => captureExistingWindow(captured!, async () => { nativeCalls++; throw new Error("blank"); }, () => ({ healthy: () => true, preview })));
    expect({ nativeCalls, previewCalls }).toEqual({ nativeCalls: 1, previewCalls: 1 });
    expect(result.window).toEqual(window);
    expect(result.window?.rect).toEqual([-32000, -32000, 219, 30]);
    expect(result.coordinateSpace).toBe("browser-viewport");
    expect(capturedImage(result).structuredContent).toEqual({ puk_snapshot: { window, width: 1342, height: 891, digest: Bun.hash(png()).toString(16), coordinateSpace: "browser-viewport" } });
    // Native capture success does not invoke the backend or invalidate a task's refs.
    const native = await captureExistingWindow(window, async () => png(), () => { throw new Error("must not request a direct preview"); });
    expect(native).toEqual({ data: png() });
    expect(previewCalls).toBe(1);
  });

  test("missing or unhealthy direct preview stays closed without any alternate transport", async () => {
    const window = { ...paint(), app: "chrome" };
    const grab = async () => { throw new Error("blank"); };
    let calls = 0;
    const preview = async () => { calls++; throw new Error("must not preview"); };
    for (const connection of [null, { healthy: () => false, preview }, { healthy: () => true }])
      await expect(captureExistingWindow(window, grab, () => connection)).rejects.toThrow("preview is unavailable");
    expect(calls).toBe(0);
    await expect(captureExistingWindow(window, grab, () => ({ healthy: () => true, preview: async () => { calls++; throw new Error("direct backend busy"); } }))).rejects.toThrow("direct backend busy");
    expect(calls).toBe(1);
  });

  test("direct preview refuses changed native owner/state and dishonest PNG dimensions", async () => {
    const window = { ...paint(), app: "chrome", iconic: true };
    const grab = async () => { throw new Error("blank"); };
    const valid = { window, image: { type: "image" as const, mimeType: "image/png" as const, data: png() }, width: 1342, height: 891 };
    for (const next of [{ ...window, pid: 99 }, { ...window, containerId: 902 }, { ...window, ownerNonce: "0000000000000002" },
      { ...window, title: "Another tab" }, { ...window, iconic: false }, { ...window, rect: [40, 40, 200, 30] as RawWindow["rect"] }])
      await expect(captureExistingWindow(window, grab, () => ({ healthy: () => true, preview: async () => ({ ...valid, window: next }) }))).rejects.toThrow("window changed");
    for (const dimensions of [{ width: 219 }, { height: 30 }, { width: 0 }, { image: { ...valid.image, data: "bad" } }])
      await expect(captureExistingWindow(window, grab, () => ({ healthy: () => true, preview: async () => ({ ...valid, ...dimensions }) }))).rejects.toThrow("PNG dimensions");
    let healthy = true;
    await expect(captureExistingWindow(window, grab, () => ({ healthy: () => healthy, preview: async () => { healthy = false; return valid; } }))).rejects.toThrow("window changed");
  });

  test("changing selected target during a direct preview cannot publish old viewport pixels", async () => {
    let current = { ...paint(), app: "chrome", iconic: true };
    const expected = current;
    await expect(bindWindowCapture(async () => current, async window => captureExistingWindow(window!, async () => { throw new Error("blank"); }, () => ({ healthy: () => true,
      preview: async () => { current = { ...expected, pid: 99, containerId: 902 }; return { window: expected, image: { type: "image", mimeType: "image/png", data: png() }, width: 1342, height: 891 }; },
    })))).rejects.toThrow("changed while capturing");
  });
});

describe("existing browser target ownership", () => {
  const hand: Hand = { id: 1, pid: 7, display: "Puk hand 1", width: 1280, height: 800 };
  const chrome = (id = 901, pid = 82): RawWindow => ({ app: "chrome", title: "Inbox - Google Chrome", focused: true, pid, containerId: id,
    ownerNonce: id.toString(16).padStart(16, "0"), rect: [40, 40, 1360, 900] });
  function fixture(activity?: () => BrowserActivity, allowMinimizedAfterBind = false) {
    let available = [chrome()], current: RawWindow | null = chrome(), failed = false, preparations = 0, healthy = true;
    let restored: RawWindow | null = chrome(), focusing: Promise<void> | undefined, focusError: Error | undefined;
    const calls: string[] = [];
    const prepared: RawWindow[] = [];
    let validate: (() => Promise<RawWindow>) | undefined;
    let reading: Promise<RawWindow | null> | undefined;
    const targets = createExistingBrowserTargets({
      allowMinimizedAfterBind,
      candidates: async () => available,
      claim: async (hand, window) => { calls.push(`claim ${hand.id} ${window.containerId}`); },
      read: async () => reading ?? current,
      focus: async (hand, window) => { calls.push(`focus ${hand.id} ${window.containerId}`); if (focusing) await focusing; if (focusError) throw focusError; current = restored; },
      release: async (hand) => { calls.push(`release ${hand.id}`); },
      endSession: async () => { calls.push("end disconnected session"); },
      prepare: async (_hand, checked, signal, resume) => { preparations++; if (resume) calls.push("resume only"); validate = checked; signal?.throwIfAborted(); prepared.push(await checked()); if (failed) throw new Error("Cua permission denied"); healthy = true; return { healthy: () => healthy, ...(activity ? { activity } : {}), close: async () => { calls.push("end session"); } }; },
    });
    return { targets, calls, prepared, preparations: () => preparations, validate: () => validate!(), fail: () => { failed = true; }, expire: () => { healthy = false; }, found: (windows: RawWindow[]) => { available = windows; },
      restored: (window: RawWindow | null) => { restored = window; }, focusError: (error: Error) => { focusError = error; }, focusing: (promise: Promise<void>) => { focusing = promise; },
      current: (window: RawWindow | null) => { current = window; }, reading: (promise: Promise<RawWindow | null>) => { reading = promise; } };
  }

  test("native foreground focus stays truthful while a background Chrome remains the selected hand target", async () => {
    const f = fixture(), background = { ...chrome(), focused: false };
    f.found([background]); f.current(background);
    await f.targets.attach(hand);
    const observed = (await f.targets.read(hand))!;
    expect(observed.focused).toBe(false);
    expect(await f.validate()).toEqual(background);
    expect(f.targets.target(hand)).toMatchObject({ ready: true });
    const selected = selectedExistingWindow(observed);
    expect(selected).toMatchObject({ focused: true, foregroundFocused: false, containerId: 901 });
    expect(observed.focused).toBe(false);
    expect(selected.rect).not.toBe(observed.rect);
    expect(f.calls).toEqual(["claim 1 901"]);
  });

  test("explicit attach restores only the selected minimized window before preparing Cua with fresh geometry", async () => {
    const f = fixture(), minimized: RawWindow = { ...chrome(), focused: false, iconic: true, rect: [-32000, -32000, 219, 30] };
    const restored: RawWindow = { ...chrome(), iconic: false, rect: [0, 0, 2560, 1600] };
    f.found([minimized, chrome(902, 99)]); f.current(minimized); f.restored(restored);
    await f.targets.attach(hand, { window_id: 901, pid: 82 });
    expect(f.calls).toEqual(["claim 1 901", "focus 1 901"]);
    expect(f.prepared).toEqual([restored]);
    expect(await f.validate()).toEqual(restored);
    expect(f.targets.target(hand)).toMatchObject({ ready: true, iconic: false, window_id: 901, pid: 82 });
  });

  test("passive reads report minimized readiness without restoring; explicit repeated attach restores without reconnecting", async () => {
    const f = fixture(); await f.targets.attach(hand);
    const connection = f.targets.connection(hand);
    const minimized: RawWindow = { ...chrome(), focused: false, iconic: true, rect: [-32000, -32000, 219, 30] };
    f.current(minimized); f.restored({ ...chrome(), iconic: false });
    expect(await f.targets.read(hand)).toEqual(minimized);
    expect(f.targets.target(hand)).toMatchObject({ ready: false, iconic: true });
    expect(() => f.targets.connection(hand)).toThrow("minimized");
    await expect(f.validate()).rejects.toThrow("minimized");
    expect(f.calls).toEqual(["claim 1 901"]);
    await f.targets.attach(hand, { window_id: 901 });
    expect(f.targets.connection(hand)).toBe(connection);
    expect(f.preparations()).toBe(1);
    expect(f.calls).toEqual(["claim 1 901", "focus 1 901"]);
    expect(f.targets.target(hand)).toMatchObject({ ready: true, iconic: false });
  });

  test("opted-in direct connection remains ready while minimized and repeated attach does not restore or reconnect", async () => {
    const f = fixture(undefined, true); await f.targets.attach(hand);
    const connection = f.targets.connection(hand), minimized: RawWindow = { ...chrome(), focused: false, iconic: true, rect: [-32000, -32000, 219, 30] };
    f.current(minimized);
    expect(await f.targets.read(hand)).toEqual(minimized);
    expect(f.targets.target(hand)).toMatchObject({ ready: true, iconic: true });
    expect(f.targets.connection(hand)).toBe(connection);
    expect(await f.validate()).toEqual(minimized);
    await f.targets.attach(hand, { window_id: 901 });
    expect(f.preparations()).toBe(1);
    expect(f.calls).toEqual(["claim 1 901"]);
    expect(f.targets.target(hand)).toMatchObject({ ready: true, iconic: true });
    f.expire();
    expect(f.targets.target(hand)).toMatchObject({ ready: false, iconic: true });
    expect(() => f.targets.connection(hand)).toThrow();
    await expect(f.validate()).rejects.toThrow("minimized");
  });

  test("direct minimized opt-in cannot skip restoration on initial/expired binding or grant a startup binding", async () => {
    const minimized: RawWindow = { ...chrome(), focused: false, iconic: true, rect: [-32000, -32000, 219, 30] };
    const f = fixture(undefined, true); f.found([minimized]); f.current(minimized); f.restored({ ...chrome(), iconic: false });
    await f.targets.attach(hand);
    expect(f.calls).toEqual(["claim 1 901", "focus 1 901"]);
    f.current(minimized); f.expire();
    await f.targets.attach(hand);
    expect(f.preparations()).toBe(2);
    expect(f.calls).toEqual(["claim 1 901", "focus 1 901", "end session", "release 1", "claim 1 901", "focus 1 901"]);
    const restored = fixture(undefined, true); restored.found([minimized]); restored.current(minimized);
    await expect(restored.targets.restore(hand, chrome())).rejects.toThrow("minimized");
    expect(restored.calls).toEqual(["claim 1 901"]);
    expect(restored.preparations()).toBe(0);
    expect(restored.targets.target(hand)).toMatchObject({ ready: false, iconic: true });
  });

  test("startup restoration of a minimized selection is passive and stays disconnected until explicit attach", async () => {
    const f = fixture(), minimized: RawWindow = { ...chrome(), focused: false, iconic: true, rect: [-32000, -32000, 219, 30] };
    f.found([minimized]); f.current(minimized); f.restored({ ...chrome(), iconic: false });
    await expect(f.targets.restore(hand, chrome())).rejects.toThrow("minimized");
    expect(f.preparations()).toBe(0);
    expect(f.calls).toEqual(["claim 1 901"]);
    expect(f.targets.target(hand)).toMatchObject({ mode: "existing", ready: false, iconic: true });
    await f.targets.attach(hand);
    expect(f.preparations()).toBe(1);
    expect(f.calls).toEqual(["claim 1 901", "release 1", "claim 1 901", "focus 1 901"]);
    expect(f.targets.target(hand)).toMatchObject({ ready: true, iconic: false });
  });

  test("restoration cannot pass changed identities, missing windows, minimized state or invalid geometry into Cua", async () => {
    const minimized: RawWindow = { ...chrome(), iconic: true, rect: [-32000, -32000, 219, 30] };
    for (const result of [null, chrome(902), { ...chrome(), pid: 99 }, { ...chrome(), ownerNonce: "0000000000000099" }, minimized,
      { ...chrome(), iconic: false, rect: [0, 0, 0, 900] as RawWindow["rect"] }]) {
      const f = fixture(); f.found([minimized]); f.current(minimized); f.restored(result);
      await expect(f.targets.attach(hand, { window_id: 901 })).rejects.toThrow();
      expect(f.preparations()).toBe(0);
      expect(f.calls).toEqual(["claim 1 901", "focus 1 901"]);
      expect(f.targets.target(hand)).toMatchObject({ mode: "existing", window_id: 901, ready: false });
    }
  });

  test("failed or cancelled restoration is not replayed and never prepares a browser connection", async () => {
    const minimized: RawWindow = { ...chrome(), iconic: true, rect: [-32000, -32000, 219, 30] };
    const failed = fixture(); failed.found([minimized]); failed.current(minimized); failed.focusError(new Error("native restore refused"));
    await expect(failed.targets.attach(hand)).rejects.toThrow("restore refused");
    expect(failed.calls).toEqual(["claim 1 901", "focus 1 901"]);
    expect(failed.preparations()).toBe(0);
    const f = fixture(), wait = Promise.withResolvers<void>(), controller = new AbortController();
    f.found([minimized]); f.current(minimized); f.focusing(wait.promise);
    const pending = f.targets.attach(hand, {}, controller.signal);
    while (!f.calls.includes("focus 1 901")) await Bun.sleep(0);
    controller.abort(); wait.resolve();
    await expect(pending).rejects.toThrow();
    expect(f.preparations()).toBe(0);
    expect(f.calls).toEqual(["claim 1 901", "focus 1 901"]);
    expect(f.targets.target(hand)).toMatchObject({ ready: false });
  });

  test("a selected user's Chrome is the only observed target and detaching never owns or closes it", async () => {
    const f = fixture();
    await f.targets.attach(hand, { window_id: 901 });
    expect(f.targets.target(hand)).toMatchObject({ mode: "existing", window_id: 901, pid: 82, ready: true });
    expect(await f.targets.read(hand)).toEqual(chrome());
    expect(await f.validate()).toEqual(chrome());
    await f.targets.detach(hand);
    expect(f.targets.target(hand)).toEqual({ mode: "private" });
    expect(f.calls).toEqual(["claim 1 901", "end session", "release 1"]);
    await expect(f.validate()).rejects.toThrow("replaced");
  });

  test("restart restores only the original window through bind-only connection", async () => {
    const f = fixture();
    await f.targets.restore(hand, chrome());
    expect(f.targets.target(hand)).toMatchObject({ mode: "existing", window_id: 901, ready: true });
    expect(f.calls).toEqual(["claim 1 901", "resume only"]);
    expect(await f.validate()).toEqual(chrome());
  });

  test("browser activity stays with its exact target and diagnostic failure cannot change readiness", async () => {
    let broken = false;
    let activity: BrowserActivity = { active: { phase: "snapshot_rpc", sequence: 1, startedAt: 1000 } };
    const f = fixture(() => { if (broken) throw new Error("diagnostic unavailable"); return activity; });
    await f.targets.attach(hand);
    expect(f.targets.target(hand)).toMatchObject({ mode: "existing", window_id: 901, ready: true, activity });
    activity = { last: { phase: "snapshot_rpc", sequence: 1, durationMs: 24000, outcome: "ok" } };
    expect(f.targets.target(hand)).toMatchObject({ activity });
    broken = true;
    expect(f.targets.target(hand)).toMatchObject({ mode: "existing", window_id: 901, ready: true });
    expect(f.targets.target(hand)).not.toHaveProperty("activity");
    expect(f.preparations()).toBe(1);
    await f.targets.detach(hand);
    expect(f.targets.target(hand)).toEqual({ mode: "private" });
  });

  test("expired grants and recycled saved windows stay disconnected in existing mode", async () => {
    for (const arrange of [(f: ReturnType<typeof fixture>) => f.fail(), (f: ReturnType<typeof fixture>) => f.found([]),
      (f: ReturnType<typeof fixture>) => f.found([{ ...chrome(), ownerNonce: "0000000000000002" }])]) {
      const f = fixture(); arrange(f);
      await expect(f.targets.restore(hand, chrome())).rejects.toThrow();
      expect(f.targets.target(hand)).toMatchObject({ mode: "existing", window_id: 901, ready: false });
      expect(() => f.targets.connection(hand)).toThrow("reconnection");
      expect(f.calls).not.toContain("end session");
      expect(f.calls.length === 0 || f.calls.includes("resume only")).toBe(true);
      await f.targets.detach(hand);
      expect(f.calls).toContain("end disconnected session");
      expect(f.targets.target(hand)).toEqual({ mode: "private" });
    }
  });

  test("ambiguous Chrome windows and invalid nonces require explicit current selection", async () => {
    const f = fixture(); f.found([chrome(), chrome(902)]);
    await expect(f.targets.attach(hand)).rejects.toThrow("Choose one observed");
    expect(f.calls).toEqual([]);
    f.found([{ ...chrome(), ownerNonce: undefined }]);
    await expect(f.targets.attach(hand, { window_id: 901 })).rejects.toThrow("No matching");
    expect(f.targets.target(hand)).toEqual({ mode: "private" });
  });

  test("repeated attachment reuses the exact live connection without closing or preparing it again", async () => {
    const f = fixture(); await f.targets.attach(hand);
    const connected = f.targets.connection(hand);
    // A second Chrome window does not make reusing our already bound one ambiguous.
    f.found([chrome(), chrome(902)]);
    await f.targets.attach(hand);
    await f.targets.attach(hand, { window_id: 901, pid: 82 });
    expect(f.targets.connection(hand)).toBe(connected);
    expect(f.preparations()).toBe(1);
    expect(f.calls).toEqual(["claim 1 901"]);
    f.current(chrome(902));
    await f.targets.attach(hand, { window_id: 902 });
    expect(f.preparations()).toBe(2);
    expect(f.calls).toEqual(["claim 1 901", "end session", "release 1", "claim 1 902"]);
    expect(f.targets.target(hand)).toMatchObject({ mode: "existing", window_id: 902, ready: true });
  });

  test("idempotent attach still refuses a closed window, changed PID or recycled nonce", async () => {
    for (const changed of [null, { ...chrome(), pid: 99 }, { ...chrome(), ownerNonce: "0000000000000002" }]) {
      const f = fixture(); await f.targets.attach(hand);
      f.current(changed);
      await expect(f.targets.attach(hand)).rejects.toThrow();
      expect(f.preparations()).toBe(1);
      expect(f.calls).toEqual(["claim 1 901"]);
      expect(f.targets.target(hand).mode).toBe("existing");
    }
  });

  test("an ended session is shown disconnected and an explicit attach replaces it", async () => {
    const f = fixture(); await f.targets.attach(hand);
    const previous = f.targets.connection(hand);
    f.expire();
    expect(f.targets.target(hand)).toMatchObject({ mode: "existing", window_id: 901, ready: false });
    await f.targets.attach(hand, { window_id: 901, pid: 82 });
    expect(f.preparations()).toBe(2);
    expect(f.targets.connection(hand)).not.toBe(previous);
    expect(f.targets.target(hand)).toMatchObject({ mode: "existing", window_id: 901, ready: true });
    expect(f.calls).toEqual(["claim 1 901", "end session", "release 1", "claim 1 901"]);
  });

  test("failed preparation keeps explicit existing mode and refuses sandbox fallback", async () => {
    const f = fixture(); f.fail();
    await expect(f.targets.attach(hand)).rejects.toThrow("permission denied");
    expect(f.targets.target(hand)).toMatchObject({ mode: "existing", ready: false, error: "Cua permission denied", window_id: 901 });
    expect(() => f.targets.connection(hand)).toThrow("permission denied");
    expect(await f.targets.read(hand)).toEqual(chrome());
    expect(f.calls).toEqual(["claim 1 901"]);
  });

  test("a closed, temporarily omitted or recycled user window cannot become another Chrome window", async () => {
    const f = fixture(); await f.targets.attach(hand);
    f.current(null);
    expect(await f.targets.read(hand)).toBeNull();
    expect(f.targets.target(hand).mode).toBe("existing");
    await expect(f.validate()).rejects.toThrow("unavailable");
    for (const changed of [{ ...chrome(), pid: 99 }, { ...chrome(), ownerNonce: "0000000000000902" }, chrome(902)]) {
      f.current(changed);
      await expect(f.targets.read(hand)).rejects.toThrow("identity changed");
    }
    f.current(chrome());
    expect(await f.targets.read(hand)).toEqual(chrome());
  });

  test("simultaneous hand claims have one winner, including two windows of the same Chrome process", async () => {
    const f = fixture(); f.found([chrome(), chrome(902)]);
    const second = { ...hand, id: 2, display: "Puk hand 2" };
    const result = await Promise.allSettled([f.targets.attach(hand, { window_id: 901 }), f.targets.attach(second, { window_id: 902 })]);
    expect(result.map((entry) => entry.status)).toEqual(["fulfilled", "rejected"]);
    expect(f.targets.target(second)).toEqual({ mode: "private" });
    expect(f.calls).toEqual(["claim 1 901"]);
  });

  test("a read finishing after detachment cannot republish the previous account window", async () => {
    const f = fixture(); await f.targets.attach(hand);
    let finish!: (window: RawWindow) => void;
    f.reading(new Promise((resolve) => { finish = resolve; }));
    const pending = f.targets.read(hand);
    await f.targets.detach(hand);
    finish(chrome());
    await expect(pending).rejects.toThrow("target changed");
    expect(f.targets.target(hand)).toEqual({ mode: "private" });
  });
});

describe("private browser ownership", () => {
  const executable = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const profile = "C:\\Users\\A User\\AppData\\Local\\Puk\\hands\\1\\browser";
  const process = (commandLine: string) => ({ pid: 82, executable, commandLine: `"${executable}" ${commandLine}` });

  test("cleanup recognizes exact quoted private profiles, never a user's Chrome or a substring", () => {
    expect(isPrivateBrowser(process(`"--user-data-dir=${profile}" --remote-debugging-port=0`), executable, profile)).toBe(true);
    expect(isPrivateBrowser(process(`--user-data-dir="${profile}"`), executable, profile)).toBe(true);
    expect(isPrivateBrowser(process(`--user-data-dir "${profile.toUpperCase()}"`), executable, profile)).toBe(true);
    for (const arguments_ of [
      "--remote-debugging-port=9222", `"--user-data-dir=${profile}-other"`,
      `"--user-data-dir=${profile}" --type=renderer`,
      `"--user-data-dir=${profile}" "--user-data-dir=C:\\Users\\A User\\Chrome"`,
      `"--user-data-dir=${profile}`, `--some-url="${profile}"`,
    ]) expect(isPrivateBrowser(process(arguments_), executable, profile)).toBe(false);
    expect(isPrivateBrowser({ ...process(`"--user-data-dir=${profile}"`), executable: "C:\\other\\chrome.exe" }, executable, profile)).toBe(false);
  });

  test("a fresh user window is never adopted, even if larger or the only window", () => {
    const mine = { pid: 82, rect: [0, 0, 1000, 800] as [number, number, number, number] };
    const user = { pid: 60, rect: [0, 0, 2000, 1800] as [number, number, number, number] };
    expect(launchedBrowserWindow([user, mine], 82)).toBe(mine);
    expect(launchedBrowserWindow([user], 82)).toBeUndefined();
    expect(launchedBrowserWindow([user, mine], 0)).toBeUndefined();
    expect(launchedBrowserWindow([{ pid: 82, rect: [0, 0, 200, 200] }, mine], 82)).toBe(mine);
  });
});

describe("shared Cua transports", () => {
  const hand: Hand = { id: 1, pid: 1, display: "test", width: 800, height: 600 };
  const raw = (close: () => Promise<void> = async () => {}): CuaConnection => ({ call: async () => ({ content: [] }), close });

  test("pool preserves the broker's stable browser-session provider", async () => {
    const session = "puk-browser-stable";
    const pool = createDriverPool(async () => ({ ...raw(), browserSession: async () => session }));
    expect(await (await pool.get(hand)).browserSession?.()).toBe(session);
    await pool.close();
  });

  test("pool publishes immediate transport loss without ending a session or opening a replacement", async () => {
    let attempts = 0, closes = 0;
    const closed: (() => void)[] = [], calls: string[] = [];
    const pool = createDriverPool(async (_hand, onClosed) => {
      attempts++; closed.push(onClosed);
      return { call: async name => { calls.push(name); return { content: [] }; }, close: async () => { closes++; } };
    });
    const first = await pool.get(hand);
    expect(first.disconnected?.aborted).toBe(false);
    closed[0]!();
    expect(first.disconnected?.aborted).toBe(true);
    expect({ attempts, closes, calls }).toEqual({ attempts: 1, closes: 0, calls: [] });
    const replacement = await pool.get(hand);
    expect(replacement.disconnected?.aborted).toBe(false);
    await first.close();
    expect(replacement.disconnected?.aborted).toBe(false);
    expect(await pool.get(hand)).toBe(replacement);
    await pool.close();
    expect(replacement.disconnected?.aborted).toBe(true);
    expect({ attempts, closes, calls }).toEqual({ attempts: 2, closes: 2, calls: [] });
  });

  test("closing a raw driver publishes disconnection before its cleanup finishes", async () => {
    const cleanup = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const pool = createDriverPool(async () => raw(async () => { entered.resolve(); await cleanup.promise; }));
    const connection = await pool.get(hand), closing = connection.close();
    await entered.promise;
    expect(connection.disconnected?.aborted).toBe(true);
    cleanup.resolve(); await closing; await pool.close();
  });


  test("failed connection attempts are evicted and an old close cannot evict a replacement", async () => {
    let attempts = 0;
    const closed: (() => void)[] = [];
    const pool = createDriverPool(async (_hand, onClosed) => {
      attempts++; closed.push(onClosed);
      if (attempts === 1) throw new Error("temporary connection failure");
      return raw();
    });
    await expect(pool.get(hand)).rejects.toThrow("temporary connection failure");
    const second = await pool.get(hand);
    expect(await pool.get(hand)).toBe(second);
    closed[1]!();
    const third = await pool.get(hand);
    expect(third).not.toBe(second);
    await second.close();
    expect(await pool.get(hand)).toBe(third);
    expect(attempts).toBe(3);
    await pool.close();
  });

  test("an ordinary rejected action keeps the shared transport and is not replayed", async () => {
    let attempts = 0, actions = 0, closes = 0;
    const pool = createDriverPool(async () => {
      attempts++;
      return { call: async () => { actions++; throw new Error("canvas refused input"); }, close: async () => { closes++; } };
    });
    const connection = await pool.get(hand);
    await expect(connection.call("drag")).rejects.toThrow("canvas refused input");
    expect(await pool.get(hand)).toBe(connection);
    expect({ attempts, actions, closes }).toEqual({ attempts: 1, actions: 1, closes: 0 });
    await pool.close();
    expect(closes).toBe(1);
  });
});

test("startup failure closes helper pipes even if another disposer fails, once only", async () => {
  const helper = Bun.spawn([process.execPath, "-e", "await new Response(Bun.stdin.stream()).text()"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let desktopClosed = 0;
  const resources = serverResources(async () => { desktopClosed++; helper.stdin.end(); await helper.exited; });
  resources.add(() => { throw new Error("partly initialized server"); });
  try {
    await Promise.race([resources.close(), Bun.sleep(2000).then(() => { throw new Error("helper pipe kept the process alive"); })]);
    await resources.close();
    expect(helper.exitCode).toBe(0);
    expect(desktopClosed).toBe(1);
  } finally { if (helper.exitCode === null) helper.kill(); }
});

describe("signing in", () => {
  test("tells the user what to do while the window is open, and what came of it", () => {
    expect(signInLine(1, { state: "waiting", sites: null })).toBe("");
    expect(signInLine(1, { state: "open", sites: null })).toContain("close the window");
    expect(signInLine(2, { state: "done", sites: ["Google", "GitHub"] })).toBe("Hand 2 is signed in to: Google, GitHub.");
    expect(signInLine(2, { state: "done", sites: [] })).toContain("none of the sign-ins Puk knows");
    expect(signInLine(2, { state: "done", sites: null })).toContain("bun win/desktop.ts sessions 2");
    expect(signInLine(3, { state: "error", sites: null, error: "Hand 3's browser did not close." })).toBe("Hand 3: Hand 3's browser did not close.");
  });
  test("a hand by number needs no desktop: the bench keeps its own name", () => {
    expect(handFor(2).display).toBe("Puk hand 2");
    expect(handFor(99).display).toBe("Puk bench");
  });
});

describe("adoptable", () => {
  const w = (app: string, title: string, size = 800, iconic = false, at = 40) => ({ app, title, rect: [at, at, size, size] as [number, number, number, number], iconic });
  test("an application left on the hand's desktop by an earlier run is used again, not opened a second time", () => {
    const left = [w("chrome", "about:blank - Google Chrome"), w("ApplicationFrameHost", "Calculator", 900), w("CalculatorApp", "Calculator", 500, false, 0), w("mspaint", "Untitled - Paint")];
    expect(adoptable(left, "Calculator")?.app).toBe("CalculatorApp");
    expect(adoptable(left, "Paint")?.title).toBe("Untitled - Paint");
    expect(adoptable(left, "Notepad")).toBeUndefined();
  });
  test("what a closed UWP application leaves behind is not an open application", () => {
    // The content window outlives its frame, suspended, and still reads "Display is 372" from the task before.
    expect(adoptable([w("CalculatorApp", "Calculator", 500, false, 0)], "Calculator")).toBeUndefined();
    expect(adoptable([w("ApplicationFrameHost", "Calculator", 900)], "Calculator")).toBeUndefined(); // a frame alone is not it either
  });
  test("a lookalike is not the application, and a minimised window is not adopted", () => {
    expect(adoptable([w("PaintStudio.View", "Paint 3D")], "Paint")).toBeUndefined();
    expect(adoptable([w("notepad++", "new 1 - Notepad++")], "Notepad")).toBeUndefined();
    expect(adoptable([w("mspaint", "Untitled - Paint", 800, true)], "Paint")).toBeUndefined();
    expect(adoptable([w("charmap", "Character Map")], "Character Map")?.app).toBe("charmap");
  });
});
