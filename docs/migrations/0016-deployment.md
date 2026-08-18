# Migration 0016 — application package

Applied **by hand** in the Supabase SQL Editor. Nothing in CI applies it.
Nothing in this document has been run against Supabase.

File: `supabase/migrations/0016_ownership_resolution.sql`

---

## 1. What it installs

One table and three functions. It adds no column to an existing table, alters
no existing function, drops nothing, and backfills nothing.

### `item_media_decisions`

```sql
create table if not exists public.item_media_decisions (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.items(id) on delete cascade,
  url        text not null,
  created_at timestamptz not null default now(),
  unique (item_id, url)
);
```

**The row's existence means "kept".** There is no `decision` column and no
`source_hash`:

- A decision is only ever consulted after recompute has already proven the
  slice hashes to the run's `source_hash`, and `items.origin_run_id` fixes which
  run that is — so a stored hash could never discriminate, but could silently
  lose a Keep and make a resolved finding reappear with no way to see why.
- `item_id` is the only stable handle here. `item_photos` rows are deleted and
  reinserted with fresh uuids on every save (0011), so a decision cannot key on
  a photo row.
- RLS is **enabled with no policy**, and all privileges are revoked from `anon`
  and `authenticated`. It is reachable only through the service role and the
  `SECURITY DEFINER` functions below.
- **No `content_rev` trigger, deliberately.** A decision is not packet content,
  and bumping the revision would falsely trip an in-flight run's
  `baseline_content_rev` assertion in `finalize_ingestion_run`.

### RPC semantics

All three are `SECURITY DEFINER` with `set search_path = ''`, and all three are
revoked from `public`, `anon` and `authenticated` — matching 0012's posture.

**`move_item_photos(p_owner, p_from_item, p_to_item, p_url, p_packet_id default null) returns int`**

Asserts, in order: the two items differ; the url is http(s); both items exist
and belong to the **same packet**; that packet matches `p_packet_id` when given;
the caller owns it; it is still a **draft**; and no import is `active` or
`finalizing` on it. Then:

- **If the destination already holds that url**, the misplaced rows are
  **deleted** rather than reassigned. `item_photos` has no unique
  `(item_id, url)`, so reassigning would hand the destination the same photo
  twice. Move means "this belongs there, not here"; when it is already there,
  honouring that means removing the misplaced copies.
- **Otherwise** the rows are reassigned and **appended** to the destination —
  `max(sort_order) + 1` upward, not carrying `sort_order` across. Readers order
  by `sort_order` with no tie-break, so a carried value would collide and make
  the carousel order, and the hero photo, nondeterministic.
- Raises if nothing matched, so a no-op cannot look like a success.
- Deletes any decision recorded against the **old** placement, which would
  otherwise silently suppress a later finding about the same url returning.

It reads `ingestion_runs` with a plain read, **not** `for update`:
`finalize_ingestion_run` locks `ingestion_runs` *before* `packets`, so acquiring
them in the opposite order here would be a deadlock class.

**`set_item_media_decision(p_owner, p_item_id, p_url) returns void`**

Owner-scoped, draft-only, and requires the photo to **actually be on the item** —
so a Keep cannot pre-suppress a finding for a placement that does not exist.
Idempotent (`on conflict do nothing`).

**`clear_item_media_decision(p_owner, p_item_id, p_url) returns void`**

The undo. Owner-scoped. Deliberately **not** draft-gated and not conditioned on
a current finding: while a Keep stands its finding is suppressed, so requiring
one would make every Keep permanent.

### Self-verification

The migration ends with a `do $verify$` block that raises — rolling the whole
transaction back — unless the table exists, none of the three functions is
executable by `anon`/`authenticated`, and those roles hold no table privileges
on `item_media_decisions`.

---

## 2. Publish-gate behaviour

The gate is in `src/app/api/packets/[id]/publish/route.ts`, recomputed per
request, immediately before the single `UPDATE` that publishes. It cannot live
in a trigger: the check needs `detectSourceRecords` and `segmentHash`, which are
TypeScript.

**Four outcomes, and they are not interchangeable:**

| Outcome | Meaning | Response |
|---|---|---|
| clean | checked, nothing wrong | **200**, publishes |
| **declined** | the check RAN; ownership is not establishable | **200**, publishes, `console.warn` |
| **blocking** | the check ran; photos sit where the source does not put them | **409** `ownership_unresolved` + findings |
| **unavailable** | the check **DID NOT RUN** | **503** `ownership_unavailable`, `retryable: true`, **no findings** |

The invariant behind the split:

> A legitimate inability to prove ownership may be nonblocking.
> A technical failure to perform the check must never masquerade as a
> successful clean check.

**Declines are answers.** No provenance (pre-0014), a voided offset base, a
replaced source, prose with no record structure, incomplete correspondence, a
run row that no longer exists. Blocking on these would trap every historical
packet behind a check it can never satisfy. They are logged so that "checked and
clean" stays distinguishable from "could not be checked".

