// script.ts — a video script is DATA: scenes that each name one template from a closed set and give its
// parameters. This file is that contract, once, for everyone who needs it:
//
//   TEMPLATES          the closed set: what each template shows and which parameters it takes
//   briefOfTemplates() the same, as text for the writer (so the prompt can never drift from the code)
//   check(script)      code's review: shape, timing, and EVERY number recomputed (matrix.ts). Problems come
//                      back as sentences a writer can act on; nothing here throws on a bad script
//   screen / facts     per scene: what the viewer will see, and the numbers code computed for it. Jev checks
//                      the narration against these, and the storyboard shows them to a reader
//
// Pure: no Remotion, no network. The Remotion templates import the same parsing, so what is checked is
// what is drawn.

import { apply, det, inverse, isZero, parseMatrix, parseQ, product, sameMatrix, show, showMatrix, steps2x2, identity, toNumber, type Matrix, type Q } from "./matrix";

export type ParamKind = "text" | "tex_lines" | "points" | "matrix2" | "vector2" | "number";
export type ParamSpec = { kind: ParamKind; required: boolean; about: string };
export type TemplateSpec = { shows: string; params: Record<string, ParamSpec> };

const p = (kind: ParamKind, required: boolean, about: string): ParamSpec => ({ kind, required, about });

export const TEMPLATES = {
  title: { shows: "An opening card: the title and a subtitle over a faint number plane. No mathematics yet.",
    params: { title: p("text", true, "at most 40 characters"), subtitle: p("text", false, "at most 70 characters") } },
  transform: { shows: "The number plane with the basis vectors î (green) and ĵ (red). The whole grid moves smoothly from the identity to `matrix`: î lands on its first column, ĵ on its second. The matrix is typeset in the corner with its columns in the same colours. With `vector`, a yellow vector is carried along and its landing point is labelled.",
    params: { matrix: p("matrix2", true, "[[a, b], [c, d]], entries between -3 and 3"), vector: p("vector2", false, "[x, y], a vector to follow") } },
  undo: { shows: "The plane is transformed by `matrix`, pauses, and is then transformed by `inverse`, which brings every grid line and both basis vectors back to where they started. Typeset: A, then A⁻¹, then A⁻¹A = I.",
    params: { matrix: p("matrix2", true, "[[a, b], [c, d]] with a non-zero determinant, entries between -3 and 3"), inverse: p("matrix2", true, "its inverse; code checks that inverse · matrix is the identity") } },
  area: { shows: "The unit square on î and ĵ (area 1, shaded yellow) is carried by `matrix` to a parallelogram; its new area is labelled, and det(A) = ad − bc is typeset with the numbers filled in. A negative determinant is shown as the plane flipping over.",
    params: { matrix: p("matrix2", true, "[[a, b], [c, d]], entries between -3 and 3"), det: p("number", true, "its determinant; code checks it") } },
  collapse: { shows: "The plane is squashed by a matrix whose determinant is 0: every grid line, the unit square and both basis vectors fall onto a single line (area 0). Typeset: the matrix, det = 0, and 'no inverse'. Many different points land on the same point, so nothing can undo it.",
    params: { matrix: p("matrix2", true, "[[a, b], [c, d]] with determinant exactly 0 and not all zeros, entries between -3 and 3") } },
  equation: { shows: "One to four typeset lines of mathematics on a dark background, appearing one after another. For definitions, general formulas and symbolic statements.",
    params: { lines: p("tex_lines", true, "1 to 4 LaTeX strings (KaTeX, no $ signs), each under 120 characters; use \\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix} for matrices; letters rather than numbers: numeric examples belong in the templates whose numbers code checks") } },
  worked_inverse: { shows: "A worked 2x2 example, typeset step by step: the matrix; its determinant ad − bc with the numbers filled in; swap a and d, negate b and c; divide by the determinant to get A⁻¹; and the check that A·A⁻¹ is the identity. Code computes every number shown.",
    params: { matrix: p("matrix2", true, "[[a, b], [c, d]] with a non-zero determinant"), det: p("number", true, "its determinant; code checks it"), inverse: p("matrix2", true, "its inverse (fractions as strings, \"1/2\"); code checks it") } },
  product: { shows: "A typeset product of two 2x2 matrices and its result, with each entry of the result worked out as row times column.",
    params: { left: p("matrix2", true, "the left factor"), right: p("matrix2", true, "the right factor"), result: p("matrix2", true, "left · right; code checks it") } },
  recap: { shows: "A closing list: three to five short points appearing one at a time over a faint number plane.",
    params: { points: p("points", true, "3 to 5 strings of at most 90 characters; mathematics inside a point goes between $ signs as LaTeX") } },
} as const satisfies Record<string, TemplateSpec>;

