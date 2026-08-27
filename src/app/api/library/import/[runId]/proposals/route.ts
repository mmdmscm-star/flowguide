import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { loadImportRun, loadImportChunks, loadChunkTexts } from "@/lib/library-import-service";
import { derivePhase, orderProposals } from "@/lib/library-import";
import { planContinuationMerges } from "@/lib/library-continuation";
import { priceWarningsFor, sourceTextFor } from "@/lib/library-price-gate";
import { completenessWarnings, missingFromChunk } from "@/lib/source-completeness";
import { noteWarningsFor } from "@/lib/library-notes-gate";
import { attributionWarningsFor } from "@/lib/attribution-conflict";
import { attributePhotos, unplacedPhotos } from "@/lib/photo-attribution";

type Context = { params: Promise<{ runId: string }> };

// GET  — restore the review exactly as it was left.
// POST — materialise staged model output into durable proposals (idempotent).

async function proposalsFor(
  supabase: ReturnType<typeof createServerClient>, runId: string,
) {
  const { data } = await supabase
    .from("library_import_proposals")
    .select("id, ordinal, idx, payload, selected")
    .eq("run_id", runId);
  return (data ?? []).map((p: Record<string, unknown>) => ({
    id: p.id as string,
    ordinal: Number(p.ordinal),
    idx: Number(p.idx),
    selected: Boolean(p.selected),
    ...(p.payload as Record<string, unknown>),
  }));
}

export async function GET(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await context.params;
  const supabase = createServerClient();

  const { run, error } = await loadImportRun(supabase, session.userId, runId);
  if (error || !run) return NextResponse.json({ error: error ?? "not_found" }, { status: error === "wrong_destination" ? 409 : 404 });

  const chunks = await loadImportChunks(supabase, runId);
  const proposals = await proposalsFor(supabase, runId);

  return NextResponse.json({
    phase: derivePhase(run.status, chunks),
    run: { id: run.id, status: run.status, totalChunks: run.totalChunks, completedChunks: run.completedChunks },
    // SOURCE ORDER, not (ordinal, idx) order — a split chunk's children carry
    // higher ordinals while their text belongs mid-paste.
    proposals: orderProposals(proposals, chunks),
  });
}

