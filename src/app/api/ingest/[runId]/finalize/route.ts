import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { buildMediaLedger, describeMediaFailures, type StoredMedia } from "@/lib/media-ledger";

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
  const result = data as { packet_id?: string } | null;
  const packetId = result?.packet_id;
  let review: { ok: boolean; summary: string; failures: unknown[] } | undefined;

  if (packetId) {
    try {
      const { data: packet } = await supabase
        .from("packets").select("raw_input").eq("id", packetId).maybeSingle();
      const source = (packet as { raw_input?: string } | null)?.raw_input ?? "";

      const { data: sections } = await supabase.from("sections").select("id").eq("packet_id", packetId);
      const sectionIds = (sections ?? []).map((s: { id: string }) => s.id);
      const stored: StoredMedia[] = [];
      if (sectionIds.length > 0) {
        const { data: items } = await supabase.from("items").select("id").in("section_id", sectionIds);
        const itemIds = (items ?? []).map((i: { id: string }) => i.id);
        if (itemIds.length > 0) {
          const { data: photos } = await supabase
            .from("item_photos").select("item_id, url").in("item_id", itemIds);
          for (const p of (photos ?? []) as Array<{ item_id: string; url: string }>) {
            stored.push({ url: p.url, itemId: p.item_id });
          }
        }
      }

      const ledger = buildMediaLedger({ source, stored });
      review = { ok: ledger.ok, summary: describeMediaFailures(ledger.failures), failures: ledger.failures };

      if (!ledger.ok) {
        console.error("[finalize] media accounting failed", { runId, packetId, failures: ledger.failures });
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
