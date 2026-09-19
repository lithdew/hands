// kits/site.ts — a static personal site, every fact on it sourced.
import type { Kit } from "../relay";

export const site: Kit = {
  name: "site",
  brief: "The deliverables are site/index.html, one self-contained page (its CSS inline or in site/style.css; no frameworks, no remote scripts), and site/SOURCES.md, which lists every fact about the person that the page states and where it was found.",
};
