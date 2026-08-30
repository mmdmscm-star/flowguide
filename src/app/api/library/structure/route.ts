import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { renameStructure, readStructure } from "@/lib/library-service";

// PATCH /api/library/structure — rename one section or one group.
//
//   { kind: "section" | "group", id, name }
//
// A HEADING THE PROFESSIONAL WROTE, CORRECTABLE. Sections and groups are named
// inline while filing, which means they are named in a hurry — so getting one
// slightly wrong has to be fixable in place rather than by emptying it and
// starting again.
//
// THE NAME AND NOTHING ELSE. This route cannot move an item, reorder anything,
// touch a label or a star, or reach any content. It writes one text column.
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { kind, id, name } = body as { kind?: string; id?: string; name?: string };

  if (kind !== "section" && kind !== "group") {
    return NextResponse.json({ error: "bad_request", message: "Unknown thing to rename." }, { status: 400 });
  }
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "bad_request", message: "Nothing to rename." }, { status: 400 });
  }

  const supabase = createServerClient();
  const { error } = await renameStructure(supabase, session.userId, kind, id, String(name ?? ""));

  if (error === "blank_name") {
    return NextResponse.json({ error: "bad_request", message: "Give it a name." }, { status: 400 });
  }
  if (error === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (error === "duplicate_name") {
    // Said in the professional's terms: they already have one of these, and the
    // two would be indistinguishable in the list.
    return NextResponse.json({
      error: "duplicate_name",
      message: kind === "section"
        ? "You already have a section with that name."
        : "That section already has a group with that name.",
    }, { status: 409 });
  }
  if (error) {
    console.error(`[library-structure] ${error}`);
    return NextResponse.json(
      { error: "rename_failed", message: "Could not rename that. Nothing was changed." }, { status: 400 });
  }

  return NextResponse.json({ structure: await readStructure(supabase, session.userId) });
}
