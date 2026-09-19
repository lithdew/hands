import { z } from "zod";

export const ArtifactKindSchema = z.enum(["report", "website", "video"]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
// Relative, portable data files only. No executable shell/program return type.
export const ArtifactPathSchema = z.string().min(1).max(180).refine(path =>
  /^[a-zA-Z0-9][a-zA-Z0-9_./-]*\.(?:html|css|js|json|md|txt|csv|svg|vtt)$/.test(path)
  && path.split("/").every(part => part && part !== "." && part !== ".." && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), "Use a portable relative artifact path");
export const SourceSeedSchema = z.object({ url: z.url(), title: z.string().max(300).optional() });
export const PlanSchema = z.object({
  title: z.string().min(1).max(200), kind: ArtifactKindSchema,
  brief: z.string().min(1).max(6000), sources: z.array(SourceSeedSchema).max(16),
  requiredFiles: z.array(ArtifactPathSchema).min(1).max(20),
  checks: z.array(z.string().min(1).max(2000)).min(1).max(20),
});
export type ArtifactPlan = z.infer<typeof PlanSchema>;
export const BundleSchema = z.object({
  title: z.string().min(1).max(200), summary: z.string().min(1).max(2000),
  entrypoint: ArtifactPathSchema,
  files: z.array(z.object({ path: ArtifactPathSchema, content: z.string().max(300_000) })).min(1).max(20),
  sources: z.array(z.object({ url: z.url(), title: z.string().max(300), claims: z.array(z.string().max(1000)).max(30) })).max(30),
  limitations: z.array(z.string().max(1000)).max(20),
}).superRefine((bundle, ctx) => {
  const paths = bundle.files.map(file => file.path.toLowerCase());
  if (new Set(paths).size !== paths.length) ctx.addIssue({ code: "custom", message: "Duplicate artifact paths" });
  if (!bundle.files.some(file => file.path === bundle.entrypoint)) ctx.addIssue({ code: "custom", message: "Entrypoint is not included" });
  if (!bundle.entrypoint.endsWith(".html")) ctx.addIssue({ code: "custom", message: "Entrypoint must be locally readable HTML" });
  if (bundle.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0) > 800_000) ctx.addIssue({ code: "custom", message: "Artifact bundle exceeds 800 KB" });
});
export type ArtifactBundle = z.infer<typeof BundleSchema>;
export const BundlePatchSchema = z.object({
  replacements: z.array(z.object({path:ArtifactPathSchema,content:z.string().max(300_000)})).max(20),
  remove: z.array(ArtifactPathSchema).max(20).optional(),
  title: z.string().min(1).max(200).optional(), summary:z.string().min(1).max(2000).optional(),
  entrypoint:ArtifactPathSchema.optional(), sources:BundleSchema.shape.sources.optional(), limitations:BundleSchema.shape.limitations.optional(),
}).refine(patch=>new Set(patch.replacements.map(file=>file.path.toLowerCase())).size===patch.replacements.length,"Duplicate replacement paths");
export function applyBundlePatch(bundle:ArtifactBundle,patch:z.infer<typeof BundlePatchSchema>) {
  const replaced=new Set(patch.replacements.map(file=>file.path));
  return {...bundle,...Object.fromEntries(Object.entries(patch).filter(([key,value])=>!["replacements","remove"].includes(key)&&value!==undefined)),files:[...bundle.files.filter(file=>!replaced.has(file.path)&&!patch.remove?.includes(file.path)),...patch.replacements]};
}
export const ReviewSchema = z.object({
  passed: z.boolean(), summary: z.string().min(1).max(2000),
  issues: z.array(z.object({ severity: z.enum(["error", "warning"]), file: z.string().max(180), detail: z.string().min(1).max(2000) })).max(30),
});
export type ArtifactReview = z.infer<typeof ReviewSchema>;
export type Check = { name: string; passed: boolean; detail: string };
export function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")));
}
export function looksLikeArtifactRequest(text: string) {
  return /\b(?:create|make|build|write|produce|generate|summari[sz]e)\b/i.test(text)
    && /\b(?:website|web site|mock exam|past papers|research (?:brief|summary|report)|summary.{0,60}(?:research|reinforcement)|presentation video|remotion|cheat sheets?|flash cards?)\b/i.test(text);
}
