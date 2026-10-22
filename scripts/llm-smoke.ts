import "../src/config.ts";
import { env } from "../src/config.ts";
const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("OPENROUTER_API_KEY")}` },
  body: JSON.stringify({ model: process.argv[2] ?? "nvidia/nemotron-3-super-120b-a12b:free", max_tokens: Number(process.argv[3] ?? 250), messages: [{ role: "user", content: 'Reply with JSON only: {"order":["a","b"],"why":"x"}' }] }) });
const j: any = await r.json();
const m = j?.choices?.[0]?.message ?? {};
console.log(r.status, "finish:", j?.choices?.[0]?.finish_reason, "content:", JSON.stringify(m.content)?.slice(0, 300), "reasoning len:", (m.reasoning ?? "").length, j.error ? JSON.stringify(j.error).slice(0, 300) : "", "usage:", JSON.stringify(j.usage));
