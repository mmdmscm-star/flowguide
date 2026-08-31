-- ============================================================================
-- 0043 — A DECISION BUTTON SHOULD PERFORM THE DECISION.
--
-- The privacy contract surfaces a note it will not place, and asks the
-- professional what to do. Until now the only answers were "I've handled this"
-- and "Leave it out", and NEITHER did anything to the material:
--
--   * the contract had already cleared `notes` on the item, so the excerpt in
--     `review` was the only surviving copy;
--   * both dispositions REMOVE that excerpt on settle — 0027's retention rule,
--     which is correct, because an indefinite second copy of raw source outside
--     the 0024/0026 evidence lifecycle is the thing those migrations exist to
--     prevent;
--   * so whichever button was pressed the note was gone, and "I've handled
--     this" had not helped anyone handle anything.
--
-- This adds a third disposition, `kept_private`, which writes the excerpt into
-- the item's creator-only `notes` and only then settles the unit.
--
-- ---------------------------------------------------------------------------
-- THIS DOES NOT WEAKEN THE RULE THAT AI CANNOT INVENT PRIVACY.
--
-- 0027 refused this function any ability to edit content, and the reasoning was
-- right: FlowGuide choosing a destination is the error the whole slice exists
-- to prevent. What changes is WHO chooses. The model still cannot mark anything
-- private without source authority. A professional can, explicitly, on one
-- named record — and the function then carries out the decision they made
-- rather than asking them to do it by hand and tick a box afterwards.
--
-- ---------------------------------------------------------------------------
-- SAME SIGNATURE, ON PURPOSE.
--
-- `p_status` was validated inside the function rather than by a CHECK, so a
-- third value needs no signature change. CREATE OR REPLACE on the same identity
-- preserves the OID, the owner and the ACL — the EXECUTE grant to service_role
-- and the revokes from public/anon/authenticated all stand untouched. A new
-- signature would have created a NEW function defaulting EXECUTE to PUBLIC,
-- which is how a SECURITY DEFINER routine quietly becomes callable by anon. The
-- revokes are re-asserted below anyway, because being right by accident is not
-- the same as being right.
--
-- Everything else in 0027 is carried forward unchanged.
-- ============================================================================

begin;

