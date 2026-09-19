import { expect, test } from "bun:test";
import { BrowserSchema, createSemanticComputer, diffLines, observedTabInventory, type DialogObservation, type Snapshot } from "./semantic-computer";

const page = (): Snapshot => ({ kind: "browser", identity: "1:2:https://example.test", title: "Search", url: "https://example.test/", texts: ["Ready"], binding: {}, elements: [
  { key: "search", role: "textbox", name: "Search", value: "", editable: true, address: { x: 1, y: 2 } },
  { key: "save", role: "button", name: "Save", within: "Notifications", address: { x: 3, y: 4 } },
] });

const alertDialog = (): DialogObservation => ({ present: true, dialog_id: "dialog-7", kind: "alert", window: "Search", url: "https://example.test/", binding: {} });

const canvasPage = (): Snapshot => ({ ...page(), image: { type: "image", mimeType: "image/png", data: "native-png" },
  canvasCoordinates: { width: 1000, height: 800 }, binding: { window: "90:1234:0000000000000123", canvas: { privateCapability: "never-expose" } } });

test("visual target frames require native canvas evidence and never fall back to page identity", async () => {
  let state = page();
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => state, act: async () => {} });
  expect(computer.visualTargetFrame()).toBeUndefined();
  for (const invalid of [page(), { ...page(), image: canvasPage().image },
    { ...canvasPage(), binding: { window: "90:1234:0000000000000123" } }, { ...canvasPage(), binding: { canvas: {} } },
    { ...canvasPage(), canvasCoordinates: undefined }, { ...canvasPage(), image: undefined },
    { ...canvasPage(), image: { type: "image" as const, mimeType: "image/jpeg", data: "jpeg" } },
    { ...canvasPage(), canvasCoordinates: { width: 0, height: 800 } }, { ...canvasPage(), kind: "native" as const }]) {
    state = invalid;
    await computer.look({ what: "window", screenshot: true });
    expect(computer.visualTargetFrame()).toBeUndefined();
  }
});

test("visual target frames are deterministic frozen copies without references or page authority", async () => {
  const state = canvasPage();
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => state, act: async () => {} });
  await computer.browser({ action: "canvas_snapshot", include_refs: true });
  const first = computer.visualTargetFrame()!, same = computer.visualTargetFrame()!;
  expect(first).toEqual(same); expect(first).not.toBe(same); expect(first.image).not.toBe(same.image);
  expect(first).toMatchObject({ targetKey: "90:1234:0000000000000123", generation: 1, width: 1000, height: 800,
    image: { type: "image", mimeType: "image/png", data: "native-png" } });
  expect(first.observationId.endsWith(":1")).toBe(true);
  expect(Object.keys(first).sort()).toEqual(["generation", "height", "image", "observationId", "targetKey", "width"]);
  expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.image)).toBe(true);
  const text = JSON.stringify(first);
  for (const omitted of ["never-expose", "binding", "example.test", "Search", "Ready", "p1:", "address"]) expect(text).not.toContain(omitted);
  expect(first.image).not.toBe(state.image);
  await computer.browser({ action: "canvas_snapshot" });
  const fresh = computer.visualTargetFrame()!;
  expect(fresh.generation).toBe(2); expect(fresh.observationId).not.toBe(first.observationId);
});

test("new, failed, reset and overlapping reads revoke visual target frames immediately", async () => {
  let pending: ReturnType<typeof Promise.withResolvers<Snapshot>> | undefined;
  const computer = createSemanticComputer({ windows: async () => [], observe: () => pending?.promise ?? Promise.resolve(canvasPage()), act: async () => {} });
  await computer.browser({ action: "canvas_snapshot" });
  const old = computer.visualTargetFrame()!;
  pending = Promise.withResolvers<Snapshot>();
  const failed = computer.browser({ action: "canvas_snapshot" }).then(() => null, error => error);
  expect(computer.visualTargetFrame()).toBeUndefined();
  pending.reject(new Error("capture failed")); expect(String(await failed)).toContain("capture failed");
  expect(computer.visualTargetFrame()).toBeUndefined();
  pending = undefined; await computer.browser({ action: "canvas_snapshot" });
  expect(computer.visualTargetFrame()!.generation).toBeGreaterThan(old.generation);
  pending = Promise.withResolvers<Snapshot>();
  const superseded = computer.browser({ action: "canvas_snapshot" }).then(() => null, error => error);
  computer.reset(); pending.resolve(canvasPage());
  expect(String(await superseded)).toContain("newer observation"); expect(computer.visualTargetFrame()).toBeUndefined();
  pending = undefined; await computer.browser({ action: "canvas_snapshot" });
  await computer.look({ what: "windows" }); expect(computer.visualTargetFrame()).toBeUndefined();
});

