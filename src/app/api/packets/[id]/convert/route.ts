import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

type Context = { params: Promise<{ id: string }> };

// POST /api/packets/:id/convert — legacy draft -> block mode.
// Ownership is authorized here; convert_packet_to_blocks (service_role) locks the
// packet and enforces draft + legacy, so a published/block/non-owned packet is
// rejected. Item content is preserved; sections become heading blocks. On failure
// the packet is left unchanged.
export async function POST(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const supabase = createServerClient();

  const { data: packet } = await supabase
    .from("packets")
    .select("id")
    .eq("id", id)
    .eq("user_id", session.userId)
    .single();
  if (!packet) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { error } = await supabase.rpc("convert_packet_to_blocks", { p_packet_id: id });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
