-- ============================================================================
-- 0059 — ITEM ACTIONS: somebody can heart an item, come back, and find their
-- own hearts still there.
--
-- 0058 stored correspondence: a message, sent once, never edited. This adds the
-- other half — PREFERENCE, which is mutable by the person who expressed it. The
-- two must not be confused, so the submission table now carries an explicit
-- shape, and the database refuses every mixture of the two:
--
--   kind = 'message'  immutable. No capability. Carries the publication marker
--                     and was-current for the one moment it happened. Notified.
--   kind = 'actions'  mutable. Carries a capability (below), a signature, and
--                     no submission-level publication fields, because it spans
--                     republishes and no single marker could be true of it.
--                     Never notified: hearts are not correspondence.
--
-- THE CAPABILITY, and where each part of it is allowed to exist:
--
--   * THE SERVER generates the raw 256 bits. Nothing else ever does.
--   * It reaches the browser ONLY as an HttpOnly, Secure cookie scoped to that
--     one Sendset's path.
--   * JAVASCRIPT NEVER RECEIVES OR READS IT. HttpOnly is what makes that true
--     rather than a convention the page is trusted to keep.
--   * It never appears in JSON, in application logs, in a URL, or in
--     PostgreSQL.
--   * POSTGRESQL RECEIVES ONLY THE 32-BYTE SHA-256 HASH, as an argument, and
--     stores only that.
--
-- It is a BEARER TOKEN FOR ONE SUBMISSION ON ONE SENDSET — not an identity, not
-- an account, and never proof of who anybody is. It is minted only by a
-- completed first action, so a person who merely reads a Sendset is given
-- nothing at all, and there is no row, no counter and no cookie describing
-- them.
--
-- TURNING LIKE OFF STOPS NEW EXPRESSION, NOT WITHDRAWAL. While the creator has
-- Like switched off, nothing new can be minted or set — but a capability that
-- already exists can still READ what it said and still WITHDRAW it, including a
-- like on an item the Sendset no longer carries. Someone who hearted three
-- things must not be locked in by a switch they do not hold, so `clear` and
-- `read` do not read response_actions AT ALL. That is structural: there is no
-- condition to re-add by accident, and the harness mutates one back in to prove
-- the difference is real.
--
-- WHAT IS DELIBERATELY ABSENT: no IP, no fingerprint, no visit log, no
-- last-seen, no read counter, no cross-Sendset identifier, and no per-mutation
-- event row. The only activity state that exists is a rate-limit counter that
-- is OVERWRITTEN IN PLACE and self-erasing (section 5).
--
-- STALENESS MOVES TO THE LINE. A message happens once, so its marker belongs to
-- the submission. A heart taken today and another after a Republish cannot share
-- one marker, so each LIKE LINE carries its own live_publication_published_at
-- and rendered_publication_was_current, written server-side, compared here in
-- SQL by equality. All of 0058's marker rules apply unchanged: an opaque string
-- from the browser, validated before any lookup, never a JavaScript Date, and
-- never an ordering comparison — published_at is not monotonic.
--
-- AN ACTION ON A REMOVED ITEM IS NOT SILENTLY LOST. target_item_id has no
-- foreign key and target_label is frozen at write time, so deleting an item
-- cannot take the line with it. set refuses a target that is not in the current
-- publication (PT409 target_absent); clear is ALLOWED, because withdrawing your
-- own statement is a deliberate act, not the silent loss this protects against.
--
-- ONE ACTION PER CALL. There is no "replace my lines" parameter anywhere in
-- this API, so a client that cannot render a tombstoned line cannot delete it
-- by omission. That is the guarantee, and it is structural rather than a rule
-- somebody has to remember.
--
--   public.sendset_action_rate                  the only activity state, and it
--                                               is one overwritten row.
--   public.sendset_publication_item(...)        is this item in that publication?
--   public.set_sendset_item_action(...)         add or refresh ONE action.
--   public.clear_sendset_item_action(...)       withdraw ONE action.
--   public.read_sendset_session_actions(...)    a capability's OWN actions.
--
-- Nothing here touches packet_publications, publish_packet, or 0058's
-- record_sendset_response / mark_sendset_response_notified / delete_sendset.
--
-- ROLLBACK: supabase/rollbacks/0059_sendset_item_actions_down.sql. It REFUSES
-- once any action session exists, and is lossless while only messages do.
-- ============================================================================

begin;

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.sendset_responses') is null
     or to_regclass('public.sendset_response_lines') is null
     or to_regprocedure('public.record_sendset_response(text,text,text,text,text)') is null
     or to_regprocedure('public.delete_sendset(uuid,uuid,integer)') is null then
    raise exception 'MIGRATION 0059 ABORTED: 0058 is not applied.';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'sendset_responses'
                and column_name in ('kind', 'session_hash', 'updated_at')) then
    raise exception 'MIGRATION 0059 ABORTED: sendset_responses already carries 0059 columns.';
  end if;
  if to_regclass('public.sendset_action_rate') is not null
     or to_regprocedure('public.set_sendset_item_action(text,text,bytea,text,text,uuid,text)') is not null
     or to_regprocedure('public.clear_sendset_item_action(text,bytea,uuid,text)') is not null
     or to_regprocedure('public.read_sendset_session_actions(text,bytea)') is not null
     or to_regprocedure('public.sendset_publication_item(jsonb,uuid)') is not null then
    raise exception 'MIGRATION 0059 ABORTED: a 0059 object already exists.';
  end if;
  -- Every existing row must be a message. There is no other shape yet, and if
  -- there were, this migration's backfill would be mislabelling it.
  if exists (select 1 from public.sendset_response_lines where action <> 'respond') then
    raise exception 'MIGRATION 0059 ABORTED: a non-respond line already exists.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. A FIXTURE MESSAGE, CREATED BEFORE ANYTHING CHANGES.
