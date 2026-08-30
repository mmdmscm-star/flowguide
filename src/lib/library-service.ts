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

import { cursorFilter, cursorFrom, vocabularyOf, containerCursorFilter, containerCursorFrom,
  type LibraryCursor, type ContainerCursor, type LibraryVocabulary } from "./library-organization";
import { appendOrders, cleanName, findByName, shadowCategory, swapForMove,
  type GroupRow, type Placement, type SectionRow } from "./library-structure";

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
  /** The item's ONE structural home. null/null is the unorganized remainder,
   *  which is a valid permanent place to live. */
  sectionId: string | null;
  groupId: string | null;
  /** Position within that container. Meaningful only when placed; the
   *  unorganized remainder is newest-first and is not hand-ordered. */
  sortOrder: number;
}

const COLUMNS = "id, title, address, description, notes, details, links, photos, contacts, revision, updated_at, category, labels, is_favorite, section_id, group_id, sort_order";

/** Rows carry snake_case; the payload shape is shared with the packet writers. */
function toLibraryItem(row: Record<string, unknown>): LibraryItem {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    updatedAt: String(row.updated_at),
    category: String(row.category ?? ""),
    labels: Array.isArray(row.labels) ? (row.labels as unknown[]).map(String) : [],
    isFavorite: row.is_favorite === true,
    sectionId: (row.section_id as string | null) ?? null,
    groupId: (row.group_id as string | null) ?? null,
    sortOrder: Number(row.sort_order ?? 0),
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
  /** ONE CONTAINER, in its stored hand-order. `sectionId: null` with
   *  `container: true` means the unorganized remainder, which keeps
   *  newest-first ordering because it is not hand-ordered. */
  container?: Placement | null;
  containerCursor?: ContainerCursor | null;
}

export interface LibraryPage {
  items: LibraryItem[];
  hasMore: boolean;
  nextCursor: LibraryCursor | null;
  /** Set instead of nextCursor when the page came from a hand-ordered
   *  container, because that page is ordered by position and not by time. */
  nextContainerCursor?: ContainerCursor | null;
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

  // ONE CONTAINER, when asked for. A section or group is ordered by hand, so it
  // pages on (sort_order, id); the unorganized remainder is not hand-ordered
  // and keeps (updated_at, id). Both are total orders — the tiebreak is the
  // primary key either way.
  const c = query.container;
  const handOrdered = !!c && c.sectionId !== null;
  if (c) {
    if (c.sectionId === null) q = q.is("section_id", null);
    else q = q.eq("section_id", c.sectionId);
    if (c.groupId === null) q = q.is("group_id", null);
    else q = q.eq("group_id", c.groupId);
  }

  if (handOrdered && query.containerCursor) q = q.or(containerCursorFilter(query.containerCursor));
  else if (query.cursor) q = q.or(cursorFilter(query.cursor));

  q = handOrdered
    ? q.order("sort_order", { ascending: true }).order("id", { ascending: true })
    : q.order("updated_at", { ascending: false }).order("id", { ascending: false });

  const { data, error } = await q.limit(limit + 1);

  if (error) return { items: [], hasMore: false, nextCursor: null, error: error.message };

  const rows = (data ?? []) as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).map((r) => toLibraryItem(r));
  const last = page[page.length - 1];
  if (handOrdered) {
    return { items: page, hasMore, nextCursor: null,
      nextContainerCursor: hasMore && last ? containerCursorFrom(last) : null };
  }
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

export interface BulkOrganizePatch {
  addLabels?: string[];
  removeLabels?: string[];
  favorite?: boolean;
}

/**
 * Organize MANY items at once — the reason organization is usable at all.
 *
 * A Library that already holds sixty-five things cannot be organized one dialog
 * at a time; that is not a feature with friction, it is a feature nobody will
 * ever finish. So the same three columns are written across a selection.
 *
 * Owner-scoped on every statement, and it writes NOTHING ELSE. No revision, no
 * updated_at — see setLibraryOrganization for why the first would report every
 * descendant FlowGuide as diverged and the second would reshuffle the list.
 *
 * Labels need each row's current value to add to or remove from, so rows are
 * read first. Rows whose result is identical are then written together, which
 * keeps a 65-item categorise to a handful of statements rather than 65.
 */
