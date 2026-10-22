import { test } from "node:test";
import assert from "node:assert/strict";
import { score } from "../src/agent/investigator.ts";
import { assertReadOnly } from "../src/data/backend.ts";

const ev = (rows: any[]) => ({ id: "ev-2", hypothesis: "x", sql: "", backend: "t", ranAt: "", ms: 0, rows });

test("concentrated drop is supported", () => {
  const f = score("category", "cat", ev([
    { segment: "A", v_from: 100, v_to: 20 }, { segment: "B", v_from: 100, v_to: 100 }, { segment: "C", v_from: 100, v_to: 100 },
  ]), -80, 300);
  assert.equal(f.verdict, "supported");
  assert.equal(f.drivers[0].segment, "A");
});

test("proportional drop is rejected", () => {
  const f = score("category", "cat", ev([
    { segment: "A", v_from: 100, v_to: 90 }, { segment: "B", v_from: 100, v_to: 90 }, { segment: "C", v_from: 100, v_to: 90 },
  ]), -30, 300);
  assert.equal(f.verdict, "rejected");
});

test("SQL guard blocks writes", () => {
  assert.throws(() => assertReadOnly("DROP TABLE x"));
  assert.throws(() => assertReadOnly("SELECT 1; DELETE FROM x"));
  assertReadOnly("WITH a AS (SELECT 1) SELECT * FROM a");
});