--
-- The before/after proof in section 9 compares real production correspondence
-- against itself. With no rows it would compare two empty sets and pass while
-- proving nothing (the failure mode that has bitten this project before), so a
-- message is created HERE, before the first ALTER, and is carried through the
-- whole migration exactly as a real one is. It is removed in section 9.
-- ---------------------------------------------------------------------------
create temp table zz0059_fixture (user_id uuid, packet_id uuid, response_id uuid, line_id uuid) on commit drop;
do $fixture$
declare u uuid; pk uuid; r uuid; l uuid;
begin
  insert into public.users (email) values ('0059-proof@example.invalid') returning id into u;
  insert into public.packets (user_id, slug, title) values (u, '0059-proof-slug', 'proof') returning id into pk;
  insert into public.sendset_responses
         (packet_id, owner_user_id, live_publication_published_at,
          rendered_publication_was_current, responder_name, responder_contact, notification_due)
  values (pk, u, '2026-09-15T19:13:23.490556+00:00'::timestamptz, true, 'Fixture', 'fixture@example.invalid', true)
  returning id into r;
  insert into public.sendset_response_lines (response_id, target_kind, action, note)
  values (r, 'sendset', 'respond', 'a message that existed before 0059') returning id into l;
  insert into zz0059_fixture values (u, pk, r, l);
end $fixture$;

-- THE PRE-STATE, named column by column: row_to_json would change shape the
-- moment a column is added and could not be compared with itself afterwards.
create temp table zz0059_pre on commit drop as
select
  (select count(*) from public.sendset_responses)      as n_responses,
  (select count(*) from public.sendset_response_lines) as n_lines,
  (select md5(coalesce(string_agg(h, ',' order by h), '')) from (
     select md5(concat_ws('|', id, packet_id, owner_user_id,
                          live_publication_published_at, rendered_publication_was_current,
                          coalesce(responder_name, ''), coalesce(responder_contact, ''),
                          notification_due, created_at, coalesce(notified_at::text, ''))) as h
       from public.sendset_responses) s)               as responses_digest,
  (select md5(coalesce(string_agg(h, ',' order by h), '')) from (
     select md5(concat_ws('|', id, response_id, target_kind, coalesce(target_item_id::text, ''),
                          coalesce(target_label, ''), action, coalesce(note, ''))) as h
       from public.sendset_response_lines) s)          as lines_digest;

-- ---------------------------------------------------------------------------
-- 2. WHAT A PUBLISHED PAGE ACCEPTS.
--
-- 'like' is a SEPARATE creator choice from 'respond' and defaults off with it:
-- an existing Sendset holding '{respond}' gains nothing here.
-- ---------------------------------------------------------------------------
alter table public.packets drop constraint packets_response_actions_known;
alter table public.packets
  add constraint packets_response_actions_known
  check (response_actions <@ array['respond', 'like']::text[]);

comment on column public.packets.response_actions is
  'Response actions the published page accepts (0058, 0059). Empty = responses off. respond = a message; like = item hearts. Live on the Sendset rather than frozen into its publication, so switching either off takes effect immediately. Excluded from draft_rev and content_rev. Never copied into a publication.';

-- ---------------------------------------------------------------------------
-- 3. THE SUBMISSION GAINS A SHAPE.
--
-- kind keeps its default forever, on purpose: 0058's record_sendset_response is
-- live and does not name it, and this migration does not rewrite a working
-- function to satisfy a column it predates. The default cannot produce a wrong
-- row, because the shape CHECK below refuses a defaulted row that carries a
-- capability.
-- ---------------------------------------------------------------------------
alter table public.sendset_responses
  add column kind                  text        not null default 'message',
  add column session_hash          bytea,
  add column updated_at            timestamptz,
  add column mutation_window_start timestamptz,
  add column mutations_in_window   integer     not null default 0;

alter table public.sendset_responses
  alter column live_publication_published_at    drop not null,
  alter column rendered_publication_was_current drop not null;

alter table public.sendset_responses
  add constraint sendset_responses_kind_known check (kind in ('message', 'actions')),

  -- THE TWO SHAPES, in one statement, so neither can drift into the other.
  add constraint sendset_responses_shape check (
    (kind = 'message'
      and session_hash is null
      and live_publication_published_at is not null
      and rendered_publication_was_current is not null
      and updated_at is null
      and mutation_window_start is null
      and mutations_in_window = 0)
    or
    (kind = 'actions'
      and session_hash is not null
      and live_publication_published_at is null
      and rendered_publication_was_current is null
      and updated_at is not null
      -- A signature is required for an action session: "someone hearted items
      -- 2 and 4" is not something a professional can act on, and it is what
      -- makes "Not you? Start a new response" mean anything.
      and responder_name is not null
      -- Hearts never email. The notification allowance exists for real
      -- correspondence and must not be spent by taps.
      and notification_due = false
      and notified_at is null)),

  -- 256 bits, hashed. Server-side generation and hashing are the application's
  -- half of this; the length is the part the database can insist on.
  add constraint sendset_responses_session_hash_shape
    check (session_hash is null or octet_length(session_hash) = 32),

  add constraint sendset_responses_mutations_nonneg check (mutations_in_window >= 0),

  -- The FK target for a line's parent_kind (section 4).
  add constraint sendset_responses_id_kind unique (id, kind);

-- ONE LIVE SUBMISSION PER CAPABILITY PER SENDSET. Messages all carry a null
-- hash and are not constrained by this.
create unique index sendset_responses_capability
  on public.sendset_responses (packet_id, session_hash)
  where session_hash is not null;

comment on column public.sendset_responses.kind is
  'message = immutable correspondence (0058). actions = a mutable item-action session held by one capability (0059). The shape CHECK refuses every mixture.';
comment on column public.sendset_responses.session_hash is
  'SHA-256 of a 256-bit capability generated server-side and held in an HttpOnly cookie scoped to this Sendset. The raw token is never stored, never logged, and never supplied by a client. A bearer token for ONE submission on ONE Sendset; not an identity and not proof of who anybody is.';
comment on column public.sendset_responses.updated_at is
  'When this action session last changed, by an addition OR a withdrawal. Null for a message, which is never updated.';
