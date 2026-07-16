import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

type Context = { params: Promise<{ id: string }> };

const HEADING_TYPES = ["heading", "subheading", "label"];

// POST /api/packets/:id/blocks — add a heading-like block at a position.
// Body: { position: number, blockType: "heading"|"subheading"|"label",
//         text: string, subtext?: string }. Item blocks are never created here.
// Returns { id } of the new block. The RPC enforces draft + block-mode, shifts
// positions, and preserves the consistency invariant.
export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const { position, blockType, text, subtext } = await request.json();

  if (typeof position !== "number" || position < 0) {
    return NextResponse.json({ error: "position required" }, { status: 400 });
  }
  if (!HEADING_TYPES.includes(blockType)) {
    return NextResponse.json({ error: "blockType must be heading, subheading, or label" }, { status: 400 });
  }
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }

  const supabase = createServerClient();

  const { data: packet } = await supabase
    .from("packets")
    .select("id")
    .eq("id", id)
    .eq("user_id", session.userId)
    .single();
  if (!packet) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data, error } = await supabase.rpc("add_heading_block", {
    p_packet_id: id,
    p_position: position,
    p_block_type: blockType,
    p_text: text,
    p_subtext: typeof subtext === "string" ? subtext : null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, id: data });
}
