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
-- WHY TWO RPCs, AFTER ALL. An earlier draft of this migration claimed none were
-- needed because a Library record is a single row. That is true of a Library
-- WRITE and false of the two operations that matter:
--
--   Update Library version  = replace library_items + bump its revision
--                             + refresh the DESCENDANT's recorded revision
--   Save as new             = insert library_items + repoint the descendant
--
-- Both span two tables. Split into separate statements, a failure between them
-- leaves the Library updated while the descendant still records the OLD
-- revision — which the save-back logic then reports as "the ancestor moved on",
-- warning the professional about their own change. That is a false warning, and
-- a false warning is worse than none: it teaches people to dismiss the real one.
--
-- supabase-js exposes no multi-statement transaction, so atomicity requires a
-- function. Direct Library edits stay a plain conditional UPDATE — genuinely one
-- row, genuinely atomic, no function needed.
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
-- ANCESTRY COHERENCE. Four combinations exist; two are meaningless:
--
--   id set,  revision set   -> descendant of a known revision            OK
--   id null, revision null  -> no ancestry                                OK
--   id set,  revision null  -> live ancestor, unknown revision       IMPOSSIBLE
--   id null, revision set   -> orphan revision                       IMPOSSIBLE
--
-- The fourth is not hypothetical: `on delete set null` nulls ONLY the id, so
-- deleting a Library entry would strand its revision on every descendant. The
-- trigger below therefore clears BOTH before the row goes, and the FK's own
-- action then finds the id already null. With that in place the CHECK is safe;
-- without it, deleting a Library item would violate the constraint and fail.
-- ---------------------------------------------------------------------------
create or replace function public.library_clear_descendant_lineage() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.items
     set library_item_id = null, library_item_revision = null
   where library_item_id = old.id;
  return old;
end;
$$;

drop trigger if exists trg_library_clear_lineage on public.library_items;
create trigger trg_library_clear_lineage before delete on public.library_items
  for each row execute function public.library_clear_descendant_lineage();

alter table public.items drop constraint if exists items_library_lineage_coherent;
alter table public.items add constraint items_library_lineage_coherent
  check ((library_item_id is null) = (library_item_revision is null));

-- ---------------------------------------------------------------------------
-- Privilege boundary — 0016's posture, including the correction that cost two
-- rounds there.
-- ---------------------------------------------------------------------------
alter table public.library_items enable row level security;
revoke all on table public.library_items from public;
revoke all on table public.library_items from anon, authenticated;
grant select, insert, update, delete on table public.library_items to service_role;

-- ---------------------------------------------------------------------------
-- Update Library version — ATOMIC, with optimistic concurrency.
--
-- p_expected_revision is the revision the professional actually REVIEWED in the
-- confirmation dialog. Between seeing that comparison and pressing the button,
-- the Library entry may have changed again — another tab, another device. A
-- replacement must only land against the state that was reviewed, so a mismatch
-- returns -1 rather than overwriting work nobody looked at. The caller then
-- recomputes the diff and shows the updated comparison.
--
-- Both writes happen here, in one transaction, for the reason in the header:
-- a partial apply would make the descendant report its own change as somebody
-- else's.
-- ---------------------------------------------------------------------------
create or replace function public.library_update_from_item(
  p_owner uuid,
  p_library_item_id uuid,
  p_item_id uuid,
  p_expected_revision bigint
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lib_owner uuid; v_current bigint; v_item_owner uuid; v_new bigint;
  v_title text; v_address text; v_description text; v_notes text;
  v_details jsonb; v_links jsonb; v_photos jsonb; v_contacts jsonb;
begin
  -- Lock the Library row FIRST and for the whole transaction: the revision check
  -- and the write must not be separable, or two concurrent replacements could
  -- both read the same revision and both believe they won.
  select user_id, revision into v_lib_owner, v_current
    from public.library_items where id = p_library_item_id for update;
  if v_lib_owner is null then raise exception 'library: entry % not found', p_library_item_id; end if;
  if v_lib_owner <> p_owner then raise exception 'library: caller does not own this entry'; end if;

  -- The conflict signal. NOT an exception: this is an ordinary race with a
  -- defined resolution (show the professional what changed), not a fault.
  if v_current <> p_expected_revision then return -1; end if;

  -- The descendant must belong to the same owner. Verified through the packet,
  -- because items carry no user_id of their own.
  select pk.user_id into v_item_owner
    from public.items i
    join public.sections s on s.id = i.section_id
    join public.packets pk on pk.id = s.packet_id
   where i.id = p_item_id;
  if v_item_owner is null then raise exception 'library: item % not found', p_item_id; end if;
  if v_item_owner <> p_owner then raise exception 'library: caller does not own this item'; end if;

  select i.title, i.address, i.description, i.notes,
         coalesce((select jsonb_agg(jsonb_build_object('label', d.label, 'value', d.value)
                    order by d.sort_order, d.created_at) from public.item_details d where d.item_id = i.id), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object('url', l.url, 'label', l.label)
                    order by l.sort_order, l.created_at) from public.item_links l where l.item_id = i.id), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object('url', ph.url)
                    order by ph.sort_order, ph.created_at) from public.item_photos ph where ph.item_id = i.id), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object('name', c.name, 'role', c.role, 'phone', c.phone,
                                                       'email', c.email, 'website', c.website)
                    order by c.sort_order, c.created_at) from public.item_contacts c where c.item_id = i.id), '[]'::jsonb)
    into v_title, v_address, v_description, v_notes, v_details, v_links, v_photos, v_contacts
    from public.items i where i.id = p_item_id;

  update public.library_items
     set title = v_title, address = v_address, description = v_description, notes = v_notes,
         details = v_details, links = v_links, photos = v_photos, contacts = v_contacts,
         revision = revision + 1, updated_at = now()
   where id = p_library_item_id
   returning revision into v_new;

  -- The descendant that just BECAME the base is no longer stale against it.
  -- Same transaction, so it can never be left reporting its own change as
  -- somebody else's.
  update public.items
     set library_item_id = p_library_item_id, library_item_revision = v_new
   where id = p_item_id;

  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Save as new — ATOMIC. Creates a fresh entry from a packet item and repoints
