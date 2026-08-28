// Library data access. Owner-scoped, service-role, no RLS reliance.
//
// `library_items` has RLS enabled with NO policy, so the table is reachable only
// through the service role — which means ownership is THIS layer's job and is
// never inferred. Every query carries an explicit `user_id` predicate, and every
// route passes the session's id rather than anything from a request body.
//
// The two cross-table operations do NOT live here. `library_update_from_item`
// and `library_save_as_new_from_item` are SECURITY DEFINER functions (0017)
// because each writes both a library row and a packet item's lineage, and
// supabase-js exposes no multi-statement transaction. Splitting them would let a
// failure between the writes leave a descendant recording a revision that is no
// longer current — reporting the professional's own change as somebody else's.

import { createServerClient } from "./supabase.ts";
import type { ItemContentPayload } from "./item-content.ts";
import { REVISION_CONFLICT, type LibraryAncestry } from "./library.ts";

import { cursorFilter, cursorFrom, vocabularyOf, type LibraryCursor } from "./library-organization";

type Db = ReturnType<typeof createServerClient>;

export interface LibraryItem extends ItemContentPayload {
  id: string;
  revision: number;
  updatedAt: string;
  /** Library ORGANIZATION. Never copied into a FlowGuide, never shown to a
   *  recipient — how a professional files their own shelf is not information
   *  about the thing on it. */
  category: string;
  labels: string[];
  isFavorite: boolean;
}

const COLUMNS = "id, title, address, description, notes, details, links, photos, contacts, revision, updated_at, category, labels, is_favorite";

/** Rows carry snake_case; the payload shape is shared with the packet writers. */
function toLibraryItem(row: Record<string, unknown>): LibraryItem {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    updatedAt: String(row.updated_at),
    category: String(row.category ?? ""),
    labels: Array.isArray(row.labels) ? (row.labels as unknown[]).map(String) : [],
    isFavorite: row.is_favorite === true,
    title: String(row.title ?? ""),
    address: String(row.address ?? ""),
    description: String(row.description ?? ""),
    notes: String(row.notes ?? ""),
    details: (row.details ?? []) as ItemContentPayload["details"],
    links: (row.links ?? []) as ItemContentPayload["links"],
    photos: (row.photos ?? []) as ItemContentPayload["photos"],
    contacts: (row.contacts ?? []) as ItemContentPayload["contacts"],
  };
}

/** Search, or list most-recently-updated when the query is empty. */
export interface LibraryQuery {
  q?: string;
  category?: string;
  /** AND semantics: an item must carry every label asked for. */
  labels?: string[];
  favorite?: boolean;
  cursor?: LibraryCursor | null;
  limit?: number;
}

export interface LibraryPage {
  items: LibraryItem[];
  hasMore: boolean;
  nextCursor: LibraryCursor | null;
  error?: string;
}

/**
 * One page of the Library, filtered and keyset-paginated.
 *
 * `hasMore` is EXPLICIT rather than inferred from a short page. A caller that
 * guesses "fewer than I asked for means the end" is right until a filter
 * changes the page shape, and then it silently hides the rest of someone's
 * Library — which is the defect this replaces, in a new costume. One extra row
 * is fetched and discarded so the answer is observed, not assumed.
 */
export async function searchLibrary(
  db: Db, userId: string, query: LibraryQuery = {},
): Promise<LibraryPage> {
  const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
  let q = db.from("library_items").select(COLUMNS).eq("user_id", userId);

  // websearch_to_tsquery tolerates whatever a professional actually types —
  // quotes, stray operators — instead of erroring on it.
  const text = String(query.q ?? "").trim();
  if (text) q = q.textSearch("search_tsv", text, { type: "websearch" });

  const category = String(query.category ?? "").trim();
  if (category) q = q.eq("category", category);

  const labels = (query.labels ?? []).map((l) => String(l).trim()).filter(Boolean);
  if (labels.length) q = q.contains("labels", labels);

  if (query.favorite) q = q.eq("is_favorite", true);

  if (query.cursor) q = q.or(cursorFilter(query.cursor));

  const { data, error } = await q
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (error) return { items: [], hasMore: false, nextCursor: null, error: error.message };

  const rows = (data ?? []) as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).map((r) => toLibraryItem(r));
  const last = page[page.length - 1];
  return { items: page, hasMore, nextCursor: hasMore && last ? cursorFrom(last) : null };
}

