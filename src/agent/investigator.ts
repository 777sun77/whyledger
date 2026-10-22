import { createHash } from "node:crypto";
import type { SqlBackend } from "../data/backend.ts";
import { chat, llmAvailable, llmLabel, parseJson } from "../llm/provider.ts";
import type { Memory } from "../memory/meterless.ts";
import { baselineSql, DATASETS, drillSql, hypotheses } from "./datasets.ts";
import { frameQuestion } from "./framing.ts";
import type { Evidence, Finding, Frame, Report } from "./types.ts";

export { frameQuestion };

const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v));
const pct = (a: number, b: number) => (a === 0 ? 0 : (b - a) / Math.abs(a));
export const fmtU = (n: number, unit: "$" | "#" = "$") => {
  const a = Math.abs(n), m = n < 0 ? "-" : "", cur = unit === "$" ? "$" : "";
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : `${a.toFixed(0)}`;
  return `${m}${cur}${s}`;
};
const sgn = (n: number) => (n >= 0 ? "+" : "");

export type StepListener = (step: string, detail: string, data?: unknown) => void;

export async function investigate(question: string, backend: SqlBackend, mem: Memory, onStep: StepListener = () => {}): Promise<Report> {
  const t0 = Date.now();
  const steps: Report["steps"] = [];
  const timings: Record<string, number> = {};
  const step = (s: string, d: string, data?: unknown) => { steps.push({ at: new Date().toISOString(), ms: Date.now() - t0, step: s, detail: d }); onStep(s, d, data); };
  const timed = async <T>(k: string, p: Promise<T>) => { const s = Date.now(); try { return await p; } finally { timings[k] = Date.now() - s; } };
  const evidence: Evidence[] = [];
  const runId = `run-${Date.now()}`;

  // 1. Frame (rules first, Nemotron if needed)
  const frame = await timed("frame", frameQuestion(question));
  const ds = DATASETS[frame.dataset];
  const metric = ds.metrics[frame.metric] ?? ds.metrics[ds.defaultMetric];
  frame.metric = Object.keys(ds.metrics).find((k) => ds.metrics[k] === metric)!;
  const unit = metric.unit;
  const fmt = (n: number) => fmtU(n, unit);
  const label = ds.periodLabel;
  const scopeTxt = Object.entries(frame.scope).map(([k, v]) => `${k}=${v}`).join(", ");
  step("frame", `${ds.name}: ${frame.channel ? frame.channel + " " : ""}${metric.label}, ${label(frame.from)} -> ${label(frame.to)}${scopeTxt ? ` | filter ${scopeTxt}` : ""} (${frame.framedBy})`, frame);

  const record = async (hypothesis: string, title: string, sql: string) => {
    const s = Date.now();
    const r = await backend.run(sql);
    const ev: Evidence = { id: "", hypothesis, title, sql, backend: backend.name, lineage: ds.lineage, ranAt: new Date().toISOString(), ms: Date.now() - s, rows: r.rows };
    ev.id = `ev-${evidence.push(ev)}`;
    return ev;
  };

  // 2. Recall (Meterless H-MEM)
  const recall = mem.hmem.query(question, { threshold: 0.15, topN: 5 });
  const recalled = recall.memories.map((m: any) => ({ id: m.memory.id, content: m.memory.content, relevance: m.relevance }));
  step("recall", recalled.length ? `${recalled.length} related memories (H-MEM ${recall.trace?.strategy ?? "hybrid"})` : "no prior memory on this question", recalled);

  // 3. The fact to explain
  const base = await timed("baseline", record("baseline", "The change to explain", baselineSql(frame, ds, backend)));
  const bFrom = num(base.rows[0]?.v_from), bTo = num(base.rows[0]?.v_to), delta = bTo - bFrom;
  step("baseline", `${metric.label} ${fmt(bFrom)} -> ${fmt(bTo)} (${sgn(delta)}${fmt(delta)}, ${sgn(delta)}${(pct(bFrom, bTo) * 100).toFixed(1)}%) [${base.id}]`, base);
  if (bFrom === 0 && bTo === 0) throw new Error(`No data for ${label(frame.from)} / ${label(frame.to)}${scopeTxt ? ` with ${scopeTxt}` : ""}. Try: ${ds.examples[0]}`);

  // 4. Nemotron's hunch (runs in parallel with the evidence; compared afterwards)
  const hyps = hypotheses(frame, ds, backend);
  const hunchP = llmAvailable()
    ? chat([
        { role: "system", content: "You are a careful business analyst. Reply with JSON only." },
        { role: "user", content: `Explain: ${question}\nObserved: ${metric.label} ${fmt(bFrom)} -> ${fmt(bTo)}.\nPrior memory: ${recalled.map((r: { content: string }) => r.content).join(" | ") || "none"}\nHypotheses: ${hyps.map((h) => `${h.id}: ${h.question}`).join("; ")}\nReturn {"order":[ids, most likely first],"why":"one sentence"}` },
      ], { maxTokens: 250 }).then((r) => parseJson<{ order: string[]; why: string }>(r)).catch((e) => { console.warn(`[llm] ${(e as Error).message.slice(0, 200)}`); return null; })
    : Promise.resolve(null);
  step("plan", `testing ${hyps.length} hypotheses in parallel on ${backend.name}${llmAvailable() ? " while Nemotron forms a hunch" : ""}`, hyps.map((h) => ({ id: h.id, title: h.title, question: h.question })));

  // 5. Test every hypothesis in parallel; numbers come only from SQL
  const tTests = Date.now();
  const findings = (await Promise.all(hyps.map(async (h) => {
    try {
      const ev = await record(h.id, h.title, h.sql);
      const f = score(h.id, h.title, ev, delta, bFrom, unit);
      step("test", `${h.id}: ${f.verdict} — ${f.summary} [${ev.id}, ${ev.ms} ms]`, { finding: f, evidence: ev });
      return f;
    } catch (e) {
      step("test", `${h.id}: query failed (${(e as Error).message.slice(0, 120)})`);
      return null;
    }
  }))).filter((f): f is Finding => !!f);
  timings.tests = Date.now() - tTests;
  findings.sort((a, b) => rank(b) - rank(a));

  // 6. Connect findings: drill into the strongest segment by the next dimension
  const segF = findings.filter((f) => f.verdict === "supported" && ds.dims.some((d) => d.id === f.hypothesis));
  if (segF.length >= 1) {
    const A = segF[0];
    const by = (segF[1]?.hypothesis ?? ds.dims.find((d) => d.id !== A.hypothesis && !(d.id in frame.scope))?.id)!;
    const lead = A.drivers[0];
    if (lead && by) {
      try {
        const ev = await timed("drill", record(`drill:${A.hypothesis}>${by}`, `Inside ${lead.segment}`, drillSql(frame, ds, backend, { dim: A.hypothesis, value: lead.segment }, by)));
        const leadDelta = lead.delta;
        const g = score(by, `Inside ${lead.segment}, by ${by}`, ev, leadDelta, lead.from, unit);
        const conn: Finding = { ...g, hypothesis: `drill:${A.hypothesis}>${by}`, title: `Connecting: ${lead.segment} × ${by}`, verdict: "connection", explains: g.explains,
          summary: `${lead.segment} (${sgn(leadDelta)}${fmt(leadDelta)}) broken down by ${by}: ${g.verdict === "rejected" ? "spread evenly — the two drivers are independent" : g.summary}` };
        findings.splice(findings.indexOf(A) + 1, 0, conn);
        step("connect", `${conn.summary} [${ev.id}]`, { finding: conn, evidence: ev });
      } catch (e) {
        step("connect", `drill-down failed (${(e as Error).message.slice(0, 100)})`);
      }
    }
  }

  // 7. Compare Nemotron's hunch with the evidence
  const hunchBudget = Number(process.env.WHYLEDGER_HUNCH_WAIT_MS ?? 30000);
  const hunchRaw = await timed("hunch_wait", Promise.race([hunchP, new Promise<null>((r) => setTimeout(() => r(null), hunchBudget).unref())]));
  if (!hunchRaw && llmAvailable()) step("hunch", `Nemotron's hunch did not arrive within ${hunchBudget / 1000}s; continuing on evidence alone`);
  let hunch: Report["hunch"];
  if (hunchRaw?.order?.length) {
    const best = findings.find((f) => f.verdict === "supported");
    const matched = !!best && hunchRaw.order[0] === best.hypothesis;
    hunch = { order: hunchRaw.order, why: hunchRaw.why ?? "", matched };
    step("hunch", `Nemotron guessed "${hunchRaw.order[0]}" first — evidence ${matched ? "agrees" : `points to "${best?.hypothesis ?? "none"}"`}`, hunch);
  }

  // 8. Evidence graph (Meterless World Model) with SQL provenance
  await writeWorld(mem, frame, findings, evidence, runId, backend.name);
  step("world-model", `${findings.length} findings + ${evidence.length} receipts written with provenance`);

  // 9. Answer (Nemotron narrates only computed findings, must cite receipts)
  const { text, mode } = await timed("narrate", narrate(frame, metric.label, unit, { bFrom, bTo, delta }, findings, recalled));
  step("answer", mode);

  // 10. Remember
  const top = findings.filter((f) => f.verdict === "supported" || f.verdict === "connection").slice(0, 3);
  const remembered = mem.hmem.add({
    content: `Investigation "${question}": ${metric.label} ${label(frame.from)}->${label(frame.to)}${scopeTxt ? ` (${scopeTxt})` : ""} changed ${sgn(delta)}${fmt(delta)}. Drivers: ${top.map((f) => `${f.title}: ${f.summary}`).join("; ") || "none supported"}.`,
    type: "factual",
    source: `whyledger:${runId}`,
  });
  step("remember", `conclusion stored in H-MEM as ${remembered.id}`);
  timings.total = Date.now() - t0;

  return {
    frame, metricLabel: metric.label, unit,
    baseline: { from: bFrom, to: bTo, delta, pct: pct(bFrom, bTo), evidence: base.id },
    findings, answer: text, answerMode: mode, hunch, recalled, evidence, backend: backend.name, steps, timings, memoryId: remembered.id,
  };
}

