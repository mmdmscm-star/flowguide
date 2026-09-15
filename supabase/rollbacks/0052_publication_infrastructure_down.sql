-- ============================================================================
-- ROLLBACK FOR 0052. Not a migration; kept outside supabase/migrations.
--
-- Drops the publish token, publish/unpublish functions and the two lock-only
-- triggers. It touches no row: packet_publications (0050) keeps whatever it
-- holds, and every Sendset keeps its status.
--
-- ORDER MATTERS. If the publish route has been changed to call publish_packet /
-- unpublish_packet, revert and deploy that route FIRST, or publishing breaks.
-- Refuses if 0053's single-door trigger exists, because without these functions
-- nothing could change a Sendset's status.
-- ============================================================================

begin;

do $$
begin
  if exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
              where t.tgrelid = 'public.packets'::regclass
                and position('app.publication_authorized_packet' in p.prosrc) > 0) then
    raise exception 'ROLLBACK 0052 REFUSED: a trigger enforcing the publication flag exists (0053). Roll that back first.';
  end if;
end $$;

drop trigger trg_lock_packets_for_media_decision on public.item_media_decisions;
drop trigger trg_lock_packets_for_profile on public.professional_profiles;

drop function public.publish_packet(uuid, uuid, jsonb, smallint, jsonb, jsonb);
drop function public.unpublish_packet(uuid, uuid);
drop function public.packet_publish_token(uuid, uuid);
drop function public.lock_packets_for_media_decision();
drop function public.lock_packets_for_profile();

do $$
begin
  if to_regprocedure('public.publish_packet(uuid,uuid,jsonb,smallint,jsonb,jsonb)') is not null
     or to_regprocedure('public.unpublish_packet(uuid,uuid)') is not null
     or to_regprocedure('public.packet_publish_token(uuid,uuid)') is not null
     or to_regprocedure('public.lock_packets_for_media_decision()') is not null
     or to_regprocedure('public.lock_packets_for_profile()') is not null
     or exists (select 1 from pg_trigger where tgname in ('trg_lock_packets_for_media_decision', 'trg_lock_packets_for_profile'))
  then
    raise exception 'ROLLBACK 0052 INCOMPLETE: a 0052 object survived.';
  end if;
end $$;

commit;
