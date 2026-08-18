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

## 3. Privilege boundary

0015 existed because access was reachable that nobody had granted on purpose. A
new table plus three `SECURITY DEFINER` functions is exactly the shape that
reintroduces it, so the boundary is stated in the migration and asserted twice —
by the migration's own verify block at apply time, and by
`src/lib/ownership-route.test.mts` at edit time.

### What the migration does to the ACL

```sql
alter table public.item_media_decisions enable row level security;
revoke all on table public.item_media_decisions from public;
revoke all on table public.item_media_decisions from anon, authenticated;
grant select, insert, delete on table public.item_media_decisions to service_role;

revoke all on function public.move_item_photos(uuid, uuid, uuid, text, uuid) from public;
revoke all on function public.move_item_photos(uuid, uuid, uuid, text, uuid) from anon, authenticated;
revoke all on function public.set_item_media_decision(uuid, uuid, text) from public;
revoke all on function public.set_item_media_decision(uuid, uuid, text) from anon, authenticated;
revoke all on function public.clear_item_media_decision(uuid, uuid, text) from public;
revoke all on function public.clear_item_media_decision(uuid, uuid, text) from anon, authenticated;
```

Three things here are load-bearing and were **not** in the first draft:

1. **`revoke … from public` on the table.** A privilege held by PUBLIC is held by
   every role and shows up as a grant to neither `anon` nor `authenticated`.
   Revoking only from those two leaves it open.
2. **Functions default to `EXECUTE` for PUBLIC.** Omitting their revoke does not
   leave them locked down; it leaves them world-callable. A NULL `proacl` is the
   dangerous state, not the safe one.
3. **An explicit grant to `service_role`.** `bypassrls` skips *policies*, not
   *grants*. Relying on `ALTER DEFAULT PRIVILEGES` means the only legitimate
   caller works or does not depending on how the project was configured — and
   under the trust policy in §2 that failure is a permanent 503, not a loud
   error.

### How the verify block tests it

**By effect, not by grant rows.** `has_table_privilege` / `has_function_privilege`
answer "can this role actually do this", which accounts for privileges held
through PUBLIC and through role inheritance. The first draft searched
`information_schema.role_table_grants` for `grantee in ('anon','authenticated')`
— which would have passed while both roles held everything via PUBLIC. That was
the exact class of miss 0015 was about.

**PUBLIC is checked through the ACL, not through `has_*_privilege`.** PUBLIC is a
pseudo-role with no `pg_roles` entry, so `has_function_privilege('public', …)`
raises rather than returning false. It is checked as grantee OID `0` via
`aclexplode`, with a NULL `proacl` treated as a failure.

The block raises — rolling the whole transaction back — unless **all** of:

- the table exists, and all three functions exist (exactly 3);
- every function is `SECURITY DEFINER` **and** pins `search_path`;
- neither `anon` nor `authenticated` can `EXECUTE` any of the three;
- PUBLIC holds no `EXECUTE` on any of the three, and no ACL is NULL;
- neither `anon` nor `authenticated` holds `SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER` on the table;
- PUBLIC holds nothing on the table;
- RLS is enabled and there are **no policies**;
- `service_role` **can** `SELECT`, `INSERT` and `DELETE` — a lockdown that also
  locks out the intended caller is a 503 discovered in production, not a success.

### The SECURITY DEFINER functions, checked explicitly

| | `move_item_photos` | `set_item_media_decision` | `clear_item_media_decision` |
|---|---|---|---|
| `search_path` pinned to `''` | yes | yes | yes |
| fully-qualified `public.` refs | yes | yes | yes |
| caller owns the packet | yes, under `for update` | yes | yes |
| items belong to one packet | yes | n/a (single item) | n/a |
| optional `p_packet_id` cross-check | yes | no | no |
| draft-only | yes | yes | **no — deliberate** |
| refuses during an import | yes | no | no |

Two of those cells are deliberate and worth stating rather than discovering:

- **`clear_item_media_decision` is not draft-gated.** It is the undo. Gating it
  on draft would make a Keep irreversible the moment a packet is published,
  which is the trap the whole feature exists to remove. It still verifies
  ownership.
- **Only `move_item_photos` refuses during an import,** because only it mutates
  packet content and would break an in-flight run's `baseline_content_rev`
  assertion. It reads `ingestion_runs` **without** `for update`, because
  `finalize_ingestion_run` locks `ingestion_runs` before `packets` and the
  opposite order here would be a deadlock class.

`p_owner` is supplied by the server from the session, never by the browser. That
is safe **because** the functions are unreachable except through the service
role — which is what the checks above exist to guarantee.

### The route is server-side, and the browser cannot reach these RPCs

Verified across `src/`, not assumed:

- every `.rpc(` call site lives under `src/app/api/` or `src/lib/` — no client
  component calls one;