function rank(f: Finding) {
  return (f.verdict === "supported" ? 2 : f.verdict === "partial" ? 1 : 0) + f.explains;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Pure scoring from query rows. Exported for tests.
 * Every "explains" value is bounded to 0..1 and means: the share of the
 * movement in the direction of the net change that this hypothesis accounts
 * for. Raw $ contributions (which can exceed the net change when other
 * segments offset) are reported separately as dollars, never as a % > 100.
 */
export function score(id: string, title: string, ev: Evidence, delta: number, baseFrom: number, unit: "$" | "#" = "$"): Finding {
  const fmt = (n: number) => fmtU(n, unit);
  const base = { hypothesis: id, title, evidence: [ev.id] };
  const dir = Math.sign(delta) || -1;
  const tiny = baseFrom !== 0 && Math.abs(delta / baseFrom) < 0.002;
  // Below ~1% the net change is small next to normal segment churn: never call it "supported".
  const small = baseFrom !== 0 && Math.abs(delta / baseFrom) < 0.01;
  const cap = (v: Finding["verdict"]): Finding["verdict"] => (small && v === "supported" ? "partial" : v);
  if (id === "price_volume") {
    const r0 = ev.rows[0] ?? {};
    const uA = num(r0.u_from), uB = num(r0.u_to), rA = num(r0.v_from), rB = num(r0.v_to);
    const pA = uA ? rA / uA : 0, pB = uB ? rB / uB : 0;
    const volEffect = (uB - uA) * pA; // revenue change from units at old price
    const priceEffect = (pB - pA) * uB; // revenue change from price at new units (vol + price = delta exactly)
    const gross = Math.abs(volEffect) + Math.abs(priceEffect) || 1;
    const volShare = Math.abs(volEffect) / gross, priceShare = Math.abs(priceEffect) / gross;
    const main = volShare >= priceShare ? "volume" : "price";
    const mainEffect = main === "volume" ? volEffect : priceEffect;
    const sameDir = Math.sign(mainEffect) === dir;
    return {
      ...base,
      explains: sameDir ? Math.max(volShare, priceShare) : 0,
      verdict: cap(tiny ? "rejected" : sameDir && Math.max(volShare, priceShare) >= 0.7 ? "supported" : "partial"),
      summary: `volume ${sgn(uB - uA)}${(pct(uA, uB) * 100).toFixed(1)}%, value per unit ${sgn(pB - pA)}${(pct(pA, pB) * 100).toFixed(1)}% — volume effect ${sgn(volEffect)}${fmt(volEffect)}, price effect ${sgn(priceEffect)}${fmt(priceEffect)}: mostly a ${main} story`,
      drivers: [
        { segment: "volume (units)", from: uA, to: uB, delta: volEffect, shareOfDelta: volShare * Math.sign(volEffect) * dir },
        { segment: "price (revenue/unit)", from: pA, to: pB, delta: priceEffect, shareOfDelta: priceShare * Math.sign(priceEffect) * dir },
      ],
    };
  }
  const segs = ev.rows.map((r) => {
    const from = num(r.v_from), to = num(r.v_to);
    return { segment: String(r.segment), from, to, delta: to - from, shareOfDelta: 0 };
  });
  if (id === "channel_shift") {
    const self = segs.find((s) => Math.abs(s.delta - delta) < Math.max(1, Math.abs(delta) * 1e-6));
    const others = segs.filter((s) => s !== self);
    const opposite = others.filter((s) => Math.sign(s.delta) === -dir);
    const offsetAmt = opposite.reduce((a, s) => a + Math.abs(s.delta), 0);
    const offset = clamp01(offsetAmt / (Math.abs(delta) || 1));
    for (const s of segs) s.shareOfDelta = s === self ? 1 : clamp01(Math.abs(s.delta) / (Math.abs(delta) || 1)) * (Math.sign(s.delta) === dir ? 1 : -1);
    return {
      ...base,
      explains: offset,
      verdict: cap(tiny ? "rejected" : offsetAmt > 3 * Math.abs(delta) ? "partial" : offset >= 0.5 ? "supported" : offset >= 0.2 ? "partial" : "rejected"),
      summary: opposite.length
        ? `${opposite.map((s) => `${s.segment} ${sgn(s.delta)}${fmt(s.delta)}`).join(", ")} moved the opposite way while this channel went ${sgn(delta)}${fmt(delta)}${offset >= 1 ? " — fully offset" : ` — offsets ${(offset * 100).toFixed(0)}%`} (co-movement, not proof of switching)`
        : `other channels moved the same direction (${others.map((s) => `${s.segment} ${sgn(s.delta)}${fmt(s.delta)}`).join(", ")}) — not a channel shift`,
      drivers: segs,
    };
  }
  if (id === "fees") {
    const r = segs[0] ?? { from: 0, to: 0, delta: 0, segment: "fees", shareOfDelta: 0 };
    const helps = Math.sign(r.delta) === dir;
    const share = helps ? clamp01(Math.abs(r.delta) / (Math.abs(delta) || 1)) : 0;
    r.shareOfDelta = share;
    return {
      ...base, explains: share,
      verdict: cap(tiny ? "rejected" : share >= 0.3 ? "supported" : share >= 0.1 ? "partial" : "rejected"),
      summary: `${r.segment} ${fmt(r.from)} -> ${fmt(r.to)} (${sgn(r.delta)}${fmt(r.delta)})${helps ? `, ${(share * 100).toFixed(0)}% of the change` : ", moved the other way"}`,
      drivers: [r],
    };
  }
  if (id === "returns") {
    const r = segs[0] ?? { from: 0, to: 0, delta: 0, segment: "returns", shareOfDelta: 0 };
    // More returns can explain a fall; fewer returns can explain a rise.
    const helps = Math.sign(-r.delta) === dir;
    const share = helps ? clamp01(Math.abs(r.delta) / (Math.abs(delta) || 1)) : 0;
    r.shareOfDelta = share;
    return {
      ...base,
      explains: share,
      verdict: cap(tiny ? "rejected" : share >= 0.3 ? "supported" : share >= 0.1 ? "partial" : "rejected"),
      summary: `returns ${fmt(r.from)} -> ${fmt(r.to)} (${sgn(r.delta)}${fmt(r.delta)})${helps ? `, up to ${(share * 100).toFixed(0)}% of the change` : ", moved the wrong way to explain it"}`,
      drivers: [r],
    };
  }
  // Segment decompositions. Compare each segment's share of the movement in
  // the net direction with its share of baseline revenue: a cause is
  // concentrated, a non-cause moves in proportion.
  const totalFrom = segs.reduce((a, s) => a + s.from, 0) || baseFrom || 1;
  const withDir = segs.filter((s) => Math.sign(s.delta) === dir);
  const against = segs.filter((s) => Math.sign(s.delta) === -dir);
  const grossDir = withDir.reduce((a, s) => a + Math.abs(s.delta), 0) || 1;
  for (const s of segs) s.shareOfDelta = Math.sign(s.delta) === dir ? Math.abs(s.delta) / grossDir : -Math.abs(s.delta) / grossDir;
  withDir.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const top = withDir.slice(0, 2);
  const topShare = top.reduce((a, s) => a + s.shareOfDelta, 0); // 0..1
  const topBaseShare = top.reduce((a, s) => a + s.from / totalFrom, 0);
  const lead = top[0];
  const leadOver = lead ? lead.shareOfDelta / Math.max(lead.from / totalFrom, 1e-9) : 0;
  const offsetAmt = against.reduce((a, s) => a + Math.abs(s.delta), 0);
  const verdict: Finding["verdict"] =
    cap(tiny || segs.length < 2 ? "rejected" : topShare >= 0.5 && leadOver >= 1.5 ? "supported" : topShare >= 0.35 && leadOver >= 1.2 ? "partial" : "rejected");
  const ordered = [...withDir, ...against.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))];
  return {
    ...base,
    explains: verdict === "rejected" ? 0 : topShare,
    verdict,
    summary:
      segs.length < 2
        ? `only one segment in the data (${segs[0]?.segment ?? "none"}) — cannot test`
        : verdict === "rejected"
          ? `movement is spread roughly in proportion across ${segs.length} segments — not the cause`
          : `${top.map((s) => `${s.segment} ${sgn(s.delta)}${fmt(s.delta)}`).join(", ")} = ${(topShare * 100).toFixed(0)}% of all ${dir < 0 ? "declines" : "gains"} vs ${(topBaseShare * 100).toFixed(0)}% of baseline revenue${offsetAmt ? `; partly offset by ${sgn(-dir)}${fmt(offsetAmt * -dir)} elsewhere` : ""}`,
    drivers: ordered.slice(0, 8),
  };
}

