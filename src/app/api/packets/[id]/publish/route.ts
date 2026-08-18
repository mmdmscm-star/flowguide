import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { loadPacketOwnership } from "@/lib/ownership-service";

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
    // needs_review MUST be in this list. The trigger (0013) blocks publishing on
    // it, so leaving it out doesn't allow the publish — it just replaces this
    // sentence with raw Postgres text and gives the professional nothing to do.
    const { data: activeRun } = await supabase
      .from("ingestion_runs")
      .select("id, status, review")
      .eq("packet_id", id)
      .eq("user_id", session.userId)
      .in("status", ["active", "finalizing", "needs_review"])
      .maybeSingle();
    if (activeRun) {
      const run = activeRun as { id: string; status: string; review?: { summary?: string; exit?: string } | null };
      if (run.status === "needs_review") {
        const why = run.review?.summary?.trim();
        const exit = run.review?.exit?.trim() || "Discard the import to clear this review.";
        return NextResponse.json({
          error: "import_needs_review",
          runId: run.id,
          message: `${why ? why + " " : ""}${exit}`,
        }, { status: 409 });
      }
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

    // ---- Media ownership gate. RECOMPUTED, never read from a stored finding.
    //
    // This is the last check before the single UPDATE that publishes, and this
    // route is the only writer of status='published' in the codebase — verified,
    // not assumed. It cannot live in the DB trigger: the check needs
    // detectSourceRecords and segmentHash, which are TypeScript.
    //
    // FAIL-OPEN ON DECLINE, deliberately. A packet with no usable provenance —
    // imported before 0014, prose with no record structure, a source that was
    // replaced — yields no findings and publishes normally. Blocking there would
    // trap every historical packet behind a check that can never be satisfied.
    // Declines are logged so that "checked and clean" stays distinguishable from
    // "could not be checked".
    try {
      const ownership = await loadPacketOwnership(id, supabase);
      if (ownership.declines.length > 0) {
        console.warn("[publish] ownership not verifiable", { packetId: id, declines: ownership.declines });
      }
      if (ownership.blocking.length > 0) {
        console.error("[publish] blocked by ownership", { packetId: id, count: ownership.blocking.length });
        const n = ownership.blocking.length;
        return NextResponse.json({
          error: "ownership_unresolved",
          message: `${n} photo${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} on an item your source doesn't put ${n === 1 ? "it" : "them"} on. Move ${n === 1 ? "it" : "them"} or keep ${n === 1 ? "it" : "them"} where ${n === 1 ? "it is" : "they are"}, then publish.`,
          findings: ownership.blocking,
        }, { status: 409 });
      }
    } catch (e) {
      // A failure to CHECK must not become a failure to publish.
      console.error("[publish] ownership check threw:", e);
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
