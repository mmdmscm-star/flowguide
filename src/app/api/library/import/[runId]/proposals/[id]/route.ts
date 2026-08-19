import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { normalizeItemContent } from "@/lib/item-content";
import { loadImportRun } from "@/lib/library-import-service";

type Context = { params: Promise<{ runId: string; id: string }> };

// PATCH — edit a proposal, or select/deselect it.
//
// THIS IS WHY THE REVIEW LAYER IS PERSISTED. For an import of twenty to forty
// items, review is a sitting rather than a moment, and losing an hour of edits
// to a closed tab is the same class of failure that made extraction persistent.
export async function PATCH(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId, id } = await context.params;
  const supabase = createServerClient();

  const { run, error } = await loadImportRun(supabase, session.userId, runId);
  if (error || !run) return NextResponse.json({ error: error ?? "not_found" }, { status: error === "wrong_destination" ? 409 : 404 });
  if (run.status !== "active") {
    return NextResponse.json({ error: "import_closed", message: "This import is closed." }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.item !== undefined) {
    // The SAME normaliser the Library's own write paths use, so an edited
    // proposal and a hand-written entry cannot end up shaped differently.
    patch.payload = normalizeItemContent(body.item as Record<string, unknown>);
  }
  if (typeof body.selected === "boolean") patch.selected = body.selected;
  if (patch.payload === undefined && patch.selected === undefined) {
    return NextResponse.json({ error: "bad_request", message: "Nothing to change." }, { status: 400 });
  }

  const { data, error: upErr } = await supabase
    .from("library_import_proposals")
    .update(patch)
    .eq("id", id).eq("run_id", runId)      // run scoping; the run is owner-scoped above
    .select("id, ordinal, idx, payload, selected")
    .maybeSingle();
  if (upErr) return NextResponse.json({ error: "update_failed", message: upErr.message }, { status: 400 });
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const p = data as Record<string, unknown>;
  return NextResponse.json({
    proposal: {
      id: p.id, ordinal: Number(p.ordinal), idx: Number(p.idx),
      selected: Boolean(p.selected), ...(p.payload as Record<string, unknown>),
    },
  });
}
