// matrix.ts — exact arithmetic for the numbers a mathematics video shows.
//
// No model's arithmetic is trusted: every determinant, inverse and product in a script is recomputed
// here, in rationals (so 1/3 stays 1/3), and what the video typesets is what this file computed.
// Pure, shared by the kit (checking a script under Bun) and the Remotion templates (drawing it).

/** A rational number n/d in lowest terms, d > 0. */
export type Q = { n: number; d: number };
export type Matrix = Q[][];

const gcd = (a: number, b: number): number => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a || 1; };

export function q(n: number, d = 1): Q {
  if (!Number.isInteger(n) || !Number.isInteger(d) || d === 0) throw new Error(`not a rational: ${n}/${d}`);
  const g = gcd(n, d) * (d < 0 ? -1 : 1);
  return { n: n / g || 0, d: d / g };
}

/** A script's number: 3, -0.25, "1/2", "-3/4", "0.5", "−2" (a typographic minus is a minus). Null when it is not one. */
export function parseQ(value: unknown): Q | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > 1e6) return null;
    for (const d of [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 50, 100, 1000]) if (Math.abs(value * d - Math.round(value * d)) < 1e-9) return q(Math.round(value * d), d);
    return null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/[−–]/g, "-").replace(/\s+/g, "");
  const fraction = /^(-?\d{1,7})\/(\d{1,7})$/.exec(text);
  if (fraction) return Number(fraction[2]) === 0 ? null : q(Number(fraction[1]), Number(fraction[2]));
  return /^-?\d{1,7}(\.\d{1,4})?$/.test(text) ? parseQ(Number(text)) : null;
}

export const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
export const neg = (a: Q): Q => q(-a.n, a.d);
export const sub = (a: Q, b: Q): Q => add(a, neg(b));
export const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
export const div = (a: Q, b: Q): Q => { if (b.n === 0) throw new Error("division by zero"); return q(a.n * b.d, a.d * b.n); };
export const eq = (a: Q, b: Q): boolean => a.n === b.n && a.d === b.d;
export const isZero = (a: Q): boolean => a.n === 0;
export const toNumber = (a: Q): number => a.n / a.d;
/** "-1/2", "3". A real minus sign, as typeset. */
export const show = (a: Q): string => `${a.n < 0 ? "−" : ""}${Math.abs(a.n)}${a.d === 1 ? "" : `/${a.d}`}`;
export const tex = (a: Q): string => a.d === 1 ? `${a.n}` : `${a.n < 0 ? "-" : ""}\\frac{${Math.abs(a.n)}}{${a.d}}`;
/** In a sum or product a negative number is bracketed: 2·(−1). */
export const texTerm = (a: Q): string => a.n < 0 ? `(${tex(a)})` : tex(a);

/** A script's matrix (rows of numbers or "a/b" strings), square, of the wanted size. Null when it is not one. */
export function parseMatrix(value: unknown, size?: number): Matrix | null {
  if (!Array.isArray(value) || !value.length || value.length > 4) return null;
  const rows = value.map((row) => Array.isArray(row) ? row.map(parseQ) : null);
  if (rows.some((row) => !row || row.length !== value.length || row.some((x) => !x))) return null;
  return size && value.length !== size ? null : rows as Matrix;
}

export const identity = (size: number): Matrix => Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => q(i === j ? 1 : 0)));
export const sameMatrix = (a: Matrix, b: Matrix): boolean => a.length === b.length && a.every((row, i) => row.length === b[i]!.length && row.every((x, j) => eq(x, b[i]![j]!)));
export const showMatrix = (m: Matrix): string => `[${m.map((row) => `[${row.map(show).join(", ")}]`).join(", ")}]`;
/** Rows of fractions get a little air, or the fraction bar of one row touches the next. */
export const texRows = (m: Matrix): string => m.some((row) => row.some((x) => x.d !== 1)) ? " \\\\[0.45em] " : " \\\\ ";
export const texMatrix = (m: Matrix): string => `\\begin{bmatrix} ${m.map((row) => row.map(tex).join(" & ")).join(texRows(m))} \\end{bmatrix}`;
export const numbers = (m: Matrix): number[][] => m.map((row) => row.map(toNumber));

export function product(a: Matrix, b: Matrix): Matrix {
  if (a.length !== b.length) throw new Error("the matrices differ in size");
  return a.map((row) => b.map((_, j) => row.reduce((sum, x, k) => add(sum, mul(x, b[k]![j]!)), q(0))));
}

export function apply(m: Matrix, v: Q[]): Q[] {
  return m.map((row) => row.reduce((sum, x, k) => add(sum, mul(x, v[k]!)), q(0)));
}

/** By cofactors along the first row: exact, and the sizes here are at most 4. */
export function det(m: Matrix): Q {
  if (m.length === 1) return m[0]![0]!;
  return m[0]!.reduce((sum, x, j) => {
    const minor = m.slice(1).map((row) => row.filter((_, k) => k !== j));
    return add(sum, mul(mul(q(j % 2 ? -1 : 1), x), det(minor)));
  }, q(0));
}

/** Gauss-Jordan in rationals. Null when the determinant is zero. */
export function inverse(m: Matrix): Matrix | null {
  const size = m.length, work = m.map((row, i) => [...row, ...identity(size)[i]!]);
  for (let col = 0; col < size; col++) {
    const pivot = work.findIndex((row, i) => i >= col && !isZero(row[col]!));
    if (pivot < 0) return null;
    [work[col], work[pivot]] = [work[pivot]!, work[col]!];
    const lead = work[col]![col]!;
    work[col] = work[col]!.map((x) => div(x, lead));
    for (let i = 0; i < size; i++) if (i !== col && !isZero(work[i]![col]!)) { const factor = work[i]![col]!; work[i] = work[i]!.map((x, k) => sub(x, mul(factor, work[col]![k]!))); }
  }
  return work.map((row) => row.slice(size));
}

/** Everything a 2x2 worked example shows, step by step, for [[a, b], [c, d]]. */
export function steps2x2(m: Matrix): { a: Q; b: Q; c: Q; d: Q; ad: Q; bc: Q; det: Q; adjugate: Matrix; inverse: Matrix | null } {
  const [a, b, c, d] = [m[0]![0]!, m[0]![1]!, m[1]![0]!, m[1]![1]!];
  const ad = mul(a, d), bc = mul(b, c), determinant = sub(ad, bc);
  return { a, b, c, d, ad, bc, det: determinant, adjugate: [[d, neg(b)], [neg(c), a]], inverse: inverse(m) };
}
