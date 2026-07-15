import { createServerClient } from "./supabase";
import { resolveProfessional, assembleItemsByIds } from "./queries";
import type { PacketBlock, ProfessionalContact } from "./types";

// ============================================================
// R1B read-only block-preview reader (owner-scoped; isolated from the published
// packet path). Reads packet_blocks for a block-mode packet OWNED by the caller
// and assembles the referenced item content live from the item tables — content
// is never duplicated into blocks. It shares the canonical PacketBlock shape and
// item assembler with the production renderer so preview and production match.
// ============================================================

export type BlockPreview =
  | { status: "not_found" }
  | { status: "legacy" }
  | {
      status: "blocks";
      title: string;
      clientName?: string;
      professional: ProfessionalContact;
      blocks: PacketBlock[];
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
  const itemsById = await assembleItemsByIds(supabase, itemIds);

  const blocks: PacketBlock[] = [];
  for (const r of rows) {
    if (r.block_type === "item") {
      const item = itemsById[r.item_id as string];
      if (item) blocks.push({ id: r.id, kind: "item", item });
      // (a missing item would be an inconsistency the DB guards against; skip defensively)
    } else {
      blocks.push({
        id: r.id,
        kind: r.block_type as "heading" | "subheading" | "label",
        text: r.heading_text || "",
        subtext: r.heading_subtext || undefined,
      });
    }
  }
  return { status: "blocks", title: packet.title, clientName, professional, blocks };
}
