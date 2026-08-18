import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { normalizeItemContent } from "@/lib/item-content";
import { isDuplicateCandidate } from "@/lib/library";
import { searchLibrary, createLibraryItem, readItemAsPayload } from "@/lib/library-service";

// GET  /api/library?q=   — search, or most-recently-updated when q is empty
// POST /api/library      — Save to Library from a packet item
//
// Ownership is enforced HERE, from the session, never from the request body.
// library_items has RLS enabled with no policy, so the table is reachable only
// through the service role — which makes ownership this layer's job rather than
// the database's, and it must therefore be explicit on every query.

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = new URL(request.url).searchParams.get("q") ?? "";
  const supabase = createServerClient();
  const { items, error } = await searchLibrary(supabase, session.userId, q);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ items });
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { itemId, force } = body as { itemId?: string; force?: boolean };
  if (!itemId) {
    return NextResponse.json({ error: "bad_request", message: "An item is required." }, { status: 400 });
  }

  const supabase = createServerClient();
  const source = await readItemAsPayload(supabase, session.userId, itemId);
  if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Duplicate candidates WARN. They never merge and never block — two genuinely
  // different things can share a name, and silently merging a professional's
  // content is unrecoverable. `force` is the professional saying so explicitly.
  if (!force) {
    const { items } = await searchLibrary(supabase, session.userId, source.payload.title ?? "", 25);
    const existing = items.find((i) => isDuplicateCandidate(i, source.payload));
    if (existing) {
      return NextResponse.json({
        error: "duplicate_candidate",
        message: `You already have "${existing.title}" in your Library.`,
        existing: { id: existing.id, title: existing.title, address: existing.address, updatedAt: existing.updatedAt },
      }, { status: 409 });
    }
  }

  const { item, error } = await createLibraryItem(
    supabase, session.userId, normalizeItemContent(source.payload as Record<string, unknown>), itemId);
  if (error || !item) return NextResponse.json({ error: error ?? "save_failed" }, { status: 400 });

  // Lineage is written as BOTH columns or neither — a live ancestor whose
  // revision is unknown is a state the save-back logic cannot reason about, and
  // 0017's CHECK constraint makes it unrepresentable.
  await supabase.from("items")
    .update({ library_item_id: item.id, library_item_revision: item.revision })
    .eq("id", itemId);

  return NextResponse.json({ item });
}