export async function POST(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await context.params;
  const supabase = createServerClient();

  const { run, error } = await loadImportRun(supabase, session.userId, runId);
  if (error || !run) return NextResponse.json({ error: error ?? "not_found" }, { status: error === "wrong_destination" ? 409 : 404 });

  const chunks = await loadImportChunks(supabase, runId);
  if (derivePhase(run.status, chunks) !== "review") {
    return NextResponse.json({
      error: "not_ready",
      message: "The import is still being organized.",
    }, { status: 409 });
  }

  // IDEMPOTENT. Safe to call on every reconnect: the RPC inserts with
  // `on conflict do nothing`, so proposals already reviewed and edited are left
  // exactly as the professional left them.
  const { data, error: rpcErr } = await supabase.rpc("library_materialize_proposals", {
    p_owner: session.userId, p_run_id: runId,
  });
  if (rpcErr) return NextResponse.json({ error: "materialize_failed", message: rpcErr.message }, { status: 400 });

  // ONE COMMUNITY, ONE PROPOSAL.
  //
  // materialise expands every item of every chunk, so a community whose text
  // straddles a chunk boundary arrives as two half-populated records. Folded
  // here — PERSISTED, not merely presented, because `save` reads the table and
  // a read-time merge would still write two Library items.
  //
  // Idempotent: once a pair is folded there is no adjacent duplicate left to
  // find, so a reconnect that calls this again changes nothing.
  let proposals = await proposalsFor(supabase, runId);
  const plans = planContinuationMerges(orderProposals(proposals, chunks));
  for (const plan of plans) {
    const { id: keepId, ordinal: _o, idx: _i, selected: _s, ...payload } = plan.merged as Record<string, unknown>;
    void _o; void _i; void _s;
    await supabase.from("library_import_proposals")
      .update({ payload }).eq("run_id", runId).eq("id", keepId as string);
    await supabase.from("library_import_proposals")
      .delete().eq("run_id", runId).eq("id", plan.absorb.id as string);
  }
  if (plans.length) proposals = await proposalsFor(supabase, runId);

  // PRICE PROVENANCE, surfaced. A value or range the community's own source
  // never states is written onto the proposal so the review shows it. This is
  // the UX half only — `save` audits again from source and does not trust it.
  const chunkTexts = await loadChunkTexts(supabase, runId);

  // PHOTOS ARE ATTRIBUTED FROM THE FULL SOURCE, not from the chunk and not by
  // the model. A community's Pictures block can cross a chunk boundary, so its
  // tail arrives beside the NEXT community and is attached there or dropped.
  // A photo URL appears verbatim in exactly one block, so its owner is a fact.
  const { data: runRow } = await supabase
    .from("ingestion_runs").select("source_text").eq("id", runId).maybeSingle();
  const fullSource = String((runRow as { source_text?: string } | null)?.source_text ?? "");
  const allTitles = proposals.map((q) => String((q as { title?: unknown }).title ?? ""));

  for (const p of proposals) {
    const { id, ordinal: _o, idx: _i, selected: _s, ...payload } = p as Record<string, unknown>;
    void _o; void _i; void _s;
    const attrib = fullSource
      ? attributePhotos(payload as { title?: unknown; photos?: unknown }, fullSource, allTitles)
      : { photos: (payload as { photos?: unknown }).photos as string[], resolved: false, removed: [], added: [] };
    if (attrib.resolved) (payload as { photos?: unknown }).photos = attrib.photos;
    const withOrdinal = { ...payload, ordinal: (p as { ordinal: number }).ordinal };
    const warnings = priceWarningsFor(withOrdinal, chunkTexts);
    // A fact the source LABELS and the record does not carry — surfaced, not
    // blocked. An unsupported price is a false statement to a client; a missing
    // phone is an omission, and the professional decides what to do about it.
    // Chunk-scoped: a labelled fact is lost only when NO record from that
    // chunk carries it. Auditing a record against the whole chunk reports its
    // neighbours' facts as missing — a chunk usually holds several communities.
    const ord = (p as { ordinal: number }).ordinal;
    const siblings = proposals.filter((q) => (q as { ordinal: number }).ordinal === ord)
      .map((q) => { const { id: _id, ordinal: _oo, idx: _ii, selected: _ss, ...rest } = q as Record<string, unknown>;
                    void _id; void _oo; void _ii; void _ss; return rest; });
    const m = missingFromChunk(siblings, sourceTextFor(withOrdinal, chunkTexts));
    const missing = [
      ...m.phones.map((x) => `phone not carried over: ${x}`),
      ...m.emails.map((x) => `email not carried over: ${x}`),
      ...m.websites.map((x) => `website not carried over: ${x}`),
    ];
    // A private note must trace to source that says it is private, for THIS
    // record. Surfaced here; save re-derives and re-checks.
    // Content sourced from another identifiable record must not quietly become
    // this record's client-facing description. Verbatim evidence only — a NAME
    // appearing is never evidence, since related communities cite each other.
    const attribWarn = fullSource
      ? attributionWarningsFor(payload as { title?: unknown; description?: unknown }, fullSource, allTitles)
      : [];
    const noteWarn = noteWarningsFor(withOrdinal, proposals as never, chunkTexts);
    const had = Array.isArray((payload as { priceWarnings?: unknown }).priceWarnings)
      ? ((payload as { priceWarnings: unknown[] }).priceWarnings as string[]) : [];
    const hadM = Array.isArray((payload as { completenessWarnings?: unknown }).completenessWarnings)
      ? ((payload as { completenessWarnings: unknown[] }).completenessWarnings as string[]) : [];
    const hadN = Array.isArray((payload as { noteWarnings?: unknown }).noteWarnings)
      ? ((payload as { noteWarnings: unknown[] }).noteWarnings as string[]) : [];
    const hadA = Array.isArray((payload as { attributionWarnings?: unknown }).attributionWarnings)
      ? ((payload as { attributionWarnings: unknown[] }).attributionWarnings as string[]) : [];
    const photosChanged = attrib.resolved && (attrib.added.length > 0 || attrib.removed.length > 0);
    if (!photosChanged && warnings.join("|") === had.join("|") && missing.join("|") === hadM.join("|")
        && noteWarn.join("|") === hadN.join("|") && attribWarn.join("|") === hadA.join("|")) continue;
    await supabase.from("library_import_proposals")
      .update({ payload: { ...payload, priceWarnings: warnings, completenessWarnings: missing, noteWarnings: noteWarn, attributionWarnings: attribWarn } })
      .eq("run_id", runId).eq("id", id as string);
  }
  proposals = await proposalsFor(supabase, runId);

  // A source photo that reaches no record at all. With span attribution this
  // should be empty; if it is not, it is reported rather than left to be found
  // by counting rows later.
  const finalRows = await proposalsFor(supabase, runId);
  const unplaced = fullSource ? unplacedPhotos(finalRows as { photos?: unknown }[], fullSource) : [];

  return NextResponse.json({
    inserted: Number(data ?? 0),
    merged: plans.length,
    unplacedPhotos: unplaced.length,
    phase: "review",
    proposals: orderProposals(finalRows, chunks),
  });
}
