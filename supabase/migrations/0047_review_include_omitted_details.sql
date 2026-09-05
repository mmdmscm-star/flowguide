-- ============================================================================
-- 0047 — "Add these to the item" ACTUALLY ADDS THEM.
--
-- Phase 1 (shipped 7958824) gave the professional the question: one
-- `source-details-omitted` card per keep_together run, holding the source lines
-- that reached nothing the client would see. On the real Spring Lake run that
-- is eleven lines, including every pricing qualifier that had been vanishing —
-- annual increases, personal-assistance charges, the Community Fee's
-- refundability, the April 1 2026 effective date.
--
-- Its two answers settle the question and move nothing, and settling REMOVES
-- the excerpt (0027's retention rule, which is right). So a professional who
-- wanted those lines in the Sendset had to retype them from a card that was
-- about to disappear. This adds the third answer, `included`, which writes them.
--
-- ---------------------------------------------------------------------------
-- WHAT IT WRITES, AND WHAT IT REFUSES TO WRITE
--
--   * ONE DETAIL PER LINE. Merging them into one row would decide that several
--     facts are one fact.
--   * NO LABEL. These lines have none in the source, and inventing one per line
--     would be this function authoring recipient-facing prose.
--   * THE PROFESSIONAL'S OWN WORDING, minus one thing: a leading ordinary list
--     bullet ('-', en dash, em dash, bullet) and the whitespace around it.
--   * A LEADING '*' OR '**' IS KEPT. It is not layout. The brochure that
--     produced this feature carries `Community Fee**` as a detail and
--     `**The Community Fee is refundable ...` as its footnote; the asterisks
--     are the only thing connecting the fee to its own terms.
--   * NOTHING GOES TO `description`. That is the narrative overflow field the
--     ingestion contract refuses to create.
--
-- ---------------------------------------------------------------------------
-- THE KIND COUPLING IS IN THE DATABASE, NOT ONLY IN THE REGISTRY
--
-- This is a SECURITY DEFINER routine and the registry that decides which kinds
-- may take which disposition lives in application code. `included` is refused
-- unless the STORED unit's kind is exactly `source-details-omitted`, so a route
-- that forgot the check — or a caller that never went through one — cannot
-- write a privacy question's excerpt into a client-facing detail. Every other
-- kind and every other disposition behaves exactly as it did in 0043.
--
-- ---------------------------------------------------------------------------
-- SAME SIGNATURE, ON PURPOSE — the 0043 lesson, restated because it is the one
-- that bites. `p_status` is validated inside the body rather than by a CHECK, so
-- a fourth value needs no signature change. CREATE OR REPLACE on the same
-- identity preserves the OID, the owner and the ACL. A NEW signature would be a
-- NEW function whose EXECUTE defaults to PUBLIC, which is how a SECURITY
-- DEFINER routine quietly becomes callable by anon. The revokes are re-asserted
-- below anyway, because being right by accident is not the same as being right.
--
-- ---------------------------------------------------------------------------
-- DRIFT GUARD
--
-- This reissues a LIVE function. If production is not running 0043's body
-- byte-for-byte, something happened that nobody here knows about, and replacing
-- it would erase that silently. `pg_proc.prosrc` stores the body verbatim, so
-- md5(prosrc) is an exact fingerprint. Expected:
--
--   md5    fb771a95376cd59cbd964c5c2ab7ffb1
--   length 8368 characters (8388 octets)
--
-- Verified reproducible: creating 0043's statement in a disposable Postgres and
-- reading md5(prosrc) returns exactly that.
--
-- ---------------------------------------------------------------------------
-- SIDE EFFECT, STATED RATHER THAN DISCOVERED. `item_details` carries
-- trg_ingest_rev_details, which bumps `packets.content_rev` once PER ROW. Eleven
-- accepted lines bump it eleven times. Harmless — content_rev gates ACTIVE runs
-- and this one is past finalize — but the editor's change detection will see it.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Refuse to replace anything but the function we reviewed.
-- ---------------------------------------------------------------------------
do $guard$
declare v_md5 text; v_len int;
begin
  select md5(p.prosrc), length(p.prosrc) into v_md5, v_len
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'resolve_review_unit'
     and oidvectortypes(p.proargtypes) = 'uuid, uuid, text, text';
  if v_md5 is null then
    raise exception '0047: resolve_review_unit(uuid, uuid, text, text) does not exist';
  end if;
  if v_md5 <> 'fb771a95376cd59cbd964c5c2ab7ffb1' or v_len <> 8368 then
    raise exception '0047: the live resolve_review_unit is not 0043 (md5 %, length %) - do not replace it blind',
      v_md5, v_len;
  end if;
  raise notice '0047 guard: live function matches 0043';
end
$guard$;

-- ---------------------------------------------------------------------------
-- 2. The function, with `included` added and nothing else changed.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_review_unit(
  p_owner uuid, p_run_id uuid, p_unit_id text, p_status text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $rru$
declare
  v_run record; v_review jsonb; v_unit jsonb; v_failures jsonb; v_remaining int;
  v_text text; v_item uuid; v_matches int; v_base int; v_missing int;
begin
  if p_status not in ('resolved', 'ignored', 'kept_private', 'included') then
    raise exception 'review: status must be resolved, ignored, kept_private or included (got %)', p_status;
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
    -- AND THE COUPLING RUNS THE OTHER WAY TOO.
    --
    -- `source-details-omitted` holds the professional's own source lines, most
    -- of them written for the client. Filing them privately would hide them
    -- from the person they were written for, which is why the registry has
    -- never offered that answer for this kind and the route refuses it. This
    -- function is SECURITY DEFINER and the registry is application code, so it
    -- says so itself rather than trusting a caller to have checked.
    --
    -- SCOPED TO THAT ONE KIND. Every other kind's kept_private behaviour is
    -- exactly what 0043 shipped; this adds a refusal, it does not change one.
    if coalesce(v_unit->>'kind', '') = 'source-details-omitted' then
      raise exception 'review: unit % holds source material written for the client — keeping it private is not one of its answers',
        p_unit_id;
    end if;

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

  -- =======================================================================
  -- ADD THESE TO THE ITEM — the second disposition that performs the decision.
  --
  -- `source-details-omitted` holds source lines that reached nothing the client
  -- would see. Until now its only answers settled the question and moved
  -- nothing, and settling REMOVES the excerpt — so a professional who wanted
  -- those lines in the Sendset had to retype them from a card that was about to
  -- disappear.
  --
  -- THE MODEL IS NOT INVOLVED AND NEITHER IS THIS FUNCTION'S JUDGEMENT. Each
  -- line goes in as its own detail, with the professional's own wording and NO
  -- LABEL. Writing a label per line would be this function authoring
  -- recipient-facing prose; merging the lines into one row would decide that
  -- several facts are one. Both are the choices the contract refuses to make.
  --
  -- ONLY AN ORDINARY LIST BULLET IS REMOVED. A leading '-', en dash, em dash or
  -- bullet is layout. A leading '*' or '**' is NOT: the brochure that produced
  -- this feature carries `Community Fee**` as a detail and
  -- `**The Community Fee is refundable ...` as its footnote, and the asterisks
  -- are the only thing connecting them. Stripping them would silently sever a
  -- fee from its own terms.
  -- =======================================================================
  if p_status = 'included' then
    -- THE COUPLING IS ENFORCED HERE, NOT ONLY IN THE APPLICATION.
    --
    -- This is a SECURITY DEFINER function reachable by service_role, and the
    -- registry that decides which kinds may take which disposition lives in
    -- TypeScript. A route that forgot the check — or a caller that never went
    -- through one — must not be able to write a privacy question's excerpt into
    -- a client-facing detail. `included` exists for exactly one kind and the
    -- database says so.
    if coalesce(v_unit->>'kind', '') <> 'source-details-omitted' then
      raise exception 'review: unit % is a % unit — included is not one of its answers',
        p_unit_id, coalesce(nullif(v_unit->>'kind', ''), 'kindless');
    end if;

    v_text := v_unit->>'text';
    if v_text is null or btrim(v_text) = '' then
      raise exception 'review: unit % has no text to add', p_unit_id;
    end if;

    -- IDENTITY IS THE ID, NOT THE NAME — the same rule kept_private follows, and
    -- for the same reason: finalize attaches itemIds only when the title
    -- resolves to exactly one item, so an ambiguous name arrives here as no id
    -- rather than as a guess. Matching on title again would rebuild an
    -- ambiguity the pipeline had already settled.
    -- COALESCED, and that is not cosmetic. jsonb_typeof(NULL) is NULL, so a unit
    -- with NO itemIds key at all makes `<> 'array'` evaluate to NULL and the
    -- test is simply not taken — the missing-key case then falls through to the
    -- count below and is refused with the wrong sentence. It IS refused either
    -- way, which is why this has never mattered; a negative control found it.
    -- Written correctly here and left alone in the kept_private branch above,
    -- because changing that would change an existing disposition's message for
    -- no reason beyond tidiness.
    if coalesce(jsonb_typeof(v_unit->'itemIds'), '') <> 'array' then
      raise exception 'review: unit % carries no item to write to', p_unit_id;
    end if;
    select count(*) into v_matches from jsonb_array_elements_text(v_unit->'itemIds');
    if v_matches <> 1 then
      raise exception 'review: unit % names % items — it must name exactly one', p_unit_id, v_matches;
    end if;
    v_item := (v_unit->'itemIds'->>0)::uuid;

    -- OWNER-SCOPED, and scoped to THIS run's packet. The id came from our own
    -- review JSON, but a stored id is still an input.
    select count(*) into v_matches
      from public.items i
      join public.sections s on s.id = i.section_id
      join public.packets p on p.id = s.packet_id
     where i.id = v_item and s.packet_id = v_run.packet_id and p.user_id = p_owner;
    if v_matches <> 1 then
      raise exception 'review: unit % points at an item that is not in this Sendset', p_unit_id;
    end if;

    -- APPENDED, IN SOURCE ORDER, AFTER WHAT IS ALREADY THERE. sort_order need
    -- not be gap-free — every reader orders by it, and the editor reindexes from
    -- zero on its next save.
    select coalesce(max(sort_order), -1) into v_base
      from public.item_details where item_id = v_item;

    -- IDEMPOTENT IN BOTH DIRECTIONS. `deduped` collapses a line repeated inside
    -- one excerpt; the NOT EXISTS skips a line this item already carries, which
    -- is what makes a retry that never learned the first call succeeded a no-op
    -- rather than a second copy. The status guard above already covers the
    -- ordinary second click.
    with parsed as (
      select btrim(regexp_replace(t.line, '^[[:space:]]*[-–—•][[:space:]]*', '')) as line,
             t.ord as ord
        from unnest(string_to_array(v_text, E'\n')) with ordinality as t(line, ord)
    ), deduped as (
      select p.line, min(p.ord) as ord from parsed p where p.line <> '' group by p.line
    ), fresh as (
      select d.line, d.ord from deduped d
       where not exists (select 1 from public.item_details x
                          where x.item_id = v_item and x.value = d.line)
    )
    insert into public.item_details (item_id, label, value, sort_order)
    select v_item, '', f.line, v_base + row_number() over (order by f.ord)
      from fresh f;

    -- PROVE IT LANDED. An insert that silently affected nothing would settle the
    -- unit and destroy its excerpt with the content nowhere. Every non-empty
    -- line of the excerpt must now be a detail on this item, or the whole
    -- transaction goes back and the unit stays unresolved with its text intact.
    select count(*) into v_missing from (
      select btrim(regexp_replace(t.line, '^[[:space:]]*[-–—•][[:space:]]*', '')) as line
        from unnest(string_to_array(v_text, E'\n')) as t(line)
    ) q
     where q.line <> ''
       and not exists (select 1 from public.item_details x
                        where x.item_id = v_item and x.value = q.line);
    if v_missing > 0 then
      raise exception 'review: % line(s) of unit % were not written', v_missing, p_unit_id;
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
  'Settles one review unit. resolved = the professional placed the material themselves; ignored = they discarded it; kept_private = they chose the private note, and this function writes it to that item''s notes; included = they accepted omitted source lines, and this function writes one label-less detail per line to that item. `included` is refused for any kind but source-details-omitted, and source-details-omitted is refused kept_private - it holds material written for the client.';

-- BELT AND BRACES. CREATE OR REPLACE on an unchanged signature keeps the
-- existing ACL, so these are re-assertions rather than repairs.
revoke all on function public.resolve_review_unit(uuid, uuid, text, text) from public;
revoke all on function public.resolve_review_unit(uuid, uuid, text, text) from anon, authenticated;
grant execute on function public.resolve_review_unit(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Structural verification. Anything wrong rolls the whole migration back.
--    Behavioural proof - that the refusals actually refuse - is deliberately
--    outside this transaction, as 0020 established, and is in the PGlite
--    harness instead.
-- ---------------------------------------------------------------------------
do $v$
declare v_src text;
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'resolve_review_unit') <> 1 then
    raise exception '0047: more than one resolve_review_unit exists - an old overload survives';
  end if;
  -- The ARGUMENT TYPES are the identity; pg_get_function_identity_arguments
  -- also carries the parameter names, which are not part of it.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'resolve_review_unit'
                    and oidvectortypes(p.proargtypes) = 'uuid, uuid, text, text') then
    raise exception '0047: the function identity changed - the ACL would have been reset';
  end if;
  if has_function_privilege('anon', 'public.resolve_review_unit(uuid, uuid, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.resolve_review_unit(uuid, uuid, text, text)', 'EXECUTE') then
    raise exception '0047: anon or authenticated can execute a SECURITY DEFINER function';
  end if;
  if not has_function_privilege('service_role', 'public.resolve_review_unit(uuid, uuid, text, text)', 'EXECUTE') then
    raise exception '0047: service_role cannot execute the function the application calls';
  end if;

  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'resolve_review_unit';

  -- The new disposition exists, and it is bound to its one kind.
  if position('included' in v_src) = 0 then
    raise exception '0047: the replacement does not carry the included disposition';
  end if;
  -- BOTH DIRECTIONS, IN THE FUNCTION ITSELF. Asserted by the two distinct
  -- comparisons rather than by counting the kind's name, which also appears in
  -- the body's comments — prosrc keeps those, so a count would be a test of the
  -- prose rather than of the rules.
  if position('<> ''source-details-omitted'' then' in v_src) = 0 then
    raise exception '0047: included is not restricted to source-details-omitted in the function itself';
  end if;
  if position('= ''source-details-omitted'' then' in v_src) = 0
     or position('keeping it private is not one of its answers' in v_src) = 0 then
    raise exception '0047: source-details-omitted can still be filed as a private note';
  end if;
  -- The three older dispositions survived the replacement.
  if position('kept_private' in v_src) = 0 or position('resolved' in v_src) = 0
     or position('ignored' in v_src) = 0 then
    raise exception '0047: a pre-existing disposition was lost in the replacement';
  end if;
  -- AND THE FOOTNOTE MARKERS ARE NOT STRIPPED. The bullet class must not have
  -- learned about asterisks - that would sever a fee from its own terms, and it
  -- is the one substantive thing this migration could get wrong silently.
  if (select count(*) from regexp_matches(v_src, '\^\[\[:space:\]\]\*\[\-–—•\]\[\[:space:\]\]\*', 'g')) <> 2 then
    raise exception '0047: the list-bullet rule is not the one that was reviewed, in both places';
  end if;
  -- The class must contain NO asterisk anywhere in the function.
  if position('[-–—•*]' in v_src) > 0 or position('[*' in v_src) > 0 then
    raise exception '0047: the marker class strips asterisks - footnote markers would be lost';
  end if;

  raise notice '0047 verify: OK';
end
$v$;

commit;
