import { createPublicClient, createServerClient } from "./supabase";
import type { Packet, PacketBlock, Section, Item, ItemDetail, ItemLink, ItemContact, ProfessionalContact } from "./types";

// ============================================================
// Resolve which identity a packet presents in the editor/preview,
// honoring the packet's identity_mode:
//   'default' -> the live account profile (current behavior)
//   'none'    -> no identity (empty; the footer/logo simply don't render)
//   'custom'  -> the packet-specific identity stored on the packet
// Published views do NOT use this — they read the frozen snapshot, into which
// publish has already baked the resolved identity.
// ============================================================
export function resolveProfessional(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  packet: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile: any
): ProfessionalContact {
  const mode = packet.identity_mode || "default";

  if (mode === "none") {
    return { name: "" };
  }

  if (mode === "custom") {
    const c = packet.custom_identity || {};
    return {
      name: c.name || "",
      email: c.email || undefined,
      phone: c.phone || undefined,
      businessName: c.businessName || undefined,
      logoUrl: c.logoUrl || undefined,
      headshotUrl: c.headshotUrl || undefined,
      footerLabel: c.footerLabel || undefined,
      websiteUrl: c.websiteUrl || undefined,
      links: Array.isArray(c.links) && c.links.length > 0 ? c.links : undefined,
    };
  }

  return {
    name: profile?.name || "",
    email: profile?.email || undefined,
    phone: profile?.phone || undefined,
    businessName: profile?.business_name || undefined,
    logoUrl: profile?.logo_url || undefined,
    headshotUrl: profile?.headshot_url || undefined,
    footerLabel: profile?.footer_label ?? "Your Advisor",
    websiteUrl: profile?.website_url || undefined,
    links: profile?.links || undefined,
  };
}

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

  // Use snapshotted profile when present, fall back to live profile for
  // packets published before the snapshot feature (snapshot is null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let profile: any = null;
  const snapshot = packet.professional_snapshot;
  if (snapshot && typeof snapshot === "object" && Object.keys(snapshot).length > 0) {
    profile = {
      name: snapshot.name || "",
      email: snapshot.email || "",
      phone: snapshot.phone || "",
      business_name: snapshot.businessName || "",
      logo_url: snapshot.logoUrl || "",
      headshot_url: snapshot.headshotUrl || "",
      footer_label: snapshot.footerLabel ?? "Your Advisor",
      website_url: snapshot.websiteUrl || "",
      links: snapshot.links || [],
    };
  } else if (snapshot === null) {
    // No snapshot — legacy packet, fall back to live profile
    const { data: liveProfile } = await supabase
      .from("professional_profiles")
      .select("*")
      .eq("user_id", packet.user_id)
      .single();
    profile = liveProfile;
  }
  // If snapshot is {} (empty object), packet was published without branding — profile stays null

  // Branch on composition mode. Block-mode packets present an ordered block body
  // (packet_blocks) instead of sections; legacy packets continue through the
  // exact section/item assembly below, unchanged. The packet shell and the
  // resolved professional identity (from the frozen snapshot) are shared by both.
  // (A block packet cannot actually be published yet — the draft-only DB trigger
  // blocks it — but the production read path understands one if it exists.)
  if (packet.composition_mode === "blocks") {
    return buildBlockPacket(supabase, packet, profile);
  }

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

// Map a snapshot/profile row (snake_case) to the ProfessionalContact shape the
// renderers consume. Shared by the legacy and block published paths so identity
// resolves identically regardless of composition mode.
function professionalFromProfileRow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile: any
): ProfessionalContact {
  return {
    name: profile?.name || "",
    email: profile?.email || undefined,
    phone: profile?.phone || undefined,
    businessName: profile?.business_name || undefined,
    logoUrl: profile?.logo_url || undefined,
    headshotUrl: profile?.headshot_url || undefined,
    footerLabel: profile?.footer_label ?? "Your Advisor",
    websiteUrl: profile?.website_url || undefined,
    links: profile?.links || undefined,
  };
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
    compositionMode: "legacy",
    sections,
    professional: professionalFromProfileRow(profile),
  };
}

