/** The agreed LLM pool. Jev and speech models are separate from this policy. */
export const LUNA = "gpt-5.6-luna";
export const ASTRA = "gpt-6-astra";
export const GEMINI = "gemini-3.8-flash";

export function assertModel(provider: string, model: string): string {
  const allowed = provider === "openai" ? [LUNA, ASTRA] : provider === "gemini" ? [GEMINI] : [];
  if (!allowed.includes(model)) throw new Error(`Puk's model pool is Luna, Gemini 3.8 Flash and Astra. ${provider}/${model} is not enabled.`);
  return model;
}

export function modelEffort<T extends string>(model: string, effort: T): T | "low" {
  return model === ASTRA ? "low" : effort;
}

/** Port of the supplied pi-tier extension. Keep this on OpenAI requests only. */
export function serviceTier(provider: string): "priority" | "flex" | undefined {
  if (provider !== "openai") return undefined;
  const tier = (process.env.PUK_SERVICE_TIER ?? process.env.PI_TIER ?? "priority").trim().toLowerCase();
  if (tier === "off") return undefined;
  if (tier === "priority" || tier === "flex") return tier;
  throw new Error("PUK_SERVICE_TIER (or PI_TIER) must be priority, flex or off.");
}

/** SimpleStreamOptions exposes onPayload, not the provider's serviceTier option. */
export function tierPayload(provider: string, payload: unknown): unknown {
  const tier = serviceTier(provider);
  return tier && payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...payload, service_tier: tier } : payload;
}
