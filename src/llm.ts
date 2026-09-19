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

/** pi-ai's simple options carry no service tier, so it rides on the request body. */
export const onPayload = (payload: unknown): unknown => {
  const tier = serviceTier();
  return tier === "off" ? undefined : { ...(payload as object), service_tier: tier };
};
