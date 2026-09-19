/**
 * What Jev reads instead of pixels: the hand's browser page as labelled elements.
 *
 * jev/observe.ts gets this from AT-SPI on Omarchy. On Windows the page's own DOM
 * is richer and costs one DevTools round trip (about 30 ms), so Jev can look
 * before and after every action without the look being the slow part.
 *
 * UI Automation is not used for native windows: on a window that sits on another
 * virtual desktop it exposes next to nothing (Calculator: no elements, Paint: its
 * title bar) and takes one to three seconds. Native apps beyond opening them are
 * left to the vision agent.
 */
import { debugLog, type Hand } from "../desktop";
import type { Observation, UiElement } from "../jev/observe";
import { boost, browserPid, browserWindow, frontOf, handBrowser } from "./desktop";

export const MAX_ELEMENTS = 80;

type PageElement = { role: string; name: string; value: string; editable: boolean; focused: boolean; within: string; x: number; y: number; w: number; h: number };
type PageDump = { url: string; title: string; ready: string; elements: PageElement[]; texts: string[] };

/** Runs in the page. Kept to what a person could see and use right now: inside
 * the viewport, not covered, with a name. Fields come first because the cap
 * should never cost Jev the search box. */
export const READ_PAGE = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const roleOf = (el) => {
    const given = el.getAttribute("role");
    if (given) return given;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "select") return "combo box";
    if (tag === "textarea" || el.isContentEditable) return "text field";
    if (tag === "summary") return "button";
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (["checkbox", "radio", "range", "file", "color"].includes(type)) return type;
      return type === "password" ? "password field" : "text field";
    }
    return tag;
  };
  const nameOf = (el) => clean(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.placeholder
    || (el.tagName === "INPUT" && ["submit", "button"].includes(el.type) ? el.value : "") || el.innerText || el.title || el.alt
    || (el.querySelector("img[alt]") || {}).alt || el.name || el.id);
  const within = (el) => {
    const box = el.closest("[role=dialog],dialog,[role=search],form,nav,[role=navigation],header,footer,aside");
    if (!box) return "";
    return clean(box.getAttribute("aria-label") || box.getAttribute("role") || box.tagName.toLowerCase());
  };
  const picked = [];
  const selector = "a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=textbox],[role=searchbox],[role=combobox],[role=tab],[role=menuitem],[role=checkbox],[role=option],[contenteditable=''],[contenteditable=true]";
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0 || el.disabled) continue;
    const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(cx, cy);
    if (hit && !el.contains(hit) && !hit.contains(el)) continue;
    const role = roleOf(el), editable = role === "text field" || role === "password field" || role === "textbox" || role === "searchbox" || role === "combobox";
    const name = nameOf(el);
    if (!name && !editable) continue;
    picked.push({ role, name, editable, focused: document.activeElement === el, within: within(el),
      value: role === "password field" ? "" : clean(el.value !== undefined && typeof el.value === "string" ? el.value : ""),
      x: r.left, y: r.top, w: r.width, h: r.height });
  }
  const rank = (e) => (e.editable ? 0 : e.role === "link" ? 2 : 1);
  picked.sort((a, b) => rank(a) - rank(b));
  const texts = [];
  for (const el of document.querySelectorAll("h1,h2,h3,[role=heading],p,li,td,[role=alert],[role=status]")) {
    if (texts.length >= 14) break;
    const r = el.getBoundingClientRect();
    if (r.height < 4 || r.bottom <= 0 || r.top >= innerHeight) continue;
    const t = (el.innerText || "").replace(/\\s+/g, " ").trim();
    if (t.length > 3) texts.push(t.slice(0, 200));
  }
  return JSON.stringify({ url: location.href, title: document.title, ready: document.readyState, elements: picked.slice(0, ${MAX_ELEMENTS}), texts });
})()`;

/** Pure: a page dump and where the page sits in the window, as the Observation jev/cua.ts reads. */
export function pageObservation(dump: PageDump, frames: string[], geometry: { area: [number, number, number, number]; scale: number }): Observation {
  const [left, top] = geometry.area, px = (css: number) => Math.round(css / geometry.scale);
  const elements: UiElement[] = dump.elements.map((e, i) => ({
    id: `e${i + 1}`, source: "atspi", role: e.role, name: e.name, value: e.value, editable: e.editable, focused: e.focused,
    within: e.within, frame: frames[0] ?? dump.title,
    rect: { x: left + px(e.x), y: top + px(e.y), w: Math.max(1, px(e.w)), h: Math.max(1, px(e.h)) },
  }));
  const texts = [`page: ${dump.title}`, `address: ${dump.url}`, ...(dump.ready === "complete" ? [] : ["the page is still loading"]), ...dump.texts];
  const seen = JSON.stringify([dump.url, dump.title, dump.ready, elements.map((e) => [e.role, e.name, e.value, e.focused, e.editable, e.within, e.rect]), dump.texts]);
  return { elements, texts, frames, fingerprint: Bun.hash(seen).toString(16) };
}

/** The hand's screen for Jev. No elements means Jev cannot work here, and its loop hands over. */
export async function observeHand(hand: Hand): Promise<Observation> {
  const front = await frontOf(hand);
  const frames = front ? [front.title] : [];
  // Between two pages there is a moment with nothing to read. An empty screen sends
  // jev/cua.ts to the vision planner, which costs ten seconds; waiting costs far less.
  const started = performance.now();
  for (let attempt = 0; attempt < 12; attempt++) {
    const window = await browserWindow(hand);
    if (!window) { debugLog("win.observe", { hand: hand.id, attempt, front: front?.title, why: "the front window is not this hand's browser" }); break; }
    const page = handBrowser(hand), geometry = await page.geometry(window), raw = geometry && await page.evaluate(window, READ_PAGE);
    if (geometry && typeof raw === "string") {
      const dump = JSON.parse(raw) as PageDump;
      // A page is usable long before it has finished loading: on a slow network the
      // search box is there seconds before the last script. A handful of elements, or
      // any field, is a page Jev can start on; the loop looks again after every action.
      const usable = dump.elements.some((e) => e.editable) || dump.elements.length >= 5;
      if (usable || dump.ready === "complete" || attempt >= 8) {
        debugLog("win.observe", { hand: hand.id, attempt, ms: Math.round(performance.now() - started), elements: dump.elements.length, ready: dump.ready, url: dump.url.slice(0, 80) });
        return pageObservation(dump, [window.title], geometry);
      }
    } else debugLog("win.observe", { hand: hand.id, attempt, ms: Math.round(performance.now() - started), geometry: Boolean(geometry), read: typeof raw });
    await Bun.sleep(250);
  }
  return { elements: [], texts: [], frames, fingerprint: `native:${frames.join("|")}` };
}

/** Wait until the page can be read, or long enough. The DOM being there is
 * enough for Jev; images and scripts may still be arriving. */
export async function pageSettled(hand: Hand, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  // A navigation can start a new renderer process, which Windows would throttle again.
  const pid = browserPid(hand);
  if (pid) void boost(pid);
  await Bun.sleep(80); // let a navigation that was just asked for begin
  while (Date.now() < until) {
    const window = await browserWindow(hand);
    if (!window) return;
    const ready = await handBrowser(hand).evaluate(window, "location.href === 'about:blank' ? 'blank' : document.readyState");
    if (ready === "interactive" || ready === "complete") return;
    await Bun.sleep(120);
  }
}
