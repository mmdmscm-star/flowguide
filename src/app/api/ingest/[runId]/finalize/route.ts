import { NextResponse } from "next/server";
import { collapseRunToOneItem, type CollapseDb } from "@/lib/collapse-run";
import { groupingOf } from "@/lib/grouping";
import { assessRecovery, recoveryMessage, type RecoveryVerdict } from "@/lib/ingest-recovery";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { buildMediaLedger, describeMediaFailures, type StoredMedia } from "@/lib/media-ledger";
import { describeReviewExit, discardWouldDeletePacket } from "@/lib/review-exit";
import { checkRunOutcome } from "@/lib/run-guards";
import { attachItems, unitId, type ReviewFailure } from "@/lib/review-units";
import { buildOmission } from "@/lib/omitted-source";

export const maxDuration = 60;
type Context = { params: Promise<{ runId: string }> };

// POST /api/ingest/:runId/finalize — apply the combined staged result to the
// canonical packet in one transaction (idempotent). The RPC verifies ownership,
// draft status, coverage/completeness, applies + clears staged material atomically.
export async function POST(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await context.params;
  const supabase = createServerClient();

  // Read the origin marker BEFORE finalizing. finalize_ingestion_run clears
  // packets.origin_ingestion_run_id on its way through, and discard's
  // delete-the-empty-draft rule depends on it — so after the RPC there is no
  // way to tell whether this run created the packet. Best-effort: a failure
  // here must never stop a finalize.
  const { data: preRow } = await supabase
    .from("ingestion_runs").select("packet_id, destination").eq("id", runId).eq("user_id", session.userId).maybeSingle();

  // A LIBRARY IMPORT DOES NOT FINALIZE INTO ANYTHING. finalize_ingestion_run
  // refuses it at the database, but a professional should never see a raw
  // database refusal — and the correct next step has a name, so say it.
  if ((preRow as { destination?: string } | null)?.destination === "library") {
    return NextResponse.json({
      error: "wrong_destination",
      message: "This is a Library import. Finish it from your Library instead.",
    }, { status: 409 });
  }
  const prePacketId = (preRow as { packet_id?: string } | null)?.packet_id;
  let createdThisPacket = false;
  if (prePacketId) {
    const { data: prePacket } = await supabase
      .from("packets").select("origin_ingestion_run_id").eq("id", prePacketId).maybeSingle();
    createdThisPacket = (prePacket as { origin_ingestion_run_id?: string | null } | null)?.origin_ingestion_run_id === runId;
  }

  // THE PROFESSIONAL'S DECISION, carried in the request rather than inferred.
  // Set only by the recovery panel, after it was told recovery is possible.
  // rebaseline_ingestion_run re-checks the invariants itself: this flag moves a
  // baseline, it does not grant permission to ignore anything.
  let acceptStructuralChange = false;
  try {
    const body = (await _request.json().catch(() => ({}))) as { acceptStructuralChange?: unknown };
    acceptStructuralChange = body?.acceptStructuralChange === true;
  } catch { /* no body is the normal case */ }

  if (acceptStructuralChange) {
    const { error: rebaseErr } = await supabase.rpc("rebaseline_ingestion_run", {
      p_run_id: runId,
      p_owner: session.userId,
    });
    if (rebaseErr) {
      console.error("[finalize] rebaseline error:", rebaseErr.message);
      const gone = /target section no longer valid/i.test(rebaseErr.message);
      return NextResponse.json({
        error: gone ? "target_section_missing" : "rebaseline_failed",
        message: gone
          ? "The section this content was being added to no longer exists. Discard this import and run it again on the section you want."
          : "Could not re-check this Sendset. Try again.",
      }, { status: 409 });
    }
  }

  // KEEP_TOGETHER IS A RUN-LEVEL FACT, AND THIS IS WHERE IT IS HONOURED.
  //
  // Each chunk was told to return one item, but chunking is an implementation
  // detail the professional never agreed to: a 26-row sheet is 1,077 characters
  // and still becomes five chunks on the segmenter's six-item budget. Five
  // obedient chunks would become five identically-named items, because
  // finalize_ingestion_run inserts every item of every chunk and recombines
  // only at section level, "never by title".
  //
  // So the run's proposals are folded once, here — the last moment every
  // chunk's result is visible together and nothing has reached the packet. It
  // reads the PERSISTED intent, so a resumed or retried finalize behaves the
  // same as the first one, and it is idempotent: folding one already-folded
  // item reproduces it.
  //
  // A FAILURE HERE STOPS THE FINALIZE. Applying a keep_together run as several
  // items is the exact outcome the creator asked us to avoid, and it cannot be
  // undone afterwards without them deleting items by hand.
  const { data: groupingRow } = await supabase
    .from("ingestion_runs")
    .select("grouping_intent, grouping_title, source_text, delimiter_hint")
    .eq("id", runId).eq("user_id", session.userId).maybeSingle();
  const grouping = groupingOf(groupingRow as { grouping_intent?: unknown; grouping_title?: unknown } | null);
  const collapse = await collapseRunToOneItem(
    supabase as unknown as CollapseDb, runId, grouping);
  if (collapse.kind === "error") {
    console.error("[finalize] keep-together collapse failed", { runId, message: collapse.message });
    return NextResponse.json({
      error: "collapse_failed",
      message: "Could not combine this into one item, so nothing was applied. Please try again.",
    }, { status: 500 });
  }

  // WHAT THE SOURCE SAYS AND THIS ITEM DOES NOT — asked ONCE, here, about the
  // item the collapse just assembled.
  //
  // This is the only moment it can be asked honestly. Per chunk it is the wrong
  // question: on the run this was built for, the chunk-local test finds 58
  // orphans and most are artefacts — a bullet absent from its own chunk and
  // present in the packet two chunks later, a transcription line-wrap with no
  // independent existence. Asked once against the assembled item, the same run
  // yields 11, and they are the material qualifiers that were disappearing.
  //
  // ONE UNIT FOR THE RUN. Not one per line and not one per chunk: a single
  // structural mistake must not become dozens of decisions.
  //
  // keep_together ONLY, for now. Under `auto` there is no single assembled item
  // to ask about, the unbound rule already holds ungoverned proposals, and what
  // enabling it would do to existing imports has not been measured. It reads
  // the run's PERSISTED intent, the same value the fold above used.
  //
  // AND IT FAILS CLOSED. It was best-effort in its first version, which was
  // wrong: this check is the only thing standing between a pricing qualifier
  // and silent loss, so swallowing its failure publishes the Sendset while
  // reporting that everything passed. A detector failure is not an omission and
  // not an absence of one — it is an unanswered question, and it must not be
  // turned into either. Nothing has been applied at this line, and the fold is
  // idempotent, so the run is left exactly as retryable as it was.
  let omissionUnit: ReviewFailure | null = null;
  if (collapse.kind === "collapsed") {
    const gr = groupingRow as { source_text?: string | null; delimiter_hint?: string | null } | null;
    const omission = buildOmission(collapse.segments, collapse.item as unknown as Record<string, unknown>,
      { sourceText: gr?.source_text ?? "", delimiterHint: gr?.delimiter_hint ?? null });
    if (!omission.ok) {
      console.error("[finalize] omission check failed", { runId, message: omission.message });
      return NextResponse.json({
        error: "omission_check_failed",
        message: "Could not check that every detail from your source made it in, so nothing was applied. Please try again.",
      }, { status: 500 });
    }
    if (omission.text) {
      // Content-derived id, so a replayed finalize recomputes the same unit
      // rather than adding a second copy of the same question. chunk -1
      // records that this is the run's, not any one chunk's.
      omissionUnit = {
        id: unitId(runId, { chunk: -1, record: 0, kind: "source-details-omitted", text: omission.text }),
        code: "source_details_omitted", kind: "source-details-omitted",
        record: 0, chunk: -1, title: grouping.title, text: omission.text,
        reason: "present in the source and in nothing the client would see",
        status: "unresolved",
      };
    }
  }

  const { data, error } = await supabase.rpc("finalize_ingestion_run", {
    p_run_id: runId,
    p_owner: session.userId,
  });
  if (error) {
    // Raw Postgres text ("ingestion: chunk 2 not completed") must not reach the
    // editor banner. Map the known conditions to something a professional can
    // act on; keep the original in the logs for diagnosis.
    const incomplete = /not completed|coverage|cover the whole/i.test(error.message);
    const changed = /structure changed since the import began|changed since the import began|structural_rev|content_rev/i.test(error.message);
    const targetGone = /target section no longer valid/i.test(error.message);
    console.error("[finalize] rpc error:", error.message);

    // THE STRUCTURAL CONFLICT IS RECOVERABLE, so it is not reported as a
    // failure. The completed work is still there; the professional is asked
    // what to do with it. Whether "add it anyway" may be OFFERED is decided by
    // assessRecovery, never assumed — applying over unaccountable media would
    // finalize successfully and leave the FlowGuide unpublishable.
    if (changed && !targetGone) {
      const verdict = await assessRunRecovery(supabase, runId);
      return NextResponse.json({
        error: "structure_changed",
        message: recoveryMessage(verdict),
        recovery: { canApply: verdict.canApply, blockers: verdict.blockers },
      }, { status: 409 });
    }
    if (targetGone) {
      return NextResponse.json({
        error: "target_section_missing",
        message: "The section this content was being added to no longer exists. Discard this import and run it again on the section you want.",
        recovery: { canApply: false, blockers: [{ code: "target_section_missing" }] },
      }, { status: 409 });
    }
    const message = incomplete
      ? "Some parts haven't finished yet. Resume the import to finish them."
      : "Could not combine the results. You can retry.";
    return NextResponse.json({ error: "finalize_failed", message }, { status: incomplete ? 409 : 400 });
  }
  // ---- Exact media accounting (Stage 1).
  //
  // Runs HERE, once, after the whole run is applied — never per chunk. Per-chunk
  // accounting would need cross-chunk visibility and would break the claim/lease
  // model that migration 0012 hardened; no chunk ever reads another chunk's
  // state. Counting is the only defense against a silent loss: the failure this
  // guards is ABSENCE, which no per-value validation can see.
  //
  // Objective failures (missing / duplicated / not-in-source media) put the run
  // into needs_review and block publishing. This does NOT prove a photo sits on
  // the RIGHT item — that needs per-item provenance, which is Stage 2.
  // The packet id comes from the RUN ROW, not from the RPC result:
  // finalize_ingestion_run returns {status, reused, sections, items} and no
  // packet_id. Reading it from the result silently disabled this entire block.
  const { data: runRow } = await supabase
    .from("ingestion_runs").select("packet_id, entry_point").eq("id", runId).eq("user_id", session.userId).maybeSingle();
  const run = runRow as { packet_id?: string; entry_point?: string } | null;
  const packetId = run?.packet_id;
  let review: { ok: boolean; summary: string; exit: string; failures: unknown[] } | undefined;

  if (packetId) {
    try {
      const { data: packet } = await supabase
        .from("packets").select("raw_input, status, origin_ingestion_run_id").eq("id", packetId).maybeSingle();
      const pk = packet as { raw_input?: string; status?: string; origin_ingestion_run_id?: string | null } | null;
      const source = pk?.raw_input ?? "";

      const { data: sections } = await supabase.from("sections").select("id").eq("packet_id", packetId);
      const sectionIds = (sections ?? []).map((s: { id: string }) => s.id);
      const stored: StoredMedia[] = [];
      let itemCount = 0;
      if (sectionIds.length > 0) {
        const { data: items } = await supabase.from("items").select("id").in("section_id", sectionIds);
        const itemIds = (items ?? []).map((i: { id: string }) => i.id);
        itemCount = itemIds.length;
        if (itemIds.length > 0) {
          const { data: photos } = await supabase
            .from("item_photos").select("item_id, url").in("item_id", itemIds);
          for (const p of (photos ?? []) as Array<{ item_id: string; url: string }>) {
            stored.push({ url: p.url, itemId: p.item_id });
          }
        }
      }

      const { count: blockCount } = await supabase
        .from("packet_blocks").select("id", { count: "exact", head: true }).eq("packet_id", packetId);
      const isEmpty = sectionIds.length === 0 && stored.length === 0 && (blockCount ?? 0) === 0 && itemCount === 0;

      const ledger = buildMediaLedger({ source, stored });
      const failures: unknown[] = [...ledger.failures];
      const summaries = ledger.failures.length ? [describeMediaFailures(ledger.failures)] : [];

      // REVIEW-REQUIRED UNITS.
      //
      // Enforcement refused a placement the model proposed and held the prose
      // rather than choosing a destination for it. Gathered here, once, from
      // the dedicated product-state column - never from `fact_ledger`, which is
      // evidence and must stay unreadable to product behaviour, or a change to
      // what we record for diagnosis could change what a professional is asked.
      //
      // Ids were assigned at production time, so this is aggregation, not
      // derivation: two chunks reporting the same excerpt on the same record
      // collapse to the one decision they always were.
      const byId = new Map<string, ReviewFailure>();
      const { data: chunkRows } = await supabase
        .from("ingestion_chunks").select("review_units").eq("run_id", runId);
      for (const c of (chunkRows ?? []) as Array<{ review_units?: ReviewFailure[] | null }>) {
        for (const u of c.review_units ?? []) if (u?.id && !byId.has(u.id)) byId.set(u.id, u);
      }
      // The run-level omission joins the per-chunk units here, so it is
      // aggregated, titled and settled by exactly the same machinery.
      if (omissionUnit && !byId.has(omissionUnit.id)) byId.set(omissionUnit.id, omissionUnit);
      // Title to item id, only where the title names exactly ONE item. A title
      // shared by two items must not point the professional at whichever one
      // happened to sort first.
      const byTitle = new Map<string, string[]>();
      if (sectionIds.length > 0) {
        const { data: titled } = await supabase
          .from("items").select("id, title").in("section_id", sectionIds);
        for (const it of (titled ?? []) as Array<{ id: string; title: string | null }>) {
          const k = String(it.title ?? "");
          if (!k) continue;
          byTitle.set(k, [...(byTitle.get(k) ?? []), it.id]);
        }
      }
      const unitFailures: ReviewFailure[] = attachItems([...byId.values()], byTitle);
      if (unitFailures.length) {
        failures.push(...unitFailures);
        summaries.push(unitFailures.length === 1
          ? "1 piece of information needs a decision before publishing."
          : `${unitFailures.length} pieces of information need a decision before publishing.`);
      }

      // Advisories are RECORDED but never block. Today that is exactly
      // media_consolidated: the source listed one url twice inside a single
      // record and the packet holds one copy, so every distinct photo a client
      // could see is present. Keeping them out of `failures` is what stops
      // "1 photo is missing" from parking a run whose only exit is discarding
      // the import — while keeping them in the payload preserves the evidence.
      if (ledger.advisories.length) {
        console.warn("[finalize] media advisories (not blocking)", {
          runId, packetId, advisories: ledger.advisories,
        });
      }

      // Run-level outcome. Per-chunk validation cannot see this: every chunk can
      // report success while the run as a whole produced nothing. Mode-aware —
      // an append run may legitimately add no NEW item. Skipped on an idempotent
      // replay, which returns `reused` and no counts.
      const applied = data as { reused?: boolean; items?: number };
      if (!applied?.reused) {
        const outcome = checkRunOutcome({
          entryPoint: run?.entry_point ?? "organize",
          source,
          itemsCreated: applied?.items ?? 0,
        });
        if (outcome) {
          failures.push(outcome);
          summaries.push(outcome.summary);
          console.error("[finalize] run produced nothing", { runId, packetId, usableChars: outcome.usableChars });
        }
      }

      const ok = failures.length === 0;

      // A run held for review did not really finish, so the packet it created is
      // still an orphan-import candidate. finalize cleared that marker assuming
      // the run succeeded; restore it for an EMPTY packet this run created, so
      // discard does what 0012 already intends — remove the empty draft instead
      // of stranding the professional in one. Discard re-evaluates emptiness at
      // discard time, so a packet they meanwhile fill in is preserved and the
      // marker is dropped then.
      const disposition = {
        entryPoint: run?.entry_point ?? "organize",
        isOriginRun: createdThisPacket,
        isDraft: pk?.status === "draft",
        isEmpty,
      };
      const willRemovePacket = !ok && discardWouldDeletePacket(disposition);
      if (willRemovePacket) {
        const { error: markErr } = await supabase
          .from("packets").update({ origin_ingestion_run_id: runId }).eq("id", packetId);
        if (markErr) console.error("[finalize] could not restore origin marker:", markErr.message);
      }

      // Mirrors discard_ingestion_run's own predicate, so the sentence promises
      // exactly what the SQL will do.
      // Discard is still the exit for a media loss or an empty run. It stops
      // being the exit when every blocker is a decision the professional can
      // make right here.
      const allResolvable = failures.length > 0 && failures.length === unitFailures.length;
      const exit = describeReviewExit({ ...disposition, isOriginRun: willRemovePacket }, { allResolvable });
      review = {
        ok, summary: summaries.join(" "), exit, failures,
        ...(ledger.advisories.length
          ? { advisories: ledger.advisories, advisorySummary: describeMediaFailures(ledger.advisories) }
          : {}),
      };

      // A run someone already cleared must not be pushed back into review by a
      // replayed finalize. `reused` alone is the wrong test: a finalize that
      // applied and then died before writing its review would also be a replay,
      // and skipping it there would leave the run finalized with unresolved
      // work and publishing open. So ask the state instead - only a run that
      // has been AFFIRMATIVELY cleared is left alone.
      const { data: nowRow } = await supabase
        .from("ingestion_runs").select("status, review").eq("id", runId).maybeSingle();
      const cleared = (nowRow as { status?: string; review?: { ok?: boolean } } | null);
      const alreadyDecided = cleared?.status === "finalized" && cleared?.review?.ok === true;

      if (!ok && alreadyDecided) {
        console.warn("[finalize] replay on an already-cleared run; leaving review alone", { runId, packetId });
      } else if (!ok) {
        console.error("[finalize] run needs review", { runId, packetId, failures });
        // Persisting the review state needs migration 0013 (the `needs_review`
        // status and the `review` column). Until it is applied this write fails
        // harmlessly and the failure still reaches the caller and the logs —
        // deliberately tolerant, so a clean run never depends on the migration.
        const { error: reviewErr } = await supabase
          .from("ingestion_runs")
          .update({ status: "needs_review", review })
          .eq("id", runId)
          .eq("user_id", session.userId);
        if (reviewErr) console.error("[finalize] could not persist needs_review:", reviewErr.message);
      }
    } catch (e) {
      // Accounting must never destroy an otherwise successful import.
      console.error("[finalize] media accounting threw:", e);
    }
  }

  return NextResponse.json({ ok: true, ...(data as object), review });
}

