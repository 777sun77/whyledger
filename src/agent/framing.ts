// Question -> Frame. Deterministic rules first (instant, auditable); Nemotron
// only when the rules cannot find two periods.
import { chat, llmAvailable, parseJson } from "../llm/provider.ts";
import { DATASETS } from "./datasets.ts";
import type { DatasetId, Frame, Period } from "./types.ts";

const STATES: Record<string, string> = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY" };
const CATEGORIES = ["Books", "Children", "Electronics", "Home", "Jewelry", "Men", "Music", "Shoes", "Sports", "Women"];
const BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island", "EWR"];
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function detectDataset(q: string): DatasetId {
  return /\b(taxi|cab|trips?|rides?|fares?|borough|manhattan|brooklyn|queens|bronx|airport)\b/i.test(q) ? "taxi" : "retail";
}

function periods(q: string, ds: DatasetId): Period[] {
  const out: { at: number; p: Period }[] = [];
  if (ds === "taxi") {
    for (const m of q.matchAll(/\b(20\d\d)-(0[1-9]|1[0-2])\b/g)) out.push({ at: m.index!, p: { year: +m[1], month: +m[2] } });
    for (const m of q.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (20\d\d)\b/gi)) out.push({ at: m.index!, p: { year: +m[2], month: MONTHS[m[1].toLowerCase()] } });
  } else {
    for (const m of q.matchAll(/\b(199[8-9]|200[0-3])\s*q([1-4])\b|\bq([1-4])\s*(199[8-9]|200[0-3])\b/gi))
      out.push({ at: m.index!, p: m[1] ? { year: +m[1], qoy: +m[2] } : { year: +m[4], qoy: +m[3] } });
    const taken = out.map((o) => o.at);
    for (const m of q.matchAll(/\b(199[8-9]|200[0-3])\b/g)) if (!taken.some((t) => Math.abs(t - m.index!) < 8)) out.push({ at: m.index!, p: { year: +m[1] } });
  }
  return out.sort((a, b) => a.at - b.at).map((o) => o.p);
}

export function frameByRules(question: string): Frame | null {
  const dataset = detectDataset(question);
  const ps = periods(question, dataset);
  if (ps.length < 2) return null;
  const lower = question.toLowerCase();
  const scope: Record<string, string> = {};
  const d = DATASETS[dataset];
  let metric = d.defaultMetric;
  let channel: string | undefined;
  if (dataset === "retail") {
    channel = /\bweb|online\b/.test(lower) ? "web" : /\bcatalog/.test(lower) ? "catalog" : "store";
    for (const [name, code] of Object.entries(STATES)) if (new RegExp(`\\b${name}\\b`).test(lower)) scope.state = code;
    const code = question.match(/\b(?:in|for|from) ([A-Z]{2})\b/);
    if (code && Object.values(STATES).includes(code[1])) scope.state = code[1];
    for (const c of CATEGORIES) if (new RegExp(`\\b${c.toLowerCase()}\\b`).test(lower)) scope.category = c;
  } else {
    if (/\b(revenue|fares?|money|earnings|income)\b/.test(lower) && !/\btrips?\b.*\b(drop|fall|change|rise)/.test(lower)) metric = "revenue";
    for (const b of BOROUGHS) if (lower.includes(b.toLowerCase())) scope.borough = b;
    if (/\bairport/.test(lower)) scope.airport = "airport";
  }
  const [from, to] = [ps[0], ps[1]];
  return { question, dataset, metric, channel, from, to, scope, framedBy: "rules" };
}

export async function frameQuestion(question: string): Promise<Frame> {
  const byRules = frameByRules(question);
  if (byRules) return byRules;
  const dataset = detectDataset(question);
  const fallback: Frame = dataset === "taxi"
    ? { question, dataset, metric: "trips", from: { year: 2024, month: 10 }, to: { year: 2025, month: 2 }, scope: {}, framedBy: "default" }
    : { question, dataset, metric: "revenue", channel: "store", from: { year: 2001, qoy: 4 }, to: { year: 2002, qoy: 4 }, scope: {}, framedBy: "default" };
  if (!llmAvailable()) return fallback;
  const schema = dataset === "taxi"
    ? `{"metric":"trips|revenue","from":{"year":2024|2025,"month":1-12},"to":{...},"scope":{"borough":"Manhattan|Brooklyn|Queens|Bronx|Staten Island or null"}}`
    : `{"channel":"store|web|catalog","from":{"year":1998-2003,"qoy":1-4 or null},"to":{...},"scope":{"state":"2-letter or null","category":"${CATEGORIES.join("|")} or null"}}`;
  const reply = await chat([
    { role: "system", content: "You convert analyst questions into JSON frames. Reply with JSON only." },
    { role: "user", content: `Question: ${question}\nSchema: ${schema}\n"from" is the earlier period. If the question gives one period, compare it with the same period a year earlier.` },
  ], { maxTokens: 300 }).catch(() => null);
  const j = parseJson<any>(reply);
  if (!j?.from?.year || !j?.to?.year) return fallback;
  const p = (x: any): Period => ({ year: +x.year, qoy: x.qoy ? +x.qoy : undefined, month: x.month ? +x.month : undefined });
  const scope = Object.fromEntries(Object.entries(j.scope ?? {}).filter(([, v]) => v)) as Record<string, string>;
  return { ...fallback, metric: j.metric ?? fallback.metric, channel: j.channel ?? fallback.channel, from: p(j.from), to: p(j.to), scope, framedBy: "nemotron" };
}