export type TemplateName = keyof typeof TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateName[];

export type Scene = { id: string; template: TemplateName; seconds: number; narration: string; heading?: string; [param: string]: unknown };
export type Script = { title?: string; scenes: Scene[] };

export const LIMITS = { scenes: [6, 14], sceneSeconds: [4, 30], totalSeconds: [60, 150], wordsPerSecond: [1.2, 2.7], entry: 3, heading: 60 } as const;
const COMMON = ["id", "template", "seconds", "narration", "heading"];

export const FPS = 30;
export const framesOf = (scene: Scene): number => Math.max(1, Math.round((Number(scene.seconds) || 1) * FPS));
/** Where each template is at its fullest, as a fraction of its scene: the frame a still is taken from. */
export const FULLEST: Record<TemplateName, number> = { title: 0.6, transform: 0.8, undo: 0.5, area: 0.85, collapse: 0.9, equation: 0.92, worked_inverse: 0.94, product: 0.92, recap: 0.93 };

/** One still per scene that shows mathematics (a title card is not what a still is for): its name and frame. */
export function stillsOf(script: Script): { name: string; frame: number }[] {
  let at = 0;
  const all = script.scenes.map((scene, i) => { const frames = framesOf(scene), frame = at + Math.min(frames - 1, Math.floor(frames * (FULLEST[scene.template] ?? 0.8))); at += frames; return { name: `${String(i + 1).padStart(2, "0")}-${scene.id}.png`, frame, template: scene.template }; });
  const shown = all.filter((s) => s.template !== "title");
  return (shown.length >= 4 ? shown : all).map(({ name, frame }) => ({ name, frame }));
}

export const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** The contract as the writer reads it. */
export function briefOfTemplates(): string {
  const kinds: Record<ParamKind, string> = { text: "string", tex_lines: "array of LaTeX strings", points: "array of strings", matrix2: "2x2 array", vector2: "[x, y]", number: "number" };
  return TEMPLATE_NAMES.map((name) => {
    const t: TemplateSpec = TEMPLATES[name];
    return `- "${name}": ${t.shows} Parameters: ${Object.entries(t.params).map(([key, spec]) => `${key}${spec.required ? "" : "?"} (${kinds[spec.kind]}: ${spec.about})`).join("; ")}.`;
  }).join("\n");
}

// ---------------------------------------------------------------- parameters as the templates read them

export const matrixOf = (scene: Scene, key: string): Matrix | null => parseMatrix(scene[key], 2);
export const vectorOf = (scene: Scene, key: string): Q[] | null => { const v = scene[key]; if (!Array.isArray(v) || v.length !== 2) return null; const parsed = v.map(parseQ); return parsed.every(Boolean) ? parsed as Q[] : null; };
export const stringsOf = (scene: Scene, key: string): string[] => Array.isArray(scene[key]) ? (scene[key] as unknown[]).filter((x): x is string => typeof x === "string") : [];
export const point = (v: Q[]): string => `(${v.map(show).join(", ")})`;

// ---------------------------------------------------------------- what code knows about a scene

