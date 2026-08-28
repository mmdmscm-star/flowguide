-- ============================================================================
-- 0037 — THE NAME A PROFESSIONAL FILES IT UNDER IS NOT THE TITLE A CLIENT READS.
--
-- packets.title carries two jobs at once. It is how a FlowGuide is found in My
-- FlowGuides — searched, listed, duplicated, required before publishing — and
-- it is simultaneously the large heading on the recipient page, in the email,
-- and on the printed version.
--
-- Those are different needs. "Options for Bonnie Smith" is a useful thing to
-- call a FlowGuide and a strange thing to show Bonnie Smith. And some
-- FlowGuides read better with no heading at all; the recipient version is
-- already complete without one.
--
-- A backstage requirement should not automatically become frontstage
-- communication. So:
--
--   packets.title         stays exactly what it is — the INTERNAL name.
--                         Required to publish. Never shown to a recipient.
--   packets.client_title  NEW. The optional heading a client sees. Blank means
--                         the title area is omitted, not that something failed.
--
-- Two meanings need two columns. Nothing runtime-only can do this: every such
-- scheme has to DERIVE one meaning from the other, and "internal name is
-- Options for Bonnie Smith, client heading is Senior Living Communities" is two
-- independent values. A show/hide flag cannot express it either.
--
-- ---------------------------------------------------------------------------
-- COMPATIBILITY: NOTHING ALREADY SENT MAY CHANGE.
--
-- Every existing FlowGuide shows its title to recipients today. If the
-- renderers switched to an empty client_title, every one of them would lose its
-- heading the next time it was opened — including links already in clients'
-- hands. So every existing row is backfilled with its current title, drafts as
-- well as published: a draft's Preview shows that heading today too, and a
-- professional watching it vanish is the same silent change.
--
-- Only FlowGuides created AFTER this migration start blank, which is the new
-- default and affects no work already done.
--
-- A nullable three-state column (null = fall back to title, '' = omit) was the
-- alternative and is worse: the same stored value would render differently
-- depending on how old the row is, which is the ambiguity this migration exists
-- to remove.
--
-- ---------------------------------------------------------------------------
-- THE BACKFILL MUST NOT TOUCH updated_at.
--
-- update_packets_updated_at is an unconditional BEFORE UPDATE trigger, and the
-- dashboard lists FlowGuides by updated_at descending. A blanket UPDATE would
-- therefore stamp every packet with the migration time and flatten every
-- professional's list into one indistinguishable block — a silent, visible
-- change to work they have not touched. The trigger is disabled for the
-- backfill and restored immediately, inside this transaction.
--
-- trg_ingest_invalidate_offsets is `after update OF raw_input`, so the backfill
-- cannot fire it. No ingestion run is disturbed.
--
-- ---------------------------------------------------------------------------
-- NOT AN INGESTION-INVALIDATING CHANGE, DELIBERATELY.
--
-- ingest_bump_packet_self() bumps content_rev when one of title, client_name,
-- personal_note, map_url, identity_mode, custom_identity or composition_mode
-- changes. That tuple is an explicit ALLOWLIST, so a column left out of it
-- simply does not bump — which is how show_quick_nav (0030) already behaves and
-- why no trigger change is needed here.
--
-- client_title stays out of it on purpose. A heading has no bearing on
-- ingestion offsets or on the block/item bijection that content_rev guards, so
-- editing one mid-import must not abort the import. This does NOT change how
-- title itself is treated; title's behaviour is untouched.
--
-- Mutable after publish, like title and personal_note: it changes what an
-- already-shared link renders next time it is opened. professional_snapshot is
-- the frozen-at-publish concept, and this is not that.
--
-- Runs as a single explicit transaction.
-- ============================================================================

begin;

alter table public.packets
  add column client_title text not null default '';

comment on column public.packets.client_title is
  'Optional recipient-facing heading. Blank means the title area is omitted from the recipient page, email and print — not an error state. Distinct from packets.title, which is the professional''s internal name for finding the FlowGuide and is never shown to a recipient.';

-- ---------------------------------------------------------------------------
-- Backfill, with updated_at preserved.
--
-- The before-picture is recorded rather than inferred from a time window: a
-- professional editing a FlowGuide in the minute before this runs would make a
-- "was anything stamped recently" check fail on a migration that did nothing
-- wrong. Comparing each row against its own prior value cannot false-positive.
-- ---------------------------------------------------------------------------
create temp table _packet_updated_at_before on commit drop as
  select id, updated_at from public.packets;

alter table public.packets disable trigger update_packets_updated_at;

update public.packets
   set client_title = title
 where title <> ''
   and client_title = '';

alter table public.packets enable trigger update_packets_updated_at;

-- ---------------------------------------------------------------------------
-- Prove the two things this migration promised, before committing.
-- ---------------------------------------------------------------------------
do $$
declare
  v_unmigrated int;
  v_stamped    int;
begin
  -- Every row that had a title now shows the same heading it showed before.
  select count(*) into v_unmigrated
    from public.packets where title <> '' and client_title is distinct from title;
  if v_unmigrated > 0 then
    raise exception 'client_title backfill missed % packet(s); recipients would lose a heading', v_unmigrated;
  end if;

  -- ...and not one row was stamped as freshly edited by this migration.
  select count(*) into v_stamped
    from public.packets p
    join _packet_updated_at_before b on b.id = p.id
   where p.updated_at is distinct from b.updated_at;
  if v_stamped > 0 then
    raise exception
      'the backfill moved updated_at on % packet(s); every dashboard would reorder', v_stamped;
  end if;
end $$;

commit;
