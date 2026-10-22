import "../src/config.ts";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.ts";
const z = config.zetaris;
const login: any = await (await fetch(`${z.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: z.username, password: z.password }) })).json();
const r = await fetch(`${z.baseUrl}/api/proxy/sql-editor/sqls/run-query`, { method: "POST", headers: { Authorization: `Bearer ${login.idToken}`, "X-Org-ID": z.orgId!, "X-Request-ID": randomUUID(), "Content-Type": "application/json" }, body: JSON.stringify({ sql: process.argv[2] ?? "SHOW LIGHTNING DATABASES", limit: 5 }) });
console.log(r.status, (await r.text()).slice(0, 1500));
