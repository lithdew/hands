import { expect, test } from "bun:test";
import { assertModel, modelEffort, serviceTier, tierPayload } from "./model-policy";
import { responsesBody } from "./jev/openai";

test("the model boundary rejects other models and Astra never uses high effort", () => {
  expect(() => assertModel("anthropic", "claude-sonnet-5")).toThrow("not enabled");
  expect(() => assertModel("openai", "gpt-5.6-sol")).toThrow("not enabled");
  expect(modelEffort("gpt-6-astra", "high")).toBe("low");
  const body = responsesBody({ model: "gpt-6-astra", effort: "high", system: "", user: "", schema: { name: "t", schema: {} } });
  expect(body.reasoning).toEqual({ effort: "low" });
});

test("priority is applied to both OpenAI request paths; Gemini and off omit it", () => {
  const saved = { puk: process.env.PUK_SERVICE_TIER, pi: process.env.PI_TIER };
  try {
    delete process.env.PUK_SERVICE_TIER; delete process.env.PI_TIER;
    expect(tierPayload("openai", { model: "gpt-5.6-luna" })).toEqual({ model: "gpt-5.6-luna", service_tier: "priority" });
    expect(tierPayload("gemini", { model: "gemini-3.8-flash" })).toEqual({ model: "gemini-3.8-flash" });
    expect(responsesBody({ model: "gpt-5.6-luna", system: "", user: "", schema: { name: "t", schema: {} } }).service_tier).toBe("priority");
    process.env.PI_TIER = "flex"; expect(serviceTier("openai")).toBe("flex");
    process.env.PUK_SERVICE_TIER = "off"; expect(tierPayload("openai", {})).toEqual({});
    process.env.PUK_SERVICE_TIER = "typo"; expect(() => serviceTier("openai")).toThrow("must be");
  } finally {
    if (saved.puk === undefined) delete process.env.PUK_SERVICE_TIER; else process.env.PUK_SERVICE_TIER = saved.puk;
    if (saved.pi === undefined) delete process.env.PI_TIER; else process.env.PI_TIER = saved.pi;
  }
});
