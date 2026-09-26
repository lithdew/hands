import { afterEach, expect, test } from "bun:test";
import { onPayload, shareCache } from "../src/llm.ts";

const tier = process.env.HANDS_SERVICE_TIER;
afterEach(() => {
  shareCache(null);
  if (tier === undefined) delete process.env.HANDS_SERVICE_TIER;
  else process.env.HANDS_SERVICE_TIER = tier;
});

test("an OpenAI request carries the hand's prompt cache key, over pi's own per-agent one", () => {
  process.env.HANDS_SERVICE_TIER = "off";
  shareCache("hands-lefty");
  const body = { model: "gpt-6-astra", prompt_cache_key: "a-random-session", input: [] };
  expect(onPayload(body, { api: "openai-codex-responses" })).toEqual({ ...body, prompt_cache_key: "hands-lefty" });
  expect(onPayload(body, { api: "openai-responses" })).toMatchObject({ prompt_cache_key: "hands-lefty" });
});

test("a request to an API without the field is left as it was, and so is one with no key and no service tier", () => {
  process.env.HANDS_SERVICE_TIER = "off";
  shareCache("hands-lefty");
  expect(onPayload({ model: "claude", messages: [] }, { api: "anthropic-messages" })).toBeUndefined();
  shareCache(null);
  expect(onPayload({ model: "gpt-6-astra" }, { api: "openai-codex-responses" })).toBeUndefined();
});

test("the service tier still rides on the body, with or without the key", () => {
  process.env.HANDS_SERVICE_TIER = "priority";
  expect(onPayload({ model: "gpt-6-astra" }, { api: "openai-codex-responses" })).toEqual({ model: "gpt-6-astra", service_tier: "priority" });
  shareCache("hands-righty");
  expect(onPayload({ model: "gpt-6-astra" }, { api: "openai-codex-responses" })).toEqual({ model: "gpt-6-astra", service_tier: "priority", prompt_cache_key: "hands-righty" });
});
