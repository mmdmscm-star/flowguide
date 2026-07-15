import { createServerClient } from "./supabase";
import { resolveProfessional } from "./queries";
import type { Item, ProfessionalContact } from "./types";

// ============================================================
// R1B-A read-only block-preview reader (isolated; does NOT touch the production
// packet queries). Reads packet_blocks for a block-mode packet OWNED by the
// caller and assembles the referenced item content live from the item tables —
// content is never duplicated into blocks.
// ============================================================

export type PreviewBlock =
  | { id: string; position: number; kind: "heading" | "subheading" | "label"; text: string; subtext?: string }
  | { id: string; position: number; kind: "item"; item: Item };

export type BlockPreview =
  | { status: "not_found" }
  | { status: "legacy" }
  | {
      status: "blocks";
      title: string;
      clientName?: string;
      professional: ProfessionalContact;
      blocks: PreviewBlock[];
    };

export async function getPacketBlockPreview(packetId: string, userId: string): Promise<BlockPreview> {
  const supabase = createServerClient();

  // Ownership: only a packet owned by the signed-in professional. Also pull the
  // packet-level identity selections so the preview can render the same header
  // (branding/logo) and footer (advisor signature) the recipient view resolves.
  const { data: packet, error } = await supabase
    .from("packets")
    .select("id, title, client_name, composition_mode, identity_mode, custom_identity")
    .eq("id", packetId)
    .eq("user_id", userId)
    .single();
  if (error || !packet) return { status: "not_found" };
  if (packet.composition_mode !== "blocks") return { status: "legacy" };

  // Resolve the packet-level professional identity exactly as the editor/preview
  // does — honoring identity_mode (default -> live profile, custom -> packet
  // identity, none -> empty). Blocks own only the ordered body, never identity.
  const { data: profile } = await supabase
    .from("professional_profiles")
    .select("*")
    .eq("user_id", userId)
    .single();
  const professional = resolveProfessional(packet, profile);
  const clientName = packet.client_name || undefined;

  // Blocks strictly by position.
  const { data: rows } = await supabase
    .from("packet_blocks")
    .select("id, position, block_type, item_id, heading_text, heading_subtext")
    .eq("packet_id", packetId)
    .order("position");
  if (!rows || rows.length === 0)
    return { status: "blocks", title: packet.title, clientName, professional, blocks: [] };

  const itemIds = rows.filter((r) => r.block_type === "item" && r.item_id).map((r) => r.item_id as string);
  const itemsById = await assembleItems(supabase, itemIds);

  const blocks: PreviewBlock[] = [];
  for (const r of rows) {
    if (r.block_type === "item") {
      const item = itemsById[r.item_id as string];
      if (item) blocks.push({ id: r.id, position: r.position, kind: "item", item });
      // (a missing item would be an inconsistency the DB guards against; skip defensively)
    } else {
      blocks.push({
        id: r.id,
        position: r.position,
        kind: r.block_type as "heading" | "subheading" | "label",
        text: r.heading_text || "",
        subtext: r.heading_subtext || undefined,
      });
    }
  }
  return { status: "blocks", title: packet.title, clientName, professional, blocks };
}

// Live-assemble item content for the referenced item ids (no duplication into blocks).
async function assembleItems(
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
    const itemLinks = links.filter((l) => l.item_id === it.id).map((l) => ({ url: l.url, label: l.label || undefined }));
    const itemDetails = details.filter((d) => d.item_id === it.id).map((d) => ({ label: d.label, value: d.value }));
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
