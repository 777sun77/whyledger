import "/workspace/genai-hackathon/whyledger/src/config.ts";
import { ZetarisBackend } from "/workspace/genai-hackathon/whyledger/src/data/zetaris.ts";
const b = new ZetarisBackend();
for (const q of ["SELECT 1 AS one", "SHOW LIGHTNING DATABASES"]) {
  try { const r = await b.run(q); console.log(q, "=>", r.columns, JSON.stringify(r.rows.slice(0, 8)), r.ms + "ms"); } catch (e) { console.log(q, "ERR", (e as Error).message); }
}
