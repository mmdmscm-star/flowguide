import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { loadImportRun } from "@/lib/library-import-service";
import { loadChunkTexts, loadImportChunks } from "@/lib/library-import-service";
import { auditProposal, priceBlockMessage } from "@/lib/library-price-gate";
import { auditProposalNote, noteBlockMessage } from "@/lib/library-notes-gate";
import { auditAttribution } from "@/lib/attribution-conflict";
import { ambiguousRanges, withoutAmbiguous, doubtFor, provenanceWarningsFor,
         unresolvedOrdinals, withoutAmbiguousChunks } from "@/lib/ambiguous-provenance";

type Context = { params: Promise<{ runId: string }> };

// POST /api/library/import/:runId/save — turn the selected proposals into
// Library entries.
//
// EVERY ENTRY GOES THROUGH library_save_proposal AND NOTHING ELSE. This route
// does not insert into library_items, and must never be changed to: the RPC is
// the only place where creating the entry and consuming the proposal happen in
// one transaction. A second writer here would reintroduce exactly the crash
// window 0021 exists to close, and would also bypass the title rule.
//
// One request rather than forty: a batch of twenty to forty is normal, and a
// single duplicate or untitled item must not fail the rest.
export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await context.params;
  const supabase = createServerClient();

  const { run, error } = await loadImportRun(supabase, session.userId, runId);
  if (error || !run) return NextResponse.json({ error: error ?? "not_found" }, { status: error === "wrong_destination" ? 409 : 404 });
  if (run.status !== "active") {
    return NextResponse.json({ error: "import_closed", message: "This import is closed." }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));
  const explicit: string[] | null = Array.isArray(body.proposalIds) ? body.proposalIds : null;

  const query = supabase
    .from("library_import_proposals").select("id, ordinal, payload").eq("run_id", runId);
  const { data: rows } = explicit ? await query.in("id", explicit) : await query.eq("selected", true);
  const targets = (rows ?? []) as { id: string; ordinal: number; payload: Record<string, unknown> }[];

  if (targets.length === 0) {
    return NextResponse.json({ error: "nothing_selected", message: "Select at least one item to save." }, { status: 400 });
  }

  // THE INTEGRITY BOUNDARY.
  //
  // The audit runs AGAIN here, from the chunk text, and deliberately ignores
  // the `priceWarnings` stored on the payload. Those warnings are UX: they live
  // in a payload the client can PATCH, so gating on them would mean the gate
  // could be cleared by editing the very thing it guards. A price the community
  //'s own source never states must not become a Library item, because from
  // there it reaches a client as a quote.
  const chunkTexts = await loadChunkTexts(supabase, runId);

  // Attribution is re-derived from the run's own source text, not read from the
  // stored warning: the warning lives in a payload the client can PATCH.
  const { data: runSrc } = await supabase
    .from("ingestion_runs").select("source_text").eq("id", runId).maybeSingle();
  const fullSource = String((runSrc as { source_text?: string } | null)?.source_text ?? "");
  // Every proposal of the run, not just the selected ones: a record's span ends
  // where its NEIGHBOUR begins, so the neighbours are needed even when they are
  // not being saved.
  const { data: allRows } = await supabase
    .from("library_import_proposals").select("ordinal, payload").eq("run_id", runId);
  const allProposals = ((allRows ?? []) as { ordinal: number; payload: Record<string, unknown> }[])
    .map((r) => ({ ordinal: Number(r.ordinal), ...r.payload }));
  // The same list, as titles: a record's span ends where its NEIGHBOUR begins,
  // so every title is needed to bound one span — not only the selected ones.
  const allTitles = allProposals.map((q) => String((q as { title?: unknown }).title ?? "")).filter(Boolean);

  // A record whose identity the source cannot confirm does not only fail for
  // itself: it stops bounding its neighbour, whose span then runs through its
  // block and is trusted for photos, notes and description alike. Re-derived
  // here from the run's own chunks — the stored warning lives in a payload the
  // client can PATCH, so it is evidence of nothing.
  const chunkRows = await loadImportChunks(supabase, runId);
  const orderedChunks = [...chunkRows].sort((a, b) => a.sourceStart - b.sourceStart);
  const chunkRanges = orderedChunks.map((c, i) => ({
    ordinal: c.ordinal,
    start: c.sourceStart,
    end: i + 1 < orderedChunks.length ? orderedChunks[i + 1].sourceStart : fullSource.length,
  }));
  const ambiguous = fullSource ? ambiguousRanges(allProposals as never, fullSource, chunkRanges) : [];
  // Positive evidence only ever comes from source nobody else may own.
  const provenanceSource = withoutAmbiguous(fullSource, ambiguous);
  // Same reason as the full source: the note gate reads chunk text, so an
  // unconfirmable record's chunk must prove nothing there either.
  const provenanceChunks = fullSource
    ? withoutAmbiguousChunks(chunkTexts, unresolvedOrdinals(allProposals as never, fullSource))
    : chunkTexts;

  const results: { id: string; title: string; outcome: string; libraryItemId?: string; message?: string }[] = [];
  for (const t of targets) {
    const title = String(t.payload?.title ?? "").trim();

    // Re-derived from authoritative source, ignoring any stored warning.
    // ORDINAL IS A COLUMN, NOT PART OF THE PAYLOAD. Without it
    // sourceOrdinalsOf resolves nothing, the source text comes back empty, and
    // both gates condemn every record they are asked about — an empty source
    // supports no price and proves no note private. Production smoke caught
    // exactly that: a supported price and a genuinely private note were both
    // refused, because neither gate could see any source at all.
    const withProvenance = { ordinal: Number(t.ordinal), ...t.payload };
    // PROVENANCE DOUBT IS JUDGED FIRST. Every gate below asks what this record's
    // source says about it; that question is meaningless while the boundary
    // deciding which source is its own remains unknown. Reporting a downstream
    // symptom instead — production smoke saw "the private note is unverified",
    // which was true but told the professional to go and look at the note —
    // sends them to the wrong place. The unlocatable neighbour is the problem.
    if (fullSource) {
      const doubt = doubtFor(withProvenance, fullSource, allTitles, ambiguous);
      if (doubt.unresolved || doubt.overlapping) {
        results.push({ id: t.id, title, outcome: "ambiguous_provenance",
          message: provenanceWarningsFor(withProvenance, fullSource, allTitles, ambiguous)[0] });
        continue;
      }
    }

    // A private note must trace to source that says it is private, for THIS
    // record. A provable cross-record attribution conflict blocks the save.
    // FlowGuide does not move the content back and does not delete it: the
    // source may be mistaken, or it may be a legitimate cross-reference between
    // communities under one operator. Only the professional can say.
    const noteV = auditProposalNote(withProvenance, allProposals as never, provenanceChunks);
    if (!noteV.ok) {
      results.push({ id: t.id, title, outcome: "private_note_unverified",
                     message: noteBlockMessage(title, noteV) });
      continue;
    }

    if (fullSource) {
      const attrib = auditAttribution(t.payload as { title?: unknown; description?: unknown }, provenanceSource, allTitles);
      if (!attrib.ok) {
        const owner = attrib.conflicts[0]?.owner;
        results.push({ id: t.id, title, outcome: "attribution_conflict",
          message: attrib.resolved
            ? `Part of ${title || "this record"}'s description appears in your source under “${owner}”, not under this community. Confirm where it belongs before saving.`
            : `FlowGuide could not locate ${title || "this record"} in your source, so it cannot confirm the description belongs to it. Check it before saving.` });
        continue;
      }
    }

    const audit = auditProposal(withProvenance, chunkTexts);
    if (!audit.ok) {
      const offending = [...audit.unsupported, ...audit.unsupportedRanges];
      results.push({ id: t.id, title, outcome: "unsupported_price",
                     message: priceBlockMessage(title, offending) });
      continue;
    }

    const { data, error: rpcErr } = await supabase.rpc("library_save_proposal", {
      p_owner: session.userId, p_run_id: runId, p_proposal_id: t.id,
    });
    if (rpcErr) {
      // An untitled item is the one failure a professional can act on, so it is
      // named rather than lumped in with "couldn't save".
      const needsTitle = /no title/i.test(rpcErr.message);
      results.push({ id: t.id, title, outcome: needsTitle ? "needs_title" : "failed", message: rpcErr.message });
      continue;
    }
    // NULL means the proposal was already consumed — precisely what a retry
    // after a timeout looks like. It is a no-op, never a second entry.
    results.push(data
      ? { id: t.id, title, outcome: "saved", libraryItemId: data as string }
      : { id: t.id, title, outcome: "already_saved" });
  }

  const saved = results.filter((r) => r.outcome === "saved").length;
  const blocked = results.filter((r) => r.outcome === "unsupported_price" || r.outcome === "private_note_unverified").length;
  const { count: remaining } = await supabase
    .from("library_import_proposals").select("id", { count: "exact", head: true }).eq("run_id", runId);

  return NextResponse.json({ saved, blocked, remaining: remaining ?? 0, results });
}
