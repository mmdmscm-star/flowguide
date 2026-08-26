import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { loadImportRun } from "@/lib/library-import-service";
import { loadChunkTexts } from "@/lib/library-import-service";
import { auditProposal, priceBlockMessage } from "@/lib/library-price-gate";
import { auditProposalNote, noteBlockMessage } from "@/lib/library-notes-gate";

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
    .from("library_import_proposals").select("id, payload").eq("run_id", runId);
  const { data: rows } = explicit ? await query.in("id", explicit) : await query.eq("selected", true);
  const targets = (rows ?? []) as { id: string; payload: Record<string, unknown> }[];

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
  // Every proposal of the run, not just the selected ones: a record's span ends
  // where its NEIGHBOUR begins, so the neighbours are needed even when they are
  // not being saved.
  const { data: allRows } = await supabase
    .from("library_import_proposals").select("ordinal, payload").eq("run_id", runId);
  const allProposals = ((allRows ?? []) as { ordinal: number; payload: Record<string, unknown> }[])
    .map((r) => ({ ordinal: Number(r.ordinal), ...r.payload }));

  const results: { id: string; title: string; outcome: string; libraryItemId?: string; message?: string }[] = [];
  for (const t of targets) {
    const title = String(t.payload?.title ?? "").trim();

    // Re-derived from authoritative source, ignoring any stored warning.
    const noteV = auditProposalNote({ ...t.payload }, allProposals as never, chunkTexts);
    if (!noteV.ok) {
      results.push({ id: t.id, title, outcome: "private_note_unverified",
                     message: noteBlockMessage(title, noteV) });
      continue;
    }

    const audit = auditProposal({ ...t.payload }, chunkTexts);
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
