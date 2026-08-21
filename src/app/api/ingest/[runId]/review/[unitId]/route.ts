import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

type Context = { params: Promise<{ runId: string; unitId: string }> };

// POST /api/ingest/:runId/review/:unitId  { status: "resolved" | "ignored" }
//
// THE OWNER IS THE SESSION. It is read from getSession() and from nowhere else.
// A body-supplied owner id would reduce "resolve someone else's review" to
// guessing a uuid, and the RPC cannot tell a forged owner from a real one - it
// can only check that the owner it was given matches the run, which is exactly
// half of the guarantee. This route is the other half.
//
// The RPC does the rest in one transaction: it verifies the run belongs to that
// owner, refuses a run that is not in needs_review, refuses a status outside
// resolved/ignored, strips the verbatim excerpt, and - only when the last unit
// clears - takes the run out of needs_review so the publish block lifts.
export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId, unitId } = await context.params;

  let status = "";
  try {
    const body = (await request.json()) as { status?: unknown };
    status = String(body?.status ?? "");
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Expected a JSON body." }, { status: 400 });
  }
  // Checked here as well as in the RPC. The database refusal is the guarantee;
  // this one exists so a typo comes back as a sentence instead of a 500.
  if (status !== "resolved" && status !== "ignored") {
    return NextResponse.json(
      { error: "bad_status", message: "A unit can be marked resolved or ignored." },
      { status: 400 },
    );
  }

  const supabase = createServerClient();
  const { data, error } = await supabase.rpc("resolve_review_unit", {
    p_owner: session.userId,
    p_run_id: runId,
    p_unit_id: unitId,
    p_status: status,
  });

  if (error) {
    // Ownership and run-state refusals are not server faults - they are the
    // guard working. Reporting them as 500 would send the client into a retry
    // loop against a decision the database has already made.
    const msg = error.message || "Could not update this review item.";
    const denied = /does not own|not found|needs review|must be resolved or ignored|appears .* times/i.test(msg);
    console.error("[review] resolve_review_unit failed", { runId, unitId, status, msg });
    return NextResponse.json(
      { error: denied ? "review_refused" : "review_failed", message: msg },
      { status: denied ? 409 : 500 },
    );
  }

  // `changed: false` means someone already decided this one. It is a normal
  // outcome of two tabs, not an error, and the client re-reads either way.
  return NextResponse.json({ ok: true, ...(data as object) });
}
