-- ============================================================================
-- ROLLBACK FOR 0050. Not a migration; kept outside supabase/migrations so no
-- tool ever applies it by accident.
--
-- SAFE ONLY WHILE NOTHING DEPENDS ON 0050. Before running it, confirm:
--   * no deployed code reads packets.draft_rev, professional_profiles.identity_rev
--     or packet_publications (revert and deploy that code FIRST), and
--   * packet_publications is empty, or its rows are knowingly discarded — once
--     the public renderers read it, dropping it takes published Sendsets offline.
--
-- While those hold it is lossless: the counters are derived, and nothing else
-- is stored. Dropping the triggers restores exactly the pre-0050 write path;
-- no pre-existing function, trigger, grant or row is altered by 0050.
-- ============================================================================

begin;

do $$
begin
  if (select count(*) from public.packet_publications) <> 0 then
    raise exception 'ROLLBACK 0050 REFUSED: packet_publications holds % row(s). Revert the code that reads it and decide about those rows first.',
      (select count(*) from public.packet_publications);
  end if;
end $$;

drop table public.packet_publications;

drop trigger trg_draft_rev_packet_self      on public.packets;
drop trigger trg_identity_rev_profile_self  on public.professional_profiles;
drop trigger trg_draft_rev_sections_insdel  on public.sections;
drop trigger trg_draft_rev_sections_upd     on public.sections;
drop trigger trg_draft_rev_blocks_insdel    on public.packet_blocks;
drop trigger trg_draft_rev_blocks_upd       on public.packet_blocks;
drop trigger trg_draft_rev_items_insdel     on public.items;
drop trigger trg_draft_rev_items_upd        on public.items;
drop trigger trg_draft_rev_photos_insdel    on public.item_photos;
drop trigger trg_draft_rev_photos_upd       on public.item_photos;
drop trigger trg_draft_rev_links_insdel     on public.item_links;
drop trigger trg_draft_rev_links_upd        on public.item_links;
drop trigger trg_draft_rev_details_insdel   on public.item_details;
drop trigger trg_draft_rev_details_upd      on public.item_details;
drop trigger trg_draft_rev_contacts_insdel  on public.item_contacts;
drop trigger trg_draft_rev_contacts_upd     on public.item_contacts;

drop function public.draft_rev_packet_self();
drop function public.identity_rev_profile_self();
drop function public.draft_rev_by_packet();
drop function public.draft_rev_by_section();
drop function public.draft_rev_by_item();

-- Dropping a column is metadata-only: no row rewrite, no trigger, updated_at kept.
alter table public.packets drop column draft_rev;
alter table public.professional_profiles drop column identity_rev;

do $$
begin
  if to_regclass('public.packet_publications') is not null
     or exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                 where ns.nspname = 'public'
                   and p.proname in ('draft_rev_packet_self','identity_rev_profile_self',
                                     'draft_rev_by_packet','draft_rev_by_section','draft_rev_by_item'))
     or exists (select 1 from pg_trigger where not tgisinternal
                 and tgname in ('trg_draft_rev_packet_self','trg_identity_rev_profile_self')
                  or tgname like 'trg_draft_rev_%')
     or exists (select 1 from information_schema.columns
                 where table_schema = 'public'
                   and ((table_name = 'packets' and column_name = 'draft_rev')
                     or (table_name = 'professional_profiles' and column_name = 'identity_rev')))
  then
    raise exception 'ROLLBACK 0050 INCOMPLETE: an 0050 object survived.';
  end if;
end $$;

commit;
