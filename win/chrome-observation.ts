/** Fixed, read-only functions for a dedicated CDP isolated execution context.
 * The caller MUST verify the context is non-default and belongs to its exact
 * frame/document. Never evaluate these in the page's main world. Returned refs
 * index real Element objects held only in that isolated world, never DOM IDs,
 * attributes, selectors or page-authored object properties. Input stays in CDP
 * Input.*; this module never focuses, clicks, scrolls or changes page values.
 */
export type ChromeAction = "click" | "type" | "key" | "scroll";
export type ChromeRect = { x: number; y: number; width: number; height: number };
export type ChromePoint = { x: number; y: number };
export type ChromeDocument = {
  url: string; urlTruncated: boolean; title: string; titleTruncated: boolean;
  visibility: "visible" | "hidden"; hasFocus: boolean;
  viewport: { width: number; height: number; devicePixelRatio: number; scale: number; offsetLeft: number; offsetTop: number };
  scroll: { x: number; y: number }; coordinateSpace: "css-viewport";
};
export type ChromeObservedElement = {
  ref: string; role: string; name: string; nameTruncated: boolean; within: string;
  rect: ChromeRect; center: ChromePoint; focused: boolean; editable: boolean;
  type: string; protected: boolean; value?: string; valueTruncated: boolean;
  actions: ChromeAction[];
};
export type ChromeObservation = {
  nonce: string; document: ChromeDocument; elements: ChromeObservedElement[]; texts: string[];
  coverage: { elementsTruncated: boolean; textsTruncated: boolean; scannedControls: number;
    returnedNodes: number; framesOmitted: number; shadowDOM: "not-traversed"; hiddenDocument: boolean };
};
export type ChromeVerifyRequest = { nonce: string; ref?: string; action: ChromeAction };
export type ChromeFocusRequest = { nonce: string; ref?: string; token: string; checkFocus?: boolean };
export type ChromeVerification = { ok: false; reason: string } | {
  ok: true; nonce: string; ref?: string; token: string; document: ChromeDocument;
  center: ChromePoint; focused: boolean; editable: boolean;
};

