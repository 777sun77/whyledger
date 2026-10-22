// Planted-cause evaluation: does WhyLedger find a cause we put there on purpose,
// and does it refuse to invent one when there is none?
//
// We copy one real quarter (TPC-DS sf0.1, 2001 Q4, all channels) and synthesize
// the next-year quarter with a KNOWN cause planted in it: one category, state or
// customer segment collapses or surges, prices rise, demand moves to the web,
// returns spike, or nothing happens at all (noise / uniform controls). Then the
// unchanged investigator (same SQL, same scoring) answers
// "Why did store revenue change from 2001 Q4 to 2002 Q4?" and we grade it.
//
// Runs offline in ~10 s, no Zetaris and no keys:   npm run eval:planted
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.WHYLEDGER_LLM = "none";
process.env.WHYLEDGER_BACKEND = "local";
process.env.WHYLEDGER_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "whyledger-eval-"));
const { DuckDBInstance } = await import("@duckdb/node-api");
const { investigate } = await import("../src/agent/investigator.ts");
const { openMemory } = await import("../src/memory/meterless.ts");
const { assertReadOnly } = await import("../src/data/backend.ts");
type SqlBackend = import("../src/data/backend.ts").SqlBackend;

const SEGMENT_DIMS = ["state", "category", "education", "promoted"];
interface Scenario {
  name: string;
  /** SQL expressions for the 2002 Q4 copy */
  revenue: string; units: string; returns?: string; webBoost?: number;
  expect: { hypothesis?: string; lead?: string; story?: "price" | "volume"; none?: boolean };
}
const seg = (dim: string, v: string, f: number): Pick<Scenario, "revenue" | "units"> => ({
  revenue: `CASE WHEN channel='store' AND ${dim}='${v}' THEN revenue*${f} ELSE revenue END`,
  units: `CASE WHEN channel='store' AND ${dim}='${v}' THEN units*${f} ELSE units END`,
});
const scenarios: Scenario[] = [
  ...[["Electronics", 0.55], ["Books", 0.6], ["Home", 1.5], ["Shoes", 0.5]].map(([v, f]) => ({ name: `category ${v} x${f}`, ...seg("category", v as string, f as number), expect: { hypothesis: "category", lead: v as string } })),
  ...[["TX", 0.5], ["KY", 1.6], ["GA", 0.4]].map(([v, f]) => ({ name: `shopper state ${v} x${f}`, ...seg("state", v as string, f as number), expect: { hypothesis: "state", lead: v as string } })),
  ...[["College", 1.45], ["Primary", 0.6], ["4 yr Degree", 0.6]].map(([v, f]) => ({ name: `segment ${v} x${f}`, ...seg("education", v as string, f as number), expect: { hypothesis: "education", lead: v as string } })),
  { name: "promotion-driven lift (no-promo sales x4)", ...seg("promoted", "no promotion", 4), expect: { hypothesis: "promoted", lead: "no promotion" } },
  { name: "price rise +10%, same units", revenue: "CASE WHEN channel='store' THEN revenue*1.10 ELSE revenue END", units: "units", expect: { story: "price" } },
  { name: "uniform volume drop -15%", revenue: "CASE WHEN channel='store' THEN revenue*0.85 ELSE revenue END", units: "CASE WHEN channel='store' THEN units*0.85 ELSE units END", expect: { story: "volume" } },
  { name: "demand moves from store to web", revenue: "CASE WHEN channel='store' THEN revenue*0.9 ELSE revenue END", units: "CASE WHEN channel='store' THEN units*0.9 ELSE units END", webBoost: 0.1, expect: { hypothesis: "channel_shift" } },
  { name: "returns spike (store returns x4, sales -5%)", revenue: "CASE WHEN channel='store' THEN revenue*0.95 ELSE revenue END", units: "CASE WHEN channel='store' THEN units*0.95 ELSE units END", returns: "CASE WHEN channel='store' THEN return_amt*4 ELSE return_amt END", expect: { hypothesis: "returns" } },
  { name: "control: noise only (+/-0.4%)", revenue: "revenue*(1 + 0.004*sin(hash(state||category||education)))", units: "units", expect: { none: true } },
  { name: "control: uniform +6% (no single cause)", revenue: "CASE WHEN channel='store' THEN revenue*1.06 ELSE revenue END", units: "CASE WHEN channel='store' THEN units*1.06 ELSE units END", expect: { none: true, story: "volume" } },
];

