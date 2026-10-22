import "./config.ts";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { getBackend } from "./data/index.ts";
import { investigate } from "./agent/investigator.ts";
import { openMemory } from "./memory/meterless.ts";
import { llmLabel } from "./llm/provider.ts";

const port = Number(process.env.PORT ?? 8787);
const backend = await getBackend();
const mem = await openMemory();
const page = () => fs.readFileSync(path.resolve("web/index.html"), "utf8");

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page()); }
    if (url.pathname === "/api/status") return json(res, { backend: backend.name, zetaris: backend.isZetaris, llm: llmLabel() });
    if (url.pathname === "/api/investigate") {
      // Server-sent events: the UI shows each step as the agent works
      const q = url.searchParams.get("q") ?? "";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const report = await investigate(q, backend, mem, (step, detail) => send("step", { step, detail }));
      send("report", report);
      return res.end();
    }
    if (url.pathname === "/api/feedback" && req.method === "POST") {
      const body = JSON.parse(await new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); }));
      mem.hmem.feedback(body.memoryId, body.kind === "unhelpful" ? "unhelpful" : "helpful");
      return json(res, { ok: true });
    }
    if (url.pathname === "/api/world") return json(res, { audit: mem.world.audit().slice(-50) });
    res.writeHead(404); res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
}).listen(port, () => console.log(`WhyLedger on http://localhost:${port} | backend: ${backend.name} | llm: ${llmLabel()}`));

function json(res: http.ServerResponse, body: unknown) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
