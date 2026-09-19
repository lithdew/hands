/**
 * Deterministic date handling.
 *
 * The classifier does no calendar math, so dates found in screen text are parsed
 * here and handed over as offsets from today.
 */

import { center, type Item, type Screen } from "./models.ts";

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
const DASHES = "[-–—]"; // hyphen, en dash, em dash between the days of a range
export const DATE_RE = new RegExp(
  `\\b(?:(?<mon>${MONTH})[a-z]*\\.?\\s+(?<day>\\d{1,2})(?:\\s*${DASHES}\\s*\\d{1,2})?(?:,?\\s+(?<year>\\d{4}))?` +
    `|(?<day2>\\d{1,2})\\s+(?<mon2>${MONTH})[a-z]*\\.?(?:,?\\s+(?<year2>\\d{4}))?` +
    "|(?<iso>\\d{4}-\\d{2}-\\d{2})" +
    "|(?<m>\\d{1,2})/(?<d>\\d{1,2})/(?<y>\\d{4}))\\b",
  "i",
);
export const NEAR_ROWS_PT = 60;
const DAY_MS = 86_400_000;

/** A calendar date as UTC midnight, so differences are whole days whatever the local DST does. */
export type Day = Date;

/** The date, or null when the calendar has no such day (Feb 30, month 13). */
export function day(year: number, month: number, dayOfMonth: number): Day | null {
  const d = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (year < 100) d.setUTCFullYear(year);
  const real = d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === dayOfMonth;
  return real ? d : null;
}

export const isoDate = (d: Day): string => d.toISOString().slice(0, 10);

export function localToday(): Day {
  const now = new Date();
  return day(now.getFullYear(), now.getMonth() + 1, now.getDate())!;
}

export function nowContext() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = isoDate(localToday());
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(now).find((p) => p.type === "timeZoneName");
  return {
    local_time: `${today} ${pad(now.getHours())}:${pad(now.getMinutes())} ${weekday}`,
    timezone: zone?.value ?? "",
    today,
  };
}

/** The first date mentioned in the text, or null. A missing year is assumed current or next. */
export function firstDate(text: string, today: Day = localToday()): Day | null {
  const g = DATE_RE.exec(text)?.groups;
  if (!g) return null;
  if (g.iso) {
    const [y, m, d] = g.iso.split("-").map(Number);
    return day(y!, m!, d!);
  }
  if (g.m) return day(Number(g.y), Number(g.m), Number(g.d));
  const mon = MONTH_NAMES.indexOf((g.mon ?? g.mon2)!.slice(0, 3).toLowerCase()) + 1;
  const dayOfMonth = Number(g.day ?? g.day2);
  const year = g.year ?? g.year2;
  const found = day(year ? Number(year) : today.getUTCFullYear(), mon, dayOfMonth);
  if (found && !year && (today.getTime() - found.getTime()) / DAY_MS > 60) return day(today.getUTCFullYear() + 1, mon, dayOfMonth);
  return found;
}

export function describeOffset(d: Day, today: Day = localToday()): string {
  const delta = Math.round((d.getTime() - today.getTime()) / DAY_MS);
  if (delta === 0) return `${isoDate(d)} (today)`;
  if (delta > 0) return `${isoDate(d)} (in ${delta} days)`;
  return `${isoDate(d)} (${-delta} days ago)`;
}

/** Item index -> 'dated ...' for items containing a date, or 'near a line dated ...' for close neighbours. */
export function dateHints(items: Item[], screen: Screen, today: Day = localToday()): Map<number, string> {
  const dated = new Map<number, Day>();
  for (const it of items) {
    const d = firstDate(it.text, today);
    if (d) dated.set(it.index, d);
  }
  const hints = new Map([...dated].map(([i, d]) => [i, `dated ${describeOffset(d, today)}`]));
  if (!dated.size) return hints;
  const byIndex = new Map(items.map((it) => [it.index, it]));
  const cyOf = (i: number) => center(byIndex.get(i)!)[1];
  for (const it of items) {
    if (hints.has(it.index)) continue;
    const cy = center(it)[1];
    const nearest = [...dated.keys()].reduce((best, i) => (Math.abs(cyOf(i) - cy) < Math.abs(cyOf(best) - cy) ? i : best));
    if (Math.abs(cyOf(nearest) - cy) < NEAR_ROWS_PT * screen.scale) {
      hints.set(it.index, `near a line dated ${describeOffset(dated.get(nearest)!, today)}`);
    }
  }
  return hints;
}
