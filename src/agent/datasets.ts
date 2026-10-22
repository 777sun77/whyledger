// Two investigation domains over different Zetaris sources. Each one is a
// small "investigation cube" materialized IN Zetaris (schemastore view ->
// Lightning filestore table, see zetaris/*.sql), so every hypothesis is a
// sub-second read-only query instead of a 30 s scan of the raw tables.
import type { SqlBackend } from "../data/backend.ts";
import type { DatasetId, Frame, Period } from "./types.ts";

export interface Dim { id: string; col: string; title: string; question: string }

export interface Dataset {
  id: DatasetId;
  name: string;
  cube: string;
  lineage: string;
  metrics: Record<string, { col: string; label: string; unit: "$" | "#"; volume?: { col: string; label: string } }>;
  defaultMetric: string;
  dims: Dim[];
  periodCond: (p: Period) => string;
  periodLabel: (p: Period) => string;
  /** extra WHERE beyond scope (e.g. retail channel) */
  baseWhere: (f: Frame) => string[];
  extra: (f: Frame, b: SqlBackend) => { id: string; title: string; question: string; sql: string }[];
  examples: string[];
}

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

export const RETAIL: Dataset = {
  id: "retail",
  name: "Retail (TPC-DS: store, web and catalog channels)",
  cube: "sales_cube",
  lineage: "WHYLEDGER_MART.sales_cube <- schemastore view whyledger.sales_cube <- TPCDS_DB.store_sales + web_sales + catalog_sales JOIN date_dim, item, customer_address, customer_demographics",
  metrics: { revenue: { col: "revenue", label: "revenue", unit: "$", volume: { col: "units", label: "units" } } },
  defaultMetric: "revenue",
  dims: [
    { id: "state", col: "state", title: "Shoppers from a few states drove it", question: "Is the change concentrated in shoppers from specific states?" },
    { id: "category", col: "category", title: "A product category drove it", question: "Is the change concentrated in specific item categories?" },
    { id: "education", col: "education", title: "A customer segment shifted", question: "Did a customer segment (education level) buy more or less?" },
    { id: "promoted", col: "promoted", title: "Promotions changed", question: "Did promoted vs non-promoted sales move differently?" },
  ],
  periodCond: (p) => `(yr = ${p.year}${p.qoy ? ` AND qoy = ${p.qoy}` : ""})`,
  periodLabel: (p) => `${p.year}${p.qoy ? ` Q${p.qoy}` : ""}`,
  baseWhere: (f) => [`channel = ${q(f.channel ?? "store")}`],
  extra: (f, b) => {
    const scope = scopeWhere(f, RETAIL, ["state", "category"]);
    const both = `(${RETAIL.periodCond(f.from)} OR ${RETAIL.periodCond(f.to)})`;
    return [
      {
        id: "channel_shift", title: "Demand moved to another channel", question: "Did the other channels grow while this one fell (cannibalization)?",
        sql: `SELECT channel AS segment, ${sums(f, RETAIL, "revenue")}\nFROM ${b.t("sales_cube")}\nWHERE ${[both, ...scope].join(" AND ")}\nGROUP BY channel`,
      },
      {
        id: "returns", title: "Returns ate into it", question: "Did refunds/returns grow between the periods?",
        sql: `SELECT 'returns' AS segment, ${sums(f, RETAIL, "return_amt")}\nFROM ${b.t("returns_cube")}\nWHERE ${[both, `channel = ${q(f.channel ?? "store")}`, ...scope].join(" AND ")}`,
      },
    ];
  },
  examples: [
    "Why did store revenue change from 2001 Q4 to 2002 Q4?",
    "Why did web revenue in TX change from 2000 to 2001?",
    "Why did catalog revenue for Electronics change from 2001 Q3 to 2002 Q3?",
  ],
};

