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
    // Reject publishing while an import is in progress (server-side, not just the
    // UI). The DB trigger (migration 0012) is the hard guard; this returns a clear
    // message before hitting it.
    const { data: activeRun } = await supabase
      .from("ingestion_runs")
      .select("id")
      .eq("packet_id", id)
      .eq("user_id", session.userId)
      .in("status", ["active", "finalizing"])
      .maybeSingle();
    if (activeRun) {
      return NextResponse.json({ error: "import_in_progress", message: "An import is still in progress. Finish or discard it before publishing." }, { status: 409 });
    }

    // Validate the packet has required content
    const { data: packet } = await supabase
      .from("packets")
      .select("id, title, identity_mode, custom_identity, composition_mode")
      .eq("id", id)
      .eq("user_id", session.userId)
      .single();

    if (!packet) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!packet.title?.trim()) {
      return NextResponse.json({ error: "Packet needs a title" }, { status: 400 });
    }

    // Content validation branches on composition mode. Legacy packets keep the
    // exact section-based validation; block packets validate their ordered block
    // body instead. Headings/subheadings/labels are optional in a block packet —
    // only Item blocks carry required content.
    if (packet.composition_mode === "blocks") {
      const { data: blocks } = await supabase
        .from("packet_blocks")
        .select("id, block_type, item_id")
        .eq("packet_id", id);

      const itemBlocks = (blocks || []).filter((b) => b.block_type === "item");
      if (itemBlocks.length === 0) {
        return NextResponse.json(
          { error: "Add at least one item" },
          { status: 400 }
        );
      }

      // Every item block must reference an existing item with a title.
      const itemIds = itemBlocks.map((b) => b.item_id).filter(Boolean) as string[];
      const { data: items } = await supabase
        .from("items")
        .select("id, title")
        .in("id", itemIds);

      const itemsById = new Map((items || []).map((i) => [i.id, i]));
      for (const b of itemBlocks) {
        const item = b.item_id ? itemsById.get(b.item_id) : undefined;
        if (!item || !item.title?.trim()) {
          return NextResponse.json(
            { error: "All items need titles" },
            { status: 400 }
          );
        }
      }

      // Enforce the block/item bijection + dense positions before publishing.
      const { error: consistencyError } = await supabase.rpc(
        "assert_packet_block_consistency",
        { p_packet_id: id }
      );
      if (consistencyError) {
        return NextResponse.json(
          { error: "Block composition is inconsistent; cannot publish" },
          { status: 400 }
        );
      }
    } else {
      // Check for at least one section with a title
      const { data: sections } = await supabase
        .from("sections")
        .select("id, title")
        .eq("packet_id", id);

      if (!sections || sections.length === 0) {
        return NextResponse.json({ error: "Add at least one section" }, { status: 400 });
      }

      // Section titles are optional — a section can be a simple grouping container.
      // Check each section has at least one item with a title
      for (const section of sections) {
        const hasTitle = !!section.title?.trim();
        const sectionRef = hasTitle ? `Section "${section.title}"` : "A section";
        const sectionRefIn = hasTitle ? `"${section.title}"` : "this section";

        const { data: items } = await supabase
          .from("items")
          .select("id, title")
          .eq("section_id", section.id);

        if (!items || items.length === 0) {
          return NextResponse.json(
            { error: `${sectionRef} needs at least one item` },
            { status: 400 }
          );
        }

        const untitledItem = items.find((i) => !i.title?.trim());
        if (untitledItem) {
          return NextResponse.json(
            { error: `All items in ${sectionRefIn} need titles` },
            { status: 400 }
          );
        }
      }
    }

    // Resolve which identity this packet presents, honoring its identity_mode.
    // 'default' snapshots the account profile (existing behavior), 'none' shows
    // no branding, 'custom' snapshots the packet-specific identity. Whatever we
    // resolve is frozen into professional_snapshot, so the recipient render path
    // stays a single source: it always reads the snapshot.
    const mode: string = packet.identity_mode || "default";

    let professionalSnapshot: Record<string, unknown>;
    let contact: { name?: string; email?: string; phone?: string } | null = null;

    if (mode === "none") {
      professionalSnapshot = {};
    } else if (mode === "custom") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (packet.custom_identity || {}) as Record<string, any>;
      professionalSnapshot = {
        name: c.name || "",
        email: c.email || "",
        phone: c.phone || "",
        businessName: c.businessName || "",
        logoUrl: c.logoUrl || "",
        headshotUrl: c.headshotUrl || "",
        footerLabel: c.footerLabel || "",
        websiteUrl: c.websiteUrl || "",
        links: Array.isArray(c.links) ? c.links : [],
      };
      contact = { name: c.name, email: c.email, phone: c.phone };
    } else {
      const { data: profile } = await supabase
        .from("professional_profiles")
        .select("name, email, phone, business_name, logo_url, headshot_url, footer_label, website_url, links")
        .eq("user_id", session.userId)
        .single();
      // Preserve existing behavior: skipping the check publishes with no branding.
      professionalSnapshot = skipProfileCheck ? {} : {
        name: profile?.name || "",
        email: profile?.email || "",
        phone: profile?.phone || "",
        businessName: profile?.business_name || "",
        logoUrl: profile?.logo_url || "",
        headshotUrl: profile?.headshot_url || "",
        footerLabel: profile?.footer_label ?? "Your Advisor",
        websiteUrl: profile?.website_url || "",
        links: profile?.links || [],
      };
      contact = { name: profile?.name, email: profile?.email, phone: profile?.phone };
    }

    // Validate contact info unless the user chose to skip (or the packet
    // intentionally has no identity). Applies to whichever identity is presented.
    if (!skipProfileCheck && contact) {
      if (!contact.name?.trim()) {
        return NextResponse.json(
          { error: "no_profile", message: "No professional contact information" },
          { status: 422 }
        );
      }

      if (!contact.email?.trim() && !contact.phone?.trim()) {
        return NextResponse.json(
          { error: "no_contact", message: "No email or phone in professional contact" },
          { status: 422 }
        );
      }
    }

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
