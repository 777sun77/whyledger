// Meterless engines, used for real (no stubs):
//  - H-MEM: remembers past investigations + analyst feedback, recalls them
//    with a retrieval trace, keeps an append-only trust ledger.
//  - World Model: event-sourced evidence graph. Every metric, segment,
//    hypothesis and finding is an entity/fact WITH provenance (the SQL receipt).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config.ts";

async function load(rel: string) {
  const p = path.resolve(process.cwd(), "vendor", rel, "src", "index.ts");
  if (!fs.existsSync(p)) throw new Error(`Meterless engine missing at vendor/${rel}. Run: npm run setup`);
  return import(pathToFileURL(p).href);
}

export async function openMemory() {
  fs.mkdirSync(config.stateDir, { recursive: true });
  const { HMEM } = await load("hmem");
  const { WorldModel } = await load("world-model");
  const hmem = new HMEM({ persistDir: path.join(config.stateDir, "hmem") });
  const world = new WorldModel({ namespace: "whyledger", storage: "local", directory: config.stateDir });
  return { hmem, world };
}

export type Memory = Awaited<ReturnType<typeof openMemory>>;
