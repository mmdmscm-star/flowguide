import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { loadImportRun } from "@/lib/library-import-service";

type Context = { params: Promise<{ runId: string }> };

// POST /api/library/import/:runId/abandon — "throw this import away."
//
// Deliberately a SEPARATE route from finish, with its own required confirmation.
// Both end the run, but they mean opposite things to the person doing them, and
// an endpoint whose meaning depends on an argument is an endpoint that will
// eventually be called with the wrong one.
//
// Anything already saved to the Library STAYS saved — a Library entry is a copy
// and has no further relationship to the import that proposed it.
export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await context.params;
  const supabase = createServerClient();

  const { run, error } = await loadImportRun(supabase, session.userId, runId);
  if (error || !run) return NextResponse.json({ error: error ?? "not_found" }, { status: error === "wrong_destination" ? 409 : 404 });

  const body = await request.json().catch(() => ({}));
  if (body.confirm !== true) {
    const { count } = await supabase
      .from("library_import_proposals").select("id", { count: "exact", head: true }).eq("run_id", runId);
    return NextResponse.json({
      error: "confirm_required",
      message: `Abandoning throws away this import${count ? ` and its ${count} proposed item${count === 1 ? "" : "s"}` : ""}. Anything you already saved stays in your Library.`,
      remaining: count ?? 0,
    }, { status: 409 });
  }

  const { data, error: rpcErr } = await supabase.rpc("library_close_import_run", {
    p_owner: session.userId, p_run_id: runId, p_status: "discarded",
  });
  if (rpcErr) return NextResponse.json({ error: "abandon_failed", message: rpcErr.message }, { status: 400 });

  const res = data as { droppedProposals?: number; reused?: boolean };
  return NextResponse.json({ status: "abandoned", dropped: res?.droppedProposals ?? 0, reused: res?.reused ?? false });
}
