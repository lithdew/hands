/**
 * What Jev reads instead of pixels: a screen as a list of labelled elements, `e7: button "Send" (top right, in "New Message")`.
 *
 * Jev picks a label; the rectangle behind it never leaves this program. A web page is read from its own DOM in
 * one DevTools round trip, and any other window from its UI Automation tree (windows.cs `tree`). Both are pure
 * here: hand.ts runs the scripts and the helper.
 *
 * A page also lists the controls it has but does not show, unmarked and in reading order. Measured on the
 * simulated pages with a fold (27 runs): 15 solved when only the viewport was offered, 27 with these, and 24
 * when they were marked "not visible". Whether a control is in view says nothing about whether it is the right one.
 */

import type { UiaNode } from "./windows.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UiElement {
  /** The label Jev picks: "e1".."eN" on a page, "n1".."nN" in a native window. Only valid within one Observation. */
  id: string;
  role: string;
  name: string;
  /** What a field holds, or a dropdown shows. Never read for a password field. */
  value: string;
  editable: boolean;
  focused: boolean;
  /** Nearest named container: a dialog, a form, a toolbar. */
  within: string;
  /** Page: CSS pixels of the viewport. Native: pixels of the window. */
  rect: Rect;
  /** A native dropdown's choices. screen.ts sets one without opening it. */
  options?: string[];
  /** Page: which node of the look this is. Native: the control's UI Automation reference. */
  ref: number | string;
  secret?: boolean;
}

export interface Observation {
  elements: UiElement[];
  /** Headings, labels and other text on screen, for context. Untrusted. */
  texts: string[];
  title: string;
  /** Width and height the rectangles are measured in, so "top right" means something. */
  size: [number, number];
  /** Changes when the screen changes. Compared before and after an action. */
  fingerprint: string;
}

/** ground.eval.ts in the old tree: shown all 700 elements of a real page in reading order, Jev picked right 98% of the time; cut off at 150, 54%. */
export const MAX_ELEMENTS = 300;
const MAX_BEYOND = 120;
/** A Choice takes 255 labels; a dropdown with more than this (a list of countries) is opened and searched instead. */
const MAX_OPTIONS = 120;
/** Fewer controls than this and Jev has nothing to work with: a canvas, a game, a window that publishes nothing. */
export const READABLE = 3;

/** Where on the screen, in words. Jev reads "top right" better than "1180, 40". What is past an edge reads as that edge: it is not marked. */
export function regionOf(rect: Rect, [width, height]: [number, number]): string {
  const [cx, cy] = [rect.x + rect.w / 2, rect.y + rect.h / 2];
  const col = cx < width / 3 ? "left" : cx < (width * 2) / 3 ? "center" : "right";
  const row = cy < height / 3 ? "top" : cy < (height * 2) / 3 ? "middle" : "bottom";
  return row === "middle" && col === "center" ? "center" : `${row} ${col}`;
}

/** The words Jev reads for one element. */
export function describeElement(el: UiElement, size: [number, number]): string {
  const parts = [el.role, el.name ? JSON.stringify(el.name) : "(no name)"];
  if (el.editable) parts.push(el.value ? `containing ${JSON.stringify(el.value)}` : "empty");
  if (el.focused) parts.push("focused");
  const where = [regionOf(el.rect, size)];
  if (el.within && el.within !== el.name) where.push(`in ${JSON.stringify(el.within)}`);
  return `${parts.join(" ")} (${where.join(", ")})`;
}

export const centerOf = (rect: Rect): [number, number] => [Math.round(rect.x + rect.w / 2), Math.round(rect.y + rect.h / 2)];

// ------------------------------------------------------------------ a web page

interface PageElement extends Rect {
  i: number;
  role: string;
  name: string;
  value: string;
  editable: boolean;
  focused: boolean;
  within: string;
  secret: boolean;
  options?: string[];
}
export interface PageDump {
  url: string;
  title: string;
  ready: string;
  view: [number, number];
  elements: PageElement[];
  texts: string[];
}

/**
 * Runs in the page. What a person could use: named, not covered, inside the viewport, plus what the page scrolls
 * to vertically (never what is off to the side: a carousel's next slides, a closed drawer). The nodes stay in the
 * page under a token, so an action finds the very node again instead of looking for it by words.
 */