test("input revokes visual target evidence before dispatch and only fresh capture restores it", async () => {
  const dispatched = Promise.withResolvers<void>(), consumed = new Set<unknown>(); let fail = false;
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => canvasPage(), act: async (snapshot) => {
    expect(computer.visualTargetFrame()).toBeUndefined();
    expect(consumed.has(snapshot.binding.canvas)).toBe(false); consumed.add(snapshot.binding.canvas);
    await dispatched.promise; if (fail) throw new Error("input failed");
  } });
  await computer.browser({ action: "canvas_snapshot" });
  const first = computer.visualTargetFrame()!;
  const input = computer.browser({ action: "canvas_click", delivery: "foreground", x: 20, y: 30 });
  expect(computer.visualTargetFrame()).toBeUndefined();
  dispatched.resolve(); await input;
  expect(consumed.size).toBe(1); expect(computer.visualTargetFrame()!.observationId).not.toBe(first.observationId);
  fail = true;
  await expect(computer.browser({ action: "canvas_click", delivery: "foreground", x: 20, y: 30 })).rejects.toThrow("input failed");
  expect(computer.visualTargetFrame()).toBeUndefined();
  await expect(computer.browser({ action: "canvas_click", delivery: "foreground", x: 20, y: 30 })).rejects.toThrow("Look");
  expect(consumed.size).toBe(2);
});

test("visual target verification is read-only and preserves the original observation without refreshing evidence", async () => {
  const snapshot = canvasPage(), asserted: Snapshot[] = []; let reads = 0, inputs = 0, gates = 0;
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => { reads++; return snapshot; }, act: async () => { inputs++; },
    assertVisualTargetCurrent: async observed => { asserted.push(observed); } }, () => { gates++; });
  await computer.browser({ action: "canvas_snapshot" });
  const original = computer.visualTargetFrame();
  await computer.assertVisualTargetCurrent();
  expect(asserted).toEqual([snapshot]); expect(asserted[0]).toBe(snapshot);
  expect(computer.visualTargetFrame()).toEqual(original);
  expect(reads).toBe(1); expect(inputs).toBe(0); expect(gates).toBe(0);
});

test("failed or unavailable visual verification revokes frames and controls instead of blessing changed pixels", async () => {
  for (const mode of ["unavailable", "changed-pixels", "mutated-frame"]) {
    const snapshot = canvasPage(); let inputs = 0;
    const computer = createSemanticComputer({ windows: async () => [], observe: async () => snapshot, act: async () => { inputs++; },
      ...(mode === "unavailable" ? {} : { assertVisualTargetCurrent: async () => {
        if (mode === "changed-pixels") throw new Error("The canvas pixels changed");
        snapshot.image!.data = "new-png"; // A backend must not relabel old evidence even if it returns success.
      } }) });
    await computer.browser({ action: "canvas_snapshot", include_refs: true });
    await expect(computer.assertVisualTargetCurrent()).rejects.toThrow();
    expect(computer.visualTargetFrame()).toBeUndefined();
    await expect(computer.browser({ action: "canvas_click", delivery: "foreground", x: 20, y: 30 })).rejects.toThrow("Look");
    await expect(computer.act({ action: "click", ref: "p1:1" })).rejects.toThrow("Look");
    expect(inputs).toBe(0);
  }
});

