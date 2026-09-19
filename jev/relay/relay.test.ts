import { expect, test } from "bun:test";
import { again, dropped, shown } from "./relay";

test("a long file is shown to the checker with its outline, its start and its end", () => {
  const long = `# Sources\n\n## Papers\n${"- a paper with its address\n".repeat(400)}\n## Mapping\n| Question | Modelled on |\n|---|---|\n| 1 | MIT |\n\n## Not found or not opened\nNothing from the library could be opened.\n`;
  const view = shown(long);
  expect(view.length).toBeLessThan(4200);
  expect(view).toContain("## Mapping");
  expect(view).toContain("| Question | Modelled on |");
  expect(view).toContain("Nothing from the library could be opened.");
  expect(view).toStartWith("OUTLINE");
  expect(shown("# Short\nfile")).toBe("# Short\nfile");
});

test("a dropped connection is the line; a refusal or a bad request is an answer", () => {
  expect(dropped(Object.assign(new TypeError("The socket connection was closed unexpectedly."), { code: "ECONNRESET" }))).toBe(true);
  expect(dropped(new Error("OpenAI gpt-6-astra failed (503): upstream"))).toBe(true);
  expect(dropped(new Error("OpenAI gpt-6-astra failed (429): quota"))).toBe(false);
  expect(dropped(new Error("OpenAI gpt-6-astra failed (400): bad schema"))).toBe(false);
  expect(dropped(new Error("the model refused: no"))).toBe(false);
});

test("again retries what is transient, twice at most, and nothing else", async () => {
  let calls = 0;
  expect(await again(async () => { if (++calls < 3) throw new Error("ECONNRESET"); return "ok"; }, dropped, () => {}, 1)).toBe("ok");
  expect(calls).toBe(3);

  calls = 0;
  await expect(again(async () => { calls++; throw new Error("ECONNRESET"); }, dropped, () => {}, 1)).rejects.toThrow("ECONNRESET");
  expect(calls).toBe(3);

  calls = 0;
  await expect(again(async () => { calls++; throw new Error("failed (401)"); }, dropped, () => {}, 1)).rejects.toThrow("401");
  expect(calls).toBe(1);
});
