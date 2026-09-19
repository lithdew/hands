// llm.ts — the relay's calls to OpenAI, streamed.
//
// jev/openai.ts waits for the whole answer on a silent socket. That is right for the app's two-second
// calls. The relay's writer thinks for minutes, and from this machine a socket that says nothing for 60 s
// is cut by the network (measured: ECONNRESET at 60 s, three times out of three, while calls under a
// minute went through). Streaming is the API's own answer to that: the same request with `stream: true`,
// events while the model works, and the finished response in the last event. Same body, same schema
// enforcement, still `store: false`.
//
//   const llm = createStreamingOpenAI();     // an `Llm`, as createOpenAI() is

import { outputJson, responsesBody, type FetchLike, type Llm } from "../openai";

/** The finished response out of a Responses API event stream. Throws on a failed, incomplete or cut-off stream. Exported for tests. */
export function finishedResponse(sse: string): unknown {
  let done: unknown = null;
  for (const block of sse.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    let event: { type?: string; response?: { error?: { message?: string }; incomplete_details?: { reason?: string } }; message?: string };
    try { event = JSON.parse(data); } catch { continue; }
    if (event.type === "response.completed") done = event.response;
    else if (event.type === "response.failed") throw new Error(`the model's response failed: ${event.response?.error?.message ?? "no reason given"}`);
    else if (event.type === "response.incomplete") throw new Error(`the model's response is incomplete: ${event.response?.incomplete_details?.reason ?? "no reason given"}`);
    else if (event.type === "error") throw new Error(`the stream reported an error: ${event.message ?? "no message"}`);
  }
  if (!done) throw new Error("the stream ended before the response was complete");
  return done;
}

export function createStreamingOpenAI(opts: { apiKey?: string; baseURL?: string; fetch?: FetchLike; timeoutMs?: number } = {}): Llm {
  const apiKey = (opts.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.OAI)?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set. Put it (or OAI) in .env");
  const baseURL = (opts.baseURL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  return async (req) => {
    const res = await doFetch(`${baseURL}/responses`, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ ...responsesBody(req), stream: true }), signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000) });
    if (!res.ok) throw new Error(`OpenAI ${req.model} failed (${res.status}): ${(await res.text()).replaceAll(apiKey, "[redacted]").slice(0, 400)}`);
    return outputJson(finishedResponse(await res.text()));
  };
}
