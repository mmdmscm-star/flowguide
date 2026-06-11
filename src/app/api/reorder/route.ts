import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

// POST /api/reorder — reorder sections or items
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { type, orderedIds } = body; // type: "sections" | "items"

  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return NextResponse.json({ error: "orderedIds required" }, { status: 400 });
  }

  const supabase = createServerClient();
  const table = type === "sections" ? "sections" : "items";

  // Update sort_order for each item
  const updates = orderedIds.map((id: string, index: number) =>
    supabase.from(table).update({ sort_order: index }).eq("id", id)
  );

  await Promise.all(updates);

  return NextResponse.json({ ok: true });
}
