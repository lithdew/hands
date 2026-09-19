import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { applyMarks, createMarkMemory, decodePng, decompose, drawMarks, encodePng, flatRegions, learn, legendOf, offerReadable, phrasesOf, recall, signatureOf, similarity, snapPlan, subcell,
  type Bitmap, type Caption, type Markable, type OcrLine } from "./marks";
import type { Rect, UiElement } from "./observe";

const SCREEN = { width: 400, height: 300 };
type Colour = [number, number, number];
function canvas(width = SCREEN.width, height = SCREEN.height, [r, g, b]: Colour = [233, 235, 239]): Bitmap {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
  return { width, height, data };
}
function paint(b: Bitmap, rect: Rect, [r, g, bl]: Colour): void {
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) { const o = (y * b.width + x) * 4; b.data[o] = r; b.data[o + 1] = g; b.data[o + 2] = bl; }
}
/** A crude icon: a box with a diagonal, or with a bar, so two kinds of icon differ in their pixels. */
function icon(b: Bitmap, rect: Rect, kind: "slash" | "bar"): void {
  paint(b, rect, [255, 255, 255]);
  for (let i = 4; i < rect.w - 4; i++) paint(b, kind === "slash" ? { x: rect.x + i, y: rect.y + i, w: 2, h: 2 } : { x: rect.x + i, y: rect.y + Math.floor(rect.h / 2), w: 1, h: 3 }, [30, 30, 30]);
}
const el = (id: string, role: string, name: string, rect: Rect, extra: Partial<UiElement> = {}): UiElement => ({ id, source: "atspi", role, name, value: "", editable: false, focused: false, within: "", frame: "App", rect, ...extra });
const word = (t: string, x: number, y: number, w = t.length * 8, h = 12) => ({ t, x, y, w, h });
const caption = (mark: string, name: string, extra: Partial<Caption> = {}): Caption => ({ mark, name, role: "button", container: "", editable: false, at: null, ...extra });

describe("png", () => {
  test("what is written is read back, and a mark changes the pixels under it", () => {
    const b = canvas(64, 40); paint(b, { x: 10, y: 10, w: 20, h: 10 }, [224, 49, 49]);
    const back = decodePng(encodePng(b));
    expect([back.width, back.height]).toEqual([64, 40]);
    expect(Buffer.from(back.data).equals(Buffer.from(b.data))).toBe(true);
    const drawn = drawMarks(b, [{ label: "7", id: "m7", kind: "region", rect: { x: 10, y: 20, w: 20, h: 10 }, role: "region", name: "", within: "", editable: false }]);
    expect(Buffer.from(drawn.data).equals(Buffer.from(b.data))).toBe(false);
    expect(Buffer.from(b.data).equals(Buffer.from(canvas(64, 40).data))).toBe(false);   // the source is never drawn on
  });
  test("reads what Chrome writes: every filter type, no alpha", async () => {
    const shot = decodePng(new Uint8Array(await Bun.file(join(import.meta.dir, "fixtures", "marks", "verify.png")).arrayBuffer()));
    expect([shot.width, shot.height]).toEqual([1280, 800]);
    const at = (x: number, y: number) => [...shot.data.subarray((y * 1280 + x) * 4, (y * 1280 + x) * 4 + 3)];
    expect(at(5, 5)).toEqual([255, 255, 255]);        // the header
    expect(at(5, 700)).toEqual([244, 245, 247]);      // the page behind the card
  });
  test("refuses what it cannot read instead of guessing", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow("not a PNG");
  });
});

