// Loads .env.local (gitignored) without printing any value.
import fs from "node:fs";
import path from "node:path";

const envFile = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}

export const env = (k: string, d?: string) => {
  const v = process.env[k];
  return v === undefined || v === "" ? d : v;
};

export const config = {
  backend: env("WHYLEDGER_BACKEND", env("ZETARIS_BASE_URL") ? "zetaris" : "local") as "zetaris" | "local",
  zetaris: {
    baseUrl: env("ZETARIS_BASE_URL", "http://localhost:3000")!.replace(/\/$/, ""),
    orgId: env("ZETARIS_ORG_ID"),
    apiKey: env("ZETARIS_API_KEY"),
    username: env("ZETARIS_USERNAME"),
    password: env("ZETARIS_PASSWORD"),
    engineId: env("ZETARIS_ENGINE_ID"),
    limit: Number(env("ZETARIS_QUERY_LIMIT", "1000")),
    // Lightning namespace prefix for the TPC-DS sample, e.g. "TPCDS_DB." (blank locally)
    tpcdsPrefix: env("WHYLEDGER_TPCDS_PREFIX", "")!,
  },
  llm: {
    // nvidia | openrouter | meterless | none
    provider: (env("WHYLEDGER_LLM") ??
      (env("NVIDIA_API_KEY") ? "nvidia" : env("OPENROUTER_API_KEY") ? "openrouter" : env("METERLESS_BASE_URL") ? "meterless" : "none")) as
      "nvidia" | "openrouter" | "meterless" | "none",
  },
  stateDir: path.resolve(process.cwd(), env("WHYLEDGER_STATE", ".whyledger")!),
};
