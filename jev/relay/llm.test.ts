import { expect, test } from "bun:test";
import { createStreamingOpenAI, finishedResponse } from "./llm";

const event = (type: string, extra: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const completed = (text: string) => event("response.completed", { response: { output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text }] }] } });

test("the finished response is the one in the last event", () => {
  const sse = event("response.created") + event("response.in_progress") + event("response.output_text.delta", { delta: "{" }) + completed(`{"files":[]}`);
  expect(finishedResponse(sse)).toEqual({ output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: `{"files":[]}` }] }] });
});

test("a stream that fails, is incomplete or is cut off throws, and says which", () => {
  expect(() => finishedResponse(event("response.created") + event("response.failed", { response: { error: { message: "server overloaded" } } }))).toThrow("server overloaded");
  expect(() => finishedResponse(event("response.incomplete", { response: { incomplete_details: { reason: "max_output_tokens" } } }))).toThrow("max_output_tokens");
  expect(() => finishedResponse(event("error", { message: "bad" }))).toThrow("bad");
  expect(() => finishedResponse(event("response.created") + event("response.in_progress"))).toThrow("before the response was complete");
});

test("the client asks for a stream, keeps store false, and returns the parsed JSON", async () => {
  let sent: Record<string, unknown> = {};
  const llm = createStreamingOpenAI({ apiKey: "k", fetch: async (_url, init) => { sent = JSON.parse(String(init.body)); return new Response(completed(`{"ok":true}`), { status: 200 }); } });
  expect(await llm({ model: "gpt-6-astra", system: "s", user: "u", schema: { name: "x", schema: {} } })).toEqual({ ok: true });
  expect(sent.stream).toBe(true);
  expect(sent.store).toBe(false);
});

test("an HTTP error names the status and never the key", async () => {
  const llm = createStreamingOpenAI({ apiKey: "sk-secret", fetch: async () => new Response("bad key sk-secret", { status: 401 }) });
  await expect(llm({ model: "gpt-6-astra", system: "s", user: "u", schema: { name: "x", schema: {} } })).rejects.toThrow(/failed \(401\): bad key \[redacted\]/);
});
