# 0053 — the status single door

**Written and tested; not applied.**

Only `publish_packet` and `unpublish_packet` (0052) may change
`packets.status`. A BEFORE INSERT OR UPDATE OF status trigger refuses any status
change — either direction — and any insert that is not a draft, unless the
transaction-local setting `app.publication_authorized_packet` names that exact
Sendset. The two functions set it immediately before their status UPDATE and
clear it immediately after. Refusals: `PT403`, DETAIL `status_single_door`.

Not touched: inserting drafts (every creation path, including
`create_organize_run`), updates that leave status unchanged, deletes, and every
other column. No backfill, no reader change, no status ⇔ publication invariant.

Preconditions refuse to install if either door is missing or does not authorise
itself, or if any other installed function writes a status (and name it).
Production was checked read-only first: only the two doors update a status, and
`create_organize_run` inserts a draft.

## Verification

- In the migration: catalog assertions (invoker, empty search_path, owner-only;
  enabled BEFORE INSERT OR UPDATE OF status row trigger; no row changed) and a
  rolled-back proof (insert as published refused; direct update refused in both
  directions; authorisation for another Sendset refused; both doors work;
  ordinary updates and deletes unaffected).
- `node scripts/pg-harness/test-0053.mjs` — 38 checks on real PostgreSQL 17:
  direct writes (14, including service_role and authorisation not outliving
  publish_packet), other paths (7: organize-run creation, block conversion and
  publish, runs, deletes, account deletion, blocking import), two-connection
  isolation of the authorisation (1), grants/rerun/rollback/precondition (9),
  mutants (7).
- `ownership-route.test`: the trigger's shape, the id binding in both branches,
  and each door's authorise → write → clear order.

## Rollback

`supabase/rollbacks/0053_packet_status_single_door_down.sql` drops the trigger
and function; touches no row; safe at any time. 0052's rollback refuses while
this door exists.
