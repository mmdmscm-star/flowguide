import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { applyItemContentUpdate } from "@/lib/item-content";

type Context = { params: Promise<{ id: string; itemId: string }> };

// PATCH /api/packets/:id/items/:itemId — edit item CONTENT from the block editor.
//
// Every mutation verifies, in order:
//   1. the authenticated user owns the packet;
//   2. the packet is draft;
//   3. the packet is in block mode;
//   4. the item belongs to THAT exact packet (item -> section -> packet_id = id).
//
// Content only (title/description/notes/address + details/links/photos/contact,
// via the shared helper). It never changes block order, inserts/deletes item
// blocks, moves the item to another packet/section, or alters headings.
export async function PATCH(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, itemId } = await context.params;
  const supabase = createServerClient();

  // 1. ownership + 2. draft + 3. block mode
  const { data: packet } = await supabase
    .from("packets")
    .select("id, status, composition_mode")
    .eq("id", id)
    .eq("user_id", session.userId)
    .single();
  if (!packet) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (packet.status !== "draft") {
    return NextResponse.json({ error: "Packet is not draft" }, { status: 400 });
  }
  if (packet.composition_mode !== "blocks") {
    return NextResponse.json({ error: "Packet is not in block mode" }, { status: 400 });
  }

  // 4. the item belongs to THIS packet
  const { data: item } = await supabase
    .from("items")
    .select("id, section_id")
    .eq("id", itemId)
    .single();
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  const { data: section } = await supabase
    .from("sections")
    .select("packet_id")
    .eq("id", item.section_id)
    .single();
  if (!section || section.packet_id !== id) {
    return NextResponse.json({ error: "Item does not belong to this packet" }, { status: 404 });
  }

  const body = await request.json();
  const { title, description, notes, address, links, details, photos, contact } = body;
  const { error } = await applyItemContentUpdate(supabase, itemId, {
    title, description, notes, address, links, details, photos, contact,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });

  return NextResponse.json({ ok: true });
}
