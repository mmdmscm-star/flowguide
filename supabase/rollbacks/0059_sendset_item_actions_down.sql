-- ============================================================================
-- ROLLBACK FOR 0059. Not a migration; kept outside supabase/migrations.
--
-- ORDER MATTERS. Revert and deploy the application FIRST. Without these objects
-- the item-action endpoints fail.
--
-- REFUSES ONCE ANYBODY HAS USED IT. An action session is somebody's expressed
-- preference and a like line is what they said about an item; 0058 has nowhere
-- to put either, so undoing 0059 while they exist would either destroy them or
-- misrepresent them as correspondence. Both are refusals, not choices this
-- script makes quietly. Delete them deliberately first if that is really meant.
--
-- REFUSES WHILE ANY SENDSET STILL ACCEPTS 'like', because restoring 0058's
-- CHECK would otherwise fail — and stripping the value would silently change a
-- creator's setting.
--
-- With only 0058-era messages present it is LOSSLESS: every message submission
-- and respond line is left byte-for-byte as it was.
-- ============================================================================

begin;

set local lock_timeout = '3s';

do $$
declare n int;
begin
  if to_regclass('public.sendset_responses') is null then
    raise exception 'ROLLBACK 0059 REFUSED: 0058 is not applied; there is nothing to roll back to.';
  end if;

  select count(*) into n from public.sendset_responses where kind = 'actions';
  if n > 0 then
    raise exception 'ROLLBACK 0059 REFUSED: % action session(s) exist. 0058 cannot hold them. Delete them deliberately first.', n;
  end if;

  select count(*) into n from public.sendset_response_lines where action = 'like';
  if n > 0 then
    raise exception 'ROLLBACK 0059 REFUSED: % like line(s) exist. Delete them deliberately first.', n;
  end if;

  select count(*) into n from public.packets where 'like' = any (response_actions);
  if n > 0 then
    raise exception 'ROLLBACK 0059 REFUSED: % Sendset(s) still accept item actions. Turn Like off first.', n;
  end if;

  -- A message with no marker cannot exist under 0058's NOT NULL. If one did,
  -- restoring it would fail halfway; say so before anything is dropped.
  select count(*) into n from public.sendset_responses
   where live_publication_published_at is null or rendered_publication_was_current is null;
  if n > 0 then
    raise exception 'ROLLBACK 0059 REFUSED: % submission(s) carry no publication marker.', n;
  end if;
end $$;

drop function if exists public.read_sendset_session_actions(text, bytea);
drop function if exists public.clear_sendset_item_action(text, bytea, uuid, text);
drop function if exists public.set_sendset_item_action(text, text, bytea, text, text, uuid, text);
drop function if exists public.sendset_publication_item(jsonb, uuid);

drop table if exists public.sendset_action_rate;

alter table public.sendset_response_lines
  drop constraint if exists sendset_response_lines_parent_kind_fkey,
  drop constraint if exists sendset_response_lines_action_matches_parent,
  drop constraint if exists sendset_response_lines_like_shape,
  drop constraint if exists sendset_response_lines_respond_shape,
  drop column if exists parent_kind,
  drop column if exists live_publication_published_at,
  drop column if exists rendered_publication_was_current;

alter table public.sendset_response_lines drop constraint if exists sendset_response_lines_action_known;
alter table public.sendset_response_lines
  add constraint sendset_response_lines_action_known check (action in ('respond'));

drop index if exists public.sendset_responses_capability;

alter table public.sendset_responses
  drop constraint if exists sendset_responses_shape,
  drop constraint if exists sendset_responses_kind_known,
  drop constraint if exists sendset_responses_session_hash_shape,
  drop constraint if exists sendset_responses_mutations_nonneg,
  drop constraint if exists sendset_responses_id_kind,
  drop column if exists kind,
  drop column if exists session_hash,
  drop column if exists updated_at,
  drop column if exists mutation_window_start,
  drop column if exists mutations_in_window;

alter table public.sendset_responses
  alter column live_publication_published_at    set not null,
  alter column rendered_publication_was_current set not null;

alter table public.packets drop constraint if exists packets_response_actions_known;
alter table public.packets
  add constraint packets_response_actions_known
  check (response_actions <@ array['respond']::text[]);

comment on column public.packets.response_actions is
  'Response actions the published page accepts (0058). Empty = responses off. Live on the Sendset rather than frozen into its publication, so switching responses off takes effect immediately. Excluded from draft_rev and content_rev. Never copied into a publication.';

do $$
begin
  if to_regclass('public.sendset_action_rate') is not null
     or to_regprocedure('public.set_sendset_item_action(text,text,bytea,text,text,uuid,text)') is not null
     or to_regprocedure('public.clear_sendset_item_action(text,bytea,uuid,text)') is not null
     or to_regprocedure('public.read_sendset_session_actions(text,bytea)') is not null
     or to_regprocedure('public.sendset_publication_item(jsonb,uuid)') is not null
     or exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'sendset_responses'
                   and column_name in ('kind', 'session_hash', 'updated_at',
                                       'mutation_window_start', 'mutations_in_window'))
     or exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'sendset_response_lines'
                   and column_name in ('parent_kind', 'live_publication_published_at',
                                       'rendered_publication_was_current')) then
    raise exception 'ROLLBACK 0059 INCOMPLETE: an 0059 object survived.';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'sendset_responses'
                and column_name = 'live_publication_published_at' and is_nullable = 'YES') then
    raise exception 'ROLLBACK 0059 INCOMPLETE: the publication marker is still nullable.';
  end if;
end $$;

commit;
