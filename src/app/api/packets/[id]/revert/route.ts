import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

type Context = { params: Promise<{ id: string }> };

// POST /api/packets/:id/revert — block draft -> legacy mode.
// Ownership is authorized here; revert_packet_to_legacy (service_role) locks the
// packet and enforces draft + block mode, so a published/legacy/non-owned packet
// is rejected. Item content remains; block-only headings and block ordering are
// discarded. On failure the packet is left unchanged.
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

  const { error } = await supabase.rpc("revert_packet_to_legacy", { p_packet_id: id });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