-- the descendant, so a tailored copy stops being measured against a base it
-- deliberately does not match.
-- ---------------------------------------------------------------------------
create or replace function public.library_save_as_new_from_item(
  p_owner uuid,
  p_item_id uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_item_owner uuid; v_new_id uuid;
begin
  select pk.user_id into v_item_owner
    from public.items i
    join public.sections s on s.id = i.section_id
    join public.packets pk on pk.id = s.packet_id
   where i.id = p_item_id;
  if v_item_owner is null then raise exception 'library: item % not found', p_item_id; end if;
  if v_item_owner <> p_owner then raise exception 'library: caller does not own this item'; end if;

  insert into public.library_items
    (user_id, title, address, description, notes, details, links, photos, contacts,
     source_packet_item_id, revision)
  select p_owner, i.title, i.address, i.description, i.notes,
         coalesce((select jsonb_agg(jsonb_build_object('label', d.label, 'value', d.value)
                    order by d.sort_order, d.created_at) from public.item_details d where d.item_id = i.id), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object('url', l.url, 'label', l.label)
                    order by l.sort_order, l.created_at) from public.item_links l where l.item_id = i.id), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object('url', ph.url)
                    order by ph.sort_order, ph.created_at) from public.item_photos ph where ph.item_id = i.id), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object('name', c.name, 'role', c.role, 'phone', c.phone,
                                                       'email', c.email, 'website', c.website)
                    order by c.sort_order, c.created_at) from public.item_contacts c where c.item_id = i.id), '[]'::jsonb),
         i.id, 1
    from public.items i where i.id = p_item_id
  returning id into v_new_id;

  -- Both lineage columns together — the CHECK constraint makes a half state
  -- unrepresentable, and this is where it would otherwise be introduced.
  update public.items
     set library_item_id = v_new_id, library_item_revision = 1
   where id = p_item_id;

  return v_new_id;
end;
$$;

revoke all on function public.library_update_from_item(uuid, uuid, uuid, bigint) from public;
revoke all on function public.library_update_from_item(uuid, uuid, uuid, bigint) from anon, authenticated;
revoke all on function public.library_save_as_new_from_item(uuid, uuid) from public;
revoke all on function public.library_save_as_new_from_item(uuid, uuid) from anon, authenticated;
revoke all on function public.library_clear_descendant_lineage() from public, anon, authenticated, service_role;

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

  -- The two cross-table writers must be SECURITY DEFINER with a pinned
  -- search_path, and unreachable by anon/authenticated or PUBLIC.
  select string_agg(p.proname::text, ', ') into v_left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('library_update_from_item','library_save_as_new_from_item')
    and (not p.prosecdef
      or coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=%');
  if v_left is not null then
    raise exception '0017: not SECURITY DEFINER with a pinned search_path: %', v_left;
  end if;

  select string_agg(distinct r.rolname::text || ' -> ' || p.proname::text, ', ') into v_left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'),('authenticated')) as r(rolname)
  where n.nspname = 'public'
    and p.proname in ('library_update_from_item','library_save_as_new_from_item')
    and has_function_privilege(r.rolname, p.oid, 'execute');
  if v_left is not null then
    raise exception '0017: functions still executable: %', v_left;
  end if;

  select string_agg(p.proname::text, ', ') into v_left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('library_update_from_item','library_save_as_new_from_item')
    and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0));
  if v_left is not null then
    raise exception '0017: PUBLIC can still execute: %', v_left;
  end if;

  -- Half-lineage must be unrepresentable, and deleting an entry must clear both
  -- columns rather than stranding a revision.
  if not exists (select 1 from pg_constraint
                 where conname = 'items_library_lineage_coherent') then
    raise exception '0017: the lineage coherence constraint is missing';
  end if;
  if not exists (select 1 from pg_trigger
                 where tgname = 'trg_library_clear_lineage' and not tgisinternal) then
    raise exception '0017: the lineage-clearing trigger is missing';
  end if;

  raise notice '0017: library_items created; anon/authenticated/PUBLIC hold nothing; service_role can read and write; RLS on with no policy';
end
$verify$;

commit;
notify pgrst, 'reload schema';
