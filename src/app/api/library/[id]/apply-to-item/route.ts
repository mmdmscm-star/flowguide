import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { getLibraryItem, readItemAsPayload } from "@/lib/library-service";
import { applyItemContentUpdate } from "@/lib/item-content";

// POST /api/library/:id/apply-to-item — push the library item's current
// version into ONE Sendset item that was created from it.
//
//   { itemId }
//
// EXPLICIT, PER-SENDSET. The companion to GET /api/library/:id/usages.
// The user who flagged this didn't want auto-update or an all-or-nothing
// propagation — they wanted to look at each Sendset and decide. One POST
// here handles one Sendset; a second POST handles another; none runs
// without the professional's click.
//
// OWNERSHIP via the sendset item's section → packet → user chain, matched
// against the library item's user. If the item isn't linked to this
// library entry we refuse rather than silently rewriting it; a Sendset
// item can only be re-synced from the library item it was taken from.
//
// WHAT IS COPIED: the content fields the library stores — title,
// description, notes, highlight, address, details, links, photos,
// contacts — in the shape the item editor already writes. Nothing on
// the Sendset item that isn't content (sort_order, section_id, etc.)
// is touched. The item's `library_item_revision` is updated to match
// the library's current revision so "In sync" reads true next time
// usages is read.
//
// PUBLISHED SENDSETS KEEP THEIR PUBLICATION. The published snapshot is
// frozen at publish time (see memory on "Published snapshot / 0050");
// updating the item here changes the DRAFT, which only reaches a
// recipient on a republish. That's the correct behaviour — the owner
// opted in to this update, not into republishing.
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: libraryItemId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const { itemId } = body as { itemId?: string };
  if (!itemId || typeof itemId !== "string") {
    return NextResponse.json({ error: "bad_request", message: "Which Sendset item should take the update?" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Library item owned by this user; its content payload is the source.
  const libraryItem = await getLibraryItem(supabase, session.userId, libraryItemId);
  if (!libraryItem) {
    return NextResponse.json({ error: "not_found", message: "That library item is not yours or no longer exists." }, { status: 404 });
  }

  // The destination item — verify it's actually linked to this library
  // entry, through the owner chain. A direct supabase query is used so
  // we can enforce the library_item_id match in the same SQL that
  // enforces ownership.
  const { data: destItemRow } = await supabase
    .from("items")
    .select("id, library_item_id, sections!inner(packet_id, packets!inner(id, user_id))")
    .eq("id", itemId).maybeSingle();
  // Supabase's related-table joins return ARRAYS even for !inner joins; take
  // the first row at each level. A missing join (undefined) is treated as
  // not-found, same as a missing root row.
  const destItem = destItemRow as unknown as null | {
    id: string; library_item_id: string | null;
    sections: Array<{ packet_id: string; packets: Array<{ id: string; user_id: string }> }>;
  };
  const destPacket = destItem?.sections?.[0]?.packets?.[0];
  if (!destItem || !destPacket) {
    return NextResponse.json({ error: "not_found", message: "That Sendset item no longer exists." }, { status: 404 });
  }
  if (destPacket.user_id !== session.userId) {
    return NextResponse.json({ error: "forbidden", message: "That Sendset item is not yours." }, { status: 403 });
  }
  if (destItem.library_item_id !== libraryItemId) {
    return NextResponse.json({
      error: "not_linked",
      message: "That Sendset item isn't linked to this library entry.",
    }, { status: 409 });
  }

  // The library item's content as a payload the item writer understands.
  // readItemAsPayload returns { payload, ancestry }; only the payload is
  // needed here — ancestry is for the OTHER direction (item → library).
  const source = await readItemAsPayload(supabase, session.userId, libraryItem.id);
  if (!source) {
    return NextResponse.json({ error: "not_found", message: "The library item could not be read." }, { status: 500 });
  }

  // Write the content. applyItemContentUpdate (the shared writer the item
  // editor uses) enforces owner + mode via the RPC it calls.
  const { error: writeError } = await applyItemContentUpdate(
    supabase,
    { itemId, ownerId: session.userId, requireMode: "legacy" },
    source.payload,
  );
  if (writeError) {
    console.error(`[library-apply-to-item] write ${writeError}`);
    return NextResponse.json({ error: "write_failed", message: "The update could not be saved." }, { status: 500 });
  }

  // Record which library revision this copy now matches, so the usages
  // endpoint reads "in sync" the next time it's queried. Separate from
  // the content write because the RPC above intentionally doesn't touch
  // this column — content writes from a normal edit do not change it.
  const { error: revisionError } = await supabase
    .from("items")
    .update({ library_item_revision: libraryItem.revision })
    .eq("id", itemId);
  if (revisionError) {
    console.error(`[library-apply-to-item] revision ${revisionError.message}`);
    // Content is already written; a stale revision marker is cosmetic
    // (the next time usages is read, outOfDate will still read true, so
    // the owner can click Update again and it will no-op). Report but
    // don't fail.
  }

  return NextResponse.json({ ok: true, revision: Number(libraryItem.revision ?? 0) });
}
