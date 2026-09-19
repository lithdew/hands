import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { RawWindow } from "./desktop";

const Window = z.object({
  app: z.string().max(500), title: z.string().max(10_000), focused: z.boolean(),
  pid: z.number().int().positive(), containerId: z.number().int().positive(),
  ownerNonce: z.string().regex(/^[0-7][0-9a-f]{15}$/).refine(value => !/^0+$/.test(value)),
  rect: z.tuple([z.number(), z.number(), z.number(), z.number()]), iconic: z.boolean().optional(),
});

/** Selection is remembered, never treated as proof the old HWND is still live. */
export function browserSelections(directory: string) {
  const path = (hand: number) => {
    if (!Number.isSafeInteger(hand) || hand < 1) throw new Error("Invalid browser hand.");
    return join(directory, `hand-${hand}.json`);
  };
  return {
    async read(hand: number): Promise<RawWindow | null> {
      const saved = await readFile(path(hand), "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
      return saved === null ? null : Window.parse(JSON.parse(saved));
    },
    async save(hand: number, window: RawWindow | null): Promise<void> {
      const file = path(hand);
      if (!window) { await rm(file, { force: true }); return; }
      const value = Window.parse(window);
      await mkdir(directory, { recursive: true });
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      try { await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
    },
  };
}

/** A durable random property name lets the next helper attest the same HWND.
 * Windows deletes the property when the window dies, so recycled IDs fail. */
export async function windowOwnerNamespace(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = join(directory, "window-owner-namespace");
  try { await writeFile(file, crypto.randomUUID(), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const value = (await readFile(file, "utf8")).trim();
  if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error("Invalid saved window ownership namespace.");
  return value;
}
