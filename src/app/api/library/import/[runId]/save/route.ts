import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { loadImportRun } from "@/lib/library-import-service";

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

  const results: { id: string; title: string; outcome: string; libraryItemId?: string; message?: string }[] = [];
  for (const t of targets) {
    const title = String(t.payload?.title ?? "").trim();
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
  const { count: remaining } = await supabase
    .from("library_import_proposals").select("id", { count: "exact", head: true }).eq("run_id", runId);

  return NextResponse.json({ saved, remaining: remaining ?? 0, results });
}