**Unavailable is not an answer.** A failed query, a missing table, a timeout, or
a **throw** inside the check. It publishes nothing, and it accuses nobody — it
returns no findings, because accusing on evidence that was never read is the
same error pointed the other way. It is retryable and says so.

### Operational-error behaviour, by source

Any of these reads failing yields 503, naming the source in the log:
`packets`, `sections`, `items`, `item_photos`, `ingestion_runs`,
`ingestion_chunks`, `item_media_decisions`.

### The decisions read is deferred, and why that is not a loophole

A decision can only ever **suppress** a blocking finding. Recompute therefore
runs **first**, and `item_media_decisions` is read **only if a blocking finding
actually exists**. The read is load-bearing only when there is something for it
to bear.

The consequence, which is also the deployment property:

| Packet | Before 0016 is applied |
|---|---|
| nothing wrong | never touches the table — **publishes normally** |
| a real blocking finding | **503, retryable** — refuses to resolve itself against data it could not read |

So the pre-apply blast radius is exactly the packets that should be blocked
anyway. This is the rule applied precisely, not relaxed: no packet is ever
published on the strength of a check that did not run.

**Recommended order: apply 0016 first, then deploy.** The reverse is safe but
leaves packets with genuine findings unpublishable-but-retryable until it lands.

---

## 3. No bypass

Asserted in `src/lib/ownership-route.test.mts`, not claimed by hand:

- **`status='published'` is written in exactly one place in server code** —
  `src/app/api/packets/[id]/publish/route.ts`. (The legacy editor sets the same
  string in React state after a successful response; that is local echo, and the
  test is scoped to `src/app/api/` and `src/lib/` for that reason.)
- **No migration assigns `status = 'published'`.** Every `update … packets`
  statement across `supabase/migrations/*.sql` is checked. `0012`'s
  `block_publish_during_ingest` *reads* `new.status = 'published'` to decide
  whether to raise — that is the trigger doing its job, not a second door.
- **The gate precedes the write**, and the ownership call is inside `try/catch`
  whose handler returns 503 rather than falling through.
- **The three RPCs have exactly one call site** —
  `src/app/api/packets/[id]/ownership/route.ts` — and are unreachable as
  PostgREST endpoints.
- **A Move destination is re-derived and compared, never taken from the request
  body.** The RPC's own checks (owner, draft, same packet) are all satisfied by
  a stray request, so trusting the body would let one file any photo onto any
  item in the packet under the banner of fixing ownership.

`block_publish_during_ingest` (0012) remains the trigger-level hard guard for
run *status* and is untouched.

---

## 4. Integrity check

Verify the file you are about to paste is the file that was reviewed.

```bash
shasum -a 256 supabase/migrations/0016_ownership_resolution.sql
wc -l supabase/migrations/0016_ownership_resolution.sql
head -1 supabase/migrations/0016_ownership_resolution.sql
tail -1 supabase/migrations/0016_ownership_resolution.sql
```

| Property | Expected |
|---|---|
| sha256 | `928a7c028014f24c61ea177fa0f73a69ddd3ebe2d950e9698fcf5f821660657e` |
| lines | `273` |
| bytes | `13034` |
| first line | `-- 0016 — ownership resolution: atomic Move, intentional Keep.` |
| last line | `notify pgrst, 'reload schema';` |

Structural census — the file contains exactly:

- `begin;` at line 39, `commit;` at line 271, `notify pgrst` at line 273
- 1 × `create table if not exists`, 1 × `create index if not exists`
- 3 × `create or replace function`
- 7 × `revoke` (1 table, 6 function)
- 1 × `do $verify$` block

**If the hash does not match, stop.** Do not reconcile by eye.

---

## 5. Preflight

Run **before** applying. Each says what result means "safe to proceed".

```sql
-- (a) Nothing is mid-flight. move_item_photos refuses to run during an import,
--     and applying while a run finalizes risks contending with it.
--     SAFE = zero rows.
select id, packet_id, status, created_at
from public.ingestion_runs
where status in ('active','finalizing','needs_review');

-- (b) Not already applied.
--     SAFE = zero rows.
select 'table' as kind, table_name as name
from information_schema.tables
where table_schema = 'public' and table_name = 'item_media_decisions'
union all
select 'function', p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision');

-- (c) The shapes the RPCs assume.
--     SAFE = item_photos has (id, item_id, url, sort_order, created_at)
--            and items has (id, section_id).
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name in ('item_photos','items')
order by table_name, ordinal_position;

-- (d) No name collision with anything already present.
--     SAFE = zero rows.
select proname, pronargs from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and proname like '%item_media%';
```

Also confirm the app is running the code that matches this migration — the gate
and the three RPC call sites ship together.

---

## 6. Apply

Paste the file whole. It runs inside `begin; … commit;` with
`lock_timeout = '3s'` and `statement_timeout = '60s'`.

Success prints:

```
NOTICE:  0016: table created, three RPCs installed, none reachable by anon
```

