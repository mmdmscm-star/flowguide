import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { loadOwnerResponses } from "@/lib/owner-responses";

// GET /api/packets/:id/responses — the owner's responses on one Sendset.
//
// Owner only. A Sendset that does not exist and one that belongs to someone
// else get the same 404.
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  try {
    const loaded = await loadOwnerResponses(id, session.userId);
    if (!loaded) {
      return NextResponse.json({
        error: "not_found",
        message: "This Sendset no longer exists, or you no longer have access to it.",
      }, { status: 404 });
    }
    return NextResponse.json({ count: loaded.responses.length, responses: loaded.responses });
  } catch {
    return NextResponse.json({ error: "read_failed", message: "Could not load responses. Try again." }, { status: 500 });
  }
}
