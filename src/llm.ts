/** The language model behind both the agent and the writer: pi-ai, signed in through pi's own credential store. */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { serviceTier } from "./config.ts";

let created: Promise<ModelRuntime> | undefined;
/** Providers, models, and auth from ~/.pi/agent: `pi` then `/login` is what signs a subscription in. */
export const runtime = (): Promise<ModelRuntime> => (created ??= ModelRuntime.create());

/** A `provider/model` spec, e.g. `openai-codex/gpt-6-astra`. */
export async function resolveModel(spec: string) {
  const cut = spec.indexOf("/");
  const model = (await runtime()).getModel(spec.slice(0, cut), spec.slice(cut + 1));
  if (!model) throw new Error(`unknown model ${JSON.stringify(spec)}; expected provider/model, e.g. openai-codex/gpt-6-astra`);
  return model;
}

/** The APIs whose request body takes OpenAI's prompt_cache_key. */
const CACHE_KEYED = new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);
let cacheKey: string | null = null;

/**
 * The key OpenAI routes this process's requests by for its prompt cache. pi keys each agent by a session id of its
 * own, so no two hands ever shared a cached prompt: every new hand's first turn read its 5k-token prefix afresh. Keyed
 * by the hand's name, each new Lefty finds the last Lefty's prefix (measured: 5 of 6 first turns read it from the
 * cache, median 1.74 s against 2.0 s, without the 2.7 s tail), and the load of several hands at once is spread over
 * their names rather than piled on one key. The system prompt keeps what changes (the time) at its end for this.
 */
export function shareCache(key: string | null): void {
  cacheKey = key;
}

/** pi-ai's simple options carry no service tier, so it rides on the request body, as does the cache key where the API takes one. */
export const onPayload = (payload: unknown, model?: { api?: string }): unknown => {
  const tier = serviceTier();
  const keyed = cacheKey && model?.api && CACHE_KEYED.has(model.api) ? { prompt_cache_key: cacheKey } : null;
  if (tier === "off" && !keyed) return undefined;
  return { ...(payload as object), ...(tier === "off" ? {} : { service_tier: tier }), ...keyed };
};
