-- 0026 BEHAVIOUR PROOF. Ends in ROLLBACK; the file contains no COMMIT, so
-- nothing it creates can persist even if it errors partway.
begin;
create temp table v(ord int, check_name text, expected text, actual text) on commit drop;

do $verify$
declare
  v_owner uuid; v_pk uuid; v_run uuid; v_run2 uuid; v_chunk uuid;
  v_seg text; v_led jsonb; v_exp timestamptz; v_del timestamptz; v_pid uuid;
  v_status text; v_err text; v_rows int; v_lib uuid;
begin
  select id into v_owner from public.users order by created_at limit 1;

  -- ---- DISCARD retains evidence, deletes the draft, keeps the run ----------
  insert into public.packets (user_id, slug) values (v_owner, 'zz-0026-'||gen_random_uuid()) returning id into v_pk;
  v_run := gen_random_uuid();
  insert into public.ingestion_runs (id, user_id, packet_id, destination, entry_point, source_text,
                                     source_hash, source_len, segmenter_version, status, error)
    values (v_run, v_owner, v_pk, 'packet', 'organize', 'Community Fee: $3,500',
            'h0026', 21, 'seg-v4', 'active', 'the original failure reason');
  insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_text, segment_hash,
                                       status, result, fact_ledger)
    values (v_run, 0, 0, 21, 'Community Fee: $3,500', 'c0', 'completed',
            '{"items":[]}'::jsonb, '{"counts":{"detected":1}}'::jsonb);
  update public.packets set origin_ingestion_run_id = v_run where id = v_pk;

  perform public.discard_ingestion_run(v_run, v_owner);

  select status, error, packet_id, packet_deleted_at, evidence_purge_after
    into v_status, v_err, v_pid, v_del, v_exp from public.ingestion_runs where id = v_run;
  select segment_text, fact_ledger into v_seg, v_led from public.ingestion_chunks where run_id=v_run and ordinal=0;
  select count(*) into v_rows from public.packets where id = v_pk;

  insert into v values (1,'discard: the RUN survives its deleted draft','run=present packet_row=0 packet_id=null stamped=yes',
    'run='||(case when v_status is null then 'GONE' else 'present' end)||
    ' packet_row='||v_rows||
    ' packet_id='||(case when v_pid is null then 'null' else 'STILL SET' end)||
    ' stamped='||(case when v_del is null then 'NO' else 'yes' end));
  insert into v values (2,'discard: diagnostic evidence RETAINED','segment=kept ledger=kept error=kept expiry=stamped',
    'segment='||(case when v_seg is null then 'CLEARED' else 'kept' end)||
    ' ledger='||(case when v_led is null then 'CLEARED' else 'kept' end)||
    ' error='||(case when coalesce(v_err,'')='' then 'CLEARED' else 'kept' end)||
    ' expiry='||(case when v_exp is null then 'MISSING' else 'stamped' end));
  insert into v values (3,'discard: run is not active, so not resumable','discarded', coalesce(v_status,'GONE'));

  -- ---- PURGE clears everything retained, and deletes the expired orphan ----
  update public.ingestion_runs set evidence_purge_after = now() - interval '1 day' where id = v_run;
  perform public.purge_ingestion_evidence();
  select count(*) into v_rows from public.ingestion_runs where id = v_run;
  insert into v values (4,'purge: expired ORPHAN run is deleted','0', v_rows::text);
  select count(*) into v_rows from public.ingestion_chunks where run_id = v_run;
  insert into v values (5,'purge: its chunks go with it','0', v_rows::text);

  -- ---- PROVENANCE GUARD: an orphan referenced by a Library item survives ---
  insert into public.packets (user_id, slug) values (v_owner, 'zz-0026b-'||gen_random_uuid()) returning id into v_pk;
  v_run2 := gen_random_uuid();
  insert into public.ingestion_runs (id, user_id, packet_id, destination, entry_point, source_text,
                                     source_hash, source_len, segmenter_version, status)
    values (v_run2, v_owner, v_pk, 'packet', 'organize', 'x', 'h2', 1, 'seg-v4', 'active');
  insert into public.library_items (user_id, title, origin_run_id, origin_chunk_ordinal, origin_item_index)
    values (v_owner, 'zz-0026 provenance holder', v_run2, 0, 0) returning id into v_lib;
  delete from public.packets where id = v_pk;                 -- trigger stamps the run
  update public.ingestion_runs set evidence_purge_after = now() - interval '1 day' where id = v_run2;
  perform public.purge_ingestion_evidence();
  select count(*) into v_rows from public.ingestion_runs where id = v_run2;
  insert into v values (6,'purge: an orphan still referenced by a Library item is KEPT','1', v_rows::text);
  select source_text into v_seg from public.ingestion_runs where id = v_run2;
  insert into v values (7,'...but its CONTENT is still purged','cleared',
    case when v_seg is null then 'cleared' else 'KEPT' end);

  -- ---- The trigger stamps on ANY packet delete, not just discard ----------
  select packet_deleted_at into v_del from public.ingestion_runs where id = v_run2;
  insert into v values (8,'trigger: packet delete stamps packet_deleted_at','yes',
    case when v_del is null then 'NO' else 'yes' end);
exception when others then
  insert into v values (99,'BEHAVIOUR PROOF','completed','ERROR: '||SQLERRM);
end
$verify$;

select ord, check_name, expected, actual,
       case when actual = expected then 'PASS' else 'FAIL' end as result
from v order by ord;

rollback;
