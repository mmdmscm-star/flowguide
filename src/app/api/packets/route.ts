import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { generateSlug } from "@/lib/slug";

// GET /api/packets — list all packets for the current user
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createServerClient();
  const { data: packets, error } = await supabase
    .from("packets")
    .select("id, slug, title, client_name, status, viewed, created_at, updated_at")
    .eq("user_id", session.userId)
    .order("updated_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ packets });
}

// POST /api/packets — create a new packet
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { title, clientName, packetType } = body;

  const supabase = createServerClient();

  // Generate unique slug
  let slug = generateSlug();
  let attempts = 0;
  while (attempts < 5) {
    const { data: existing } = await supabase
      .from("packets")
      .select("id")
      .eq("slug", slug)
      .single();
    if (!existing) break;
    slug = generateSlug();
    attempts++;
  }

  const { data: packet, error } = await supabase
    .from("packets")
    .insert({
      user_id: session.userId,
      slug,
      title: title || "",
      client_name: clientName || "",
      packet_type: packetType || "general",
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ packet }, { status: 201 });
}
