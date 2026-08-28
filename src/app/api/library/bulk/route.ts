import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { bulkOrganize, libraryVocabulary } from "@/lib/library-service";
import { normalizeCategory, normalizeLabels } from "@/lib/library-organization";

// PATCH /api/library/bulk — organize a selection of Library entries at once.
//
// { ids, setCategory?, clearCategory?, addLabels?, removeLabels?, favorite? }
//
// ORGANIZATION ONLY. This route can set a category, a label and a star, and
// there is nothing else it can reach: no title, no description, no content of
// any kind. A bulk endpoint that could write content would be one mistake away
// from overwriting sixty-five records at once, so it simply cannot.
//
// Ownership comes from the SESSION, never from the body, and is applied inside
// every statement rather than checked once — the same rule the rest of the
// Library layer follows, because library_items has RLS enabled with no policy
// and is reachable only through the service role.
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray((body as { ids?: unknown }).ids)
    ? ((body as { ids: unknown[] }).ids).map(String).filter(Boolean)
    : [];
  if (!ids.length) {
    return NextResponse.json(
      { error: "bad_request", message: "Choose something to organize first." }, { status: 400 });
  }

  const supabase = createServerClient();
  // Normalised against the professional's OWN vocabulary, so a bulk action
  // cannot be the thing that creates "santa rosa" beside "Santa Rosa".
  const known = await libraryVocabulary(supabase, session.userId);
  const b = body as Record<string, unknown>;

  const { updated, error } = await bulkOrganize(supabase, session.userId, ids, {
    setCategory: "setCategory" in b ? normalizeCategory(b.setCategory, known.categories) : undefined,
    clearCategory: b.clearCategory === true,
    addLabels: "addLabels" in b ? normalizeLabels(b.addLabels, known.labels) : undefined,
    // Removal matches case-insensitively inside bulkOrganize, so a label typed
    // in the wrong case still comes off rather than silently staying put.
    removeLabels: "removeLabels" in b ? normalizeLabels(b.removeLabels, known.labels) : undefined,
    favorite: typeof b.favorite === "boolean" ? b.favorite : undefined,
  });

  if (error === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (error === "nothing_selected") {
    return NextResponse.json(
      { error: "bad_request", message: "Choose something to organize first." }, { status: 400 });
  }
  if (error) {
    console.error(`[library-bulk] ${error}`);
    return NextResponse.json(
      { error: "organize_failed", message: "Could not organize those items. Nothing was changed." },
      { status: 400 });
  }
  return NextResponse.json({ updated, vocabulary: await libraryVocabulary(supabase, session.userId) });
}