// Build a published block-mode packet: read packet_blocks STRICTLY by position,
// assemble the referenced item content, and reuse the same packet shell and
// resolved professional identity as the legacy path. `sections` is empty; the
// ordered `blocks` body is what the renderer reads.
async function buildBlockPacket(
  supabase: ReturnType<typeof createServerClient>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  packet: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile: any
): Promise<Packet> {
  const { data: rows } = await supabase
    .from("packet_blocks")
    .select("id, position, block_type, item_id, heading_text, heading_subtext")
    .eq("packet_id", packet.id)
    .order("position");

  const blockRows = rows || [];
  const itemIds = blockRows
    .filter((r) => r.block_type === "item" && r.item_id)
    .map((r) => r.item_id as string);
  const itemsById = await assembleItemsByIds(supabase, itemIds);

  const blocks: PacketBlock[] = [];
  for (const r of blockRows) {
    if (r.block_type === "item") {
      const item = itemsById[r.item_id as string];
      // A missing item would be a DB-guarded inconsistency; skip defensively.
      if (item) blocks.push({ id: r.id, kind: "item", item });
    } else {
      blocks.push({
        id: r.id,
        kind: r.block_type as "heading" | "subheading" | "label",
        text: r.heading_text || "",
        subtext: r.heading_subtext || undefined,
      });
    }
  }

  return {
    slug: packet.slug,
    title: packet.title,
    clientName: packet.client_name || undefined,
    personalNote: packet.personal_note || undefined,
    mapUrl: packet.map_url || undefined,
    compositionMode: "blocks",
    sections: [],
    blocks,
    professional: professionalFromProfileRow(profile),
  };
}

// Assemble full Item content (photos/links/details/contact) for a set of item
// ids, matching the legacy published assembly exactly. Shared by the block
// published path and the persisted-block preview so item rendering never drifts.
export async function assembleItemsByIds(
  supabase: ReturnType<typeof createServerClient>,
  itemIds: string[]
): Promise<Record<string, Item>> {
  if (itemIds.length === 0) return {};
  const [itemsRes, photosRes, linksRes, detailsRes, contactsRes] = await Promise.all([
    supabase.from("items").select("*").in("id", itemIds),
    supabase.from("item_photos").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_links").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_details").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_contacts").select("*").in("item_id", itemIds),
  ]);
  const photos = photosRes.data || [];
  const links = linksRes.data || [];
  const details = detailsRes.data || [];
  const contacts = contactsRes.data || [];

  const map: Record<string, Item> = {};
  for (const it of itemsRes.data || []) {
    const itemPhotos = photos.filter((p) => p.item_id === it.id).map((p) => p.url);
    const itemLinks: ItemLink[] = links
      .filter((l) => l.item_id === it.id)
      .map((l) => ({ url: l.url, label: l.label || undefined }));
    const itemDetails: ItemDetail[] = details
      .filter((d) => d.item_id === it.id)
      .map((d) => ({ label: d.label, value: d.value }));
    const c = contacts.find((x) => x.item_id === it.id);
    map[it.id] = {
      id: it.id,
      title: it.title,
      address: it.address || undefined,
      description: it.description || undefined,
      notes: it.notes || undefined,
      photos: itemPhotos.length > 0 ? itemPhotos : undefined,
      links: itemLinks.length > 0 ? itemLinks : undefined,
      details: itemDetails.length > 0 ? itemDetails : undefined,
      contact: c
        ? { name: c.name || undefined, phone: c.phone || undefined, email: c.email || undefined, website: c.website || undefined }
        : undefined,
    };
  }
  return map;
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
): Promise<(Packet & { id: string; status: string }) | null> {
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
    professional: resolveProfessional(packet, profile),
  };
}
