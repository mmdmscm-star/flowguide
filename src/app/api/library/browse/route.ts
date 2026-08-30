import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { browseLibrary, libraryVocabulary } from "@/lib/library-service";

// GET /api/library/browse?per=6 — the Library, structured, in ONE response.
//
// Sections and their groups, each with a first page of items, plus the
// unorganized remainder. One round trip and one loading state, because the
// alternative — a request per container from the browser — makes the Library
// assemble itself in front of the professional a piece at a time.
//
// Sections and groups are read WHOLE rather than paged. They are few by nature:
// a professional names the handful of kinds of thing they keep. That is a
// deliberate bet and not a hidden cap — if one ever had hundreds, that is a
// finding worth acting on rather than a limit to quietly impose here.
//
// Long containers do not become their own screen. They expand in place through
// the ordinary paged list at /api/library, which is why this returns each
// container's cursor and total alongside its first page.
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const per = Math.min(Math.max(Number(new URL(request.url).searchParams.get("per")) || 6, 1), 50);
  const supabase = createServerClient();

  const [browse, vocabulary] = await Promise.all([
    browseLibrary(supabase, session.userId, per),
    libraryVocabulary(supabase, session.userId),
  ]);

  return NextResponse.json({ ...browse, vocabulary });
}
