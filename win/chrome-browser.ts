/** Direct signed-in Chrome control. No Cua calls or grants are used here. */
import { connectChromeCdp, type ChromeCdp } from "./chrome-cdp";
import { discoverChromeEndpoint, ownsChromeEndpoint, sameChromeOwner, type ChromeEndpoint } from "./chrome-endpoint";
import type { NativeChromeMetadata } from "./chrome-native";
import { collectorFunction, verifierFunction, verifyFocusFunction, type ChromeObservation } from "./chrome-observation";
import { keyEvent, type ExistingBrowserInput, type ExistingBrowserSnapshot, type ExistingBrowserWindow, type ExistingCanvas, type ExistingDialog, type ExistingBrowserActivity } from "./browser";

type Tab = { targetId: string; type: string; title: string; url: string };
type Bounds = { left?: number; top?: number; width?: number; height?: number; windowState?: string };
type Frame = { id: string; loaderId: string; url: string };
type Binding = { window: ExistingBrowserWindow; native: NativeChromeMetadata; windowId: number; tab: Tab; tabs: ExistingBrowserSnapshot["tabs"]; session: string; frame: Frame; context: number };
type Evidence = { page: ExistingBrowserSnapshot; binding: Binding; observation: ChromeObservation };
type Verification = { ok: boolean; reason?: string; token: string; center: {x:number;y:number}; focused: boolean; editable: boolean };
type Action = Parameters<ExistingBrowserInput["act"]>[1];
export type DirectChromeOptions = {
  current(): Promise<ExistingBrowserWindow>;
  probe(window: ExistingBrowserWindow, signal?: AbortSignal): Promise<NativeChromeMetadata>;
  discover?: typeof discoverChromeEndpoint;
  connect?: typeof connectChromeCdp;
};
const sameWindow = (a: ExistingBrowserWindow, b: ExistingBrowserWindow) => a.pid === b.pid && a.containerId === b.containerId && a.ownerNonce === b.ownerNonce;
const equalRect = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);
const titleOf = (title: string) => title.replace(/ - (?:Google Chrome|Chromium)$/u, "");
/** Native GetWindowRect is physical; Chrome exposes DIP coordinates. Refuse ambiguous windows. */
export function chromeBoundsMatch(native: NativeChromeMetadata, bounds: Bounds): boolean {
  if (native.iconic || bounds.windowState === "minimized") return false;
  const rect = [bounds.left, bounds.top, bounds.width, bounds.height];
  if (!rect.every(n => typeof n === "number" && Number.isFinite(n)) || Number(bounds.width) < 100 || Number(bounds.height) < 100) return false;
  return [1, native.dpiScale].some(scale => native.outerRect.every((n, i) => Math.abs(n / scale - Number(rect[i])) <= 2));
}
function validNavigation(value: string | undefined): string {
  const url = new URL(value ?? "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser navigation requires an http(s) URL without credentials.");
  return url.href;
}
function pageKeys(value: string | undefined) {
  const keys = (value ?? "").toLowerCase().split("+").map(k => k.trim()).filter(Boolean);
  if (!keys.length || keys.some(k => ["alt", "meta", "win", "cmd"].includes(k))
    || keys.some(k => /^f\d+$/.test(k)) || keys.includes("ctrl") && !["a", "c", "v", "x", "z", "y", "enter", "home", "end"].includes(keys.at(-1)!)) {
    throw new Error("Direct Chrome supports page editing keys. Use an explicit URL for navigation; browser toolbar shortcuts are unavailable.");
  }
  return keyEvent(keys);
}

