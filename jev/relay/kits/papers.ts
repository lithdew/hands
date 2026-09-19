// kits/papers.ts — a research summary whose every citation is a real paper.
import type { Kit } from "../relay";
import { arxiv } from "../web";

export const papers: Kit = {
  name: "papers",
  brief: "The deliverable is one markdown file, rl-frontier.md. Cite every paper as a markdown link whose text is the paper's exact title and whose address is its arXiv abstract page: [Exact Title](https://arxiv.org/abs/2501.01234). Only papers that are in the notes, with the title and address exactly as the notes give them.",
  // arXiv's own listing, newest first: real titles and addresses, with the abstract to sift on.
  sources: (query) => arxiv(`all:${JSON.stringify(query.replace(/\b(20\d\d|arxiv|paper|papers|survey of)\b/gi, "").trim())}`, 30),
};
