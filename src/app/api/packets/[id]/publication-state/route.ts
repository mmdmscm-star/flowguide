import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { getPublicationState } from "@/lib/publication-state";

type Context = { params: Promise<{ id: string }> };

// GET /api/packets/:id/publication-state — the owner's exact "Published" vs
// "Changes not published" answer. A failure to TELL is a 503, never a guess:
// the editor then claims neither.
export async function GET(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const state = await getPublicationState(createServerClient(), id, session.userId);
    if (!state) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[publication-state] could not compare", { packetId: id, error: (e as Error).message });
    return NextResponse.json({ error: "state_unavailable" }, { status: 503 });
  }
}
