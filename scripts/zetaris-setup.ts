// Builds WhyLedger's semantic layer inside Zetaris Lightning, in order:
//   01-02 retail cubes (schemastore views over the federated TPC-DS tables)
//   03    WHYLEDGER_MART lightning database
//   04-05 materialize the retail cubes as filestore parquet tables
//   06-07 NYC taxi cube view + materialization
// Re-runnable: "already exists" errors are reported as skipped.
// Usage: npx tsx scripts/zetaris-setup.ts [prefix regex, e.g. "06|07"]
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Agent, setGlobalDispatcher } from "undici";
import { config } from "../src/config.ts";

// Materializing a cube can take many minutes; disable client-side header/body timeouts.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const z = config.zetaris;
const login: any = await (await fetch(`${z.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: z.username, password: z.password }) })).json();
if (!login?.idToken) throw new Error("Zetaris login failed; check ZETARIS_* in .env.local");
const only = process.argv[2];
const files = fs.readdirSync("zetaris").filter((f) => /^\d\d_.*\.sql$/.test(f) && (!only || new RegExp(`^(${only})`).test(f))).sort();
for (const f of files) {
  const sql = fs.readFileSync(`zetaris/${f}`, "utf8");
  const t0 = Date.now();
  const r = await fetch(`${z.baseUrl}/api/proxy/sql-editor/sqls/run-query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${login.idToken}`, "X-Org-ID": z.orgId!, "X-Request-ID": randomUUID(), "Content-Type": "application/json" },
    body: JSON.stringify({ sql, limit: 1 }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  const body = await r.text();
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.ok) console.log(`ok       ${f}  ${s}s`);
  else if (/already exist/i.test(body)) console.log(`skipped  ${f}  (already exists)`);
  else { console.error(`FAILED   ${f}  ${s}s  HTTP ${r.status}: ${body.slice(0, 300)}`); process.exit(1); }
}
