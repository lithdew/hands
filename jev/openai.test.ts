import { describe, expect, test } from "bun:test";
import { createOpenAI, outputJson, responsesBody, type LlmRequest } from "./openai";

const req: LlmRequest = {
  model: "gpt-5.6-luna",
  system: "You are terse.",
  user: "hello",
  schema: { name: "reply", schema: { type: "object" } },
};

describe("responsesBody", () => {
  test("the standalone planner also enforces low as the minimum effort", () => {
    expect(responsesBody({ ...req, effort: "high" }).reasoning).toEqual({ effort: "high" });
    expect(() => responsesBody({ ...req, effort: "off" as never })).toThrow();
  });

  test("asks for strict structured output", () => {
    const body = responsesBody(req) as any;
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.instructions).toBe("You are terse.");
    expect(body.input[0].content).toEqual([{ type: "input_text", text: "hello" }]);
    expect(body.text.format).toEqual({ type: "json_schema", name: "reply", strict: true, schema: { type: "object" } });
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  test("attaches a screenshot as a data url", () => {
    const body = responsesBody({ ...req, imagePng: new Uint8Array([1, 2, 3]) }) as any;
    expect(body.input[0].content[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,AQID" });
  });
});

describe("outputJson", () => {
  test("parses the output text, skipping reasoning items", () => {
    const body = {
      output: [
        { type: "reasoning", summary: [] },
        { type: "message", content: [{ type: "output_text", text: '{"ok":true}' }] },
      ],
    };
    expect(outputJson(body)).toEqual({ ok: true });
  });

  test("throws on a refusal", () => {
    const body = { output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] };
    expect(() => outputJson(body)).toThrow(/refused: no/);
  });

  test("throws when there is no output", () => {
    expect(() => outputJson({})).toThrow(/no output/);
    expect(() => outputJson({ output: [] })).toThrow(/no output text/);
  });
});

describe("createOpenAI", () => {
  test("posts to /responses with the key and returns the parsed JSON", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const llm = createOpenAI({
      apiKey: "sk-test",
      baseURL: "https://example.test/v1/",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: '{"a":1}' }] }] });
      },
    });
    expect(await llm(req)).toEqual({ a: 1 });
    expect(calls[0]!.url).toBe("https://example.test/v1/responses");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer sk-test");
  });

  test("reports the status and body of a failed call", async () => {
    const llm = createOpenAI({ apiKey: "sk-test", fetch: async () => new Response("model not found", { status: 404 }) });
    await expect(llm(req)).rejects.toThrow(/gpt-5.6-luna failed \(404\): model not found/);
  });

  test("names the missing key", () => {
    const saved = process.env.OPENAI_API_KEY, alias = process.env.OAI;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OAI;
    try {
      expect(() => createOpenAI()).toThrow(/OPENAI_API_KEY is not set/);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      if (alias !== undefined) process.env.OAI = alias;
    }
  });
});
