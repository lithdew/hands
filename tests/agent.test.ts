import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { pruneScreens, staleCount } from "../src/agent.ts";

const STUB = "[an earlier screen; call `screen` for the current one]";

/** A tool result carrying a listing and a screenshot, as `screen` does when asked for the picture. */
const result = (toolName: string, n: number): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: `call-${n}`,
  toolName,
  content: [
    { type: "text", text: `${toolName} ${n}` },
    { type: "image", data: `shot-${n}`, mimeType: "image/jpeg" },
  ],
  isError: false,
  timestamp: n,
});

const screens = (count: number) => Array.from({ length: count }, (_, n) => result("screen", n));

/** Each screen result as what is left of it: a stub, its text alone, or all of it. */
const shapes = (messages: AgentMessage[]) =>
  messages.flatMap((m) => {
    if (m.role !== "toolResult" || m.toolName !== "screen") return [];
    const [first] = m.content;
    if (first?.type === "text" && first.text === STUB) return ["stub"];
    return [m.content.some((block) => block.type === "image") ? "full" : "text"];
  });

test("everything but the newest few is stale, a whole batch at a time", () => {
  expect([0, 3, 6, 7, 10, 11].map((count) => staleCount(count, 3))).toEqual([0, 0, 0, 4, 4, 8]);
  expect([1, 4, 5, 8, 9].map((count) => staleCount(count, 1))).toEqual([0, 0, 4, 4, 8]);
  expect(staleCount(6, 1, 2)).toBe(4);
});

test("listings and screenshots are cut in batches, never one a turn", () => {
  expect(shapes(pruneScreens(screens(4)))).toEqual(["full", "full", "full", "full"]);
  expect(shapes(pruneScreens(screens(5)))).toEqual(["text", "text", "text", "text", "full"]);
  expect(shapes(pruneScreens(screens(6)))).toEqual(["text", "text", "text", "text", "full", "full"]);
  expect(shapes(pruneScreens(screens(7)))).toEqual(["stub", "stub", "stub", "stub", "full", "full", "full"]);
});

test("stale listings become a stub and only the newest screenshot keeps its image", () => {
  const pruned = pruneScreens(screens(9));
  expect(shapes(pruned)).toEqual(["stub", "stub", "stub", "stub", "text", "text", "text", "text", "full"]);
  expect(pruned[0]).toEqual({ ...result("screen", 0), content: [{ type: "text", text: STUB }] });
  expect(pruned[4]).toEqual({ ...result("screen", 4), content: [{ type: "text", text: "screen 4" }] });
  expect(pruned[8]).toEqual(result("screen", 8));
});

test("other messages pass through untouched and the transcript given is not mutated", () => {
  const ask: AgentMessage = { role: "user", content: "what is on screen?", timestamp: 0 };
  const listing = result("bash", 100);
  const messages = [ask, ...screens(5), listing, ...screens(4).map((_, n) => result("screen", 5 + n))];
  const before = structuredClone(messages);
  const pruned = pruneScreens(messages);
  expect(messages).toEqual(before);
  expect(pruned).not.toBe(messages);
  expect(pruned).toHaveLength(messages.length);
  expect(pruned[0]).toBe(ask);
  expect(pruned[6]).toBe(listing);
  expect(pruned.at(-1)).toBe(messages.at(-1)!);
  expect(shapes(pruned)).toEqual(["stub", "stub", "stub", "stub", "text", "text", "text", "text", "full"]);
  expect(shapes(messages)).toEqual(Array(9).fill("full"));
});

test("an action that ends with a listing goes stale like a screen, and keeps what it said it did", () => {
  const opened: ToolResultMessage = {
    ...result("browser", 0),
    content: [
      { type: "text", text: "opened https://arxiv.org in a new tab" },
      { type: "text", text: "frontmost app: Google Chrome\nitems: ..." },
    ],
    details: { listing: true },
  };
  const tabs: ToolResultMessage = { ...result("browser", 1), details: undefined };
  const pruned = pruneScreens([opened, tabs, ...screens(6)]);
  expect(pruned[0]).toEqual({ ...opened, content: [{ type: "text", text: "opened https://arxiv.org in a new tab" }, { type: "text", text: STUB }] });
  expect(pruned[1]).toBe(tabs);
  expect(shapes(pruned)).toEqual(["stub", "stub", "stub", "full", "full", "full"]);
});
