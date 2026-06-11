import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

// POST /api/sections — create a section
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { packetId, title, sortOrder } = body;

  const supabase = createServerClient();

  // Verify packet belongs to user
  const { data: packet } = await supabase
    .from("packets")
    .select("id")
    .eq("id", packetId)
    .eq("user_id", session.userId)
    .single();

  if (!packet) return NextResponse.json({ error: "Packet not found" }, { status: 404 });

  const { data: section, error } = await supabase
    .from("sections")
    .insert({
      packet_id: packetId,
      title: title || "",
      sort_order: sortOrder ?? 0,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ section }, { status: 201 });
}

// PATCH /api/sections — update a section
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { id, title, description, sortOrder } = body;

  const supabase = createServerClient();

  // Verify ownership via packet
  const { data: section } = await supabase
    .from("sections")
    .select("id, packet_id")
    .eq("id", id)
    .single();

  if (!section) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: packet } = await supabase
    .from("packets")
    .select("id")
    .eq("id", section.packet_id)
    .eq("user_id", session.userId)
    .single();

  if (!packet) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const updates: Record<string, unknown> = {};
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (sortOrder !== undefined) updates.sort_order = sortOrder;

  const { error } = await supabase.from("sections").update(updates).eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

// DELETE /api/sections — delete a section
export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { id } = body;

  const supabase = createServerClient();

  // Verify ownership
  const { data: section } = await supabase
    .from("sections")
    .select("id, packet_id")
    .eq("id", id)
    .single();

  if (!section) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: packet } = await supabase
    .from("packets")
    .select("id")
    .eq("id", section.packet_id)
    .eq("user_id", session.userId)
    .single();

  if (!packet) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { error } = await supabase.from("sections").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