/**
 * Set a Library item's ORGANIZATION, and nothing else.
 *
 * Deliberately not part of updateLibraryItem. That bumps `revision`, which is
 * the save-back comparator: a descendant records the revision it was copied
 * from, and a mismatch means "the base moved on". Filing 65 items into
 * categories would otherwise tell the professional that 65 FlowGuides had
 * diverged — because they tidied their shelf.
 *
 * `updated_at` is left alone for the same reason in miniature: it is the
 * Library's ordering, and organizing must not reshuffle the list.
 */
export async function setLibraryOrganization(
  db: Db, userId: string, id: string,
  patch: { category?: string; labels?: string[]; isFavorite?: boolean },
): Promise<{ item?: LibraryItem; error?: string }> {
  const update: Record<string, unknown> = {};
  if (patch.category !== undefined) update.category = patch.category;
  if (patch.labels !== undefined) update.labels = patch.labels;
  if (patch.isFavorite !== undefined) update.is_favorite = patch.isFavorite;
  if (!Object.keys(update).length) return { error: "nothing_to_change" };

  const { data, error } = await db.from("library_items")
    .update(update)                       // no revision, no updated_at, on purpose
    .eq("id", id).eq("user_id", userId)
    .select(COLUMNS).maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "not_found" };
  return { item: toLibraryItem(data as Record<string, unknown>) };
}

/** The professional's own vocabulary, for filter chips and spelling reuse. */
export async function libraryVocabulary(
  db: Db, userId: string,
): Promise<{ categories: string[]; labels: string[] }> {
  const { data } = await db.from("library_items").select("category, labels").eq("user_id", userId);
  return vocabularyOf((data ?? []) as Array<{ category?: unknown; labels?: unknown }>);
}

