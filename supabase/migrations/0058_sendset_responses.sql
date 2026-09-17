-- ============================================================================
-- 0058 — SENDSET RESPONSES: somebody can answer a Sendset, and the professional
-- hears about it.
--
-- WHAT THIS IS NOT. There is no recipient here. The same link may reach one
-- person, a family, or the public, and Sendset cannot know which — so nothing
-- records an audience, nothing identifies a person beyond what they typed, and
-- nothing about responses is ever shown to anyone holding the link.
--
--   public.packets.response_actions        what the published page accepts.
--                                          '{}' (the default) = responses off.
--   public.sendset_responses               ONE SUBMISSION: somebody, once,
--                                          signed however they chose.
--   public.sendset_response_lines          WHAT THEY SAID: a target and an
--                                          action. v1 writes exactly one
--                                          Sendset-level 'respond' line.
--   public.record_sendset_response(...)    the only way to write either table.
--   public.mark_sendset_response_notified  records that the owner's email went.
--   public.delete_sendset(owner, id, n)    the ONLY way to delete a Sendset that
--                                          has responses: with an exact,
--                                          acknowledged count.
--
-- THE PUBLICATION MARKER. The page renders the live publication's published_at
-- as an opaque string and the browser sends it back. The function reads the
-- live publication ITSELF, stores that server-read value, and stores whether
-- the two were equal — compared here, in PostgreSQL, never in JavaScript,
-- whose Date type silently drops the microseconds now() writes.
--
--   * The returned marker is supplied by a browser and is not independently
--     trustworthy. `rendered_publication_was_current` is a best-effort property
--     of the normal response flow. It is NOT proof of what anybody saw.
--   * published_at identifies a publication EVENT. The content of an earlier
--     publication is not retained after Republish and cannot be shown.
--   * published_at is NOT monotonic: publish_packet writes the transaction's
--     START time, so a republish that waited on the row lock can write an
--     earlier value than the one it replaced. Compare for equality only.
--
-- Nothing here touches packet_publications or publish_packet.
--
-- A RESPONSE CANNOT BE DESTROYED BY DELETING ITS SENDSET BEHIND THE CREATOR'S
-- BACK. Both foreign keys into this data are ON DELETE RESTRICT, so ANY
-- deletion of a Sendset — the route, the ingestion functions that discard empty
-- drafts, a script, a cascade from a deleted user — is refused by the database
-- while that Sendset still has responses. The one exception is
-- delete_sendset, which removes the responses itself, and only after locking
-- the Sendset and finding the exact count the creator acknowledged. The lock is
-- what makes that count exact; RESTRICT is what makes every OTHER path safe.
--
-- GRANTS: anon and authenticated get nothing on any object. service_role may
-- SELECT both tables (the owner's read path) and EXECUTE the three functions;
-- it has no INSERT, UPDATE or DELETE, so every write goes through a function.
--
-- ROLLBACK: supabase/rollbacks/0058_sendset_responses_down.sql.
-- ============================================================================

begin;

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'packets'
                and column_name = 'response_actions') then
    raise exception 'MIGRATION 0058 ABORTED: packets.response_actions already exists.';
  end if;
  if to_regclass('public.sendset_responses') is not null
     or to_regclass('public.sendset_response_lines') is not null then
    raise exception 'MIGRATION 0058 ABORTED: a responses table already exists.';
  end if;
  if to_regprocedure('public.record_sendset_response(text,text,text,text,text)') is not null
     or to_regprocedure('public.mark_sendset_response_notified(uuid)') is not null
     or to_regprocedure('public.delete_sendset(uuid,uuid,integer)') is not null then
    raise exception 'MIGRATION 0058 ABORTED: a responses function already exists.';
  end if;
  -- What this is written against.
  if to_regprocedure('public.record_packet_view(text)') is null then
    raise exception 'MIGRATION 0058 ABORTED: 0057 is not applied.';
  end if;
  if to_regprocedure('public.draft_rev_packet_self()') is null
     or to_regprocedure('public.ingest_bump_packet_self()') is null
     or to_regclass('public.packet_publications') is null then
    raise exception 'MIGRATION 0058 ABORTED: the publication spine is not the one this was written against.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. CONFIGURATION.
