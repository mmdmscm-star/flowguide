-- 0029 PREFLIGHT — READ ONLY. Creates nothing, changes nothing.
with c as (
  select 1::numeric as ord, 'schema is at 0028 — review_units exists' as check_name, '1' as expected,
         (select count(*)::text from information_schema.columns
           where table_schema='public' and table_name='ingestion_chunks' and column_name='review_units') as actual
  union all
  select 2, 'the packet-photos bucket does NOT exist yet', '0',
         (select count(*)::text from storage.buckets where id='packet-photos')
  union all
  select 3, 'storage schema is reachable at all', 'true',
         (select (count(*) >= 0)::text from storage.buckets)
  union all
  -- item_photos.storage_path stays '' in this migration; nothing depends on it
  -- being populated, and the creator rule reads the URL instead.
  select 4, 'item_photos.storage_path exists (unused, stays empty)', '1',
         (select count(*)::text from information_schema.columns
           where table_schema='public' and table_name='item_photos' and column_name='storage_path')
  union all
  select 5, 'no existing policy would conflict by name', '0',
         (select count(*)::text from pg_policies
           where schemaname='storage' and tablename='objects'
             and policyname='packet photos are publicly readable')
  union all
  select 6, 'existing photos, all external today', 'report',
         (select count(*)::text from public.item_photos)
  union all
  select 7, 'photos already under the new bucket path (should be none)', '0',
         (select count(*)::text from public.item_photos
           where url ~ '/storage/v1/object/public/packet-photos/')
  union all
  select 8, 'storage.objects RLS is on', 'true',
         (select relrowsecurity::text from pg_class where oid='storage.objects'::regclass)
)
select ord, check_name, expected, actual,
       case when expected='report' then 'INFO' when expected=actual then 'PASS' else 'FAIL' end as result
from c order by ord;
