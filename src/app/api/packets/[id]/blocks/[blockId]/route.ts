import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

type Context = { params: Promise<{ id: string; blockId: string }> };

// Verify the packet is owned by the caller AND the block belongs to that packet.
// The RPCs run as service_role, so ownership is authorized here.
async function authorize(
  supabase: ReturnType<typeof createServerClient>,
  packetId: string,
  blockId: string,
  userId: string
): Promise<boolean> {
  const { data: packet } = await supabase
    .from("packets")
    .select("id")
    .eq("id", packetId)
    .eq("user_id", userId)
    .single();
  if (!packet) return false;
  const { data: block } = await supabase
    .from("packet_blocks")
    .select("id")
    .eq("id", blockId)
    .eq("packet_id", packetId)
    .single();
  return !!block;
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
  if (!(await authorize(supabase, id, blockId, session.userId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { error } = await supabase.rpc("update_heading_block", {
    p_block_id: blockId,
    p_text: text,
    p_subtext: typeof subtext === "string" ? subtext : null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}

// DELETE /api/packets/:id/blocks/:blockId — delete a heading-like block only.
// Item blocks are rejected by the RPC; no item content is touched.
export async function DELETE(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, blockId } = await context.params;
  const supabase = createServerClient();
  if (!(await authorize(supabase, id, blockId, session.userId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { error } = await supabase.rpc("delete_heading_block", { p_block_id: blockId });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
