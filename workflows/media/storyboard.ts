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
  layout: z.enum(["kinetic-title", "workflow", "task-field", "artifact-stage", "editorial", "statement", "closing-mark"]).optional(),
  tone: z.enum(["ink", "ivory", "cobalt"]).optional(),
  kicker: text(55).optional(),
  emphasis: text(45).optional(),
  chips: z.array(text(65)).min(1).max(6).optional(),
  workflow: z.array(z.object({label:text(24),detail:text(80).optional()}).strict()).min(3).max(4).optional(),
  correction: text(65).optional(),
  math: z.object({kind:z.enum(["inverse-formula","identity","inverse-example","solve"]),matrix:Matrix.optional(),vector:z.tuple([z.number().finite().min(-20).max(20),z.number().finite().min(-20).max(20)]).optional()}).strict().optional(),
}).strict().superRefine((s, c) => {
  if (s.visual === "matrix" && !s.matrix) c.addIssue({code: "custom", message: "A matrix scene requires a numeric 2x2 matrix"});
  if (s.matrix && s.visual !== "matrix") c.addIssue({code: "custom", message: "Only matrix scenes accept a matrix"});
  if (s.emphasis && !s.title.includes(s.emphasis)) c.addIssue({code:"custom",message:"emphasis must be an exact phrase in the scene title"});
  if (s.layout === "artifact-stage" && !s.artifactImage) c.addIssue({code:"custom",message:"artifact-stage requires a trusted artifactImage ID"});
  if (s.correction && s.layout !== "workflow") c.addIssue({code:"custom",message:"A correction branch belongs to an explicit workflow layout"});
  if(s.math && s.visual === "matrix") c.addIssue({code:"custom",message:"Use separate actual Manim geometry and typeset equation scenes"});
  if(s.math && ["inverse-example","solve"].includes(s.math.kind) && (!s.math.matrix || Math.abs(determinant(s.math.matrix))<1e-8)) c.addIssue({code:"custom",message:"A worked equation requires an invertible numeric matrix"});
  if(s.math?.kind === "solve" && !s.math.vector) c.addIssue({code:"custom",message:"A solve equation requires its right-hand-side vector"});
  if(s.math && (s.math.matrix?.flat().some(n=>!Number.isInteger(n)) || s.math.vector?.some(n=>!Number.isInteger(n)))) c.addIssue({code:"custom",message:"Typeset worked equations use integer matrix/vector inputs for exact rational results"});
  if(s.math && (s.body?.length ?? 0)>110) c.addIssue({code:"custom",message:"Keep equation-scene body to 110 characters; put explanation in the caption or transcript"});
  if(s.math && s.durationSeconds<8) c.addIssue({code:"custom",message:"Equation scenes need at least 8 seconds for staged reveal and reading"});
});

export const storyboardSchema = z.object({
  version: z.literal(1),
  title: text(120),
  kind: z.enum(["matrix-inversion", "pitch"]),
  width: z.literal(1280).default(1280),
  height: z.literal(720).default(720),
  fps: z.literal(24).default(24),
  design: z.object({theme:z.literal("editorial-cobalt"),motion:z.enum(["expressive","restrained"]).default("expressive")}).strict().optional(),
  music: z.object({style:z.enum(["minimal-electronic","warm-keys"]),tempoBpm:z.number().int().min(72).max(132).default(104),intensity:z.number().min(.2).max(1).default(.65),seed:z.number().int().min(0).max(65535).default(23),gainDb:z.number().min(-18).max(0).default(-3)}).strict().optional(),
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
export type PreparedStoryboard = Omit<Storyboard, "scenes"> & {scenes: PreparedScene[]; durationInFrames: number; musicAsset?:string};
