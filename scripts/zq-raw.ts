import "../src/config.ts";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.ts";
const z = config.zetaris;
const login: any = await (await fetch(`${z.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: z.username, password: z.password }) })).json();
const t0 = Date.now();
const r = await fetch(`${z.baseUrl}/api/proxy/sql-editor/sqls/run-query`, { method: "POST", headers: { Authorization: `Bearer ${login.idToken}`, "X-Org-ID": z.orgId!, "X-Request-ID": randomUUID(), "Content-Type": "application/json" }, body: JSON.stringify({ sql: process.argv[2] === "--file" ? (await import("node:fs")).readFileSync(process.argv[3], "utf8") : process.argv[2] ?? "SHOW LIGHTNING DATABASES", limit: Number(process.env.LIMIT ?? 5) }) });
console.log(r.status, `${Date.now() - t0}ms`, (await r.text()).slice(0, 1500));