--
-- On the Sendset, NOT in the frozen publication: turning responses off takes
-- effect on the next request, with no Republish. Outside the draft_rev and
-- content_rev column tuples, so toggling it never reads as "Changes not
-- published" — proved below.
-- ---------------------------------------------------------------------------
alter table public.packets
  add column response_actions text[] not null default '{}';

alter table public.packets
  add constraint packets_response_actions_known
  check (response_actions <@ array['respond']::text[]);

comment on column public.packets.response_actions is
  'Response actions the published page accepts (0058). Empty = responses off. Live on the Sendset rather than frozen into its publication, so switching responses off takes effect immediately. Excluded from draft_rev and content_rev. Never copied into a publication.';

-- ---------------------------------------------------------------------------
-- 2. ONE SUBMISSION.
-- ---------------------------------------------------------------------------
create table public.sendset_responses (
  id                                uuid        primary key default gen_random_uuid(),
  -- RESTRICT, NOT CASCADE. A Sendset with responses cannot be deleted by any
  -- path except delete_sendset (section 6).
  packet_id                         uuid        not null references public.packets(id) on delete restrict,
  -- Copied from packets.user_id by record_sendset_response. Routing is always
  -- to the owner's account, whatever sender identity the Sendset displays.
  -- RESTRICT for the same reason: deleting an account must not silently
  -- destroy correspondence addressed to it.
  owner_user_id                     uuid        not null references public.users(id)   on delete restrict,

  live_publication_published_at     timestamptz not null,
  rendered_publication_was_current  boolean     not null,

  -- SELF-ASSERTED and unverified. Nullable: whether a name or contact is
  -- required is policy, enforced by the endpoint. Stored trimmed, never blank.
  responder_name                    text,
  responder_contact                 text,

  -- Decided at insert, under the Sendset's row lock: false once this Sendset
  -- has used its hourly notification allowance. Such a response is never
  -- emailed and is still listed for the owner.
  notification_due                  boolean     not null,
  created_at                        timestamptz not null default now(),
  -- Set only once the owner's email is confirmed sent. due and null = a send
  -- that failed or has not completed, which stays visible rather than silent.
  notified_at                       timestamptz,

  constraint sendset_responses_name_shape check (
    responder_name is null
    or (char_length(responder_name) between 1 and 120
        and responder_name = btrim(responder_name, E' \t\r\n'))),
  constraint sendset_responses_contact_shape check (
    responder_contact is null
    or (char_length(responder_contact) between 1 and 200
        and responder_contact = btrim(responder_contact, E' \t\r\n'))),
  constraint sendset_responses_notified_only_when_due check (notified_at is null or notification_due)
);

comment on table public.sendset_responses is
  'One response submission to a published Sendset (0058). Names and contact details are what the person typed and are not verified. Never shown to anyone holding the link. rendered_publication_was_current is a best-effort property of the normal response flow, not proof of what anybody saw; the content live at live_publication_published_at is not retained.';

-- The owner's list, newest first; and the rate-limit windows.
create index sendset_responses_packet_created on public.sendset_responses (packet_id, created_at desc);
create index sendset_responses_created on public.sendset_responses (created_at);