async function writeWorld(mem: Memory, frame: Frame, findings: Finding[], evidence: Evidence[], runId: string, backendName: string) {
  const at = new Date().toISOString();
  const src = (ev?: Evidence) => ({
    kind: "agent", by: "whyledger", at, runId,
    url: ev ? `sql:${backendName}` : undefined,
    checksum: ev ? createHash("sha256").update(ev.sql + JSON.stringify(ev.rows)).digest("hex").slice(0, 16) : undefined,
  });
  const q = await mem.world.upsertEntity({ type: "question", externalKey: { system: "whyledger", id: runId }, attrs: { text: frame.question, dataset: frame.dataset, metric: frame.metric, scope: frame.scope }, source: src() });
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

async function narrate(frame: Frame, metricLabel: string, unit: "$" | "#", b: { bFrom: number; bTo: number; delta: number }, findings: Finding[], recalled: Report["recalled"]) {
  const fmt = (n: number) => fmtU(n, unit);
  const facts = findings.map((f) => ({ id: f.hypothesis, verdict: f.verdict, summary: f.summary, evidence: f.evidence }));
  const template = () => {
    const sup = findings.filter((f) => f.verdict !== "rejected");
    const rej = findings.filter((f) => f.verdict === "rejected");
    return [
      `${metricLabel[0].toUpperCase() + metricLabel.slice(1)} went ${fmt(b.bFrom)} -> ${fmt(b.bTo)} (${sgn(b.delta)}${fmt(b.delta)}) [ev-1].`,
      sup.length ? "What explains it:" : "No single hypothesis explains it; the change is broad-based.",
      ...sup.slice(0, 4).map((f, i) => `${i + 1}. ${f.title}: ${f.summary} [${f.evidence.join(", ")}]`),
      rej.length ? `Ruled out: ${rej.map((f) => `${f.title} [${f.evidence.join(", ")}]`).join("; ")}.` : "",
    ].filter(Boolean).join("\n");
  };
  if (!llmAvailable()) return { text: template(), mode: llmLabel() };
  const budget = Number(process.env.WHYLEDGER_NARRATE_WAIT_MS ?? 60000);
  const reply = await Promise.race([chat([
    { role: "system", content: "You explain metric changes to a busy operations manager. Use ONLY the findings given; never invent numbers. Cite evidence ids in [brackets] after each claim. Mention what was ruled out. <=130 words, plain language, then one line 'Next check:' with a concrete follow-up." },
    { role: "user", content: `Question: ${frame.question}\nChange: ${metricLabel} ${fmt(b.bFrom)} -> ${fmt(b.bTo)} (${sgn(b.delta)}${fmt(b.delta)}) [ev-1]\nFindings: ${JSON.stringify(facts)}\nPrior memory: ${JSON.stringify(recalled.map((r) => r.content))}` },
  ], { maxTokens: 500 }).catch((e) => { console.warn(`[llm] ${(e as Error).message.slice(0, 200)}`); return null; }),
    new Promise<null>((r) => setTimeout(() => r(null), budget).unref())]);
  if (process.env.WHYLEDGER_DEBUG) console.warn(`[narrate raw] ${JSON.stringify(reply)}`);
  if (!reply) return { text: template(), mode: `${llmLabel()} unavailable/timed out -> template` };
  if (!/ev-\d+/.test(reply)) return { text: template(), mode: `${llmLabel()} cited no receipts -> template` };
  // every cited id must exist
  const ids = new Set(findings.flatMap((f) => f.evidence).concat("ev-1"));
  const cited = [...reply.matchAll(/ev-\d+/g)].map((m) => m[0]);
  if (cited.some((c) => !ids.has(c))) return { text: template(), mode: `${llmLabel()} cited a missing receipt -> template` };
  return { text: reply, mode: llmLabel() };
}