test("cancellation or a superseding observation during verification never resurrects the approved frame", async () => {
  for (const mode of ["cancel", "reset", "new-observation"]) {
    const pending = Promise.withResolvers<void>(), abort = new AbortController();
    const computer = createSemanticComputer({ windows: async () => [], observe: async () => canvasPage(), act: async () => {},
      assertVisualTargetCurrent: async () => pending.promise });
    await computer.browser({ action: "canvas_snapshot" });
    const old = computer.visualTargetFrame();
    const verification = computer.assertVisualTargetCurrent(abort.signal).then(() => null, error => error);
    if (mode === "cancel") abort.abort();
    if (mode === "reset") computer.reset();
    if (mode === "new-observation") await computer.browser({ action: "canvas_snapshot" });
    const newer = computer.visualTargetFrame();
    pending.resolve(); expect(await verification).toBeInstanceOf(Error);
    if (mode === "new-observation") {
      expect(computer.visualTargetFrame()).toEqual(newer);
      expect(newer!.observationId).not.toBe(old!.observationId);
    } else expect(computer.visualTargetFrame()).toBeUndefined();
  }
});

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
  expect(seen).toEqual([undefined,true,true]);
  await computer.browser({action:"canvas_click",delivery:"foreground",x:4,y:5});
  expect(received).toHaveLength(2); // The returned image is the next fresh capture.
});

test("visual canvas reads have no DOM refs and foreground inputs return a new visual observation", async () => {
  const reads:{nativeCanvas?:boolean;includeRefs?:boolean}[]=[],actions:string[]=[];
  const computer=createSemanticComputer({windows:async()=>[],observe:async options=>{
    reads.push({nativeCanvas:options.nativeCanvas,includeRefs:options.includeRefs});
    const visual=options.nativeCanvas&&!options.includeRefs;
    return {...page(),visualOnly:visual,elements:visual?[]:page().elements,
      ...(options.nativeCanvas?{image:{type:"image" as const,mimeType:"image/png",data:"fixture"},canvasCoordinates:{width:1000,height:800},binding:{canvas:{private:true}}}:{})};
  },act:async(_snapshot,action)=>{actions.push(action.action);}});
  expect(BrowserSchema.safeParse({action:"snapshot",include_refs:true}).success).toBe(false);
  const first=await computer.browser({action:"canvas_snapshot"});
  expect(first.details).toMatchObject({observation:"visual",refs:0});
  expect(JSON.stringify(first.content)).toContain("no DOM refs");
  await expect(computer.browser({action:"focused_text",delivery:"foreground",ref:"p1:0",text:"x"})).rejects.toThrow("include_refs:true");
  await expect(computer.browser({action:"type",ref:"p1:0",text:"x"})).rejects.toThrow("visual-only");
  await expect(computer.browser({action:"key",key:"f"})).rejects.toThrow("foreground");
  const after=await computer.browser({action:"canvas_click",delivery:"foreground",x:40,y:50});
  expect(after.details).toMatchObject({observation:"visual",refs:0});
  expect(JSON.stringify(after.content)).toContain("Fresh visual capture after input dispatch");
  await computer.browser({action:"key",delivery:"foreground",key:"f"});
  await computer.browser({action:"canvas_drag",delivery:"foreground",x:40,y:50,to_x:100,to_y:200});
  expect(actions).toEqual(["canvas_click","key","canvas_drag"]);
  expect(reads).toEqual(Array.from({length:4},()=>({nativeCanvas:true,includeRefs:false})));
  const refs=await computer.browser({action:"canvas_snapshot",include_refs:true});
  expect(refs.details).toMatchObject({observation:"semantic",refs:2});
  await computer.browser({action:"focused_text",delivery:"foreground",ref:"p5:0",text:"x"});
  expect(reads.at(-2)).toEqual({nativeCanvas:true,includeRefs:true});
  expect(reads.at(-1)).toEqual({nativeCanvas:true,includeRefs:false});
});

