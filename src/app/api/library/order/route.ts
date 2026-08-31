import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { moveItem, moveSection, moveGroup, moveStructural } from "@/lib/library-service";

// POST /api/library/order — move one thing one step.
//
//   { kind: "item" | "section" | "group", id, direction: "up" | "down" }
//
// AN INTENT, NOT A LIST. The obvious shape for a reorder endpoint is "here is
// the complete ordered set of ids", which is what the FlowGuide editor sends —
// and it is correct there, because that editor always holds every block.
//
// The Library does not. A section shows its first few items and expands in
// place, so the browser routinely holds a PAGE of a container rather than the
// container. Sending that page as if it were the whole order would renumber the
// loaded rows and silently rewrite everything below them the first time anybody
// pressed Move down on the last visible row.
//
// So the client says what it wants to happen and the server resolves the
// neighbour against the whole container. Nothing about correctness then depends
// on how far someone had scrolled.
//
// ORDER ONLY. This route cannot reach a title, a description, or any content:
// it writes sort_order and nothing else, and never touches revision or
// updated_at — moving an item is not a change to what it says.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { kind, id, direction, sectionId, groupId, before, after } = body as {
    kind?: string; id?: string; direction?: string;
    sectionId?: string | null; groupId?: string | null; before?: string | null; after?: string | null;
  };

  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "bad_request", message: "Nothing to move." }, { status: 400 });
  }
  if (kind !== "item" && kind !== "section" && kind !== "group") {
    return NextResponse.json({ error: "bad_request", message: "Unknown thing to move." }, { status: 400 });
  }

  const supabase = createServerClient();

  // ---- THE DRAG FORM: a position relative to a named sibling ---------------
  //
  // A drop says "put this immediately before that one", or names a destination
  // with no sibling at all, meaning the true end of that container. The client
  // never sends an order: it names one thing and one neighbour, and the server
  // reads the whole container to work out what that means. Which is why this is
  // correct however far the professional had scrolled, and why a Section hidden
  // from a future view would still be counted when siblings are renumbered.
  //
  // THE OWNER IS THE SESSION'S, always. It is not in the body and cannot be.
  if (direction === undefined) {
    if (before && after) {
      return NextResponse.json(
        { error: "bad_request", message: "Give a neighbour to go before or after, not both." },
        { status: 400 });
    }
    if (kind === "item" && (typeof sectionId !== "string" || !sectionId)) {
      // Unorganized is newest-first and is not a destination.
      return NextResponse.json(
        { error: "bad_request", message: "An item must land in a section." }, { status: 400 });
    }
    const r = await moveStructural(supabase, session.userId, {
      kind, id,
      sectionId: kind === "item" ? sectionId ?? null : null,
      groupId: kind === "item" ? groupId ?? null : null,
      before: before ?? null,
      after: after ?? null,
    });
    if (!r.moved) {
      console.error(`[library-order] ${r.error}`);
      return NextResponse.json(
        { error: "move_failed", message: "Could not move that. Nothing was changed." }, { status: 400 });
    }
    return NextResponse.json({ moved: true });
  }

  // ---- THE FALLBACK FORM: one step up or down -----------------------------
  if (direction !== "up" && direction !== "down") {
    return NextResponse.json({ error: "bad_request", message: "Direction must be up or down." }, { status: 400 });
  }
  const move = kind === "section" ? moveSection : kind === "group" ? moveGroup : moveItem;
  const { moved, error } = await move(supabase, session.userId, id, direction);

  if (error === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (error === "not_ordered") {
    // The unorganized remainder is newest-first by design and has no hand
    // order to move within. Saying so beats a silent no-op.
    return NextResponse.json({
      error: "not_ordered",
      message: "Items that are not in a section stay newest first.",
    }, { status: 400 });
  }
  if (error) {
    console.error(`[library-order] ${error}`);
    return NextResponse.json({ error: "move_failed", message: "Could not move that. Nothing was changed." }, { status: 400 });
  }

  // `moved: false` is the honest answer for something already at the end of its
  // container — not an error, and not a change.
  return NextResponse.json({ moved });
}
