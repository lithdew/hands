import { expect, test } from "bun:test";
import { APIConnectionError, APITimeoutError, BadRequestError, type ChoiceQuestion } from "@typesafe-ai/sdk";
import { SITES } from "../src/config.ts";
import { chosenField, combine, Decision, failure, itemLine, kindCriteria, NONE, type Offer, readAnswers, request, siteCriteria, tooLarge } from "../src/decide.ts";
import { type AxNode, item, type Item } from "../src/models.ts";
import { offscreenFor } from "../src/perception.ts";
import { answer, makeItem, screen } from "./helpers.ts";

const control = (index: number, text: string, role: string, extra: Partial<Item> = {}): Item => ({ ...item(index, text, 1, [100, 100 + index * 40, 400, 130 + index * 40], role, "ax"), ...extra });
const node = (label: string, role = "AXLink"): AxNode => ({ role, label, x: 0, y: -4000, w: 100, h: 20, pressable: true, ref: { label } });
const criteria = (question: unknown) => (question as ChoiceQuestion).criteria;
const offer = (overrides: Partial<Offer> = {}): Offer => ({ items: true, fields: false, text: null, write: false, email: null, offscreen: false, browse: null, ...overrides });

test("decision click uses item and min confidence", () => {
  const d = new Decision(answer("click_item", 0.9), answer("12", 0.6), answer("none", 1.0));
  expect(d.clicking).toBe(true);
  expect(d.chosen).toBe("12");
  expect(d.target).toBe("12");
  expect(d.confidence).toBe(0.6);
});

test("decision fixed action ignores item", () => {
  const d = new Decision(answer("use_browser", 0.8), answer("3", 0.1), answer("github", 0.9));
  expect(d.clicking).toBe(false);
  expect(d.chosen).toBe("use_browser");
  expect(d.confidence).toBe(0.8);
});

test("decision press_offscreen uses the offscreen answer, whose o-prefixed id names the control's place", () => {
  const d = new Decision(answer("press_offscreen", 0.9), answer("3", 0.9), null, answer("o7", 0.5));
  expect(d.pressingOffscreen).toBe(true);
  expect(d.chosen).toBe("offscreen:7");
  expect(d.confidence).toBe(0.5);
  expect(new Decision(answer("click_item", 0.9), answer("3", 0.8), null, answer("o7", 0.1)).chosen).toBe("3");
});

test("each answer is held to its own bar: the kind to the run's, an item to 0.5, a field to 0.3", () => {
  const typing = (field: number) => new Decision(answer("type_text", 0.9), null, null, null, { field: answer("4", field) });
  expect(new Decision(answer("scroll_down", 0.3), null, null).doubt(0.4)).toBe("kind 'scroll_down' at 0.30, below 0.4");
  expect(new Decision(answer("click_item", 0.9), answer("12", 0.45), null).doubt(0.4)).toBe("item '12' at 0.45, below 0.5");
  expect(new Decision(answer("click_item", 0.9), answer("12", 0.55), null).doubt(0.4)).toBeNull();
  expect(typing(0.35).doubt(0.4)).toBeNull();
  expect(typing(0.25).doubt(0.4)).toBe("field '4' at 0.25, below 0.3");
  expect(typing(0.35).target).toBe("4");
});

test("done needs the screen to show it: goal_met 0.8 alone, or 0.5 with the kind agreeing; a reply without goal_met leaves it to the kind", () => {
  const with_ = (kind: string, goalMet: number | null) => new Decision(answer(kind, 0.9), answer("1", 0.9), null, null, { goalMet });
  expect(with_("click_item", 0.85).done).toBe(true);
  expect(with_("click_item", 0.6).done).toBe(false);
  expect(with_("done", 0.6).done).toBe(true);
  expect(with_("done", 0.3).done).toBe(false);
  expect(with_("done", null).done).toBe(true);
});