-- ---------------------------------------------------------------------------
-- 3. WHAT THEY SAID.
-- ---------------------------------------------------------------------------
create table public.sendset_response_lines (
  id              uuid primary key default gen_random_uuid(),
  response_id     uuid not null references public.sendset_responses(id) on delete cascade,

  target_kind     text not null,
  -- No FK: an item can be deleted after a response about it exists.
  target_item_id  uuid,
  -- The item's title as published, copied server-side. Null for the Sendset.
  target_label    text,

  action          text not null,
  note            text,

  constraint sendset_response_lines_target_kind_known check (target_kind in ('sendset', 'item')),
  constraint sendset_response_lines_item_target_has_id check ((target_kind = 'item') = (target_item_id is not null)),
  constraint sendset_response_lines_sendset_target_has_no_label check (target_kind = 'item' or target_label is null),
  constraint sendset_response_lines_label_length check (target_label is null or char_length(target_label) between 1 and 500),
  constraint sendset_response_lines_action_known check (action in ('respond')),
  -- A Respond IS a message. The action's meaning, not creator policy.
  constraint sendset_response_lines_respond_has_note check (action <> 'respond' or note is not null),
  constraint sendset_response_lines_note_shape check (
    note is null
    or (char_length(note) between 1 and 4000
        and note = btrim(note, E' \t\r\n'))),
  constraint sendset_response_lines_one_per_target_action
    unique nulls not distinct (response_id, target_kind, target_item_id, action)
);

comment on table public.sendset_response_lines is
  'What a response submission said (0058): a target and an action, optionally with a note. v1 writes exactly one Sendset-level respond line per submission.';

-- ---------------------------------------------------------------------------
-- 4. LOCKED DOWN.
--
-- The platform's default privileges grant ALL on every new table to anon,
-- authenticated and service_role. Revoke all of it, then give back the one
-- thing the server's read path needs.
-- ---------------------------------------------------------------------------
alter table public.sendset_responses      enable row level security;
alter table public.sendset_response_lines enable row level security;

revoke all on public.sendset_responses      from public, anon, authenticated, service_role;
revoke all on public.sendset_response_lines from public, anon, authenticated, service_role;
grant select on public.sendset_responses      to service_role;
grant select on public.sendset_response_lines to service_role;

