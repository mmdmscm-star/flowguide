import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { normalizeItemContent } from "@/lib/item-content";
import { getLibraryItem, updateLibraryItem, deleteLibraryItem, countDescendants, setLibraryOrganization, libraryVocabulary } from "@/lib/library-service";
import { normalizeCategory, normalizeLabels } from "@/lib/library-organization";

type Context = { params: Promise<{ id: string }> };

// GET    — one entry, plus how many packet items descend from it
// PATCH  — direct edit, with OPTIMISTIC CONCURRENCY
// DELETE — hard delete; packets are untouched by construction

export async function GET(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const supabase = createServerClient();
  const item = await getLibraryItem(supabase, session.userId, id);
  if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ item, usedIn: await countDescendants(supabase, id) });
}

export async function PATCH(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const supabaseEarly = createServerClient();

  // ORGANIZING IS NOT EDITING, and it arrives in its own envelope so the two can
  // never be confused for one another.
  //
  // A content save bumps `revision`, which is the save-back comparator: a copied
  // item records the revision it came from, and a mismatch means "the base moved
  // on". If filing an item into a category bumped it, organizing a 65-item
  // Library would report 65 diverged FlowGuides. So this path writes the three
  // organizational columns and nothing else — no revision, no updated_at, and
  // no expectedRevision to supply, because no content is at stake.
  const org = (body as { organization?: Record<string, unknown> }).organization;
  if (org && typeof org === "object") {
    const known = await libraryVocabulary(supabaseEarly, session.userId);
    const patch: { category?: string; labels?: string[]; isFavorite?: boolean } = {};
    if ("category" in org) patch.category = normalizeCategory(org.category, known.categories);
    if ("labels" in org) patch.labels = normalizeLabels(org.labels, known.labels);
    if ("isFavorite" in org) patch.isFavorite = org.isFavorite === true;

    const res = await setLibraryOrganization(supabaseEarly, session.userId, id, patch);
    if (res.error === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (res.error) return NextResponse.json({ error: res.error }, { status: 400 });
    return NextResponse.json({ item: res.item });
  }

  const expected = (body as { expectedRevision?: number }).expectedRevision;

  // The revision the editor loaded is REQUIRED, not optional. Without it two
  // tabs editing the same entry silently overwrite each other — the same class
  // of loss the save-back safeguard exists to prevent, reached from a different
  // direction. Refusing is better than guessing which write should win.
  if (typeof expected !== "number") {
    return NextResponse.json(
      { error: "bad_request", message: "expectedRevision is required." }, { status: 400 });
  }

  const supabase = supabaseEarly;
  const { item, conflict, error } = await updateLibraryItem(
    supabase, session.userId, id,
    normalizeItemContent(body as Record<string, unknown>), expected);

  if (error === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (error) return NextResponse.json({ error }, { status: 400 });
  if (conflict) {
    // 409 carries the CURRENT entry, so the editor can show what it actually is
    // now rather than asking the professional to guess what they missed.
    return NextResponse.json({
      error: "revision_conflict",
      message: "This Library item changed since you opened it.",
      current: conflict,
    }, { status: 409 });
  }
  return NextResponse.json({ item });
}

export async function DELETE(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const supabase = createServerClient();
  // Packets are unaffected: they hold snapshots, and 0017's BEFORE DELETE
  // trigger clears both lineage columns on every descendant so none is left
  // recording an ancestor that no longer exists.
  const { error } = await deleteLibraryItem(supabase, session.userId, id);
  if (error) return NextResponse.json({ error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