const db = await (await DuckDBInstance.create(":memory:")).connect();
await db.run(`ATTACH '${path.resolve("data/local.duckdb")}' AS src (READ_ONLY)`);
const backend: SqlBackend = {
  name: "eval (DuckDB, planted causes)", isZetaris: false, t: (x) => x,
  async run(sql) { assertReadOnly(sql); const s = Date.now(); const r = await db.runAndReadAll(sql); return { columns: r.columnNames(), rows: r.getRowObjectsJson().map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]))), ms: Date.now() - s }; },
  async catalog() { return []; },
};
const mem = await openMemory();
const Q = "Why did store revenue change from 2001 Q4 to 2002 Q4?";
const results: any[] = [];
for (const sc of scenarios) {
  const base = "FROM src.sales_cube WHERE yr = 2001 AND qoy = 4";
  await db.run(`CREATE OR REPLACE TABLE sales_cube AS
    SELECT * ${base}
    UNION ALL SELECT 2002 AS yr, 4 AS qoy, channel, category, state, education, promoted, ${sc.revenue} AS revenue, ${sc.units} AS units, lines ${base}`);
  if (sc.webBoost) {
    // move the store's lost revenue to the web, spread in proportion
    await db.run(`UPDATE sales_cube SET revenue = revenue * (1 + (SELECT SUM(revenue) FROM src.sales_cube WHERE yr=2001 AND qoy=4 AND channel='store') * ${sc.webBoost} / (SELECT SUM(revenue) FROM src.sales_cube WHERE yr=2001 AND qoy=4 AND channel='web')) WHERE yr = 2002 AND channel = 'web'`);
  }
  const rb = "FROM src.returns_cube WHERE yr = 2001 AND qoy = 4";
  await db.run(`CREATE OR REPLACE TABLE returns_cube AS SELECT * ${rb} UNION ALL SELECT 2002 AS yr, 4 AS qoy, channel, category, state, ${sc.returns ?? "return_amt"} AS return_amt, lines ${rb}`);

  const r = await investigate(Q, backend, mem);
  const f = (id: string) => r.findings.find((x) => x.hypothesis === id);
  const supportedSeg = r.findings.filter((x) => SEGMENT_DIMS.includes(x.hypothesis) && x.verdict === "supported").map((x) => x.hypothesis);
  const pv = f("price_volume");
  const checks: Record<string, boolean> = {};
  if (sc.expect.hypothesis) {
    const h = f(sc.expect.hypothesis);
    checks.found = h?.verdict === "supported";
    if (sc.expect.lead) checks.lead = h?.drivers[0]?.segment === sc.expect.lead;
    checks.noFalseSegment = supportedSeg.filter((x) => x !== sc.expect.hypothesis).length === 0;
  }
  if (sc.expect.story) checks.story = new RegExp(`mostly a ${sc.expect.story} story`).test(pv?.summary ?? "");
  if (sc.expect.none) checks.noFalseCause = supportedSeg.length === 0 && !["channel_shift", "returns"].some((x) => f(x)?.verdict === "supported");
  checks.bounded = r.findings.every((x) => x.explains >= 0 && x.explains <= 1 && x.drivers.every((d) => Math.abs(d.shareOfDelta) <= 1 + 1e-9));
  checks.receipts = r.findings.every((x) => x.evidence.every((id) => r.evidence.some((e) => e.id === id)));
  const pass = Object.values(checks).every(Boolean);
  results.push({ scenario: sc.name, pass, checks, change: `${(r.baseline.pct * 100).toFixed(1)}%`, top: r.findings.filter((x) => x.verdict !== "rejected").slice(0, 3).map((x) => `${x.hypothesis}:${x.verdict}${x.drivers[0] ? `(${x.drivers[0].segment})` : ""}`), ruledOut: r.findings.filter((x) => x.verdict === "rejected").map((x) => x.hypothesis) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${sc.name.padEnd(44)} change ${results.at(-1).change.padStart(6)}  ${JSON.stringify(checks)}`);
}
const n = results.length, ok = results.filter((x) => x.pass).length;
const allChecks = results.flatMap((x) => Object.values(x.checks)), okChecks = allChecks.filter(Boolean).length;
console.log(`\n${ok}/${n} scenarios fully correct · ${okChecks}/${allChecks.length} individual checks`);
fs.mkdirSync("eval", { recursive: true });
fs.writeFileSync("eval/planted-results.json", JSON.stringify({ question: Q, ranAt: new Date().toISOString(), scenarios: n, passed: ok, checks: allChecks.length, checksPassed: okChecks, results }, null, 2));
process.exit(0);
