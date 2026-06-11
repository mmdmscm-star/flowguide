import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

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
  const { id, title, description, notes, address, sortOrder, links, details, contact, photos } = body;

  const supabase = createServerClient();
  const item = await verifyItemOwnership(supabase, id, session.userId);
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Update item fields
  const updates: Record<string, unknown> = {};
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (notes !== undefined) updates.notes = notes;
  if (address !== undefined) updates.address = address;
  if (sortOrder !== undefined) updates.sort_order = sortOrder;

  if (Object.keys(updates).length > 0) {
    const { error } = await supabase.from("items").update(updates).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Replace links if provided
  if (links !== undefined) {
    await supabase.from("item_links").delete().eq("item_id", id);
    if (links.length > 0) {
      const linkRows = links.map((l: { url: string; label?: string }, i: number) => ({
        item_id: id,
        url: l.url,
        label: l.label || "",
        sort_order: i,
      }));
      await supabase.from("item_links").insert(linkRows);
    }
  }

  // Replace details if provided
  if (details !== undefined) {
    await supabase.from("item_details").delete().eq("item_id", id);
    if (details.length > 0) {
      const detailRows = details.map((d: { label: string; value: string }, i: number) => ({
        item_id: id,
        label: d.label,
        value: d.value,
        sort_order: i,
      }));
      await supabase.from("item_details").insert(detailRows);
    }
  }

  // Replace photos if provided
  if (photos !== undefined) {
    await supabase.from("item_photos").delete().eq("item_id", id);
    if (photos.length > 0) {
      const photoRows = photos
        .filter((p: { url: string }) => p.url && p.url.startsWith("http"))
        .map((p: { url: string }, i: number) => ({
          item_id: id,
          url: p.url,
          sort_order: i,
        }));
      if (photoRows.length > 0) {
        await supabase.from("item_photos").insert(photoRows);
      }
    }
  }

  // Replace contact if provided
  if (contact !== undefined) {
    await supabase.from("item_contacts").delete().eq("item_id", id);
    if (contact && (contact.name || contact.phone || contact.email || contact.website)) {
      await supabase.from("item_contacts").insert({
        item_id: id,
        name: contact.name || "",
        phone: contact.phone || "",
        email: contact.email || "",
        website: contact.website || "",
      });
    }
  }

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