/** The numbers of a scene, computed here, as plain sentences. Empty for a scene without numbers. */
export function facts(scene: Scene): string[] {
  const out: string[] = [];
  const A = matrixOf(scene, scene.template === "product" ? "left" : "matrix");
  if (!A) return out;
  const s = steps2x2(A);
  if (scene.template === "product") {
    const B = matrixOf(scene, "right");
    if (B) out.push(`${showMatrix(A)} times ${showMatrix(B)} equals ${showMatrix(product(A, B))}.`);
    return out;
  }
  out.push(`The matrix is ${showMatrix(A)}. It sends î = (1, 0) to ${point([s.a, s.c])} and ĵ = (0, 1) to ${point([s.b, s.d])}.`);
  const term = (x: Q) => x.n < 0 ? `(${show(x)})` : show(x); // a negative number inside a sum is bracketed
  out.push(`Its determinant is ${show(s.a)}·${term(s.d)} − ${term(s.b)}·${term(s.c)} = ${show(s.ad)} − ${term(s.bc)} = ${show(s.det)}.`);
  if (scene.template === "transform") { const v = vectorOf(scene, "vector"); if (v) out.push(`The vector ${point(v)} lands on ${point(apply(A, v))}.`); }
  if (scene.template === "area" || scene.template === "collapse") out.push(`The unit square, of area 1, becomes a shape of area ${show(s.det.n < 0 ? { n: -s.det.n, d: s.det.d } : s.det)}${s.det.n < 0 ? "; the determinant is negative, so the plane is flipped over" : ""}.`);
  if (s.inverse) out.push(`Its inverse is ${showMatrix(s.inverse)}, which is 1/${s.det.d === 1 && s.det.n > 0 ? show(s.det) : `(${show(s.det)})`} times ${showMatrix(s.adjugate)}; multiplied with the matrix in either order it gives the identity [[1, 0], [0, 1]].`);
  else out.push(`The determinant is 0, so it has no inverse: both columns lie on one line through the origin, and the whole plane lands on that line.`);
  return out;
}

/** What the viewer will see, in one or two sentences, with this scene's own parameters. */
export function screen(scene: Scene): string {
  const A = matrixOf(scene, "matrix"), name = A ? showMatrix(A) : "the matrix", heading = typeof scene.heading === "string" && scene.heading ? `Heading: "${scene.heading}". ` : "";
  const s = A ? steps2x2(A) : null;
  switch (scene.template) {
    case "title": return `A title card over a faint number plane: "${String(scene.title ?? "")}"${scene.subtitle ? `, and under it "${String(scene.subtitle)}"` : ""}.`;
    case "transform": { const v = vectorOf(scene, "vector"); return `${heading}A number plane with î (green) and ĵ (red). The whole grid moves from the identity to ${name}: î lands on ${s ? point([s.a, s.c]) : "the first column"}, ĵ on ${s ? point([s.b, s.d]) : "the second column"}. The matrix is typeset in the corner, columns coloured like the vectors.${v && A ? ` A yellow vector ${point(v)} is carried to ${point(apply(A, v))}.` : ""}`; }
    case "undo": { const B = matrixOf(scene, "inverse"); return `${heading}The plane is transformed by A = ${name}, pauses, then by A⁻¹ = ${B ? showMatrix(B) : "its inverse"}: every grid line and both basis vectors return to where they started. Typeset: A, A⁻¹ and A⁻¹A = I.`; }
    case "area": return `${heading}The unit square (area 1, shaded yellow) is carried by ${name} to a parallelogram labelled with its area ${s ? show({ n: Math.abs(s.det.n), d: s.det.d }) : ""}. Typeset: det(A) = ad − bc = ${s ? show(s.det) : ""}.${s && s.det.n < 0 ? " The plane flips over, because the determinant is negative." : ""}`;
    case "collapse": return `${heading}The plane is squashed by ${name}: all grid lines, the unit square and both basis vectors fall onto one line, area 0. Typeset: the matrix, det(A) = 0, "no inverse".`;
    case "equation": return `${heading}Typeset mathematics on a dark background, one line after another: ${stringsOf(scene, "lines").join("  ;  ")}`;
    case "worked_inverse": return `${heading}A worked example typeset step by step: A = ${name}; det(A) = ${s ? `${show(s.ad)} − ${show(s.bc)} = ${show(s.det)}` : ""}; swap a and d, negate b and c: ${s ? showMatrix(s.adjugate) : ""}; divide by the determinant: A⁻¹ = ${s?.inverse ? showMatrix(s.inverse) : ""}; check: A·A⁻¹ = [[1, 0], [0, 1]].`;
    case "product": { const L = matrixOf(scene, "left"), R = matrixOf(scene, "right"); return `${heading}A typeset product: ${L ? showMatrix(L) : ""} times ${R ? showMatrix(R) : ""} = ${L && R ? showMatrix(product(L, R)) : ""}, each entry worked out as row times column.`; }
    case "recap": return `${heading}A closing list over a faint number plane, one point at a time: ${stringsOf(scene, "points").join(" | ")}`;
    default: return "Nothing: this template does not exist.";
  }
}