/**
 * Gather what the recovery decision needs, then decide.
 *
 * Reads the CURRENT packet, because that is the state "apply anyway" would
 * apply into. The projection inside assessRecovery mirrors what finalize will
 * write to raw_input; a test asserts the two agree for both entry points, so
 * this cannot drift into falsely blocking ordinary FlowGuides.
 */
async function assessRunRecovery(
  supabase: ReturnType<typeof createServerClient>,
  runId: string,
): Promise<RecoveryVerdict> {
  const { data: runRow } = await supabase
    .from("ingestion_runs")
    .select("packet_id, entry_point, source_text, target_section_id")
    .eq("id", runId).maybeSingle();
  const run = runRow as {
    packet_id?: string; entry_point?: string;
    source_text?: string; target_section_id?: string | null;
  } | null;
  // Without the run we cannot judge, and the SAFE answer is to withhold the
  // override rather than offer one we could not check.
  if (!run?.packet_id) return { canApply: false, blockers: [] };

  const { data: packet } = await supabase
    .from("packets").select("raw_input").eq("id", run.packet_id).maybeSingle();

  const { data: sections } = await supabase.from("sections").select("id").eq("packet_id", run.packet_id);
  const sectionIds = (sections ?? []).map((x: { id: string }) => x.id);
  const stored: Array<{ url: string; itemId: string }> = [];
  if (sectionIds.length > 0) {
    const { data: items } = await supabase.from("items").select("id").in("section_id", sectionIds);
    const itemIds = (items ?? []).map((x: { id: string }) => x.id);
    if (itemIds.length > 0) {
      const { data: photos } = await supabase
        .from("item_photos").select("item_id, url").in("item_id", itemIds);
      for (const ph of (photos ?? []) as Array<{ item_id: string; url: string }>) {
        stored.push({ url: ph.url, itemId: ph.item_id });
      }
    }
  }

  let targetSectionValid: boolean | undefined;
  if (run.entry_point === "section_append") {
    targetSectionValid = run.target_section_id
      ? sectionIds.includes(run.target_section_id)
      : false;
  }

  return assessRecovery({
    entryPoint: String(run.entry_point ?? ""),
    rawInput: (packet as { raw_input?: string } | null)?.raw_input ?? "",
    sourceText: run.source_text ?? "",
    storedPhotos: stored,
    targetSectionValid,
  });
}
