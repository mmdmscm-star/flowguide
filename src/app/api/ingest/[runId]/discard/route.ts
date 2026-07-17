import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

type Context = { params: Promise<{ runId: string }> };

// POST /api/ingest/:runId/discard — abandon an import. Clears staged source +
// model results; deletes the orphan draft if this was an empty initial organize.
export async function POST(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await context.params;
  const supabase = createServerClient();

  const { data, error } = await supabase.rpc("discard_ingestion_run", {
    p_run_id: runId,
    p_owner: session.userId,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, ...(data as object) });
}
