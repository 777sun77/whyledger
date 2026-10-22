// Local dev fallback ONLY: generates the same TPC-DS schema that ships as the
// TPCDS_DB sample on every Zetaris instance, so the agent can be developed
// before a Zetaris instance is available. The demo runs against Zetaris.
import { DuckDBInstance } from "@duckdb/node-api";
const sf = process.argv[2] ?? "0.1";
const inst = await DuckDBInstance.create("data/local.duckdb");
const c = await inst.connect();
await c.run("SET custom_extension_repository='https://extensions.duckdb.org';");
try { await c.run("LOAD tpcds;"); } catch { try { await c.run("INSTALL tpcds; LOAD tpcds;"); } catch { await c.run("INSTALL '.duckdb-ext/tpcds.duckdb_extension'; LOAD tpcds;"); } }
const t = await c.runAndReadAll("SELECT count(*) FROM information_schema.tables WHERE table_name='store_sales'");
if (Number(t.getRows()[0][0]) === 0) { await c.run(`CALL dsdgen(sf=${sf})`); console.log(`generated TPC-DS sf=${sf}`); }
else console.log("TPC-DS already present");
const r = await c.runAndReadAll("SELECT count(*) FROM store_sales");
console.log("store_sales rows:", String(r.getRows()[0][0]));

// Same investigation cubes as zetaris/01_sales_cube.sql + 02_returns_cube.sql (dev mirror)
import fs from "node:fs";
for (const [file, name] of [["zetaris/01_sales_cube.sql", "sales_cube"], ["zetaris/02_returns_cube.sql", "returns_cube"]] as const) {
  const body = fs.readFileSync(file, "utf8").replace(/^CREATE OR REPLACE SCHEMASTORE VIEW \w+ WITH CONTAINER \w+ AS/m, "").replace(/TPCDS_DB\./g, "");
  await c.run(`CREATE OR REPLACE TABLE ${name} AS ${body}`);
  const n = await c.runAndReadAll(`SELECT count(*) FROM ${name}`);
  console.log(`${name}: ${String(n.getRows()[0][0])} rows`);
}