export async function bulkOrganize(
  db: Db, userId: string, ids: string[], patch: BulkOrganizePatch,
): Promise<{ updated: number; error?: string }> {
  const targets = [...new Set(ids.map(String))].filter(Boolean);
  if (!targets.length) return { updated: 0, error: "nothing_selected" };

  // Ownership is confirmed HERE, from the session's id, before anything is
  // written — and the write repeats the predicate rather than trusting this.
  const { data: owned, error: readErr } = await db.from("library_items")
    .select("id, labels").eq("user_id", userId).in("id", targets);
  if (readErr) return { updated: 0, error: readErr.message };
  const rows = (owned ?? []) as Array<{ id: string; labels: string[] | null }>;
  if (!rows.length) return { updated: 0, error: "not_found" };
  const mine = rows.map((r) => r.id);

  // The star only. Category is not reachable from here any more: it is the
  // rollback shadow, written by placeItems from the section's name, and a
  // second writer could make it disagree with section_id.
  const flat: Record<string, unknown> = {};
  if (patch.favorite !== undefined) flat.is_favorite = patch.favorite;

  if (Object.keys(flat).length) {
    const { error } = await db.from("library_items").update(flat)
      .eq("user_id", userId).in("id", mine);
    if (error) return { updated: 0, error: error.message };
  }

  const add = (patch.addLabels ?? []).filter(Boolean);
  const remove = (patch.removeLabels ?? []).filter(Boolean);
  if (add.length || remove.length) {
    const fold = (x: string) => x.toLowerCase();
    const dropped = new Set(remove.map(fold));
    // Group by the RESULT, so identical outcomes cost one statement between them.
    const groups = new Map<string, { labels: string[]; ids: string[] }>();
    for (const r of rows) {
      const current = (r.labels ?? []).map(String);
      const kept = current.filter((l) => !dropped.has(fold(l)));
      const have = new Set(kept.map(fold));
      const next = [...kept];
      for (const l of add) if (!have.has(fold(l))) { next.push(l); have.add(fold(l)); }
      const key = JSON.stringify(next);
      const g = groups.get(key) ?? { labels: next, ids: [] };
      g.ids.push(r.id);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const { error } = await db.from("library_items").update({ labels: g.labels })
        .eq("user_id", userId).in("id", g.ids);
      if (error) return { updated: 0, error: error.message };
    }
  }

  return { updated: mine.length };
}

/** The professional's own vocabulary, for filter chips and spelling reuse. */
export async function libraryVocabulary(db: Db, userId: string): Promise<LibraryVocabulary> {
  const { data } = await db.from("library_items")
    .select("category, labels, is_favorite").eq("user_id", userId);
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

// ===========================================================================
// STRUCTURE — sections, groups, placement and order.
//
// Every statement carries an explicit user_id, for the same reason the rest of
// this file does: library_items, library_sections and library_groups all have
// RLS enabled with NO policy, so they are reachable only through the service
// role and ownership is this layer's job rather than the database's.
//
// NOTHING HERE WRITES revision OR updated_at. Where an item is filed is not a
// change to what it says: bumping revision would report every descendant
// FlowGuide as diverged because somebody tidied a shelf, and bumping updated_at
// would reshuffle the Library into the order things were filed in.
// ===========================================================================

export interface LibraryStructure { sections: SectionRow[]; groups: GroupRow[] }

export async function readStructure(db: Db, userId: string): Promise<LibraryStructure> {
  const [s, g] = await Promise.all([
    db.from("library_sections").select("id, name, sort_order").eq("user_id", userId)
      .order("sort_order").order("id"),
    db.from("library_groups").select("id, section_id, name, sort_order").eq("user_id", userId)
      .order("sort_order").order("id"),
  ]);
  return {
    sections: ((s.data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), name: String(r.name), sortOrder: Number(r.sort_order) })),
    groups: ((g.data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), sectionId: String(r.section_id), name: String(r.name), sortOrder: Number(r.sort_order) })),
  };
}

