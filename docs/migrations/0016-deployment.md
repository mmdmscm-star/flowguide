# Migration 0016 — deployment runbook

Applied **by hand** in the Supabase SQL Editor. Nothing in CI applies it.

File: `supabase/migrations/0016_ownership_resolution.sql`

It adds `item_media_decisions` and three owner-scoped, draft-only RPCs —
`move_item_photos`, `set_item_media_decision`, `clear_item_media_decision` — all
revoked from `anon` and `authenticated`, matching 0012's posture. It adds no
column to an existing table, changes no existing function, and backfills nothing.

---

## 0. Deploy order does not matter

This is worth stating plainly, because the first draft of this feature made it
matter a great deal.

The publish gate lives in application code and consults `item_media_decisions`
to know which findings the professional already resolved. If that table is
missing, the naive reading — "no rows, therefore no Keeps" — blocks every
affected packet, and the one action that clears the block writes to the table
that is not there. Code shipped ahead of the migration would have produced
unpublishable packets with no way out.

`loadPacketOwnership` treats a failed decisions read as *overrides unknown* and
withdraws blocking for the whole packet, rather than treating it as *no
overrides exist*. So:

| Order | Behaviour |
|---|---|
| Code first, migration later | Gate is inert. Findings computed and logged, nothing blocks. |
| Migration first, code later | Table and RPCs sit unused. Nothing calls them. |
| Both present | Gate is live. |

Either order is safe. The gate switches on when both halves are present.
`src/lib/ownership-service.test.mts` pins this — see *"an unreadable decisions
table withdraws the block instead of discarding every Keep"*.

---

## 1. Preflight

Run these **before** applying. Each says what result means "safe to proceed".

```sql
-- (a) Nothing is mid-flight. move_item_photos refuses to run during an import,
--     and applying while a run finalizes risks contending with it.
--     SAFE = zero rows.
select id, packet_id, status, created_at
from public.ingestion_runs
where status in ('active','finalizing','needs_review');

-- (b) The migration has not already been applied.
--     SAFE = zero rows.
select 'table' as kind, 'item_media_decisions' as name
from information_schema.tables
where table_schema = 'public' and table_name = 'item_media_decisions'
union all
select 'function', p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision');

-- (c) items and item_photos are the shapes the RPCs assume.
--     SAFE = item_photos has (id, item_id, url, sort_order, created_at).
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'item_photos'
order by ordinal_position;
```

---

## 2. Apply

Paste `supabase/migrations/0016_ownership_resolution.sql` whole. It runs inside
`begin; … commit;` with `lock_timeout = 3s` and `statement_timeout = 60s`, and
ends with a `do $verify$` block that raises rather than committing if any of
these is false:

- `item_media_decisions` exists;
- none of the three functions is executable by `anon` or `authenticated`;
- `anon`/`authenticated` hold no table privileges on `item_media_decisions`.

Success prints:

```
NOTICE:  0016: table created, three RPCs installed, none reachable by anon
```

If it raises, **nothing is applied** — the transaction rolls back whole. Fix the
cause and re-run; the migration is idempotent (`create table if not exists`,
`create or replace function`).

The final `notify pgrst, 'reload schema'` refreshes PostgREST's schema cache.

---

## 3. Verify after applying

```sql
-- (a) The three RPCs exist and are SECURITY DEFINER with a pinned search_path.
--     SAFE = three rows, prosecdef = true, proconfig = {search_path=}
select proname, prosecdef, proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision');

-- (b) Not reachable as a PostgREST endpoint.
--     SAFE = zero rows.
select p.proname, r.rolname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('anon'),('authenticated')) as r(rolname)
where n.nspname = 'public'
  and p.proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision')
  and has_function_privilege(r.rolname, p.oid, 'execute');

-- (c) RLS on, and no policy — the table is reachable only through the service
--     role and the SECURITY DEFINER functions.
--     SAFE = relrowsecurity = true, zero policies.
select c.relrowsecurity, (select count(*) from pg_policies
                          where schemaname='public' and tablename='item_media_decisions') as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname='public' and c.relname='item_media_decisions';
```

Then, in the app: open a packet that reports a blocking finding, press
**Publish**, and confirm the panel offers *Move to …* and *Keep here*. Pressing
either must make that row disappear on the response, not on a page reload —
the response carries a fresh recompute.

---

## 4. Rollback

Lossless **only if no decision has been recorded yet**, which is the case
immediately after applying. `item_media_decisions` is the sole store of a
professional's intentional Keeps; dropping it after they exist destroys
information that lives nowhere else, and every Keep silently becomes an
unresolved finding again.

Capture anything recorded before dropping:

```sql
select item_id, url, created_at from public.item_media_decisions order by created_at;
```

Then:

```sql
begin;
drop function if exists public.clear_item_media_decision(uuid, uuid, text);
drop function if exists public.set_item_media_decision(uuid, uuid, text);
drop function if exists public.move_item_photos(uuid, uuid, uuid, text, uuid);
drop table if exists public.item_media_decisions;
commit;
notify pgrst, 'reload schema';
```

0016 alters no existing table, column or function, so there is nothing else to
restore. With the table gone the application gate goes inert again (§0) rather
than blocking, so a rollback cannot strand a packet.

**Photos already moved are not rolled back**, and should not be: `move_item_photos`
put them on the item the source names, which is where they belonged. Dropping
the function does not un-move them, and the recompute that reports them clean
will keep doing so.

---

## 5. What this does not do

- **No backfill.** Packets imported before 0014 carry no provenance, recompute
  declines for them, and the gate lets them publish. That is deliberate —
  blocking there would trap every historical packet behind a check it can never
  satisfy. Declines are logged, so "checked and clean" stays distinguishable
  from "could not be checked".
- **No hard database guard.** `block_publish_during_ingest` (0012) remains the
  trigger-level guard for run *status* and is untouched. Ownership blocking is
  application-layer, because the check needs `detectSourceRecords` and
  `segmentHash`, which are TypeScript. `src/lib/ownership-route.test.mts` pins
  that the publish route is the only writer of `status='published'` in server
  code and that no RPC assigns it, so there is a single door for the gate to
  stand in.
