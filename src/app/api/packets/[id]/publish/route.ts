import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

type Context = { params: Promise<{ id: string }> };

// POST /api/packets/:id/publish — publish or unpublish
export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const body = await request.json();
  const { action, skipProfileCheck } = body;
  const supabase = createServerClient();

  if (action === "publish") {
    // Validate the packet has required content
    const { data: packet } = await supabase
      .from("packets")
      .select("id, title")
      .eq("id", id)
      .eq("user_id", session.userId)
      .single();

    if (!packet) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!packet.title?.trim()) {
      return NextResponse.json({ error: "Packet needs a title" }, { status: 400 });
    }

    // Check for at least one section with a title
    const { data: sections } = await supabase
      .from("sections")
      .select("id, title")
      .eq("packet_id", id);

    if (!sections || sections.length === 0) {
      return NextResponse.json({ error: "Add at least one section" }, { status: 400 });
    }

    const untitledSection = sections.find((s) => !s.title?.trim());
    if (untitledSection) {
      return NextResponse.json({ error: "All sections need titles" }, { status: 400 });
    }

    // Check each section has at least one item with a title
    for (const section of sections) {
      const { data: items } = await supabase
        .from("items")
        .select("id, title")
        .eq("section_id", section.id);

      if (!items || items.length === 0) {
        return NextResponse.json(
          { error: `Section "${section.title}" needs at least one item` },
          { status: 400 }
        );
      }

      const untitledItem = items.find((i) => !i.title?.trim());
      if (untitledItem) {
        return NextResponse.json(
          { error: `All items in "${section.title}" need titles` },
          { status: 400 }
        );
      }
    }

    // Fetch professional profile for validation and snapshot
    const { data: profile } = await supabase
      .from("professional_profiles")
      .select("name, email, phone, business_name, logo_url, website_url")
      .eq("user_id", session.userId)
      .single();

    if (!skipProfileCheck) {
      if (!profile?.name?.trim()) {
        return NextResponse.json(
          { error: "no_profile", message: "No professional contact information" },
          { status: 422 }
        );
      }

      if (!profile.email?.trim() && !profile.phone?.trim()) {
        return NextResponse.json(
          { error: "no_contact", message: "No email or phone in professional contact" },
          { status: 422 }
        );
      }
    }

    // Snapshot: empty object if skipped (no branding), full profile otherwise
    const professionalSnapshot = skipProfileCheck ? {} : {
      name: profile?.name || "",
      email: profile?.email || "",
      phone: profile?.phone || "",
      businessName: profile?.business_name || "",
      logoUrl: profile?.logo_url || "",
      websiteUrl: profile?.website_url || "",
    };

    const { error } = await supabase
      .from("packets")
      .update({
        status: "published",
        published_at: new Date().toISOString(),
        professional_snapshot: professionalSnapshot,
      })
      .eq("id", id)
      .eq("user_id", session.userId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Get the slug for the response
    const { data: updated } = await supabase
      .from("packets")
      .select("slug")
      .eq("id", id)
      .single();

    return NextResponse.json({ ok: true, slug: updated?.slug });
  }

  if (action === "unpublish") {
    const { error } = await supabase
      .from("packets")
      .update({ status: "draft" })
      .eq("id", id)
      .eq("user_id", session.userId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
