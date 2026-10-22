// One OpenAI-compatible client for three providers:
//  - nvidia:     NVIDIA NIM free endpoint (build.nvidia.com), Nemotron models
//  - openrouter: OpenRouter ":free" Nemotron models
//  - meterless:  Meterless Runtime / Nightshift hotspot (local, unmetered)
// With no key the agent still runs: planning and narration fall back to
// deterministic templates, and every output is labeled with its mode.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { config, env } from "../config.ts";

// Disk cache: identical prompts (same model) are answered instantly. Keeps
// demos fast and stays well inside free-tier rate limits.
const cacheFile = path.join(config.stateDir, "llm-cache.json");
let cache: Record<string, string> | undefined;
const loadCache = () => (cache ??= fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {});
export const llmStats = { calls: 0, cacheHits: 0, ms: 0 };

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

const PROVIDERS = {
  nvidia: { base: "https://integrate.api.nvidia.com/v1", key: "NVIDIA_API_KEY", model: "nvidia/nemotron-3.5-lightning-30b-a3b" },
  openrouter: { base: "https://openrouter.ai/api/v1", key: "OPENROUTER_API_KEY", model: "nvidia/nemotron-3.5-lightning:free" },
  meterless: { base: env("METERLESS_BASE_URL", "http://127.0.0.1:8088/v1")!, key: "METERLESS_API_KEY", model: "nemotron" },
} as const;

export function llmLabel(): string {
  if (config.llm.provider === "none") return "offline (deterministic templates, no LLM)";
  const p = PROVIDERS[config.llm.provider];
  return `${config.llm.provider}:${env("WHYLEDGER_MODEL", p.model)}`;
}

export function llmAvailable(): boolean {
  if (config.llm.provider === "none") return false;
  if (config.llm.provider === "meterless") return true;
  return !!env(PROVIDERS[config.llm.provider].key);
}

export async function chat(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<string | null> {
  if (!llmAvailable()) return null;
  const p = PROVIDERS[config.llm.provider as keyof typeof PROVIDERS];
  const key = env(p.key, config.llm.provider === "meterless" ? "rt-local" : undefined);
  const model = env("WHYLEDGER_MODEL", p.model)!;
  const ck = createHash("sha256").update(JSON.stringify([model, messages, opts.maxTokens ?? 900])).digest("hex");
  if (env("WHYLEDGER_LLM_CACHE", "1") === "1" && loadCache()[ck] !== undefined) { llmStats.cacheHits++; return cache![ck]; }
  const started = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${p.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages,
        // Nemotron reasons before answering; leave room for it
        max_tokens: (opts.maxTokens ?? 900) + 2500,
        ...(config.llm.provider === "openrouter" ? { reasoning: { effort: "low" } } : {}),
        temperature: opts.temperature ?? 0.2,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 4000 * (attempt + 1))); continue; }
    if (r.status >= 500 && attempt < 2) { await new Promise((s) => setTimeout(s, 3000)); continue; }
    if (!r.ok) throw new Error(`LLM ${config.llm.provider} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    const msg = j?.choices?.[0]?.message;
    const text = (msg?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    llmStats.calls++; llmStats.ms += Date.now() - started;
    if (text) { loadCache()[ck] = text; fs.mkdirSync(config.stateDir, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache)); }
    return text;
  }
  throw new Error("LLM rate-limited after 3 attempts");
}

/** Pull the first JSON object out of a model reply. */
export function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}
