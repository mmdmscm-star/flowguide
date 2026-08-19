import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { generateSlug } from "@/lib/slug";

export const maxDuration = 30;

// POST /api/packets/from-library — start a new FlowGuide from saved material.
//
// { libraryItemIds: string[], title?, clientName? } -> { packetId }
//
// ONE TRANSACTION, not three writes and a cleanup. create_packet_from_library
// (0023) creates the FlowGuide, its first section and every copy inside a single
// plpgsql body, so any failure — including one raised by update_item_content deep
// inside the loop — rolls all of it back together.
//
// The previous implementation deleted the draft it had just made when a later
// step failed. That is compensating cleanup, not atomicity: if the process,
// connection or instance died in between, the cleanup never ran and an orphan
// draft survived. Proven by fault injection on the third of four copies, which
// now leaves zero packet, zero section and zero items.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { libraryItemIds, title, clientName } = body as
    { libraryItemIds?: string[]; title?: string; clientName?: string };

  if (!Array.isArray(libraryItemIds) || libraryItemIds.length === 0) {
    return NextResponse.json(
      { error: "bad_request", message: "Choose something from your Library first." }, { status: 400 });
  }

  const supabase = createServerClient();

  // Slug collisions are retried here exactly as the ordinary blank create
  // retries them. Each attempt is a whole transaction that either happened or
  // did not, so a losing attempt leaves nothing behind to tidy up.
  let lastError = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await supabase.rpc("create_packet_from_library", {
      p_owner: session.userId,
      p_slug: generateSlug(),
      p_title: typeof title === "string" ? title : "",
      p_client_name: typeof clientName === "string" ? clientName : "",
      p_library_item_ids: libraryItemIds,
    });

    if (!error) {
      const res = data as { packet_id: string; section_id: string; item_ids: string[]; count: number };
      return NextResponse.json(
        { packetId: res.packet_id, sectionId: res.section_id, itemIds: res.item_ids, count: res.count },
        { status: 201 });
    }

    lastError = error.message;
    if (/slug .* is taken/i.test(error.message)) continue;

    // ALL OR NOTHING on the input side: a missing or foreign entry aborts the
    // whole creation rather than quietly producing a partial subset. Someone who
    // picked four things gets four or an error, never three without explanation.
    if (/missing or not yours/i.test(error.message)) {
      return NextResponse.json({
        error: "entries_unavailable",
        message: "Some of those Library items are no longer available. Refresh and try again.",
      }, { status: 409 });
    }
    return NextResponse.json({ error: "create_failed", message: error.message }, { status: 400 });
  }

  return NextResponse.json(
    { error: "create_failed", message: lastError || "Could not create it. Try again." }, { status: 400 });
}
