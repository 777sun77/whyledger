// Numeric grounding check for model-written answers.
// The citation check proves every [ev-n] exists; this proves every NUMBER in
// the narration also exists in the computed findings (the SQL results), so
// Nemotron cannot introduce a figure the receipts do not support.

export interface NumberToken { raw: string; value: number; kind: "money" | "pct" | "count" }

const MULT: Record<string, number> = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9 };

/** Extract numeric claims: $5.17M, -$3.2k, 81%, +1.3%, 3.83M trips, 1,234. */
export function extractNumbers(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  // drop receipt ids, period labels and years so they are not treated as claims
  const t = text
    .replace(/\bev-\d+\b/g, " ")
    .replace(/\b(19|20)\d\d(-\d\d)?\b/g, " ")
    .replace(/\bQ[1-4]\b/g, " ");
  const re = /([+\-−]?)(\$?)(\d[\d,]*(?:\.\d+)?)\s*([kKmMbB](?![a-z]))?\s*(%)?/g;
  for (const m of t.matchAll(re)) {
    const [raw, , dollar, digits, mult, pctSign] = m;
    let value = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    if (mult) value *= MULT[mult];
    const kind: NumberToken["kind"] = pctSign ? "pct" : dollar ? "money" : "count";
    out.push({ raw: raw.trim(), value, kind });
  }
  return out;
}

/**
 * A claim is grounded when the same magnitude appears in the source text
 * (computed findings + baseline line) within rounding tolerance.
 * Small integers (list numbering, "two drivers") are ignored.
 */
export function checkGrounding(answer: string, sources: string[]) {
  const allowed = sources.flatMap(extractNumbers);
  const claims = extractNumbers(answer).filter((c) => !(c.kind === "count" && Number.isInteger(c.value) && c.value <= 12));
  const ok = (c: NumberToken) =>
    allowed.some((a) => {
      if (c.kind === "pct" || a.kind === "pct") return a.kind === c.kind && Math.abs(a.value - c.value) <= 0.6;
      const tol = Math.max(Math.abs(a.value) * 0.011, 0.6); // 2-3 significant digit rounding
      return Math.abs(Math.abs(a.value) - Math.abs(c.value)) <= tol;
    });
  const ungrounded = claims.filter((c) => !ok(c)).map((c) => c.raw);
  return { claims: claims.length, grounded: claims.length - ungrounded.length, ungrounded };
}
