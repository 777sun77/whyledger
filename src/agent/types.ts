export interface Period { year: number; qoy?: number; month?: number }
export type DatasetId = "retail" | "taxi";

export interface Frame {
  question: string;
  dataset: DatasetId;
  /** measure to explain, e.g. revenue | trips */
  metric: string;
  /** retail only: store | web | catalog */
  channel?: string;
  from: Period; // baseline (earlier)
  to: Period; // comparison
  /** dimension filters honored by every query, e.g. { state: "TX" } */
  scope: Record<string, string>;
  framedBy: string;
}

export interface Evidence {
  id: string; // ev-1 ...
  hypothesis: string;
  title: string;
  sql: string;
  backend: string;
  lineage: string;
  ranAt: string;
  ms: number;
  rows: Record<string, unknown>[];
}

export interface Driver { segment: string; from: number; to: number; delta: number; shareOfDelta: number }

export interface Finding {
  hypothesis: string;
  title: string;
  /** share (0..1) of the movement in the net direction this hypothesis accounts for */
  explains: number;
  verdict: "supported" | "partial" | "rejected" | "connection";
  summary: string;
  evidence: string[]; // evidence ids
  drivers: Driver[];
}

export interface Report {
  frame: Frame;
  metricLabel: string;
  unit: "$" | "#";
  baseline: { from: number; to: number; delta: number; pct: number; evidence: string };
  findings: Finding[];
  answer: string;
  answerMode: string;
  hunch?: { order: string[]; why: string; matched: boolean };
  recalled: { id: string; content: string; relevance: number }[];
  evidence: Evidence[];
  backend: string;
  steps: { at: string; ms: number; step: string; detail: string }[];
  timings: Record<string, number>;
  /** H-MEM id of the stored conclusion (feedback + audit target) */
  memoryId: string;
}