comment on column public.sendset_responses.mutations_in_window is
  'Rate-limit counter, OVERWRITTEN IN PLACE and reset when its hour rolls. Not an activity history: the previous window is destroyed, not archived, and this is never exposed on any read path.';

-- ---------------------------------------------------------------------------
-- 4. THE LINE GAINS ITS OWN MARKER, AND A PARENT IT CANNOT ESCAPE.
--
-- parent_kind plus the composite foreign key make "a like hangs only under an
-- action session, and a respond only under a message" a database guarantee
-- rather than a convention every future function has to remember.
-- ---------------------------------------------------------------------------
alter table public.sendset_response_lines
  add column parent_kind                      text not null default 'message',
  add column live_publication_published_at    timestamptz,
  add column rendered_publication_was_current boolean;

alter table public.sendset_response_lines
  add constraint sendset_response_lines_parent_kind_fkey
    foreign key (response_id, parent_kind)
    references public.sendset_responses (id, kind) on delete cascade,

  add constraint sendset_response_lines_action_matches_parent
    check ((action = 'like') = (parent_kind = 'actions'));

alter table public.sendset_response_lines
  drop constraint sendset_response_lines_action_known;
alter table public.sendset_response_lines
  add constraint sendset_response_lines_action_known check (action in ('respond', 'like')),

  -- A like is an item preference: an item target, its own marker, and no words.
  -- Words would make it correspondence, which is immutable and notified.
  add constraint sendset_response_lines_like_shape check (
    action <> 'like'
    or (target_kind = 'item'
        and note is null
        and live_publication_published_at is not null
        and rendered_publication_was_current is not null)),

  -- A respond keeps using its parent's marker and cannot acquire item-action
  -- semantics by having one of its own.
  add constraint sendset_response_lines_respond_shape check (
    action <> 'respond'
    or (target_kind = 'sendset'
        and live_publication_published_at is null
        and rendered_publication_was_current is null));

comment on column public.sendset_response_lines.live_publication_published_at is
  'Which publication was live when THIS line was written (0059). On the line rather than the submission because an action session spans republishes and no single marker could be true of it. Null for a respond line, which uses its submission''s.';
comment on column public.sendset_response_lines.target_label is
  'The item''s title as published, frozen server-side when the line was written. A TOMBSTONE, not a display default: while the item is still in the publication both sides show its current title; this is what remains sayable once it is gone.';

-- ---------------------------------------------------------------------------
-- 5. THE ONLY ACTIVITY STATE IN THE SYSTEM.
--
-- One row per Sendset, overwritten in place. It holds a window start and a
-- count, and nothing else: no capability, no identity, no per-event row, and no
-- history — when the hour rolls, the old window is destroyed rather than kept.
--
-- CASCADE, not RESTRICT: a counter is not correspondence, and nothing about a
-- deletion should be refused to protect it.
-- ---------------------------------------------------------------------------
create table public.sendset_action_rate (
  packet_id    uuid        primary key references public.packets(id) on delete cascade,
  window_start timestamptz not null,
  mutations    integer     not null default 0,
  constraint sendset_action_rate_nonneg check (mutations >= 0)
);

create index sendset_action_rate_window on public.sendset_action_rate (window_start);

comment on table public.sendset_action_rate is
  'Rate-limit counter for item-action mutations (0059): one row per Sendset, overwritten in place, self-erasing when its hour rolls. Deliberately NOT an event log: there is no row per mutation, nothing identifying a browser or a person, and no retained history.';

