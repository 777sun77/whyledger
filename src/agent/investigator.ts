import { createHash } from "node:crypto";
import type { SqlBackend } from "../data/backend.ts";
import { chat, llmAvailable, llmLabel, parseJson } from "../llm/provider.ts";
import type { Memory } from "../memory/meterless.ts";
import { baselineSql, HYPOTHESES } from "./hypotheses.ts";
import type { Evidence, Finding, Frame, Report } from "./types.ts";

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const pct = (a: number, b: number) => (a === 0 ? 0 : (b - a) / Math.abs(a));
const fmt = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`);
const sgn = (n: number) => (n >= 0 ? "+" : "");

export type StepListener = (step: string, detail: string) => void;

/** Turn a free-form question into a structured frame (LLM if available, regex otherwise). */
export async function frameQuestion(question: string): Promise<Frame> {
  const q = question.toLowerCase();
  const years = [...q.matchAll(/\b(199[8-9]|200[0-3])\b/g)].map((m) => Number(m[1]));
  const quarters = [...q.matchAll(/\bq([1-4])\b/g)].map((m) => Number(m[1]));
  const metric: Frame["metric"] = /web|online/.test(q) ? "web_revenue" : /catalog/.test(q) ? "catalog_revenue" : "store_revenue";
  const fallback: Frame = {
    question,
    metric,
    from: { year: years[0] ?? 2001, qoy: quarters[0] },
    to: { year: years[1] ?? (years[0] ? years[0] + 1 : 2002), qoy: quarters[1] ?? quarters[0] },
  };
  const states = q.match(/\b(in|for) ([a-z]{2})\b/);
  if (states) fallback.scope = { state: states[2].toUpperCase() };
  if (!llmAvailable()) return fallback;
  const reply = await chat([
    { role: "system", content: "You convert analyst questions into JSON frames. Reply with JSON only." },
    {
      role: "user",
      content: `Question: ${question}\nSchema: {"metric":"store_revenue|web_revenue|catalog_revenue","from":{"year":1998-2003,"qoy":1-4 or null},"to":{"year":..,"qoy":..},"scope":{"state":"two-letter or null","category":"Books|Children|Electronics|Home|Jewelry|Men|Music|Shoes|Sports|Women or null"}}\n"from" is the earlier/baseline period.`,
    },
  ], { maxTokens: 300 }).catch(() => null);
  const j = parseJson<Partial<Frame>>(reply);
  if (!j?.from?.year || !j?.to?.year) return fallback;
  const clean = (p: any) => ({ year: Number(p.year), qoy: p.qoy ? Number(p.qoy) : undefined });
  const scope = j.scope ? Object.fromEntries(Object.entries(j.scope).filter(([, v]) => v)) : undefined;
  return { question, metric: (j.metric as Frame["metric"]) ?? metric, from: clean(j.from), to: clean(j.to), scope: scope && Object.keys(scope).length ? scope : undefined };
}

export async function investigate(question: string, backend: SqlBackend, mem: Memory, onStep: StepListener = () => {}): Promise<Report> {
  const steps: Report["steps"] = [];
  const step = (s: string, d: string) => { steps.push({ at: new Date().toISOString(), step: s, detail: d }); onStep(s, d); };
  const evidence: Evidence[] = [];
  const runId = `run-${Date.now()}`;

  const record = async (hypothesis: string, sql: string) => {
    const r = await backend.run(sql);
    const ev: Evidence = { id: `ev-${evidence.length + 1}`, hypothesis, sql, backend: backend.name, ranAt: new Date().toISOString(), ms: r.ms, rows: r.rows };
    evidence.push(ev);
    return ev;
  };

  // 1. Frame
  const frame = await frameQuestion(question);
  const label = (p: Frame["from"]) => `${p.year}${p.qoy ? ` Q${p.qoy}` : ""}`;
  step("frame", `${frame.metric} ${label(frame.from)} -> ${label(frame.to)}${frame.scope ? ` scope ${JSON.stringify(frame.scope)}` : ""}`);

  // 2. Recall (Meterless H-MEM): what did earlier investigations / analysts say?
  const recall = mem.hmem.query(question, { threshold: 0.15, topN: 5 });
  const recalled = recall.memories.map((m: any) => ({ id: m.memory.id, content: m.memory.content, relevance: m.relevance }));
  step("recall", recalled.length ? `${recalled.length} prior memories (H-MEM ${recall.trace?.strategy ?? "hybrid"})` : "no prior memory on this question");

  // 3. Establish the fact to explain
  const base = await record("baseline", baselineSql(frame, backend));
  const bFrom = num(base.rows.find((r) => r.period === "from")?.revenue);
  const bTo = num(base.rows.find((r) => r.period === "to")?.revenue);
  const delta = bTo - bFrom;
  step("baseline", `${fmt(bFrom)} -> ${fmt(bTo)} (${sgn(delta)}${fmt(delta)}, ${sgn(delta)}${(pct(bFrom, bTo) * 100).toFixed(1)}%) [${base.id}]`);

  // 4. Plan: which hypotheses first (LLM may reorder using recalled memory; all are tested)
  let order = HYPOTHESES.map((h) => h.id);
  if (llmAvailable()) {
    const reply = await chat([
      { role: "system", content: "You are a careful business analyst planning an investigation. Reply with JSON only." },
      { role: "user", content: `Explain: ${question}\nObserved: revenue ${fmt(bFrom)} -> ${fmt(bTo)}.\nPrior memory: ${recalled.map((r: { content: string }) => r.content).join(" | ") || "none"}\nHypotheses: ${HYPOTHESES.map((h) => `${h.id}: ${h.question}`).join("; ")}\nReturn {"order":[ids most-promising first],"why":"one sentence"}` },
    ], { maxTokens: 250 }).catch(() => null);
    const j = parseJson<{ order: string[]; why: string }>(reply);
    if (j?.order?.length) {
      order = [...new Set([...j.order.filter((id) => order.includes(id)), ...order])];
      step("plan", `${order.join(" > ")} — ${j.why ?? ""}`);
    } else step("plan", order.join(" > "));
  } else step("plan", `${order.join(" > ")} (default order, offline)`);

  // 5. Test every hypothesis with a query; score it from the numbers
  const findings: Finding[] = [];
  for (const id of order) {
    const h = HYPOTHESES.find((x) => x.id === id)!;
    let ev: Evidence;
    try {
      ev = await record(h.id, h.sql(frame, backend));
    } catch (e) {
      step("test", `${h.id}: query failed (${(e as Error).message.slice(0, 120)})`);
      continue;
    }
    const f = score(h.id, h.title, ev, delta, bFrom);
    findings.push(f);
    step("test", `${h.id}: ${f.verdict} — ${f.summary} [${ev.id}]`);
  }
  findings.sort((a, b) => rank(b) - rank(a));

  // 6. Write the evidence graph (Meterless World Model) with SQL provenance
  await writeWorld(mem, frame, findings, evidence, runId, backend.name);
  step("world-model", `${findings.length} findings + ${evidence.length} receipts written with provenance`);

  // 7. Answer: model narrates ONLY the computed findings and must cite evidence ids
  const { text, mode } = await narrate(frame, { bFrom, bTo, delta }, findings, recalled);
  step("answer", mode);

  // 8. Remember the conclusion for next time (H-MEM), so follow-ups compound
  const top = findings.filter((f) => f.verdict !== "rejected").slice(0, 2);
  mem.hmem.add({
    content: `Investigation "${question}": ${frame.metric} ${label(frame.from)}->${label(frame.to)} changed ${sgn(delta)}${fmt(delta)}. Main drivers: ${top.map((f) => `${f.title} (${f.summary})`).join("; ") || "none supported"}.`,
    type: "factual",
    source: `whyledger:${runId}`,
  });
  step("remember", "conclusion stored in H-MEM");

  return {
    frame,
    baseline: { from: bFrom, to: bTo, delta, pct: pct(bFrom, bTo), evidence: base.id },
    findings, answer: text, answerMode: mode, recalled, evidence, backend: backend.name, steps,
  };
}

function rank(f: Finding) {
  return (f.verdict === "supported" ? 2 : f.verdict === "partial" ? 1 : 0) + Math.min(Math.abs(f.explains), 1.5);
}

/** Pure scoring from query rows. Exported for tests. */
export function score(id: string, title: string, ev: Evidence, delta: number, baseFrom: number): Finding {
  const base = { hypothesis: id, title, evidence: [ev.id] };
  if (id === "price_volume") {
    const a = ev.rows.find((r) => r.period === "from") ?? {};
    const b = ev.rows.find((r) => r.period === "to") ?? {};
    const uA = num(a.units), uB = num(b.units), rA = num(a.revenue), rB = num(b.revenue);
    const pA = uA ? rA / uA : 0, pB = uB ? rB / uB : 0;
    const volEffect = (uB - uA) * pA; // revenue change from units at old price
    const priceEffect = (pB - pA) * uB; // revenue change from price at new units
    const vol = delta ? volEffect / delta : 0;
    const price = delta ? priceEffect / delta : 0;
    const main = Math.abs(vol) >= Math.abs(price) ? "volume" : "price";
    return {
      ...base,
      explains: Math.max(vol, price),
      verdict: Math.max(vol, price) > 0.6 ? "supported" : "partial",
      summary: `units ${sgn(uB - uA)}${(pct(uA, uB) * 100).toFixed(1)}%, revenue/unit ${sgn(pB - pA)}${(pct(pA, pB) * 100).toFixed(1)}% — mostly a ${main} effect (volume ${(vol * 100).toFixed(0)}%, price ${(price * 100).toFixed(0)}% of the change)`,
      drivers: [
        { segment: "volume (units)", from: uA, to: uB, delta: volEffect, shareOfDelta: vol },
        { segment: "price (revenue/unit)", from: pA, to: pB, delta: priceEffect, shareOfDelta: price },
      ],
    };
  }
  const segs = ev.rows.map((r) => {
    const from = num(r.v_from), to = num(r.v_to);
    return { segment: String(r.segment), from, to, delta: to - from, shareOfDelta: delta ? (to - from) / delta : 0 };
  });
  if (id === "channel_shift") {
    const others = segs.filter((s) => s.shareOfDelta !== 1 && Math.abs(s.delta - delta) > 1e-6);
    const opposite = others.filter((s) => Math.sign(s.delta) === -Math.sign(delta));
    const offset = opposite.reduce((a, s) => a + Math.abs(s.delta), 0) / (Math.abs(delta) || 1);
    return {
      ...base,
      explains: Math.min(offset, 1),
      verdict: offset >= 0.5 ? "supported" : offset >= 0.2 ? "partial" : "rejected",
      summary: opposite.length ? `${opposite.map((s) => `${s.segment} ${sgn(s.delta)}${fmt(s.delta)}`).join(", ")} moved the opposite way (offsets ${(offset * 100).toFixed(0)}% of the change)` : `other channels moved the same direction (${others.map((s) => `${s.segment} ${sgn(s.delta)}${fmt(s.delta)}`).join(", ")}) — not a channel shift`,
      drivers: segs,
    };
  }
  if (id === "returns") {
    const r = segs[0] ?? { from: 0, to: 0, delta: 0, segment: "returns", shareOfDelta: 0 };
    const share = delta ? -r.delta / delta : 0; // more returns explains a fall
    return {
      ...base,
      explains: share,
      verdict: share >= 0.3 ? "supported" : share >= 0.1 ? "partial" : "rejected",
      summary: `returns ${fmt(r.from)} -> ${fmt(r.to)} (${sgn(r.delta)}${fmt(r.delta)}), ${(share * 100).toFixed(0)}% of the revenue change`,
      drivers: [r],
    };
  }
  // Segment decompositions: is the change concentrated or proportional?
  segs.sort((a, b) => b.shareOfDelta - a.shareOfDelta);
  const totalFrom = segs.reduce((a, s) => a + s.from, 0) || baseFrom || 1;
  const dissimilarity = segs.reduce((a, s) => a + Math.abs(s.shareOfDelta - s.from / totalFrom), 0) / 2;
  const top = segs.slice(0, 2);
  const topShare = top.reduce((a, s) => a + s.shareOfDelta, 0);
  const topBaseShare = top.reduce((a, s) => a + s.from / totalFrom, 0);
  const lead = top[0]; const leadOver = lead ? lead.shareOfDelta / Math.max(lead.from / totalFrom, 1e-9) : 0;
  const verdict = dissimilarity >= 0.35 && leadOver >= 1.5 ? "supported" : dissimilarity >= 0.15 ? "partial" : "rejected";
  return {
    ...base,
    explains: topShare,
    verdict,
    summary:
      verdict === "rejected"
        ? `change is spread proportionally across ${segs.length} segments (concentration ${(dissimilarity * 100).toFixed(0)}%) — not the cause`
        : `${top.map((s) => `${s.segment} ${sgn(s.delta)}${fmt(s.delta)}`).join(", ")} = ${(topShare * 100).toFixed(0)}% of the change vs ${(topBaseShare * 100).toFixed(0)}% of baseline revenue (concentration ${(dissimilarity * 100).toFixed(0)}%)`,
    drivers: segs.slice(0, 8),
  };
}

async function writeWorld(mem: Memory, frame: Frame, findings: Finding[], evidence: Evidence[], runId: string, backendName: string) {
  const at = new Date().toISOString();
  const src = (ev?: Evidence) => ({
    kind: "agent", by: "whyledger", at, runId,
    url: ev ? `sql:${backendName}` : undefined,
    checksum: ev ? createHash("sha256").update(ev.sql + JSON.stringify(ev.rows)).digest("hex").slice(0, 16) : undefined,
  });
  const q = await mem.world.upsertEntity({ type: "question", externalKey: { system: "whyledger", id: runId }, attrs: { text: frame.question, metric: frame.metric }, source: src() });
  for (const f of findings) {
    const ev = evidence.find((e) => e.id === f.evidence[0]);
    const h = await mem.world.upsertEntity({ type: "hypothesis", externalKey: { system: "whyledger", id: `${runId}:${f.hypothesis}` }, attrs: { name: f.title }, source: src(ev) });
    await mem.world.relate({ from: q.id, type: "tested", to: h.id, source: src(ev) });
    await mem.world.assertFact({ about: h.id, predicate: "verdict", value: { verdict: f.verdict, explains: f.explains, summary: f.summary, evidence: f.evidence, sql: ev?.sql }, confidence: f.verdict === "supported" ? 0.9 : f.verdict === "partial" ? 0.6 : 0.3, source: src(ev) });
    for (const d of f.drivers.slice(0, 3)) {
      const seg = await mem.world.upsertEntity({ type: "segment", name: `${f.hypothesis}:${d.segment}`, attrs: { dimension: f.hypothesis, value: d.segment }, source: src(ev) });
      await mem.world.relate({ from: h.id, type: "driven_by", to: seg.id, attrs: { delta: d.delta, share: d.shareOfDelta }, source: src(ev) });
    }
  }
}

async function narrate(frame: Frame, b: { bFrom: number; bTo: number; delta: number }, findings: Finding[], recalled: Report["recalled"]) {
  const facts = findings.map((f) => ({ id: f.hypothesis, verdict: f.verdict, summary: f.summary, evidence: f.evidence }));
  const template = () => {
    const sup = findings.filter((f) => f.verdict !== "rejected");
    const rej = findings.filter((f) => f.verdict === "rejected");
    const lines = [
      `${frame.metric.replace("_", " ")} went ${fmt(b.bFrom)} -> ${fmt(b.bTo)} (${sgn(b.delta)}${fmt(b.delta)}).`,
      sup.length ? "What explains it:" : "No single hypothesis explains it; the change is broad-based.",
      ...sup.slice(0, 4).map((f, i) => `${i + 1}. ${f.title}: ${f.summary} [${f.evidence.join(", ")}]`),
      rej.length ? `Ruled out: ${rej.map((f) => `${f.title} [${f.evidence.join(", ")}]`).join("; ")}.` : "",
    ];
    return lines.filter(Boolean).join("\n");
  };
  if (!llmAvailable()) return { text: template(), mode: llmLabel() };
  const reply = await chat([
    { role: "system", content: "You explain business metric changes to a store operations manager. Use ONLY the findings given. Every claim must cite its evidence id in [brackets]. Say what was ruled out. Be concise: <=150 words, plain language, end with one recommended next check." },
    { role: "user", content: `Question: ${frame.question}\nChange: ${fmt(b.bFrom)} -> ${fmt(b.bTo)} (${sgn(b.delta)}${fmt(b.delta)}) [ev-1]\nFindings: ${JSON.stringify(facts)}\nPrior memory: ${JSON.stringify(recalled.map((r) => r.content))}` },
  ], { maxTokens: 600 }).catch(() => null);
  if (!reply || !/\[ev-\d+/.test(reply)) return { text: template(), mode: `${llmLabel()} failed citation check -> template` };
  return { text: reply, mode: llmLabel() };
}
