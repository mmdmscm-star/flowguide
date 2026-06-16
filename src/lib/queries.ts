import { createPublicClient, createServerClient } from "./supabase";
import type { Packet, Section, Item, ItemDetail, ItemLink, ItemContact } from "./types";

// ============================================================
// SERVER: Fetch a published packet by slug (recipient view)
// Uses server client to bypass RLS for profile reads while
// still filtering to published packets only.
// ============================================================
export async function getPublishedPacket(slug: string): Promise<Packet | null> {
  const supabase = createServerClient();

  // Fetch the packet
  const { data: packet, error: packetError } = await supabase
    .from("packets")
    .select("*")
    .eq("slug", slug)
    .eq("status", "published")
    .single();

  if (packetError || !packet) return null;

  // Fetch professional profile
  const { data: profile } = await supabase
    .from("professional_profiles")
    .select("*")
    .eq("user_id", packet.user_id)
    .single();

  // Fetch sections ordered by sort_order
  const { data: sections } = await supabase
    .from("sections")
    .select("*")
    .eq("packet_id", packet.id)
    .order("sort_order");

  if (!sections || sections.length === 0) {
    return buildPacket(packet, profile, []);
  }

  // Fetch all items for all sections
  const sectionIds = sections.map((s) => s.id);
  const { data: items } = await supabase
    .from("items")
    .select("*")
    .in("section_id", sectionIds)
    .order("sort_order");

  if (!items || items.length === 0) {
    return buildPacket(
      packet,
      profile,
      sections.map((s) => ({ ...s, items: [] }))
    );
  }

  // Fetch all sub-fields for all items
  const itemIds = items.map((i) => i.id);
  const [photosRes, linksRes, detailsRes, contactsRes] = await Promise.all([
    supabase.from("item_photos").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_links").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_details").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_contacts").select("*").in("item_id", itemIds),
  ]);

  const photos = photosRes.data || [];
  const links = linksRes.data || [];
  const details = detailsRes.data || [];
  const contacts = contactsRes.data || [];

  // Assemble items with their sub-fields
  const assembledItems = items.map((item) => {
    const itemPhotos = photos.filter((p) => p.item_id === item.id).map((p) => p.url);
    const itemLinks: ItemLink[] = links
      .filter((l) => l.item_id === item.id)
      .map((l) => ({ url: l.url, label: l.label || undefined }));
    const itemDetails: ItemDetail[] = details
      .filter((d) => d.item_id === item.id)
      .map((d) => ({ label: d.label, value: d.value }));
    const itemContact = contacts.find((c) => c.item_id === item.id);

    const assembled: Item = {
      id: item.id,
      title: item.title,
      address: item.address || undefined,
      description: item.description || undefined,
      notes: item.notes || undefined,
      photos: itemPhotos.length > 0 ? itemPhotos : undefined,
      links: itemLinks.length > 0 ? itemLinks : undefined,
      details: itemDetails.length > 0 ? itemDetails : undefined,
      contact: itemContact
        ? {
            name: itemContact.name || undefined,
            phone: itemContact.phone || undefined,
            email: itemContact.email || undefined,
            website: itemContact.website || undefined,
          }
        : undefined,
    };
    return assembled;
  });

  // Assemble sections with their items
  const assembledSections: Section[] = sections.map((section) => ({
    id: section.id,
    title: section.title,
    description: section.description || undefined,
    items: assembledItems.filter((item) =>
      items.find((i) => i.id === item.id && i.section_id === section.id)
    ),
  }));

  return buildPacket(packet, profile, assembledSections);
}

function buildPacket(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  packet: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile: any,
  sections: Section[]
): Packet {
  return {
    slug: packet.slug,
    title: packet.title,
    clientName: packet.client_name || undefined,
    personalNote: packet.personal_note || undefined,
    mapUrl: packet.map_url || undefined,
    sections,
    professional: {
      name: profile?.name || "",
      email: profile?.email || undefined,
      phone: profile?.phone || undefined,
      businessName: profile?.business_name || undefined,
      logoUrl: profile?.logo_url || undefined,
    },
  };
}

// ============================================================
// SERVER: Mark a packet as viewed
// ============================================================
export async function markPacketViewed(slug: string): Promise<void> {
  const supabase = createServerClient();
  await supabase
    .from("packets")
    .update({ viewed: true })
    .eq("slug", slug)
    .eq("status", "published")
    .eq("viewed", false);
}

// ============================================================
// SERVER: Fetch a packet by ID for the editor (any status)
// ============================================================
export async function getPacketForEditor(
  packetId: string,
  userId: string
): Promise<Packet | null> {
  const supabase = createServerClient();

  const { data: packet, error } = await supabase
    .from("packets")
    .select("*")
    .eq("id", packetId)
    .eq("user_id", userId)
    .single();

  if (error || !packet) return null;

  // Reuse the same assembly logic but with server client
  const { data: profile } = await supabase
    .from("professional_profiles")
    .select("*")
    .eq("user_id", userId)
    .single();

  const { data: sections } = await supabase
    .from("sections")
    .select("*")
    .eq("packet_id", packet.id)
    .order("sort_order");

  if (!sections || sections.length === 0) {
    return buildPacketWithId(packet, profile, []);
  }

  const sectionIds = sections.map((s) => s.id);
  const { data: items } = await supabase
    .from("items")
    .select("*")
    .in("section_id", sectionIds)
    .order("sort_order");

  if (!items || items.length === 0) {
    return buildPacketWithId(
      packet,
      profile,
      sections.map((s) => ({ id: s.id, title: s.title, description: s.description, items: [] }))
    );
  }

  const itemIds = items.map((i) => i.id);
  const [photosRes, linksRes, detailsRes, contactsRes] = await Promise.all([
    supabase.from("item_photos").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_links").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_details").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_contacts").select("*").in("item_id", itemIds),
  ]);

  const photos = photosRes.data || [];
  const links = linksRes.data || [];
  const details = detailsRes.data || [];
  const contacts = contactsRes.data || [];

  const assembledItems = items.map((item) => ({
    id: item.id,
    title: item.title,
    address: item.address || undefined,
    description: item.description || undefined,
    notes: item.notes || undefined,
    photos: photos.filter((p) => p.item_id === item.id).map((p) => p.url),
    links: links.filter((l) => l.item_id === item.id).map((l) => ({ url: l.url, label: l.label || undefined })),
    details: details.filter((d) => d.item_id === item.id).map((d) => ({ label: d.label, value: d.value })),
    contact: (() => {
      const c = contacts.find((c) => c.item_id === item.id);
      return c ? { name: c.name || undefined, phone: c.phone || undefined, email: c.email || undefined, website: c.website || undefined } : undefined;
    })(),
  }));

  const assembledSections = sections.map((section) => ({
    id: section.id,
    title: section.title,
    description: section.description || undefined,
    items: assembledItems.filter((item) =>
      items.find((i) => i.id === item.id && i.section_id === section.id)
    ),
  }));

  return buildPacketWithId(packet, profile, assembledSections);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildPacketWithId(packet: any, profile: any, sections: Section[]): Packet & { id: string; status: string } {
  return {
    id: packet.id,
    slug: packet.slug,
    title: packet.title,
    clientName: packet.client_name || undefined,
    personalNote: packet.personal_note || undefined,
    mapUrl: packet.map_url || undefined,
    status: packet.status,
    sections,
    professional: {
      name: profile?.name || "",
      email: profile?.email || undefined,
      phone: profile?.phone || undefined,
      businessName: profile?.business_name || undefined,
      logoUrl: profile?.logo_url || undefined,
    },
  };
}
