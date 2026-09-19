// openai.ts — one structured call to an OpenAI model, optionally with a screenshot.
//
// The language models in hands never return free prose to the rest of the
// program. Every call names a JSON schema, the API enforces it (strict
// structured outputs), and the caller validates what comes back. `intent.ts`
// and `planner.ts` share this one seam, so tests replace a single function.
//
//   const llm = createOpenAI();
//   const json = await llm({ model, system, user, imagePng, schema });
//
// Requires: OPENAI_API_KEY in .env.local. OPENAI_BASE_URL points it at any
// server that speaks the Responses API.

import { z } from "zod";

// ---------------------------------------------------------------- types

export type JsonSchema = { name: string; schema: Record<string, unknown> };

export type LlmRequest = {
  model: string;
  effort?: "low" | "medium" | "high";
  system: string;
  user: string;
  /** A PNG the model should look at, e.g. a hand's screenshot. */
  imagePng?: Uint8Array;
  schema: JsonSchema;
};

/** Returns the parsed JSON the model produced. Tests replace this with a fake. */
export type Llm = (req: LlmRequest) => Promise<unknown>;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------- request

/** The Responses API body for a request. Exported for tests. */
export function responsesBody(req: LlmRequest): Record<string, unknown> {
  const content: Record<string, unknown>[] = [{ type: "input_text", text: req.user }];
  if (req.imagePng) {
    content.push({
      type: "input_image",
      image_url: `data:image/png;base64,${Buffer.from(req.imagePng).toString("base64")}`,
    });
  }
  return {
    model: req.model,
    reasoning: { effort: z.enum(["low", "medium", "high"]).parse(req.effort ?? "low") },
    instructions: req.system,
    input: [{ role: "user", content }],
    text: { format: { type: "json_schema", name: req.schema.name, strict: true, schema: req.schema.schema } },
    store: false,
  };
}

/** Pull the JSON text out of a Responses API result. Exported for tests. */
export function outputJson(body: unknown): unknown {
  const output = (body as { output?: unknown })?.output;
  if (!Array.isArray(output)) throw new Error("OpenAI response has no output");
  for (const item of output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === "refusal") throw new Error(`the model refused: ${part.refusal}`);
      if (part?.type === "output_text") return JSON.parse(part.text);
    }
  }
  throw new Error("OpenAI response has no output text");
}

// ---------------------------------------------------------------- client

export function createOpenAI(
  opts: { apiKey?: string; baseURL?: string; fetch?: FetchLike; timeoutMs?: number } = {},
): Llm {
  const apiKey = (opts.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.OAI)?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set. Put it (or OAI) in .env");
  const baseURL = (opts.baseURL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;

  return async (req) => {
    const res = await doFetch(`${baseURL}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(responsesBody(req)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    if (!res.ok) throw new Error(`OpenAI ${req.model} failed (${res.status}): ${(await res.text()).replaceAll(apiKey, "[redacted]").slice(0, 400)}`);
    return outputJson(await res.json());
  };
}
