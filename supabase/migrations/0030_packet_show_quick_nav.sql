-- 0030 - ONE PRESENTATION PREFERENCE: SHOW QUICK NAVIGATION.
--
-- A section with more than one item renders a clickable list of its item titles
-- at the top (src/components/section-contents.tsx). That is navigation over a
-- long FlowGuide and it earns its place on a twenty-item packet; on a short or
-- deliberately narrative one a professional may not want it. This makes it a
-- per-packet choice.
--
-- NOT NULL DEFAULT TRUE, so every packet that exists today keeps exactly the
-- behaviour it has today. No backfill, no second step, no window in which an
-- index disappears from a FlowGuide someone has already sent.
--
-- PRESENTATION, NOT CONTENT - AND THE SCHEMA ALREADY KNOWS THE DIFFERENCE.
-- ingest_bump_packet_self() bumps content_rev only when one of title,
-- client_name, personal_note, map_url, identity_mode, custom_identity or
-- composition_mode changes. show_quick_nav is deliberately NOT in that list, so
-- toggling it does not bump content_rev and cannot disturb ingestion offsets or
-- the block/item bijection that revision guards. Adding it to that list later
-- would be reclassifying a display preference as content - don't.
--
-- MUTABLE AFTER PUBLISH, on purpose. professional_snapshot is frozen at publish
-- time because a recipient must keep seeing the identity they were actually
-- sent. This is the opposite kind of state: it changes what an already-shared
-- link renders the next time it is opened, which is the same contract title and
-- personal_note already have.
--
-- WHAT THIS COLUMN DOES NOT DECIDE: whether a SINGLE-item section shows an
-- index. It never does, that rule is about the content rather than about the
-- professional's preference, and it stays in the component where it lives now.
--
-- Legacy composition only. Block-mode packets render through PacketBlockBody,
-- which has no index at all, so the column is inert for them rather than
-- meaningful-but-ignored.

begin;

alter table packets
  add column show_quick_nav boolean not null default true;

comment on column packets.show_quick_nav is
  'Recipient presentation only: render the multi-item section index. Default true. Not content - deliberately excluded from ingest_bump_packet_self().';

commit;
