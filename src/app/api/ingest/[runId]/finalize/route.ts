import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

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
  return NextResponse.json({ ok: true, ...(data as object) });
}
