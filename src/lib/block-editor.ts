import { createServerClient } from "./supabase";
import { assembleItemsByIds } from "./queries";
import type { PacketBlock } from "./types";

// ============================================================
// Editor-side loader for a block-mode packet. Owner-scoped. Returns the routing
// decision for the canonical editor (legacy vs block) and, for block packets,
// the ordered block list with item content assembled live from the item tables
// (content is referenced, never duplicated). Shares the item assembler and the
// PacketBlock shape with the published renderer and the read-only preview.
// ============================================================

export type BlockEditorLoad =
  | { found: false }
  | { found: true; mode: "legacy" }
  | { found: true; mode: "blocks"; status: string; title: string; blocks: PacketBlock[] };

export async function getBlockEditorData(packetId: string, userId: string): Promise<BlockEditorLoad> {
  const supabase = createServerClient();

  const { data: packet, error } = await supabase
    .from("packets")
    .select("id, title, status, composition_mode")
    .eq("id", packetId)
    .eq("user_id", userId)
    .single();
  if (error || !packet) return { found: false };
  if (packet.composition_mode !== "blocks") return { found: true, mode: "legacy" };

  const { data: rows } = await supabase
    .from("packet_blocks")
    .select("id, position, block_type, item_id, heading_text, heading_subtext")
    .eq("packet_id", packetId)
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

  return { found: true, mode: "blocks", status: packet.status, title: packet.title, blocks };
}
