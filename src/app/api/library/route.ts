import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { normalizeItemContent } from "@/lib/item-content";
import { isDuplicateCandidate } from "@/lib/library";
import { searchLibrary, createLibraryItem, readItemAsPayload, libraryVocabulary, readStructure } from "@/lib/library-service";

// GET  /api/library?q=&labels=a,b&favorite=1&cursorUpdatedAt=&cursorId=
//      One PAGE of the Library, newest first. Search and the organization
//      filters compose; paging is keyset, so nothing is skipped or repeated
//      when an item is edited mid-scroll.
// POST /api/library      — add an entry, from a packet item OR written directly
//
// Ownership is enforced HERE, from the session, never from the request body.
// library_items has RLS enabled with no policy, so the table is reachable only
// through the service role — which makes ownership this layer's job rather than
// the database's, and it must therefore be explicit on every query.

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = new URL(request.url).searchParams;
  const supabase = createServerClient();

  // The cursor carries the RAW timestamp string the previous page returned. It
  // is never parsed into a Date here: timestamptz is microsecond precision and
  // a Date is milliseconds, so a round-trip would truncate it and the page
  // boundary would repeat or skip a row.
  const cursorUpdatedAt = sp.get("cursorUpdatedAt");
  const cursorId = sp.get("cursorId");
  const cursor = cursorUpdatedAt && cursorId ? { updatedAt: cursorUpdatedAt, id: cursorId } : null;

  // ONE CONTAINER, when the structured view is expanding a long section in
  // place. `unorganized=1` is the remainder, which keeps newest-first ordering
  // because it is not hand-ordered; a section or group is ordered by hand and
  // pages on (sort_order, id), so it carries its own cursor.
  const sectionId = sp.get("sectionId");
  const groupId = sp.get("groupId");
  const wantsContainer = !!sectionId || sp.get("unorganized") === "1";
  const container = wantsContainer
    ? { sectionId: sectionId || null, groupId: groupId || null }
    : null;
  const cursorSortOrder = sp.get("cursorSortOrder");
  const containerCursor = cursorSortOrder !== null && cursorId
    ? { sortOrder: Number(cursorSortOrder), id: cursorId }
    : null;

  const { items, hasMore, nextCursor, nextContainerCursor, error } = await searchLibrary(supabase, session.userId, {
    q: sp.get("q") ?? "",
    labels: (sp.get("labels") ?? "").split(",").map((l) => l.trim()).filter(Boolean),
    favorite: sp.get("favorite") === "1",
    cursor,
    container,
    containerCursor,
    limit: Number(sp.get("limit")) || undefined,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });

  // The vocabulary rides along with the FIRST page only. It describes the whole
  // Library rather than this page, so re-sending it with every scroll would be
  // the same answer repeated.
  // Vocabulary and structure ride along with the FIRST page only. Both
  // describe the whole Library rather than this page, so re-sending them with
  // every scroll would be the same answer repeated. Structure comes too so the
  // Organize panel can offer real sections without a second round trip.
  const first = !cursor && !containerCursor;
  const [vocabulary, structure] = first
    ? await Promise.all([libraryVocabulary(supabase, session.userId), readStructure(supabase, session.userId)])
    : [undefined, undefined];
  return NextResponse.json({ items, hasMore, nextCursor, nextContainerCursor, vocabulary, structure });
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { itemId, item, force } = body as
    { itemId?: string; item?: Record<string, unknown>; force?: boolean };
  if (!itemId && !item) {
    return NextResponse.json({ error: "bad_request", message: "An item is required." }, { status: 400 });
  }

  const supabase = createServerClient();

  // TWO WAYS IN, ONE ENTRY. Promoting a packet item and writing one directly
  // produce the same row through the same normaliser — a Library entry does not
  // remember which door it came through, and nothing downstream may depend on
  // it. Only the promote path records lineage, because only it has an item to
  // record lineage against.
  let raw: Record<string, unknown>;
  if (itemId) {
    const source = await readItemAsPayload(supabase, session.userId, itemId);
    if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });
    raw = source.payload as unknown as Record<string, unknown>;
  } else {
    raw = item as Record<string, unknown>;
    if (!String(raw.title ?? "").trim()) {
      return NextResponse.json(
        { error: "bad_request", message: "Give this item a title so you can find it later." },
        { status: 400 });
    }
  }
  // Normalised once, here, so every downstream step — the duplicate check and
  // the insert — reasons about the same shape regardless of which door it used.
  const payload = normalizeItemContent(raw);

  // Duplicate candidates WARN. They never merge and never block — two genuinely
  // different things can share a name, and silently merging a professional's
  // content is unrecoverable. `force` is the professional saying so explicitly.
  if (!force) {
    const { items } = await searchLibrary(supabase, session.userId, { q: payload.title ?? "", limit: 25 });
    const existing = items.find((i) => isDuplicateCandidate(i, payload));
    if (existing) {
      return NextResponse.json({
        error: "duplicate_candidate",
        message: `You already have "${existing.title}" in your Library.`,
        existing: { id: existing.id, title: existing.title, address: existing.address, updatedAt: existing.updatedAt },
      }, { status: 409 });
    }
  }

  const { item: created, error } = await createLibraryItem(
    supabase, session.userId, payload, itemId);
  if (error || !created) return NextResponse.json({ error: error ?? "save_failed" }, { status: 400 });

  // Lineage is written as BOTH columns or neither — a live ancestor whose
  // revision is unknown is a state the save-back logic cannot reason about, and
  // 0017's CHECK constraint makes it unrepresentable. An entry written directly
  // has no packet item to point at, so it correctly gets no lineage at all.
  if (itemId) {
    await supabase.from("items")
      .update({ library_item_id: created.id, library_item_revision: created.revision })
      .eq("id", itemId);
  }

  return NextResponse.json({ item: created });
}
