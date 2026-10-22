// Hypothesis library for "why did revenue move?". Each hypothesis is a
// decomposition the agent can TEST with one read-only query against the
// connected sources (stores, items, promotions, demographics, returns, and
// the other sales channels). The LLM chooses order and may propose more;
// numbers always come from SQL, never from the model.
import type { SqlBackend } from "../data/backend.ts";
import type { Frame, Period } from "./types.ts";

export interface Hypothesis {
  id: string;
  title: string;
  question: string; // what it would mean if true
  sql: (f: Frame, b: SqlBackend) => string;
}

const FACT = {
  store_revenue: { table: "store_sales", date: "ss_sold_date_sk", amt: "ss_net_paid", qty: "ss_quantity", item: "ss_item_sk", promo: "ss_promo_sk", cdemo: "ss_cdemo_sk" },
  web_revenue: { table: "web_sales", date: "ws_sold_date_sk", amt: "ws_net_paid", qty: "ws_quantity", item: "ws_item_sk", promo: "ws_promo_sk", cdemo: "ws_bill_cdemo_sk" },
  catalog_revenue: { table: "catalog_sales", date: "cs_sold_date_sk", amt: "cs_net_paid", qty: "cs_quantity", item: "cs_item_sk", promo: "cs_promo_sk", cdemo: "cs_bill_cdemo_sk" },
} as const;

const periodCond = (p: Period) => `(d.d_year = ${p.year}${p.qoy ? ` AND d.d_qoy = ${p.qoy}` : ""})`;
const bucket = (f: Frame) =>
  `CASE WHEN ${periodCond(f.from)} THEN 'from' WHEN ${periodCond(f.to)} THEN 'to' END`;
const both = (f: Frame) => `(${periodCond(f.from)} OR ${periodCond(f.to)})`;

function scopeJoins(f: Frame, b: SqlBackend, F: (typeof FACT)[keyof typeof FACT]) {
  const j: string[] = [];
  const w: string[] = [];
  if (f.scope?.category) { j.push(`JOIN ${b.t("item")} si ON si.i_item_sk = s.${F.item}`); w.push(`si.i_category = '${f.scope.category.replace(/'/g, "")}'`); }
  if (f.scope?.state && f.metric === "store_revenue") { j.push(`JOIN ${b.t("store")} ss2 ON ss2.s_store_sk = s.ss_store_sk`); w.push(`ss2.s_state = '${f.scope.state.replace(/'/g, "")}'`); }
  return { j: j.join(" "), w: w.length ? " AND " + w.join(" AND ") : "" };
}

/** Generic "split the change by a dimension" query: segment, from, to. */
function bySegment(segmentExpr: string, extraJoin: (f: Frame, b: SqlBackend) => string) {
  return (f: Frame, b: SqlBackend) => {
    const F = FACT[f.metric];
    const sc = scopeJoins(f, b, F);
    return `SELECT ${segmentExpr} AS segment,
  SUM(CASE WHEN ${periodCond(f.from)} THEN s.${F.amt} ELSE 0 END) AS v_from,
  SUM(CASE WHEN ${periodCond(f.to)} THEN s.${F.amt} ELSE 0 END) AS v_to
FROM ${b.t(F.table)} s
JOIN ${b.t("date_dim")} d ON d.d_date_sk = s.${F.date}
${extraJoin(f, b)} ${sc.j}
WHERE ${both(f)}${sc.w}
GROUP BY 1`;
  };
}

