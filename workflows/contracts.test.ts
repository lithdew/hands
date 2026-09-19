import { expect, test } from "bun:test";
import { applyBundlePatch, BundlePatchSchema, type ArtifactBundle } from "./contracts";

const original: ArtifactBundle = {
  title: "Example", summary: "A reviewed artifact", entrypoint: "index.html",
  files: [
    { path: "index.html", content: "<h1>Original title</h1><p>Keep this paragraph.</p>" },
    { path: "style.css", content: "body { color: navy; }" },
  ], sources: [], limitations: ["No deployment requested"],
};

test("small exact edits preserve all unrelated file bytes and metadata", () => {
  const patch = BundlePatchSchema.parse({ replacements: [], edits: [
    { path: "index.html", find: "Original title", replace: "Corrected $& $1 title" },
  ] });
  const result = applyBundlePatch(original, patch);
  expect(result.files[0]!.content).toBe("<h1>Corrected $& $1 title</h1><p>Keep this paragraph.</p>");
  expect(result.files[1]).toEqual(original.files[1]);
  expect(result.summary).toBe(original.summary);
  expect(result.limitations).toEqual(original.limitations);
  expect(original.files[0]!.content).toContain("Original title");
});

test("missing and ambiguous edit targets fail without partially mutating the reviewed bundle", () => {
  for (const edit of [
    { path: "missing.html", find: "Original", replace: "New" },
    { path: "index.html", find: "Absent text", replace: "New" },
    { path: "index.html", find: "<", replace: "New" },
  ]) {
    expect(() => applyBundlePatch(original, { replacements: [], edits: [
      { path: "index.html", find: "Original title", replace: "Changed first" }, edit,
    ] })).toThrow("match once");
    expect(original.files[0]!.content).toContain("Original title");
  }
  expect(() => applyBundlePatch({ ...original, files: [{ path: "index.html", content: "aaa" }] }, {
    replacements: [], edits: [{ path: "index.html", find: "aa", replace: "b" }],
  })).toThrow("match once");
});

test("exact edits compose sequentially with full replacements and removals", () => {
  const result = applyBundlePatch(original, BundlePatchSchema.parse({
    replacements: [{ path: "style.css", content: "body { color: black; }" }],
    edits: [
      { path: "style.css", find: "black", replace: "white" },
      { path: "style.css", find: "white", replace: "teal" },
    ], summary: "Updated style",
  }));
  expect(result.files.find(file => file.path === "style.css")!.content).toBe("body { color: teal; }");
  expect(result.summary).toBe("Updated style");
  expect(BundlePatchSchema.safeParse({ replacements: [], edits: [{ path: "index.html", find: "", replace: "x" }] }).success).toBe(false);
  expect(() => applyBundlePatch(original, { replacements: [], remove: ["style.css"], edits: [{ path: "style.css", find: "navy", replace: "x" }] })).toThrow("match once");
});