test("a kind whose target question said none_of_these has nothing to act on", () => {
  const d = new Decision(answer("click_item", 0.9), answer(NONE, 0.8), null);
  expect(d.clicking).toBe(false);
  expect(d.targetless).toBe(true);
  expect(d.chosen).toBe("click_item");
  expect(new Decision(answer("type_text", 0.9), null, null, null, { field: answer(NONE, 0.9) }).targetless).toBe(true);
  expect(new Decision(answer("scroll_down", 0.9), null, null).targetless).toBe(false);
});

test("only kinds that can run are offered", () => {
  expect(kindCriteria(offer({ items: false }))).not.toHaveProperty("click_item");
  expect(kindCriteria(offer())).toHaveProperty("click_item");
  expect(kindCriteria(offer())).not.toHaveProperty("press_offscreen");
  expect(kindCriteria(offer({ offscreen: true }))).toHaveProperty("press_offscreen");
  // Typing needs a field, and text: the hand's own or a writer's. Return needs a field to submit.
  expect(kindCriteria(offer({ write: true }))).not.toHaveProperty("type_text");
  expect(kindCriteria(offer({ fields: true }))).not.toHaveProperty("type_text");
  expect(kindCriteria(offer({ fields: true }))).toHaveProperty("press_enter");
  expect(kindCriteria(offer())).not.toHaveProperty("press_enter");
  expect(kindCriteria(offer({ fields: true, text: "Grace Hopper" })).type_text).toContain("`text_to_type`");
  expect(kindCriteria(offer({ fields: true, write: true })).type_text).toContain("writing model");
  expect(kindCriteria(offer({ fields: true, email: "user@example.com" }))).toHaveProperty("type_email");
  expect(kindCriteria(offer({ email: "user@example.com" }))).not.toHaveProperty("type_email");
  // The browser and its catalog are `bun clicker`'s alone: a hand opens pages with its own `browser`.
  expect(kindCriteria(offer())).not.toHaveProperty("use_browser");
  expect(kindCriteria(offer({ browse: "Google Chrome" })).use_browser).toContain("Google Chrome");
  for (const always of ["press_escape", "scroll_down", "scroll_up", "wait", "done", "none"]) expect(kindCriteria(offer({ items: false }))).toHaveProperty(always);
});

test("site criteria covers the catalog, a site outside it, and no site", () => {
  const crit = siteCriteria();
  expect(crit.github).toBe(SITES.github!);
  expect(crit.other).toContain("not one of the sites named in this list");
  expect(crit.none).toContain("already open");
});

test("an item is one line: id, role, words cut short, what a field holds, where it is, and a date's distance", () => {
  const live = screen();
  expect(itemLine(live, control(12, "Charles Babbage", "link"))).toBe("12: link 'Charles Babbage' (middle-left)");
  expect(itemLine(live, makeItem(3, "Born 26 December 1791"), "dated 1791-12-26 (84000 days ago)")).toBe("3: text 'Born 26 December 1791' (top-left; dated 1791-12-26 (84000 days ago))");
  expect(itemLine(live, control(1, "Search Wikipedia", "field", { value: "" }))).toBe("1: field 'Search Wikipedia' empty (top-left)");
  expect(itemLine(live, control(1, "Search Wikipedia", "field", { value: "Grace Hopper" }))).toBe("1: field 'Search Wikipedia' containing 'Grace Hopper' (top-left)");
  expect(itemLine(live, control(1, "Search", "field"))).toBe("1: field 'Search' (top-left)"); // no value read: nothing claimed
  expect(itemLine(live, makeItem(0, "x".repeat(300)))).toBe(`0: text '${"x".repeat(100)}…' (top-left)`);
});

