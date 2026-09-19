import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { previewBrowserExecutable } from "../workflows/preview";
import { collectorFunction, verifierFunction, verifyFocusFunction, type ChromeObservation, type ChromeVerification } from "./chrome-observation";

const executablePath = previewBrowserExecutable();
let browser: Browser;
beforeAll(async () => { if (executablePath) browser = await chromium.launch({ executablePath, headless: true }); });
afterAll(async () => { await browser?.close(); });

type Fixture = { page: Page; cdp: CDPSession; contextId: number;
  collect(): Promise<ChromeObservation>; verify(args: unknown): Promise<ChromeVerification>; follow(args: unknown): Promise<ChromeVerification>;
  isolated<T = unknown>(expression: string): Promise<T> };
async function fixture(html: string, run: (f: Fixture) => Promise<void>) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.route("**/*", route => route.abort()); // No fixture may reach an account, server or the network.
  const page = await context.newPage();
  try {
    await page.setContent(`<style>body{font:18px Arial;margin:24px}input,textarea,select,button,[contenteditable]{display:block;box-sizing:border-box;width:300px;min-height:32px;margin:10px 0}textarea,[contenteditable]{height:80px;white-space:pre-wrap}</style>${html}`);
    const cdp = await context.newCDPSession(page); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: `hands-fixture-${crypto.randomUUID()}` });
    async function call<T>(functionDeclaration: string, value: unknown): Promise<T> {
      const result = await cdp.send("Runtime.callFunctionOn", { executionContextId, functionDeclaration, arguments: [{ value }], returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value as T;
    }
    await run({ page, cdp, contextId: executionContextId,
      collect: () => call<ChromeObservation>(collectorFunction, { nonce: crypto.randomUUID() }),
      verify: args => call<ChromeVerification>(verifierFunction, args), follow: args => call<ChromeVerification>(verifyFocusFunction, args),
      isolated: async <T>(expression: string) => {
        const result = await cdp.send("Runtime.evaluate", { contextId: executionContextId, expression, returnByValue: true });
        if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
        return result.result.value as T;
      } });
  } finally { await context.close(); }
}
const form = '<form aria-label="Compose"><label for="to">To</label><input id="to" value="friend@example.test"><label for="subject">Subject</label><input id="subject" value="A draft"><div id="body" role="textbox" contenteditable="true" aria-label="Message body">Hello</div><button type="button" id="send">Send</button></form>';
const row = (o: ChromeObservation, name: string) => {
  const result = o.elements.find(e => e.name === name); if (!result) throw Error(`Fixture row missing: ${name}`); return result;
};
const request = (o: ChromeObservation, name: string, action = "click") => ({ nonce: o.nonce, ref: row(o, name).ref, action });