export const readPage = (token: string): string => `(() => {
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
    return box ? clean(box.getAttribute("aria-label") || box.getAttribute("role") || box.tagName.toLowerCase()) : "";
  };
  // An open dialog owns the page: nothing behind it can be used, in view or not.
  const modal = document.querySelector("dialog[open],[role=dialog][aria-modal=true]");
  const nodes = [], picked = [];
  let beyond = 0;
  const selector = "a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=textbox],[role=searchbox],[role=combobox],[role=tab],[role=menuitem],[role=checkbox],[role=option],[contenteditable=''],[contenteditable=true]";
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.right <= 0 || r.left >= innerWidth || el.disabled) continue;
    if (el.checkVisibility ? !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : getComputedStyle(el).visibility === "hidden") continue;
    const outside = r.bottom <= 0 || r.top >= innerHeight;
    if (outside) {
      if (beyond >= ${MAX_BEYOND} || (modal && !modal.contains(el)) || el.closest("[aria-hidden=true],[inert]")) continue;
    } else {
      const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
      if (hit && !el.contains(hit) && !hit.contains(el)) continue;
    }
    const role = roleOf(el), editable = ["text field", "password field", "textbox", "searchbox", "combobox"].includes(role);
    const name = nameOf(el);
    if (!name && !editable) continue;
    if (outside) beyond++;
    // A native dropdown shows its option's words, not its value attribute, and its choices can be read without opening it.
    const chosen = el.tagName === "SELECT" && el.selectedOptions[0] ? clean(el.selectedOptions[0].text) : null;
    const options = el.tagName === "SELECT" && !el.multiple ? [...new Set([...el.options].filter((o) => !o.disabled).map((o) => clean(o.text)).filter(Boolean))].slice(0, ${MAX_OPTIONS}) : [];
    picked.push({ i: nodes.length, role, name, editable, focused: document.activeElement === el, within: within(el), secret: role === "password field",
      inDialog: Boolean(el.closest("[role=dialog],dialog")),
      value: role === "password field" ? "" : chosen ?? (typeof el.value === "string" ? el.value : el.isContentEditable ? el.innerText : "").replace(/\\s+/g, " ").trim().slice(0, 400),
      ...(options.length > 1 ? { options } : {}), x: r.left, y: r.top, w: r.width, h: r.height });
    nodes.push(el);
  }
  window.__hands = { token: ${JSON.stringify(token)}, nodes };
  // Reading order is kept: a "7:00 PM" button is told from its twins by the row it is read next to. The cap never costs a field, or anything in an open dialog.
  const elements = picked.filter((e, n) => n < ${MAX_ELEMENTS} || e.editable || e.inDialog);
  const texts = [];
  for (const el of new Set([...document.querySelectorAll("[role=alert],[role=status],[role=dialog],dialog"), ...document.querySelectorAll("h1,h2,h3,[role=heading],p,li,td")])) {
    if (texts.length >= 14) break;
    const r = el.getBoundingClientRect();
    if (r.height < 4 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth || (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))) continue;
    const t = (el.innerText || "").replace(/\\s+/g, " ").trim();
    if (t.length > 3) texts.push(t.slice(0, 200));
  }
  return JSON.stringify({ url: location.href, title: document.title, ready: document.readyState, view: [innerWidth, innerHeight], elements, texts });
})()`;

/** Runs in the page. The node's rectangle once it is in view with nothing over it, scrolled there if it was not; else null. */
export const revealNode = (token: string, index: number): string => `(() => {
  const kept = window.__hands, el = kept && kept.token === ${JSON.stringify(token)} ? kept.nodes[${Number(index)}] : null;
  if (!el || !el.isConnected) return null;
  let r = el.getBoundingClientRect();
  if (r.bottom <= 0 || r.top >= innerHeight) { el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); r = el.getBoundingClientRect(); }
  if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.top >= innerHeight) return null;
  const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
  if (!hit || (!el.contains(hit) && !hit.contains(el))) return null;
  return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
})()`;

