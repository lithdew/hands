/** Windows port of the supplied pi-cua look/act/browser interface. Uses Puk's
 * existing persistent CDP connection for browser text and Cua UIA for native apps.
 * Native pixel/Retina assumptions from the macOS extension are deliberately not
 * applied to Windows: exact snapshot tokens are used for native controls.
 */
import type { Hand, InstalledApp } from "../desktop";
import { createSemanticComputer, type Element, type PixelCapture, type Snapshot } from "../semantic-computer";
import { attachExistingBrowser, browserTarget, browserWindow, captureBound, capturedImage, detachExistingBrowser, driver, existingBrowser, existingBrowserCandidates, frontOf, handBrowser, handState, launchInstalledApp, type RawWindow } from "./desktop";
import type { ExistingBrowserSnapshot } from "./browser";
import { observeHand, pageSettled } from "./observe";

type NativeElement = { element_index: number; element_token?: string; role: string; label?: string; value?: string; enabled?: boolean; actions?: string[]; parent_index?: number };
const identity = (w: { pid: number; containerId: number; ownerNonce?: string }) => `${w.pid}:${w.containerId}:${w.ownerNonce ?? ""}`;

export function semanticComputer(hand: Hand, beforeInput: () => void = () => {}) {
  const session = `puk-semantic-${hand.id}-${crypto.randomUUID()}`;
  const front = async () => {
    const window = await frontOf(hand);
    if (!window) throw new Error("This hand has no window. Use open_app first.");
    return window;
  };
  const pixels = async (window: RawWindow) => {
    const shot = await captureBound(hand);
    if (!shot.window || identity(shot.window) !== identity(window) || shot.window.title !== window.title || shot.window.rect.slice(2).join("x") !== window.rect.slice(2).join("x")) throw new Error("The observed window changed before its screenshot. Look again.");
    return { image: { type: "image" as const, mimeType: "image/png", data: shot.data }, capture: (capturedImage(shot).structuredContent as { puk_snapshot: PixelCapture }).puk_snapshot };
  };
  return createSemanticComputer({
    windows: async () => ({ ...await handState(hand), existing_browsers: (await existingBrowserCandidates()).map(({ rect: _, iconic: __, ...window }) => window) }),
    async attach(target, signal) {
      beforeInput(); signal?.throwIfAborted();
      if (target.mode === "existing") await attachExistingBrowser(hand, target, signal);
      else {
        await detachExistingBrowser(hand);
        beforeInput(); signal?.throwIfAborted();
        await launchInstalledApp(hand, { id: "browser", name: "Web browser" } as InstalledApp);
      }
      beforeInput(); signal?.throwIfAborted();
    },
    async observe(options): Promise<Snapshot> {
      options.signal?.throwIfAborted();
      const window = await front();
      if (browserTarget(hand).mode === "existing") {
        const observed = await existingBrowser(hand)!.snapshot(options.signal);
        const current = await front();
        if (identity(current) !== identity(window) || identity(observed.window) !== identity(window) || current.title !== observed.window.title
          || current.rect.slice(2).join("x") !== observed.window.rect.slice(2).join("x")) throw new Error("The existing Chrome window changed while observing it. Look again.");
        const elements: Element[] = observed.refs.filter((ref) => ref.states?.disabled !== true).map((ref) => {
          const protectedField = /password/i.test(ref.role) || ref.states?.protected === true;
          return { key: ref.ref, role: ref.role, name: ref.name, value: protectedField ? undefined : ref.value,
            editable: !protectedField && Boolean(ref.actions?.includes("type")), address: { browser_ref: ref.ref } };
        });
        return { kind: "browser", identity: `${identity(current)}:${observed.url}`, title: current.title, url: observed.url, elements,
          texts: ["Connected to the user's existing Chrome. Only the active tab shown in the preview receives input.",
            ...observed.tabs.slice(0, 8).map((tab) => `${tab.active === true ? "Active" : "Inactive"} tab: ${tab.title} ${tab.url}`),
            ...observed.outline.split("\n").filter((line) => !/password/i.test(line)).slice(0, 31)],
          ...(options.screenshot || !elements.length ? await pixels(current) : {}),
          binding: { window: identity(current), size: current.rect.slice(2).join("x"), existing: observed } };
      }
      const web = await browserWindow(hand);
      if (web && web.containerId === window.containerId) {
        const observation = await observeHand(hand);
        options.signal?.throwIfAborted();
        const url = observation.texts.find((s) => s.startsWith("address: "))?.slice(9);
        return { kind: "browser", identity: `${identity(window)}:${url}`, title: window.title, url, texts: observation.texts,
          elements: observation.elements.map((e) => ({ key: e.id, role: e.role, name: e.name, value: e.value, within: e.within, editable: e.editable,
            address: { x: Math.round(e.rect.x + e.rect.w / 2), y: Math.round(e.rect.y + e.rect.h / 2), rect: e.rect } })),
          ...(options.screenshot ? await pixels(window) : {}), binding: { window: identity(window), size: window.rect.slice(2).join("x"), fingerprint: observation.fingerprint } };
      }
      const result = await (await driver(hand)).call("get_window_state", { pid: window.pid, window_id: window.containerId, session,
        include_accessibility_tree: true, include_screenshot: false, max_elements: 400, max_depth: 20 }, options.signal);
      const state = result.structuredContent as { elements?: NativeElement[]; tree_markdown?: string; snapshot_id?: string } | undefined;
      if (!state) throw new Error("Cua returned no structured window state.");
      const all = state.elements ?? [];
      const elements: Element[] = all.filter((e) => e.enabled !== false && (e.element_token || state.snapshot_id)).map((e) => ({
        key: String(e.element_index), role: e.role, name: e.label ?? "", value: /password/i.test(e.role) ? "" : e.value,
        editable: !/password/i.test(e.role) && (/edit|text.?field|text.?area|combo/i.test(e.role) || (e.actions ?? []).some((a) => /set.?value|type/i.test(a))),
        within: all.find((p) => p.element_index === e.parent_index)?.label,
        address: e.element_token ? { element_token: e.element_token } : { element_index: e.element_index, snapshot_id: state.snapshot_id },
      }));
      return { kind: "native", identity: identity(window), title: window.title, elements,
        texts: state.tree_markdown ? state.tree_markdown.split("\n").filter((s) => !/password/i.test(s)).slice(0, 40) : [],
        ...(options.screenshot || !elements.length ? await pixels(window) : {}),
        binding: { window: identity(window), size: window.rect.slice(2).join("x"), title: window.title } };
    },
    async act(snapshot, action, element, signal) {
      const checkTarget = async () => {
        signal?.throwIfAborted(); beforeInput();
        const window = await front();
        if (identity(window) !== snapshot.binding.window || window.rect.slice(2).join("x") !== snapshot.binding.size || window.title !== snapshot.title) throw new Error("The active window changed or resized. Look again before acting.");
        signal?.throwIfAborted(); beforeInput();
        return window;
      };
      const window = await checkTarget();
      const target = { pid: window.pid, window_id: window.containerId, session };
      if (snapshot.binding.existing) {
        if (browserTarget(hand).mode !== "existing") throw new Error("The existing Chrome connection changed after observation. Attach and look again.");
        await existingBrowser(hand)!.act(snapshot.binding.existing as ExistingBrowserSnapshot, action,
          element ? String(element.address.browser_ref) : undefined, signal, beforeInput);
        return;
      }
      if (browserTarget(hand).mode === "existing") throw new Error("This observation belongs to the private hand, which is no longer selected. Look at the attached Chrome window first.");
      if (snapshot.kind === "browser") {
        const web = await browserWindow(hand);
        if (!web || identity(web) !== snapshot.binding.window) throw new Error("The browser target changed. Look again.");
        const fresh = await observeHand(hand);
        if (fresh.fingerprint !== snapshot.binding.fingerprint) throw new Error("The page changed since observation. Take a fresh snapshot and use its references.");
        await checkTarget();
        if (action.action === "navigate") {
          if (!await handBrowser(hand).navigate(web, action.url!)) throw new Error("The bound browser is unavailable.");
        } else {
          // Keep the exact observed window through the awaits. The general Cua
          // facade follows focus, which could retarget an input during a switch.
          const input = handBrowser(hand);
          const call = async (name: string, args: Record<string, unknown>) => {
            await checkTarget();
            if (!await input.handle(name, args, web)) throw new Error("The bound page could not receive input. Observe it again.");
          };
          const point = element ? { x: element.address.x, y: element.address.y } : { x: Math.round(window.rect[2] / 2), y: Math.round(window.rect[3] / 2) };
          if (action.action === "click") await call("click", { ...point, button: "left" });
          else if (action.action === "type" || action.action === "set_value") {
            await call("click", { ...point, button: "left" });
            if (action.replace !== false) await call("hotkey", { keys: ["ctrl", "a"] });
            await call("type_text", { text: action.text });
          } else if (action.action === "key") {
            const keys = action.key!.toLowerCase().split("+").map((k) => k.trim());
            await call(keys.length > 1 ? "hotkey" : "press_key", keys.length > 1 ? { keys } : { key: keys[0] });
          } else if (action.action === "scroll") await call("scroll", { ...point, direction: action.direction ?? "down", amount: action.amount ?? 6, by: "line" });
        }
        await pageSettled(hand, 1500);
      } else {
        const raw = await driver(hand), address = { ...target, ...element?.address };
        await checkTarget();
        if (action.action === "type" && action.replace === false) throw new Error("Appending to a native field is not supported by Cua's token input. Use set_value with the complete intended value, or inspect a screenshot and use keyboard input.");
        if (action.action === "click") await raw.call("click", address, signal);
        else if (action.action === "set_value" || (action.action === "type" && action.replace !== false)) await raw.call("set_value", { ...address, value: action.text }, signal);
        else if (action.action === "key") {
          const keys = action.key!.toLowerCase().split("+").map((k) => k.trim());
          await raw.call(keys.length > 1 ? "hotkey" : "press_key", { ...address, ...(keys.length > 1 ? { keys } : { key: keys[0] }) }, signal);
        } else if (action.action === "scroll") await raw.call("scroll", { ...address, direction: action.direction ?? "down", amount: action.amount ?? 3 }, signal);
        else throw new Error("Browser navigation is not available in this native window.");
        await Bun.sleep(150);
      }
    },
  }, beforeInput);
}
