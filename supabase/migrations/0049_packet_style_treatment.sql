-- 0049 - ONE PRESENTATION CHOICE: WHICH TREATMENT A SENDSET WEARS.
--
-- A treatment is a whole coherent look - a palette, a type scale, a set of
-- structural decisions - authored in src/lib/style/treatment.ts and resolved
-- per medium by the recipient page, Preview, print and email. Three exist:
-- `default` (the shipped Sendset look), `warm` and `editorial`. This column is
-- how a packet says which one it wears.
--
-- PRESENTATION, NOT CONTENT - AND THE SCHEMA ALREADY KNOWS THE DIFFERENCE.
-- ingest_bump_packet_self() bumps content_rev only when one of title,
-- client_name, personal_note, map_url, identity_mode, custom_identity or
-- composition_mode changes. style_treatment is deliberately NOT in that list,
-- so choosing a look does not bump content_rev and cannot disturb ingestion
-- offsets or the block/item bijection that revision guards. structural_rev is
-- moved only by the CHILD triggers (0034) and is untouched by anything here.
-- Adding this column to either list later would be reclassifying a display
-- preference as content - don't. The migration does not merely assert that; it
-- PROVES it on a real packet below.
--
-- NOT NULL DEFAULT 'default', so every packet that exists today keeps exactly
-- the look it has today. No backfill, no second step, no window in which a
-- Sendset someone has already sent changes appearance. Postgres stores a
-- non-volatile default without rewriting the table.
--
-- MUTABLE AFTER PUBLISH, on purpose, and with no republish. professional_snapshot
-- is frozen at publish time because a recipient must keep seeing the identity
-- they were actually sent. This is the opposite kind of state: it changes what
-- an already-shared link renders the next time it is opened, which is the same
-- contract title, personal_note and show_quick_nav (0030) already have. The
-- recipient page and the print route are force-dynamic and the email version is
-- built on demand, so a saved choice is live on the next open.
--
-- A CHECK RATHER THAN AN ENUM. Adding a value to a Postgres enum is
-- irreversible and awkward inside a transaction; a CHECK constraint is dropped
-- and recreated in one transaction when a fourth treatment ships. The cost is
-- that adding a treatment needs a migration as well as a deploy, in that order.
--
-- UNKNOWN VALUES ARE SAFE ON THE READ SIDE. treatmentByName() falls back to the
-- default treatment for any name it does not recognise, so a value written by a
-- newer deploy, or left behind by a treatment that was later withdrawn, renders
-- as Default rather than blanking a recipient's page.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT TOUCH: RLS, policies, grants, roles,
-- auth, professional_snapshot, any trigger, and any function. In particular it
-- CREATES OR REPLACES NOTHING - so there is no signature to change and no
-- EXECUTE grant that could be silently reset to PUBLIC. The new column inherits
-- the table's existing ACL; no privilege is issued to anyone. The privilege
-- assertions below observe that state, they do not create it.
--
-- ONE PRECHECK RESULT THIS DEPENDS ON (production, at drafting): RLS is enabled
-- on public.packets, the table carries ZERO policies, anon and authenticated
-- hold no table or column UPDATE privilege, and service_role owns the effective
-- write path. Nothing here changes any of that; the guards below refuse to
-- proceed if it has stopped being true.

begin;

-- ---------------------------------------------------------------------------
-- 1. DRIFT GUARD, BEFORE ANY DDL.
--
-- The whole safety argument for this column rests on one function's body. Do
-- not take the repo's word for what production runs - measure it, and refuse to
-- continue if a single byte differs.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
  src text;
  secdef boolean;
  cfg text[];
begin
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'ingest_bump_packet_self';
  if n <> 1 then
    raise exception
      'MIGRATION 0049 ABORTED: expected exactly one public.ingest_bump_packet_self(), found %.', n;
  end if;

  select p.prosrc, p.prosecdef, p.proconfig into src, secdef, cfg
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'ingest_bump_packet_self';

  if md5(src) <> 'a70a51fc101d15acabc6e5be97de8b96' then
    raise exception
      'MIGRATION 0049 ABORTED: ingest_bump_packet_self() body md5 is %, expected a70a51fc101d15acabc6e5be97de8b96. Production has drifted from migration 0012; reconcile before adding a column whose safety depends on this function.',
      md5(src);
  end if;
  if length(src) <> 363 then
    raise exception
      'MIGRATION 0049 ABORTED: ingest_bump_packet_self() body length is %, expected 363.', length(src);
  end if;
  if not secdef then
    raise exception
      'MIGRATION 0049 ABORTED: ingest_bump_packet_self() is no longer SECURITY DEFINER.';
  end if;
  if cfg is null or not ('search_path=""' = any(cfg)) then
    raise exception
      'MIGRATION 0049 ABORTED: ingest_bump_packet_self() proconfig is %, expected search_path="".',
      coalesce(array_to_string(cfg, ', '), '(null)');
  end if;
  if position('style_treatment' in src) > 0 then
    raise exception
      'MIGRATION 0049 ABORTED: ingest_bump_packet_self() already references style_treatment, so a style change would bump content_rev.';
  end if;

  raise notice
    '0049 guard: ingest_bump_packet_self() is byte-identical to 0012 (md5 %, % chars, security definer, search_path="") and does not watch style_treatment.',
    md5(src), length(src);