// ---------------------------------------------------------------- code's review

/** `hard`: the video cannot be rendered, or would be wrong, until this is corrected. The rest is advice the writer should take. */
export type Problem = { text: string; hard: boolean };
export type Checked = { script: Script | null; problems: Problem[]; seconds: number };

/** `texError` says what is wrong with a LaTeX string, or null: KaTeX's own parser when the kit has it. */
export function check(raw: unknown, texError: (latex: string) => string | null = () => null): Checked {
  const problems: Problem[] = [], hard = (text: string) => { problems.push({ text, hard: true }); }, soft = (text: string) => { problems.push({ text, hard: false }); };
  const scenes = (raw as Script | null)?.scenes;
  if (!raw || typeof raw !== "object" || !Array.isArray(scenes)) return { script: null, problems: [{ text: "video/script.json must be a JSON object { \"title\": string, \"scenes\": [ ... ] }.", hard: true }], seconds: 0 };
  if (scenes.length < LIMITS.scenes[0] || scenes.length > LIMITS.scenes[1]) (scenes.length < 4 ? hard : soft)(`The script has ${scenes.length} scenes; give between ${LIMITS.scenes[0]} and ${LIMITS.scenes[1]}.`);
  const seen = new Set<string>();
  let total = 0;
  scenes.forEach((scene: Scene, index) => {
    const at = `Scene ${index + 1}${typeof scene?.id === "string" ? ` ("${scene.id}")` : ""}`;
    if (!scene || typeof scene !== "object") { hard(`${at} is not an object.`); return; }
    if (typeof scene.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(scene.id)) hard(`${at}: "id" must be a short name of letters, digits and underscores, such as "undo_it".`);
    else if (seen.has(scene.id)) hard(`${at}: the id is used twice.`); else seen.add(scene.id);
    if (!TEMPLATE_NAMES.includes(scene.template)) { hard(`${at}: "template" is ${JSON.stringify(scene.template)}; it must be one of ${TEMPLATE_NAMES.join(", ")}.`); return; }
    const spec: TemplateSpec = TEMPLATES[scene.template];

    // timing: arithmetic, so code
    const seconds = typeof scene.seconds === "number" && Number.isFinite(scene.seconds) ? scene.seconds : 0;
    total += seconds;
    if (seconds < LIMITS.sceneSeconds[0] || seconds > LIMITS.sceneSeconds[1]) (seconds < 2 || seconds > 60 ? hard : soft)(`${at}: "seconds" is ${JSON.stringify(scene.seconds)}; a scene lasts ${LIMITS.sceneSeconds[0]} to ${LIMITS.sceneSeconds[1]} seconds.`);
    if (typeof scene.narration !== "string" || words(scene.narration) < 5) hard(`${at}: "narration" must be at least one full sentence.`);
    else {
      const n = words(scene.narration), rate = seconds ? n / seconds : 0;
      if (seconds && rate > LIMITS.wordsPerSecond[1]) soft(`${at}: ${n} words of narration in ${seconds} seconds is ${rate.toFixed(1)} words a second, too fast to follow. Give it at least ${Math.ceil(n / 2.4)} seconds, or cut the narration to ${Math.floor(seconds * 2.4)} words.`);
      if (seconds && rate < LIMITS.wordsPerSecond[0]) soft(`${at}: ${n} words of narration in ${seconds} seconds leaves the viewer waiting. Give it about ${Math.max(LIMITS.sceneSeconds[0], Math.round(n / 2.2))} seconds, or say more.`);
      if (/\\[a-zA-Z]+|\$|[_^]\{/.test(scene.narration)) soft(`${at}: the narration is spoken; it must not contain LaTeX.`);
    }
    if (scene.heading !== undefined && (typeof scene.heading !== "string" || scene.heading.length > LIMITS.heading)) soft(`${at}: "heading" must be a string of at most ${LIMITS.heading} characters.`);

    // parameters: the closed set, of the right kind
    for (const key of Object.keys(scene)) if (!COMMON.includes(key) && !(key in spec.params)) soft(`${at}: the "${scene.template}" template has no parameter "${key}" (it takes ${Object.keys(spec.params).join(", ")}).`);
    let usable = true;
    for (const [key, param] of Object.entries(spec.params)) {
      const value = scene[key];
      if (value === undefined || value === null) { if (param.required) { hard(`${at}: the "${scene.template}" template needs "${key}" (${param.about}).`); usable = false; } continue; }
      const bad = wrongKind(value, param.kind, key, texError);
      if (bad) { hard(`${at}: ${bad}`); usable = false; }
    }
    if (usable) { for (const line of numbersWrong(scene)) hard(`${at}: ${line}`); for (const line of showsLittle(scene)) soft(`${at}: ${line}`); }
  });
  if (total < LIMITS.totalSeconds[0] || total > LIMITS.totalSeconds[1]) (total < 48 || total > 300 ? hard : soft)(`The scenes add up to ${total} seconds; the video should run ${LIMITS.totalSeconds[0]} to ${LIMITS.totalSeconds[1]} seconds.`);
  return { script: raw as Script, problems, seconds: total };
}

function wrongKind(value: unknown, kind: ParamKind, key: string, texError: (latex: string) => string | null): string | null {
  if (kind === "text") return typeof value === "string" && value.trim() && value.length <= 80 && !/\\[a-zA-Z]/.test(value) ? null : `"${key}" must be plain text of at most 80 characters.`;
  if (kind === "number") return parseQ(value) ? null : `"${key}" must be a number (a fraction as a string, "1/2").`;
  if (kind === "vector2") return Array.isArray(value) && value.length === 2 && value.every((x) => { const n = parseQ(x); return n && Math.abs(toNumber(n)) <= 4; }) ? null : `"${key}" must be [x, y] with both between -4 and 4.`;
  if (kind === "matrix2") return parseMatrix(value, 2) ? null : `"${key}" must be a 2x2 matrix [[a, b], [c, d]] of numbers (fractions as strings, "1/2").`;
  const list = Array.isArray(value) && value.every((x) => typeof x === "string" && x.trim()) ? value as string[] : null;
  if (kind === "tex_lines") {
    if (!list || list.length < 1 || list.length > 4) return `"${key}" must be 1 to 4 LaTeX strings.`;
    for (const line of list) { if (line.length > 160) return `"${key}": a line is ${line.length} characters; keep each under 120 so it fits the screen.`; const error = texError(line.replace(/^\$+|\$+$/g, "")); if (error) return `"${key}": KaTeX cannot typeset ${JSON.stringify(line)}: ${error}`; }
    return null;
  }
  if (!list || list.length < 3 || list.length > 5) return `"${key}" must be 3 to 5 strings.`;
  for (const item of list) {
    if (item.replace(/\$[^$]*\$/g, "xx").length > 100) return `"${key}": ${JSON.stringify(item.slice(0, 40))}… is too long for one line; keep each point under 90 characters.`;
    if ((item.match(/\$/g) ?? []).length % 2) return `"${key}": ${JSON.stringify(item)} has an unmatched $.`;
    for (const m of item.matchAll(/\$([^$]*)\$/g)) { const error = texError(m[1]!); if (error) return `"${key}": KaTeX cannot typeset ${JSON.stringify(m[1])}: ${error}`; }
  }
  return null;
}

/** Every number a scene claims, against what code computes. The feedback carries the right value. */
function numbersWrong(scene: Scene): string[] {
  const out: string[] = [];
  const onPlane = ["transform", "undo", "area", "collapse"].includes(scene.template);
  if (scene.template === "product") {
    const L = matrixOf(scene, "left")!, R = matrixOf(scene, "right")!, claimed = matrixOf(scene, "result")!;
    if (!sameMatrix(product(L, R), claimed)) out.push(`"result" is wrong: ${showMatrix(L)} times ${showMatrix(R)} is ${showMatrix(product(L, R))}, not ${showMatrix(claimed)}.`);
    return out;
  }
  const A = matrixOf(scene, "matrix");
  if (!A) return out;
  const d = det(A), inv = inverse(A);
  if (onPlane && A.flat().some((x) => Math.abs(toNumber(x)) > LIMITS.entry)) out.push(`the entries of "matrix" must lie between -${LIMITS.entry} and ${LIMITS.entry}, or the transformed grid leaves the screen.`);
  if ("det" in scene) { const claimed = parseQ(scene.det); if (claimed && (claimed.n !== d.n || claimed.d !== d.d)) out.push(`"det" is wrong: the determinant of ${showMatrix(A)} is ${show(d)}, not ${show(claimed)}.`); }
  if (scene.template === "collapse") {
    if (!isZero(d)) out.push(`the "collapse" template needs a matrix with determinant 0; ${showMatrix(A)} has determinant ${show(d)}. Make one column a multiple of the other.`);
    if (A.flat().every(isZero)) out.push(`the zero matrix sends everything to one point; use a matrix whose columns lie on one line, such as one column twice the other.`);
  }
  if (scene.template === "undo" || scene.template === "worked_inverse") {
    const claimed = matrixOf(scene, "inverse");
    if (!inv) out.push(`${showMatrix(A)} has determinant 0 and no inverse; this template needs an invertible matrix.`);
    else if (claimed && !sameMatrix(claimed, inv)) out.push(`"inverse" is wrong: the inverse of ${showMatrix(A)} is ${showMatrix(inv)}, not ${showMatrix(claimed)} (their product is ${showMatrix(product(A, claimed))}, not the identity).`);
    else if (claimed && !sameMatrix(product(claimed, A), identity(2))) out.push(`"inverse" times "matrix" is not the identity.`);
    if (scene.template === "undo" && inv && inv.flat().some((x) => Math.abs(toNumber(x)) > LIMITS.entry + 1)) out.push(`the inverse ${showMatrix(inv)} has entries too large to draw; choose a matrix whose inverse stays within ${LIMITS.entry + 1}.`);
  }
  if (scene.template === "area" && isZero(d)) out.push(`this matrix has determinant 0; the "collapse" template shows that case. "area" needs a non-zero determinant.`);
  return out;
}

/** Correct, but the template would have nothing to show: a picture of scaling in which nothing scales. */
function showsLittle(scene: Scene): string[] {
  const A = matrixOf(scene, "matrix");
  if (!A) return [];
  const d = det(A), unit = Math.abs(d.n) === 1 && d.d === 1;
  if (scene.template === "area" && unit) return [`${showMatrix(A)} has determinant ${show(d)}, so the square keeps its area and the viewer sees nothing being scaled. Show area scaling with a matrix whose determinant is clearly not 1, such as 2, 3 or 1/2.`];
  if (scene.template === "worked_inverse" && unit) return [`${showMatrix(A)} has determinant ${show(d)}, so the step "divide by the determinant" changes nothing on screen. Work the example with a matrix whose determinant is not 1 or −1, so that every step of the method is seen to matter.`];
  if ((scene.template === "transform" || scene.template === "undo") && sameMatrix(A, identity(2))) return [`the identity matrix moves nothing; choose a matrix that visibly moves the plane.`];
  return [];
}

// ---------------------------------------------------------------- for readers: Jev, the judge, a person

/** One scene as the reviewer reads it: what is said, what is seen, what code computed. */
export function sceneCard(scene: Scene): { id: string; template: string; seconds: number; narration: string; on_screen: string; computed_by_code: string[] } {
  return { id: scene.id, template: scene.template, seconds: scene.seconds, narration: scene.narration, on_screen: screen(scene), computed_by_code: facts(scene) };
}

/** The storyboard: every scene, what is said, what is seen, and the numbers code computed for it. */
export function storyboard(script: Script): string {
  const total = script.scenes.reduce((sum, s) => sum + (Number(s.seconds) || 0), 0);
  let at = 0;
  const parts = script.scenes.map((scene, i) => {
    const from = at; at += Number(scene.seconds) || 0;
    const computed = facts(scene);
    return `## ${i + 1}. ${scene.id} — template \`${scene.template}\`, ${from}–${at} s\n\n**On screen.** ${screen(scene)}\n\n**Narration (shown as captions).** ${scene.narration}\n${computed.length ? `\n**Computed by code, not by a model.** ${computed.join(" ")}\n` : ""}`;
  });
  return `# Storyboard${script.title ? `: ${script.title}` : ""}\n\n${script.scenes.length} scenes, ${total} seconds. Written by this kit's build from video/script.json: what each scene shows is what its template draws with the scene's parameters, and every number under "computed by code" was recomputed in exact rational arithmetic before rendering.\n\n${parts.join("\n")}`;
}
