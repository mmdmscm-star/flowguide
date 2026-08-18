import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { diffItemContent, decideSaveBack, recomputeAfterConflict } from "@/lib/library";
import { getLibraryItem, readItemAsPayload, updateLibraryFromItem, saveAsNewFromItem } from "@/lib/library-service";

type Context = { params: Promise<{ id: string }> };

// POST /api/library/:id/update-from-item — "Update Library version".
//
// EXPLICIT, USER-INITIATED REPLACEMENT. Not synchronization: it writes FROM a
// packet item TO the Library snapshot, on confirmation, and touches no other
// packet. Every packet that already used this entry is unchanged — they hold
// their own snapshots.
//
// TWO WAYS THIS CAN DESTROY WORK, and both are ordinary rather than edge cases:
//
//   TAILORED  — the descendant was deliberately pruned for one recipient, so a
//               replacement deletes reusable content from the base.
//   STALE     — the entry was edited directly after this copy was taken, so a
//               replacement overwrites those newer edits.
//
// GET returns the comparison the professional reviews. POST re-checks the
// revision ATOMICALLY at write time, because the entry can change between the
// two — another tab, another device. A write that lands against a state nobody
// reviewed is precisely the overwrite this route exists to prevent.

/** The comparison behind the confirmation dialog. */
export async function GET(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const itemId = new URL(request.url).searchParams.get("itemId");
  if (!itemId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = createServerClient();
  const source = await readItemAsPayload(supabase, session.userId, itemId);
  if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const ancestor = await getLibraryItem(supabase, session.userId, id);
  if (!ancestor) {
    // Deleted ancestor: the only honest offer is a NEW entry. A deleted record
    // is never silently resurrected.
    return NextResponse.json({
      decision: decideSaveBack({ libraryItemId: null, copiedFromRevision: source.ancestry.copiedFromRevision, currentRevision: null }, null),
      diff: null, ancestor: null,
    });
  }

  const diff = diffItemContent(ancestor, source.payload);
  return NextResponse.json({
    diff,
    decision: decideSaveBack({ ...source.ancestry, currentRevision: ancestor.revision }, diff),
    ancestor: { id: ancestor.id, title: ancestor.title, revision: ancestor.revision },
  });
}

export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const { itemId, expectedRevision, action } = body as {
    itemId?: string; expectedRevision?: number; action?: "update" | "save_as_new";
  };
  if (!itemId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = createServerClient();

  // Save as new: atomic insert + repoint, so a tailored copy stops being
  // measured against a base it deliberately does not match.
  if (action === "save_as_new") {
    const { libraryItemId, error } = await saveAsNewFromItem(supabase, session.userId, itemId);
    if (error) return NextResponse.json({ error }, { status: 400 });
    return NextResponse.json({ ok: true, libraryItemId });
  }

  // The reviewed revision is required. Accepting the write without it would
  // mean replacing whatever happens to be there now, which is the thing the
  // confirmation was supposed to prevent.
  if (typeof expectedRevision !== "number") {
    return NextResponse.json(
      { error: "bad_request", message: "expectedRevision is required." }, { status: 400 });
  }

  const { revision, conflict, error } = await updateLibraryFromItem(
    supabase, session.userId, id, itemId, expectedRevision);
  if (error) return NextResponse.json({ error }, { status: 400 });

  if (conflict) {
    // Not a failure — an ordinary race with a defined resolution. Return the
    // RECOMPUTED comparison so the professional decides again with accurate
    // information rather than retrying blindly.
    const [ancestor, source] = await Promise.all([
      getLibraryItem(supabase, session.userId, id),
      readItemAsPayload(supabase, session.userId, itemId),
    ]);
    if (!ancestor || !source) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const fresh = recomputeAfterConflict(ancestor, source.payload, {
      ...source.ancestry, currentRevision: ancestor.revision,
    });
    return NextResponse.json({
      error: "revision_conflict",
      message: "This Library item changed while you were reviewing. Here's what it looks like now.",
      currentRevision: ancestor.revision,
      ...fresh,
    }, { status: 409 });
  }

  return NextResponse.json({ ok: true, revision });
}
