-- 0015 — close public write access, and public enumeration, of client packets.
--
-- URGENT, and independent of every other in-flight change.
--
-- WHAT IS OPEN RIGHT NOW. `Public can mark packets as viewed` is
--   on public.packets for update using (status='published') with check (status='published')
-- Postgres RLS gates ROWS, not COLUMNS. The policy name says "viewed" but the
-- grant is a whole-row UPDATE of every published packet. Combined with
-- `Public can view published packets` (SELECT, same predicate), anyone holding
-- the anon key — which ships in the browser bundle and is public by design —
-- can enumerate every published packet and overwrite its title, client_name,
-- personal_note, map_url, raw_input, custom_identity and professional_snapshot.
--
-- Verified against production, not inferred: an anon-key client listed live
-- packets including real client names, and an UPDATE of raw_input on a published
-- packet returned rows=1 (the probe wrote the column's existing value, so no
-- data changed). `with check (status='published')` prevents unpublishing, and
-- nothing else.
--
-- Overwriting raw_input also permanently disables media-ownership recomputation
-- for that packet: it fires 0014's trg_ingest_invalidate_offsets, nulling
-- source_offset_base for every run, after which recompute declines forever. That
-- is the smaller half of the problem and is not why this is urgent.
--
-- WHY THIS IS SAFE TO DROP. Nothing uses it. `createPublicClient()`
-- (src/lib/supabase.ts) is imported once in src/lib/queries.ts and never called;
-- there are zero call sites in the codebase. Every server path — including the
-- recipient-facing /p/[slug] page and markPacketViewed — uses
-- createServerClient(), the SERVICE ROLE, which bypasses RLS entirely and is
-- unaffected by any policy in this file.
--
-- Section 2 is separable: if you want to keep public reads for a future
-- client-side renderer, apply section 1 alone. Section 1 is the write hole.
--
-- Section 3 closes the PRIVILEGE layer, which is a different gate from RLS and
-- was missed on the first pass.
--
-- Measured, not assumed: an anon INSERT against packets/sections/items/
-- item_photos/item_contacts is refused with "new row violates row-level security
-- policy", meaning the table GRANT is present and RLS is the only thing stopping
-- it. The same INSERT against packet_blocks is refused with "permission denied
-- for table" — 0007 revoked its grants properly.
--
-- Two DIFFERENT arguments, because two different mechanisms are involved:
--
--   * For SELECT / INSERT / UPDATE / DELETE, RLS is a real gate, but it is the
--     ONLY gate on 13 of 14 tables. Re-add any permissive policy later and
--     access reopens instantly. Revoking makes a dropped policy fail safe.
--
--   * For TRUNCATE and REFERENCES, RLS IS NOT A GATE AT ALL. Row security
--     policies apply only to the four DML commands above; TRUNCATE is a
--     table-level operation and REFERENCES is a schema-level one, and neither is
--     filtered by a policy. What has actually prevented an anon TRUNCATE is that
--     PostgREST exposes no verb for it — an absence-of-execution-path, not a
--     permission check. The grant is the only correct place to reason about
--     these, and until this migration they were granted to anon on every table
--     except packet_blocks.

begin;

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. THE WRITE HOLE. Remove unauthenticated write access to published packets.
-- ---------------------------------------------------------------------------
drop policy if exists "Public can mark packets as viewed" on public.packets;

-- ---------------------------------------------------------------------------
-- 2. ENUMERATION. Remove unauthenticated reads of client content.
--
-- The product model is that a packet is protected by an unguessable slug. That
-- model is not currently enforced: the SELECT predicate is `status='published'`
-- with no slug condition, so the anon key lists ALL published packets and their
-- children — client names, notes, addresses, contacts — without knowing any
-- slug. Dropping these makes the server the only reader, which is how the app
-- already behaves.
-- ---------------------------------------------------------------------------
drop policy if exists "Public can view published packets"             on public.packets;
drop policy if exists "Public can view sections of published packets" on public.sections;
drop policy if exists "Public can view items of published packets"    on public.items;
drop policy if exists "Public can view photos of published packets"   on public.item_photos;
drop policy if exists "Public can view links of published packets"    on public.item_links;
drop policy if exists "Public can view details of published packets"  on public.item_details;
drop policy if exists "Public can view contacts of published packets" on public.item_contacts;
drop policy if exists "Public can view blocks of published packets"   on public.packet_blocks;

-- ---------------------------------------------------------------------------
-- 3. THE PRIVILEGE LAYER. RLS should not be the only gate.
--
-- Nothing in FlowGuide uses the anon or authenticated roles against the
-- database: createPublicClient() has zero call sites, and every path goes
-- through createServerClient() (service role), which bypasses RLS and is
-- unaffected by grants on these tables.
--
-- service_role is deliberately NOT named here. Note packet_blocks already
-- restricts service_role to SELECT (0007), forcing block writes through the
-- SECURITY DEFINER RPCs; that arrangement is intentional and left alone.
-- ---------------------------------------------------------------------------
revoke all on table
  public.packets, public.sections, public.items,
  public.item_photos, public.item_links, public.item_details, public.item_contacts,
  public.packet_blocks
from anon, authenticated;

-- Auth-bearing tables. RLS is enabled with ZERO policies, so they are already
-- denied — but sessions and magic_links hold live credentials, and
-- policy-absence is currently the only thing protecting them. Same one-line
-- reasoning; separable if you would rather keep this migration to packet
-- content alone.
revoke all on table
  public.users, public.sessions, public.magic_links,
  public.professional_profiles,
  public.ingestion_runs, public.ingestion_chunks
from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Prove it, at BOTH layers, because they fail independently.
--
--    Policy layer: RLS is enabled on every one of these tables, so with no
--    permissive policy remaining, anon and authenticated are denied for SELECT,
--    INSERT, UPDATE and DELETE. service_role continues to bypass RLS.
--
--    Privilege layer: checked separately against information_schema, and it is
--    the only meaningful check for TRUNCATE and REFERENCES, which no policy
--    could ever have constrained.
--
--    Fails the migration if either layer still admits anon or authenticated.
-- ---------------------------------------------------------------------------
do $verify$
declare v_left text; v_grants text;
begin
  select string_agg(format('%s.%s: %s', schemaname, tablename, policyname), '; ')
    into v_left
  from pg_policies
  where schemaname = 'public'
    and tablename in ('packets','sections','items','item_photos','item_links',
                      'item_details','item_contacts','packet_blocks')
    and (roles = '{public}'::name[] or 'anon' = any(roles) or 'authenticated' = any(roles));

  if v_left is not null then
    raise exception '0015: policies still reachable by anon/authenticated remain: %', v_left;
  end if;

  select string_agg(distinct format('%s:%s', table_name, privilege_type), ', ')
    into v_grants
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon','authenticated')
    and table_name in ('packets','sections','items','item_photos','item_links',
                       'item_details','item_contacts','packet_blocks',
                       'users','sessions','magic_links','professional_profiles',
                       'ingestion_runs','ingestion_chunks');

  if v_grants is not null then
    raise exception '0015: table privileges still held by anon/authenticated: %', v_grants;
  end if;

  raise notice '0015: no anon-reachable policy AND no anon table privilege remains';
end
$verify$;

commit;

notify pgrst, 'reload schema';
