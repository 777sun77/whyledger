# WhyLedger

**Ask why a business number moved. Get the answer, what was ruled out, and a receipt for every claim.**

Open Agent Hackathon 2026 · Track 02 — *The Agent That Can Explain Why*

A store-operations manager sees "Q4 store revenue −2.1% vs last year" and has to explain it by Monday. The data that explains it lives in different places: stores, items, promotions, customer demographics, returns, and two other sales channels. WhyLedger:

1. **Frames** the question (metric, periods, scope).
2. **Recalls** what earlier investigations and analyst feedback said (Meterless **H-MEM**).
3. **Establishes the fact** to explain with one query (receipt `ev-1`).
4. **Plans** which hypotheses to test first (NVIDIA **Nemotron**).
5. **Tests every hypothesis with a real query through Zetaris** — region, category, promotion, demographics, price vs volume, channel shift, returns. The numbers come from SQL, never from the model.
6. **Scores** each one: supported / partial / ruled out, and how much of the change it accounts for.
7. **Writes the evidence graph** (Meterless **World Model**): question → hypothesis → driver segments, every fact carrying provenance (backend, query checksum).
8. **Answers** in plain language; the narration must cite receipts or it is replaced by the deterministic template.
9. **Remembers** the conclusion so the next question builds on it.

## Run it

```bash
npm install
npm run setup          # vendors Meterless H-MEM + World Model (Apache-2.0) into vendor/
cp .env.example .env.local   # add Zetaris + (optional) NVIDIA_API_KEY
npm run investigate -- "Why did store revenue change from 2001 Q4 to 2002 Q4?"
npm run serve          # http://localhost:8787
```

No Zetaris instance yet? `npm run seed:local` builds the same TPC-DS schema in DuckDB for development. Every receipt is labeled `local-dev (… not Zetaris)` so a dev run is never presented as the sponsor demo.

No LLM key? The agent runs fully offline with deterministic planning and narration (labeled `offline`).

## Sponsor technology

| Sponsor | Where | Why it matters |
|---|---|---|
| **Zetaris Lightning** | `src/data/zetaris.ts` — every investigation query runs through the Zetaris query engine over the TPCDS_DB sample (store, web and catalog sales, returns, items, promotions, demographics) | One SQL surface over fragmented sources, no data movement; the agent can investigate across channels without an ETL step |
| **Meterless H-MEM** | `src/memory/meterless.ts`, recall + remember + feedback in `src/agent/investigator.ts` | Investigations compound; recall is explainable (trace) and auditable (trust ledger) |
| **Meterless World Model** | `writeWorld()` in `src/agent/investigator.ts` | Event-sourced evidence graph, provenance required on every write — the "why" is inspectable after the fact |
| **NVIDIA Nemotron** | `src/llm/provider.ts` (NIM `integrate.api.nvidia.com`, or OpenRouter `:free`, or a local Meterless Runtime) | Framing, planning and cited narration |
| **Cursor** | Development environment (see `docs/CURSOR.md`) | |

## Safety

- The agent can only read: `assertReadOnly()` rejects anything but a single SELECT/WITH/SHOW/DESCRIBE.
- Credentials live in `.env.local` (gitignored), server-side only.

## Pre-existing components (declared)

Meterless H-MEM and World Model reference implementations (Apache-2.0, vendored by `npm run setup`), DuckDB. All WhyLedger code was written during the build window (from 22 Oct 2026 00:00 UTC).

## License

Apache-2.0