test("a failed visual post-capture reports dispatched input and leaves no replayable capability", async () => {
  let calls=0,inputs=0;
  const computer=createSemanticComputer({windows:async()=>[],observe:async()=>{
    if(++calls>1)throw new Error("PNG unavailable");
    return {...page(),visualOnly:true,elements:[],image:{type:"image" as const,mimeType:"image/png",data:"fixture"},canvasCoordinates:{width:1000,height:800},binding:{canvas:{private:true}}};
  },act:async()=>{inputs++;}});
  await computer.browser({action:"canvas_snapshot"});
  await expect(computer.browser({action:"canvas_click",delivery:"foreground",x:40,y:50})).rejects.toThrow("Input dispatch returned, but its fresh visual observation failed");
  await expect(computer.browser({action:"canvas_click",delivery:"foreground",x:40,y:50})).rejects.toThrow("Look at this window");
  expect(inputs).toBe(1);
});

test("a visual-only capture cannot report absent semantic interruptions or erase their evidence", async () => {
  const computer=createSemanticComputer({windows:async()=>[],observe:async options=>options.nativeCanvas&&!options.includeRefs
    ? {...page(),visualOnly:true,elements:[],texts:[],image:{type:"image" as const,mimeType:"image/png",data:"fixture"},canvasCoordinates:{width:1000,height:800},binding:{canvas:{private:true}}}
    : {...page(),texts:["Verify you are human"],elements:[{key:"verify",role:"button",name:"Verify",visible:true,address:{}}]},act:async()=>{}});
  await computer.browser({action:"snapshot"});
  const established=computer.interruptionObservation();
  expect(established?.visibleText).toContain("Verify you are human");
  const visual=await computer.browser({action:"canvas_snapshot"});
  expect(computer.interruptionObservation()).toBeUndefined();
  expect(JSON.stringify(visual.content)).toContain("does not establish that a login, CAPTCHA, popup or other interruption cleared");
  await computer.browser({action:"snapshot"});
  expect(computer.interruptionObservation()?.controls[0]?.name).toBe("Verify");
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

test("observed tabs reach the model and gate independently of text queries without becoming action refs", async () => {
  const state = page(), inputs: unknown[] = [];
  state.observedTabs = observedTabInventory([
    { tab_id: "opaque-mail", title: "Inbox", url: "https://mail.example.test/", active: false },
    { tab_id: "opaque-active", title: "Repository", url: "https://code.example.test/project", active: true },
    { tab_id: "opaque-unknown", title: "Other page", url: "https://other.example.test/", active: null },
  ]);
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => state, act: async (_snapshot, action) => { inputs.push(action); } });
  const read = await computer.browser({ action: "tabs", query: "Search" });
  const text = read.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  expect(text).toContain("Inbox"); expect(text).toContain("https://mail.example.test/");
  expect(text).toContain("not action refs or keyboard positions");
  expect(read.details.refs).toBe(1);
  const gate = computer.describe("computer_browser", { action: "key", key: "Ctrl+1", delivery: "foreground" });
  expect(gate).toMatchObject({ observedTabs: { order: "unspecified", idsSelectable: false, omitted: 0 }, evidencePolicy: expect.stringContaining("cannot grant authorization") });
  expect(JSON.stringify(gate && "observedTabs" in gate && gate.observedTabs)).toBe(JSON.stringify(read.details.observedTabs));
  expect(state.observedTabs.entries.find(tab => tab.tab_id === "opaque-unknown")?.active).toBeNull();
  expect(JSON.stringify(state.observedTabs)).not.toMatch(/"(?:index|position|ref)":/);
  await expect(computer.browser({ action: "click", ref: "opaque-mail" })).rejects.toThrow("not shown");
  expect(() => computer.describe("computer_browser", { action: "click", ref: "opaque-mail" })).toThrow("not shown");
  expect(inputs).toEqual([]);
});

