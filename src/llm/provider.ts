// One OpenAI-compatible client for three providers:
//  - nvidia:     NVIDIA NIM free endpoint (build.nvidia.com), Nemotron models
//  - openrouter: OpenRouter ":free" Nemotron models
//  - meterless:  Meterless Runtime / Nightshift hotspot (local, unmetered)
// With no key the agent still runs: planning and narration fall back to
// deterministic templates, and every output is labeled with its mode.
import { config, env } from "../config.ts";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

const PROVIDERS = {
  nvidia: { base: "https://integrate.api.nvidia.com/v1", key: "NVIDIA_API_KEY", model: "nvidia/nemotron-3.5-lightning-30b-a3b" },
  openrouter: { base: "https://openrouter.ai/api/v1", key: "OPENROUTER_API_KEY", model: "nvidia/nemotron-3-super-120b-a12b:free" },
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
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${p.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: env("WHYLEDGER_MODEL", p.model),
        messages,
        max_tokens: opts.maxTokens ?? 900,
        temperature: opts.temperature ?? 0.2,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 4000 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(`LLM ${config.llm.provider} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    const msg = j?.choices?.[0]?.message;
    return (msg?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
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
