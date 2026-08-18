# Library v1 — implementation plan and migration package

**Status: PLAN. 2026-08-18.** Spec: [library-v1-spec.md](library-v1-spec.md).

Adversarial review found **no architectural blocker**. Mixed-origin ownership is
already correct and is now pinned by three regressions that pass against the
unchanged architecture.

---

## Migration 0017 — additive, reversible, no backfill

```sql
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- The reusable snapshot. Columns mirror ItemContentPayload exactly
-- (src/lib/item-content.ts) so there is NO transform between Library and packet
-- and therefore nothing that can drift. Array ORDER is the display order and is
-- carried by position, which is why no sort_order travels.
-- ---------------------------------------------------------------------------
create table if not exists public.library_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,

  title       text not null default '',
  address     text not null default '',
  description text not null default '',
  notes       text not null default '',

  details     jsonb not null default '[]'::jsonb,   -- {label,value}[]
  links       jsonb not null default '[]'::jsonb,   -- {url,label?}[]
  photos      jsonb not null default '[]'::jsonb,   -- {url}[]
  contacts    jsonb not null default '[]'::jsonb,   -- {name?,role?,phone?,email?,website?}[]

  -- INERT lineage. Nothing renders or edits differently because of it.
  source_packet_item_id uuid references public.items(id) on delete set null,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Search over everything a professional would actually type, including detail
-- labels and values — "memory care" often appears ONLY in a detail. Photo urls
-- are excluded as noise.
alter table public.library_items
  add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector('english',
      coalesce(title,'') || ' ' || coalesce(address,'') || ' ' ||
      coalesce(description,'') || ' ' || coalesce(notes,'') || ' ' ||
      coalesce(jsonb_path_query_array(details,  '$[*].label')::text, '') || ' ' ||
      coalesce(jsonb_path_query_array(details,  '$[*].value')::text, '') || ' ' ||
      coalesce(jsonb_path_query_array(contacts, '$[*].name')::text,  '') || ' ' ||
      coalesce(jsonb_path_query_array(contacts, '$[*].role')::text,  '') || ' ' ||
      coalesce(jsonb_path_query_array(links,    '$[*].label')::text, '')
    )
  ) stored;

create index if not exists library_items_search_idx on public.library_items using gin (search_tsv);
create index if not exists library_items_user_idx   on public.library_items(user_id, updated_at desc);

-- INERT lineage on the packet side. This is also what makes
-- "Update Library version" offerable, and `set null` is what guarantees a
-- deleted Library entry can never affect a packet copy.
alter table public.items
  add column if not exists library_item_id uuid
    references public.library_items(id) on delete set null;

create index if not exists items_library_item_idx on public.items(library_item_id)
  where library_item_id is not null;

-- ---------------------------------------------------------------------------
-- Privilege boundary — 0016's posture, including the correction that cost two
-- rounds there.
-- ---------------------------------------------------------------------------
alter table public.library_items enable row level security;
revoke all on table public.library_items from public;
revoke all on table public.library_items from anon, authenticated;
grant select, insert, update, delete on table public.library_items to service_role;

do $verify$
declare v_left text;
begin
  if to_regclass('public.library_items') is null then
    raise exception '0017: library_items was not created';
  end if;

  -- BY EFFECT, not by grant rows: a privilege held through PUBLIC never appears
  -- as a grant to anon or authenticated.
  select string_agg(distinct r.rolname::text || ':' || pr.priv::text, ', ') into v_left
  from (values ('anon'),('authenticated')) as r(rolname)
  cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                     ('TRUNCATE'),('REFERENCES'),('TRIGGER')) as pr(priv)
  where has_table_privilege(r.rolname, 'public.library_items', pr.priv);
  if v_left is not null then
    raise exception '0017: library_items still reachable: %', v_left;
  end if;

  -- PUBLIC is a pseudo-role with no pg_roles entry, so it is checked as
  -- grantee 0 in the ACL rather than through has_table_privilege.
  if exists (select 1 from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
             cross join lateral aclexplode(c.relacl) a
             where n.nspname='public' and c.relname='library_items' and a.grantee = 0) then
    raise exception '0017: PUBLIC still holds privileges on library_items';
  end if;

  if not coalesce((select c.relrowsecurity from pg_class c
                   join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname='public' and c.relname='library_items'), false) then
    raise exception '0017: row level security is not enabled on library_items';
  end if;

  if (select count(*) from pg_policies
      where schemaname='public' and tablename='library_items') > 0 then
    raise exception '0017: library_items must carry no policy';
  end if;

  -- A lockdown that locks out the only caller is a 503 found in production.
  select string_agg(pr.priv::text, ', ') into v_left
  from (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) as pr(priv)
  where not has_table_privilege('service_role', 'public.library_items', pr.priv);
  if v_left is not null then
    raise exception '0017: service_role lacks % on library_items', v_left;
  end if;

  raise notice '0017: library_items created; anon/authenticated/PUBLIC hold nothing; service_role can read and write; RLS on with no policy';
end
$verify$;

commit;
notify pgrst, 'reload schema';
```