alter table public.sendset_action_rate enable row level security;
revoke all on public.sendset_action_rate from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. IS THIS ITEM IN THAT PUBLICATION?
--
-- Both composition modes, because a Sendset can be authored either way and a
-- heart must mean the same thing in both. Returns null when the item is not in
-- the publication at all, which is DIFFERENT from an item that is present with
-- no title: the first refuses a new action, the second is simply unlabelled.
-- ---------------------------------------------------------------------------
create function public.sendset_publication_item(p_content jsonb, p_item_id uuid)
returns jsonb
language sql immutable parallel safe set search_path = '' as $$
  select jsonb_build_object('label', nullif(btrim(coalesce(x.title, ''), E' \t\r\n'), ''))
    from (
      select i->>'title' as title
        from jsonb_array_elements(coalesce(p_content->'sections', '[]'::jsonb)) s,
             jsonb_array_elements(coalesce(s->'items', '[]'::jsonb)) i
       where i->>'id' = p_item_id::text
      union all
      select b->'item'->>'title'
        from jsonb_array_elements(coalesce(p_content->'blocks', '[]'::jsonb)) b
       where b->>'kind' = 'item' and b->'item'->>'id' = p_item_id::text
    ) x
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 7. ADD OR REFRESH ONE ACTION.
--
-- ONE TARGET, ONE ACTION, ONE CALL. The signature is written only when the
-- capability is minted; a later call cannot rewrite it, because a shared browser
-- must not be able to rename somebody else's submission. Starting again is the
-- deliberate act of dropping the cookie and minting a new capability.
--
-- The name is required and validated BEFORE the lookup even when the capability
-- already exists and the value will be ignored. Validating it after would make
-- "name_required" distinguishable from "not_accepting", which would tell a
-- prober that a slug exists and accepts hearts.
-- ---------------------------------------------------------------------------
create function public.set_sendset_item_action(
  p_slug                  text,
  p_rendered_published_at text,
  p_session_hash          bytea,
  p_responder_name        text,
  p_responder_contact     text,
  p_item_id               uuid,
  p_action                text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  -- v1 ABUSE AND COST CONTROLS, NOT PRODUCT SEMANTICS. Nothing about what a
  -- heart means depends on these numbers; they bound a flood and a bill.
  -- Minting creates a durable row, so it is counted from those rows and is
  -- exact under the Sendset lock. Mutations create nothing, so they are counted
  -- by two overwritten counters rather than by recording what anybody did.
  c_mints_per_sendset_hr     constant int := 200;
  c_mints_all_hr             constant int := 2000;
  c_mutations_per_cap_hr     constant int := 100;
  c_mutations_per_sendset_hr constant int := 2000;
  c_mutations_all_hr         constant int := 10000;

  v_name      text := nullif(btrim(coalesce(p_responder_name, ''),    E' \t\r\n'), '');
  v_contact   text := nullif(btrim(coalesce(p_responder_contact, ''), E' \t\r\n'), '');
  v_rendered  timestamptz;
  v_packet    record;
  v_live      timestamptz;
  v_content   jsonb;
  v_item      jsonb;
  v_resp      record;
  v_rate      record;
  v_created   boolean := false;
  v_count     int;
  v_window    timestamptz;
  v_muts      int;
begin
  if p_action is null or p_action <> 'like' then
    raise exception 'action: unknown item action' using errcode = 'PT400', detail = 'action_invalid';
  end if;

  -- THE MARKER'S SHAPE, before it is cast and before any lookup, so a malformed
  -- marker is refused identically for every slug.
  if p_rendered_published_at is null
     or p_rendered_published_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
    raise exception 'action: the publication marker is malformed'
      using errcode = 'PT400', detail = 'marker_invalid';
  end if;
  begin
    v_rendered := p_rendered_published_at::timestamptz;
  exception when others then
    raise exception 'action: the publication marker is malformed'
      using errcode = 'PT400', detail = 'marker_invalid';
  end;

  if p_session_hash is null or octet_length(p_session_hash) <> 32 then
    raise exception 'action: the capability is malformed' using errcode = 'PT400', detail = 'session_invalid';
  end if;
  if v_name is null then
    raise exception 'action: a name is required' using errcode = 'PT400', detail = 'name_required';
  end if;
  if p_item_id is null then
    raise exception 'action: a target is required' using errcode = 'PT400', detail = 'target_invalid';
  end if;

  select id, user_id, status, response_actions into v_packet
    from public.packets
   where slug = p_slug
     for no key update;

  -- THE ONE PLACE THE CREATOR'S SWITCH IS READ. New expression stops here when
  -- Like is off; reading and withdrawing do not consult it at all.
  if v_packet.id is null
     or v_packet.status <> 'published'
     or not ('like' = any (v_packet.response_actions)) then
    raise exception 'action: this Sendset is not accepting item actions'
      using errcode = 'PT404', detail = 'not_accepting';
  end if;

  select published_at, content into v_live, v_content
    from public.packet_publications
   where packet_id = v_packet.id;
  if v_live is null then
    raise exception 'action: this Sendset is not accepting item actions'
      using errcode = 'PT404', detail = 'not_accepting';
  end if;

  -- NO NEW OR CHANGED ACTION ON SOMETHING THAT IS NO LONGER THERE. A line that
  -- already exists for it stays exactly as it is, and may still be withdrawn.
  v_item := public.sendset_publication_item(v_content, p_item_id);
  if v_item is null then
    raise exception 'action: that item is no longer in this Sendset'
      using errcode = 'PT409', detail = 'target_absent';
  end if;

  select * into v_resp
    from public.sendset_responses
   where packet_id = v_packet.id and session_hash = p_session_hash;

  if v_resp.id is null then
    -- MINTING, counted from the durable rows it creates.
    select count(*) into v_count from public.sendset_responses
     where packet_id = v_packet.id and kind = 'actions' and created_at > now() - interval '1 hour';
    if v_count >= c_mints_per_sendset_hr then
      raise exception 'action: too many new responses to this Sendset just now'
        using errcode = 'PT429', detail = 'rate_limited';
    end if;
    select count(*) into v_count from public.sendset_responses
     where kind = 'actions' and created_at > now() - interval '1 hour';
    if v_count >= c_mints_all_hr then
      raise exception 'action: too many new responses just now'
        using errcode = 'PT429', detail = 'rate_limited';
    end if;

    insert into public.sendset_responses
           (packet_id, owner_user_id, kind, session_hash, responder_name, responder_contact,
            notification_due, updated_at, mutation_window_start, mutations_in_window)
    values (v_packet.id, v_packet.user_id, 'actions', p_session_hash, v_name, v_contact,
            false, now(), now(), 0)
    returning * into v_resp;
    v_created := true;
  end if;

  -- MUTATION CEILINGS. Per capability: two columns on the submission being
  -- written anyway. Per Sendset: one row, overwritten. Globally: the sum of
  -- those rows, which is approximate by construction and is a cost ceiling
  -- rather than a guarantee.
  v_window := v_resp.mutation_window_start;
  v_muts   := v_resp.mutations_in_window;
  if v_window is null or v_window <= now() - interval '1 hour' then
    v_window := now();
    v_muts   := 0;
  end if;
  if v_muts >= c_mutations_per_cap_hr then
    raise exception 'action: too many changes just now' using errcode = 'PT429', detail = 'rate_limited';
  end if;

  insert into public.sendset_action_rate as r (packet_id, window_start, mutations)
  values (v_packet.id, now(), 0)
  on conflict (packet_id) do update
     set window_start = case when r.window_start <= now() - interval '1 hour' then now() else r.window_start end,
         mutations    = case when r.window_start <= now() - interval '1 hour' then 0     else r.mutations    end
  returning * into v_rate;
  if v_rate.mutations >= c_mutations_per_sendset_hr then
    raise exception 'action: too many changes to this Sendset just now' using errcode = 'PT429', detail = 'rate_limited';
  end if;

  select coalesce(sum(mutations), 0) into v_count
    from public.sendset_action_rate where window_start > now() - interval '1 hour';
  if v_count >= c_mutations_all_hr then
    raise exception 'action: too many changes just now' using errcode = 'PT429', detail = 'rate_limited';
  end if;

  -- ONE LINE. Re-setting an action already held refreshes its frozen label and
  -- its marker; it never creates a second line, and never touches another
  -- capability's line.
  insert into public.sendset_response_lines
         (response_id, parent_kind, target_kind, target_item_id, target_label, action,
          live_publication_published_at, rendered_publication_was_current)
  values (v_resp.id, 'actions', 'item', p_item_id, left(v_item->>'label', 500), p_action,
          v_live, v_rendered = v_live)
  on conflict on constraint sendset_response_lines_one_per_target_action do update
     set target_label = excluded.target_label,
         live_publication_published_at    = excluded.live_publication_published_at,
         rendered_publication_was_current = excluded.rendered_publication_was_current;

  update public.sendset_responses
     set updated_at = now(), mutation_window_start = v_window, mutations_in_window = v_muts + 1
   where id = v_resp.id;
  update public.sendset_action_rate set mutations = mutations + 1 where packet_id = v_packet.id;

  return jsonb_build_object(
    'responseId', v_resp.id, 'created', v_created, 'itemId', p_item_id, 'action', p_action,
    'label', v_item->>'label', 'wasCurrent', v_rendered = v_live);
end;
$$;

comment on function public.set_sendset_item_action(text, text, bytea, text, text, uuid, text) is
  'Add or refresh ONE item action for ONE capability (0059). Mints the capability''s submission on first use and never rewrites its signature afterwards. Refuses a target absent from the current publication. Atomic under the Sendset row lock. Server-only.';

-- ---------------------------------------------------------------------------
-- 8. WITHDRAW ONE ACTION.
--
-- OWNERSHIP IS IN THE WHERE CLAUSE. The line is found through the submission
-- this capability owns, so clearing somebody else's line is not refused — it is
-- unaddressable.
--
-- ALLOWED FOR AN ITEM THAT IS GONE. A person withdrawing their own statement is
-- a deliberate act; the silent loss this migration guards against is a client
-- deleting a line it could not render, which cannot happen because no call ever
-- names more than one target.
--
-- A capability that owns no such line is not an error: nothing was withdrawn,
-- and saying so reveals nothing.
--
-- NOT GATED ON THE CREATOR'S SWITCH. response_actions is never read here: a
-- withdrawal is the responder taking back their own statement, and Like being
-- switched off must not trap it. It cannot be used to add anything, and it
-- cannot mint: a browser with no capability withdraws nothing.
-- ---------------------------------------------------------------------------
create function public.clear_sendset_item_action(
  p_slug         text,
  p_session_hash bytea,
  p_item_id      uuid,
  p_action       text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_mutations_per_cap_hr     constant int := 100;
  c_mutations_per_sendset_hr constant int := 2000;
  c_mutations_all_hr         constant int := 10000;

  v_packet  record;
  v_resp    record;
  v_rate    record;
  v_window  timestamptz;
  v_muts    int;
  v_count   int;
  v_removed int;
begin
  if p_action is null or p_action <> 'like' then
    raise exception 'action: unknown item action' using errcode = 'PT400', detail = 'action_invalid';
  end if;
  if p_session_hash is null or octet_length(p_session_hash) <> 32 then
    raise exception 'action: the capability is malformed' using errcode = 'PT400', detail = 'session_invalid';
  end if;
  if p_item_id is null then
    raise exception 'action: a target is required' using errcode = 'PT400', detail = 'target_invalid';
  end if;

  select id, status into v_packet
    from public.packets
   where slug = p_slug
     for no key update;

  if v_packet.id is null or v_packet.status <> 'published' then
    raise exception 'action: this Sendset is not accepting item actions'
      using errcode = 'PT404', detail = 'not_accepting';
  end if;

  select * into v_resp
    from public.sendset_responses
   where packet_id = v_packet.id and session_hash = p_session_hash;
  if v_resp.id is null then
    return jsonb_build_object('removed', false);
  end if;

  v_window := v_resp.mutation_window_start;
  v_muts   := v_resp.mutations_in_window;
  if v_window is null or v_window <= now() - interval '1 hour' then
    v_window := now();
    v_muts   := 0;
  end if;
  if v_muts >= c_mutations_per_cap_hr then
    raise exception 'action: too many changes just now' using errcode = 'PT429', detail = 'rate_limited';
  end if;

  insert into public.sendset_action_rate as r (packet_id, window_start, mutations)
  values (v_packet.id, now(), 0)
  on conflict (packet_id) do update
     set window_start = case when r.window_start <= now() - interval '1 hour' then now() else r.window_start end,
         mutations    = case when r.window_start <= now() - interval '1 hour' then 0     else r.mutations    end
  returning * into v_rate;
  if v_rate.mutations >= c_mutations_per_sendset_hr then
    raise exception 'action: too many changes to this Sendset just now' using errcode = 'PT429', detail = 'rate_limited';
  end if;
  select coalesce(sum(mutations), 0) into v_count
    from public.sendset_action_rate where window_start > now() - interval '1 hour';
  if v_count >= c_mutations_all_hr then
    raise exception 'action: too many changes just now' using errcode = 'PT429', detail = 'rate_limited';
  end if;

  delete from public.sendset_response_lines
   where response_id = v_resp.id
     and target_kind = 'item'
     and target_item_id = p_item_id
     and action = p_action;
  get diagnostics v_removed = row_count;

  -- The attempt is counted whether or not it removed anything, so a capability
  -- cannot spend an unbounded number of calls on lines it does not hold.
  update public.sendset_responses
     set updated_at = now(), mutation_window_start = v_window, mutations_in_window = v_muts + 1
   where id = v_resp.id;
  update public.sendset_action_rate set mutations = mutations + 1 where packet_id = v_packet.id;

  return jsonb_build_object('removed', v_removed > 0);
end;
$$;

comment on function public.clear_sendset_item_action(text, bytea, uuid, text) is
  'Withdraw ONE item action held by ONE capability (0059). Never consults response_actions: switching Like off stops new expression, not withdrawal. Scoped to that capability''s own submission, so another''s line is unaddressable. Allowed for an item no longer in the publication: withdrawing your own statement is deliberate. Server-only.';

-- ---------------------------------------------------------------------------
-- 9. WHAT THIS CAPABILITY ITSELF SAID.
--
-- ITS OWN LINES AND NOTHING ELSE: no counts, no other submissions, no hint that
-- anybody else has responded at all. An unknown capability and a slug that never
-- existed return the SAME empty answer.
--
-- NOT GATED ON THE CREATOR'S SWITCH, for the same reason as the withdrawal: what
-- somebody already said stays visible to them, and they cannot be shown an empty
-- list for hearts they can still withdraw. response_actions is never read here.
--
-- The contact is deliberately not returned. The message form may prefill a name
-- from this; a contact detail typed once for hearts is not something to hand
-- back to a form the person has not opened yet.
--
-- in_current is computed here and never stored: it changes when the Sendset
-- changes, not when the person acts.
-- ---------------------------------------------------------------------------
create function public.read_sendset_session_actions(p_slug text, p_session_hash bytea)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_empty   constant jsonb := jsonb_build_object('signature', null, 'actions', '[]'::jsonb);
  v_packet  record;
  v_content jsonb;
  v_resp    record;
  v_actions jsonb;
begin
  if p_session_hash is null or octet_length(p_session_hash) <> 32 then
    return v_empty;
  end if;

  select id, status into v_packet from public.packets where slug = p_slug;
  if v_packet.id is null or v_packet.status <> 'published' then
    return v_empty;
  end if;

  select content into v_content from public.packet_publications where packet_id = v_packet.id;
  if v_content is null then
    return v_empty;
  end if;

  select * into v_resp
    from public.sendset_responses
   where packet_id = v_packet.id and session_hash = p_session_hash;
  if v_resp.id is null then
    return v_empty;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'itemId',     l.target_item_id,
           'action',     l.action,
           -- The CURRENT title while the item is there; the frozen tombstone
           -- once it is not.
           'label',      coalesce(public.sendset_publication_item(v_content, l.target_item_id)->>'label', l.target_label),
           'inCurrent',  public.sendset_publication_item(v_content, l.target_item_id) is not null,
           'wasCurrent', l.rendered_publication_was_current
         ) order by l.target_label, l.target_item_id), '[]'::jsonb)
    into v_actions
    from public.sendset_response_lines l
   where l.response_id = v_resp.id and l.action = 'like';

  return jsonb_build_object(
    'signature', jsonb_build_object('name', v_resp.responder_name),
    'actions', v_actions);
