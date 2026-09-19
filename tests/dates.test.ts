import { expect, test } from "bun:test";
import { dateHints, day, describeOffset, firstDate } from "../src/dates.ts";
import { makeItem, screen } from "./helpers.ts";

const TODAY = day(2026, 9, 16)!;

test("parses common forms", () => {
  expect(firstDate("October 13 - 15, 2026", TODAY)).toEqual(day(2026, 10, 13));
  expect(firstDate("November 4, 2026", TODAY)).toEqual(day(2026, 11, 4));
  expect(firstDate("Last day to book Sept 18", TODAY)).toEqual(day(2026, 9, 18));
  expect(firstDate("Posted 9/1/2026", TODAY)).toEqual(day(2026, 9, 1));
  expect(firstDate("2026-12-01 release", TODAY)).toEqual(day(2026, 12, 1));
  expect(firstDate("4 Nov 2026", TODAY)).toEqual(day(2026, 11, 4));
});

test("no date and invalid date", () => {
  expect(firstDate("Register Now", TODAY)).toBeNull();
  expect(firstDate("Feb 30", TODAY)).toBeNull();
});

test("missing year rolls forward when well past", () => {
  expect(firstDate("Jan 5", TODAY)).toEqual(day(2027, 1, 5));
  expect(firstDate("Sep 1", TODAY)).toEqual(day(2026, 9, 1));
});

test("describe offset", () => {
  expect(describeOffset(day(2026, 9, 16)!, TODAY)).toBe("2026-09-16 (today)");
  expect(describeOffset(day(2026, 10, 13)!, TODAY)).toBe("2026-10-13 (in 27 days)");
  expect(describeOffset(day(2026, 9, 1)!, TODAY)).toBe("2026-09-01 (15 days ago)");
});

test("neighbours inherit nearest date", () => {
  const items = [
    makeItem(0, "TechCrunch Disrupt 2026 | October 13 - 15, 2026", { y1: 1325, y2: 1355 }),
    makeItem(1, "Register Now", { y1: 1359, y2: 1389 }),
    makeItem(2, "Founder Summit | November 4, 2026", { y1: 1601, y2: 1631 }),
    makeItem(3, "Register Now", { y1: 1631, y2: 1661 }),
    makeItem(4, "Footer", { y1: 2400, y2: 2430 }),
  ];
  const hints = dateHints(items, screen(), TODAY);
  expect(hints.get(0)).toStartWith("dated 2026-10-13");
  expect(hints.get(1)).toBe("near a line dated 2026-10-13 (in 27 days)");
  expect(hints.get(3)).toBe("near a line dated 2026-11-04 (in 49 days)");
  expect(hints.has(4)).toBe(false);
});
