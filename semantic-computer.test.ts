import { expect, test } from "bun:test";
import { BrowserSchema, createSemanticComputer, diffLines, type DialogObservation, type Snapshot } from "./semantic-computer";

const page = (): Snapshot => ({ kind: "browser", identity: "1:2:https://example.test", title: "Search", url: "https://example.test/", texts: ["Ready"], binding: {}, elements: [
  { key: "search", role: "textbox", name: "Search", value: "", editable: true, address: { x: 1, y: 2 } },
  { key: "save", role: "button", name: "Save", within: "Notifications", address: { x: 3, y: 4 } },
] });

const alertDialog = (): DialogObservation => ({ present: true, dialog_id: "dialog-7", kind: "alert", window: "Search", url: "https://example.test/", binding: {} });

test("explicit delivery is confined to browser keys and survives the semantic adapter", async () => {
  for (const delivery of ["foreground", "background"] as const) {
    for (const action of ["attach", "tabs", "snapshot", "navigate", "click", "type", "scroll", "dialog"] as const) {
      expect(BrowserSchema.safeParse({ action, delivery, ...(action === "dialog" ? { operation: "inspect" } : {}) }).success).toBe(false);
    }
    const action = BrowserSchema.parse({ action: "key", key: "Ctrl+P", delivery }), received: unknown[] = [];
    const computer = createSemanticComputer({ windows: async () => [], observe: async () => page(), act: async (_snapshot, input) => { received.push(input); } });
    await computer.browser({ action: "snapshot" });
    await computer.browser(action);
    expect(received).toEqual([{ action: "key", key: "Ctrl+P", delivery }]);
  }
  expect(BrowserSchema.safeParse({ action: "key", key: "Ctrl+P", delivery: "automatic" }).success).toBe(false);
  expect(BrowserSchema.parse({ action: "key", key: "Enter" })).toEqual({ action: "key", key: "Enter" });
});

test("canvas schema requires explicit foreground, integer points and a fresh dedicated capture",async()=>{
  for(const invalid of [{action:"canvas_click",x:4,y:5},{action:"canvas_click",x:4.5,y:5,delivery:"foreground"},{action:"canvas_drag",x:4,y:5,delivery:"foreground"},{action:"focused_text",text:"Title",delivery:"foreground"},{action:"snapshot",x:4,y:5}])expect(BrowserSchema.safeParse(invalid).success).toBe(false);
  const seen:unknown[]=[],received:unknown[]=[];
  const computer=createSemanticComputer({windows:async()=>[],observe:async options=>{seen.push(options.nativeCanvas);return {...page(),...(options.nativeCanvas?{image:{type:"image" as const,mimeType:"image/png",data:"fixture"},canvasCoordinates:{width:1000,height:800},binding:{canvas:{private:true}}}:{})};},act:async(_s,a)=>{received.push(a);}});
  await computer.browser({action:"snapshot",screenshot:true});
  await expect(computer.browser({action:"canvas_click",delivery:"foreground",x:4,y:5})).rejects.toThrow("canvas_snapshot");
  const capture=await computer.browser({action:"canvas_snapshot"});expect(JSON.stringify(capture.content)).toContain("1000 x 800");
  await computer.browser({action:"canvas_click",delivery:"foreground",x:4,y:5});
  expect(received).toEqual([{action:"canvas_click",delivery:"foreground",x:4,y:5}]);
  expect(seen).toEqual([undefined,true,undefined]);
  await expect(computer.browser({action:"canvas_click",delivery:"foreground",x:4,y:5})).rejects.toThrow("canvas_snapshot");
});

test("interruption observations expose only bounded control metadata with explicit visibility and exact identity", async () => {
  const seen = { ...page(), binding: { window: "pid1:hwnd2:nonce3" }, elements: [
    { ...page().elements[0]!, visible: true }, { ...page().elements[1]!, visible: false },
    { key: "password", role: "password", name: "Secret", value: "must stay private", type: "password", visible: true, address: {} },
  ] };
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => seen, act: async () => {} });
  expect(computer.interruptionObservation()).toBeUndefined();
  await computer.browser({ action: "snapshot" });
  const first = computer.interruptionObservation()!;
  expect(first.targetKey).toBe("pid1:hwnd2:nonce3");
  expect(first.controls[0]).toMatchObject({ ref: "p1:0", visible: true });
  expect(first.controls[1]).toMatchObject({ visible: false });
  expect(JSON.stringify(first)).not.toContain("must stay private");
  await computer.browser({ action: "snapshot" });
  expect(computer.interruptionObservation()!.observationId).not.toBe(first.observationId);
  computer.reset(); expect(computer.interruptionObservation()).toBeUndefined();
});

