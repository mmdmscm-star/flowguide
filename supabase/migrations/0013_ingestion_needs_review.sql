-- ============================================================
-- 0013 — needs_review: exact media accounting must be able to STOP a run.
--
-- Migration 0012 gave a run three terminal outcomes: finalized, discarded,
-- error. None of them can express "the content was applied, but it provably
-- does not match the source." That gap is why three photos could leave a packet
-- with no error and no warning, and why that packet was then published.
--
-- `needs_review` is a NON-TERMINAL state entered on an OBJECTIVE accounting
-- failure — media missing, media stored more than once, or media stored that is
-- absent from the source. It is not for heuristic suspicion; a weak quality
-- signal warns and does not block.
--
-- Additive and backward-compatible: existing rows keep their status, and a run
-- that accounts cleanly never touches any of this.
-- See docs/investigations/mid-record-chunk-splits-plan.md.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The new status.
-- ------------------------------------------------------------
alter table public.ingestion_runs
  drop constraint if exists ingestion_runs_status_check;

alter table public.ingestion_runs
  add constraint ingestion_runs_status_check
  check (status in ('active', 'finalizing', 'finalized', 'discarded', 'error', 'needs_review'));

-- ------------------------------------------------------------
-- 2. What needs reviewing. Structured so the editor can render each unresolved
--    item WITH the source offset it came from — a professional cannot adjudicate
--    ownership from a count, only from seeing where the media sat.
-- ------------------------------------------------------------
alter table public.ingestion_runs
  add column if not exists review jsonb not null default '{}'::jsonb;

comment on column public.ingestion_runs.review is
  'Objective accounting failures: {ok, summary, failures:[{code,url,offset,itemIds}]}. Empty when the run accounted cleanly.';

-- ------------------------------------------------------------
-- 3. needs_review is NON-TERMINAL, so it must occupy the one-active-run slot.
--    Without this a second Organize could start on a packet awaiting review and
--    finalize into the same packet.
-- ------------------------------------------------------------
drop index if exists idx_ingestion_runs_one_active;
create unique index idx_ingestion_runs_one_active
  on public.ingestion_runs(packet_id)
  where status in ('active', 'finalizing', 'needs_review');

-- ------------------------------------------------------------
-- 4. Publishing is blocked while a run needs review.
--
--    0012 already refuses to publish while an import is ACTIVE. The same
--    guarantee has to extend to a run whose content is applied but unaccounted:
--    the whole point of exact accounting is that a packet which provably does
--    not match its source cannot be sent to a client.
-- ------------------------------------------------------------
--    Replaces the EXISTING function in place (same name, same empty search_path,
--    same trigger) so the already-installed trg_block_publish_during_ingest
--    picks it up. Creating a differently-named function here would leave an
--    orphan that no trigger calls, and the guard would silently not apply.
create or replace function public.block_publish_during_ingest() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    if exists (select 1 from public.ingestion_runs
               where packet_id = new.id and status in ('active','finalizing','needs_review')) then
      raise exception 'cannot publish while an import is in progress or needs review';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.block_publish_during_ingest() from public, anon, authenticated, service_role;