describe("what pixels alone can tell", () => {
  test("a swatch is a region; the dot in a size button is not a second one; the drawing area is too large to be a control", () => {
    const b = canvas(); paint(b, { x: 150, y: 20, w: 240, h: 270 }, [255, 255, 255]);
    paint(b, { x: 20, y: 40, w: 40, h: 38 }, [224, 49, 49]); paint(b, { x: 20, y: 100, w: 32, h: 32 }, [255, 255, 255]); paint(b, { x: 30, y: 110, w: 12, h: 12 }, [20, 20, 20]);
    const found = flatRegions(b, { x: 0, y: 0, ...{ w: 400, h: 300 } });
    expect(found).toContainEqual({ x: 20, y: 40, w: 40, h: 38 });
    expect(found).toContainEqual({ x: 20, y: 100, w: 32, h: 32 });
    expect(found.some((r) => r.w === 12)).toBe(false);
    expect(found.some((r) => r.w >= 240)).toBe(true);   // 240x270 is under the cap; a full drawing area is not:
    expect(flatRegions(canvas(800, 500, [255, 255, 255]), { x: 0, y: 0, w: 800, h: 500 })).toEqual([]);
  });
  test("the same icon has the same signature wherever it sits; another icon, or another colour, has not", () => {
    const b = canvas(); icon(b, { x: 10, y: 10, w: 30, h: 30 }, "slash"); icon(b, { x: 10, y: 60, w: 30, h: 30 }, "slash"); icon(b, { x: 60, y: 10, w: 30, h: 30 }, "bar");
    paint(b, { x: 200, y: 10, w: 30, h: 30 }, [224, 49, 49]); paint(b, { x: 200, y: 60, w: 30, h: 30 }, [28, 126, 214]);
    const sig = (x: number, y: number) => signatureOf(b, { x, y, w: 30, h: 30 });
    expect(sig(10, 10)).toBe(sig(10, 60));
    expect(sig(10, 10)).not.toBe(sig(60, 10));
    expect(sig(200, 10)).not.toBe(sig(200, 60));
  });
  test("a line of OCR is cut where a person sees separate labels", () => {
    const line: OcrLine = { text: "New Open Export PNG", words: [word("New", 150, 60, 28), word("Open", 212, 60, 34), word("Export", 357, 60, 44), word("PNG", 405, 60, 28)] };
    expect(phrasesOf([line]).map((p) => p.text)).toEqual(["New", "Open", "Export PNG"]);
    expect(phrasesOf([{ text: "o", words: [word("o", 5, 5, 8)] }])).toEqual([]);   // what the engine makes of an icon
  });
  test("similarity is about shared words, whatever the case and punctuation", () => {
    expect(similarity("Find a table", "find a table now")).toBe(1);
    expect(similarity("Gallery", "Help")).toBe(0);
  });
});