**No RPCs.** Unlike 0016, nothing here needs `SECURITY DEFINER`: `library_items`
is a single row per record with no child tables, so there is no multi-table
atomicity problem. Ownership is enforced in the route layer with the service
role and an explicit `user_id` predicate on every query — the same pattern the
packet routes already use.

**Deploy order does not matter.** The column is inert without the code; the code
offers nothing without the table. No gate depends on either.

**Rollback:**

```sql
begin;
alter table public.items drop column if exists library_item_id;
drop table if exists public.library_items;
commit;
notify pgrst, 'reload schema';
```

Lossless for packets, which never depended on either. Library content itself is
lost — capture it first if any exists.

---

## Build order

Each step ends green: tests, tsc, build.

**1. Migration + shared types** *(no UI)*
`supabase/migrations/0017_library_items.sql`; extract
`normalizeItemContent(payload): ItemContentPayload` from the item routes into
`src/lib/item-content.ts` and use it in the existing packet routes first, so the
refactor is proven before the Library depends on it.

**2. `src/lib/library.ts`** — pure core, no I/O
`toSnapshot(item)`, `fromSnapshot(row)`, `diffItemContent(a, b)` returning
`{ added, changed, removed }`, and `isDuplicateCandidate(a, b)`.
Unit-tested exhaustively. **This is where the safeguard logic lives**, and it is
pure so it can be tested without a database.

**3. Library service + routes**
`src/lib/library-service.ts` (owner-scoped reads/writes) and the seven routes
from spec §5. Every route asserts `user_id` — never inferred from a join.

**4. Search workspace** — `/library`
List, search, edit, delete. Reuses `BlockItemEditor`, refactored to accept
content + `onSave` rather than assuming a packet.

**5. Packet integration**
*Add item → From Library* picker in **both** editors; insertion via
`applyItemContentUpdate`; `library_item_id` set; 0014 provenance deliberately
left null.

**6. Save to Library + duplicate flow**
Single-item save, 409 duplicate candidate, Update / Save as new / Cancel.

**7. Update Library version + the removal safeguard**
Two-state dialog driven by `diffItemContent`. Removals flip the primary action to
*Save as new Library item*.

**8. Bulk promotion**
Packet-level *Save items to Library*, reading current items, default selection
**none**, select-all available; dismissible one-time hint after a clean import.

**9. Proof**
Unit suite green, plus a disposable runtime script in the
`scripts/ingestion-runtime/` style:

> import → bulk-promote the reviewed base → insert into a fresh packet → prune it
> for that client → attempt *Update Library version* → **assert the removal
> safeguard fires** → *Save as new* instead → assert the original Library entry
> is byte-identical → assert the first packet is untouched → publish → cleanup
> verified clean.

Plus a mixed-origin assertion in that runtime script: a packet holding both
imported and Library items still reports ownership as **checked**, mirroring the
unit regressions already committed.

---

## Acceptance gates before it ships

Everything in spec §7, plus these three from the review:

- **Mixed origin:** a packet with imported *and* Library items reports
  `checked: true` and the full, unchanged set of real findings. *(Already
  passing.)*
- **Removal safeguard:** a pruned descendant attempting *Update Library version*
  must surface the removals and must not present replacement as the default.
- **No third editor:** asserted against source — exactly one component renders
  item content fields for editing.

## Risk register for the build itself

| Risk | Handling |
|---|---|
| `BlockItemEditor` refactor regresses the block editor | Step 1 refactors and proves normalization *before* the Library uses it; the block editor's own tests must stay green at every step |
| `jsonb_path_query_array` in a generated column is heavier than expected | Measure on real data at step 1; fall back to a trigger-maintained tsvector if needed — same column, same index, no API change |
| Scope gravity mid-build | Steps 1-9 are the whole of v1. Folders, tags, templates, teams and versioning are not in this plan and should not enter it |