-- ---------------------------------------------------------------------------
-- 5. THE ONLY WAY IN.
--
-- ONE TRANSACTION, ONE LOCK. The Sendset row is taken FOR NO KEY UPDATE, which
--   * serialises this against publish_packet and unpublish_packet (both FOR
--     UPDATE), so the publication read below cannot change underneath it;
--   * serialises responses to the SAME Sendset against each other, so the
--     per-Sendset rate limit and notification allowance are exact;
--   * does NOT conflict with the FOR KEY SHARE that foreign-key checks take,
--     so edits elsewhere in the Sendset are not blocked.
-- The submission and its line are inserted inside that one transaction: a
-- failure anywhere leaves neither.
--
-- The global ceiling is counted without a global lock and is therefore
-- approximate under concurrency. It is a cost ceiling, not a guarantee.
--
-- Refusals are raised with a stable DETAIL and never say whether the slug
-- exists: unknown, unpublished and responses-off are one refusal.
-- ---------------------------------------------------------------------------
create function public.record_sendset_response(
  p_slug                  text,
  p_rendered_published_at text,
  p_responder_name        text,
  p_responder_contact     text,
  p_note                  text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  -- v1 ABUSE AND COST CONTROLS, NOT PRODUCT SEMANTICS. Nothing about what a
  -- response means depends on these numbers; they bound a flood and a bill.
  -- Expect to adjust them with evidence, by replacing this function.
  c_per_sendset_per_hour   constant int := 20;
  c_all_per_hour           constant int := 300;
  c_emails_per_sendset_hr  constant int := 5;

  v_name     text := nullif(btrim(coalesce(p_responder_name, ''),    E' \t\r\n'), '');
  v_contact  text := nullif(btrim(coalesce(p_responder_contact, ''), E' \t\r\n'), '');
  v_note     text := nullif(btrim(coalesce(p_note, ''),              E' \t\r\n'), '');
  v_rendered timestamptz;
  v_packet   record;
  v_live     timestamptz;
  v_count    int;
  v_due      boolean;
  v_id       uuid;
begin
  -- THE MARKER'S SHAPE, before it is cast and before any lookup, so a
  -- malformed marker is refused identically for every slug.
  if p_rendered_published_at is null
     or p_rendered_published_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
    raise exception 'respond: the publication marker is malformed'
      using errcode = 'PT400', detail = 'marker_invalid';
  end if;
  begin
    v_rendered := p_rendered_published_at::timestamptz;
  exception when others then
    raise exception 'respond: the publication marker is malformed'
      using errcode = 'PT400', detail = 'marker_invalid';
  end;

  -- A Respond is a message.
  if v_note is null then
    raise exception 'respond: a message is required'
      using errcode = 'PT400', detail = 'note_required';
  end if;

  select id, user_id, status, response_actions into v_packet
    from public.packets
   where slug = p_slug
     for no key update;

  if v_packet.id is null
     or v_packet.status <> 'published'
     or not ('respond' = any (v_packet.response_actions)) then
    raise exception 'respond: this Sendset is not accepting responses'
      using errcode = 'PT404', detail = 'not_accepting';
  end if;

  select published_at into v_live
    from public.packet_publications
   where packet_id = v_packet.id;
  if v_live is null then
    raise exception 'respond: this Sendset is not accepting responses'
      using errcode = 'PT404', detail = 'not_accepting';
  end if;

  -- LIMITS. No identifier of any kind is consulted: counts only.
  select count(*) into v_count from public.sendset_responses
   where packet_id = v_packet.id and created_at > now() - interval '1 hour';
  if v_count >= c_per_sendset_per_hour then
    raise exception 'respond: too many responses to this Sendset just now'
      using errcode = 'PT429', detail = 'rate_limited';
  end if;

  select count(*) into v_count from public.sendset_responses
   where created_at > now() - interval '1 hour';
  if v_count >= c_all_per_hour then
    raise exception 'respond: too many responses just now'
      using errcode = 'PT429', detail = 'rate_limited';
  end if;

  select count(*) into v_count from public.sendset_responses
   where packet_id = v_packet.id and notification_due and created_at > now() - interval '1 hour';
  v_due := v_count < c_emails_per_sendset_hr;

  insert into public.sendset_responses
         (packet_id, owner_user_id, live_publication_published_at,
          rendered_publication_was_current, responder_name, responder_contact, notification_due)
  values (v_packet.id, v_packet.user_id, v_live,
          v_rendered = v_live, v_name, v_contact, v_due)
  returning id into v_id;

  insert into public.sendset_response_lines (response_id, target_kind, action, note)
  values (v_id, 'sendset', 'respond', v_note);

  return jsonb_build_object('responseId', v_id, 'ownerUserId', v_packet.user_id, 'notificationDue', v_due);
end;
$$;

comment on function public.record_sendset_response(text, text, text, text, text) is
  'Record one Sendset-level Respond (0058). Atomic under the Sendset row lock. Refuses without revealing whether the slug exists. Stores the server-read live published_at and whether the browser-returned marker equalled it — a best-effort property, not proof. Server-only.';

create function public.mark_sendset_response_notified(p_response_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.sendset_responses
     set notified_at = now()
   where id = p_response_id
     and notification_due
     and notified_at is null;
$$;

comment on function public.mark_sendset_response_notified(uuid) is
  'Record that the owner''s notification for a response was sent (0058). Only for a response that was due one; never overwrites an earlier time. Server-only.';

-- ---------------------------------------------------------------------------
-- 6. THE ONLY WAY TO DELETE A SENDSET THAT HAS RESPONSES.
--
-- THE INVARIANT: a Sendset deletion cannot destroy a response that was not
-- included in the response count the creator acknowledged.
--
-- How the transaction closes the race, step by step:
--   1. The Sendset row is locked FOR UPDATE. That conflicts with the FOR NO KEY
--      UPDATE record_sendset_response takes, AND with the FOR KEY SHARE any
--      insert into sendset_responses takes for its foreign-key check. From this
--      moment no response to this Sendset can be added, by any path, until this
--      transaction ends.
--   2. The count is taken AFTER the lock, by a new statement, so it includes
--      every response committed before the lock was granted — including one
--      whose insert this lock had to wait for.
--   3. Nonzero and not exactly the acknowledged number: refuse, delete nothing.
--   4. The responses are removed (their lines cascade), then the Sendset, still
--      under the same lock, in the same transaction.
--
-- Why RESTRICT and not only this function: any OTHER deletion path is refused
-- by the foreign keys while responses exist, so this function is not merely
-- the recommended path — it is the only one that can succeed.
--
-- OWNER-SCOPED, ONE ANSWER. A Sendset that does not exist and one belonging to
-- somebody else are the same refusal, as the route has always answered: telling
-- them apart would reveal whether a stranger's id is real.
--
-- Zero responses: the acknowledgement is not required and not examined.
-- ---------------------------------------------------------------------------
create function public.delete_sendset(
  p_owner                  uuid,
  p_packet_id              uuid,
  p_acknowledged_responses integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id    uuid;
  v_count int;
begin
  select id into v_id
    from public.packets
   where id = p_packet_id
     and user_id = p_owner
     for update;
  if v_id is null then
    raise exception 'delete: this Sendset no longer exists, or you no longer have access to it'
      using errcode = 'PT404', detail = 'not_found';
  end if;

  select count(*) into v_count from public.sendset_responses where packet_id = v_id;

  if v_count > 0
     and (p_acknowledged_responses is null or p_acknowledged_responses <> v_count) then
    -- The actual count travels in HINT so the creator can be shown the true
    -- number before being asked again. Nothing has been deleted.
    raise exception 'delete: the responses to this Sendset changed'
      using errcode = 'PT409', detail = 'responses_changed', hint = v_count::text;
  end if;

  delete from public.sendset_responses where packet_id = v_id;   -- lines cascade
  delete from public.packets where id = v_id;                     -- the rest cascades as before

  return jsonb_build_object('deleted', true, 'responses', v_count);
end;
$$;

comment on function public.delete_sendset(uuid, uuid, integer) is
  'Delete an owner''s Sendset (0058). If it has responses, only when the acknowledged count equals the actual count, compared and acted on under the Sendset row lock in one transaction. Every other deletion path is refused by ON DELETE RESTRICT while responses exist. Server-only.';

-- A NEW FUNCTION IS EXECUTABLE BY PUBLIC, AND BY DEFAULT PRIVILEGE BY anon AND
-- authenticated, until said otherwise.
revoke all on function public.record_sendset_response(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.mark_sendset_response_notified(uuid)                  from public, anon, authenticated;
revoke all on function public.delete_sendset(uuid, uuid, integer)                      from public, anon, authenticated;
grant execute on function public.record_sendset_response(text, text, text, text, text) to service_role;
grant execute on function public.mark_sendset_response_notified(uuid)                  to service_role;
grant execute on function public.delete_sendset(uuid, uuid, integer)                      to service_role;

-- ---------------------------------------------------------------------------
-- 7. PROOF, IN THIS TRANSACTION.
--
-- A migration may not publish a Sendset (0053's single door; and
-- ownership-route.test scans these files for it), so the function's behaviour
-- against a published Sendset is proved in scripts/pg-harness/test-0058.mjs.
-- What is proved here is what the tables themselves must guarantee.
-- ---------------------------------------------------------------------------
do $$
declare
  u uuid; pk uuid; d0 bigint; c0 bigint; r uuid; n int; ok boolean;
begin
  insert into public.users (email) values ('0058-proof@example.invalid') returning id into u;
  insert into public.packets (user_id, slug, title) values (u, '0058-proof-slug', 'proof') returning id into pk;

  if (select response_actions from public.packets where id = pk) <> '{}'::text[] then
    raise exception '0058 PROOF: responses are not off by default';
  end if;

  -- THE REVISION INVARIANT: switching responses on moves no revision.
  d0 := (select draft_rev from public.packets where id = pk);
  c0 := (select content_rev from public.packets where id = pk);
  update public.packets set response_actions = '{respond}' where id = pk;
  if (select draft_rev from public.packets where id = pk) <> d0 then
    raise exception '0058 PROOF: enabling responses moved draft_rev';
  end if;
  if (select content_rev from public.packets where id = pk) <> c0 then
    raise exception '0058 PROOF: enabling responses moved content_rev';
  end if;
  update public.packets set client_title = 'a real edit' where id = pk;
  if (select draft_rev from public.packets where id = pk) <= d0 then
    raise exception '0058 PROOF: draft_rev stopped responding to a real edit';
  end if;

  -- AN UNKNOWN ACTION IS REFUSED.
  ok := false;
  begin
    update public.packets set response_actions = '{respond,approve}' where id = pk;
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception '0058 PROOF: an unknown response action was accepted'; end if;

  -- LINE CONSTRAINTS, directly (the function never writes these shapes).
  insert into public.sendset_responses
         (packet_id, owner_user_id, live_publication_published_at, rendered_publication_was_current, notification_due)
  values (pk, u, now(), true, true) returning id into r;

  ok := false;
  begin insert into public.sendset_response_lines (response_id, target_kind, action) values (r, 'sendset', 'respond');
  exception when check_violation then ok := true; end;
  if not ok then raise exception '0058 PROOF: a Respond without a message was accepted'; end if;

  ok := false;
  begin insert into public.sendset_response_lines (response_id, target_kind, action, note) values (r, 'item', 'respond', 'x');
  exception when check_violation then ok := true; end;
  if not ok then raise exception '0058 PROOF: an item target without an item id was accepted'; end if;

  ok := false;
  begin insert into public.sendset_response_lines (response_id, target_kind, target_label, action, note) values (r, 'sendset', 'L', 'respond', 'x');
  exception when check_violation then ok := true; end;
  if not ok then raise exception '0058 PROOF: a Sendset target carried an item label'; end if;

  ok := false;
  begin insert into public.sendset_response_lines (response_id, target_kind, action, note) values (r, 'sendset', 'approve', 'x');
  exception when check_violation then ok := true; end;
  if not ok then raise exception '0058 PROOF: an unknown action was stored'; end if;

  ok := false;
  begin update public.sendset_responses set notification_due = false, notified_at = now() where id = r;
  exception when check_violation then ok := true; end;
  if not ok then raise exception '0058 PROOF: a response not due a notification was marked notified'; end if;

  -- A VALID LINE, AND ONLY ONE OF IT.
  insert into public.sendset_response_lines (response_id, target_kind, action, note) values (r, 'sendset', 'respond', 'hello');
  ok := false;
  begin insert into public.sendset_response_lines (response_id, target_kind, action, note) values (r, 'sendset', 'respond', 'again');
  exception when unique_violation then ok := true; end;
  if not ok then raise exception '0058 PROOF: two identical target+action lines in one submission'; end if;

  -- RESPONSES MOVE NO REVISION.
  d0 := (select draft_rev from public.packets where id = pk);
  c0 := (select content_rev from public.packets where id = pk);
  insert into public.sendset_responses
         (packet_id, owner_user_id, live_publication_published_at, rendered_publication_was_current, notification_due)
  values (pk, u, now(), false, false);
  if (select draft_rev from public.packets where id = pk) <> d0
     or (select content_rev from public.packets where id = pk) <> c0 then
    raise exception '0058 PROOF: a response moved a Sendset revision';
  end if;

  -- NO PATH BUT delete_sendset CAN DESTROY THEM. Two responses now exist.
  ok := false;
  begin delete from public.packets where id = pk;
  exception when foreign_key_violation then ok := true; end;
  if not ok then raise exception '0058 PROOF: a plain DELETE destroyed a Sendset that had responses'; end if;

  ok := false;
  begin delete from public.users where id = u;
  exception when foreign_key_violation then ok := true; end;
  if not ok then raise exception '0058 PROOF: deleting an account destroyed responses addressed to it'; end if;

  -- delete_sendset: no acknowledgement, a wrong one, a larger one — each refused, nothing deleted.
  foreach n in array array[-1, 1, 3] loop
    ok := false;
    begin
      perform public.delete_sendset(u, pk, case when n = -1 then null else n end);
    exception when others then
      ok := sqlstate = 'PT409';
    end;
    if not ok then raise exception '0058 PROOF: delete_sendset accepted acknowledgement % for 2 responses', n; end if;
  end loop;
  if (select count(*) from public.sendset_responses where packet_id = pk) <> 2
     or not exists (select 1 from public.packets where id = pk) then
    raise exception '0058 PROOF: a refused delete_sendset deleted something';
  end if;

  -- Another owner: the same refusal as a Sendset that does not exist.
  ok := false;
  begin perform public.delete_sendset(gen_random_uuid(), pk, 2);
  exception when others then ok := sqlstate = 'PT404'; end;
  if not ok then raise exception '0058 PROOF: delete_sendset let a non-owner through'; end if;

  -- The exact count: the Sendset, its responses and their lines all go.
  perform public.delete_sendset(u, pk, 2);
  if exists (select 1 from public.packets where id = pk)
     or exists (select 1 from public.sendset_responses where packet_id = pk)
     or exists (select 1 from public.sendset_response_lines where response_id = r) then
    raise exception '0058 PROOF: an acknowledged delete_sendset left something behind';
  end if;

  -- Zero responses: no acknowledgement needed.
  insert into public.packets (user_id, slug, title) values (u, '0058-proof-empty', 'empty') returning id into pk;
  perform public.delete_sendset(u, pk, null);
  if exists (select 1 from public.packets where id = pk) then
    raise exception '0058 PROOF: a Sendset with no responses needed an acknowledgement';
  end if;
  delete from public.users where id = u;

  -- BOTH FOREIGN KEYS ARE RESTRICT, in the catalog.
  select count(*) into n from pg_constraint
   where conrelid = 'public.sendset_responses'::regclass and contype = 'f' and confdeltype = 'r';
  if n <> 2 then raise exception '0058 PROOF: % of 2 foreign keys on sendset_responses are ON DELETE RESTRICT', n; end if;

  -- LOCKED DOWN.
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('sendset_responses', 'sendset_response_lines')
     and grantee in ('PUBLIC', 'anon', 'authenticated');
  if n > 0 then raise exception '0058 PROOF: % table privilege(s) held by an unprivileged role', n; end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('sendset_responses', 'sendset_response_lines')
     and grantee = 'service_role' and privilege_type <> 'SELECT';
  if n > 0 then raise exception '0058 PROOF: service_role can write the responses tables directly (% privilege(s))', n; end if;

  select count(*) into n from information_schema.role_routine_grants
   where specific_schema = 'public'
     and routine_name in ('record_sendset_response', 'mark_sendset_response_notified', 'delete_sendset')
     and grantee in ('PUBLIC', 'anon', 'authenticated');
  if n > 0 then raise exception '0058 PROOF: % function grant(s) held by an unprivileged role', n; end if;

  if not (select relrowsecurity from pg_class where oid = 'public.sendset_responses'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.sendset_response_lines'::regclass) then
    raise exception '0058 PROOF: row level security is not enabled';
  end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('sendset_responses', 'sendset_response_lines');
  if n > 0 then raise exception '0058 PROOF: % policy(ies) exist on the responses tables', n; end if;
end $$;

commit;
