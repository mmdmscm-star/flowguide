import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { applyItemContentUpdate, normalizeItemContent } from "@/lib/item-content";

type Context = { params: Promise<{ id: string; itemId: string }> };

// PATCH /api/packets/:id/items/:itemId — atomic item-content save from the block
// editor. Verification AND the whole content replacement happen inside ONE
// SECURITY DEFINER RPC (update_item_content — the single writer shared with the
// legacy editor), a single transaction, so a failure during any child write
// rolls back everything and the item's content is preserved exactly.
//
// The RPC verifies, under a packet-row lock: the server-passed owner id matches
// packets.user_id; the packet is draft; the packet is in block mode
// (requireMode); and the item belongs to THAT exact packet (packetId
// cross-check). It updates only core content fields and replaces
// details/links/photos/contacts — never section_id, item/block order, or block
// membership. The block editor always sends the full set, so passing explicit
// arrays here performs a full replace.
export async function PATCH(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, itemId } = await context.params;
  const body = await request.json();

  // FULL REPLACE, unchanged: the block editor always sends the whole set, and an
  // omitted field here has always meant "clear it". The defaults below state
  // that intent explicitly; normalizeItemContent supplies the COERCION, shared
  // with every other item writer including the Library, so the rules for what
  // counts as a valid string or collection cannot drift between them.
  const supabase = createServerClient();
  const { error } = await applyItemContentUpdate(
    supabase,
    { itemId, ownerId: session.userId, packetId: id, requireMode: "blocks" },
    {
      title: "", description: "", notes: "", address: "",
      details: [], links: [], photos: [], contacts: [],
      ...normalizeItemContent(body),
    }
  );
  if (error) return NextResponse.json({ error }, { status: 400 });

  return NextResponse.json({ ok: true });
}
