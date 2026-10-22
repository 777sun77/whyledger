// Faithfulness evaluation on the real Zetaris Lightning instance.
// For every example question: run the full investigation (live SQL on Zetaris,
// Nemotron narration), then check
//   1. every cited receipt id exists                      (citation check)
//   2. every number in the answer appears in the SQL results (numeric grounding)
//   3. attribution is bounded (0..100%)
//   4. the baseline from the materialized cube equals an independent recompute
//      straight from the raw source tables (TPCDS_DB / NY_TAXI), bypassing
//      WhyLedger's semantic layer.
// Usage: npm run eval:zetaris   (needs the Zetaris stack + .env.local)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// run on a copy of the state dir so the live demo's memory is untouched (keeps the LLM cache)
const state = fs.mkdtempSync(path.join(os.tmpdir(), "whyledger-zeval-"));
if (fs.existsSync(".whyledger/llm-cache.json")) fs.copyFileSync(".whyledger/llm-cache.json", path.join(state, "llm-cache.json"));
process.env.WHYLEDGER_STATE = state;
await import("../src/config.ts");
const { getBackend } = await import("../src/data/index.ts");
const { investigate } = await import("../src/agent/investigator.ts");
const { openMemory } = await import("../src/memory/meterless.ts");
const { checkGrounding } = await import("../src/agent/grounding.ts");
const { DATASETS } = await import("../src/agent/datasets.ts");

const backend = await getBackend();
if (!backend.isZetaris) throw new Error("eval:zetaris needs the Zetaris backend (.env.local)");
const mem = await openMemory();
const questions = [...DATASETS.retail.examples, ...DATASETS.taxi.examples];

// independent recomputation from raw sources (no WhyLedger view, no materialized cube)
const RAW: Record<string, string> = {
  "Why did store revenue change from 2001 Q4 to 2002 Q4?": `SELECT SUM(CASE WHEN d.d_year = 2001 THEN s.ss_net_paid ELSE 0 END) AS v_from, SUM(CASE WHEN d.d_year = 2002 THEN s.ss_net_paid ELSE 0 END) AS v_to FROM TPCDS_DB.store_sales s JOIN TPCDS_DB.date_dim d ON d.d_date_sk = s.ss_sold_date_sk WHERE d.d_qoy = 4 AND d.d_year IN (2001, 2002)`,
  "Why did yellow taxi trips drop from 2024-10 to 2025-02?": `SELECT SUM(CASE WHEN substr(tpep_pickup_datetime, 1, 7) = '2024-10' THEN 1 ELSE 0 END) AS v_from, SUM(CASE WHEN substr(tpep_pickup_datetime, 1, 7) = '2025-02' THEN 1 ELSE 0 END) AS v_to FROM NY_TAXI.yellow_taxi WHERE substr(tpep_pickup_datetime, 1, 7) IN ('2024-10', '2025-02')`,
};

const out: any[] = [];
for (const q of questions) {
  const t0 = Date.now();
  try {
    const r = await investigate(q, backend, mem);
    const seconds = +((Date.now() - t0) / 1000).toFixed(1);
    const ids = new Set(r.evidence.map((e) => e.id));
    const cited = [...r.answer.matchAll(/ev-\d+/g)].map((m) => m[0]);
    const narrated = !/template/.test(r.answerMode);
    const g = narrated ? r.grounding ?? checkGrounding(r.answer, [r.answer]) : { claims: 0, grounded: 0, ungrounded: [] };
    let recompute: any = "n/a";
    if (RAW[q]) {
      const tr = Date.now();
      const raw = (await backend.run(RAW[q])).rows[0];
      const dFrom = Math.abs(Number(raw.v_from) - r.baseline.from), dTo = Math.abs(Number(raw.v_to) - r.baseline.to);
      recompute = { cube: [r.baseline.from, r.baseline.to], raw: [Number(raw.v_from), Number(raw.v_to)], rawScanSeconds: +((Date.now() - tr) / 1000).toFixed(1), match: dFrom < 0.01 * Math.max(1, Math.abs(r.baseline.from) * 1e-6) + 0.01 && dTo < 0.01 + Math.abs(r.baseline.to) * 1e-6 };
    }
    const row = {
      question: q, ok: true, seconds, receipts: r.evidence.length,
      answerMode: r.answerMode, narratedByNemotron: narrated,
      citations: { cited: cited.length, valid: cited.filter((c) => ids.has(c)).length },
      numbers: g, bounded: r.findings.every((f) => f.explains >= 0 && f.explains <= 1 && f.drivers.every((d) => Math.abs(d.shareOfDelta) <= 1 + 1e-9)),
      supported: r.findings.filter((f) => f.verdict === "supported").map((f) => f.hypothesis), ruledOut: r.findings.filter((f) => f.verdict === "rejected").map((f) => f.hypothesis),
      recompute, answer: r.answer,
    };
    out.push(row);
    console.log(`${q}\n  ${row.seconds}s · ${row.receipts} receipts · ${row.answerMode} · citations ${row.citations.valid}/${row.citations.cited} · numbers ${g.grounded}/${g.claims} · bounded ${row.bounded} · recompute ${typeof recompute === "string" ? recompute : recompute.match}`);
  } catch (e) {
    out.push({ question: q, ok: false, error: (e as Error).message.slice(0, 300) });
    console.log(`${q}\n  ERROR ${(e as Error).message.slice(0, 200)}`);
  }
}
fs.mkdirSync("eval", { recursive: true });
fs.writeFileSync("eval/zetaris-results.json", JSON.stringify({ backend: backend.name, ranAt: new Date().toISOString(), results: out }, null, 2));
process.exit(0);