end;
$$;

comment on function public.read_sendset_session_actions(text, bytea) is
  'One capability''s OWN item actions (0059). Never consults response_actions: what somebody already said stays visible to them. Never counts, never anyone else''s, and never says whether a slug exists. Returns the signature''s name only. Server-only.';

-- ---------------------------------------------------------------------------
-- 10. LOCKED DOWN.
-- ---------------------------------------------------------------------------
revoke all on function public.sendset_publication_item(jsonb, uuid)                            from public, anon, authenticated;
revoke all on function public.set_sendset_item_action(text, text, bytea, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.clear_sendset_item_action(text, bytea, uuid, text)                 from public, anon, authenticated;
revoke all on function public.read_sendset_session_actions(text, bytea)                          from public, anon, authenticated;
grant execute on function public.set_sendset_item_action(text, text, bytea, text, text, uuid, text) to service_role;
grant execute on function public.clear_sendset_item_action(text, bytea, uuid, text)                 to service_role;
grant execute on function public.read_sendset_session_actions(text, bytea)                          to service_role;

-- ---------------------------------------------------------------------------
-- 11. PROOF, IN THIS TRANSACTION.
--
-- A migration may not publish a Sendset (0053's single door), so the functions'
-- behaviour against a published Sendset — hearts, staleness across a republish,
-- removed items, capability isolation and the limits under real interleaving —
-- is proved in scripts/pg-harness/test-0059.mjs. What is proved here is what
-- the tables themselves must guarantee, and that the correspondence already in
-- this database came through untouched.
-- ---------------------------------------------------------------------------
do $$
declare
  f        record;
  pre      record;
  post_r   text;
  post_l   text;
  n        int;
  ok       boolean;
  u        uuid; pk uuid; r1 uuid; r2 uuid; r3 uuid; item_a uuid := gen_random_uuid();
  h1       bytea := decode(repeat('a1', 32), 'hex');
  h2       bytea := decode(repeat('b2', 32), 'hex');
begin
  select * into f   from zz0059_fixture;
  select * into pre from zz0059_pre;

  -- ---- THE CORRESPONDENCE THAT WAS ALREADY HERE -----------------------------
  if pre.n_responses < 1 or pre.n_lines < 1 then
    raise exception '0059 PROOF: the before/after comparison has nothing to compare';
  end if;
  if (select count(*) from public.sendset_responses) <> pre.n_responses
     or (select count(*) from public.sendset_response_lines) <> pre.n_lines then
    raise exception '0059 PROOF: the migration added or removed a row';
  end if;

  select md5(coalesce(string_agg(h, ',' order by h), '')) into post_r from (
    select md5(concat_ws('|', id, packet_id, owner_user_id,
                         live_publication_published_at, rendered_publication_was_current,
                         coalesce(responder_name, ''), coalesce(responder_contact, ''),
                         notification_due, created_at, coalesce(notified_at::text, ''))) as h
      from public.sendset_responses) s;
  select md5(coalesce(string_agg(h, ',' order by h), '')) into post_l from (
    select md5(concat_ws('|', id, response_id, target_kind, coalesce(target_item_id::text, ''),
                         coalesce(target_label, ''), action, coalesce(note, ''))) as h
      from public.sendset_response_lines) s;

  if post_r <> pre.responses_digest then
    raise exception '0059 PROOF: an existing submission changed (% -> %)', pre.responses_digest, post_r;
  end if;
  if post_l <> pre.lines_digest then
    raise exception '0059 PROOF: an existing response line changed (% -> %)', pre.lines_digest, post_l;
  end if;

  if exists (select 1 from public.sendset_responses where kind <> 'message')
     or exists (select 1 from public.sendset_response_lines where parent_kind <> 'message') then
    raise exception '0059 PROOF: an existing row was labelled as something other than a message';
  end if;
  if exists (select 1 from public.sendset_responses
              where updated_at is not null or session_hash is not null or mutations_in_window <> 0) then
    raise exception '0059 PROOF: an existing message acquired action-session state';
  end if;

  -- ---- THE TWO SHAPES -------------------------------------------------------
  select user_id, packet_id into u, pk from zz0059_fixture;

  -- A message may not carry a capability.
  ok := false;
  begin
    update public.sendset_responses set session_hash = h1 where id = f.response_id;
  exception when check_violation then ok := true; end;
  if not ok then raise exception '0059 PROOF: a message was given a capability'; end if;

  -- An action session may not carry a submission-level marker, and may not
  -- omit a capability, a signature or its updated_at.
  for n in 1..5 loop
    ok := false;
    begin
      insert into public.sendset_responses
             (packet_id, owner_user_id, kind, session_hash, responder_name, notification_due,
              updated_at, live_publication_published_at, rendered_publication_was_current)
      values (pk, u, 'actions',
              case when n = 1 then null else h1 end,
              case when n = 2 then null else 'Signed' end,
              case when n = 3 then true else false end,
              case when n = 4 then null else now() end,
              case when n = 5 then now() else null end,
              case when n = 5 then true else null end);
    exception when check_violation then ok := true; end;
    if not ok then raise exception '0059 PROOF: an invalid action session was accepted (case %)', n; end if;
  end loop;

  -- A capability is 32 bytes.
  ok := false;
  begin
    insert into public.sendset_responses
           (packet_id, owner_user_id, kind, session_hash, responder_name, notification_due, updated_at)
    values (pk, u, 'actions', decode('a1a1', 'hex'), 'Signed', false, now());
  exception when check_violation then ok := true; end;
  if not ok then raise exception '0059 PROOF: a capability that is not 256 bits was accepted'; end if;

  -- A real action session, and a second one on the same Sendset.
  insert into public.sendset_responses
         (packet_id, owner_user_id, kind, session_hash, responder_name, notification_due, updated_at)
  values (pk, u, 'actions', h1, 'Lisa', false, now()) returning id into r1;
  insert into public.sendset_responses
         (packet_id, owner_user_id, kind, session_hash, responder_name, notification_due, updated_at)
  values (pk, u, 'actions', h2, 'Mark', false, now()) returning id into r2;

  -- ONE SUBMISSION PER CAPABILITY PER SENDSET.
  ok := false;
  begin
    insert into public.sendset_responses
           (packet_id, owner_user_id, kind, session_hash, responder_name, notification_due, updated_at)
    values (pk, u, 'actions', h1, 'Lisa again', false, now());
  exception when unique_violation then ok := true; end;
  if not ok then raise exception '0059 PROOF: one capability holds two submissions on one Sendset'; end if;

  -- ---- LINES CANNOT ESCAPE THEIR PARENT -------------------------------------
  ok := false;
  begin
    insert into public.sendset_response_lines
           (response_id, parent_kind, target_kind, target_item_id, target_label, action,
            live_publication_published_at, rendered_publication_was_current)
    values (f.response_id, 'message', 'item', gen_random_uuid(), 'X', 'like', now(), true);
  exception when check_violation then ok := true; end;
  if not ok then raise exception '0059 PROOF: a like was hung under a message'; end if;

  ok := false;
  begin
    insert into public.sendset_response_lines
           (response_id, parent_kind, target_kind, target_item_id, target_label, action,
            live_publication_published_at, rendered_publication_was_current)
    values (f.response_id, 'actions', 'item', gen_random_uuid(), 'X', 'like', now(), true);
  exception when foreign_key_violation then ok := true; end;
  if not ok then raise exception '0059 PROOF: a like claimed a message submission as an action session'; end if;

  ok := false;
  begin
    insert into public.sendset_response_lines (response_id, parent_kind, target_kind, action, note)
    values (r1, 'actions', 'sendset', 'respond', 'a message inside an action session');
  exception when check_violation then ok := true; end;
  if not ok then raise exception '0059 PROOF: a respond was written into an action session'; end if;

  -- A like carries an item target, its own marker, and no words.
  for n in 1..4 loop
    ok := false;
    begin
      insert into public.sendset_response_lines
             (response_id, parent_kind, target_kind, target_item_id, target_label, action, note,
              live_publication_published_at, rendered_publication_was_current)
      values (r1, 'actions',
              case when n = 1 then 'sendset' else 'item' end,
              case when n = 1 then null else gen_random_uuid() end,
              'Harbor House',
              'like',
              case when n = 2 then 'words' else null end,
              case when n = 3 then null else now() end,
              case when n = 4 then null else true end);
    exception when check_violation then ok := true; end;
    if not ok then raise exception '0059 PROOF: an invalid like line was accepted (case %)', n; end if;
  end loop;

  -- A respond line cannot acquire a marker of its own. On a message of its own,
  -- so that the one-line-per-target rule cannot be what refuses it: this must
  -- fail because of its SHAPE.
  insert into public.sendset_responses
         (packet_id, owner_user_id, live_publication_published_at, rendered_publication_was_current,
          responder_name, notification_due)
  values (pk, u, now(), true, 'Second', false) returning id into r3;
  ok := false;
  begin
    insert into public.sendset_response_lines
           (response_id, parent_kind, target_kind, action, note, live_publication_published_at, rendered_publication_was_current)
    values (r3, 'message', 'sendset', 'respond', 'words', now(), true);
  exception when check_violation then ok := true; end;
  if not ok then raise exception '0059 PROOF: a respond line acquired item-action semantics'; end if;
  -- And the same line WITHOUT a marker is accepted, so the refusal above was
  -- about the marker rather than about anything else in the row.
  insert into public.sendset_response_lines (response_id, parent_kind, target_kind, action, note)
  values (r3, 'message', 'sendset', 'respond', 'words');

  -- ---- ONE LIKE PER ITEM PER SUBMISSION -------------------------------------
  begin
    insert into public.sendset_response_lines
           (response_id, parent_kind, target_kind, target_item_id, target_label, action,
            live_publication_published_at, rendered_publication_was_current)
    values (r1, 'actions', 'item', item_a, 'Harbor House', 'like', now(), true);
    ok := false;
    begin
      insert into public.sendset_response_lines
             (response_id, parent_kind, target_kind, target_item_id, target_label, action,
              live_publication_published_at, rendered_publication_was_current)
      values (r1, 'actions', 'item', item_a, 'Harbor House', 'like', now(), true);
    exception when unique_violation then ok := true; end;
    if not ok then raise exception '0059 PROOF: one capability hearted one item twice'; end if;

    -- Two capabilities may hold their own line for the same item.
    insert into public.sendset_response_lines
           (response_id, parent_kind, target_kind, target_item_id, target_label, action,
            live_publication_published_at, rendered_publication_was_current)
    values (r2, 'actions', 'item', item_a, 'Harbor House', 'like', now(), true);
  end;

  -- ---- AN ACTION SESSION IS NEVER NOTIFIED ----------------------------------
  perform public.mark_sendset_response_notified(r1);
  if (select notified_at from public.sendset_responses where id = r1) is not null then
    raise exception '0059 PROOF: an action session was marked notified';
  end if;

  -- ---- THE ITEM LOOKUP, BOTH SHAPES -----------------------------------------
  declare
    legacy jsonb := jsonb_build_object('sections', jsonb_build_array(jsonb_build_object(
      'items', jsonb_build_array(jsonb_build_object('id', item_a::text, 'title', 'Harbor House')))));
    blocky jsonb := jsonb_build_object('sections', '[]'::jsonb, 'blocks', jsonb_build_array(
      jsonb_build_object('kind', 'heading', 'id', gen_random_uuid()::text, 'text', 'Venues'),
      jsonb_build_object('kind', 'item', 'id', gen_random_uuid()::text,
                         'item', jsonb_build_object('id', item_a::text, 'title', 'The Foundry'))));
  begin
    if public.sendset_publication_item(legacy, item_a)->>'label' <> 'Harbor House' then
      raise exception '0059 PROOF: a legacy publication item was not found';
    end if;
    if public.sendset_publication_item(blocky, item_a)->>'label' <> 'The Foundry' then
      raise exception '0059 PROOF: a block publication item was not found';
    end if;
    if public.sendset_publication_item(legacy, gen_random_uuid()) is not null
       or public.sendset_publication_item(blocky, gen_random_uuid()) is not null then
      raise exception '0059 PROOF: an item that is not in the publication was found in it';
    end if;
    -- Present but untitled is NOT absent.
    if public.sendset_publication_item(
         jsonb_build_object('sections', jsonb_build_array(jsonb_build_object(
           'items', jsonb_build_array(jsonb_build_object('id', item_a::text, 'title', '  '))))), item_a) is null then
      raise exception '0059 PROOF: an untitled item read as missing';
    end if;
  end;

  -- ---- THE COUNTER IS A COUNTER ---------------------------------------------
  insert into public.sendset_action_rate (packet_id, window_start, mutations) values (pk, now(), 3);
  if (select count(*) from public.sendset_action_rate where packet_id = pk) <> 1 then
    raise exception '0059 PROOF: the rate counter keeps more than one row per Sendset';
  end if;
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'sendset_action_rate';
  if n <> 3 then
    raise exception '0059 PROOF: the rate counter carries % columns; it may hold a window, a count and nothing else', n;
  end if;
  select count(*) into n from pg_constraint
   where conrelid = 'public.sendset_action_rate'::regclass and contype = 'f' and confdeltype = 'c';
  if n <> 1 then raise exception '0059 PROOF: the rate counter does not cascade with its Sendset'; end if;

  -- ---- DELETION STILL WORKS, AND STILL REFUSES ------------------------------
  ok := false;
  begin
    delete from public.packets where id = pk;
  exception when foreign_key_violation then ok := true; end;
  if not ok then raise exception '0059 PROOF: a plain DELETE destroyed a Sendset that had responses'; end if;

  select count(*) into n from public.sendset_responses where packet_id = pk;
  ok := false;
  begin
    perform public.delete_sendset(u, pk, n - 1);
  exception when others then ok := sqlstate = 'PT409'; end;
  if not ok then raise exception '0059 PROOF: delete_sendset accepted the wrong count'; end if;

  -- The exact count removes the Sendset, every submission of both kinds, their
  -- lines, and the rate counter.
  perform public.delete_sendset(u, pk, n);
  if exists (select 1 from public.packets where id = pk)
     or exists (select 1 from public.sendset_responses where packet_id = pk)
     or exists (select 1 from public.sendset_action_rate where packet_id = pk) then
    raise exception '0059 PROOF: an acknowledged delete_sendset left something behind';
  end if;
  delete from public.users where id = u;

  -- ---- LOCKED DOWN, IN THE CATALOG ------------------------------------------
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'sendset_action_rate'
     and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role');
  if n > 0 then raise exception '0059 PROOF: % privilege(s) on the rate counter', n; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.sendset_action_rate'::regclass) then
    raise exception '0059 PROOF: row level security is not enabled on the rate counter';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sendset_action_rate') then
    raise exception '0059 PROOF: a policy exists on the rate counter';
  end if;

  select count(*) into n from information_schema.role_routine_grants
   where specific_schema = 'public'
     and routine_name in ('set_sendset_item_action', 'clear_sendset_item_action',
                          'read_sendset_session_actions', 'sendset_publication_item')
     and grantee in ('PUBLIC', 'anon', 'authenticated');
  if n > 0 then raise exception '0059 PROOF: % function grant(s) held by an unprivileged role', n; end if;

  select count(*) into n from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('set_sendset_item_action', 'clear_sendset_item_action', 'read_sendset_session_actions')
     and prosecdef
     and exists (select 1 from unnest(proconfig) cfg where cfg like 'search_path=%' and cfg not like '%public%');
  if n <> 3 then raise exception '0059 PROOF: % of 3 functions are SECURITY DEFINER with an empty search_path', n; end if;

  -- The fixture leaves nothing behind.
  if exists (select 1 from public.users where email = '0059-proof@example.invalid') then
    raise exception '0059 PROOF: the fixture survived';
  end if;
end $$;

commit;