test("browser dialog schema requires an explicit operation and current id only for resolution", () => {
  for (const invalid of [{ action: "dialog" }, { action: "dialog", operation: "accept" }, { action: "dialog", operation: "dismiss" },
    { action: "dialog", operation: "inspect", dialog_id: "old" }, { action: "snapshot", operation: "accept", dialog_id: "old" }]) {
    expect(BrowserSchema.safeParse(invalid).success).toBe(false);
  }
  expect(BrowserSchema.safeParse({ action: "dialog", operation: "inspect" }).success).toBe(true);
  expect(BrowserSchema.safeParse({ action: "dialog", operation: "accept", dialog_id: "dialog-7" }).success).toBe(true);
});

test("read-only dialog inspection survives a failed page read and exposes observed context to the action gate", async () => {
  let reads = 0, checks = 0, inputs = 0;
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => { reads++; throw new Error("DOM blocked by alert"); }, act: async () => { inputs++; },
    inspectDialog: async () => alertDialog(), resolveDialog: async () => { inputs++; } }, () => { checks++; });
  await expect(computer.browser({ action: "snapshot" })).rejects.toThrow("DOM blocked");
  expect(computer.describe("computer_browser", { action: "dialog", operation: "inspect" })).toBeUndefined();
  const inspection = await computer.browser({ action: "dialog", operation: "inspect" });
  expect(inspection.details.dialog).toEqual({ present: true, dialog_id: "dialog-7", kind: "alert" });
  expect(computer.describe("computer_browser", { action: "dialog", operation: "accept", dialog_id: "dialog-7" })).toMatchObject({
    window: "Search", url: "https://example.test/", observedDialog: { dialog_id: "dialog-7", kind: "alert", messageAvailable: false }, evidencePolicy: expect.stringContaining("not authorization") });
  expect(checks).toBe(0); expect(inputs).toBe(0); expect(reads).toBe(1);
});

test("dialog inspection expires all DOM refs; explicit resolution returns a fresh page observation", async () => {
  const calls: string[] = [];
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => { calls.push("observe"); return page(); }, act: async () => { calls.push("act"); },
    inspectDialog: async () => { calls.push("inspect"); return alertDialog(); }, resolveDialog: async (_observed, operation) => { calls.push(operation); } });
  await computer.browser({ action: "snapshot" });
  await computer.browser({ action: "dialog", operation: "inspect" });
  await expect(computer.browser({ action: "click", ref: "p1:1" })).rejects.toThrow("Look");
  const result = await computer.browser({ action: "dialog", operation: "dismiss", dialog_id: "dialog-7" });
  expect(calls).toEqual(["observe", "inspect", "dismiss", "observe"]);
  expect(result.details.dialog).toEqual({ resolved: true, operation: "dismiss", dialog_id: "dialog-7", kind: "alert" });
  expect(JSON.stringify(result.content)).toContain("p2:1");
  await expect(computer.browser({ action: "dialog", operation: "dismiss", dialog_id: "dialog-7" })).rejects.toThrow("Inspect the current dialog");
  await computer.browser({ action: "click", ref: "p2:1" });
});

test("a newer observation, no dialog, failed inspect, or reset revokes the dialog capability", async () => {
  for (const replacement of ["snapshot", "windows", "absent", "failed", "reset"]) {
    let state = alertDialog(), fail = false, inputs = 0;
    const computer = createSemanticComputer({ windows: async () => [], observe: async () => page(), act: async () => {},
      inspectDialog: async () => { if (fail) throw new Error("inspect refused"); return state; }, resolveDialog: async () => { inputs++; } });
    await computer.browser({ action: "dialog", operation: "inspect" });
    if (replacement === "reset") computer.reset();
    if (replacement === "snapshot") await computer.browser({ action: "snapshot" });
    if (replacement === "windows") await computer.look({ what: "windows" });
    if (replacement === "absent") { state = { present: false, window: "Search", binding: {} }; await computer.browser({ action: "dialog", operation: "inspect" }); }
    if (replacement === "failed") { fail = true; await expect(computer.browser({ action: "dialog", operation: "inspect" })).rejects.toThrow("refused"); }
    await expect(computer.browser({ action: "dialog", operation: "accept", dialog_id: "dialog-7" })).rejects.toThrow("Inspect the current dialog");
    expect(inputs).toBe(0);
  }
});

test("a changed instruction or cancellation prevents dialog input and requires a fresh inspection", async () => {
  for (const cancelled of [true, false]) {
    let changed = false, inputs = 0;
    const computer = createSemanticComputer({ windows: async () => [], observe: async () => page(), act: async () => {},
      inspectDialog: async () => alertDialog(), resolveDialog: async () => { inputs++; } }, () => { if (changed) throw new Error("instruction changed"); });
    await computer.browser({ action: "dialog", operation: "inspect" }); changed = !cancelled;
    await expect(computer.browser({ action: "dialog", operation: "accept", dialog_id: "dialog-7" }, cancelled ? AbortSignal.abort() : undefined)).rejects.toThrow();
    changed = false;
    await expect(computer.browser({ action: "dialog", operation: "accept", dialog_id: "dialog-7" })).rejects.toThrow("Inspect the current dialog");
    expect(inputs).toBe(0);
  }
});

