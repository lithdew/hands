import { describe, expect, test } from "bun:test";
import { PANEL_CSP, panelResponse, previewLabel } from "./serve";

describe("Windows panel route", () => {
  const get = (path: string) => panelResponse(new Request(`http://127.0.0.1:7777${path}`));

  test("serves the Windows page at / and /index.html with hotkey.ts's CSP", async () => {
    for (const path of ["/", "/index.html"]) {
      const response = await get(path);
      expect(response?.status).toBe(200);
      expect(response?.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(response?.headers.get("Cache-Control")).toBe("no-store");
      expect(response?.headers.get("Content-Security-Policy")).toBe(PANEL_CSP);
    }
    expect(PANEL_CSP).toBe("default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  });
  test("everything else falls through to the panel server", async () => {
    expect(await get("/status")).toBeNull();
    expect(await get("/desktop.png")).toBeNull();
    expect(await panelResponse(new Request("http://127.0.0.1:7777/", { method: "POST" }))).toBeNull();
  });
  test("the page fetches nothing external and carries Windows hints only", async () => {
    const html = await (await get("/"))!.text();
    expect(html).toContain("<kbd>F8</kbd>");
    expect(html).toContain("Ctrl</kbd><kbd>Alt</kbd><kbd>Esc</kbd>");
    for (const forbidden of ["googleapis", "gstatic", "<link", "Super", "Ctrl+Alt+1", "Reset previews", "/desktop/layout"]) expect(html).not.toContain(forbidden);
    // Every id the script reads must exist in the markup.
    const ids = new Set([...html.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]!));
    for (const id of ids) expect(html).toContain(`id="${id}"`);
    expect(ids.size).toBeGreaterThan(10);
  });
});

describe("previewLabel", () => {
  test("joins task and title with one middle dot and drops it when a half is empty", () => {
    expect(previewLabel("open paint", "Untitled - Paint")).toBe("open paint · Untitled - Paint");
    expect(previewLabel("", "Untitled - Paint")).toBe("Untitled - Paint");
    expect(previewLabel("open paint", "")).toBe("open paint");
    expect(previewLabel("", "")).toBe("");
  });
  test("a dot inside either half cannot be mistaken for the separator", () => {
    expect(previewLabel("email · Sam", "Inbox · Mail")).toBe("email - Sam · Inbox - Mail");
  });
  test("collapses whitespace and caps the caption", () => {
    expect(previewLabel("a\n\nb", "  c\t d ")).toBe("a b · c d");
    expect(previewLabel("x".repeat(200), "y")).toHaveLength(120);
  });
});
