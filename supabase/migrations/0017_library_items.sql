-- 0017 — Library: reusable item snapshots.
--
-- WHAT THIS IS. A professional-private store of reusable items. Saving captures
-- an item's full content; inserting drops a complete, client-ready copy into a
-- packet. The product loop: save -> find -> insert -> edit freely -> explicitly
-- Update Library version when desired.
--
-- THE GOVERNING RULE, INHERITED. docs/product-direction.md: "Inputs seed once;
-- they do not stay connected. An import is a seed, not a live binding." The
-- Library is an INPUT. Insertion is a disconnected snapshot. NOTHING propagates
-- in either direction on its own, ever. A packet is a record of what a
-- professional said to one client on one day; retroactively mutating it because
-- a Library record changed would falsify a conversation.
--
-- "Update Library version" does not violate that: it writes FROM a packet item
-- TO the Library snapshot, explicitly, on confirmation. It is a save, not a sync.
--
-- WHY NO CHILD TABLES. The columns below mirror ItemContentPayload
-- (src/lib/item-content.ts) exactly — the shape update_item_content already
-- consumes. There is therefore NO transform between Library and packet, so the
-- two cannot drift. Mirror tables would add a second shape to keep in step by
-- hand. Array ORDER is the display order and is carried by position, which is
-- why no sort_order travels.
--
-- WHY NO RPCs. Unlike 0016, nothing here needs SECURITY DEFINER: this is one row
-- per record with no child tables, so there is no multi-table atomicity problem
-- to solve. Ownership is enforced in the route layer with the service role and
-- an explicit user_id predicate on every query.
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

  -- Monotonic content revision, bumped on every direct edit and every accepted
  -- "Update Library version". A descendant records the revision it was copied
  -- from, so a save-back can tell "the base is untouched" from "the base moved
  -- on and replacing would overwrite newer edits".
  --
  -- A counter, not a timestamp: packets.content_rev (0012) set the precedent,
  -- and a monotonic integer compares exactly where clock values invite
  -- resolution and ordering questions this does not need to have.
  revision    bigint not null default 1,

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
    references public.library_items(id) on delete set null,
  -- Which revision of the ancestor this copy was taken from. NULL means
  -- unknown, which must never be read as "changed" — an absence is not
  -- evidence, and warning on one would train the professional to dismiss the
  -- warning that matters.
  add column if not exists library_item_revision bigint;

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
