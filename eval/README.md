# Does WhyLedger explain correctly?

Two evaluations, both reproducible from this repo. Raw output: [`planted-results.json`](planted-results.json), [`zetaris-results.json`](zetaris-results.json).

## 1. Planted causes: can it find a cause we hid, and refuse to invent one?

`npm run eval:planted` (offline, ~12 s, no keys). One real quarter of TPC-DS (2001 Q4, all three channels) is copied as the next-year quarter **with a known cause planted in it**. The unchanged investigator (same SQL, same scoring) then answers *"Why did store revenue change from 2001 Q4 to 2002 Q4?"* and is graded on:

- **found**: the planted hypothesis is `supported`
- **lead**: its top driver is the planted segment
- **noFalseSegment** / **noFalseCause**: no other segment hypothesis is wrongly `supported`
- **story**: price vs volume is called correctly
- **bounded** (all shares within 0–100%) and **receipts** (every finding cites a receipt that exists)

| Planted cause | Store revenue change | Result |
|---|---|---|
| Category Electronics ×0.55 · Books ×0.6 · Home ×1.5 · Shoes ×0.5 | −4.5% / −4.4% / +4.4% / −4.5% | ✅ 4/4: right category, right lead, no false causes |
| Shopper state TX ×0.5 · KY ×1.6 · GA ×0.4 | −3.9% / +3.0% / −2.5% | ✅ 3/3 |
| Segment College ×1.45 · Primary ×0.6 · 4 yr Degree ×0.6 | +6.5% / −5.4% / −6.1% | ✅ 3/3 |
| Price +10%, same units | +10.0% | ✅ "mostly a price story" |
| Uniform volume −15% | −15.0% | ✅ "mostly a volume story", no segment blamed |
| Demand moves from store to web | −10.0% | ✅ channel shift supported |
| Store returns ×4, sales −5% | −5.0% | ✅ returns supported |
| **Control:** noise only (±0.4%) | −0.0% | ✅ nothing supported |
| **Control:** uniform +6% | +6.0% | ✅ no false cause; volume story |
| No-promotion sales ×4 | +3.2% | ⚠️ promotions found with the right lead, but one other segment also flagged |

**16/17 scenarios fully correct, 75/76 individual checks.** The one miss is a real confound in TPC-DS: sales without a promotion key are mostly the rows that also lack customer demographics (`unknown`), so the "unknown" education segment moves with them. WhyLedger's drill-down shows exactly that link (*no promotion × education → unknown*), so the user can see it, but our strict grader counts it as a false positive.

## 2. Faithfulness on the real Zetaris instance

`npm run eval:zetaris` runs all five example questions end to end on Zetaris Lightning with live Nemotron (cache off), then checks every answer. Run on Oct 22 2026, 21:37 KST.

| Question | Time | Receipts | Answer by | Citations valid | Numbers grounded | Baseline = raw recompute |
|---|---|---|---|---|---|---|
| Store revenue, 2001 Q4 → 2002 Q4 | 69 s | 9 | Nemotron | 7/7 | 8/8 | ✅ exact (TPCDS_DB.store_sales) |
| Web revenue in TX, 2000 → 2001 | 106 s | 8 | template (Nemotron timed out) | 7/7 | n/a | |
| Catalog Electronics, 2001 Q3 → 2002 Q3 | 50 s | 7 | Nemotron | 6/6 | 5/5 | |
| Yellow taxi trips, 2024-10 → 2025-02 | 61 s | 7 | template (Nemotron cited no receipts) | 7/7 | n/a | ✅ exact (NY_TAXI.yellow_taxi) |
| Manhattan taxi revenue, 2024-05 → 2025-01 | 57 s | 7 | Nemotron | 6/6 | 6/6 | |

- **33/33 citations point to receipts that exist; 19/19 numbers in Nemotron's answers appear in the SQL results.** Any answer that fails either check is replaced by the deterministic template. That happened twice in this run (a free-tier timeout and an answer without citations), so the user still got a correct, cited answer.
- **The semantic layer is exact.** The baselines computed on WhyLedger's materialized cubes match an independent query on the raw source tables to the cent and to the trip (402,333,788.11 → 407,500,391.95; 3,833,780 → 3,577,514 trips). The raw scans took 22 s and 163 s; the cube queries take about a second each.
- **Wall time** is mostly Nemotron on OpenRouter's free tier (the narration budget is 75 s). Without the model, the full SQL investigation (baseline, every hypothesis in parallel and the drill-down, all on Zetaris) took **1.8 s** for the retail question and **0.7 s** for the taxi question.
- In the Manhattan case nothing passed the "supported" bar, and the narration says so ("broad-based with no one cause dominating") instead of inventing a driver.
