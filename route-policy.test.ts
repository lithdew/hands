import { expect, test } from "bun:test";
import { routeCandidates, routeTask, type Fetch } from "./ai";

test("semantic routing request carries modality boundaries and preserves correction context", async () => {
  const candidates = routeCandidates("auto", { keyAvailable: () => true });
  let request: any;
  const fetch: Fetch = async (_url, options) => {
    request = JSON.parse(options!.body as string);
    return Response.json({ answers: { route: { type: "choice", choice: "openai_routine", confidence: 0.98, probabilities: { openai_routine: 0.98, gemini_standard: 0.01, openai_complex: 0.01 } } } });
  };
  const context = "A labelled mail draft is open; the previous request identified the recipient and body.";
  const route = await routeTask("Change its subject to Saturday plan", candidates, { apiKey: "test", fetch, context });
  expect(request.state.previousContext).toBe(context);
  expect(request.questions.route.criteria.openai_routine).toContain("MULTI-STEP browser and mail");
  expect(request.questions.route.criteria.gemini_standard).toContain("VISUAL GROUNDING");
  expect(request.questions.route.criteria.openai_complex).toContain("repeated failed attempts");
  expect(route).toMatchObject({ provider: "openai", model: "gpt-5.6-luna", effort: "low", fallback: false });
});

test("visual and recovery selections use only their supplied profile without overriding pins", async () => {
  for (const [selection, model] of [["openai", "gpt-5.6-luna"], ["gemini", "gemini-3.8-flash"]] as const) {
    const candidates = routeCandidates(selection, { model, keyAvailable: () => true });
    for (const difficulty of ["standard", "complex"] as const) {
      const id = `${selection}_${difficulty}`;
      const fetch: Fetch = async () => Response.json({ answers: { route: { type: "choice", choice: id, confidence: 1, probabilities: { [id]: 1 } } } });
      const route = await routeTask("Inspect the screenshot and recover from repeated failures", candidates, { apiKey: "test", fetch });
      expect(route).toMatchObject({ provider: selection, model, effort: "low", difficulty, fallback: false });
    }
  }
});
