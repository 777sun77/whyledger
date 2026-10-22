// Zetaris Lightning backend: every investigation query runs through the
// Zetaris query engine via the UI proxy route used by zetaris/getting-started
// (POST /api/proxy/sql-editor/sqls/run-query). Credentials stay server-side.
import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { assertReadOnly, type QueryResult, type SqlBackend } from "./backend.ts";

export class ZetarisBackend implements SqlBackend {
  name = "Zetaris Lightning";
  isZetaris = true;
  private token?: string;
  private z = config.zetaris;

  constructor() {
    if (!this.z.orgId || !/^\d+$/.test(this.z.orgId)) throw new Error("Set ZETARIS_ORG_ID (numeric) in .env.local");
  }

  t(table: string) {
    return `${this.z.martPrefix}${table}`;
  }

  private async auth(): Promise<string> {
    if (this.z.apiKey) return this.z.apiKey;
    if (this.token) return this.token;
    if (!this.z.username || !this.z.password) throw new Error("Set ZETARIS_API_KEY or ZETARIS_USERNAME + ZETARIS_PASSWORD in .env.local");
    const r = await fetch(`${this.z.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": randomUUID() },
      body: JSON.stringify({ username: this.z.username, password: this.z.password }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`Zetaris login failed: HTTP ${r.status}`);
    const j: any = await r.json();
    const tok = j?.idToken ?? j?.token ?? j?.accessToken ?? JSON.stringify(j).match(/[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/)?.[0];
    if (!tok) throw new Error("Zetaris login returned no token");
    this.token = tok;
    return tok;
  }

  async run(sql: string): Promise<QueryResult> {
    assertReadOnly(sql);
    const started = Date.now();
    const r = await fetch(`${this.z.baseUrl}/api/proxy/sql-editor/sqls/run-query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.auth()}`,
        "X-Org-ID": this.z.orgId!,
        "X-Request-ID": randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, limit: this.z.limit, ...(this.z.engineId ? { engineId: this.z.engineId } : {}) }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!r.ok) throw new Error(`Zetaris query failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    return { ...normalize(await r.json()), ms: Date.now() - started };
  }

  async catalog() {
    const out: { table: string; columns: string[] }[] = [];
    const tables = await this.run(`SHOW TABLES IN ${this.z.martPrefix.replace(/\.$/, "")}`);
    for (const row of tables.rows.slice(0, 40)) {
      const name = String(Object.values(row).find((v) => typeof v === "string") ?? "");
      if (!name) continue;
      try {
        const d = await this.run(`DESCRIBE ${this.t(name)}`);
        out.push({ table: name, columns: d.rows.map((x) => String(Object.values(x)[0])) });
      } catch {
        out.push({ table: name, columns: [] });
      }
    }
    return out;
  }
}

/** The run-query response shape is not formally documented; accept the common shapes. */
export function normalize(j: any): Omit<QueryResult, "ms"> {
  const body = j?.headers ? j : (j?.data && !Array.isArray(j.data) ? j.data : j?.result ?? j);
  const cols: string[] = body?.headers?.map((c: any) => (typeof c === "string" ? c : c.name)) ?? body?.columns?.map((c: any) => (typeof c === "string" ? c : c.name ?? c.label)) ?? body?.schema?.map((c: any) => c.name) ?? [];
  let rows: any[] = body?.rows ?? body?.records ?? body?.data ?? [];
  if (rows.length && Array.isArray(rows[0])) rows = rows.map((r: any[]) => Object.fromEntries(r.map((v, i) => [cols[i] ?? `c${i}`, v])));
  const columns = cols.length ? cols : rows.length ? Object.keys(rows[0]) : [];
  const coerce = (v: unknown) => (typeof v === "string" && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v) ? Number(v) : v);
  return { columns, rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), coerce(v)]))) };
}