end $$;

-- The behavioural proof reads both revision counters, so both must be here.
do $$
begin
  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.packets'::regclass
                    and attname = 'content_rev' and not attisdropped) then
    raise exception 'MIGRATION 0049 ABORTED: packets.content_rev is missing.';
  end if;
  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.packets'::regclass
                    and attname = 'structural_rev' and not attisdropped) then
    raise exception 'MIGRATION 0049 ABORTED: packets.structural_rev is missing (migration 0034 has not been applied).';
  end if;
  if exists (select 1 from pg_attribute
              where attrelid = 'public.packets'::regclass
                and attname = 'style_treatment' and not attisdropped) then
    raise exception 'MIGRATION 0049 ABORTED: packets.style_treatment already exists. 0049 has already been applied.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. THE COLUMN.
-- ---------------------------------------------------------------------------
alter table public.packets
  add column style_treatment text not null default 'default';

alter table public.packets
  add constraint packets_style_treatment_known
  check (style_treatment in ('default', 'warm', 'editorial'));

comment on column public.packets.style_treatment is
  'Recipient PRESENTATION metadata: which visual treatment this Sendset wears (default | warm | editorial). Not content - deliberately excluded from ingest_bump_packet_self(), so changing it moves neither content_rev nor structural_rev. Live and mutable after publish with no republish, exactly as show_quick_nav (0030) is; never frozen into professional_snapshot. An unrecognised value renders as the default treatment rather than failing.';

-- ---------------------------------------------------------------------------
-- 3. STRUCTURAL POST-VERIFICATION.
-- ---------------------------------------------------------------------------
do $$
declare
  notnull_ok boolean;
  dflt text;
  condef text;
  bad bigint;
  src text;
