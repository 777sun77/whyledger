# How Cursor was used

WhyLedger was developed in Cursor during the hackathon window (Oct 22–27, 2026), with an AI-agent-first workflow:

- **Cursor agents wrote most of the code.** One human (team Charlie Agents) set the direction: track choice, product decisions and demo questions. Cursor-based coding agents researched the rules and sponsor docs, scaffolded the TypeScript project, and wrote the Zetaris SQL semantic layer (`zetaris/*.sql`), the investigator loop, the scoring logic, the Meterless integration and the web UI.
- **Agents ran the work as well as writing it.** The agents brought up the Zetaris developer edition in Docker, ran every query against it, and fixed problems found against real data. Examples: Zetaris's `headers/data` response shape; TPC-DS sample stores all sitting in one state, so geography moved to shopper state; the taxi-zone table holding three copies of each zone, which triple-counted trips; slow federated scans, fixed by materialized parquet cubes. Tests (`npm test`) and `tsc` were run after every change.
- **The human reviews and approves.** Everything was kept local until it was reviewed. Pushes and the submission are done by the team member.

Generated code is permitted by the hackathon rules. Pre-existing components (Meterless reference engines, TPC-DS and NYC TLC sample data, DuckDB) are listed in `metadata.json`.

**Evaluation was agent-built too.** After the first submission, a coding agent reviewed the entry against the judging rubric. It then wrote the planted-cause evaluation (`scripts/eval-planted.ts`) and the live Zetaris faithfulness evaluation (`scripts/eval-zetaris.ts`). It also added a numeric grounding guard (`src/agent/grounding.ts`). After a live run showed the narration overstating a *partial* finding, it tightened the narration prompt to respect verdicts. Results are in `eval/README.md`.
