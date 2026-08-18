import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { loadPacketOwnership } from "@/lib/ownership-service";
import { availableActions } from "@/lib/ownership-recompute";

type Context = { params: Promise<{ id: string }> };

// The resolution surface for media-ownership findings.
//
// GET  /api/packets/:id/ownership — what is unresolved right now
// POST /api/packets/:id/ownership — Move, Keep, or undo a Keep
//
// BOTH RETURN THE SAME RECOMPUTED SHAPE, and POST returns it AFTER the write.
// That is the design's central claim made operational: a finding is never
// stored, so a resolution is never "applied" to it. Move changes the rows and
// the finding stops being true; Keep records intent and the next recompute
// declines to report it. The client re-renders from a fresh derivation every
// time and can never hold a stale finding, because it never holds one at all.
//
// The three RPCs are revoked from anon and authenticated (0016), so this route
// is the only way to reach them. Each one re-verifies ownership, draft status
// and packet membership under a row lock — this layer's checks are the friendly
// error, not the security boundary.

/** The packet must be the caller's before any of its contents are described. */
async function ownedPacket(supabase: ReturnType<typeof createServerClient>, id: string, userId: string) {
  const { data } = await supabase
    .from("packets").select("id, status").eq("id", id).eq("user_id", userId).maybeSingle();
  return data as { id: string; status: string } | null;
}

/** One recompute, shaped for the panel. Actions are attached here rather than in
 *  the client so that what may be offered stays a property of the finding. */
async function currentState(supabase: ReturnType<typeof createServerClient>, id: string) {
  const o = await loadPacketOwnership(id, supabase);
  if (o.declines.length > 0) {
    console.warn("[ownership] not verifiable", { packetId: id, declines: o.declines });
  }
  return {
    findings: o.findings.map((f) => ({ ...f, actions: availableActions(f) })),
    blockingCount: o.blocking.length,
    // A panel that cannot tell "clean" from "never checked" would tell the
    // professional their packet is fine when nothing looked at it.
    checked: o.checkedAnyRun,
    overridesReadable: o.overridesReadable,
  };
}

export async function GET(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const supabase = createServerClient();
  if (!(await ownedPacket(supabase, id, session.userId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(await currentState(supabase, id));
}

export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const supabase = createServerClient();

  const packet = await ownedPacket(supabase, id, session.userId);
  if (!packet) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (packet.status !== "draft") {
    return NextResponse.json(
      { error: "not_draft", message: "Unpublish this packet before changing where its photos sit." },
      { status: 409 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const { action, itemId, url, toItemId } = body as {
    action?: string; itemId?: string; url?: string; toItemId?: string;
  };
  if (!itemId || !url) {
    return NextResponse.json({ error: "bad_request", message: "An item and a photo are required." }, { status: 400 });
  }

  // A Move is only ever offered against a destination the SOURCE resolved. Taking
  // the client's word for it would let a stray request file a photo anywhere in
  // the packet under the banner of fixing ownership, so the destination is
  // re-derived and compared rather than trusted.
  if (action === "move") {
    if (!toItemId) {
      return NextResponse.json({ error: "bad_request", message: "A destination is required." }, { status: 400 });
    }
    const { findings } = await currentState(supabase, id);
    const proposed = findings.find(
      (f) => f.itemId === itemId && f.url === url && f.actions.includes("move"),
    );
    if (!proposed) {
      // Almost always benign: someone else's tab already resolved it, or the
      // photo moved. Re-deriving is the answer to a stale screen.
      return NextResponse.json(
        { error: "stale_finding", message: "That photo has already been dealt with.", ...(await currentState(supabase, id)) },
        { status: 409 },
      );
    }
    if (proposed.proposedItemId !== toItemId) {
      return NextResponse.json(
        { error: "destination_mismatch", message: "That is not where the source puts this photo." },
        { status: 409 },
      );
    }
    const { error } = await supabase.rpc("move_item_photos", {
      p_owner: session.userId, p_from_item: itemId, p_to_item: toItemId, p_url: url, p_packet_id: id,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(await currentState(supabase, id));
  }

  // Keep asserts "I know the source puts this elsewhere, and I want it here
  // anyway" — a real override of a KNOWN truth. It is refused for anything the
  // source never settled, which would quietly convert "we don't know" into "the
  // professional decided".
  if (action === "keep") {
    const { findings } = await currentState(supabase, id);
    const target = findings.find(
      (f) => f.itemId === itemId && f.url === url && f.actions.includes("keep"),
    );
    if (!target) {
      return NextResponse.json(
        { error: "stale_finding", message: "That photo has already been dealt with.", ...(await currentState(supabase, id)) },
        { status: 409 },
      );
    }
    const { error } = await supabase.rpc("set_item_media_decision", {
      p_owner: session.userId, p_item_id: itemId, p_url: url,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(await currentState(supabase, id));
  }

  // The undo. Deliberately NOT gated on a current finding: the whole point is
  // that the finding is invisible while the Keep stands, so requiring one would
  // make every Keep permanent. A resolution the professional cannot reverse is
  // a trap.
  if (action === "unkeep") {
    const { error } = await supabase.rpc("clear_item_media_decision", {
      p_owner: session.userId, p_item_id: itemId, p_url: url,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(await currentState(supabase, id));
  }

  return NextResponse.json({ error: "bad_request", message: "Unknown action." }, { status: 400 });
}