begin
  select a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
    into notnull_ok, dflt
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.packets'::regclass
     and a.attname = 'style_treatment' and not a.attisdropped;

  if notnull_ok is null then
    raise exception 'MIGRATION 0049 ABORTED: packets.style_treatment was not created.';
  end if;
  if not notnull_ok then
    raise exception 'MIGRATION 0049 ABORTED: packets.style_treatment is not NOT NULL.';
  end if;
  if dflt is distinct from '''default''::text' then
    raise exception 'MIGRATION 0049 ABORTED: packets.style_treatment default is %, expected ''default''::text.',
      coalesce(dflt, '(none)');
  end if;

  select pg_get_constraintdef(c.oid) into condef
    from pg_constraint c
   where c.conrelid = 'public.packets'::regclass
     and c.conname = 'packets_style_treatment_known'
     and c.contype = 'c';
  if condef is null then
    raise exception 'MIGRATION 0049 ABORTED: the packets_style_treatment_known CHECK constraint is missing.';
  end if;
  if condef !~ 'default' or condef !~ 'warm' or condef !~ 'editorial' then
    raise exception 'MIGRATION 0049 ABORTED: the CHECK constraint does not name all three treatments: %', condef;
  end if;

  select count(*) into bad from public.packets where style_treatment <> 'default';
  if bad <> 0 then
    raise exception 'MIGRATION 0049 ABORTED: % existing packet(s) are not on the default treatment.', bad;
  end if;

  -- The guard again, after the DDL: nothing in this migration may have taught
  -- the trigger about the new column.
  select p.prosrc into src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'ingest_bump_packet_self';
  if md5(src) <> 'a70a51fc101d15acabc6e5be97de8b96'
     or position('style_treatment' in src) > 0 then
    raise exception 'MIGRATION 0049 ABORTED: ingest_bump_packet_self() changed during this migration.';
  end if;

  raise notice
    '0049 verify: style_treatment exists, NOT NULL, default ''default'', CHECK (%) present, all packets on default, trigger unchanged.',
    condef;
end $$;

-- ---------------------------------------------------------------------------
-- 4. PRIVILEGE POST-VERIFICATION.
--
-- OBSERVED, NEVER ARRANGED. This migration issues no GRANT and no REVOKE. If an
-- assertion here fails, the privilege pre-dates 0049 and must be resolved on its
-- own terms - do not "fix" it by granting or revoking inside this file.
-- ---------------------------------------------------------------------------
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if to_regrole(r) is null then
      raise exception
        'MIGRATION 0049 ABORTED: role % does not exist, so its privilege on the new column cannot be asserted. This is not the database 0049 was validated against.', r;
    end if;
    if has_table_privilege(r, 'public.packets', 'UPDATE')
       or has_column_privilege(r, 'public.packets', 'style_treatment', 'UPDATE') then
      raise exception
        'MIGRATION 0049 ABORTED: % can UPDATE packets.style_treatment. 0049 granted nothing, so this privilege pre-dates it; resolve it separately rather than here.', r;
    end if;
  end loop;

  if to_regrole('service_role') is null then
    raise exception 'MIGRATION 0049 ABORTED: role service_role does not exist; the application writes through it.';
  end if;
  if not has_column_privilege('service_role', 'public.packets', 'style_treatment', 'UPDATE') then
    raise exception
      'MIGRATION 0049 ABORTED: service_role cannot UPDATE packets.style_treatment, so the selector could never save.';
  end if;

  raise notice
    '0049 verify: anon and authenticated cannot write style_treatment; service_role can. No privilege was issued by this migration.';
end $$;

-- ---------------------------------------------------------------------------
-- 5. BEHAVIOURAL PROOF, ON A REAL PACKET.
--
-- An md5 proves the trigger's TEXT has not changed. Only an update proves what
-- it DOES. This writes style_treatment on one real row, checks that neither
-- revision counter moved, and then throws the write away with ROLLBACK TO
-- SAVEPOINT - not with a second update, which would leave updated_at moved and
-- would itself have to be trusted.
--
-- The before-state is captured OUTSIDE the savepoint so it survives the
-- rollback and can be compared against afterwards.
-- ---------------------------------------------------------------------------
create temp table style_probe_before on commit drop as
  select id, status, content_rev, structural_rev, updated_at, style_treatment
    from public.packets
   order by (status = 'published') desc, id
   limit 1;

do $$
begin
  if (select count(*) from style_probe_before) <> 1 then
    raise exception
      'MIGRATION 0049 ABORTED: there is no packet to probe, so the behavioural proof cannot run. An empty packets table is unexpected here, and this migration will not report success for a proof it did not perform.';
  end if;
end $$;

savepoint style_probe;

update public.packets
   set style_treatment = 'warm'
 where id = (select id from style_probe_before);

do $$
declare b record; a record;
begin
  select * into b from style_probe_before;
  select content_rev, structural_rev, updated_at, style_treatment into a
    from public.packets where id = b.id;

  -- THE WRITE MUST ACTUALLY HAVE HAPPENED, or "nothing moved" proves nothing.
  if a.style_treatment <> 'warm' then
    raise exception
      'MIGRATION 0049 ABORTED: the probe update did not take on packet %; the proof would be vacuous.', b.id;
  end if;

  if a.content_rev <> b.content_rev then
    raise exception
      'MIGRATION 0049 ABORTED: content_rev moved % -> % on a style-only update of packet %.',
      b.content_rev, a.content_rev, b.id;
  end if;
  if a.structural_rev <> b.structural_rev then
    raise exception
      'MIGRATION 0049 ABORTED: structural_rev moved % -> % on a style-only update of packet %.',
      b.structural_rev, a.structural_rev, b.id;
  end if;

  raise notice
    '0049 proof: packet % (status %) default -> warm. content_rev % unchanged, structural_rev % unchanged, updated_at %.',
    b.id, b.status, b.content_rev, b.structural_rev,
    case when a.updated_at is distinct from b.updated_at
         then 'moved, so the row really was written'
         else 'unchanged' end;
end $$;

-- And the constraint bites rather than merely existing.
do $$
declare pid uuid;
begin
  select id into pid from style_probe_before;
  begin
    update public.packets set style_treatment = 'not-a-treatment' where id = pid;
    raise exception
      'MIGRATION 0049 ABORTED: the CHECK constraint accepted an unknown treatment.';
  exception when check_violation then
    raise notice '0049 proof: the CHECK constraint rejected an unknown treatment.';
  end;
end $$;

rollback to savepoint style_probe;
release savepoint style_probe;

-- The probe must have left nothing behind - updated_at included.
do $$
declare b record; a record;
begin
  select * into b from style_probe_before;
  select content_rev, structural_rev, updated_at, style_treatment into a
    from public.packets where id = b.id;
  if a.style_treatment <> 'default'
     or a.content_rev is distinct from b.content_rev
     or a.structural_rev is distinct from b.structural_rev
     or a.updated_at is distinct from b.updated_at then
    raise exception
      'MIGRATION 0049 ABORTED: the probe left packet % changed (style %, content_rev %, structural_rev %, updated_at moved %).',
      b.id, a.style_treatment, a.content_rev, a.structural_rev,
      (a.updated_at is distinct from b.updated_at);
  end if;
  raise notice
    '0049 proof: the probe left packet % byte-identical, updated_at included.', b.id;
end $$;

commit;
