/** Logging, annotated screenshots, and the human-readable payload dump. */

import { appendFileSync } from "node:fs";
import sharp from "sharp";
import { baseState, type ChoiceAnswer, itemCriteria, kindCriteria, offscreenCriteria, siteCriteria } from "./decide.ts";
import { fieldRecord, fromAx, type Item, region, repr, type Screen, toPoints } from "./models.ts";

const RULE = "=".repeat(78);

export type Log = (message?: string) => void;

/** Print and append to a file. */
export const makeLog =
  (path?: string): Log =>
  (message = "") => {
    console.log(message);
    if (path) appendFileSync(path, `${message}\n`);
  };

export const top = (answer: ChoiceAnswer, n = 5): [string, number][] =>
  Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);

export const axCount = (items: Item[]): number => items.filter(fromAx).length;

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** Exactly what goes to TypeSafe for this screen, plus a table of every item. */
export function renderPayload(goal: string, screen: Screen, items: Item[], history: string[], browser: string, email: string | null): string {
  const parts = [
    RULE, "STATE  (sent as `state`)", RULE, json(baseState(goal, screen, items, history)), "",
    RULE, "QUESTION kind  (Choice criteria)", RULE, json(kindCriteria(browser, email, screen.offscreen.length > 0)), "",
    RULE, "QUESTION item  (Choice criteria)", RULE, json(itemCriteria(screen, items)), "",
    RULE, "QUESTION site  (Choice criteria)", RULE, json(siteCriteria()), "",
  ]; // prettier-ignore
  if (screen.offscreen.length) parts.push(RULE, "QUESTION offscreen  (Choice criteria)", RULE, json(offscreenCriteria(screen.offscreen)), "");
  parts.push(
    RULE,
    `ITEMS  (${items.length} after merge/filter, ${axCount(items)} from the accessibility tree; ` +
      `pixel boxes on the ${screen.image.width}x${screen.image.height} capture, scale ${screen.scale})`,
    RULE,
  );
  for (const it of items) {
    const [cx, cy] = toPoints(screen, it);
    parts.push(
      `[${String(it.index).padStart(3)}] src=${it.source.padEnd(6)} role=${(it.role || "-").padEnd(8)} conf=${it.ocrConfidence.toFixed(2)} ` +
        `box=(${it.x1.toFixed(0)},${it.y1.toFixed(0)})-(${it.x2.toFixed(0)},${it.y2.toFixed(0)}) ` +
        `click_pt=(${cx.toFixed(0)},${cy.toFixed(0)}) ${region(screen, it).padEnd(13)} ${repr(it.text)}`,
    );
  }
  if (screen.offscreen.length) {
    parts.push("", RULE, `OFFSCREEN CONTROLS  (${screen.offscreen.length} the app exposes without showing; pressed through accessibility, never clicked)`, RULE);
    screen.offscreen.forEach((node, i) => parts.push(`[${String(i).padStart(3)}] role=${node.role.padEnd(22)} ${repr(node.label)}`));
  }
  if (screen.field) parts.push("", "FOCUSED FIELD", json(fieldRecord(screen.field)));
  return `${parts.join("\n")}\n`;
}

/** Blue boxes for OCR blocks, orange for accessibility controls, red for the chosen one, green for the focused field. */
export async function annotate(screen: Screen, items: Item[], chosen: string, out: string): Promise<void> {
  const { width, height } = screen.image;
  const s = screen.scale;
  const font = Math.round(11 * s);
  const shapes = items.map((it) => {
    const hit = String(it.index) === chosen;
    const color = hit ? "rgb(255,0,0)" : fromAx(it) ? "rgb(255,140,0)" : "rgb(0,160,255)";
    const box = `<rect x="${it.x1}" y="${it.y1}" width="${it.x2 - it.x1}" height="${it.y2 - it.y1}" fill="none" stroke="${color}" stroke-width="${hit ? 3 : 1}"/>`;
    return `${box}<text x="${it.x1}" y="${Math.max(0, it.y1 - 12 * s) + font}" fill="${color}">${it.index}</text>`;
  });
  const f = screen.field;
  if (f) {
    const [x, y] = [(f.x - screen.origin[0]) * s, (f.y - screen.origin[1]) * s];
    shapes.push(`<rect x="${x}" y="${y}" width="${f.w * s}" height="${f.h * s}" fill="none" stroke="rgb(0,200,0)" stroke-width="3"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="Helvetica" font-size="${font}">${shapes.join("")}</svg>`;
  await sharp(screen.image.path)
    .composite([{ input: Buffer.from(svg) }])
    .png({ compressionLevel: 3 })
    .toFile(out);
}