export const HYPOTHESES: Hypothesis[] = [
  {
    id: "geography",
    title: "A few regions drove it",
    question: "Is the change concentrated in specific states?",
    sql: (f, b) =>
      f.metric === "store_revenue"
        ? bySegment("COALESCE(st.s_state, 'unknown')", (_f, b) => `JOIN ${b.t("store")} st ON st.s_store_sk = s.ss_store_sk`)(f, b)
        : bySegment("COALESCE(ca.ca_state, 'unknown')", (f, b) => `JOIN ${b.t("customer_address")} ca ON ca.ca_address_sk = s.${f.metric === "web_revenue" ? "ws_bill_addr_sk" : "cs_bill_addr_sk"}`)(f, b),
  },
  {
    id: "category",
    title: "A product category drove it",
    question: "Is the change concentrated in specific item categories?",
    sql: bySegment("COALESCE(i.i_category, 'unknown')", (f, b) => `JOIN ${b.t("item")} i ON i.i_item_sk = s.${FACT[f.metric].item}`),
  },
  {
    id: "promotion",
    title: "Promotions changed",
    question: "Did promoted vs non-promoted sales move differently?",
    sql: bySegment("CASE WHEN s." + "PROMO" + " IS NULL THEN 'no promotion' ELSE 'promoted' END", () => ""),
  },
  {
    id: "demographics",
    title: "A customer segment shifted",
    question: "Did a demographic segment (education level) buy more or less?",
    sql: bySegment("COALESCE(cd.cd_education_status, 'unknown')", (f, b) => `LEFT JOIN ${b.t("customer_demographics")} cd ON cd.cd_demo_sk = s.${FACT[f.metric].cdemo}`),
  },
  {
    id: "price_volume",
    title: "Price vs volume",
    question: "Did fewer units sell, or did each unit sell for less?",
    sql: (f, b) => {
      const F = FACT[f.metric];
      const sc = scopeJoins(f, b, F);
      return `SELECT ${bucket(f)} AS period, SUM(s.${F.amt}) AS revenue, SUM(s.${F.qty}) AS units, COUNT(*) AS lines
FROM ${b.t(F.table)} s JOIN ${b.t("date_dim")} d ON d.d_date_sk = s.${F.date} ${sc.j}
WHERE ${both(f)}${sc.w} GROUP BY 1`;
    },
  },
  {
    id: "channel_shift",
    title: "Demand moved to another channel",
    question: "Did the other channels grow while this one fell (cannibalization)?",
    sql: (f, b) =>
      ["store_revenue", "web_revenue", "catalog_revenue"]
        .map((m) => {
          const F = FACT[m as keyof typeof FACT];
          return `SELECT '${m.replace("_revenue", "")}' AS segment,
  SUM(CASE WHEN ${periodCond(f.from)} THEN s.${F.amt} ELSE 0 END) AS v_from,
  SUM(CASE WHEN ${periodCond(f.to)} THEN s.${F.amt} ELSE 0 END) AS v_to
FROM ${b.t(F.table)} s JOIN ${b.t("date_dim")} d ON d.d_date_sk = s.${F.date} WHERE ${both(f)}`;
        })
        .join("\nUNION ALL\n"),
  },
  {
    id: "returns",
    title: "Returns ate into it",
    question: "Did refunds/returns grow between the periods?",
    sql: (f, b) => {
      const R = { store_revenue: ["store_returns", "sr_returned_date_sk", "sr_return_amt"], web_revenue: ["web_returns", "wr_returned_date_sk", "wr_return_amt"], catalog_revenue: ["catalog_returns", "cr_returned_date_sk", "cr_return_amount"] }[f.metric];
      return `SELECT 'returns' AS segment,
  SUM(CASE WHEN ${periodCond(f.from)} THEN r.${R[2]} ELSE 0 END) AS v_from,
  SUM(CASE WHEN ${periodCond(f.to)} THEN r.${R[2]} ELSE 0 END) AS v_to
FROM ${b.t(R[0])} r JOIN ${b.t("date_dim")} d ON d.d_date_sk = r.${R[1]} WHERE ${both(f)}`;
    },
  },
];

// fix the promo column placeholder per metric
const promo = HYPOTHESES.find((h) => h.id === "promotion")!;
const promoSql = promo.sql;
promo.sql = (f, b) => promoSql(f, b).replace("s.PROMO", `s.${FACT[f.metric].promo}`);

export function baselineSql(f: Frame, b: SqlBackend): string {
  const F = FACT[f.metric];
  const sc = scopeJoins(f, b, F);
  return `SELECT ${bucket(f)} AS period, SUM(s.${F.amt}) AS revenue
FROM ${b.t(F.table)} s JOIN ${b.t("date_dim")} d ON d.d_date_sk = s.${F.date} ${sc.j}
WHERE ${both(f)}${sc.w} GROUP BY 1`;
}
