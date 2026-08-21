-- 0027 — resolving a review unit is a LIFECYCLE mutation.
--
-- WHY AN RPC RATHER THAN A ROUTE
-- Clearing the last unresolved unit must do three things or none of them:
-- update the unit, decide whether any remain, and — if none do — take the run
-- out of `needs_review` so 0013's publish block lifts. Split across a route
-- those are three round trips, and the state between them is a packet whose
-- review JSON says "all clear" while its run status still blocks publishing, or
-- worse the reverse. One function, one transaction, one truth.
--
-- WHAT IT DELIBERATELY CANNOT DO
-- It governs review state and lifecycle. It never edits item content. "Resolved"
-- is the professional's assertion that they handled the information using the
-- ordinary editor — into Description, into Details, or deliberately into Private
-- Note. FlowGuide choosing that destination is the error this whole slice exists
-- to prevent, so the function is given no ability to make it.
--
-- p_owner IS NOT A CREDENTIAL
-- It is an assertion the caller must have already earned. The route MUST derive
-- it from the authenticated session and never from the request body, or this
-- becomes "resolve anyone's review by guessing a uuid". The function does the
-- half it can: it refuses when the run does not belong to the owner passed.
--
-- RETENTION
-- While a unit is unresolved its verbatim source excerpt lives in `review`,
-- because the creator cannot adjudicate what they cannot read. The moment it is
-- resolved or ignored that excerpt is REMOVED and only audit metadata remains —
-- id, code, status, record/item reference, timestamp. Otherwise `review` would
-- become an indefinite second copy of raw source content sitting outside the
-- 0026 evidence lifecycle, which is precisely the thing 0024 and 0026 exist to
-- prevent.

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
begin
  if p_status not in ('resolved', 'ignored') then
    raise exception 'review: status must be resolved or ignored (got %)', p_status;
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
  'Resolve or ignore ONE review unit by stable id. Atomically clears the run out of needs_review when the last unit is handled, and strips the verbatim source excerpt on resolution. Never edits item content.';

-- SERVER-SIDE ROLE ONLY.
--
-- PUBLIC holds EXECUTE on a new function by default, and every logged-in visitor
-- is a member of it — so the revoke is what actually closes this, not the grant.
-- anon and authenticated are named explicitly as well, so the intent survives a
-- future role change.
revoke all on function public.resolve_review_unit(uuid, uuid, text, text) from public;
revoke all on function public.resolve_review_unit(uuid, uuid, text, text) from anon, authenticated;
grant execute on function public.resolve_review_unit(uuid, uuid, text, text) to service_role;

commit;
