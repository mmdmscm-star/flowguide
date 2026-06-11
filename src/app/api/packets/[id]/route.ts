import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

type Context = { params: Promise<{ id: string }> };

// GET /api/packets/:id — get full packet data for editor
export async function GET(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const supabase = createServerClient();

  const { data: packet, error } = await supabase
    .from("packets")
    .select("*")
    .eq("id", id)
    .eq("user_id", session.userId)
    .single();

  if (error || !packet) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Fetch professional profile
  const { data: profile } = await supabase
    .from("professional_profiles")
    .select("*")
    .eq("user_id", session.userId)
    .single();

  // Fetch sections
  const { data: sections } = await supabase
    .from("sections")
    .select("*")
    .eq("packet_id", id)
    .order("sort_order");

  const sectionIds = (sections || []).map((s) => s.id);

  // Fetch items
  const { data: items } = sectionIds.length > 0
    ? await supabase.from("items").select("*").in("section_id", sectionIds).order("sort_order")
    : { data: [] };

  const itemIds = (items || []).map((i) => i.id);

  // Fetch sub-fields
  const [photosRes, linksRes, detailsRes, contactsRes] = itemIds.length > 0
    ? await Promise.all([
        supabase.from("item_photos").select("*").in("item_id", itemIds).order("sort_order"),
        supabase.from("item_links").select("*").in("item_id", itemIds).order("sort_order"),
        supabase.from("item_details").select("*").in("item_id", itemIds).order("sort_order"),
        supabase.from("item_contacts").select("*").in("item_id", itemIds),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];

  return NextResponse.json({
    packet,
    profile: profile || null,
    sections: sections || [],
    items: items || [],
    photos: photosRes.data || [],
    links: linksRes.data || [],
    details: detailsRes.data || [],
    contacts: contactsRes.data || [],
  });
}

// PATCH /api/packets/:id — update packet fields
export async function PATCH(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const body = await request.json();
  const supabase = createServerClient();

  // Only allow updating specific fields
  const allowed: Record<string, string> = {
    title: "title",
    clientName: "client_name",
    personalNote: "personal_note",
    mapUrl: "map_url",
  };

  const updates: Record<string, string> = {};
  for (const [key, col] of Object.entries(allowed)) {
    if (key in body) updates[col] = body[key];
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  const { error } = await supabase
    .from("packets")
    .update(updates)
    .eq("id", id)
    .eq("user_id", session.userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

// DELETE /api/packets/:id — delete a packet
export async function DELETE(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const supabase = createServerClient();

  const { error } = await supabase
    .from("packets")
    .delete()
    .eq("id", id)
    .eq("user_id", session.userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
