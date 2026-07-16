import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { applyItemContentUpdate } from "@/lib/item-content";

// Helper: verify item ownership through section -> packet -> user chain
async function verifyItemOwnership(
  supabase: ReturnType<typeof createServerClient>,
  itemId: string,
  userId: string
) {
  const { data: item } = await supabase
    .from("items")
    .select("id, section_id")
    .eq("id", itemId)
    .single();
  if (!item) return null;

  const { data: section } = await supabase
    .from("sections")
    .select("id, packet_id")
    .eq("id", item.section_id)
    .single();
  if (!section) return null;

  const { data: packet } = await supabase
    .from("packets")
    .select("id")
    .eq("id", section.packet_id)
    .eq("user_id", userId)
    .single();
  if (!packet) return null;

  return item;
}

// POST /api/items — create an item
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { sectionId, title, sortOrder } = body;

  const supabase = createServerClient();

  // Verify section ownership
  const { data: section } = await supabase
    .from("sections")
    .select("id, packet_id")
    .eq("id", sectionId)
    .single();
  if (!section) return NextResponse.json({ error: "Section not found" }, { status: 404 });

  const { data: packet } = await supabase
    .from("packets")
    .select("id")
    .eq("id", section.packet_id)
    .eq("user_id", session.userId)
    .single();
  if (!packet) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { data: item, error } = await supabase
    .from("items")
    .insert({
      section_id: sectionId,
      title: title || "",
      sort_order: sortOrder ?? 0,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ item }, { status: 201 });
}

// PATCH /api/items — update an item (including sub-fields)
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { id, title, description, notes, address, sortOrder, sectionId, links, details, contact, photos } = body;

  const supabase = createServerClient();
  const item = await verifyItemOwnership(supabase, id, session.userId);
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Section move / sort_order is legacy-only; item CONTENT is persisted through
  // the shared helper (same code path the block editor uses).
  const moveUpdates: Record<string, unknown> = {};
  if (sortOrder !== undefined) moveUpdates.sort_order = sortOrder;

  // Move item to a different section (must belong to the same packet/owner)
  if (sectionId !== undefined && sectionId !== item.section_id) {
    const { data: currentSection } = await supabase
      .from("sections")
      .select("packet_id")
      .eq("id", item.section_id)
      .single();
    const { data: targetSection } = await supabase
      .from("sections")
      .select("id, packet_id")
      .eq("id", sectionId)
      .single();
    if (!currentSection || !targetSection || currentSection.packet_id !== targetSection.packet_id) {
      return NextResponse.json({ error: "Invalid target section" }, { status: 403 });
    }

    // Append to the end of the target section
    const { data: siblings } = await supabase
      .from("items")
      .select("sort_order")
      .eq("section_id", sectionId)
      .order("sort_order", { ascending: false })
      .limit(1);
    const nextOrder = siblings && siblings.length > 0 ? siblings[0].sort_order + 1 : 0;

    moveUpdates.section_id = sectionId;
    moveUpdates.sort_order = nextOrder;
  }

  if (Object.keys(moveUpdates).length > 0) {
    const { error } = await supabase.from("items").update(moveUpdates).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { error: contentError } = await applyItemContentUpdate(supabase, id, {
    title, description, notes, address, links, details, photos, contact,
  });
  if (contentError) return NextResponse.json({ error: contentError }, { status: 500 });

  return NextResponse.json({ ok: true });
}

// DELETE /api/items — delete an item
export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { id } = body;

  const supabase = createServerClient();
  const item = await verifyItemOwnership(supabase, id, session.userId);
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { error } = await supabase.from("items").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
