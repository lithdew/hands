import { z } from "zod";

/** Legibility contract. Every frame is 1280x720 but is also watched inside a
 * 390px-wide phone page, where the whole frame is about 360px wide. Text is
 * therefore set large (headings 48-72px, body 30-38px, captions 28px) and each
 * scene gets a small text budget: one idea per scene, short bullets, and a
 * caption under 130 characters. Overloaded scenes are rejected here, before
 * rendering, so the specialist can shorten them. Write 2x2 matrices inline as
 * [[a,b],[c,d]]: the renderer typesets that notation as a real two-row matrix. */
const text = (n: number) => z.string().trim().min(1).max(n);
const Matrix = z.tuple([z.tuple([z.number().finite().min(-5).max(5), z.number().finite().min(-5).max(5)]), z.tuple([z.number().finite().min(-5).max(5), z.number().finite().min(-5).max(5)])]);
export const SCENE_TEXT_BUDGET = { title: 60, body: 170, bullet: 90, bullets: 4, caption: 130, matrixBody: 120, matrixBullet: 64, matrixBullets: 3, total: 420, matrixTotal: 300, wordsPerSecond: 4 } as const;
const Scene = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  title: text(SCENE_TEXT_BUDGET.title),
  body: text(SCENE_TEXT_BUDGET.body).optional(),
  bullets: z.array(text(SCENE_TEXT_BUDGET.bullet)).max(SCENE_TEXT_BUDGET.bullets).optional(),
  durationSeconds: z.number().min(3).max(30),
  visual: z.enum(["title", "bullets", "matrix", "evidence", "closing"]),
  caption: text(SCENE_TEXT_BUDGET.caption).optional(),
  narration: text(800).optional(),
  artifactImage: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional(),
  artifactLabel: text(80).optional(),
  evidence: z.array(z.object({label: text(40), value: text(90), source: text(120)}).strict()).max(3).optional(),
  matrix: Matrix.optional(),
  /** Single capital letter naming the animated matrix in the trusted panel (default: the letter used as "X = [[" in the copy, else A). */
  matrixName: z.string().regex(/^[A-Z]$/).optional(),
}).strict().superRefine((s, c) => {
  if (s.visual === "matrix" && !s.matrix) c.addIssue({code: "custom", message: "A matrix scene requires a numeric 2x2 matrix"});
  if (s.matrix && s.visual !== "matrix") c.addIssue({code: "custom", message: "Only matrix scenes accept a matrix"});
  if (s.matrixName && s.visual !== "matrix") c.addIssue({code: "custom", message: "Only matrix scenes accept a matrixName"});
  const bullets = s.bullets ?? [];
  if (s.visual === "matrix") {
    if ((s.body?.length ?? 0) > SCENE_TEXT_BUDGET.matrixBody) c.addIssue({code: "custom", message: `Matrix scene body must stay within ${SCENE_TEXT_BUDGET.matrixBody} characters: the animation shares the frame`});
    if (bullets.length > SCENE_TEXT_BUDGET.matrixBullets || bullets.some(b => b.length > SCENE_TEXT_BUDGET.matrixBullet)) c.addIssue({code: "custom", message: `Matrix scenes allow at most ${SCENE_TEXT_BUDGET.matrixBullets} bullets of ${SCENE_TEXT_BUDGET.matrixBullet} characters beside the animation`});
  }
  const copy = [s.title, s.body ?? "", ...bullets].join(" ");
  const budget = s.visual === "matrix" ? SCENE_TEXT_BUDGET.matrixTotal : SCENE_TEXT_BUDGET.total;
  if (copy.length > budget) c.addIssue({code: "custom", message: `Scene text (title, body and bullets) is ${copy.length} characters; keep it within ${budget} so it stays legible on a phone-sized player. Split the idea across scenes.`});
  const words = copy.split(/\s+/).filter(Boolean).length;
  if (s.durationSeconds * SCENE_TEXT_BUDGET.wordsPerSecond < words) c.addIssue({code: "custom", message: `${words} words need at least ${Math.ceil(words / SCENE_TEXT_BUDGET.wordsPerSecond)} seconds of reading time; raise durationSeconds or shorten the copy`});
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