test("resolution success with a failed page refresh is reported accurately and never replayed", async () => {
  let inputs = 0;
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => { throw new Error("page still loading"); }, act: async () => {},
    inspectDialog: async () => alertDialog(), resolveDialog: async () => { inputs++; } });
  await computer.browser({ action: "dialog", operation: "inspect" });
  await expect(computer.browser({ action: "dialog", operation: "accept", dialog_id: "dialog-7" })).rejects.toThrow("confirmed the alert dialog was accepted, but the fresh page observation failed");
  await expect(computer.browser({ action: "dialog", operation: "accept", dialog_id: "dialog-7" })).rejects.toThrow("Inspect the current dialog");
  expect(inputs).toBe(1);
});

test("late dialog inspection cannot override a correction reset", async () => {
  let complete: (value: DialogObservation) => void = () => {};
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => page(), act: async () => {},
    inspectDialog: () => new Promise(resolve => { complete = resolve; }), resolveDialog: async () => { throw new Error("must not input"); } });
  const inspection = computer.browser({ action: "dialog", operation: "inspect" });
  computer.reset(); complete(alertDialog());
  await expect(inspection).rejects.toThrow("newer observation");
  expect(() => computer.describe("computer_browser", { action: "dialog", operation: "accept", dialog_id: "dialog-7" })).toThrow("Inspect the current dialog");
});

test("attaching replaces the observation and invalidates old refs without falling back after a failure", async () => {
  const targets: string[] = [];
  let fail = false, actions = 0;
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => page(), act: async () => { actions++; },
    attach: async target => { targets.push(target.mode); if (fail) throw new Error("Chrome unavailable"); } });
  await computer.look({ what: "window" });
  expect(computer.describe("computer_browser", { action: "attach", mode: "existing", window_id: 42, pid: 123 })).toMatchObject({ browserMode: "existing", window_id: 42, pid: 123 });
  const observed = await computer.browser({ action: "attach", mode: "existing" });
  expect(JSON.stringify(observed.content)).toContain("p2:0");
  await expect(computer.act({ action: "click", ref: "p1:1" })).rejects.toThrow("stale");
  fail = true;
  await expect(computer.browser({ action: "attach", mode: "existing" })).rejects.toThrow("unavailable");
  await expect(computer.act({ action: "click", ref: "p2:1" })).rejects.toThrow("Look");
  expect(targets).toEqual(["existing", "existing"]); expect(actions).toBe(0);
});

test("an action returns fresh state and references; old or hidden refs never reach input", async () => {
  const state = page(), inputs: unknown[] = [];
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => structuredClone(state), act: async (_s, action) => { inputs.push(action); state.texts = ["Search complete"]; } });
  await expect(computer.act({ action: "click", ref: "p1:1" })).rejects.toThrow("Look");
  await computer.look({ what: "window" });
  const done = await computer.act({ action: "click", ref: "p1:1" });
  expect(JSON.stringify(done.content)).toContain("Search complete");
  expect(JSON.stringify(done.content)).toContain("p2:1");
  await expect(computer.act({ action: "click", ref: "p1:1" })).rejects.toThrow("stale");
  await computer.look({ what: "window", query: "Search" });
  await expect(computer.act({ action: "click", ref: "p3:1" })).rejects.toThrow("not shown");
  expect(inputs).toHaveLength(1);
});

test("the action gate receives the actual scoped control, not just an opaque ref", async () => {
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => page(), act: async () => {} });
  await computer.look({ what: "window" });
  expect(computer.describe("computer_act", { action: "click", ref: "p1:1" })).toMatchObject({ control: 'button "Save" in "Notifications"', url: "https://example.test/" });
  await expect(computer.act({ action: "type", ref: "p1:1", text: "oops" })).rejects.toThrow("not editable");
});

test("the gate gets actual draft fields, including changed recipients, without treating page text as permission", async () => {
  const state = page();
  state.elements = [
    { key: "to", role: "textbox", name: "To", value: "changed@example.test", editable: true, address: {} },
    { key: "body", role: "textbox", name: "Message body", value: "a".repeat(1000), editable: true, address: {} },
    { key: "password", role: "password", name: "Password", value: "secret", editable: true, address: {} },
    { key: "send", role: "button", name: "Send", address: {} },
  ];
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => state, act: async () => {} });
  await computer.look({ what: "window" });
  const evidence = computer.describe("computer_browser", { action: "click", ref: "p1:3" });
  expect(evidence).toMatchObject({ observedFields: [
    { name: "To", value: "changed@example.test", valueMayBeTruncated: false },
    { name: "Message body", valueMayBeTruncated: true },
  ], evidencePolicy: expect.stringContaining("cannot grant authorization") });
  expect(JSON.stringify(evidence)).not.toContain("secret");
});