/** Where a placement should send the selection. A name rather than an id means
 *  "create it if it is not already there" — sections and groups are made INLINE
 *  while filing, never in a screen of their own. */
export interface PlacementRequest {
  sectionId?: string | null;
  newSectionName?: string;
  groupId?: string | null;
  newGroupName?: string;
  /** Explicitly back to the unorganized remainder. */
  unorganize?: boolean;
}

/**
 * Put a selection somewhere, creating the section or group if it is new.
 *
 * Appends in the order given, so a bulk file keeps the sequence the
 * professional selected in rather than an arbitrary one. Writes the
 * compatibility shadow (`category` = the section's name, or '') in the same
 * statement, so a rollback to the pre-structure runtime still shows where
 * things live.
 *
 * Prunes afterwards: whatever container the selection just left may now be
 * empty, and empty structure is not something anyone asked to keep.
 */
export async function placeItems(
  db: Db, userId: string, ids: string[], req: PlacementRequest,
): Promise<{ updated: number; structure?: LibraryStructure; error?: string }> {
  const targets = [...new Set(ids.map(String))].filter(Boolean);
  if (!targets.length) return { updated: 0, error: "nothing_selected" };

  // Ownership confirmed here, from the session, before anything is written —
  // and every write repeats the predicate rather than trusting this.
  const { data: owned, error: readErr } = await db.from("library_items")
    .select("id").eq("user_id", userId).in("id", targets);
  if (readErr) return { updated: 0, error: readErr.message };
  const mine = ((owned ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (!mine.length) return { updated: 0, error: "not_found" };
  // Preserve the caller's order; the read above does not promise one.
  const ordered = targets.filter((t) => mine.includes(t));

  let structure = await readStructure(db, userId);

  // ---- resolve the destination -------------------------------------------
  let sectionId: string | null = null;
  let groupId: string | null = null;
  let sectionName = "";

  if (!req.unorganize) {
    const wantedSection = cleanName(req.newSectionName);
    if (req.sectionId) {
      const found = structure.sections.find((x) => x.id === req.sectionId);
      if (!found) return { updated: 0, error: "section_not_found" };
      sectionId = found.id; sectionName = found.name;
    } else if (wantedSection) {
      // Case-insensitive reuse: naming a section that already exists joins it
      // rather than creating a second one beside it.
      const existing = findByName(structure.sections, wantedSection);
      if (existing) { sectionId = existing.id; sectionName = existing.name; }
      else {
        const nextOrder = structure.sections.reduce((m, x) => Math.max(m, x.sortOrder), -1) + 1;
        const { data, error } = await db.from("library_sections")
          .insert({ user_id: userId, name: wantedSection, sort_order: nextOrder })
          .select("id, name, sort_order").single();
        if (error) return { updated: 0, error: error.message };
        const row = data as Record<string, unknown>;
        sectionId = String(row.id); sectionName = String(row.name);
        structure = await readStructure(db, userId);
      }
    }

    if (sectionId) {
      const wantedGroup = cleanName(req.newGroupName);
      if (req.groupId) {
        const found = structure.groups.find((x) => x.id === req.groupId && x.sectionId === sectionId);
        // A group belongs to its section. Asking for one from elsewhere is a
        // mistake, not something to silently reinterpret.
        if (!found) return { updated: 0, error: "group_not_found" };
        groupId = found.id;
      } else if (wantedGroup) {
        const siblings = structure.groups.filter((x) => x.sectionId === sectionId);
        const existing = findByName(siblings, wantedGroup);
        if (existing) groupId = existing.id;
        else {
          const nextOrder = siblings.reduce((m, x) => Math.max(m, x.sortOrder), -1) + 1;
          const { data, error } = await db.from("library_groups")
            .insert({ user_id: userId, section_id: sectionId, name: wantedGroup, sort_order: nextOrder })
            .select("id").single();
          if (error) return { updated: 0, error: error.message };
          groupId = String((data as Record<string, unknown>).id);
        }
      }
    }
  }

  // ---- append to the end of the destination -------------------------------
  let base: number | null = null;
  if (sectionId) {
    let q = db.from("library_items").select("sort_order")
      .eq("user_id", userId).eq("section_id", sectionId);
    q = groupId ? q.eq("group_id", groupId) : q.is("group_id", null);
    const { data } = await q.order("sort_order", { ascending: false }).limit(1);
    const top = (data ?? []) as Array<{ sort_order: number }>;
    base = top.length ? Number(top[0].sort_order) : null;
  }
  const orders = appendOrders(base, ordered.length);

  // The shadow. `category` cannot express a group or a position and is not
  // asked to — it names the section, or nothing.
  const category = shadowCategory(sectionName);

  // One statement per item, because each takes its own position. No revision,
  // no updated_at, on purpose.
  for (let i = 0; i < ordered.length; i++) {
    const { error } = await db.from("library_items")
      .update({ section_id: sectionId, group_id: groupId, sort_order: sectionId ? orders[i] : 0, category })
      .eq("id", ordered[i]).eq("user_id", userId);
    if (error) return { updated: 0, error: error.message };
  }

  await pruneEmptyStructure(db, userId);
  return { updated: ordered.length, structure: await readStructure(db, userId) };
}

/**
 * Remove structure nothing is in any more.
 *
 * Application policy, deliberately not a trigger. A trigger would fire between
 * "create the section" and "assign the items" — two calls, because supabase-js
 * has no multi-statement transaction — and delete the section a professional
 * had just named. The NO ACTION foreign keys are the safety net underneath: if
 * this is ever wrong, the delete is refused rather than orphaning an item.
 *
 * Groups first, because emptying a group can be what empties its section.
 */
export async function pruneEmptyStructure(db: Db, userId: string): Promise<void> {
  const [{ data: items }, structure] = await Promise.all([
    db.from("library_items").select("section_id, group_id").eq("user_id", userId),
    readStructure(db, userId),
  ]);
  const rows = (items ?? []) as Array<{ section_id: string | null; group_id: string | null }>;

  const usedGroups = new Set(rows.map((r) => r.group_id).filter(Boolean) as string[]);
  const deadGroups = structure.groups.filter((g) => !usedGroups.has(g.id)).map((g) => g.id);
  if (deadGroups.length) {
    await db.from("library_groups").delete().eq("user_id", userId).in("id", deadGroups);
  }

  const usedSections = new Set(rows.map((r) => r.section_id).filter(Boolean) as string[]);
  const keptGroupSections = new Set(
    structure.groups.filter((g) => !deadGroups.includes(g.id)).map((g) => g.sectionId));
  const deadSections = structure.sections
    .filter((s) => !usedSections.has(s.id) && !keptGroupSections.has(s.id)).map((s) => s.id);
  if (deadSections.length) {
    await db.from("library_sections").delete().eq("user_id", userId).in("id", deadSections);
  }
}

/**
 * Move one item a single step within ITS OWN container.
 *
 * The whole container is read here, on the server. The client may be showing
 * one page of a long section, and a move computed from the loaded rows would
 * quietly rewrite the tail the moment somebody pressed it on the last visible
 * row — the same class of defect as a paging cap, reached from the other side.
 */
export async function moveItem(
  db: Db, userId: string, id: string, direction: "up" | "down",
): Promise<{ moved: boolean; error?: string }> {
  const { data: row } = await db.from("library_items")
    .select("id, section_id, group_id").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!row) return { moved: false, error: "not_found" };
  const me = row as { section_id: string | null; group_id: string | null };
  // The unorganized remainder is newest-first and is not hand-ordered, so there
  // is no sequence here to move within.
  if (!me.section_id) return { moved: false, error: "not_ordered" };

  let q = db.from("library_items").select("id, sort_order")
    .eq("user_id", userId).eq("section_id", me.section_id);
  q = me.group_id ? q.eq("group_id", me.group_id) : q.is("group_id", null);
  const { data } = await q.order("sort_order", { ascending: true }).order("id", { ascending: true });

  const ordered = ((data ?? []) as Array<{ id: string; sort_order: number }>)
    .map((r) => ({ id: String(r.id), sortOrder: Number(r.sort_order) }));
  const writes = swapForMove(ordered, id, direction);
  if (!writes) return { moved: false };            // already at the edge

  for (const w of writes) {
    const { error } = await db.from("library_items").update({ sort_order: w.sortOrder })
      .eq("id", w.id).eq("user_id", userId);
    if (error) return { moved: false, error: error.message };
  }
  return { moved: true };
}

/** Move a section among the professional's sections. */
export async function moveSection(
  db: Db, userId: string, id: string, direction: "up" | "down",
): Promise<{ moved: boolean; error?: string }> {
  const { sections } = await readStructure(db, userId);
  if (!sections.some((s) => s.id === id)) return { moved: false, error: "not_found" };
  const writes = swapForMove(sections, id, direction);
  if (!writes) return { moved: false };
  for (const w of writes) {
    const { error } = await db.from("library_sections").update({ sort_order: w.sortOrder })
      .eq("id", w.id).eq("user_id", userId);
    if (error) return { moved: false, error: error.message };
  }
  return { moved: true };
}

/** Move a group within its own section. Groups never cross sections by moving —
 *  that is what "Move to…" is for, and it is a different decision. */
export async function moveGroup(
  db: Db, userId: string, id: string, direction: "up" | "down",
): Promise<{ moved: boolean; error?: string }> {
  const { groups } = await readStructure(db, userId);
  const me = groups.find((g) => g.id === id);
  if (!me) return { moved: false, error: "not_found" };
  const siblings = groups.filter((g) => g.sectionId === me.sectionId);
  const writes = swapForMove(siblings, id, direction);
  if (!writes) return { moved: false };
  for (const w of writes) {
    const { error } = await db.from("library_groups").update({ sort_order: w.sortOrder })
      .eq("id", w.id).eq("user_id", userId);
    if (error) return { moved: false, error: error.message };
  }
  return { moved: true };
}

/**
 * The whole Library, structured, in one response.
 *
 * Sections and groups are read whole because they are few by nature; each
 * container contributes its first page, and long ones expand IN PLACE through
 * the ordinary paged list rather than becoming a screen of their own. The
 * counts come from one small projection over the professional's items, so
 * "Show all 23" can say a number without a query per container.
 */
export interface BrowseContainer {
  sectionId: string | null;
  groupId: string | null;
  items: LibraryItem[];
  total: number;
  cursor: ContainerCursor | LibraryCursor | null;
  hasMore: boolean;
}

export async function browseLibrary(
  db: Db, userId: string, perContainer = 6,
): Promise<{ structure: LibraryStructure; containers: BrowseContainer[]; unorganized: BrowseContainer }> {
  const structure = await readStructure(db, userId);

  const { data: all } = await db.from("library_items")
    .select("section_id, group_id").eq("user_id", userId);
  const rows = (all ?? []) as Array<{ section_id: string | null; group_id: string | null }>;
  const countOf = (s: string | null, g: string | null) =>
    rows.filter((r) => r.section_id === s && r.group_id === g).length;

  // Organized first, remainder last — the same rule at both levels. Within a
  // section: its groups in order, then the items sitting loose in it.
  const wanted: Placement[] = [];
  for (const s of structure.sections) {
    for (const g of structure.groups.filter((x) => x.sectionId === s.id)) {
      wanted.push({ sectionId: s.id, groupId: g.id });
    }
    wanted.push({ sectionId: s.id, groupId: null });
  }

  const containers = await Promise.all(wanted.map(async (c) => {
    const page = await searchLibrary(db, userId, { container: c, limit: perContainer });
    return {
      sectionId: c.sectionId, groupId: c.groupId,
      items: page.items, total: countOf(c.sectionId, c.groupId),
      cursor: page.nextContainerCursor ?? null, hasMore: page.hasMore,
    };
  }));

  const un = await searchLibrary(db, userId, { container: { sectionId: null, groupId: null }, limit: perContainer });
  return {
    structure, containers,
    unorganized: {
      sectionId: null, groupId: null, items: un.items,
      total: countOf(null, null), cursor: un.nextCursor ?? null, hasMore: un.hasMore,
    },
  };
}