describe.skipIf(!executablePath)("isolated Chrome observations", () => {
  test("returns exact editable values and prioritized visible controls with bounded page text", async () => fixture(`${form}<p>Read-only frontier research</p>`, async f => {
    await f.page.locator("#subject").fill("  leading and trailing  ");
    await f.page.locator("#body").fill(" line one\nline two  ");
    const o = await f.collect();
    expect(row(o, "Subject").value).toBe("  leading and trailing  ");
    expect(row(o, "Message body").value).toBe(" line one\nline two  ");
    expect(row(o, "Subject")).toMatchObject({ editable: true, protected: false, valueTruncated: false, within: "Compose", actions: ["click", "type", "key"] });
    expect(o.elements.findIndex(e => e.name === "Subject")).toBeLessThan(o.elements.findIndex(e => e.name === "Send"));
    expect(o.texts).toContain("Read-only frontier research");
    expect(o.document).toMatchObject({ visibility: "visible", coordinateSpace: "css-viewport", viewport: { width: 1200, height: 900, scale: 1, offsetLeft: 0, offsetTop: 0 } });
    expect(typeof o.document.hasFocus).toBe("boolean");
    expect(o.coverage.returnedNodes).toBe(o.elements.length + o.texts.length);
  }));

  test("suppresses protected values and excludes hidden, disabled, offscreen and occluded targets", async () => fixture(`${form}
    <input aria-label="Password" type="password" value="DO_NOT_RETURN_SECRET"><input aria-label="Hidden" hidden value="HIDDEN_SECRET">
    <input aria-label="Disabled" disabled><button style="position:absolute;top:1800px">Offscreen</button>
    <button id="covered" style="position:absolute;left:700px;top:100px">Covered</button><div style="position:absolute;left:700px;top:100px;width:310px;height:100px;background:white;z-index:2">Overlay</div>
    <p style="position:absolute;left:700px;top:240px">Occluded text</p><div style="position:absolute;left:695px;top:230px;width:210px;height:60px;background:white;z-index:2">Cover text</div>`, async f => {
    const o = await f.collect(), password = row(o, "Password");
    expect(password).toMatchObject({ protected: true, editable: false, actions: [] }); expect(password.value).toBeUndefined();
    expect(JSON.stringify(o)).not.toContain("DO_NOT_RETURN_SECRET"); expect(JSON.stringify(o)).not.toContain("HIDDEN_SECRET");
    for (const name of ["Hidden", "Disabled", "Offscreen", "Covered"]) expect(o.elements.some(e => e.name === name)).toBe(false);
    expect(o.texts).not.toContain("Occluded text");
    expect(await f.verify({ nonce: o.nonce, ref: password.ref, action: "click" })).toMatchObject({ ok: false });
  }));

  test("main-world store and DOM ref forgeries cannot replace isolated Element capabilities", async () => fixture(form, async f => {
    const o = await f.collect();
    expect(await f.page.evaluate(() => (globalThis as any)[Symbol.for("hands.chrome.observation.v1")])).toBeUndefined();
    await f.page.evaluate(({ ref, nonce }) => {
      const document = (globalThis as any).document;
      (globalThis as any)[Symbol.for("hands.chrome.observation.v1")] = { nonce, verify: () => ({ ok: true }) };
      const button = document.querySelector("#send")!; const clone = button.cloneNode(true);
      clone.dataset.ref = ref; button.replaceWith(clone);
    }, { ref: row(o, "Send").ref, nonce: o.nonce });
    expect(await f.verify(request(o, "Send"))).toMatchObject({ ok: false, reason: "Target is detached or protected." });
  }));

  test("metadata, geometry, same-object form values and even truncated suffix changes invalidate input", async () => {
    for (const change of ["recipient", "whitespace", "name", "geometry", "occluded", "long-value", "readonly", "form-action", "field-name"]) await fixture(form, async f => {
      if (change === "long-value") await f.page.locator("#subject").fill("a".repeat(1100));
      const o = await f.collect();
      if (change === "long-value") expect(row(o, "Subject")).toMatchObject({ value: "a".repeat(1000), valueTruncated: true });
      await f.page.evaluate(change => {
        const document = (globalThis as any).document;
        const to = document.querySelector("#to")!, subject = document.querySelector("#subject")!, send = document.querySelector("#send")!;
        if (change === "recipient") to.value = "different@example.test";
        if (change === "whitespace") subject.value += " ";
        if (change === "name") send.setAttribute("aria-label", "Delete draft");
        if (change === "geometry") send.style.marginLeft = "20px";
        if (change === "readonly") subject.readOnly = true;
        if (change === "form-action") to.form.action = "https://changed.example.test/submit";
        if (change === "field-name") to.name = "bcc";
        if (change === "long-value") subject.value = subject.value.slice(0, 1099) + "b";
        if (change === "occluded") { const overlay = document.createElement("div"); overlay.style.cssText = "position:fixed;inset:0;background:white;z-index:999"; document.body.append(overlay); }
      }, change);
      expect(await f.verify(request(o, "Send"))).toMatchObject({ ok: false });
      expect(await f.verify(request(o, "Send"))).toMatchObject({ ok: false, reason: "Stale or consumed observation." });
    });
  });

  test("new observations revoke old refs and unsupported refs or actions never resolve by DOM ID", async () => fixture(form, async f => {
    const old = await f.collect(), current = await f.collect();
    expect(await f.verify(request(old, "Send"))).toMatchObject({ ok: false });
    expect(await f.verify(request(current, "Send"))).toMatchObject({ ok: true });
    const next = await f.collect();
    expect(await f.verify({ nonce: next.nonce, ref: "send", action: "click" })).toMatchObject({ ok: false, reason: "Unknown element capability." });
    const another = await f.collect(); expect(await f.verify(request(another, "Send", "type"))).toMatchObject({ ok: false });
  }));

  test("consumed type capability supports read-only post-focus checks but cannot rearm input", async () => fixture(form, async f => {
    const o = await f.collect(), verified = await f.verify(request(o, "Subject", "type"));
    expect(verified.ok).toBe(true); if (!verified.ok) return;
    const follow = { nonce: o.nonce, ref: row(o, "Subject").ref, token: verified.token };
    expect(await f.follow({ ...follow, checkFocus: false })).toMatchObject({ ok: true, focused: false, editable: true });
    await f.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...verified.center, button: "left", clickCount: 1 });
    await f.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...verified.center, button: "left", clickCount: 1 });
    expect(await f.follow(follow)).toMatchObject({ ok: true, focused: true, editable: true });
    expect(await f.verify(request(o, "Subject", "type"))).toMatchObject({ ok: false });
    await f.page.locator("#to").fill("changed@example.test");
    expect(await f.follow({ ...follow, checkFocus: false })).toMatchObject({ ok: false });
    await f.page.locator("#to").fill("friend@example.test");
    expect(await f.follow({ ...follow, checkFocus: false })).toMatchObject({ ok: false });
  }));

  test("document visibility and identity changes invalidate refs while document focus is informational", async () => {
    for (const change of ["hidden", "title", "document", "viewport", "dialog"]) await fixture(form, async f => {
      const o = await f.collect();
      if (change === "hidden") await f.isolated("Object.defineProperty(document, 'visibilityState', {get:()=> 'hidden', configurable:true}); true");
      if (change === "title") await f.page.evaluate(() => { (globalThis as any).document.title = "Different task"; });
      if (change === "document") await f.page.evaluate(() => { const document = (globalThis as any).document; document.documentElement.replaceWith(document.documentElement.cloneNode(true)); });
      if (change === "viewport") await f.page.setViewportSize({ width: 1000, height: 800 });
      if (change === "dialog") await f.page.evaluate(() => { const document = (globalThis as any).document; const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); dialog.textContent = "Confirm"; document.body.append(dialog); });
      expect(await f.verify(request(o, "Send"))).toMatchObject({ ok: false });
    });
    await fixture(form, async f => {
      const o = await f.collect(); await f.isolated("document.hasFocus=()=>false; true");
      expect(await f.verify(request(o, "Send"))).toMatchObject({ ok: true, document: { hasFocus: false } });
    });
  });

  test("page scroll is an observation-bound one-use target and final recheck requires its token", async () => fixture(form, async f => {
    const o = await f.collect(), verified = await f.verify({ nonce: o.nonce, action: "scroll" });
    expect(verified.ok).toBe(true); if (!verified.ok) return;
    const follow = { nonce: o.nonce, token: verified.token, checkFocus: false };
    expect(await f.follow(follow)).toMatchObject({ ok: true, editable: false });
    expect(await f.follow({ ...follow, token: "forged" })).toMatchObject({ ok: false });
    expect(await f.verify({ nonce: o.nonce, action: "scroll" })).toMatchObject({ ok: false });
    await f.page.evaluate(() => { const document = (globalThis as any).document; const overlay = document.createElement("div"); overlay.style.cssText = "position:fixed;inset:0;background:white;z-index:999"; document.body.append(overlay); });
    expect(await f.follow(follow)).toMatchObject({ ok: false });
  }));

  test("output remains bounded and child-frame/shadow controls are explicitly not synthesized", async () => fixture('<input aria-label="Priority field"><div id="buttons" style="height:600px;overflow:auto"></div><iframe srcdoc="<button>Child-only button</button>"></iframe><div id="shadow"></div>', async f => {
    await f.page.evaluate(() => {
      const document = (globalThis as any).document;
      const box = document.querySelector("#buttons")!;
      for (let i = 0; i < 800; i++) { const button = document.createElement("button"); button.textContent = "Repeated " + i; button.style.cssText = "display:inline-block;width:20px;height:20px;min-height:0;margin:0;font-size:1px"; box.append(button); }
      document.querySelector("#shadow")!.attachShadow({ mode: "open" }).innerHTML = "<button>Shadow-only button</button>";
    });
    const o = await f.collect();
    expect(o.elements[0]?.name).toBe("Priority field"); expect(o.coverage.returnedNodes).toBeLessThanOrEqual(600);
    expect(Buffer.byteLength(JSON.stringify(o))).toBeLessThan(210000);
    expect(o.coverage.framesOmitted).toBe(1); expect(o.coverage.shadowDOM).toBe("not-traversed");
    expect(o.elements.some(e => /Child-only|Shadow-only/.test(e.name))).toBe(false);
  }));

  test("page scrolling cannot infer an unobserved child-frame target", async () => fixture('<iframe style="position:fixed;inset:0;width:100%;height:100%" srcdoc="<p>Separate frame</p>"></iframe>', async f => {
    const o = await f.collect(); expect(o.coverage.framesOmitted).toBe(1);
    expect(await f.verify({ nonce: o.nonce, action: "scroll" })).toMatchObject({ ok: false });
  }));
});
