# How Cursor was used

WhyLedger was developed in Cursor during the hackathon window (Oct 22–27, 2026), with an AI-agent-first workflow:

- **Cursor agents wrote most of the code.** One human (team Charlie Agents) set the direction: track choice, product decisions and demo questions. Cursor-based coding agents researched the rules and sponsor docs, scaffolded the TypeScript project, and wrote the Zetaris SQL semantic layer (`zetaris/*.sql`), the investigator loop, the scoring logic, the Meterless integration and the web UI.
- **Agents ran the work as well as writing it.** The agents brought up the Zetaris developer edition in Docker, ran every query against it, and fixed problems found against real data. Examples: Zetaris's `headers/data` response shape; TPC-DS sample stores all sitting in one state, so geography moved to shopper state; the taxi-zone table holding three copies of each zone, which triple-counted trips; slow federated scans, fixed by materialized parquet cubes. Tests (`npm test`) and `tsc` were run after every change.
- **The human reviews and approves.** Everything was kept local until it was reviewed. Pushes and the submission are done by the team member.

Generated code is permitted by the hackathon rules. Pre-existing components (Meterless reference engines, TPC-DS and NYC TLC sample data, DuckDB) are listed in `metadata.json`.
