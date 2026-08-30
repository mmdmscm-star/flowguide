import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { bulkOrganize, libraryVocabulary, placeItems, readStructure } from "@/lib/library-service";
import { normalizeLabels } from "@/lib/library-organization";

// PATCH /api/library/bulk — organize a selection of Library entries at once.
//
// { ids, place?, addLabels?, removeLabels?, favorite? }
//
// `place` puts the selection somewhere — an existing section, a new one named
// inline, optionally a group inside it, or back to the unorganized remainder:
//
//   { sectionId } | { newSectionName } | { ..., groupId } | { ..., newGroupName }
//   | { unorganize: true }
//
// Where something lives is a `place`, never a name typed into a field — the
// destination is chosen from sections that exist, or created inline while
// filing.
//
// ORGANIZATION ONLY. This route can place items, set a label and set a star,
// and there is nothing else it can reach: no title, no description, no content
// of any kind. A bulk endpoint that could write content would be one mistake away
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

  // PLACEMENT FIRST, and on its own. It writes section, group, position and the
  // position together; labels and the star are separate dimensions that cut
  // across wherever a thing happens to live.
  let updated = 0;
  let error: string | undefined;
  const place = b.place as Record<string, unknown> | undefined;
  if (place && typeof place === "object") {
    const res = await placeItems(supabase, session.userId, ids, {
      sectionId: typeof place.sectionId === "string" ? place.sectionId : undefined,
      newSectionName: typeof place.newSectionName === "string" ? place.newSectionName : undefined,
      groupId: typeof place.groupId === "string" ? place.groupId : undefined,
      newGroupName: typeof place.newGroupName === "string" ? place.newGroupName : undefined,
      unorganize: place.unorganize === true,
    });
    updated = res.updated; error = res.error;
    if (error === "section_not_found" || error === "group_not_found") {
      // Almost always a section another tab emptied and pruned while this one
      // still had it on screen. Say which thing is gone rather than failing
      // with something the professional cannot act on.
      return NextResponse.json({
        error, message: error === "section_not_found"
          ? "That section no longer exists. Choose another or make a new one."
          : "That group no longer exists. Choose another or make a new one.",
      }, { status: 409 });
    }
  }

  if (!error && ("addLabels" in b || "removeLabels" in b || typeof b.favorite === "boolean")) {
    const res = await bulkOrganize(supabase, session.userId, ids, {
      addLabels: "addLabels" in b ? normalizeLabels(b.addLabels, known.labels) : undefined,
      // Removal matches case-insensitively inside bulkOrganize, so a label typed
      // in the wrong case still comes off rather than silently staying put.
      removeLabels: "removeLabels" in b ? normalizeLabels(b.removeLabels, known.labels) : undefined,
      favorite: typeof b.favorite === "boolean" ? b.favorite : undefined,
    });
    updated = Math.max(updated, res.updated); error = error ?? res.error;
  }

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
  const [vocabulary, structure] = await Promise.all([
    libraryVocabulary(supabase, session.userId),
    readStructure(supabase, session.userId),
  ]);
  return NextResponse.json({ updated, vocabulary, structure });
}