If it raises, **nothing is applied** — the transaction rolls back whole. Fix the
cause and re-run; the migration is idempotent.

---

## 7. Post-apply verification

```sql
-- (a) Three functions, SECURITY DEFINER, pinned search_path.
--     SAFE = 3 rows, prosecdef = t, proconfig = {search_path=}
select proname, prosecdef, proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision');

-- (b) Not reachable as PostgREST endpoints.
--     SAFE = zero rows.
select p.proname, r.rolname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('anon'),('authenticated')) as r(rolname)
where n.nspname = 'public'
  and p.proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision')
  and has_function_privilege(r.rolname, p.oid, 'execute');

-- (c) RLS on, no policy, no anon/authenticated table grants.
--     SAFE = relrowsecurity = t, policies = 0, grants = 0.
select c.relrowsecurity,
       (select count(*) from pg_policies
         where schemaname='public' and tablename='item_media_decisions') as policies,
       (select count(*) from information_schema.role_table_grants
         where table_schema='public' and table_name='item_media_decisions'
           and grantee in ('anon','authenticated')) as grants
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname='public' and c.relname='item_media_decisions';

-- (d) The unique key that makes a Keep idempotent.
--     SAFE = one unique index on (item_id, url).
select indexname, indexdef from pg_indexes
where schemaname='public' and tablename='item_media_decisions';

-- (e) The cascade, so a deleted item cannot strand a decision.
--     SAFE = delete_rule = CASCADE.
select rc.delete_rule
from information_schema.referential_constraints rc
join information_schema.table_constraints tc on tc.constraint_name = rc.constraint_name
where tc.table_schema='public' and tc.table_name='item_media_decisions';
```

Then run the E2E proof (§9).

---

## 8. Rollback

**Deterministic, and lossless only while the table is empty** — which is the
case immediately after applying. `item_media_decisions` is the sole store of a
professional's deliberate Keeps; dropping it once rows exist destroys
information that lives nowhere else, and every Keep silently becomes an
unresolved finding again.

Capture first, unconditionally:

```sql
select item_id, url, created_at
from public.item_media_decisions
order by created_at;
```

Then:

```sql
begin;
set local lock_timeout = '3s';
drop function if exists public.clear_item_media_decision(uuid, uuid, text);
drop function if exists public.set_item_media_decision(uuid, uuid, text);
drop function if exists public.move_item_photos(uuid, uuid, uuid, text, uuid);
drop table if exists public.item_media_decisions;
commit;
notify pgrst, 'reload schema';
```

Confirm:

```sql
-- SAFE = zero rows.
select 'table' as kind, table_name as name from information_schema.tables
where table_schema='public' and table_name='item_media_decisions'
union all
select 'function', proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision');
```

0016 alters no existing table, column or function, so there is nothing else to
restore. **After rollback the gate does not go quiet** — a packet with a genuine
blocking finding returns 503 rather than publishing, because that is the trust
policy and not a deployment accommodation. Clean packets are unaffected.

**Photos already moved are not rolled back, and should not be.**
`move_item_photos` put them on the item the source names, which is where they
belonged; dropping the function does not un-move them, and the recompute that
reports them clean will keep doing so.

---

## 9. E2E proof — disposable

`scripts/ingestion-runtime/verify-ownership-gate.mts`

```bash
npx tsx scripts/ingestion-runtime/verify-ownership-gate.mts
```

Real routes, real database, **no model credits** — the misplacement is
constructed directly so it is exact and repeatable. One disposable user, removed
in a `finally` block that reports whether anything was left behind.

**Run it twice.** It detects whether 0016 is applied and asserts the behaviour
correct for that state.

**Before applying** — proves the trust policy and the bounded blast radius:

- a clean packet publishes normally, and never queries the missing table;
- a packet with a blocking finding returns **503 `ownership_unavailable`**,
  `retryable: true`, with **no findings**;
- that packet is still a `draft` afterwards.

**After applying** — the full lifecycle:

1. publish is **blocked** (409), and the block names the photo;
2. the finding offers **Move and Keep**, and Move proposes the item the source
   names;
3. a destination the source did **not** name is **refused**
   (`destination_mismatch`);
4. **Keep** is accepted, clears the block, and is **discoverable** afterwards
   with a human-readable item title;
5. publish **succeeds**;
6. the Keep survives a **fresh recompute** — it is not session state;
7. the Keep is **undone**, the finding **comes back**, and publishing blocks
   again;
8. on a second packet, **Move** clears the block **without** recording a
   decision, and the photo really is on the item the source names;
9. that packet publishes;
10. cleanup, verified.

---

## 10. What this does not do

- **No backfill.** Packets imported before 0014 carry no provenance, recompute
  declines, and the gate lets them publish. Blocking there would trap every
  historical packet behind a check it can never satisfy.
- **No durable audit of decisions beyond the table itself.** There is no history
  of who kept what and when, beyond `created_at`.
- **No hard database guard for ownership.** It is application-layer by
  necessity, standing in the single door proven in §3.