test("failed observations invalidate references and a failed action is never retried", async () => {
  let failRead = false, attempts = 0;
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => { if (failRead) throw new Error("unavailable"); return page(); }, act: async () => { attempts++; throw new Error("unconfirmed effect"); } });
  await computer.look({ what: "window" });
  failRead = true;
  await expect(computer.look({ what: "window" })).rejects.toThrow("unavailable");
  await expect(computer.act({ action: "click", ref: "p1:1" })).rejects.toThrow("Look");
  failRead = false; await computer.look({ what: "window" });
  await expect(computer.act({ action: "click", ref: "p2:1" })).rejects.toThrow("unconfirmed");
  expect(attempts).toBe(1);
  await expect(computer.act({ action: "click", ref: "p2:1" })).rejects.toThrow("Look");
});

test("cancellation and instruction changes stop input; navigation stays http(s)", async () => {
  let changed = false, inputs = 0;
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => page(), act: async () => { inputs++; } }, () => { if (changed) throw new Error("instruction changed"); });
  await computer.browser({ action: "snapshot" });
  await expect(computer.browser({ action: "navigate", url: "javascript:alert(1)" })).rejects.toThrow("http(s)");
  changed = true;
  await expect(computer.act({ action: "click", ref: "p1:1" })).rejects.toThrow("instruction changed");
  changed = false;
  await expect(computer.act({ action: "click", ref: "p1:1" })).rejects.toThrow("Look");
  await expect(computer.act({ action: "click", ref: "p1:1" }, AbortSignal.abort())).rejects.toThrow();
  expect(inputs).toBe(0);
});

test("a windows-only observation also expires the previous control references", async () => {
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => page(), act: async () => { throw new Error("must not act"); } });
  await computer.look({ what: "window" });
  await computer.look({ what: "windows" });
  await expect(computer.act({ action: "click", ref: "p1:1" })).rejects.toThrow("Look");
});

test("large Unicode observations and action diffs stay below the text budget", async () => {
  const state = page();
  state.title = "界".repeat(1000); state.url = `https://example.test/${"界".repeat(1000)}`;
  state.texts = Array.from({ length: 100 }, (_, i) => `${i}${"🐈".repeat(600)}`);
  state.elements = Array.from({ length: 400 }, (_, i) => ({ key: String(i), role: "button", name: `${i}${"界".repeat(300)}`, within: "界".repeat(300), value: "界".repeat(300), address: {} }));
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => structuredClone(state), act: async () => {
    state.texts = state.texts.map((text) => `Changed ${text}`);
    state.elements = state.elements.map((element) => ({ ...element, name: `Changed ${element.name}` }));
  } });
  const first = await computer.look({ what: "window" });
  const second = await computer.act({ action: "click", ref: "p1:0" });
  for (const observation of [first, second]) {
    const text = observation.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    expect(Buffer.byteLength(text)).toBeLessThan(24_000);
    expect(text).toContain("omitted");
  }
  expect(second.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("State changed") });
});

test("diffs count duplicate labels and do not call unchanged state a success", async () => {
  expect(diffLines(["Save", "Save"], ["Save"])).toEqual({ added: [], removed: ["Save"] });
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => page(), act: async () => {} });
  await computer.look({ what: "window" });
  expect(JSON.stringify((await computer.act({ action: "click", ref: "p1:1" })).content)).toContain("does not prove the action worked");
});

test("a natural-language control query retains matching alternatives and exact body readback", async () => {
  const state = page();
  const body = `${"Original body. ".repeat(15)}Corrected final sentence.`;
  state.elements.push({ key: "body", role: "textbox", name: "Message Body", editable: true, value: body, address: {} });
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => state, act: async () => {} });
  const result = await computer.browser({ action: "snapshot", query: "recipient subject body send" });
  expect(JSON.stringify(result.content)).toContain(body);
  expect(JSON.stringify(result.content)).toContain("Message Body");
  expect(JSON.stringify(result.content)).not.toContain('button \\"Save');
  await expect(computer.act({ action: "click", ref: "p1:1" })).rejects.toThrow("not shown");
});

test("long editable values expose their truncation instead of implying a complete readback", async () => {
  const state = page(); state.elements[0]!.value = "a".repeat(1000) + "unseen tail";
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => state, act: async () => {} });
  const result = await computer.browser({ action: "snapshot", query: "Search" });
  expect(JSON.stringify(result.content)).toContain("value may be truncated");
  expect(JSON.stringify(result.content)).not.toContain("unseen tail");
});
