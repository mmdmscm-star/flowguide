import type { createServerClient } from "./supabase";

// ============================================================
// Shared item-CONTENT persistence (title/description/notes/address plus the
// details/links/photos/contact child tables). Extracted verbatim from the legacy
// /api/items PATCH so the legacy editor and the block editor persist item content
// through ONE code path. This helper touches ONLY content — never section_id,
// sort_order, packet membership, or any composition/ordering. Callers are
// responsible for authorization.
// ============================================================

export interface ItemContentPayload {
  title?: string;
  description?: string;
  notes?: string;
  address?: string;
  links?: { url: string; label?: string }[];
  details?: { label: string; value: string }[];
  photos?: { url: string }[];
  contact?: { name?: string; phone?: string; email?: string; website?: string } | null;
}

export async function applyItemContentUpdate(
  supabase: ReturnType<typeof createServerClient>,
  itemId: string,
  payload: ItemContentPayload
): Promise<{ error?: string }> {
  const { title, description, notes, address, links, details, photos, contact } = payload;

  // Core item fields (content only).
  const updates: Record<string, unknown> = {};
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (notes !== undefined) updates.notes = notes;
  if (address !== undefined) updates.address = address;
  if (Object.keys(updates).length > 0) {
    const { error } = await supabase.from("items").update(updates).eq("id", itemId);
    if (error) return { error: error.message };
  }

  // Replace links if provided.
  if (links !== undefined) {
    await supabase.from("item_links").delete().eq("item_id", itemId);
    if (links.length > 0) {
      const linkRows = links.map((l, i) => ({ item_id: itemId, url: l.url, label: l.label || "", sort_order: i }));
      await supabase.from("item_links").insert(linkRows);
    }
  }

  // Replace details if provided.
  if (details !== undefined) {
    await supabase.from("item_details").delete().eq("item_id", itemId);
    if (details.length > 0) {
      const detailRows = details.map((d, i) => ({ item_id: itemId, label: d.label, value: d.value, sort_order: i }));
      await supabase.from("item_details").insert(detailRows);
    }
  }

  // Replace photos if provided (only http(s) URLs are stored, mirroring legacy).
  if (photos !== undefined) {
    await supabase.from("item_photos").delete().eq("item_id", itemId);
    if (photos.length > 0) {
      const photoRows = photos
        .filter((p) => p.url && p.url.startsWith("http"))
        .map((p, i) => ({ item_id: itemId, url: p.url, sort_order: i }));
      if (photoRows.length > 0) {
        await supabase.from("item_photos").insert(photoRows);
      }
    }
  }

  // Replace contact if provided.
  if (contact !== undefined) {
    await supabase.from("item_contacts").delete().eq("item_id", itemId);
    if (contact && (contact.name || contact.phone || contact.email || contact.website)) {
      await supabase.from("item_contacts").insert({
        item_id: itemId,
        name: contact.name || "",
        phone: contact.phone || "",
        email: contact.email || "",
        website: contact.website || "",
      });
    }
  }

  return {};
}
