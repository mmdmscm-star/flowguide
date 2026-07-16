import type { createServerClient } from "./supabase";

// ============================================================
// Shared item-CONTENT persistence — the SINGLE implementation for BOTH editors.
//
// title/description/notes/address plus the details/links/photos/contacts child
// tables are written by ONE atomic RPC (update_item_content, migration 0011),
// so a save is all-or-nothing: any failure (e.g. a malformed contacts array)
// rolls back the entire request and leaves the item + its contacts exactly as
// they were. This replaces the previous multi-call helper, which issued
// independent PostgREST writes (items.update; then delete+insert per child) that
// could partially apply — most dangerously wiping a contact list when the
// contacts delete committed but its insert failed.
//
// PRESENCE-AWARE: an omitted field is passed as null and left UNCHANGED by the
// RPC, so the legacy editor's per-field autosaves touch only what they send
// while the block editor's full save replaces everything — one code path, both
// atomic. This helper performs NO authorization itself; the RPC verifies owner /
// draft / mode / item-belongs-to-packet under a packet-row lock.
// ============================================================

export interface ItemContentPayload {
  title?: string;
  description?: string;
  notes?: string;
  address?: string;
  links?: { url: string; label?: string }[];
  details?: { label: string; value: string }[];
  photos?: { url: string }[];
  contacts?: { name?: string; role?: string; phone?: string; email?: string; website?: string }[];
}

export interface ItemContentContext {
  itemId: string;
  ownerId: string;
  // Optional packet cross-check (block route passes the URL packet id). When
  // null the RPC derives the packet from the item and skips the cross-check.
  packetId?: string | null;
  // Optional composition-mode guard: "blocks" for the block editor, "legacy"
  // for the legacy editor. null skips the mode check.
  requireMode?: "legacy" | "blocks" | null;
}

export async function applyItemContentUpdate(
  supabase: ReturnType<typeof createServerClient>,
  ctx: ItemContentContext,
  payload: ItemContentPayload
): Promise<{ error?: string }> {
  const { error } = await supabase.rpc("update_item_content", {
    p_item_id: ctx.itemId,
    p_owner_id: ctx.ownerId,
    p_packet_id: ctx.packetId ?? null,
    p_require_mode: ctx.requireMode ?? null,
    // Core fields: undefined -> null -> leave unchanged. "" is a real value.
    p_title: payload.title ?? null,
    p_description: payload.description ?? null,
    p_notes: payload.notes ?? null,
    p_address: payload.address ?? null,
    // Children: undefined -> null -> untouched; an array (even []) REPLACES.
    p_details: payload.details ?? null,
    p_links: payload.links ?? null,
    p_photos: payload.photos ?? null,
    p_contacts: payload.contacts ?? null,
  });
  if (error) return { error: error.message };
  return {};
}
