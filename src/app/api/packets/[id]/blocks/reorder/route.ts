import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

type Context = { params: Promise<{ id: string }> };

// POST /api/packets/:id/blocks/reorder — persist the complete ordered block list.
// Body: { blockIds: string[] } — the full set of the packet's block ids in the
// new order. Ownership is checked here; the RPC enforces draft + block-mode,
// locks the packet, and preserves dense positions + the consistency invariant.
export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const { blockIds } = await request.json();
  if (!Array.isArray(blockIds) || blockIds.length === 0) {
    return NextResponse.json({ error: "blockIds required" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Ownership check — the RPC runs as service_role, so authorize here.
  const { data: packet } = await supabase
    .from("packets")
    .select("id")
    .eq("id", id)
    .eq("user_id", session.userId)
    .single();
  if (!packet) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { error } = await supabase.rpc("reorder_packet_blocks", {
    p_packet_id: id,
    p_block_ids: blockIds,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
