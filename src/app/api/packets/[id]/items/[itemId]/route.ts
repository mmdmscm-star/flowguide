import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

type Context = { params: Promise<{ id: string; itemId: string }> };

// PATCH /api/packets/:id/items/:itemId — atomic item-content save from the block
// editor. All verification AND the whole content replacement happen inside ONE
// SECURITY DEFINER RPC (a single transaction), so a failure during any child
// write rolls back everything and the item's content is preserved exactly.
//
// The RPC verifies, under a packet-row lock: the server-passed owner id matches
// packets.user_id; the packet is draft; the packet is in block mode; and the
// item belongs to THAT exact packet. It updates only core content fields and
// replaces details/links/photos/contact — never section_id, item/block order,
// or block membership.
export async function PATCH(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, itemId } = await context.params;
  const body = await request.json();
  const { title, description, notes, address, links, details, photos, contact } = body;

  const supabase = createServerClient();
  const { error } = await supabase.rpc("update_block_item_content", {
    p_packet_id: id,
    p_item_id: itemId,
    p_owner_id: session.userId,
    p_title: typeof title === "string" ? title : "",
    p_description: typeof description === "string" ? description : "",
    p_notes: typeof notes === "string" ? notes : "",
    p_address: typeof address === "string" ? address : "",
    p_details: Array.isArray(details) ? details : [],
    p_links: Array.isArray(links) ? links : [],
    p_photos: Array.isArray(photos) ? photos : [],
    p_contact: contact ?? null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
