-- 0035 - A SECTION CANNOT BE DELETED WHILE AI IS ADDING TO IT.
--
-- THE HOLE. `ingestion_runs.target_section_id` is
-- `references public.sections(id) on delete cascade` (0012). Deleting the
-- section a `section_append` run is writing into therefore deletes THE RUN and
-- its completed chunk results. The professional loses finished AI work without
-- ever seeing the conflict, because there is no longer a run to report one.
-- Measured, not assumed: after the section is gone, finalize answers
-- 'run ... not found'.
--
-- WHY BLOCK RATHER THAN CHANGE THE FOREIGN KEY. The alternative is
-- `on delete set null`, which keeps the run alive with no destination. That run
-- can never finalize honestly, and the only ways forward are to invent a
-- destination - silently moving a client's content to a section they did not
-- choose - or to hold it in a state that means the same thing as deleted. The
-- narrow answer is to stop the delete and say why.
--
-- WHOLE-PACKET DELETION MUST STILL WORK, and this is the whole subtlety.
-- Deleting a packet cascades into its sections, which would reach this trigger.
-- Packet deletion is a supported path with its own deliberate handling
-- (`stamp_orphaned_ingestion_runs`, 0026, BEFORE DELETE on packets), so it runs
-- FIRST and stamps `packet_deleted_at` on every run of that packet. A run whose
-- packet is already being deleted is therefore recognisable here, and its
-- section delete is allowed through.
--
-- That ordering is load-bearing, so it is verified rather than trusted: the
-- 0035 verification deletes a packet with an in-flight section_append and
-- asserts BOTH that it succeeds and that the resulting run/chunk state is
-- byte-for-byte the semantics measured before this migration existed
-- (run deleted, chunks deleted).
--
-- SQLSTATE FG001 IS PART OF THE CONTRACT. The route must not have to match
-- English. Postgres does not use class 'FG', so it cannot collide with a
-- built-in condition, and supabase-js surfaces it as `error.code`.

begin;

create or replace function public.block_section_delete_during_ingest() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- `packet_deleted_at is not null` means the packet itself is being deleted
  -- and this section is disappearing with it. That is a supported path and is
  -- never blocked; only a DIRECT delete of a targeted section is.
  if exists (
    select 1 from public.ingestion_runs
     where target_section_id = old.id
       and status in ('active','finalizing')
       and packet_deleted_at is null
  ) then
    raise exception 'cannot delete a section while an import is adding to it'
      using errcode = 'FG001',
            detail  = 'section_append_in_progress',
            hint    = 'Finish or discard the import, then delete the section.';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_block_section_delete_during_ingest on public.sections;
create trigger trg_block_section_delete_during_ingest
  before delete on public.sections
  for each row execute function public.block_section_delete_during_ingest();

-- Trigger functions are invoked by the trigger regardless of EXECUTE privilege,
-- so no role needs it. Matching the posture 0012 set for every other trigger
-- function here: revoked from everyone, granted to no one.
revoke all on function public.block_section_delete_during_ingest() from public, anon, authenticated, service_role;

commit;
