import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

// GET /api/library/:id/usages — the Sendsets that hold a copy of this
// library item, with enough context to say whether each copy is up to
// date and let the professional act on each independently.
//
// A user flagged the gap: "I was updating items in the Library and
// couldn't see a way to update the Sendsets I sent out with that
// information even if I wanted to. I do not want auto-update, and
// I don't want it to be all-or-nothing. In this particular case
// maybe I only want one of the three Sendsets with that information
// to be updated." This endpoint feeds that per-Sendset chooser.
//
// Returned per entry:
//   itemId         — the Sendset's own item copy
//   packetId       — so the owner can open that Sendset
//   packetTitle    — the professional's internal name for it
//   itemTitle      — in case the title in the Sendset was tailored
//   outOfDate      — the Sendset's copy is behind the library's
//                    current revision
//   itemRevision   — the library revision the Sendset copy was taken from
//                    (null for an item that was never linked to a library
//                    entry, which won't appear here)
//
// Ownership chain enforced by filtering on the user via the packet.
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const supabase = createServerClient();

  // Library item itself — need its current revision for the outOfDate flag,
  // and the owner check doubles as the 404 guard.
  const { data: libraryItem } = await supabase
    .from("library_items")
    .select("id, title, revision")
    .eq("id", id).eq("user_id", session.userId).maybeSingle();
  if (!libraryItem) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Every Sendset item that was ever created from (or linked to) this
  // library entry. The join through sections → packets keeps the user
  // check scoped — a shared / co-authored Sendset would need its own
  // owner path and is deliberately out of scope here.
  const { data: items } = await supabase
    .from("items")
    .select("id, title, library_item_revision, sections!inner(packet_id, packets!inner(id, title, user_id, status))")
    .eq("library_item_id", id);

  // Supabase joins return ARRAYS for the related table even on !inner, so
  // the shape is sections: [{ packet_id, packets: [{ id, title, user_id, status }] }].
  // Take the first row at each level; a missing join is dropped as a defensive
  // guard — if the chain is broken the row isn't ours to act on.
  type Row = {
    id: string; title: string | null; library_item_revision: number | null;
    sections: Array<{
      packet_id: string;
      packets: Array<{ id: string; title: string | null; user_id: string; status: string }>;
    }>;
  };
  const usages = ((items ?? []) as unknown as Row[])
    .map((row) => {
      const packet = row.sections?.[0]?.packets?.[0];
      if (!packet || packet.user_id !== session.userId) return null;
      const copyRevision = Number(row.library_item_revision ?? 0);
      const outOfDate = copyRevision < Number(libraryItem.revision ?? 0);
      return {
        itemId: row.id,
        itemTitle: row.title ?? "",
        packetId: packet.id,
        packetTitle: packet.title ?? "Untitled Sendset",
        packetStatus: packet.status,
        itemRevision: copyRevision,
        outOfDate,
      };
    })
    .filter((u): u is NonNullable<typeof u> => u !== null)
    // Out-of-date first — those are the ones a professional came here to act
    // on. Among each group, newest Sendset last.
    .sort((a, b) => Number(b.outOfDate) - Number(a.outOfDate));

  return NextResponse.json({
    libraryRevision: Number(libraryItem.revision ?? 0),
    libraryTitle: libraryItem.title ?? "",
    usages,
  });
}
