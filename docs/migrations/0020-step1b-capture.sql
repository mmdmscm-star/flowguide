-- 0020 STEP 1b — ADDENDUM CAPTURE. STRICTLY READ ONLY.
--
-- Two reasons this exists.
--
-- 1. Step 1 row 15 found `move_item_photos` referencing ingestion_runs, which my
--    inventory did not have. It is benign (see the design note), but it now
--    belongs on the must-not-change list — and Step 1 did not capture its hash.
--    This is the last chance to record a BEFORE value.
--
-- 2. The recorded md5 for block_publish_during_ingest came back 31 characters
--    (`81bd995264f693b970a0dae47e5ba2c`); an md5 is 32. Something clipped it in
--    transit. Re-capturing all three together removes any doubt about which
--    value we are comparing against later.

select p.proname as function,
       md5(pg_get_functiondef(p.oid)) as md5,
       length(md5(pg_get_functiondef(p.oid))) as md5_len   -- must be 32
  from pg_proc p
  join pg_namespace nsp on nsp.oid = p.pronamespace
 where nsp.nspname = 'public'
   and p.proname in ('block_publish_during_ingest','ingest_invalidate_offsets','move_item_photos')
 order by p.proname;