test("the items go once, in state, and the item question takes bare ids, with the direct wording and none_of_these", () => {
  const items = [control(0, "Main page", "link"), control(1, "Charles Babbage", "link"), makeItem(2, "Ada Lovelace")];
  const req = request({ goal: "open the Charles Babbage article", screen: screen({ url: "https://en.wikipedia.org/wiki/Ada_Lovelace" }), items, history: [] });
  expect(req.state.elements).toEqual(["0: link 'Main page' (top-left)", "1: link 'Charles Babbage' (top-left)", "2: text 'Ada Lovelace' (top-left)"]);
  expect(criteria(req.questions.item_0)).toEqual({ "0": null, "1": null, "2": null, [NONE]: "What `goal` needs is not in this list. An element that only has a similar name is not it." });
  expect((req.questions.item_0 as ChoiceQuestion).instructions).toStartWith("Which one element does the worker have to click now to carry out `goal`?");
  expect(Object.keys(req.questions).sort()).toEqual(["goal_met", "item_0", "kind", "stuck"]); // no field, no off-screen control, no site: nothing asked about them
  expect(req.questions.goal_met?.type).toBe("noul");
  expect(req.state).not.toHaveProperty("text_to_type");
  expect(req.state).toMatchObject({ goal: "open the Charles Babbage article", app: "Google Chrome", url: "https://en.wikipedia.org/wiki/Ada_Lovelace", history: [] });
});

test("past 250 items the item question is asked in parts, in one request, and the list in state stays whole", () => {
  const items = Array.from({ length: 600 }, (_, i) => makeItem(i, `row ${i}`));
  const req = request({ goal: "open row 599", screen: screen(), items, history: [] });
  expect(req.parts.map((part) => part.length)).toEqual([250, 250, 100]);
  expect(Object.keys(criteria(req.questions.item_2))).toEqual([...Array.from({ length: 100 }, (_, i) => String(500 + i)), NONE]);
  expect(req.state.elements).toHaveLength(600);
});

test("typing is asked about only with a field and text: a field question of bare ids, and whether Return follows", () => {
  const items = [control(0, "Search Wikipedia", "field", { value: "" }), control(1, "Search", "button")];
  const look = { goal: "search the site for Grace Hopper", screen: screen(), items, history: [] };
  expect(request(look).questions).not.toHaveProperty("field");
  const req = request({ ...look, text: "Grace Hopper" });
  expect(criteria(req.questions.field)).toEqual({ "0": null, [NONE]: "What `goal` needs is not in this list." });
  expect(req.questions.submit?.type).toBe("noul");
  expect(req.state.text_to_type).toBe("Grace Hopper");
  expect(criteria(req.questions.kind)).toHaveProperty("type_text");
});

test("off-screen controls: at most 40, those sharing most words with the goal, with labels cut to 80 and ids of their own", () => {
  const nodes = [...Array.from({ length: 100 }, (_, i) => node(`Footer link ${i}`)), node("Charles Babbage's Saturday night soirées"), node(`Charles Babbage ${"y".repeat(200)}`)];
  const shown = offscreenFor(nodes, "open the Charles Babbage article");
  expect(shown).toHaveLength(40);
  expect(shown).toContain(100);
  expect(shown).toContain(101);
  expect(shown).toEqual([...shown].sort((a, b) => a - b)); // in the app's order
  const req = request({ goal: "open the Charles Babbage article", screen: screen({ offscreen: nodes }), items: [makeItem(0, "Ada")], history: [] });
  expect(Object.keys(criteria(req.questions.offscreen))).toContain("o101");
  expect(criteria(req.questions.offscreen)["o101"]).toBeNull();
  const line = (req.state.offscreen_controls as string[]).find((l) => l.startsWith("o101: "))!;
  expect(line).toBe(`o101: link 'Charles Babbage ${"y".repeat(64)}…' (not visible)`);
  expect(request({ goal: "x", screen: screen({ offscreen: nodes }), items: [], history: [], offscreen: false }).questions).not.toHaveProperty("offscreen");
});

