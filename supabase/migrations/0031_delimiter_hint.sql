-- 0031 - REMEMBER THE DELIMITER THE PROFESSIONAL ALREADY TOLD US.
--
-- When someone picks a .csv or .tsv, the delimiter is a FACT. The record
-- detector otherwise has to infer it from the text, and that inference needs
-- guards — at least three fields, at least three rows, at least one record
-- spanning a newline — which is exactly why an ordinary one-line-per-row CSV is
-- never recognised as a table. Every record is one line; the guard excludes it.
--
-- The hint is stored on the RUN rather than passed only at request time so that
-- a LATER verification reproduces the same decision. Ownership recompute and
-- enforcement both re-derive records from the source text long after the
-- import; without the stored hint they would re-derive them differently from
-- the way the import actually attributed them, which is the "two partitions of
-- the same text" failure the segmenter version guard exists to prevent.
--
-- NO SEGMENTER VERSION BUMP IS OWED, and that is a deliberate property rather
-- than an oversight. `segment()` does not consult the hint: chunk planning for
-- every source, hinted or not, is byte-for-byte what it was. Only ATTRIBUTION
-- reads it, and only after the ordinary strategies have declined — so a hint
-- can add structure where none was provable and can never override or alter a
-- result that was reachable before.
--
-- Nullable with no default: every existing run keeps a NULL hint and therefore
-- behaves exactly as it does today. There is no backfill because there is
-- nothing to backfill — the hint is knowledge that only exists at input time.

begin;

alter table ingestion_runs add column delimiter_hint text;

comment on column ingestion_runs.delimiter_hint is
  'Delimiter the professional implicitly declared by choosing a .csv/.tsv file, or NULL for pasted/unhinted sources. Read only by record attribution, never by segmentation.';

-- Replaced rather than overloaded: adding a defaulted parameter to a new
-- signature would leave both the 9-argument and 10-argument functions resolvable
-- and the call ambiguous. Body below is the live definition with three edited
-- lines and nothing else.
drop function if exists public.create_organize_run(uuid, text, text, text, text, integer, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.create_organize_run(p_owner uuid, p_packet_type text, p_slug text, p_source_text text, p_source_hash text, p_source_len integer, p_request_key text, p_segmenter_version text, p_chunks jsonb, p_delimiter_hint text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_packet uuid; v_run uuid; v_hash text; c jsonb; n int;
begin
  if p_request_key is null or length(p_request_key) < 8 then raise exception 'ingestion: a request key is required'; end if;
  if jsonb_typeof(p_chunks) <> 'array' then raise exception 'ingestion: chunks must be an array'; end if;
  n := jsonb_array_length(p_chunks);
  if n < 1 then raise exception 'ingestion: at least one chunk required'; end if;

  -- Idempotency: an existing run for (owner, request_key) is returned as-is when
  -- the source matches; reuse of the key with a different source is rejected.
  select id, packet_id, source_hash into v_run, v_packet, v_hash
    from public.ingestion_runs where user_id = p_owner and request_key = p_request_key;
  if v_run is not null then
    if v_hash <> p_source_hash then raise exception 'ingestion: request key reused with a different source'; end if;
    return jsonb_build_object('packet_id', v_packet, 'run_id', v_run, 'reused', true);
  end if;

  -- Create packet + run + plan + origin marker. A concurrent identical request
  -- loses the (user_id, request_key) unique race; we roll back its packet insert
  -- and return the winner's packet/run (exactly one of each).
  begin
    insert into public.packets (user_id, slug, packet_type, status)
      values (p_owner, p_slug, coalesce(nullif(p_packet_type,''),'general'), 'draft')
      returning id into v_packet;

    insert into public.ingestion_runs (
      user_id, packet_id, entry_point, source_text, source_hash, source_len, request_key,
      segmenter_version, delimiter_hint, status, total_chunks, completed_chunks, baseline_section_count, baseline_item_count, baseline_content_rev
    ) values (
      p_owner, v_packet, 'organize', p_source_text, p_source_hash, p_source_len, p_request_key,
      p_segmenter_version, nullif(p_delimiter_hint,''), 'active', n, 0, 0, 0, 0
    ) returning id into v_run;

    for c in select value from jsonb_array_elements(p_chunks) loop
      insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_text, segment_hash, section_hint, is_continuation, status)
      values (v_run, (c->>'ordinal')::int, (c->>'source_start')::int, (c->>'source_end')::int,
              c->>'segment_text', coalesce(c->>'segment_hash',''), coalesce(c->>'section_hint',''),
              coalesce((c->>'is_continuation')::boolean, false), 'pending');
    end loop;

    update public.packets set origin_ingestion_run_id = v_run where id = v_packet;
    return jsonb_build_object('packet_id', v_packet, 'run_id', v_run, 'reused', false);
  exception when unique_violation then
    select id, packet_id, source_hash into v_run, v_packet, v_hash
      from public.ingestion_runs where user_id = p_owner and request_key = p_request_key;
    if v_run is null then raise; end if;  -- some other unique conflict
    if v_hash <> p_source_hash then raise exception 'ingestion: request key reused with a different source'; end if;
    return jsonb_build_object('packet_id', v_packet, 'run_id', v_run, 'reused', true);
  end;
end;
$function$;

commit;