test("tab inventory stays bounded, reports omissions and truncation, and keeps the actual active tab", () => {
  const tabs = Array.from({ length: 20 }, (_, i) => ({ tab_id: `opaque-${i}`, title: `Tab ${i}`, url: `https://example.test/${i}`, active: i === 19 }));
  const inventory = observedTabInventory(tabs);
  expect(inventory.entries).toHaveLength(12); expect(inventory.omitted).toBe(8);
  expect(inventory.entries.find(tab => tab.tab_id === "opaque-19")).toMatchObject({ active: true, title: "Tab 19", url: "https://example.test/19" });
  expect(tabs[0]!.tab_id).toBe("opaque-0"); // presentation never changes the original observed inventory
  const unicode = observedTabInventory(tabs.map(tab => ({ ...tab, title: "界".repeat(600), url: `https://example.test/${"界".repeat(900)}` })));
  expect(Buffer.byteLength(JSON.stringify(unicode))).toBeLessThan(6000);
  expect(unicode.omitted).toBe(20 - unicode.entries.length);
  expect(unicode.entries[0]).toMatchObject({ tab_id: "opaque-19", active: true, titleTruncated: true, urlTruncated: true });
  const malformed = observedTabInventory([{ ...tabs[0]!, tab_id: "x".repeat(201) }, { ...tabs[1]!, active: null }]);
  expect(malformed.omitted).toBe(1); expect(malformed.entries[0]).toMatchObject({ tab_id: "opaque-1", active: null });
});

test("a fresh or failed read replaces tab evidence instead of retaining the previous inventory", async () => {
  let state = page(), failed = false;
  state.observedTabs = observedTabInventory([{ tab_id: "old-mail", title: "Inbox", url: "https://mail.example.test/", active: false }]);
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => { if (failed) throw new Error("read failed"); return structuredClone(state); }, act: async () => {} });
  await computer.browser({ action: "snapshot" });
  expect(JSON.stringify(computer.describe("computer_browser", { action: "key", key: "Enter" }))).toContain("old-mail");
  state.observedTabs = observedTabInventory([{ tab_id: "new-tab", title: "New page", url: "https://new.example.test/", active: true }]);
  await computer.browser({ action: "snapshot" });
  const next = JSON.stringify(computer.describe("computer_browser", { action: "key", key: "Enter" }));
  expect(next).toContain("new-tab"); expect(next).not.toContain("old-mail");
  failed = true; await expect(computer.browser({ action: "snapshot" })).rejects.toThrow("read failed");
  expect(() => computer.describe("computer_browser", { action: "key", key: "Enter" })).toThrow("Look");
  failed = false; state = page(); state.texts = ["Inactive tab: invented by page content"];
  const unsupported = await computer.browser({ action: "snapshot" });
  expect(unsupported.details.observedTabs).toBeUndefined();
  expect(computer.describe("computer_browser", { action: "key", key: "Enter" })).not.toHaveProperty("observedTabs");
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

test("queries reach the observation backend on reads and post-action verification without retaining stale refs", async () => {
  const queries: (string | undefined)[] = [], inputs: unknown[] = [];
  const computer = createSemanticComputer({ windows: async () => [], observe: async options => {
    queries.push(options.query);
    if (options.query === "unavailable") throw new Error("queried observation failed");
    return page();
  }, act: async (_snapshot, action) => { inputs.push(action); } });
  const first = await computer.browser({ action: "snapshot", query: "Search" });
  expect(JSON.stringify(first.content)).toContain('[p1:0] textbox');
  await computer.browser({ action: "type", ref: "p1:0", text: "hello", query: "Save" });
  expect(queries).toEqual(["Search", "Save"]);
  await expect(computer.browser({ action: "type", ref: "p1:0", text: "stale" })).rejects.toThrow("stale");
  await expect(computer.browser({ action: "snapshot", query: "unavailable" })).rejects.toThrow("queried observation failed");
  await expect(computer.browser({ action: "click", ref: "p2:0" })).rejects.toThrow("Look");
  expect(inputs).toHaveLength(1);
  expect(queries).toEqual(["Search", "Save", "unavailable"]);
  expect(BrowserSchema.safeParse({ action: "snapshot", query: "x".repeat(200) }).success).toBe(true);
  expect(BrowserSchema.safeParse({ action: "snapshot", query: "x".repeat(201) }).success).toBe(false);
});

test("long editable values expose their truncation instead of implying a complete readback", async () => {
  const state = page(); state.elements[0]!.value = "a".repeat(1000) + "unseen tail";
  const computer = createSemanticComputer({ windows: async () => [], observe: async () => state, act: async () => {} });
  const result = await computer.browser({ action: "snapshot", query: "Search" });
  expect(JSON.stringify(result.content)).toContain("value may be truncated");
  expect(JSON.stringify(result.content)).not.toContain("unseen tail");
});