- **no file marked `"use client"` imports supabase at all**;
- the panel talks to `/api/packets/[id]/ownership`, a server route, which uses
  `createServerClient()` (service-role key, server-only env var);
- `createPublicClient()` — the anon-key client — is imported once in
  `src/lib/queries.ts` and **never called**, so the anon key has no call path in
  application code.

---

## 4. No bypass

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

## 5. Integrity check

Verify the file you are about to paste is the file that was reviewed.

```bash
shasum -a 256 supabase/migrations/0016_ownership_resolution.sql
wc -l supabase/migrations/0016_ownership_resolution.sql
head -1 supabase/migrations/0016_ownership_resolution.sql
tail -1 supabase/migrations/0016_ownership_resolution.sql
```

| Property | Expected |
|---|---|
| sha256 | `0fca20806c6c3fe4736bd89056430eeda839b30e3c89158e1e6b6cc46213ef29` |
| lines | `375` |
| bytes | `18765` |
| first line | `-- 0016 — ownership resolution: atomic Move, intentional Keep.` |
| last line | `notify pgrst, 'reload schema';` |

Structural census — the file contains exactly:

- `begin;` at line 39, `commit;` at line 373, `notify pgrst` at line 375
- 1 × `create table if not exists`, 1 × `create index if not exists`
- 3 × `create or replace function`
- 8 × `revoke` (2 table, 6 function)
- 1 × `grant` (service_role only)
- 1 × `do $verify$` block

**If the hash does not match, stop.** Do not reconcile by eye.

---

## 6. Preflight

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

-- (c) Every column the three RPCs actually reference. They touch FIVE tables,
--     not two: items and sections to resolve an item to its packet, packets for
--     the owner and draft checks, ingestion_runs for the in-flight refusal, and
--     item_photos for the move itself.
--     Expected-minus-actual, so SAFE = zero rows.
select e.tbl, e.col
from (values
  ('items','id'),            ('items','section_id'),
  ('sections','id'),         ('sections','packet_id'),
  ('packets','id'),          ('packets','user_id'),      ('packets','status'),
  ('item_photos','id'),      ('item_photos','item_id'),  ('item_photos','url'),
  ('item_photos','sort_order'), ('item_photos','created_at'),
  ('ingestion_runs','packet_id'), ('ingestion_runs','status')
) as e(tbl, col)
where not exists (
  select 1 from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = e.tbl and c.column_name = e.col
);

-- (c2) The two types move_item_photos actually computes on: it does
--      max(sort_order) + 1 arithmetic, and matches url against 'http%'.
--      SAFE = sort_order integer, url text.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'item_photos'
  and column_name in ('sort_order','url');

-- (d) No name collision — INCLUDING an overload.
--
--     This is not a repeat of (b). `create or replace function` replaces only
--     when the whole SIGNATURE matches; a same-named function with different
--     argument types becomes a SECOND function. The revokes in §3 name exact
--     signatures, so they would lock down the new one and leave the pre-existing
--     overload executable — a privilege hole created by the very migration that
--     is supposed to close one.
--
--     Also catches a non-table relation squatting on the table name, which
--     would make `create table if not exists` fail rather than skip.
--     SAFE = zero rows.
select 'function' as kind,
       p.proname as name,
       pg_get_function_identity_arguments(p.oid) as signature,
       pg_get_userbyid(p.proowner) as owner
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (p.proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision')
    or p.proname like '%item_media%')
union all
-- relkind is Postgres's internal "char" type, NOT text. Concatenating it with an
-- untyped literal is ambiguous ("operator is not unique: unknown || char"), so
-- the cast is required rather than cosmetic.
select 'relation (' || c.relkind::text || ')', c.relname, '', pg_get_userbyid(c.relowner)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'item_media_decisions';

-- (e) The roles this migration names must exist. It REVOKES from anon and
--     authenticated and GRANTS to service_role; a grant to a role that does not
--     exist is a hard failure, and a revoke from a missing role is too.
--     SAFE = three rows.
select rolname, rolsuper, rolbypassrls
from pg_roles
where rolname in ('anon','authenticated','service_role')
order by rolname;

-- (f) What THIS project's default privileges do to a newly created table in
--     public. INFORMATIONAL, not pass/fail — the migration revokes and grants
--     explicitly and does not depend on the answer. Worth reading once, because
--     it shows what the revokes are actually undoing, and whether a future table
--     added without those revokes would be born reachable.
select case d.defaclobjtype
         when 'r' then 'table'    when 'S' then 'sequence'
         when 'f' then 'function' when 'T' then 'type'
         when 'n' then 'schema'   else d.defaclobjtype::text
       end as obj_type,
       pg_get_userbyid(d.defaclrole) as granting_role,
       coalesce(n.nspname, '(all schemas)') as schema,
       d.defaclacl::text as default_acl
