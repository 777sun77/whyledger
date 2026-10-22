export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  ms: number;
}

export interface SqlBackend {
  /** label shown on every evidence receipt */
  name: string;
  /** true only for the real sponsor engine */
  isZetaris: boolean;
  run(sql: string): Promise<QueryResult>;
  /** discover what tables/columns exist (the "fragmented" landscape) */
  catalog(): Promise<{ table: string; columns: string[] }[]>;
  /** fully-qualified name for a TPC-DS table on this backend */
  t(table: string): string;
}

const READ_ONLY = /^\s*(--[^\n]*\n\s*)*(select|with|show|describe|desc|explain)\b/i;
const FORBIDDEN = /\b(insert|update|delete|drop|create|alter|truncate|merge|grant|revoke|cache|register|compile|activate|remove)\b/i;

/** The agent may only read. Any model-written SQL passes through here. */
export function assertReadOnly(sql: string): void {
  const stripped = sql.replace(/'[^']*'/g, "''");
  if (!READ_ONLY.test(stripped) || FORBIDDEN.test(stripped) || stripped.includes(";") && stripped.trim().replace(/;\s*$/, "").includes(";")) {
    throw new Error("Rejected non-read-only SQL: the investigator only runs single SELECT/WITH/SHOW statements.");
  }
}
