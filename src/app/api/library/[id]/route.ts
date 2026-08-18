import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { normalizeItemContent } from "@/lib/item-content";
import { getLibraryItem, updateLibraryItem, deleteLibraryItem, countDescendants } from "@/lib/library-service";

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
  const expected = (body as { expectedRevision?: number }).expectedRevision;

  // The revision the editor loaded is REQUIRED, not optional. Without it two
  // tabs editing the same entry silently overwrite each other — the same class
  // of loss the save-back safeguard exists to prevent, reached from a different
  // direction. Refusing is better than guessing which write should win.
  if (typeof expected !== "number") {
    return NextResponse.json(
      { error: "bad_request", message: "expectedRevision is required." }, { status: 400 });
  }

  const supabase = createServerClient();
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
