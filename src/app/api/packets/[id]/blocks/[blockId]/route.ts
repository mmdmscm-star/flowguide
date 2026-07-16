import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

type Context = { params: Promise<{ id: string; blockId: string }> };

// Verify the URL packet is owned by the caller. Ownership of the URL packet is
// authorized here; the RPCs additionally BIND the block to that packet id under
// the packet lock (p_block_id must have packet_id = p_packet_id), so combining
// one packet's id with another packet's block id is rejected at the DB.
async function ownsPacket(
  supabase: ReturnType<typeof createServerClient>,
  packetId: string,
  userId: string
): Promise<boolean> {
  const { data: packet } = await supabase
    .from("packets")
    .select("id")
    .eq("id", packetId)
    .eq("user_id", userId)
    .single();
  return !!packet;
}

// PATCH /api/packets/:id/blocks/:blockId — edit a heading-like block's text and
// optional subtext. Body: { text: string, subtext?: string }.
export async function PATCH(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, blockId } = await context.params;
  const { text, subtext } = await request.json();
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }

  const supabase = createServerClient();
  if (!(await ownsPacket(supabase, id, session.userId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { error } = await supabase.rpc("update_heading_block", {
    p_packet_id: id,
    p_block_id: blockId,
    p_text: text,
    p_subtext: typeof subtext === "string" ? subtext : null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}

// DELETE /api/packets/:id/blocks/:blockId — delete a heading-like block only.
// Item blocks are rejected by the RPC; no item content is touched. The block is
// bound to the URL packet id inside the RPC.
export async function DELETE(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, blockId } = await context.params;
  const supabase = createServerClient();
  if (!(await ownsPacket(supabase, id, session.userId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { error } = await supabase.rpc("delete_heading_block", {
    p_packet_id: id,
    p_block_id: blockId,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