export function directChromeBrowser(options: DirectChromeOptions): ExistingBrowserInput {
  let connection: ChromeCdp | undefined, endpoint: ChromeEndpoint | undefined, owner: NativeChromeMetadata | undefined;
  let closed = false, ready = false, busy = false, sequence = 0, generation = 0;
  let activity: ExistingBrowserActivity = {};
  let binding: Binding | undefined, evidence: Evidence | undefined, canvas: ExistingCanvas | undefined, activeSession: string | undefined;
  let dialog: { id: string; kind: "alert"|"confirm"|"prompt"|"beforeunload"|"other"; session: string } | undefined;
  let inspected: ExistingDialog | undefined;
  let pendingAck: Promise<unknown> | undefined;
  let deferredRelease: {binding:Binding;method:string;params:Record<string,unknown>} | undefined;
  const dialogWaiters = new Set<()=>void>();
  const invalidate = () => { evidence = undefined; canvas = undefined; inspected = undefined; generation++; };
  function requireConnection(): ChromeCdp {
    if (closed || !connection?.isOpen()) { invalidate(); throw new Error("The direct Chrome connection is unavailable. Attach this same window again; no input was retried."); }
    return connection;
  }
  const call = <T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal, sessionId?: string) => {
    signal?.throwIfAborted(); return requireConnection().call<T>(method, params, { signal, sessionId });
  };
  const run = async <T>(phase: NonNullable<ExistingBrowserActivity["active"]>["phase"], work: () => Promise<T>): Promise<T> => {
    if (busy) throw new Error("A direct Chrome operation is already in progress.");
    busy = true; const id = ++sequence, start = performance.now(); activity.active = { phase, sequence: id, startedAt: Date.now() };
    let outcome: "ok"|"failed" = "failed";
    try { const result = await work(); outcome = "ok"; return result; }
    catch (error) { invalidate(); throw error; }
    finally { busy = false; activity = { last: { phase, sequence: id, durationMs: Math.round(performance.now()-start), outcome } }; }
  };
  async function native(signal?: AbortSignal, expected?: Binding) {
    signal?.throwIfAborted();
    const window = await options.current(); signal?.throwIfAborted();
    const meta = await options.probe(window, signal); signal?.throwIfAborted();
    if (meta.window_id !== window.containerId || meta.pid !== window.pid || meta.ownerNonce !== window.ownerNonce || meta.title !== window.title
      || meta.iconic || meta.outerRect[2] < 100 || meta.outerRect[3] < 100) { ready=false; throw new Error("The selected Chrome window is unavailable or minimized. Restore and attach that same window."); }
    if (owner && !sameChromeOwner(owner, meta) || endpoint && !ownsChromeEndpoint(meta, endpoint)) {
      ready=false; connection?.close(); throw new Error("The selected Chrome process or debugging endpoint changed. Attach again.");
    }
    if (expected && (!sameWindow(window, expected.window) || window.title !== expected.window.title || !equalRect(window.rect, expected.window.rect)
      || !equalRect(meta.outerRect, expected.native.outerRect) || meta.dpiScale !== expected.native.dpiScale)) throw new Error("The selected Chrome window changed after observation. Look again.");
    return { window, meta };
  }
  async function functionValue<T>(b: Binding, declaration: string, argument: unknown, signal?: AbortSignal): Promise<T> {
    const reply = await call<{ result?: { value?: T }; exceptionDetails?: unknown }>("Runtime.callFunctionOn", {
      functionDeclaration: declaration, executionContextId: b.context, arguments: [{ value: argument }], returnByValue: true, awaitPromise: false,
    }, signal, b.session);
    if (reply.exceptionDetails || reply.result?.value === undefined) throw new Error("Chrome could not inspect this document. Take a fresh observation.");
    return reply.result.value;
  }
  async function attest(b: Binding, signal?: AbortSignal) {
    await native(signal, b);
    const [window, target, frame] = await Promise.all([
      call<{windowId:number;bounds:Bounds}>("Browser.getWindowForTarget", { targetId: b.tab.targetId }, signal),
      call<{targetInfo:Tab}>("Target.getTargetInfo", { targetId:b.tab.targetId }, signal),
      call<{frameTree:{frame:Frame}}>("Page.getFrameTree", {}, signal, b.session),
    ]);
    if (window.windowId !== b.windowId || !chromeBoundsMatch(b.native, window.bounds) || target.targetInfo.targetId !== b.tab.targetId || target.targetInfo.type !== "page" || target.targetInfo.title !== b.tab.title
      || target.targetInfo.url !== b.tab.url || frame.frameTree.frame.id !== b.frame.id || frame.frameTree.frame.loaderId !== b.frame.loaderId) {
      throw new Error("The active Chrome document changed after observation. Look again.");
    }
    signal?.throwIfAborted();
  }
  async function bind(signal?: AbortSignal): Promise<Binding> {
    ready=false;
    const {window, meta} = await native(signal);
    const result = await call<{targetInfos:Tab[]}>("Target.getTargets", {}, signal);
    const tabs = result.targetInfos.filter(t => t.type === "page" && !t.url.startsWith("devtools://"));
    if (!tabs.length || tabs.length > 256) throw new Error("Chrome has no usable page, or exceeds the bounded tab limit.");
    const windows: {tab:Tab;windowId:number;bounds:Bounds}[] = [];
    for (let i=0;i<tabs.length;i+=16) {
      const batch = await Promise.all(tabs.slice(i,i+16).map(async tab => ({tab,...await call<{windowId:number;bounds:Bounds}>("Browser.getWindowForTarget", {targetId:tab.targetId}, signal)})));
      windows.push(...batch);
    }
    const matches = windows.filter(w => chromeBoundsMatch(meta,w.bounds));
    if (new Set(matches.map(w=>w.windowId)).size !== 1) throw new Error("Chrome's windows have ambiguous geometry. Move the selected Chrome window slightly, then attach again.");
    const active = matches.filter(w => w.tab.title === titleOf(window.title));
    if (active.length !== 1) throw new Error("The selected Chrome tab cannot be uniquely matched. Select a tab with a unique title and observe again.");
    const selected = active[0]!;
    let session: string;
    if (binding?.tab.targetId === selected.tab.targetId) session = binding.session;
    else {
      if (binding) await call("Target.detachFromTarget", {sessionId:binding.session},signal);
      binding = undefined; dialog = undefined;
      session = (await call<{sessionId:string}>("Target.attachToTarget", {targetId:selected.tab.targetId,flatten:true},signal)).sessionId;
      activeSession = session;
      await call("Page.enable", {}, signal, session);
    }
    const frame = (await call<{frameTree:{frame:Frame}}>("Page.getFrameTree", {}, signal, session)).frameTree.frame;
    if (!frame.id || !frame.loaderId) throw new Error("Chrome's active document is not ready. Observe again after it loads.");
    const context = (await call<{executionContextId:number}>("Page.createIsolatedWorld", {frameId:frame.id,worldName:"hands-direct-observation"},signal,session)).executionContextId;
    const b: Binding = {window,native:meta,windowId:selected.windowId,tab:selected.tab,session,frame,context,
      tabs:matches.map(w=>({tab_id:w.tab.targetId,title:w.tab.title,url:w.tab.url,active:w.tab.targetId===selected.tab.targetId}))};
    await native(signal,b); binding = b; ready=true; return b;
  }
  async function snapshot(signal?: AbortSignal): Promise<ExistingBrowserSnapshot> {
    if(Boolean(dialog))throw new Error("Chrome has a page dialog. Inspect and resolve that dialog before reading the page.");
    invalidate(); const b = await bind(signal), nonce = crypto.randomUUID();
    if(dialog?.session===b.session)throw new Error("Chrome has a page dialog. Inspect and resolve that dialog before reading the page.");
    const observation = await functionValue<ChromeObservation>(b,collectorFunction,{nonce},signal);
    const sameUrl = observation.document.url === b.tab.url || ["chrome://newtab/", "chrome://new-tab-page/"].includes(observation.document.url) && ["chrome://newtab/", "chrome://new-tab-page/"].includes(b.tab.url);
    if (observation.nonce !== nonce || observation.document.visibility !== "visible" || observation.document.title !== b.tab.title || !sameUrl || observation.document.titleTruncated || observation.document.urlTruncated) throw new Error("The Chrome tab changed while reading it. Observe again.");
    await attest(b,signal);
    const page: ExistingBrowserSnapshot = {target_id:`chrome:${b.windowId}`,tab_id:b.tab.targetId,title:b.tab.title,url:b.tab.url,tabs:b.tabs,snapshot_id:nonce,window:b.window,
      refs:observation.elements.map(e=>({ref:e.ref,role:e.role,name:e.name,value:e.value,visibility:"in_viewport",actions:e.actions,
        states:{focused:e.focused,protected:e.protected,value_truncated:e.valueTruncated}})),
      content:observation.texts.map(text=>({role:"text",name:text})),outline:"Direct Chrome connection. References cover visible controls in the main document; embedded frames require visual inspection.",
      coverage:{complete:false,selectedNodes:observation.elements.length,totalNodes:observation.coverage.scannedControls,
        omitted:{unprovable_frame:observation.coverage.framesOmitted,...(observation.coverage.elementsTruncated?{budget:1}:{})},continuation:"not-needed"}};
    evidence = {page,binding:b,observation}; return page;
  }
  async function verify(b: Binding, argument: unknown, signal?: AbortSignal, focus = false) {
    const result = await functionValue<Verification>(b,focus?verifyFocusFunction:verifierFunction,argument,signal);
    if (!result.ok || !Number.isFinite(result.center?.x) || !Number.isFinite(result.center?.y)) throw new Error(`Chrome input was not sent: ${result.reason ?? "the reference is stale"}. Observe again.`);
    return result;
  }
  async function input(b: Binding, method: string, params: Record<string,unknown>, signal: AbortSignal|undefined, before:()=>void, finalProof?:()=>Promise<unknown>) {
    if(dialog || pendingAck)throw new Error("Resolve the current Chrome dialog before further input; the earlier action will not be replayed.");
    const revision=generation;
    before(); signal?.throwIfAborted(); await attest(b,signal);
    if(finalProof)await finalProof();
    else {
      const visible=await functionValue<boolean>(b,"function(){return document.visibilityState === 'visible'}",{},signal);
      if(!visible)throw new Error("The Chrome tab is no longer visible. Observe again.");
    }
    before(); signal?.throwIfAborted();
    if(revision!==generation)throw new Error("The Chrome document changed while preparing input. Observe again.");
    return acknowledge(b,method,params,signal);
  }
  /** Chrome can hold a click/key reply until its synchronous alert is handled.
   * Keep that exact request pending, but release the public operation for the
   * dialog tools. Resolving it drains the original reply; it never repeats input. */
  async function acknowledge(b:Binding,method:string,params:Record<string,unknown>,signal?:AbortSignal) {
    let notify!:()=>void;
    const opened=new Promise<{dialog:true}>(resolve=>{notify=()=>resolve({dialog:true});dialogWaiters.add(notify);});
    const request=requireConnection().call(method,params,{signal,sessionId:b.session,timeoutMs:60000});
    const finished=request.then(value=>({dialog:false as const,value}));
    try {
      const outcome=await Promise.race([finished,opened]);
      if(!outcome.dialog)return outcome.value;
      pendingAck=request;
      // A timeout still closes the transport. Retain the rejected promise for
      // resolveDialog, while attaching a handler immediately avoids rejection noise.
      void request.catch(()=>{});
      return undefined;
    } finally {dialogWaiters.delete(notify);}
  }
  async function release(b:Binding,method:string,params:Record<string,unknown>) {
    if(dialog||pendingAck){deferredRelease={binding:b,method,params};return;}
    await acknowledge(b,method,params);
  }
  async function drainDialogInput() {
    if(dialog)return;
    const outstanding=pendingAck;
    if(outstanding){
      let notify!:()=>void;
      const opened=new Promise<false>(resolve=>{notify=()=>resolve(false);dialogWaiters.add(notify);});
      try {
        const settled=await Promise.race([outstanding.then(()=>true),opened]);
        if(!settled)return; // A nested popup still owns the original response.
        if(pendingAck===outstanding)pendingAck=undefined;
      } finally {dialogWaiters.delete(notify);}
    }
    if(deferredRelease&&!dialog){const cleanup=deferredRelease;deferredRelease=undefined;await release(cleanup.binding,cleanup.method,cleanup.params);}
  }
  async function click(b:Binding, center:{x:number;y:number},signal:AbortSignal|undefined,before:()=>void,finalProof?:()=>Promise<unknown>) {
    await input(b,"Input.dispatchMouseEvent",{type:"mousePressed",...center,button:"left",clickCount:1},signal,before,finalProof);
    // Release is cleanup of this exact press, even if the task was interrupted.
    await release(b,"Input.dispatchMouseEvent",{type:"mouseReleased",...center,button:"left",clickCount:1});
  }
  async function key(b:Binding,event:ReturnType<typeof keyEvent>,signal:AbortSignal|undefined,before:()=>void,finalProof?:()=>Promise<unknown>) {
    await input(b,"Input.dispatchKeyEvent",{type:event.text?"keyDown":"rawKeyDown",...event},signal,before,finalProof);
    await release(b,"Input.dispatchKeyEvent",{type:"keyUp",...event,text:undefined,commands:undefined});
  }
  async function act(page:ExistingBrowserSnapshot, action:Action, reference?:string, signal?:AbortSignal,before=()=>{}) {
    const e = evidence;
    if (!e || e.page !== page) throw new Error("This Chrome observation has expired. Observe again.");
    invalidate(); before(); signal?.throwIfAborted(); await attest(e.binding,signal); before();
    const actionName = action.action === "set_value" ? "type" : action.action;
    if (actionName === "navigate") {
      const url = validNavigation(action.url);
      const granted=await verify(e.binding,{nonce:e.observation.nonce,action:"scroll"},signal);
      const proof=()=>verify(e.binding,{nonce:e.observation.nonce,token:granted.token,checkFocus:false},signal,true);
      const result = await input(e.binding,"Page.navigate",{url},signal,before,proof) as {errorText?:string};
      if(result?.errorText)throw new Error(`Chrome navigation failed: ${result.errorText}`); return;
    }
    if (!["click","type","key","scroll"].includes(actionName)) throw new Error(`Unsupported direct Chrome action: ${actionName}`);
    const field = e.observation.elements.find(element=>element.ref===reference);
    if (actionName === "key" && !reference) reference = e.observation.elements.find(element=>element.focused)?.ref;
    if (actionName !== "scroll" && !reference) throw new Error("This action needs a current visible Chrome reference.");
    if (actionName === "type" && (typeof action.text !== "string" || action.text.length > 8000)) throw new Error("Chrome typing requires text of at most 8000 characters.");
    const event = actionName === "key" ? pageKeys(action.key) : undefined;
    const verified = await verify(e.binding,{nonce:e.observation.nonce,ref:reference,action:actionName},signal);
    const proof=(checkFocus=false)=>()=>verify(e.binding,{nonce:e.observation.nonce,ref:reference,token:verified.token,checkFocus},signal,true);
    before(); signal?.throwIfAborted();
    if (actionName === "click") await click(e.binding,verified.center,signal,before,proof());
    else if (actionName === "scroll") await input(e.binding,"Input.dispatchMouseEvent",{type:"mouseWheel",...verified.center,deltaX:0,
      deltaY:(action.direction==="up"?-1:1)*Math.min(30,Math.max(1,action.amount??6))*40},signal,before,proof());
    else {
      if (!verified.focused) await click(e.binding,verified.center,signal,before,proof());
      await verify(e.binding,{nonce:e.observation.nonce,ref:reference,token:verified.token},signal,true);
      if (actionName === "type") {
        if (!field?.editable || field.protected) throw new Error("The captured Chrome field is not editable.");
        if (action.replace !== false) await key(e.binding,keyEvent(["ctrl","a"]),signal,before,proof(true));
        // Recheck focus and form values after selection, immediately before insertion.
        await verify(e.binding,{nonce:e.observation.nonce,ref:reference,token:verified.token},signal,true);
        await input(e.binding,"Input.insertText",{text:action.text!},signal,before,proof(true));
      } else await key(e.binding,event!,signal,before,proof(true));
    }
    signal?.throwIfAborted(); before();
  }
  async function capture(b:Binding,page:ExistingBrowserSnapshot|undefined,signal?:AbortSignal):Promise<ExistingCanvas> {
    await attest(b,signal);
    const result = await call<{data:string}>("Page.captureScreenshot",{format:"png",captureBeyondViewport:false},signal,b.session);
    const png = Buffer.from(result.data,"base64");
    if (png.length<24 || png.toString("hex",0,8)!=="89504e470d0a1a0a") throw new Error("Chrome returned an invalid preview.");
    const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
    await attest(b,signal);
    return {binding:{target_id:`chrome:${b.windowId}`,tab:{tab_id:b.tab.targetId,title:b.tab.title,url:b.tab.url,active:true},tabs:b.tabs,window:b.window},generation,page,window:b.window,width,height,
      image:{type:"image",mimeType:"image/png",data:result.data},digest:Bun.hash(result.data).toString(16)};
  }
  async function assertCanvas(c:ExistingCanvas,signal?:AbortSignal) {
    if(canvas!==c || !binding || c.generation!==generation) throw new Error("This Chrome image is stale. Capture it again.");
    const fresh = await capture(binding,c.page,signal);
    if (fresh.digest!==c.digest || fresh.width!==c.width || fresh.height!==c.height) throw new Error("The Chrome pixels changed after approval. Capture again before input.");
  }
  const api: ExistingBrowserInput = {
    healthy:()=>!closed&&ready&&!!connection?.isOpen(), activity:()=>({...activity}),
    attach:(signal, settings)=>run("bind_rpc",async()=>{
      if(closed)throw new Error("This direct Chrome connection has ended.");
      if(settings?.allowPrepare===false)throw new Error("Attach the selected Chrome window to establish its direct connection. Startup does not request browser permission.");
      connection?.close(); connection=undefined; binding=undefined; activeSession=undefined; owner=undefined; endpoint=undefined; dialog=undefined; ready=false; pendingAck=undefined; deferredRelease=undefined;
      invalidate(); const {meta}=await native(signal); owner=meta;
      endpoint=await (options.discover??discoverChromeEndpoint)(meta,signal);
      await native(signal); connection=await (options.connect??connectChromeCdp)(endpoint.url,{signal,timeoutMs:60000});
      connection.onEvent(event=>{
        if(event.method==="Target.detachedFromTarget"&&event.params.sessionId===activeSession){ready=false;invalidate();binding=undefined;activeSession=undefined;return;}
        if(event.sessionId!==activeSession)return;
        if(event.method==="Inspector.detached"){ready=false;invalidate();return;}
        if(event.method==="Page.javascriptDialogOpening") { invalidate(); const kind=String(event.params.type);dialog={id:crypto.randomUUID(),kind:["alert","confirm","prompt","beforeunload"].includes(kind)?kind as "alert":"other",session:event.sessionId!}; for(const notify of dialogWaiters)notify(); }
        if(event.method==="Page.javascriptDialogClosed") {invalidate();dialog=undefined;void Promise.resolve().then(drainDialogInput).catch(()=>{ready=false;connection?.close();});}
        if(event.method==="Page.frameNavigated" && !(event.params.frame as {parentId?:string}|undefined)?.parentId) invalidate();
      });
      try {await bind(signal);} catch(error){connection.close();throw error;}
    }),
    snapshot:(signal)=>run("snapshot_rpc",()=>snapshot(signal)),
    act:(page,action,reference,signal,before)=>run("action_rpc",()=>act(page,action,reference,signal,before)),
    navigate:(url,signal)=>run("action_rpc",async()=>{const page=await snapshot(signal);await act(page,{action:"navigate",url},undefined,signal);return true;}),
    captureCanvas:(page,signal)=>run("capture_rpc",async()=>{if(evidence?.page!==page)throw new Error("Observe Chrome before capture.");const captured=await capture(evidence.binding,page,signal);canvas=captured;return captured as ExistingCanvas & {page:ExistingBrowserSnapshot};}),
    captureVisual:(signal)=>run("capture_rpc",async()=>{invalidate();const b=await bind(signal);canvas=await capture(b,undefined,signal);return canvas;}),
    assertCanvasCurrent:(c,signal)=>run("capture_rpc",()=>assertCanvas(c,signal)),
    canvasAct:(c,action,reference,signal,before=()=>{})=>run("action_rpc",async()=>{
      await assertCanvas(c,signal); const b=binding!;
      if(action.action==="focused_text" && c.page) {await act(c.page,{...action,action:"type",replace:false},reference,signal,before);return;}
      if(action.action!=="canvas_click" && action.action!=="canvas_drag")throw new Error("Direct canvas input supports clicks and drags. Use a semantic reference for keyboard input.");
      const metrics=await call<{cssVisualViewport:{clientWidth:number;clientHeight:number}}>("Page.getLayoutMetrics",{},signal,b.session);
      const point=(x:number|undefined,y:number|undefined)=>{if(!Number.isInteger(x)||!Number.isInteger(y)||x!<0||y!<0||x!>=c.width||y!>=c.height)throw new Error("Choose a point within the Chrome viewport screenshot.");return {x:x!*metrics.cssVisualViewport.clientWidth/c.width,y:y!*metrics.cssVisualViewport.clientHeight/c.height};};
      const from=point(action.x,action.y),to=action.action==="canvas_drag"?point(action.to_x,action.to_y):from;
      await attest(b,signal);before();signal?.throwIfAborted();invalidate();
      const pixelsUnchanged=async()=>{
        const shot=await call<{data:string}>("Page.captureScreenshot",{format:"png",captureBeyondViewport:false},signal,b.session);
        if(shot.data!==c.image.data)throw new Error("The Chrome pixels changed immediately before input. Capture again.");
      };
      if(action.action==="canvas_click"){await click(b,from,signal,before,pixelsUnchanged);return;}
      await input(b,"Input.dispatchMouseEvent",{type:"mousePressed",...from,button:"left",buttons:1,clickCount:1},signal,before,pixelsUnchanged);
      try {for(let n=1;n<=12;n++)await input(b,"Input.dispatchMouseEvent",{type:"mouseMoved",x:from.x+(to.x-from.x)*n/12,y:from.y+(to.y-from.y)*n/12,button:"left",buttons:1},signal,before);}
      finally {await release(b,"Input.dispatchMouseEvent",{type:"mouseReleased",...to,button:"left",clickCount:1});}
    }),
    inspectDialog:(signal)=>run("snapshot_rpc",async()=>{
      invalidate(); const b=binding??await bind(signal);await native(signal,b);
      const base={target_id:`chrome:${b.windowId}`,tab_id:b.tab.targetId,title:b.tab.title,url:b.tab.url,window:b.window};
      inspected=dialog&&dialog.session===b.session?{...base,present:true,dialog_id:dialog.id,kind:dialog.kind}:{...base,present:false};return inspected;
    }),
    resolveDialog:(observed,operation,id,signal,before=()=>{})=>run("action_rpc",async()=>{
      if(observed!==inspected||!observed.present||dialog?.id!==id||!binding||dialog.session!==binding.session)throw new Error("Inspect the current Chrome dialog before resolving it.");
      const b=binding;before();await native(signal,b);if(dialog?.id!==id)throw new Error("The Chrome dialog changed.");invalidate();
      const [target,window]=await Promise.all([call<{targetInfo:Tab}>("Target.getTargetInfo",{targetId:b.tab.targetId},signal),
        call<{windowId:number;bounds:Bounds}>("Browser.getWindowForTarget",{targetId:b.tab.targetId},signal)]);
      if(dialog?.id!==id||target.targetInfo.targetId!==b.tab.targetId||target.targetInfo.title!==b.tab.title||target.targetInfo.url!==b.tab.url
        ||window.windowId!==b.windowId||!chromeBoundsMatch(b.native,window.bounds))throw new Error("The Chrome dialog target changed.");
      before();signal?.throwIfAborted();
      // JavaScript is paused by this dialog. Never evaluate a DOM verifier here.
      await call("Page.handleJavaScriptDialog",{accept:operation==="accept"},signal,b.session);
      await drainDialogInput();
    }),
    close:async()=>{closed=true;invalidate();connection?.close();},
  };
  return api;
}