export async function getLibraryItem(
  db: Db, userId: string, id: string,
): Promise<LibraryItem | null> {
  const { data } = await db.from("library_items")
    .select(COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  return data ? toLibraryItem(data as Record<string, unknown>) : null;
}

/** The payload of a packet item, in the shared shape, for diffing and saving. */
export async function readItemAsPayload(
  db: Db, userId: string, itemId: string,
): Promise<{ payload: ItemContentPayload; ancestry: LibraryAncestry } | null> {
  // Ownership resolved through the packet, because items carry no user_id.
  const { data: item } = await db.from("items")
    .select("id, title, address, description, notes, library_item_id, library_item_revision, sections!inner(packet_id, packets!inner(user_id))")
    .eq("id", itemId).maybeSingle();
  if (!item) return null;

  const owner = (item as unknown as { sections: { packets: { user_id: string } } })
    .sections?.packets?.user_id;
  if (owner !== userId) return null;

  const [details, links, photos, contacts] = await Promise.all([
    db.from("item_details").select("label, value").eq("item_id", itemId).order("sort_order"),
    db.from("item_links").select("url, label").eq("item_id", itemId).order("sort_order"),
    db.from("item_photos").select("url").eq("item_id", itemId).order("sort_order"),
    db.from("item_contacts").select("name, role, phone, email, website").eq("item_id", itemId).order("sort_order"),
  ]);

  const r = item as Record<string, unknown>;
  const libraryItemId = (r.library_item_id as string | null) ?? null;
  const copiedFromRevision = r.library_item_revision === null || r.library_item_revision === undefined
    ? null : Number(r.library_item_revision);

  let currentRevision: number | null = null;
  if (libraryItemId) {
    const ancestor = await getLibraryItem(db, userId, libraryItemId);
    currentRevision = ancestor ? ancestor.revision : null;
  }

  return {
    payload: {
      title: String(r.title ?? ""), address: String(r.address ?? ""),
      description: String(r.description ?? ""), notes: String(r.notes ?? ""),
      details: (details.data ?? []) as ItemContentPayload["details"],
      links: (links.data ?? []) as ItemContentPayload["links"],
      photos: (photos.data ?? []) as ItemContentPayload["photos"],
      contacts: (contacts.data ?? []) as ItemContentPayload["contacts"],
    },
    ancestry: { libraryItemId, copiedFromRevision, currentRevision },
  };
}

export async function createLibraryItem(
  db: Db, userId: string, payload: ItemContentPayload, sourceItemId?: string,
): Promise<{ item?: LibraryItem; error?: string }> {
  const { data, error } = await db.from("library_items").insert({
    user_id: userId,
    title: payload.title ?? "", address: payload.address ?? "",
    description: payload.description ?? "", notes: payload.notes ?? "",
    details: payload.details ?? [], links: payload.links ?? [],
    photos: payload.photos ?? [], contacts: payload.contacts ?? [],
    ...(sourceItemId ? { source_packet_item_id: sourceItemId } : {}),
  }).select(COLUMNS).single();
  if (error) return { error: error.message };
  return { item: toLibraryItem(data as Record<string, unknown>) };
}

/**
 * Direct edit, with optimistic concurrency.
 *
 * A single row, so this needs no function to be atomic — but it DOES need the
 * revision predicate. Without it, two tabs editing the same entry silently
 * overwrite each other, which is the same class of loss the save-back safeguard
 * exists to prevent, just reached from a different direction.
 */
export async function updateLibraryItem(
  db: Db, userId: string, id: string, payload: ItemContentPayload, expectedRevision: number,
): Promise<{ item?: LibraryItem; conflict?: LibraryItem; error?: string }> {
  const { data, error } = await db.from("library_items").update({
    title: payload.title ?? "", address: payload.address ?? "",
    description: payload.description ?? "", notes: payload.notes ?? "",
    details: payload.details ?? [], links: payload.links ?? [],
    photos: payload.photos ?? [], contacts: payload.contacts ?? [],
    revision: expectedRevision + 1,
    updated_at: new Date().toISOString(),
  })
    .eq("id", id).eq("user_id", userId)
    .eq("revision", expectedRevision)   // the whole point
    .select(COLUMNS).maybeSingle();

  if (error) return { error: error.message };
  if (!data) {
    // No row matched: either the revision moved or the entry is not the
    // caller's. Re-read to tell those apart — a conflict is recoverable and a
    // missing entry is not, and reporting one as the other would send the
    // professional looking for the wrong problem.
    const current = await getLibraryItem(db, userId, id);
    if (!current) return { error: "not_found" };
    return { conflict: current };
  }
  return { item: toLibraryItem(data as Record<string, unknown>) };
}

export async function deleteLibraryItem(db: Db, userId: string, id: string): Promise<{ error?: string }> {
  // The BEFORE DELETE trigger (0017) clears BOTH lineage columns on every
  // descendant, so no packet is touched and no half-lineage is left behind.
  const { error } = await db.from("library_items").delete().eq("id", id).eq("user_id", userId);
  return error ? { error: error.message } : {};
}

/** How many packet items descend from this entry. Read-only, for the UI. */
export async function countDescendants(db: Db, id: string): Promise<number> {
  const { count } = await db.from("items")
    .select("id", { count: "exact", head: true }).eq("library_item_id", id);
  return count ?? 0;
}

/**
 * Update Library version — atomic, via the 0017 function.
 * Returns null when the reviewed revision is stale; the caller recomputes.
 */
export async function updateLibraryFromItem(
  db: Db, userId: string, libraryItemId: string, itemId: string, expectedRevision: number,
): Promise<{ revision?: number; conflict?: true; error?: string }> {
  const { data, error } = await db.rpc("library_update_from_item", {
    p_owner: userId, p_library_item_id: libraryItemId,
    p_item_id: itemId, p_expected_revision: expectedRevision,
  });
  if (error) return { error: error.message };
  if (Number(data) === REVISION_CONFLICT) return { conflict: true };
  return { revision: Number(data) };
}

/** Save as new — atomic, via the 0017 function. Repoints the descendant. */
export async function saveAsNewFromItem(
  db: Db, userId: string, itemId: string,
): Promise<{ libraryItemId?: string; error?: string }> {
  const { data, error } = await db.rpc("library_save_as_new_from_item", {
    p_owner: userId, p_item_id: itemId,
  });
  if (error) return { error: error.message };
  return { libraryItemId: String(data) };
}
