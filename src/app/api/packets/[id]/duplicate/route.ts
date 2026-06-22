import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { generateSlug } from "@/lib/slug";

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const supabase = createServerClient();

  // Fetch original packet
  const { data: original } = await supabase
    .from("packets")
    .select("*")
    .eq("id", id)
    .eq("user_id", session.userId)
    .single();

  if (!original) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Create duplicate packet
  const { data: newPacket, error: packetErr } = await supabase
    .from("packets")
    .insert({
      user_id: session.userId,
      slug: generateSlug(),
      title: original.title ? `${original.title} (Copy)` : "",
      client_name: original.client_name || "",
      personal_note: original.personal_note || "",
      packet_type: original.packet_type || "general",
      map_url: original.map_url || "",
      raw_input: "",
      status: "draft",
      viewed: false,
    })
    .select()
    .single();

  if (packetErr || !newPacket) {
    return NextResponse.json({ error: "Failed to create duplicate." }, { status: 500 });
  }

  // Fetch all sections
  const { data: sections } = await supabase
    .from("sections")
    .select("*")
    .eq("packet_id", id)
    .order("sort_order");

  if (sections && sections.length > 0) {
    for (const section of sections) {
      const { data: newSection } = await supabase
        .from("sections")
        .insert({
          packet_id: newPacket.id,
          title: section.title,
          description: section.description || "",
          sort_order: section.sort_order,
        })
        .select()
        .single();

      if (!newSection) continue;

      // Fetch items for this section
      const { data: items } = await supabase
        .from("items")
        .select("*")
        .eq("section_id", section.id)
        .order("sort_order");

      if (!items || items.length === 0) continue;

      for (const item of items) {
        const { data: newItem } = await supabase
          .from("items")
          .insert({
            section_id: newSection.id,
            title: item.title,
            address: item.address || "",
            description: item.description || "",
            notes: item.notes || "",
            sort_order: item.sort_order,
          })
          .select()
          .single();

        if (!newItem) continue;

        // Copy details
        const { data: details } = await supabase
          .from("item_details")
          .select("*")
          .eq("item_id", item.id)
          .order("sort_order");

        if (details && details.length > 0) {
          await supabase.from("item_details").insert(
            details.map((d) => ({
              item_id: newItem.id,
              label: d.label,
              value: d.value,
              sort_order: d.sort_order,
            }))
          );
        }

        // Copy links
        const { data: links } = await supabase
          .from("item_links")
          .select("*")
          .eq("item_id", item.id)
          .order("sort_order");

        if (links && links.length > 0) {
          await supabase.from("item_links").insert(
            links.map((l) => ({
              item_id: newItem.id,
              url: l.url,
              label: l.label || "",
              sort_order: l.sort_order,
            }))
          );
        }

        // Copy photos
        const { data: photos } = await supabase
          .from("item_photos")
          .select("*")
          .eq("item_id", item.id)
          .order("sort_order");

        if (photos && photos.length > 0) {
          await supabase.from("item_photos").insert(
            photos.map((p) => ({
              item_id: newItem.id,
              url: p.url,
              storage_path: p.storage_path || "",
              sort_order: p.sort_order,
            }))
          );
        }

        // Copy contact
        const { data: contact } = await supabase
          .from("item_contacts")
          .select("*")
          .eq("item_id", item.id)
          .single();

        if (contact) {
          await supabase.from("item_contacts").insert({
            item_id: newItem.id,
            name: contact.name || "",
            phone: contact.phone || "",
            email: contact.email || "",
            website: contact.website || "",
          });
        }
      }
    }
  }

  return NextResponse.json({ packet: { id: newPacket.id } });
}
