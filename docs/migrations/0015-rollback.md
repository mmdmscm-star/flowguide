# Migration 0015 — rollback

Fully explicit and deterministic. Restores the exact policies and the exact
privileges that existed before 0015, with no "restore defaults" hand-waving.

Rollback is lossless: 0015 changes no data, no table, no column and no function.
It drops nine policies and revokes privileges. Recreating both returns the
database to byte-equivalent state.

## Before you apply 0015 — capture the live grants

The policy DDL below is verbatim from the repo and is therefore already exact.
**Privileges are not**, because they came from Supabase's project defaults rather
than from a migration, so the repo does not record them. Run this in the SQL
Editor BEFORE applying 0015 and keep the output — it *is* the second half of your
rollback script, generated from the live database rather than assumed:

```sql
select 'grant ' || string_agg(privilege_type, ', ' order by privilege_type)
       || ' on table public.' || table_name || ' to ' || grantee || ';' as rollback_sql
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon','authenticated')
  and table_name in ('packets','sections','items','item_photos','item_links',
                     'item_details','item_contacts','packet_blocks',
                     'users','sessions','magic_links','professional_profiles',
                     'ingestion_runs','ingestion_chunks')
group by table_name, grantee
order by table_name, grantee;
```

Expect up to 28 rows (14 tables x 2 roles; `packet_blocks` will show only
`SELECT`, since 0007 already restricted it). Save them verbatim.

## Rollback part 1 — privileges (captured from production 2026-08-17)

Recorded from the live capture, which returned exactly **28 rows**:
`packet_blocks` held `SELECT` only for both roles (0007 restricted it), and the
other 13 tables held the full default set. This is the state 0015 revokes, so
running this restores it exactly.

```sql
begin;
set local lock_timeout = '3s';

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ingestion_chunks to anon;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ingestion_chunks to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ingestion_runs to anon;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ingestion_runs to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.item_contacts to anon;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.item_contacts to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.item_details to anon;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.item_details to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.item_links to anon;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.item_links to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.item_photos to anon;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.item_photos to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.items to anon;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.items to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.magic_links to anon;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.magic_links to authenticated;
grant SELECT on table public.packet_blocks to anon;
grant SELECT on table public.packet_blocks to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.packets to anon;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.packets to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.professional_profiles to anon;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.professional_profiles to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sections to anon;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sections to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sessions to anon;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sessions to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.users to anon;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.users to authenticated;

commit;
notify pgrst, 'reload schema';
```

Nothing else is needed: 0015 revokes only from `anon` and `authenticated`, and
never touches `service_role`, `public`, or ownership.

**Note on TRUNCATE and REFERENCES.** These are not subject to row-level
security — RLS governs only SELECT, INSERT, UPDATE and DELETE. Restoring them
restores a real capability that no policy constrains, gated in practice only by
PostgREST exposing no verb for them. Restore deliberately, not reflexively.

## Rollback part 2 — policies (verbatim, exact)

```sql
begin;
set local lock_timeout = '3s';

-- Public read access for published packets (recipient view)
create policy "Public can view published packets"
  on public.packets for select
  using (status = 'published');

create policy "Public can view sections of published packets"
  on public.sections for select
  using (
    exists (
      select 1 from public.packets
      where packets.id = sections.packet_id
      and packets.status = 'published'
    )
  );

create policy "Public can view items of published packets"
  on public.items for select
  using (
    exists (
      select 1 from public.sections
      join public.packets on packets.id = sections.packet_id
      where sections.id = items.section_id
      and packets.status = 'published'
    )
  );

create policy "Public can view photos of published packets"
  on public.item_photos for select
  using (
    exists (
      select 1 from public.items
      join public.sections on sections.id = items.section_id
      join public.packets on packets.id = sections.packet_id
      where items.id = item_photos.item_id
      and packets.status = 'published'
    )
  );

create policy "Public can view links of published packets"
  on public.item_links for select
  using (
    exists (
      select 1 from public.items
      join public.sections on sections.id = items.section_id
      join public.packets on packets.id = sections.packet_id
      where items.id = item_links.item_id
      and packets.status = 'published'
    )
  );

create policy "Public can view details of published packets"
  on public.item_details for select
  using (
    exists (
      select 1 from public.items
      join public.sections on sections.id = items.section_id
      join public.packets on packets.id = sections.packet_id
      where items.id = item_details.item_id
      and packets.status = 'published'
    )
  );

create policy "Public can view contacts of published packets"
  on public.item_contacts for select
  using (
    exists (
      select 1 from public.items
      join public.sections on sections.id = items.section_id
      join public.packets on packets.id = sections.packet_id
      where items.id = item_contacts.item_id
      and packets.status = 'published'
    )
  );

-- Public can update the viewed flag on published packets
create policy "Public can mark packets as viewed"
  on public.packets for update
  using (status = 'published')
  with check (status = 'published');

create policy "Public can view blocks of published packets"
  on public.packet_blocks for select
  using (
    exists (
      select 1 from public.packets
      where packets.id = packet_blocks.packet_id
        and packets.status = 'published'
    )
  );

commit;
notify pgrst, 'reload schema';
```

## Confirm the rollback

```sql
-- EXPECT 9 rows.
select tablename, policyname, cmd from pg_policies
where schemaname = 'public'
  and policyname like 'Public can %'
order by tablename, policyname;
```

Then re-run the probe; it should report the original **5 anon capabilities OPEN**:

```
PROBE_STAMP=$(date +%s) npx tsx scripts/security/anon-exposure-probe.mts
```

That is the point of rolling back — restoring the exposure — so only do this if
0015 broke something real, and tell me what broke.

## What rollback cannot undo

Nothing. There is no data change to reverse. The only lasting effect of applying
0015 is that any anon-key client which was reading or writing packet content
stops working — and the audit established there is no such client: FlowGuide's
`createPublicClient()` has zero call sites.