// Keep all browser-side dependencies inside this function. Bun removes these
// TypeScript annotations before toString(); no host closure is serialized.
function collectChromeObservation(input: { nonce: string }): ChromeObservation {
  const w = globalThis as any, d = w.document;
  const key = Symbol.for("hands.chrome.observation.v1");
  const previous = w[key];
  if (!input || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(input.nonce)) throw Error("A fresh observation UUID is required.");
  if (previous?.nonce === input.nonce) throw Error("An observation nonce cannot be reused.");
  if (previous) previous.used = true;
  const state: any = { nonce: input.nonce, used: false };
  Object.defineProperty(w, key, { value: state, configurable: true });
  const docRoot = d.documentElement, MAX_CONTROLS = 6000, MAX_OUTPUT = 600, MAX_BYTES = 190000;
  const fieldsSelector = 'input:not([type="hidden"]),textarea,select,[contenteditable]:not([contenteditable="false"])';
  const controlsSelector = 'input:not([type="hidden"]),textarea,select,button,a[href],summary,[role],[contenteditable]:not([contenteditable="false"]),[tabindex]';
  const clip = (text: unknown, limit: number) => String(text ?? "").slice(0, limit);
  const compact = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const parent = (e: any) => e.parentElement; // Shadow DOM/child frames deliberately have no fabricated refs.
  const visible = (e: any) => {
    if (!e?.isConnected || e.ownerDocument !== d || e.getRootNode() !== d) return false;
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= w.innerWidth || r.top >= w.innerHeight) return false;
    let p = e, depth = 0;
    for (; p && depth < 80; p = parent(p), depth++) {
      const s = w.getComputedStyle(p);
      if (p.hidden || p.inert || p.getAttribute("aria-hidden") === "true" || s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" || Number(s.opacity) === 0 || s.contentVisibility === "hidden") return false;
    }
    return !p;
  };
  const point = (e: any, rects = e.getClientRects()): ChromePoint | null => {
    if (!visible(e)) return null;
    for (const r of Array.from(rects).slice(0, 12) as any[]) {
      const left = Math.max(0, r.left), right = Math.min(w.innerWidth, r.right), top = Math.max(0, r.top), bottom = Math.min(w.innerHeight, r.bottom);
      if (right <= left || bottom <= top) continue;
      const p = { x: (left + right) / 2, y: (top + bottom) / 2 }, hit = d.elementFromPoint(p.x, p.y);
      if (hit && (hit === e || e.contains(hit))) return p;
    }
    return null;
  };
  const protectedField = (e: any) => e.tagName === "INPUT" && (e.type === "password" || /^(?:current|new)-password$/i.test(e.autocomplete || ""));
  const disabled = (e: any) => e.matches(":disabled") || e.getAttribute("aria-disabled") === "true" || Boolean(e.closest('[aria-disabled="true"], [inert]'));
  const editable = (e: any) => !protectedField(e) && !disabled(e) && !e.readOnly && e.getAttribute("aria-readonly") !== "true"
    && (e.tagName === "TEXTAREA" || e.tagName === "INPUT" && /^(text|search|email|url|tel|number)$/.test(e.type)
      || e.isContentEditable && !e.parentElement?.isContentEditable);
  const fieldValue = (e: any): string | undefined => {
    if (protectedField(e)) return undefined;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.tagName)) return String(e.value ?? "");
    if (e.isContentEditable) return String(e.innerText ?? "");
    return undefined;
  };
  const nameOf = (e: any): string => {
    const ids = String(e.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).slice(0, 12);
    if (ids.length) { const name = ids.map((id: string) => d.getElementById(id)?.textContent || "").join(" "); if (compact(name)) return compact(name); }
    const aria = e.getAttribute("aria-label"); if (aria) return compact(aria);
    if (e.labels?.length) return compact(Array.from(e.labels).slice(0, 12).map((label: any) => label.textContent || "").join(" "));
    if (e.tagName === "INPUT" && /^(button|submit|reset)$/.test(e.type)) return compact(e.value);
    if (e.tagName === "INPUT" || e.tagName === "TEXTAREA") return compact(e.getAttribute("placeholder") || e.getAttribute("title") || e.getAttribute("name") || "");
    if (e.isContentEditable) return compact(e.getAttribute("data-placeholder") || e.getAttribute("title") || "");
    if (e.tagName === "SELECT") return compact(e.getAttribute("title") || e.getAttribute("name") || "");
    if (e.matches('dialog,[role="dialog"],[role="alertdialog"],[role="form"]')) return compact(e.getAttribute("title") || "");
    return compact(e.innerText || e.getAttribute("title") || e.getAttribute("alt") || "");
  };
  const roleOf = (e: any) => {
    const explicit = e.getAttribute("role")?.split(/\s+/)[0]; if (explicit) return clip(explicit, 60);
    if (editable(e) || protectedField(e)) return "textbox";
    if (e.tagName === "INPUT") return /^(checkbox|radio|range)$/.test(e.type) ? e.type === "range" ? "slider" : e.type : /^(submit|reset|button|image)$/.test(e.type) ? "button" : "input";
    return ({ BUTTON: "button", A: "link", SELECT: "combobox", SUMMARY: "button", DIALOG: "dialog", TEXTAREA: "textbox" } as Record<string, string>)[e.tagName] || "generic";
  };
  const containerOf = (e: any) => e.form || e.closest('form,dialog,[role="dialog"],[role="alertdialog"],[role="form"]') || d.body || docRoot;
  const withinOf = (e: any) => { const scope = containerOf(e); return scope === d.body || scope === docRoot ? "" : compact(scope.getAttribute("aria-label") || scope.getAttribute("title") || nameOf(scope)); };
  const metadata = (e: any) => {
    const r = e.getBoundingClientRect();
    return { role: roleOf(e), name: nameOf(e), within: withinOf(e), type: e.tagName === "INPUT" ? String(e.type) : e.isContentEditable ? "contenteditable" : e.tagName.toLowerCase(),
      protected: protectedField(e), editable: editable(e), disabled: disabled(e), readOnly: Boolean(e.readOnly) || e.getAttribute("aria-readonly") === "true",
      fieldName: e.getAttribute("name"), formAction: e.form ? String(e.getAttribute("formaction") ? e.formAction : e.form.action) : undefined,
      formMethod: e.form ? String(e.getAttribute("formmethod") || e.form.method) : undefined, formTarget: e.form ? String(e.getAttribute("formtarget") || e.form.target) : undefined,
      href: e.tagName === "A" ? String(e.href) : undefined, checked: "checked" in e ? Boolean(e.checked) : undefined,
      expanded: e.getAttribute("aria-expanded"), selected: e.getAttribute("aria-selected"), pressed: e.getAttribute("aria-pressed"),
      value: fieldValue(e), selectedValues: e.tagName === "SELECT" ? Array.from(e.selectedOptions).map((option: any) => String(option.value)) : undefined,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  };
  const focused = (e: any) => d.activeElement === e || e.isContentEditable && e.contains(d.activeElement);
  const documentInfo = (): ChromeDocument => ({
    url: clip(d.URL, 2000), urlTruncated: d.URL.length > 2000, title: clip(d.title, 300), titleTruncated: d.title.length > 300,
    visibility: d.visibilityState === "visible" ? "visible" : "hidden", hasFocus: d.hasFocus(),
    viewport: { width: w.innerWidth, height: w.innerHeight, devicePixelRatio: w.devicePixelRatio, scale: w.visualViewport?.scale ?? 1,
      offsetLeft: w.visualViewport?.offsetLeft ?? 0, offsetTop: w.visualViewport?.offsetTop ?? 0 },
    scroll: { x: w.scrollX, y: w.scrollY }, coordinateSpace: "css-viewport" });
  const originalDocument = documentInfo(), originalUrl = d.URL, originalTitle = d.title;
  const docCurrent = () => d === w.document && docRoot === d.documentElement && d.URL === originalUrl && d.title === originalTitle
    && d.visibilityState === "visible" && same(documentInfo().viewport, originalDocument.viewport) && same(documentInfo().scroll, originalDocument.scroll)
    && originalDocument.viewport.scale === 1 && originalDocument.viewport.offsetLeft === 0 && originalDocument.viewport.offsetTop === 0;
  const dialogNodes = () => {
    const found: any[] = [], nodes = d.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"]');
    for (let i = 0; i < Math.min(nodes.length, MAX_CONTROLS) && found.length < 17; i++) if (visible(nodes[i])) found.push(nodes[i]);
    if (nodes.length > MAX_CONTROLS) found.push(null); // Cannot prove the complete modal set.
    return found;
  };
  const originalDialogs = dialogNodes();
  const dialogsCurrent = () => { const now = dialogNodes(); return !now.includes(null) && now.length <= 16 && now.length === originalDialogs.length && now.every((e, i) => e === originalDialogs[i]); };
  const fieldState = (scope: any) => {
    const found = scope.querySelectorAll(fieldsSelector);
    if (found.length > 240) return null;
    const nodes = Array.from(found);
    if (scope.matches?.(fieldsSelector)) nodes.unshift(scope);
    // A bounded watch set must never claim completeness after truncation.
    if (nodes.length > 240) return null;
    const entries: { node: any; data: ReturnType<typeof metadata> }[] = [];
    let chars = 0;
    for (const node of nodes as any[]) {
      if (!visible(node) || node.isContentEditable && node.parentElement?.isContentEditable) continue;
      const data = metadata(node); chars += JSON.stringify(data).length;
      if (chars > 128000) return null;
      entries.push({ node, data });
    }
    return entries;
  };
  const sameFields = (before: ReturnType<typeof fieldState>, scope: any) => {
    if (!before || !scope.isConnected) return false;
    const after = fieldState(scope);
    return after !== null && before.length === after.length && before.every((entry, i) => entry.node === after[i]?.node && same(entry.data, after[i]?.data));
  };
  const formStates = new Map<any, ReturnType<typeof fieldState>>();
  const candidates: { node: any; data: ReturnType<typeof metadata>; center: ChromePoint; actions: ChromeAction[]; priority: number }[] = [];
  const controls = d.querySelectorAll(controlsSelector);
  let scannedControls = 0;
  if (d.visibilityState === "visible") for (let i = 0; i < Math.min(controls.length, MAX_CONTROLS); i++) {
    const e = controls[i];
    scannedControls++;
    if (disabled(e) || e.isContentEditable && e.parentElement?.isContentEditable) continue;
    const center = point(e); if (!center) continue;
    const data = metadata(e);
    if (JSON.stringify(data).length > 16000) continue;
    const actions: ChromeAction[] = [];
    const click = e.matches('input,textarea,select,button,a[href],summary,[tabindex]') || /^(button|link|menuitem|tab|option|checkbox|radio|switch|textbox|combobox)$/.test(data.role) || data.editable;
    if (!data.protected && click) actions.push("click");
    if (data.editable) actions.push("type");
    if (!data.protected && (e.tabIndex >= 0 || data.editable)) actions.push("key");
    const style = w.getComputedStyle(e);
    if (!data.protected && e.scrollHeight > e.clientHeight + 1 && /(auto|scroll)/.test(style.overflowY)) actions.push("scroll");
    if (!actions.length && !data.protected && !/^(dialog|alertdialog)$/.test(data.role)) continue;
    candidates.push({ node: e, data, center, actions, priority: focused(e) && data.editable ? 0 : data.editable ? 1 : /^(dialog|alertdialog)$/.test(data.role) || e.closest('dialog[open],[role="dialog"],[role="alertdialog"]') ? 2 : 3 });
  }
  candidates.sort((a, b) => a.priority - b.priority);
  const elements: ChromeObservedElement[] = [], kept: typeof candidates = [];
  let bytes = 0, elementsTruncated = controls.length > MAX_CONTROLS;
  for (const entry of candidates) {
    const { node, data, center, actions } = entry;
    const row: ChromeObservedElement = { ref: `${input.nonce}:${elements.length}`, role: data.role, name: clip(data.name, 240), nameTruncated: data.name.length > 240,
      within: clip(data.within, 180), rect: data.rect, center, focused: focused(node), editable: data.editable, type: data.type, protected: data.protected,
      ...(data.value === undefined ? {} : { value: data.value.slice(0, 1000) }), valueTruncated: (data.value?.length ?? 0) > 1000, actions };
    const length = JSON.stringify(row).length * 3;
    if (elements.length >= MAX_OUTPUT || bytes + length > MAX_BYTES) { elementsTruncated = true; break; }
    bytes += length; elements.push(row); kept.push(entry);
    const scope = containerOf(node); if (!formStates.has(scope)) formStates.set(scope, fieldState(scope));
  }
  const texts: string[] = [], seenTexts = new Set<string>();
  const walker = d.createTreeWalker(d.body || docRoot, 4); // SHOW_TEXT, no page script or accessibility traversal.
  let textNode: any, textScanned = 0, textsTruncated = false;
  if (d.visibilityState === "visible") while ((textNode = walker.nextNode())) {
    if (++textScanned > 12000 || texts.length >= Math.min(160, MAX_OUTPUT - elements.length)) { textsTruncated = true; break; }
    const e = textNode.parentElement;
    if (!e || e.closest('script,style,noscript,textarea,[contenteditable],input,select') || !visible(e)) continue;
    const range = d.createRange(); range.selectNodeContents(textNode);
    if (!point(e, range.getClientRects())) continue;
    const text = compact(textNode.nodeValue); if (!text || seenTexts.has(text)) continue;
    const line = text.slice(0, 320) + (text.length > 320 ? " [truncated]" : "");
    if (bytes + line.length * 3 > MAX_BYTES) { textsTruncated = true; break; }
    texts.push(line); seenTexts.add(text); bytes += line.length * 3;
  }
  const pageCenter = { x: w.innerWidth / 2, y: w.innerHeight / 2 }, pageHit = d.elementFromPoint(pageCenter.x, pageCenter.y);
  const pageHitKnown = () => pageHit?.isConnected && !/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(pageHit.tagName) && !pageHit.shadowRoot;
  const pageScope = d.body || docRoot;
  const pageFields = formStates.get(pageScope) ?? fieldState(pageScope);
  let authorized: { ref?: string; node?: any; token: string; action: ChromeAction; data?: ReturnType<typeof metadata>; scope?: any; fields?: ReturnType<typeof fieldState> } | undefined;
  const reject = (reason: string): ChromeVerification => ({ ok: false, reason });
  const verifyTarget = (entry: typeof candidates[number], action: ChromeAction) => {
    if (!entry.node.isConnected || entry.node.ownerDocument !== d || protectedField(entry.node)) return "Target is detached or protected.";
    if (!entry.actions.includes(action) || action === "type" && !editable(entry.node)) return "Target does not support this action.";
    if (action === "key" && !focused(entry.node)) return "The observed key target is not focused.";
    if (!point(entry.node) || !same(entry.data, metadata(entry.node))) return "Target visibility, geometry or metadata changed.";
    const scope = containerOf(entry.node);
    if (!sameFields(formStates.get(scope) ?? null, scope)) return "Relevant form controls or known values changed or exceeded the verification bound.";
    return null;
  };
  state.verify = (request: ChromeVerifyRequest): ChromeVerification => {
    if (!request || request.nonce !== input.nonce || w[key] !== state || state.used) return reject("Stale or consumed observation.");
    state.used = true; // Failed verification is also one-use; never revive by retry.
    if (!docCurrent() || !dialogsCurrent()) return reject("Document, viewport, visibility or dialog changed.");
    if (!["click", "type", "key", "scroll"].includes(request.action)) return reject("Unsupported action.");
    let center: ChromePoint, node: any;
    if (request.ref === undefined && request.action === "scroll") {
      if (!pageHitKnown() || d.elementFromPoint(pageCenter.x, pageCenter.y) !== pageHit || !sameFields(pageFields, pageScope)) return reject("The page scroll target or known values changed or were not observed.");
      center = pageCenter;
    } else {
      const index = elements.findIndex(row => row.ref === request.ref), entry = kept[index];
      if (!entry) return reject("Unknown element capability.");
      const problem = verifyTarget(entry, request.action); if (problem) return reject(problem);
      node = entry.node; center = point(node)!;
    }
    const token = Array.from(w.crypto.getRandomValues(new Uint8Array(16)), (n: any) => n.toString(16).padStart(2, "0")).join("");
    authorized = { ref: request.ref, node, token, action: request.action, ...(node ? { data: metadata(node), scope: containerOf(node), fields: formStates.get(containerOf(node)) } : {}) };
    return { ok: true, nonce: input.nonce, ...(request.ref ? { ref: request.ref } : {}), token, document: documentInfo(), center, focused: node ? focused(node) : false, editable: node ? editable(node) : false };
  };
  state.verifyFocus = (request: ChromeFocusRequest): ChromeVerification => {
    if (w[key] !== state || !state.used || !authorized || request?.nonce !== input.nonce || request.ref !== authorized.ref || request.token !== authorized.token
      || request.checkFocus !== undefined && typeof request.checkFocus !== "boolean") return reject("No consumed capability owns this verification.");
    const fail = (reason: string) => { authorized = undefined; return reject(reason); };
    if (!docCurrent() || !dialogsCurrent()) return fail("Document or dialog changed after verification.");
    const e = authorized.node;
    if (!e) {
      if (authorized.action !== "scroll" || request.checkFocus !== false || !pageHitKnown() || d.elementFromPoint(pageCenter.x, pageCenter.y) !== pageHit
        || !sameFields(pageFields, pageScope)) return fail("The consumed page-scroll target changed.");
      return { ok: true, nonce: input.nonce, token: authorized.token, document: documentInfo(), center: pageCenter, focused: false, editable: false };
    }
    if (!e.isConnected || protectedField(e) || (authorized.action === "type" && !editable(e))
      || (request.checkFocus !== false || authorized.action === "key") && !focused(e) || !point(e)
      || !same(authorized.data, metadata(e)) || !sameFields(authorized.fields ?? null, authorized.scope)) return fail("The exact target, focus or known form values changed after verification.");
    return { ok: true, nonce: input.nonce, ...(request.ref ? { ref: request.ref } : {}), token: authorized.token, document: documentInfo(), center: point(e)!, focused: focused(e), editable: editable(e) };
  };
  return { nonce: input.nonce, document: originalDocument, elements, texts, coverage: { elementsTruncated, textsTruncated, scannedControls,
    returnedNodes: elements.length + texts.length, framesOmitted: d.querySelectorAll("iframe,frame").length, shadowDOM: "not-traversed", hiddenDocument: d.visibilityState !== "visible" } };
}

function verifyChromeObservation(input: ChromeVerifyRequest): ChromeVerification {
  const store = (globalThis as any)[Symbol.for("hands.chrome.observation.v1")];
  return store?.verify ? store.verify(input) : { ok: false, reason: "No isolated-world observation is available." };
}
function verifyChromeFocus(input: ChromeFocusRequest): ChromeVerification {
  const store = (globalThis as any)[Symbol.for("hands.chrome.observation.v1")];
  return store?.verifyFocus ? store.verifyFocus(input) : { ok: false, reason: "No isolated-world observation is available." };
}

export const collectorFunction = collectChromeObservation.toString();
export const verifierFunction = verifyChromeObservation.toString();
export const verifyFocusFunction = verifyChromeFocus.toString();
