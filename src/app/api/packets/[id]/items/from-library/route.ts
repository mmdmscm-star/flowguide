import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { applyItemContentUpdate } from "@/lib/item-content";
import { lineageForInsert } from "@/lib/library";
import { getLibraryItem } from "@/lib/library-service";

type Context = { params: Promise<{ id: string }> };

// POST /api/packets/:id/items/from-library
//
// Insert one or more Library entries into a packet as ORDINARY items.
//
// A DISCONNECTED SNAPSHOT, per the input rule in product-direction.md: an input
// seeds once and does not stay connected. After this returns, the packet owns
// its copy outright — editing it changes nothing in the Library, and editing the
// Library changes nothing here.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO:
//
//   1. It does not write 0014 provenance. A Library copy has no ingestion
//      origin, so ownership recomputation must DECLINE for it rather than guess
//      — which is exactly what keeps the 0016 gate honest. Fabricating a
//      run/chunk/emit index here would invent a source claim that never existed.
//
//   2. It does not introduce a second content-write path. Content goes through
//      applyItemContentUpdate -> update_item_content, the same canonical atomic
//      writer both editors use, so an inserted item is indistinguishable from a
//      hand-made one.
export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const { libraryItemIds, sectionId } = body as { libraryItemIds?: string[]; sectionId?: string };
  if (!Array.isArray(libraryItemIds) || libraryItemIds.length === 0) {
    return NextResponse.json({ error: "bad_request", message: "Choose at least one item." }, { status: 400 });
  }

  const supabase = createServerClient();

  const { data: packet } = await supabase
    .from("packets").select("id, status, composition_mode").eq("id", id).eq("user_id", session.userId).maybeSingle();
  if (!packet) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const isBlocks = (packet as { composition_mode?: string }).composition_mode === "blocks";

  if ((packet as { status: string }).status !== "draft") {
    return NextResponse.json(
      { error: "not_draft", message: "Unpublish this packet before adding items." }, { status: 409 });
  }

  // Resolve the target section, and prove it belongs to THIS packet — a section
  // id from a request body is not evidence of anything on its own.
  let targetSection = sectionId ?? null;
  if (targetSection) {
    const { data: sec } = await supabase
      .from("sections").select("id").eq("id", targetSection).eq("packet_id", id).maybeSingle();
    if (!sec) return NextResponse.json({ error: "bad_request", message: "Unknown section." }, { status: 400 });
  } else {
    const { data: first } = await supabase
      .from("sections").select("id").eq("packet_id", id).order("sort_order").limit(1).maybeSingle();
    if (!first) return NextResponse.json({ error: "no_section", message: "Add a section first." }, { status: 400 });
    targetSection = (first as { id: string }).id;
  }

  const { data: last } = await supabase
    .from("items").select("sort_order").eq("section_id", targetSection)
    .order("sort_order", { ascending: false }).limit(1).maybeSingle();
  let nextOrder = last ? (last as { sort_order: number }).sort_order + 1 : 0;

  const created: string[] = [];
  for (const libraryItemId of libraryItemIds) {
    const source = await getLibraryItem(supabase, session.userId, libraryItemId);
    if (!source) continue;   // deleted between picking and inserting; skip quietly

    let itemId: string;

    if (isBlocks) {
      // A block packet needs an item AND its packet_blocks row, and the two are
      // a bijection the database enforces. They are created together inside
      // 0018's function because two statements from here could leave the packet
      // permanently inconsistent and unpublishable with no way to repair it.
      const { data: newId, error: rpcErr } = await supabase.rpc("library_insert_item_block", {
        p_owner: session.userId, p_packet_id: id,
        p_library_item_id: libraryItemId, p_section_id: targetSection,
      });
      if (rpcErr || !newId) continue;
      itemId = String(newId);
    } else {
      const { data: row, error: insErr } = await supabase.from("items").insert({
        section_id: targetSection, title: source.title ?? "", sort_order: nextOrder++,
        // Both lineage columns together — 0017's CHECK makes a half state
        // unrepresentable, and this is where one would otherwise be created.
        ...lineageForInsert(source.id, source.revision),
      }).select("id").single();
      if (insErr || !row) continue;
      itemId = (row as { id: string }).id;
    }

    const { error: contentErr } = await applyItemContentUpdate(
      supabase,
      { itemId, ownerId: session.userId, packetId: id, requireMode: isBlocks ? "blocks" : "legacy" },
      {
        title: source.title ?? "", description: source.description ?? "",
        notes: source.notes ?? "", address: source.address ?? "",
        details: source.details ?? [], links: source.links ?? [],
        photos: source.photos ?? [], contacts: source.contacts ?? [],
      },
    );
    if (contentErr) {
      // The row exists but its content did not land. Remove it rather than
      // leaving a titled husk the professional has to notice and delete.
      // packet_blocks.item_id cascades on delete, so a block packet's bijection
      // survives this cleanup rather than being broken by it.
      await supabase.from("items").delete().eq("id", itemId);
      return NextResponse.json({ error: contentErr }, { status: 400 });
    }
    created.push(itemId);
  }

  if (created.length === 0) {
    return NextResponse.json({ error: "nothing_inserted" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, itemIds: created, sectionId: targetSection });
}
