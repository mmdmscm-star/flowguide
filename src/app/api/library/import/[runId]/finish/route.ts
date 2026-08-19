import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { loadImportRun } from "@/lib/library-import-service";
import { unsavedAtFinish } from "@/lib/library-import";

type Context = { params: Promise<{ runId: string }> };

// POST /api/library/import/:runId/finish — "I am done with this import."
//
// FINISH IS NOT ABANDON, and the difference is the whole reason these are two
// routes rather than one `close` taking a status. Both end the run and both drop
// whatever proposals remain, so a single generic endpoint would make discarding
// a professional's reviewed work indistinguishable from completing it — one
// mistyped argument away from silent loss.
//
// Finishing therefore REFUSES while anything is left, and says what and how many,
// until the professional acknowledges it explicitly. Nothing is deleted by a
// request that did not know what it was deleting.
export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await context.params;
  const supabase = createServerClient();

  const { run, error } = await loadImportRun(supabase, session.userId, runId);
  if (error || !run) return NextResponse.json({ error: error ?? "not_found" }, { status: error === "wrong_destination" ? 409 : 404 });

  const body = await request.json().catch(() => ({}));
  const acknowledged = body.discardUnsaved === true;

  const { data: rows } = await supabase
    .from("library_import_proposals").select("selected").eq("run_id", runId);
  const unsaved = unsavedAtFinish((rows ?? []) as { selected: boolean }[]);

  if (unsaved.needsAcknowledgement && !acknowledged) {
    return NextResponse.json({
      error: "unsaved_proposals",
      message: unsaved.selected > 0
        ? `${unsaved.total} item${unsaved.total === 1 ? "" : "s"} are still here, and ${unsaved.selected} ${unsaved.selected === 1 ? "is" : "are"} selected but not saved yet.`
        : `${unsaved.total} item${unsaved.total === 1 ? "" : "s"} are still here and will not be kept.`,
      total: unsaved.total,
      selected: unsaved.selected,
    }, { status: 409 });
  }

  const { data, error: rpcErr } = await supabase.rpc("library_close_import_run", {
    p_owner: session.userId, p_run_id: runId, p_status: "finalized",
  });
  if (rpcErr) return NextResponse.json({ error: "finish_failed", message: rpcErr.message }, { status: 400 });

  const res = data as { droppedProposals?: number; reused?: boolean };
  return NextResponse.json({ status: "finished", dropped: res?.droppedProposals ?? 0, reused: res?.reused ?? false });
}
