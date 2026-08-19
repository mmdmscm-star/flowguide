import { applyItemContentUpdate, normalizeItemContent } from "./item-content.ts";
import { lineageForInsert } from "./library.ts";
import { getLibraryItem } from "./library-service.ts";
import type { createServerClient } from "./supabase.ts";

type Db = ReturnType<typeof createServerClient>;

/**
 * Copy Library entries into a section as ordinary items.
 *
 * ONE implementation, used by both entry points — adding to a FlowGuide you are
 * already editing, and creating a new one from saved material. Two copies of
 * this would drift on lineage or on the content-write path, and an inserted item
 * must be indistinguishable from a hand-made one no matter which door it used.
 *
 * A DISCONNECTED SNAPSHOT, per the input rule in product-direction.md: after
 * this returns the FlowGuide owns its copy outright. Editing it changes nothing
 * in the Library, and editing the Library changes nothing here.
 *
 * It deliberately does NOT write 0014 ingestion provenance: a Library copy has
 * no ingestion origin, so ownership recomputation must decline for it rather
 * than guess. Fabricating a run/chunk/emit index would invent a source claim
 * that never existed.
 */
export async function insertLibraryEntries(
  db: Db, userId: string, packetId: string, sectionId: string, libraryItemIds: string[],
): Promise<{ itemIds: string[]; error?: string }> {
  const { data: last } = await db
    .from("items").select("sort_order").eq("section_id", sectionId)
    .order("sort_order", { ascending: false }).limit(1).maybeSingle();
  let nextOrder = last ? (last as { sort_order: number }).sort_order + 1 : 0;

  const itemIds: string[] = [];
  for (const libraryItemId of libraryItemIds) {
    const source = await getLibraryItem(db, userId, libraryItemId);
    if (!source) continue;   // deleted between picking and inserting; skip quietly

    const { data: row, error: insErr } = await db.from("items").insert({
      section_id: sectionId, title: source.title ?? "", sort_order: nextOrder++,
      // Both lineage columns together — 0017's CHECK makes a half state
      // unrepresentable, and this is where one would otherwise be created.
      ...lineageForInsert(source.id, source.revision),
    }).select("id").single();
    if (insErr || !row) continue;
    const itemId = (row as { id: string }).id;

    // NORMALISED, not passed through. An entry imported before the photo
    // normaliser existed still holds bare url strings, and handing those to
    // update_item_content would carry the same shape bug that made Library
    // editing impossible into the packet's own photo rows.
    const { error: contentErr } = await applyItemContentUpdate(
      db,
      { itemId, ownerId: userId, packetId, requireMode: "legacy" },
      normalizeItemContent({
        title: source.title ?? "", description: source.description ?? "",
        notes: source.notes ?? "", address: source.address ?? "",
        details: source.details ?? [], links: source.links ?? [],
        photos: source.photos ?? [], contacts: source.contacts ?? [],
      } as Record<string, unknown>),
    );
    if (contentErr) {
      // The row exists but its content did not land. Remove it rather than
      // leaving a titled husk the professional has to notice and delete.
      await db.from("items").delete().eq("id", itemId);
      return { itemIds, error: contentErr };
    }
    itemIds.push(itemId);
  }
  return { itemIds };
}
