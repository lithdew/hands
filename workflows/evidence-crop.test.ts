import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { focusedCrop, inspectedRunEvidence, pngDimensions, type EvidenceCrop } from "./evidence";

function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height); bytes[24] = 8; bytes[25] = 6;
  return bytes;
}

test("png dimensions and the panel-shaped top crop are computed from real headers only", () => {
  expect(pngDimensions(pngHeader(1440, 900))).toEqual({ width: 1440, height: 900 });
  expect(pngDimensions(new TextEncoder().encode("not a png at all, just text"))).toBeUndefined();
  expect(focusedCrop(1440, 900)).toEqual({ left: 0, top: 0, width: 1440, height: 554 });
  // Captures already shaped like the panel, or only a little taller, stay whole.
  expect(focusedCrop(1088, 404)).toBeUndefined();
  expect(focusedCrop(1164, 500)).toBeUndefined();
  expect(focusedCrop(890, 362)).toBeUndefined();
});

test("tall desktop previews without an inspector-preferred image get a provenance-recorded top crop that is reused", async () => {
  const root = await mkdtemp(join(tmpdir(), "hands-evidence-")), id = crypto.randomUUID(), directory = join(root, id);
  try {
    await mkdir(join(directory, "preview"), { recursive: true });
    const png = join(directory, "preview", "desktop.png"), source = pngHeader(1440, 900);
    await writeFile(png, source);
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ runId: id, status: "complete", kind: "website", summary: "Site", checks: [{ passed: true }], screenshots: [png] }));
    await writeFile(join(directory, "independent-inspection.json"), JSON.stringify({ verdict: "pass-with-advisories", passed: true }));
    const calls: EvidenceCrop[] = [];
    const crop = async (from: string, to: string, box: EvidenceCrop) => { calls.push(box); expect(from).toBe(png); await writeFile(to, `cropped ${box.width}x${box.height}`); };
    const first = await inspectedRunEvidence(root, [id], { crop });
    const derived = join(directory, "preview", "evidence-top-1440x554.png");
    expect(first.assets).toEqual({ "artifact-1": derived });
    expect(calls).toEqual([{ left: 0, top: 0, width: 1440, height: 554 }]);
    const image = (first.records[0] as any).image;
    expect(image.selection).toBe("top-region-crop");
    expect(image.path).toBe("preview/evidence-top-1440x554.png");
    expect(image.sourcePath).toBe("preview/desktop.png");
    expect(image.sourceSha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect(image.sha256).toBe(createHash("sha256").update("cropped 1440x554").digest("hex"));
    expect(image.description).toContain("pixels unchanged");
    const sidecar = JSON.parse(await readFile(`${derived}.provenance.json`, "utf8"));
    expect(sidecar).toMatchObject({ runId: id, sourcePath: "preview/desktop.png", crop: { left: 0, top: 0, width: 1440, height: 554 }, sha256: image.sha256 });
    // A matching crop is reused without re-running the tool.
    const second = await inspectedRunEvidence(root, [id], { crop });
    expect(calls).toHaveLength(1);
    expect(second.assets).toEqual(first.assets);
    // A changed source screenshot invalidates the saved crop.
    await writeFile(png, pngHeader(1440, 901));
    await inspectedRunEvidence(root, [id], { crop });
    expect(calls).toHaveLength(2);
    // Disabled cropping and non-PNG fixtures both keep the original preview.
    const plain = await inspectedRunEvidence(root, [id], { crop: null });
    expect(plain.assets).toEqual({ "artifact-1": png });
    expect((plain.records[0] as any).image.selection).toBe("original-preview");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed crop keeps the original preview and records why", async () => {
  const root = await mkdtemp(join(tmpdir(), "hands-evidence-")), id = crypto.randomUUID(), directory = join(root, id);
  try {
    await mkdir(join(directory, "preview"), { recursive: true });
    const png = join(directory, "preview", "desktop.png");
    await writeFile(png, pngHeader(1440, 900));
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ runId: id, status: "complete", kind: "report", checks: [{ passed: true }], screenshots: [png] }));
    await writeFile(join(directory, "independent-inspection.json"), JSON.stringify({ verdict: "pass" }));
    const result = await inspectedRunEvidence(root, [id], { crop: async () => { throw new Error("Pillow missing"); } });
    expect(result.assets).toEqual({ "artifact-1": png });
    const image = (result.records[0] as any).image;
    expect(image.selection).toBe("original-preview");
    expect(image.note).toContain("Pillow missing");
  } finally { await rm(root, { recursive: true, force: true }); }
});