describe("decompose", () => {
  const known = [el("e1", "link", "Gallery", { x: 300, y: 5, w: 50, h: 16 }), el("e2", "button", "Open", { x: 20, y: 30, w: 60, h: 24 }), el("e3", "button", "Open", { x: 20, y: 60, w: 60, h: 24 })];
  function screen() {
    const b = canvas(); paint(b, { x: 0, y: 100, w: 400, h: 200 }, [213, 217, 224]);
    paint(b, { x: 20, y: 120, w: 80, h: 30 }, [255, 255, 255]);                                  // a button drawn on the canvas, labelled "Save"
    paint(b, { x: 20, y: 170, w: 40, h: 38 }, [224, 49, 49]);                                    // a swatch
    icon(b, { x: 100, y: 30, w: 24, h: 24 }, "slash"); icon(b, { x: 100, y: 60, w: 24, h: 24 }, "slash");
    return b;
  }
  const obs: Markable = { elements: known, texts: [], frames: ["App"], fingerprint: "f",
    unnamed: [{ role: "button", rect: { x: 100, y: 30, w: 24, h: 24 }, row: "report.pdf", after: 2 }, { role: "button", rect: { x: 100, y: 60, w: 24, h: 24 }, row: "invoice.pdf", after: 3 }],
    opaque: [{ kind: "canvas", rect: { x: 0, y: 100, w: 400, h: 200 } }] };
  const ocr = async (): Promise<OcrLine[]> => [{ text: "Save", words: [word("Save", 44, 129, 32)] }, { text: "Gallery", words: [word("Gallery", 302, 6, 46)] }, { text: "My files", words: [word("My", 150, 40, 16), word("files", 170, 40, 30)] }];

  test("unnamed controls, OCR and regions only where the tree is blind, a grid only there, and known elements keep their numbers", async () => {
    const marks = await decompose(obs, encodePng(screen()), SCREEN, { ocr });
    const by = (kind: string) => marks.marks.filter((m) => m.kind === kind);
    expect(by("known").map((m) => [m.label, m.id])).toEqual([["1", "e1"], ["2", "e2"], ["3", "e3"]]);
    expect(by("unnamed").map((m) => [m.id, m.within, m.sameAs])).toEqual([["m4", "report.pdf", undefined], ["m5", "invoice.pdf", "4"]]);
    // "Save" takes the rectangle of the box it sits in; "Gallery" is the link's own text; "My files" is outside the blind spot.
    expect(by("text").map((m) => [m.name, m.rect, m.within])).toEqual([["Save", { x: 20, y: 120, w: 80, h: 30 }, "canvas"]]);
    expect(by("region").map((m) => m.rect)).toEqual([{ x: 20, y: 170, w: 40, h: 38 }]);
    expect(by("cell").length).toBeGreaterThan(0);
    expect(by("cell").every((m) => m.rect.y >= 100 && /^m[A-H][1-6]$/.test(m.id))).toBe(true);
    expect(marks.drawn).toBe(true);
    expect(decodePng(marks.image).width).toBe(400);
    expect(legendOf(marks.marks).find((l) => l.startsWith("5:"))).toBe('5: looks the same as 4, in "invoice.pdf"');
  });
  test("no OCR is asked for where the tree sees everything, and a screenshot that cannot be read still leaves the DOM marks", async () => {
    let asked = 0;
    const marks = await decompose({ ...obs, opaque: [] }, new Uint8Array([9, 9, 9]), SCREEN, { ocr: async () => { asked++; return []; } });
    expect(asked).toBe(0);
    expect(marks.drawn).toBe(false);
    expect(marks.marks.filter((m) => m.kind === "unnamed")).toHaveLength(2);
    expect(legendOf(marks.marks, { coords: true }).find((l) => l.startsWith("4:"))).toContain("at x=100 y=30 w=24 h=24");
  });
  test("a capture at twice the size is read in its own pixels and answered in the hand's", async () => {
    const big = canvas(800, 600); paint(big, { x: 0, y: 200, w: 800, h: 400 }, [213, 217, 224]); paint(big, { x: 40, y: 340, w: 80, h: 76 }, [224, 49, 49]);
    const marks = await decompose({ ...obs, unnamed: [] }, encodePng(big), SCREEN, {});
    expect(marks.marks.filter((m) => m.kind === "region").map((m) => m.rect)).toEqual([{ x: 20, y: 170, w: 40, h: 38 }]);
  });
  test("an empty tree makes the whole screen a blind spot", async () => {
    const marks = await decompose({ elements: [], texts: [], frames: [], fingerprint: "native" }, encodePng(screen()), SCREEN, { ocr });
    expect(marks.marks.filter((m) => m.kind === "text").map((m) => m.name).sort()).toEqual(["Gallery", "My files", "Save"]);
  });

  test("captioned marks join Jev's list where a reader meets them, behind measured rectangles; a look-alike keeps its own row", async () => {
    const marks = await decompose(obs, encodePng(screen()), SCREEN, { ocr }), swatch = marks.marks.find((m) => m.kind === "region")!, save = marks.marks.find((m) => m.name === "Save")!;
    const seen = applyMarks(obs, marks, { captions: [caption("4", "Delete", { container: "report.pdf" }), caption(swatch.label, "Red", { role: "colour swatch" }), caption(save.label, "Save"), caption("2", "Renamed"), caption("99", "Ghost")] });
    expect(seen.elements.map((e) => e.id)).toEqual(["e1", "e2", "m4", "e3", "m5", save.id, swatch.id]);
    expect(seen.elements.find((e) => e.id === "m5")).toMatchObject({ source: "vision", name: "Delete", within: "invoice.pdf", rect: { x: 100, y: 60, w: 24, h: 24 } });
    expect(seen.elements.find((e) => e.id === "e2")!.name).toBe("Open");   // a planner cannot rename what the observer named
    expect(seen.fingerprint).toBe("f");
  });
  test("a grid cell is refined once, in words", () => {
    expect(subcell({ x: 160, y: 133, w: 160, h: 133 }, "top right")).toEqual({ x: 267, y: 133, w: 53, h: 44 });
    expect(subcell({ x: 160, y: 133, w: 160, h: 133 }, null)).toEqual({ x: 160, y: 133, w: 160, h: 133 });
  });
  test("before any model: OCR text in a blind spot is offered as it is", async () => {
    const marks = await decompose(obs, encodePng(screen()), SCREEN, { ocr });
    expect(offerReadable(obs, marks).elements.filter((e) => e.source === "vision").map((e) => [e.role, e.name, e.within])).toEqual([["text", "Save", "canvas"]]);
  });
  test("a guessed rectangle is moved onto the mark it falls on, and left alone when it falls on none", async () => {
    const marks = await decompose(obs, encodePng(screen()), SCREEN, { ocr });
    const plan = snapPlan({ elements: [{ role: "button", name: "Save", rect: { x: 30, y: 126, w: 50, h: 20 } }, { role: "button", name: "Nowhere", rect: { x: 300, y: 250, w: 10, h: 10 } }] }, marks);
    expect(plan.elements.map((e) => e.rect)).toEqual([{ x: 20, y: 120, w: 80, h: 30 }, { x: 300, y: 250, w: 10, h: 10 }]);
  });
});

