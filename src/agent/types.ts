export interface Period { year: number; qoy?: number }
export interface Frame {
  question: string;
  metric: "store_revenue" | "web_revenue" | "catalog_revenue";
  from: Period; // baseline
  to: Period; // comparison
  scope?: { state?: string; category?: string };
}

export interface Evidence {
  id: string; // ev-1 ...
  hypothesis: string;
  sql: string;
  backend: string;
  ranAt: string;
  ms: number;
  rows: Record<string, unknown>[];
}

export interface Finding {
  hypothesis: string;
  title: string;
  /** share of the total change this hypothesis accounts for, -1..1+ */
  explains: number;
  verdict: "supported" | "partial" | "rejected";
  summary: string;
  evidence: string[]; // evidence ids
  drivers: { segment: string; from: number; to: number; delta: number; shareOfDelta: number }[];
}

export interface Report {
  frame: Frame;
  baseline: { from: number; to: number; delta: number; pct: number; evidence: string };
  findings: Finding[];
  answer: string;
  answerMode: string;
  recalled: { id: string; content: string; relevance: number }[];
  evidence: Evidence[];
  backend: string;
  steps: { at: string; step: string; detail: string }[];
}