export const TAXI: Dataset = {
  id: "taxi",
  name: "NYC yellow taxi (NY_TAXI.yellow_taxi + taxi_zones)",
  cube: "taxi_cube",
  lineage: "WHYLEDGER_MART.taxi_cube <- schemastore view whyledger.taxi_cube <- NY_TAXI.yellow_taxi JOIN NY_TAXI.taxi_zones (pickup zone -> borough)",
  metrics: {
    trips: { col: "trips", label: "trips", unit: "#" },
    revenue: { col: "revenue", label: "taxi revenue", unit: "$", volume: { col: "trips", label: "trips" } },
  },
  defaultMetric: "trips",
  dims: [
    { id: "borough", col: "borough", title: "A few boroughs drove it", question: "Is the change concentrated in pickups from specific boroughs?" },
    { id: "airport", col: "airport", title: "Airport trips changed", question: "Did airport trips move differently from city trips?" },
    { id: "distance_band", col: "distance_band", title: "Short vs long trips", question: "Did a trip-length band (short hops vs long rides) drive it?" },
    { id: "time_band", col: "time_band", title: "A time of day drove it", question: "Is it concentrated in peak hours, midday or night?" },
    { id: "payment", col: "payment", title: "Payment mix shifted", question: "Did cash vs card trips move differently?" },
  ],
  periodCond: (p) => (p.month ? `(month = '${p.year}-${String(p.month).padStart(2, "0")}')` : `(substr(month, 1, 4) = '${p.year}')`),
  periodLabel: (p) => (p.month ? `${p.year}-${String(p.month).padStart(2, "0")}` : `${p.year}`),
  baseWhere: () => [],
  extra: (f, b) => {
    if (f.metric !== "revenue") return [];
    const both = `(${TAXI.periodCond(f.from)} OR ${TAXI.periodCond(f.to)})`;
    return [{
      id: "fees", title: "Surcharges changed", question: "Did congestion surcharges move the total?",
      sql: `SELECT 'congestion surcharges' AS segment, ${sums(f, TAXI, "congestion_fees")}\nFROM ${b.t("taxi_cube")}\nWHERE ${[both, ...scopeWhere(f, TAXI)].join(" AND ")}`,
    }];
  },
  examples: [
    "Why did yellow taxi trips drop from 2024-10 to 2025-02?",
    "Why did taxi revenue in Manhattan change from 2024-05 to 2025-01?",
  ],
};

export const DATASETS: Record<DatasetId, Dataset> = { retail: RETAIL, taxi: TAXI };

function scopeWhere(f: Frame, d: Dataset, only?: string[]): string[] {
  return Object.entries(f.scope)
    .filter(([k]) => d.dims.some((x) => x.id === k) && (!only || only.includes(k)))
    .map(([k, v]) => `${d.dims.find((x) => x.id === k)!.col} = ${q(v)}`);
}

function sums(f: Frame, d: Dataset, col: string) {
  return `SUM(CASE WHEN ${d.periodCond(f.from)} THEN ${col} ELSE 0 END) AS v_from,\n  SUM(CASE WHEN ${d.periodCond(f.to)} THEN ${col} ELSE 0 END) AS v_to`;
}

export function where(f: Frame, d: Dataset, extra: string[] = []): string {
  const both = `(${d.periodCond(f.from)} OR ${d.periodCond(f.to)})`;
  return [both, ...d.baseWhere(f), ...scopeWhere(f, d), ...extra].join(" AND ");
}

export function baselineSql(f: Frame, d: Dataset, b: SqlBackend): string {
  const m = d.metrics[f.metric];
  return `SELECT ${sums(f, d, m.col)}\nFROM ${b.t(d.cube)}\nWHERE ${where(f, d)}`;
}

export function hypotheses(f: Frame, d: Dataset, b: SqlBackend) {
  const m = d.metrics[f.metric];
  const out = d.dims
    .filter((dim) => !(dim.id in f.scope)) // a filtered dimension cannot explain itself
    .map((dim) => ({
      id: dim.id, title: dim.title, question: dim.question,
      sql: `SELECT ${dim.col} AS segment, ${sums(f, d, m.col)}\nFROM ${b.t(d.cube)}\nWHERE ${where(f, d)}\nGROUP BY ${dim.col}`,
    }));
  if (m.volume) {
    out.push({
      id: "price_volume", title: "Price vs volume", question: `Did fewer ${m.volume.label} happen, or did each one bring in less?`,
      sql: `SELECT ${sums(f, d, m.col)},\n  SUM(CASE WHEN ${d.periodCond(f.from)} THEN ${m.volume.col} ELSE 0 END) AS u_from,\n  SUM(CASE WHEN ${d.periodCond(f.to)} THEN ${m.volume.col} ELSE 0 END) AS u_to\nFROM ${b.t(d.cube)}\nWHERE ${where(f, d)}`,
    });
  }
  return [...out, ...d.extra(f, b)];
}

/** Second-level query that connects two findings: inside the top segment of A, split by B. */
export function drillSql(f: Frame, d: Dataset, b: SqlBackend, a: { dim: string; value: string }, by: string): string {
  const m = d.metrics[f.metric];
  const A = d.dims.find((x) => x.id === a.dim)!;
  const B = d.dims.find((x) => x.id === by)!;
  return `SELECT ${B.col} AS segment, ${sums(f, d, m.col)}\nFROM ${b.t(d.cube)}\nWHERE ${where(f, d, [`${A.col} = ${q(a.value)}`])}\nGROUP BY ${B.col}`;
}
