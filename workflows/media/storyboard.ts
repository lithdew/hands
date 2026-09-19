import { z } from "zod";

const text = (n: number) => z.string().trim().min(1).max(n);
const Matrix = z.tuple([z.tuple([z.number().finite().min(-5).max(5), z.number().finite().min(-5).max(5)]), z.tuple([z.number().finite().min(-5).max(5), z.number().finite().min(-5).max(5)])]);
const Scene = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  title: text(90),
  body: text(260).optional(),
  bullets: z.array(text(130)).max(4).optional(),
  durationSeconds: z.number().min(3).max(30),
  visual: z.enum(["title", "bullets", "matrix", "evidence", "closing"]),
  caption: text(240).optional(),
  narration: text(800).optional(),
  artifactImage: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional(),
  artifactLabel: text(100).optional(),
  evidence: z.array(z.object({label: text(65), value: text(140), source: text(250)}).strict()).max(3).optional(),
  matrix: Matrix.optional(),
}).strict().superRefine((s, c) => {
  if (s.visual === "matrix" && !s.matrix) c.addIssue({code: "custom", message: "A matrix scene requires a numeric 2x2 matrix"});
  if (s.matrix && s.visual !== "matrix") c.addIssue({code: "custom", message: "Only matrix scenes accept a matrix"});
});

export const storyboardSchema = z.object({
  version: z.literal(1),
  title: text(120),
  kind: z.enum(["matrix-inversion", "pitch"]),
  width: z.literal(1280).default(1280),
  height: z.literal(720).default(720),
  fps: z.literal(24).default(24),
  scenes: z.array(Scene).min(2).max(20),
  sources: z.array(z.object({title: text(150), url: z.url().refine(v => /^https?:\/\//.test(v), "Use public HTTP(S) source URLs")}).strict()).max(20),
}).strict().superRefine((s, c) => {
  if (new Set(s.scenes.map(x => x.id)).size !== s.scenes.length) c.addIssue({code: "custom", message: "Scene ids must be unique"});
  if (s.scenes.reduce((n, x) => n + x.durationSeconds, 0) > 240) c.addIssue({code: "custom", message: "Video duration cannot exceed 240 seconds"});
  if (s.kind === "matrix-inversion" && !s.scenes.some(x => x.matrix && Math.abs(determinant(x.matrix)) > 1e-8)) c.addIssue({code: "custom", message: "Matrix inversion video requires a nonsingular matrix scene"});
});

export type Storyboard = z.infer<typeof storyboardSchema>;
export type StoryScene = Storyboard["scenes"][number];
export type Matrix2 = z.infer<typeof Matrix>;
export function determinant(m: Matrix2) { return m[0][0] * m[1][1] - m[0][1] * m[1][0]; }
export function inverse(m: Matrix2): Matrix2 | null {
  const d = determinant(m);
  return Math.abs(d) < 1e-8 ? null : [[m[1][1] / d, -m[0][1] / d], [-m[1][0] / d, m[0][0] / d]];
}
export type PreparedScene = StoryScene & {frames: number; startFrame: number; videoAsset?: string; audioAsset?: string; imageAsset?: string};
export type PreparedStoryboard = Omit<Storyboard, "scenes"> & {scenes: PreparedScene[]; durationInFrames: number};
