import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserSelections, windowOwnerNamespace } from "./browser-selection";

test("browser selection and ownership namespace survive restart and explicit detach clears selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "puk-selection-"));
  try {
    const namespace = await windowOwnerNamespace(directory);
    expect(await windowOwnerNamespace(directory)).toBe(namespace);
    const window = { app: "chrome", title: "Mail", focused: true, pid: 10, containerId: 42, ownerNonce: "0000000000000042", rect: [0, 0, 800, 600] as [number, number, number, number] };
    await browserSelections(directory).save(1, window);
    expect(await browserSelections(directory).read(1)).toEqual(window);
    await browserSelections(directory).save(1, null);
    expect(await browserSelections(directory).read(1)).toBeNull();
    await writeFile(join(directory, "hand-1.json"), JSON.stringify({ ...window, ownerNonce: "0000000000000000" }));
    await expect(browserSelections(directory).read(1)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
