import { test } from "node:test";
import assert from "node:assert/strict";
import { score } from "../src/agent/investigator.ts";
import { assertReadOnly } from "../src/data/backend.ts";

const ev = (rows: any[]) => ({ id: "ev-2", hypothesis: "x", title: "x", sql: "", backend: "t", lineage: "", ranAt: "", ms: 0, rows });
const inRange = (f: { explains: number; drivers: { shareOfDelta: number }[] }) => {
  assert.ok(f.explains >= 0 && f.explains <= 1, `explains ${f.explains} out of 0..1`);
  for (const d of f.drivers) assert.ok(Math.abs(d.shareOfDelta) <= 1 + 1e-9, `share ${d.shareOfDelta}`);
};

test("concentrated drop is supported", () => {
  const f = score("category", "cat", ev([
    { segment: "A", v_from: 100, v_to: 20 }, { segment: "B", v_from: 100, v_to: 100 }, { segment: "C", v_from: 100, v_to: 100 },
  ]), -80, 300);
  assert.equal(f.verdict, "supported");
  assert.equal(f.drivers[0].segment, "A");
  inRange(f);
});

test("proportional drop is rejected", () => {
  const f = score("category", "cat", ev([
    { segment: "A", v_from: 100, v_to: 90 }, { segment: "B", v_from: 100, v_to: 90 }, { segment: "C", v_from: 100, v_to: 90 },
  ]), -30, 300);
  assert.equal(f.verdict, "rejected");
  inRange(f);
});

test("regression: small net change with big offsetting moves never reports >100%", () => {
  // net -10 = A -100, B -60, C +150 (old code reported 1600%)
  const f = score("category", "cat", ev([
    { segment: "A", v_from: 300, v_to: 200 }, { segment: "B", v_from: 300, v_to: 240 }, { segment: "C", v_from: 400, v_to: 550 },
  ]), -10, 1000);
  inRange(f);
  assert.match(f.summary, /offset/);
  for (const id of ["channel_shift", "returns"]) {
    inRange(score(id, id, ev([{ segment: "store", v_from: 1000, v_to: 990 }, { segment: "web", v_from: 500, v_to: 900 }]), -10, 1000));
  }
  inRange(score("price_volume", "pv", ev([{ v_from: 1000, v_to: 990, u_from: 100, u_to: 80 }]), -10, 1000));
});

test("SQL guard blocks writes", () => {
  assert.throws(() => assertReadOnly("DROP TABLE x"));
  assert.throws(() => assertReadOnly("SELECT 1; DELETE FROM x"));
  assertReadOnly("WITH a AS (SELECT 1) SELECT * FROM a");
});

import { frameByRules } from "../src/agent/framing.ts";
test("framing honors filters", () => {
  const a = frameByRules("Why did web revenue in Texas change from 2000 to 2001?")!;
  assert.equal(a.channel, "web"); assert.equal(a.scope.state, "TX"); assert.equal(a.from.year, 2000);
  const b = frameByRules("Why did catalog revenue for Electronics in CA change from 2001 Q3 to 2002 Q3?")!;
  assert.equal(b.scope.category, "Electronics"); assert.equal(b.scope.state, "CA"); assert.equal(b.from.qoy, 3);
  const c = frameByRules("Why did yellow taxi trips in Manhattan drop from 2024-10 to 2025-02?")!;
  assert.equal(c.dataset, "taxi"); assert.equal(c.scope.borough, "Manhattan"); assert.equal(c.to.month, 2); assert.equal(c.metric, "trips");
  const d = frameByRules("Why did taxi revenue change from Oct 2024 to Feb 2025?")!;
  assert.equal(d.metric, "revenue"); assert.equal(d.from.month, 10);
});
