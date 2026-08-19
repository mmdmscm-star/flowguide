import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { insertLibraryEntries } from "@/lib/library-insert";

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

  // BLOCK PACKETS ARE REFUSED, and this is a STRUCTURAL invariant rather than an
  // unimplemented feature. trg_freeze_items (0007) rejects INSERT, DELETE,
  // section_id and sort_order changes on any item whose packet is in block mode;
  // trg_freeze_sections does the same for sections. In block mode, composition
  // is owned by packet_blocks and the items/sections substrate is deliberately
  // frozen — only content edits are permitted.
  //
  // Inserting here is therefore not merely missing a packet_blocks row: the item
  // INSERT itself is rejected by the database. Supporting it means changing that
  // invariant, which is a composition decision, not a Library one.
  if ((packet as { composition_mode?: string }).composition_mode === "blocks") {
    return NextResponse.json({
      error: "unsupported_composition",
      message: "Adding from your Library isn't available in the block editor yet.",
    }, { status: 409 });
  }

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

  const { itemIds: created, error: insertErr } = await insertLibraryEntries(
    supabase, session.userId, id, targetSection, libraryItemIds);
  if (insertErr) return NextResponse.json({ error: insertErr }, { status: 400 });

  if (created.length === 0) {
    return NextResponse.json({ error: "nothing_inserted" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, itemIds: created, sectionId: targetSection });
}
