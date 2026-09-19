-- ============================================================================
-- ROLLBACK FOR 0060. Not a migration; kept outside supabase/migrations.
--
-- ORDER MATTERS. Revert and deploy the application FIRST: organize writes this
-- column for any run built from a PDF.
--
-- WHAT IS LOST: the page-by-page manifests of runs whose source is still
-- retained. They are evidence with at most a 30-day remaining life, and the
-- source text they describe is untouched — so this is a loss of debugging
-- provenance, not of anybody's content. It is stated here rather than refused,
-- because nothing a professional wrote or chose lives in this column.
-- ============================================================================

begin;

set local lock_timeout = '3s';

drop trigger if exists trg_ingestion_clear_source_documents on public.ingestion_runs;
drop function if exists public.ingestion_clear_source_documents();

alter table public.ingestion_runs
  drop constraint if exists ingestion_runs_source_documents_with_source,
  drop constraint if exists ingestion_runs_source_documents_shape,
  drop column if exists source_documents;

drop function if exists public.ingestion_source_documents_valid(jsonb);

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'ingestion_runs'
                and column_name = 'source_documents')
     or to_regprocedure('public.ingestion_source_documents_valid(jsonb)') is not null
     or to_regprocedure('public.ingestion_clear_source_documents()') is not null then
    raise exception 'ROLLBACK 0060 INCOMPLETE: an 0060 object survived.';
  end if;
end $$;

commit;