describe("memory", () => {
  const base: Markable = { elements: [el("e1", "link", "report.pdf", { x: 20, y: 30, w: 60, h: 20 })], texts: [], frames: ["App"], fingerprint: "a",
    unnamed: [{ role: "button", rect: { x: 100, y: 30, w: 24, h: 24 }, row: "report.pdf", after: 1 }], opaque: [{ kind: "canvas", rect: { x: 0, y: 100, w: 400, h: 200 } }] };
  function shot(colour: Colour = [224, 49, 49]) { const b = canvas(); icon(b, { x: 100, y: 30, w: 24, h: 24 }, "slash"); paint(b, { x: 0, y: 100, w: 400, h: 200 }, [213, 217, 224]); paint(b, { x: 20, y: 170, w: 40, h: 38 }, colour); return encodePng(b); }

  test("a caption of a DOM control comes back for free on the same screen, at wherever the control is now", async () => {
    const memory = createMarkMemory(), marks = await decompose(base, shot(), SCREEN, {}), swatch = marks.marks.find((m) => m.kind === "region")!;
    learn(memory, base, marks, { captions: [caption("2", "Delete"), caption(swatch.label, "Red")] });
    const scrolled: Markable = { ...base, fingerprint: "b", elements: [{ ...base.elements[0]!, rect: { x: 20, y: 10, w: 60, h: 20 } }], unnamed: [{ ...base.unnamed![0]!, rect: { x: 100, y: 10, w: 24, h: 24 } }] };
    const again = recall(memory, scrolled);
    expect(again.elements.map((e) => [e.id, e.name, e.rect.y])).toEqual([["e1", "report.pdf", 10], ["m2", "Delete", 10]]);
    expect(recall(memory, { ...scrolled, elements: [...scrolled.elements, el("e2", "button", "New dialog", { x: 1, y: 1, w: 9, h: 9 })] }).elements).toHaveLength(2);   // another screen: nothing is put back
  });
  test("a caption that rests on pixels comes back only against a screenshot that still shows the same thing there", async () => {
    const memory = createMarkMemory(), marks = await decompose(base, shot(), SCREEN, {}), swatch = marks.marks.find((m) => m.kind === "region")!;
    learn(memory, base, marks, { captions: [caption(swatch.label, "Red", { role: "colour swatch" })] });
    expect(recall(memory, base).elements.map((e) => e.name)).toEqual(["report.pdf"]);
    expect(recall(memory, base, shot()).elements.map((e) => e.name)).toEqual(["report.pdf", "Red"]);
    expect(recall(memory, base, shot([28, 126, 214])).elements.map((e) => e.name)).toEqual(["report.pdf"]);
  });
  test("an icon captioned once is not asked about again, on any screen", async () => {
    const memory = createMarkMemory(), marks = await decompose(base, shot(), SCREEN, {});
    learn(memory, base, marks, { captions: [caption("2", "Delete")] });
    const elsewhere: Markable = { ...base, elements: [el("e1", "link", "other.pdf", { x: 20, y: 30, w: 60, h: 20 })], unnamed: [{ role: "button", rect: { x: 100, y: 30, w: 24, h: 24 }, row: "other.pdf", after: 1 }] };
    const next = await decompose(elsewhere, shot(), SCREEN, { memory });
    expect(next.marks.find((m) => m.kind === "unnamed")).toMatchObject({ name: "Delete", learned: true });
    expect(legendOf(next.marks).find((l) => l.startsWith("2:"))).toContain("captioned before");
    expect(applyMarks(elsewhere, next, { captions: [] }).elements.map((e) => [e.name, e.within])).toEqual([["other.pdf", ""], ["Delete", "other.pdf"]]);
  });
});