test("what was tried on this screen, and the site question only where use_browser is offered", () => {
  const req = request({ goal: "g", screen: screen(), items: [makeItem(0, "a")], history: ["scrolled down -> no visible change"], tried: ["scrolled down -> no visible change"], browse: "Google Chrome" });
  expect(req.state.already_tried_on_this_screen).toEqual(["scrolled down -> no visible change"]);
  expect(req.questions).toHaveProperty("site");
  expect(request({ goal: "g", screen: screen(), items: [], history: [] }).state).not.toHaveProperty("already_tried_on_this_screen");
});

test("parts are combined by the most confident one that picked something; none only when every part says none", () => {
  const a = answer(NONE, 0.9, { "1": 0.05, [NONE]: 0.9 });
  const b = answer("260", 0.7, { "260": 0.7, [NONE]: 0.2 });
  const c = answer("520", 0.6, { "520": 0.6, [NONE]: 0.3 });
  expect(combine([a, b, c])).toMatchObject({ choice: "260", confidence: 0.7 });
  expect(combine([a, b, c]).probabilities).toMatchObject({ "260": 0.7, "520": 0.6, "1": 0.05, [NONE]: 0.2 });
  expect(combine([a, answer(NONE, 0.8)])).toMatchObject({ choice: NONE, confidence: 0.8 });
});

test("answers are read back and checked for what the chosen kind needs: a missing answer or a label never offered is a problem, not an action", () => {
  const items = [control(0, "Pricing", "link"), control(1, "Search", "field", { value: "" })];
  const req = request({ goal: "open the Pricing page", screen: screen(), items, history: [], text: "shoes" });
  const read = (answers: Record<string, unknown>) => readAnswers(req, answers as never);
  expect(read({ kind: answer("click_item", 0.9), item_0: answer("0", 0.9), goal_met: { noul: 0.1 } }).extra.problem).toBeNull();
  expect(read({ item_0: answer("0", 0.9) }).extra.problem).toBe("the reply has no answer for the kind of action");
  expect(read({ kind: answer("use_browser", 0.9) }).extra.problem).toBe("the kind 'use_browser' was not offered");
  expect(read({ kind: answer("click_item", 0.9) }).extra.problem).toBe("the reply has no item answer");
  expect(read({ kind: answer("click_item", 0.9), item_0: answer("7", 0.9) }).extra.problem).toBe("the item_0 answer '7' was not offered");
  expect(read({ kind: answer("type_text", 0.9), field: answer("0", 0.9) }).extra.problem).toBe("the field answer '0' was not offered"); // a link is no field
  const typing = read({ kind: answer("type_text", 0.9), field: answer("1", 0.6), submit: { noul: 0.9 }, goal_met: { noul: 0.02 }, stuck: { noul: 0.1 } });
  expect(typing.extra).toMatchObject({ problem: null, submit: 0.9, goalMet: 0.02, stuck: 0.1 });
  expect(chosenField(typing, screen({ axRefs: new Map([[1, "ref-1"]]) }), items)).toMatchObject({ label: "Search", value: "", ref: "ref-1", x: 50, y: 70, w: 150, h: 15 });
  // An answer the kind does not need may be missing: done needs no item.
  expect(read({ kind: answer("done", 0.9) }).extra.problem).toBeNull();
});

test("a request over Jev's token limit is told from other failures, and a failure is said in a few words", () => {
  const big = new BadRequestError(400, { detail: { error_type: "max_tokens_exceeded" } }, new Headers());
  expect(tooLarge(big)).toBe(true);
  expect(tooLarge(new BadRequestError(400, { detail: { error_type: "invalid_request" } }, new Headers()))).toBe(false);
  expect(failure(big)).toBe("400 max_tokens_exceeded");
  expect(failure(new APITimeoutError(4000))).toBe("no answer within 4000 ms");
  expect(failure(new APIConnectionError("socket closed"))).toBe("no connection (socket closed)");
});
