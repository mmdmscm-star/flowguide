import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

// POST /api/reorder — reorder sections or items within ONE packet.
//
//   { type: "sections" | "items", packetId, orderedIds }
//
// A SESSION IS NOT AN AUTHORIZATION. This route used to check that somebody was
// logged in and then write `sort_order` filtered by `.eq("id", id)` alone, on
// the service-role client — which bypasses RLS. Any signed-in person who knew a
// row id could therefore reorder anyone's packet, and the ids are not secret:
// the published page renders each item's uuid as a quick-nav anchor
// (`id="item-<uuid>"`), so reading a public FlowGuide hands over everything
// needed to rewrite its order.
//
// The pattern here is the one `placeItems` already uses in the Library:
// ownership is established from the SESSION before anything is written, and
// every write then repeats the predicate rather than trusting that check to
// still hold. Two cheap reads buy a guarantee that does not depend on the order
// statements happen to execute in.
//
// ORDER ONLY, and unchanged from before: this writes `sort_order` and nothing
// else. It cannot reach a title, a description, or any content.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { type, packetId, orderedIds } = body as {
    type?: unknown; packetId?: unknown; orderedIds?: unknown;
  };

  // NAMED, NOT DEFAULTED. `type` used to fall through to "items" for any value
  // that was not "sections", so a typo — or a probe — silently wrote to the
  // wrong table.
  if (type !== "sections" && type !== "items") {
    return NextResponse.json(
      { error: "bad_request", message: "Reorder sections or items." }, { status: 400 });
  }
  if (typeof packetId !== "string" || !packetId) {
    return NextResponse.json(
      { error: "bad_request", message: "Which FlowGuide is being reordered?" }, { status: 400 });
  }
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return NextResponse.json({ error: "bad_request", message: "orderedIds required" }, { status: 400 });
  }
  const ids = orderedIds.map((x) => String(x ?? "")).filter(Boolean);
  // A repeated id has two positions in one list; there is no order to save.
  if (ids.length !== orderedIds.length || new Set(ids).size !== ids.length) {
    return NextResponse.json(
      { error: "bad_request", message: "The order contains a repeated or empty id." }, { status: 400 });
  }

  const supabase = createServerClient();

  // ---- 1. the packet is the caller's -------------------------------------
  const { data: packet } = await supabase
    .from("packets").select("id").eq("id", packetId).eq("user_id", session.userId).maybeSingle();
  // Not "forbidden": a packet the caller does not own is, to them, not a packet.
  if (!packet) {
    return NextResponse.json(
      { error: "not_found", message: "That FlowGuide could not be found." }, { status: 404 });
  }

  // ---- 2. every id named is in that packet, and 3. every write says so ----
  //
  // The read is what makes the refusal total: a request mixing one of the
  // caller's own ids with a stranger's is rejected entirely rather than being
  // partially applied to whichever rows happened to match.
  let writes: { error: unknown }[];
  if (type === "sections") {
    const { data: owned } = await supabase
      .from("sections").select("id").eq("packet_id", packetId).in("id", ids);
    if ((owned ?? []).length !== ids.length) {
      return NextResponse.json(
        { error: "not_found", message: "Those sections are not in this FlowGuide." }, { status: 404 });
    }
    writes = await Promise.all(ids.map((id, index) =>
      supabase.from("sections").update({ sort_order: index })
        .eq("id", id).eq("packet_id", packetId)));
  } else {
    const { data: secs } = await supabase.from("sections").select("id").eq("packet_id", packetId);
    const sectionIds = ((secs ?? []) as Array<{ id: string }>).map((s) => String(s.id));
    if (!sectionIds.length) {
      return NextResponse.json(
        { error: "not_found", message: "Those items are not in this FlowGuide." }, { status: 404 });
    }
    const { data: owned } = await supabase
      .from("items").select("id").in("section_id", sectionIds).in("id", ids);
    if ((owned ?? []).length !== ids.length) {
      return NextResponse.json(
        { error: "not_found", message: "Those items are not in this FlowGuide." }, { status: 404 });
    }
    writes = await Promise.all(ids.map((id, index) =>
      supabase.from("items").update({ sort_order: index })
        .eq("id", id).in("section_id", sectionIds)));
  }

  // The previous version discarded these entirely, so a failed write reported
  // success and the editor showed "saved" over an order the database never took.
  if (writes.some((w) => w.error)) {
    return NextResponse.json(
      { error: "write_failed", message: "Could not save that order." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