create or replace function public.resolve_review_unit(
  p_owner uuid, p_run_id uuid, p_unit_id text, p_status text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $rru$
declare
  v_run record; v_review jsonb; v_unit jsonb; v_failures jsonb; v_remaining int;
  v_text text; v_item uuid; v_matches int;
begin
  if p_status not in ('resolved', 'ignored', 'kept_private') then
    raise exception 'review: status must be resolved, ignored or kept_private (got %)', p_status;
  end if;

  -- FOR UPDATE serialises concurrent resolutions of the same run. Two creators
  -- (or two tabs) clearing the last two units must not both observe "one left".
  select * into v_run from public.ingestion_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'review: run % not found', p_run_id; end if;
  if v_run.user_id <> p_owner then raise exception 'review: caller does not own run'; end if;
  if v_run.status <> 'needs_review' then
    raise exception 'review: run % is % — units are resolved only while it needs review', p_run_id, v_run.status;
  end if;

  v_review := coalesce(v_run.review, '{}'::jsonb);

  -- BY STABLE ID, never by array position. An index is not an identity: it moves
  -- when anything else in the array changes, and a stale client would clear a
  -- different unit than the one the professional was looking at.
  declare v_matches int;
  begin
    select count(*) into v_matches
      from jsonb_array_elements(coalesce(v_review->'failures', '[]'::jsonb)) f
     where f->>'id' = p_unit_id;
    if v_matches = 0 then
      raise exception 'review: unit % not found on run %', p_unit_id, p_run_id;
    end if;
    -- AMBIGUITY IS NOT RESOLVED BY PICKING ONE. A plain SELECT INTO would take
    -- the first match and silently mutate one of two units the caller cannot
    -- tell apart. Duplicate ids mean the writer is broken; fail loudly.
    if v_matches > 1 then
      raise exception 'review: unit id % appears % times on run % — ids must be unique',
        p_unit_id, v_matches, p_run_id;
    end if;
  end;

  select f into v_unit
    from jsonb_array_elements(coalesce(v_review->'failures', '[]'::jsonb)) f
   where f->>'id' = p_unit_id;

  -- STALE WRITE GUARD. Acting on a unit someone already handled is a no-op that
  -- reports itself, not a silent overwrite.
  if coalesce(v_unit->>'status', 'unresolved') <> 'unresolved' then
    return jsonb_build_object('changed', false, 'unit', p_unit_id,
                              'status', v_unit->>'status', 'reason', 'already resolved');
  end if;

  -- =======================================================================
  -- KEEP AS PRIVATE NOTE — the disposition that actually performs the decision.
  --
  -- The other two settle review state and nothing else, which was the whole
  -- complaint: the professional was asked to decide, and the button only
  -- dismissed the question. Worse, settling REMOVES the excerpt, and for a note
  -- the contract had already cleared out of the item that excerpt was the last
  -- copy — so both available answers destroyed the material.
  --
  -- THIS IS NOT THE MODEL DECIDING. 0027's rule stands: FlowGuide may not
  -- choose a destination. Here the professional chooses it, explicitly, and the
  -- function carries it out. Authority comes from a human act, which is exactly
  -- the distinction the privacy contract is built on.
  --
  -- The write happens BEFORE the unit settles, in this one transaction. If the
  -- item cannot be found, or two share a title, or the update fails, the whole
  -- call rolls back: the unit stays unresolved and its text stays readable.
  -- There is no ordering in which the excerpt is removed and the note is not
  -- saved.
  -- =======================================================================
  if p_status = 'kept_private' then
    v_text := v_unit->>'text';
    if v_text is null or btrim(v_text) = '' then
      raise exception 'review: unit % has no text to keep', p_unit_id;
    end if;
    -- IDENTITY IS THE ID, NOT THE NAME.
    --
    -- The unit already carries `itemIds`: finalize attaches it, and attaches it
    -- only when the title resolves to exactly one item — so an ambiguous name
    -- arrives here as no id rather than as a guess. Matching on title again
    -- would rebuild that ambiguity after the pipeline had already settled it,
    -- and two firms sharing a name would make an answerable question
    -- unanswerable. The title stays display text; it is not the boundary.
    if jsonb_typeof(v_unit->'itemIds') <> 'array' then
      raise exception 'review: unit % carries no item to write to', p_unit_id;
    end if;
    select count(*) into v_matches from jsonb_array_elements_text(v_unit->'itemIds');
    if v_matches <> 1 then
      raise exception 'review: unit % names % items — it must name exactly one', p_unit_id, v_matches;
    end if;
    v_item := (v_unit->'itemIds'->>0)::uuid;

    -- OWNER-SCOPED, and scoped to THIS run's packet. The id came from our own
    -- review JSON, but a stored id is still an input: an item belonging to
    -- another packet — or another person — must not be writable through a
    -- review unit, whatever the JSON says.
    select count(*) into v_matches
      from public.items i
      join public.sections s on s.id = i.section_id
      join public.packets p on p.id = s.packet_id
     where i.id = v_item and s.packet_id = v_run.packet_id and p.user_id = p_owner;
    if v_matches <> 1 then
      raise exception 'review: unit % points at an item that is not in this FlowGuide', p_unit_id;
    end if;

    -- APPEND, NEVER REPLACE. An existing private note is the professional's own
    -- writing and outranks anything arriving from an import.
    --
    -- The position() guard makes a retry idempotent: a double-click, or a
    -- client that resends after a dropped response, cannot paste the same
    -- paragraph twice. The status guard above already covers the ordinary
    -- second click; this covers a retry that never learned the first succeeded.
    --
    -- ONLY `notes` IS TOUCHED. Nothing recipient-facing — not title, not
    -- description, not details, links, photos or contacts — is reachable here.
    update public.items
       set notes = case
             when coalesce(btrim(notes), '') = '' then v_text
             when position(v_text in notes) > 0   then notes
             else notes || E'\n\n' || v_text
           end
     where id = v_item;
    if not found then
      raise exception 'review: could not write the private note for unit %', p_unit_id;
    end if;
  end if;

  select jsonb_agg(
           case when f->>'id' = p_unit_id
                -- The excerpt goes; the audit trail stays.
                then (f - 'text') || jsonb_build_object(
                       'status', p_status, 'resolved_at', to_jsonb(now()))
                else f end
           order by ord)
    into v_failures
    from jsonb_array_elements(coalesce(v_review->'failures', '[]'::jsonb)) with ordinality as t(f, ord);

  select count(*) into v_remaining
    from jsonb_array_elements(coalesce(v_failures, '[]'::jsonb)) f
   where coalesce(f->>'status', 'unresolved') = 'unresolved';

  if v_remaining = 0 then
    -- THE LAST UNIT. Review JSON and run status move together or not at all.
    -- The run had already applied its content before entering review, so the
    -- terminal state is finalized, which also frees the one-active-run slot.
    update public.ingestion_runs
       -- The JSON must not still read "failed" once the run is finalized. The
       -- per-unit audit trail in `failures` is what survives; the banner text
       -- that drove the review UI is cleared with the state it described.
       set review = jsonb_set(v_review, '{failures}', coalesce(v_failures, '[]'::jsonb))
                    || jsonb_build_object('ok', true, 'summary', '',
                                          'resolvedAt', to_jsonb(now())),
           status = 'finalized',
           finalized_at = coalesce(finalized_at, now()),
           updated_at = now()
     where id = p_run_id;
  else
    update public.ingestion_runs
       set review = jsonb_set(v_review, '{failures}', coalesce(v_failures, '[]'::jsonb)),
           updated_at = now()
     where id = p_run_id;
  end if;

  return jsonb_build_object('changed', true, 'unit', p_unit_id, 'status', p_status,
                            'remaining', v_remaining, 'runStatus',
                            case when v_remaining = 0 then 'finalized' else 'needs_review' end);
end;
$rru$;


comment on function public.resolve_review_unit(uuid, uuid, text, text) is
  'Settles one review unit. resolved = the professional placed the material themselves; ignored = they discarded it; kept_private = they chose the private note, and this function writes it to that item''s notes before settling. Never edits recipient-facing content.';

-- BELT AND BRACES. CREATE OR REPLACE on an unchanged signature keeps the
-- existing ACL, so these are re-assertions rather than repairs — and they are
-- here so a future signature change cannot silently ship a SECURITY DEFINER
-- function that PUBLIC may execute.
revoke all on function public.resolve_review_unit(uuid, uuid, text, text) from public;
revoke all on function public.resolve_review_unit(uuid, uuid, text, text) from anon, authenticated;
grant execute on function public.resolve_review_unit(uuid, uuid, text, text) to service_role;

do $v$
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'resolve_review_unit') <> 1 then
    raise exception '0043: more than one resolve_review_unit exists — an old overload survives';
  end if;
  -- The ARGUMENT TYPES are the identity; pg_get_function_identity_arguments
  -- also carries the parameter names, which are not part of it.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'resolve_review_unit'
                    and oidvectortypes(p.proargtypes) = 'uuid, uuid, text, text') then
    raise exception '0043: the function identity changed — the ACL would have been reset';
  end if;
  if has_function_privilege('anon', 'public.resolve_review_unit(uuid, uuid, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.resolve_review_unit(uuid, uuid, text, text)', 'EXECUTE') then
    raise exception '0043: anon or authenticated can execute a SECURITY DEFINER function';
  end if;
  if not has_function_privilege('service_role', 'public.resolve_review_unit(uuid, uuid, text, text)', 'EXECUTE') then
    raise exception '0043: service_role cannot execute the function the application calls';
  end if;
end;
$v$;

commit;
