# Ingestion runtime verification (migration 0012)

`src/lib/ingestion-rpc.test.mts` proves the ingestion RPC contract **statically**,
from the SQL text — it never connects to a database. This directory is the live
counterpart it defers to: it exercises the applied migration against real
Postgres and proves the guards actually fire.

Run it after applying `0012_ingestion_runs.sql` to an environment, and any time
the ingestion SQL changes.

## Safety model

These scripts write to whatever database `.env.local` points at, so they refuse
to start without an explicit opt-in:

```
FLOWGUIDE_RT_CONFIRM=1 npx tsx scripts/ingestion-runtime/<script>.mts
```

Containment is structural, not conventional:

- every row the suite creates hangs off a **disposable user** whose email matches
  `flowguide-rt-<pid>[-other]@disposable.invalid`;
- cleanup deletes only those users and lets the existing FK cascade remove the
  rest, so no genuine row is ever the target of a delete;
- `cleanup.mts` aborts if any matched email falls outside that pattern;
- restoration is proven by **row-identity diff** against the baseline, not by row
  counts alone (a delete+insert pair would keep counts equal).

## Order

1. `verify.mts` — **read-only**. Confirms tables, columns, exact RPC signatures,
   and that `anon` cannot execute any ingestion RPC. Writes `baseline.json`
   (census + per-table id fingerprint). Run this first; it writes no rows.
2. `runtime.mts` — the suite. Requires `baseline.json`.
3. `cleanup.mts` — removes the disposable users and proves the baseline is
   restored exactly.

`baseline.json` and `uid.txt` are run artifacts and are not committed.

## What the suite covers

| Section | Proves |
|---|---|
| 1 | append happy path; result applied; source text cleared on finalize |
| 2 | **late writes after a run ends are rejected** (the `mark_chunk_failed` fix), incl. a canary proving no model error text survives a discard |
| 3 | append/section_append are legacy-only; section_append works end to end into the target section |
| 4 | claim atomicity under real concurrency, lease recovery, attempt generations, hash drift |
| 5 | cross-owner isolation on every RPC |
| 6 | publish blocked mid-run; `content_rev` conflict refuses finalize with no partial write |
| 7 | organize idempotency by `request_key`; discard deletes an untouched draft |
| 8 | discard idempotency on a packet with pre-existing content |
| 9 | large multi-chunk source end to end, with per-chunk timing against the 60s serverless ceiling |

## Notes for future readers

- `create_organize_run` returns **snake_case** keys (`run_id`, `packet_id`); the
  organize route maps them to camelCase for its own JSON response. Asserting on
  camelCase here yields vacuous `undefined === undefined` passes.
- Result shapes are entry-point specific and finalize coalesces a missing key to
  `[]`: `organize`/`append` read `result->'sections'`, `section_append` reads
  `result->'items'`. Supplying the wrong shape finalizes to a silent no-op.
- Packets must be created in legacy mode (DB trigger); blocks mode is reachable
  only via `convert_packet_to_blocks`, and sections are frozen afterwards.
