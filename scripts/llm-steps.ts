// Exercises the three Nemotron steps (frame, plan via investigate is slow) without Zetaris: frame + narrate on a canned finding set.
import "../src/config.ts";
import { frameQuestion } from "../src/agent/investigator.ts";
import { chat, llmLabel, parseJson } from "../src/llm/provider.ts";
console.log("llm:", llmLabel());
const t0 = Date.now();
console.log("frame:", JSON.stringify(await frameQuestion("Why did web sales in Texas fall between Q3 2001 and Q3 2002?")), `${Date.now() - t0}ms`);
const t1 = Date.now();
const plan = parseJson(await chat([{ role: "user", content: 'Hypotheses: geography, category, promotion, returns. Question: why did store revenue fall? Return JSON {"order":[...],"why":"..."}' }], { maxTokens: 250 }));
console.log("plan:", JSON.stringify(plan), `${Date.now() - t1}ms`);
