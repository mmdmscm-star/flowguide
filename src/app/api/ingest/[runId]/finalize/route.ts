import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { buildMediaLedger, describeMediaFailures, type StoredMedia } from "@/lib/media-ledger";
import { describeReviewExit, discardWouldDeletePacket } from "@/lib/review-exit";
import { checkRunOutcome } from "@/lib/run-guards";
import { toReviewFailures, type ReviewFailure } from "@/lib/review-units";
import type { UnresolvedUnit } from "@/lib/enforce-chunk";

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

  const { data, error } = await supabase.rpc("finalize_ingestion_run", {
    p_run_id: runId,
    p_owner: session.userId,
  });
  if (error) {
    // Raw Postgres text ("ingestion: chunk 2 not completed") must not reach the
    // editor banner. Map the known conditions to something a professional can
    // act on; keep the original in the logs for diagnosis.
    const incomplete = /not completed|coverage|cover the whole/i.test(error.message);
    const changed = /changed since the import began|content_rev/i.test(error.message);
    console.error("[finalize] rpc error:", error.message);
    const message = incomplete
      ? "Some parts haven't finished yet. Resume the import to finish them."
      : changed
        ? "This packet changed while the import was running, so it wasn't combined. Discard the import and try again."
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

      // UNRESOLVED SOURCE UNITS.
      //
      // Enforcement refused a placement the model proposed and held the prose
      // rather than choosing a destination for it. Those decisions are gathered
      // here, once, from the chunk ledgers where they were recorded - the same
      // place and the same moment as media accounting, because both answer the
      // one question finalize exists to ask: is anything from the source
      // unaccounted for.
      const units: UnresolvedUnit[] = [];
      const { data: chunkRows } = await supabase
        .from("ingestion_chunks").select("fact_ledger").eq("run_id", runId);
      for (const c of (chunkRows ?? []) as Array<{ fact_ledger?: { unresolved?: UnresolvedUnit[] } }>) {
        for (const u of c.fact_ledger?.unresolved ?? []) units.push(u);
      }
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
      const unitFailures: ReviewFailure[] = toReviewFailures(runId, units, byTitle);
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

      if (!ok) {
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
