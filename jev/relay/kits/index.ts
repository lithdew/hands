// kits/index.ts — which kit a task uses. Each kit is one file, owned by whoever is improving that task.
import type { Kit } from "../relay";
import { exam } from "./exam";
import { mathvideo } from "./mathvideo";
import { papers } from "./papers";
import { pitchvideo } from "./pitchvideo";
import { site } from "./site";

export const KITS: Record<string, Kit> = { exam, papers, site, mathvideo, pitchvideo };
