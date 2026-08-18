import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

type Context = { params: Promise<{ id: string }> };

// The packet's CURRENT items, for bulk promotion.
//
// Current state, not an import's output: if the professional corrected an
// address after importing, the Library should get the corrected one. This route
// therefore reads `items` directly and has no knowledge of runs at all.
export async function GET(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const supabase = createServerClient();

  const { data: packet } = await supabase
    .from("packets").select("id").eq("id", id).eq("user_id", session.userId).maybeSingle();
  if (!packet) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { data: sections } = await supabase.from("sections").select("id").eq("packet_id", id);
  const sectionIds = (sections ?? []).map((s: { id: string }) => s.id);
  if (sectionIds.length === 0) return NextResponse.json({ items: [] });

  const { data: items, error } = await supabase
    .from("items").select("id, title, library_item_id, sort_order")
    .in("section_id", sectionIds).order("sort_order");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    items: (items ?? []).map((i: Record<string, unknown>) => ({
      id: i.id, title: i.title, libraryItemId: i.library_item_id ?? null,
    })),
  });
}