/** Runs in the page. Sets the node, a native dropdown, to the option with these words. "set", or why not. */
export const selectOption = (token: string, index: number, option: string): string => `(() => {
  const kept = window.__hands, select = kept && kept.token === ${JSON.stringify(token)} ? kept.nodes[${Number(index)}] : null;
  if (!select || select.tagName !== "SELECT") return "no dropdown there";
  const want = ${JSON.stringify(option)}.replace(/\\s+/g, " ").trim().toLowerCase();
  const found = [...select.options].find((o) => !o.disabled && (o.text || "").replace(/\\s+/g, " ").trim().toLowerCase().slice(0, 80) === want);
  if (!found) return "no such option";
  select.value = found.value;
  // Frameworks listen for these, not for the property changing.
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return "set";
})()`;

/** A page dump as the Observation screen.ts reads. Whether a control is in view is not part of what the screen is, so a scroll alone changes no fingerprint. */
export function pageObservation(dump: PageDump): Observation {
  const elements: UiElement[] = dump.elements.map((e, n) => ({
    id: `e${n + 1}`, role: e.role, name: e.name, value: e.value, editable: e.editable, focused: e.focused, within: e.within, ref: e.i,
    rect: { x: e.x, y: e.y, w: Math.max(1, e.w), h: Math.max(1, e.h) }, ...(e.options?.length ? { options: e.options } : {}), ...(e.secret ? { secret: true } : {}),
  })); // prettier-ignore
  const texts = [`page: ${dump.title}`, `address: ${dump.url}`, ...(dump.ready === "complete" ? [] : ["the page is still loading"]), ...dump.texts];
  const seen = JSON.stringify([dump.url, dump.title, dump.ready, elements.map((e) => [e.role, e.name, e.value, e.focused, e.within]), dump.texts]);
  return { elements, texts, title: dump.title, size: dump.view, fingerprint: Bun.hash(seen).toString(16) };
}

// ------------------------------------------------------------------ any other window

const NATIVE_ROLES: Record<string, string> = { Edit: "text field", Document: "text field", CheckBox: "checkbox", ComboBox: "dropdown", Hyperlink: "link", TabItem: "tab", ListItem: "list item", MenuItem: "menu item", RadioButton: "radio button", SplitButton: "button", TreeItem: "list item" }; // prettier-ignore
const PRESSES = ["invoke", "toggle", "select", "expand"];

/** One window's UI Automation tree as an Observation. Only what can be operated from behind is offered: a press is a pattern, a text is a value. */
export function nativeObservation(nodes: UiaNode[], title: string, frame: [number, number, number, number]): Observation {
  const [left, top, width, height] = frame;
  const texts = nodes.filter((n) => n.type === "Text" && n.name.trim() && !n.offscreen).slice(0, 24).map((n) => n.name.trim().slice(0, 200));
  const elements: UiElement[] = [];
  for (const node of nodes) {
    const editable = ["Edit", "Document"].includes(node.type) && node.actions.includes("value");
    if (!node.enabled || !node.frame || (!editable && !node.actions.some((a) => PRESSES.includes(a)))) continue;
    const name = (node.name || node.help).replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name && !editable) continue;
    // The nearest ancestor with a name of its own: a toolbar, a group, a pane.
    let within = "";
    for (let up = nodes[node.parent]; up && !within; up = nodes[up.parent]) if (up.name && up.name !== name && up.name !== title) within = up.name.slice(0, 80);
    elements.push({
      id: `n${elements.length + 1}`, role: NATIVE_ROLES[node.type] ?? node.type.toLowerCase(), name, value: node.password ? "" : node.value.replace(/\s+/g, " ").trim().slice(0, 400), editable, focused: node.focused, within, ref: node.ref,
      rect: { x: node.frame[0] - left, y: node.frame[1] - top, w: Math.max(1, node.frame[2]), h: Math.max(1, node.frame[3]) }, ...(node.password ? { secret: true } : {}),
    }); // prettier-ignore
    if (elements.length >= MAX_ELEMENTS) break;
  }
  const seen = JSON.stringify([title, elements.map((e) => [e.role, e.name, e.value, e.focused]), texts]);
  return { elements: elements.length < READABLE ? [] : elements, texts: [`window: ${title}`, ...texts], title, size: [width, height], fingerprint: `native:${Bun.hash(seen).toString(16)}` };
}

export const isNative = (el: UiElement): boolean => typeof el.ref === "string";
