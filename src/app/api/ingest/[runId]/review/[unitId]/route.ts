import { NextResponse } from "next/server";
import { dispositionsFor, namesOneItem, type ReviewDisposition, type ReviewFailure }
  from "@/lib/review-units";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

type Context = { params: Promise<{ runId: string; unitId: string }> };

// POST /api/ingest/:runId/review/:unitId
//   { status: "kept_private" | "resolved" | "ignored" | "included" }
//
// TWO dispositions DO something. `kept_private` writes the excerpt into that
// item's creator-only notes; `included` writes it as ordinary recipient-facing
// details, one label-less row per source line. Both take their text from the
// STORED unit inside the RPC, so the browser never sends content back — it says
// which decision was made and nothing else. The professional chose the
// destination; Sendset still cannot.
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
  const KNOWN: ReviewDisposition[] = ["resolved", "ignored", "kept_private", "included"];
  if (!KNOWN.includes(status as ReviewDisposition)) {
    return NextResponse.json(
      { error: "bad_status",
        message: "A unit can be added to the item, kept as a private note, marked handled, or left out." },
      { status: 400 },
    );
  }

  const supabase = createServerClient();

  // NOT EVERY KIND OFFERS EVERY DECISION, and the panel is not the guarantee.
  // A tab opened before a kind changed still renders whatever it rendered then,
  // and pressing a button it should no longer show would write real content.
  //
  // ASKED FROM THE REGISTRY, NOT FROM A LIST HERE. The earlier version tested
  // one disposition by name, so every future one arrived unguarded by default —
  // the wrong direction for a check whose whole job is to refuse. Now the
  // registry decides, and a disposition a kind does not offer is refused
  // whatever it is called.
  //
  // 0047 refuses the same things in the database, which is the guarantee. This
  // exists so the professional gets a sentence rather than a raw SQL message.
  //
  // Owner-scoped by the same query that reads the run, so this cannot be used to
  // probe another person's runs: an unreadable run yields no unit and the RPC's
  // own ownership check refuses whatever follows.
  {
    const { data: run } = await supabase
      .from("ingestion_runs")
      .select("review")
      .eq("id", runId)
      .eq("user_id", session.userId)
      .maybeSingle();
    const failures = ((run?.review as { failures?: ReviewFailure[] } | null)?.failures ?? []);
    const unit = failures.find((f) => f?.id === unitId);
    if (unit && !dispositionsFor(unit).includes(status as ReviewDisposition)) {
      return NextResponse.json(
        { error: "bad_status",
          message: status === "kept_private"
            ? "This one is not a private note — it holds information written for your client."
            : "That is not one of the answers this item offers." },
        { status: 400 },
      );
    }
    // A WRITING DISPOSITION NEEDS SOMEWHERE TO WRITE. The RPC refuses a unit
    // that names no item or more than one; saying so here turns a database
    // exception into a sentence, and the panel hides the button anyway.
    if (unit && (status === "included" || status === "kept_private") && !namesOneItem(unit)) {
      return NextResponse.json(
        { error: "bad_status",
          message: "Sendset can't tell which item this belongs to, so it can't add it for you." },
        { status: 400 },
      );
    }
  }

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
    const denied = /does not own|not found|needs review|must be resolved|appears .* times|no item titled|items titled|has no text|names no record|no packet/i.test(msg);
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
