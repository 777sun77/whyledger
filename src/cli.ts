// npx tsx src/cli.ts "Why did store revenue change from 2001 Q4 to 2002 Q4?"
// npx tsx src/cli.ts --feedback <memoryId> helpful|unhelpful
import "./config.ts";
import { getBackend } from "./data/index.ts";
import { investigate } from "./agent/investigator.ts";
import { openMemory } from "./memory/meterless.ts";
import { llmLabel } from "./llm/provider.ts";

const args = process.argv.slice(2);
const mem = await openMemory();
if (args[0] === "--feedback") {
  mem.hmem.feedback(args[1], args[2] === "unhelpful" ? "unhelpful" : "helpful");
  console.log(`feedback recorded on ${args[1]}`);
  process.exit(0);
}
const question = args.join(" ") || "Why did store revenue change from 2001 Q4 to 2002 Q4?";
const backend = await getBackend();
console.log(`backend: ${backend.name} | llm: ${llmLabel()}\n`);
const report = await investigate(question, backend, mem, (s, d) => console.log(`  · ${s.padEnd(11)} ${d}`));
console.log(`\n${report.answer}\n\nreceipts:`);
for (const e of report.evidence) console.log(`  ${e.id} [${e.hypothesis}] ${e.ms}ms on ${e.backend} — ${e.sql.replace(/\s+/g, " ").slice(0, 110)}…`);
if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