from pg_default_acl d
left join pg_namespace n on n.oid = d.defaclnamespace
where n.nspname = 'public' or n.nspname is null
order by obj_type, granting_role;
```

Also confirm the app is running the code that matches this migration — the gate
and the three RPC call sites ship together.

---

## 7. Apply

Paste the file whole. It runs inside `begin; … commit;` with
`lock_timeout = '3s'` and `statement_timeout = '60s'`.

Success prints:

```
NOTICE:  0016: table created, three RPCs installed, none reachable by anon
```

If it raises, **nothing is applied** — the transaction rolls back whole. Fix the
cause and re-run; the migration is idempotent.

---

## 8. Post-apply verification

```sql
-- (a) Three functions, SECURITY DEFINER, pinned search_path.
--     SAFE = 3 rows, prosecdef = t, proconfig = {search_path=}
select proname, prosecdef, proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision');

-- (b) Functions not EXECUTABLE by anon or authenticated — tested by EFFECT, so
--     a privilege held through PUBLIC is caught.
--     SAFE = zero rows.
select p.proname, r.rolname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('anon'),('authenticated')) as r(rolname)
where n.nspname = 'public'
  and p.proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision')
  and has_function_privilege(r.rolname, p.oid, 'execute');

-- (c) PUBLIC holds no EXECUTE. PUBLIC is a pseudo-role, so it is checked as
--     grantee 0 in the ACL — and a NULL proacl means DEFAULT privileges, under
--     which functions ARE executable by PUBLIC.
--     SAFE = zero rows.
select p.proname,
       case when p.proacl is null then 'NULL acl — PUBLIC CAN EXECUTE'
            else 'explicit PUBLIC grant' end as why
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision')
  and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0));

-- (d) The TABLE is unreachable by anon/authenticated, across every privilege
--     type, by effect.
--     SAFE = zero rows.
select r.rolname, pr.priv
from (values ('anon'),('authenticated')) as r(rolname)
cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                   ('TRUNCATE'),('REFERENCES'),('TRIGGER')) as pr(priv)
where has_table_privilege(r.rolname, 'public.item_media_decisions', pr.priv);

-- (e) PUBLIC holds nothing on the table.
--     SAFE = zero rows.
select a.privilege_type
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(c.relacl) a
where n.nspname='public' and c.relname='item_media_decisions' and a.grantee = 0;

-- (f) RLS on, no policy.
--     SAFE = relrowsecurity = t, policies = 0.
select c.relrowsecurity,
       (select count(*) from pg_policies
         where schemaname='public' and tablename='item_media_decisions') as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname='public' and c.relname='item_media_decisions';

-- (g) The legitimate caller still works. A lockdown that locks out the intended
--     caller is a permanent 503, not a success.
--     SAFE = three rows, all true.
select pr.priv, has_table_privilege('service_role', 'public.item_media_decisions', pr.priv) as allowed
from (values ('SELECT'),('INSERT'),('DELETE')) as pr(priv);

-- (h) Every function is SECURITY DEFINER with a pinned search_path.
--     SAFE = 3 rows, prosecdef = t, proconfig contains search_path=
select proname, prosecdef, proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public'
  and proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision');

-- (i) The unique key that makes a Keep idempotent.
--     SAFE = one unique index on (item_id, url).
select indexname, indexdef from pg_indexes
where schemaname='public' and tablename='item_media_decisions';

-- (j) The cascade, so a deleted item cannot strand a decision.
--     SAFE = delete_rule = CASCADE.
select rc.delete_rule
from information_schema.referential_constraints rc
join information_schema.table_constraints tc on tc.constraint_name = rc.constraint_name
where tc.table_schema='public' and tc.table_name='item_media_decisions';
```

Then run the E2E proof (§10).

---

## 9. Rollback

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

### ACL exactness

0016 alters no existing table, column or function, and **grants nothing to any
pre-existing object**. Every ACL change it makes lives on objects it created:

| Change | Undone by |
|---|---|
| `revoke` on `item_media_decisions` from PUBLIC / anon / authenticated | `drop table` — the ACL is dropped with the object |
| `grant … to service_role` on that table | `drop table` |
| `revoke` on the three functions from PUBLIC / anon / authenticated | `drop function` |

So there is no `grant`/`revoke` to replay in reverse: dropping the objects
removes their ACLs entirely, and no other object's privileges were touched. That
is what makes this rollback exact rather than approximate.

Confirm no ACL residue outside those objects — this should return the same rows
before 0016 and after rollback:

```sql
select c.relname, c.relacl
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;
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

## 10. E2E proof — disposable

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

## 11. What this does not do

- **No backfill.** Packets imported before 0014 carry no provenance, recompute
  declines, and the gate lets them publish. Blocking there would trap every
  historical packet behind a check it can never satisfy.
- **No durable audit of decisions beyond the table itself.** There is no history
  of who kept what and when, beyond `created_at`.
- **No hard database guard for ownership.** It is application-layer by
  necessity, standing in the single door proven in §4.
