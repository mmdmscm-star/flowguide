import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { generateSlug } from "@/lib/slug";
import { insertLibraryEntries } from "@/lib/library-insert";

// POST /api/packets/from-library — start a new FlowGuide from saved material.
//
// { libraryItemIds: string[], title?, clientName? } -> { packetId }
//
// ATOMIC FROM THE PROFESSIONAL'S POINT OF VIEW. Creating the FlowGuide, its
// first section and the copied items is three writes, and there is no single RPC
// for it. What matters is the outcome a failure leaves behind: if any step
// fails, the draft is REMOVED, so a half-built FlowGuide never appears in My
// Packets for someone to find and wonder about. A brand-new empty draft is safe
// to delete precisely because nothing else can have touched it yet.
//
// Nothing here publishes, and nothing stays connected: each item is an
// independent copy from the moment it lands.
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

  let slug = generateSlug();
  for (let i = 0; i < 5; i++) {
    const { data: taken } = await supabase.from("packets").select("id").eq("slug", slug).maybeSingle();
    if (!taken) break;
    slug = generateSlug();
  }

  const { data: packet, error: packetErr } = await supabase.from("packets").insert({
    user_id: session.userId, slug,
    title: typeof title === "string" ? title : "",
    client_name: typeof clientName === "string" ? clientName : "",
    // Legacy composition: the Library inserts into sections and items, which
    // block mode freezes. Choosing it here is not a default to drift — it is the
    // only mode this operation can produce.
    composition_mode: "legacy",
  }).select("id").single();
  if (packetErr || !packet) {
    return NextResponse.json({ error: "create_failed", message: packetErr?.message }, { status: 400 });
  }
  const packetId = (packet as { id: string }).id;

  /** Undo the whole thing. See the note above: a draft that was never finished
   *  must not survive as something the professional has to clean up. */
  async function abandon(status: number, payload: Record<string, unknown>) {
    await supabase.from("packets").delete().eq("id", packetId);
    return NextResponse.json(payload, { status });
  }

  const { data: section, error: sectionErr } = await supabase.from("sections").insert({
    packet_id: packetId, title: "", sort_order: 0,
  }).select("id").single();
  if (sectionErr || !section) {
    return abandon(400, { error: "create_failed", message: sectionErr?.message });
  }

  const { itemIds, error: insertErr } = await insertLibraryEntries(
    supabase, session.userId, packetId, (section as { id: string }).id, libraryItemIds);

  if (insertErr) return abandon(400, { error: "insert_failed", message: insertErr });
  if (itemIds.length === 0) {
    return abandon(400, {
      error: "nothing_inserted",
      message: "Those Library entries could not be found. They may have been deleted.",
    });
  }

  return NextResponse.json(
    { packetId, itemIds, count: itemIds.length, sectionId: (section as { id: string }).id },
    { status: 201 });
}
