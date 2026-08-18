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

/**
 * Coerce an untrusted body into an ItemContentPayload.
 *
 * Extracted so the Library writes through the SAME coercion as the packet
 * routes. Sharing the persistence function would be wrong — that exists to make
 * a multi-table write atomic, which a single-row Library record does not need —
 * but sharing the SHAPE and its coercion is what stops the two drifting.
 *
 * Presence-aware, matching the RPC: an absent key stays absent (leave
 * unchanged), while a present-but-malformed collection becomes [] (replace with
 * nothing) rather than being silently dropped.
 */
export function normalizeItemContent(body: Record<string, unknown>): ItemContentPayload {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const rows = <T>(v: unknown): T[] | undefined =>
    v === undefined ? undefined : (Array.isArray(v) ? (v as T[]) : []);

  const out: ItemContentPayload = {};
  const title = str(body.title);             if (title !== undefined) out.title = title;
  const description = str(body.description); if (description !== undefined) out.description = description;
  const notes = str(body.notes);             if (notes !== undefined) out.notes = notes;
  const address = str(body.address);         if (address !== undefined) out.address = address;

  const details = rows<{ label: string; value: string }>(body.details);
  if (details !== undefined) out.details = details;
  const links = rows<{ url: string; label?: string }>(body.links);
  if (links !== undefined) out.links = links;
  const photos = rows<{ url: string }>(body.photos);
  if (photos !== undefined) out.photos = photos;
  const contacts = rows<ItemContentPayload["contacts"] extends (infer U)[] | undefined ? U : never>(body.contacts);
  if (contacts !== undefined) out.contacts = contacts;

  return out;
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
