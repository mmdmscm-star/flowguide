import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { loadImportRun, loadImportChunks } from "@/lib/library-import-service";
import { derivePhase, orderProposals } from "@/lib/library-import";

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

  const proposals = await proposalsFor(supabase, runId);
  return NextResponse.json({
    inserted: Number(data ?? 0),
    phase: "review",
    proposals: orderProposals(proposals, chunks),
  });
}
