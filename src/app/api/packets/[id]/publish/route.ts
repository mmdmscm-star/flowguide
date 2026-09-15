import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { loadPacketOwnership } from "@/lib/ownership-service";
import { identityGap, IDENTITY_GAP_MESSAGE } from "@/lib/professional-identity";
import { BLOCKING_RUN_FILTER } from "@/lib/import-blocking";
import { buildPublicationSnapshot, PUBLICATION_FORMAT_VERSION } from "@/lib/queries";

type Context = { params: Promise<{ id: string }> };
type Db = ReturnType<typeof createServerClient>;

// THE MESSAGE FOR A PUBLISH THAT LOST A RACE. publish_packet refuses when
// anything the gates read changed after the route read its token.
export const CHANGED_WHILE_PUBLISHING = "This Sendset changed while publishing. Try again.";

// The import gate, as one function: it runs before the other gates, and again
// to explain a refusal publish_packet makes when an import started blocking in
// between. Same codes, same sentences, either way.
async function importGate(supabase: Db, packetId: string, userId: string): Promise<NextResponse | null> {
  // Reject publishing while an import is in progress (server-side, not just the
  // UI). The DB trigger (migration 0012) is the hard guard; this returns a clear
  // message before hitting it.
  // needs_review MUST be in this list. The trigger (0013) blocks publishing on
  // it, so leaving it out doesn't allow the publish — it just replaces this
  // sentence with raw Postgres text and gives the professional nothing to do.
  //
  // A finalized run whose review is still PENDING blocks too (0051): its
  // content is applied but nobody has decided whether it needs review yet.
  // The filter is the one shared definition in lib/import-blocking.
  //
  // A FAILED READ REFUSES. This query used to ignore its error, so a
  // database hiccup read as "no import in the way" and let the publish on.
  const { data: activeRun, error: activeRunErr } = await supabase
    .from("ingestion_runs")
    .select("id, status, review")
    .eq("packet_id", packetId)
    .eq("user_id", userId)
    .or(BLOCKING_RUN_FILTER)
    .maybeSingle();
  if (activeRunErr) {
    console.error("[publish] import gate could not be checked:", activeRunErr.message);
    return NextResponse.json({ error: "import_check_unavailable", message: "Couldn't check this Sendset's imports. Try again in a moment." }, { status: 503 });
  }
  if (activeRun) {
    const run = activeRun as { id: string; status: string; review?: { summary?: string; exit?: string } | null };
    if (run.status === "finalized") {
      return NextResponse.json({
        error: "import_finishing",
        runId: run.id,
        message: "Sendset is still checking the import. Try again in a moment.",
      }, { status: 409 });
    }
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
  return null;
}

// POST /api/packets/:id/publish — publish or unpublish
export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const body = await request.json();
  const { action, skipProfileCheck } = body;
  const supabase = createServerClient();

  if (action === "publish") {
    // THE TOKEN COMES FIRST. It records everything the gates below are about to
    // read; publish_packet recomputes it under the Sendset's lock and refuses if
    // anything changed in between, so the verdict of every gate is bound to what
    // is actually published (0052).
    const { data: publishToken, error: tokenErr } = await supabase.rpc("packet_publish_token", {
      p_owner: session.userId,
      p_packet_id: id,
    });
    if (tokenErr) {
      console.error("[publish] could not read the publish token:", tokenErr.message);
      return NextResponse.json({ error: "publish_unavailable", message: "Couldn't start publishing. Try again in a moment." }, { status: 503 });
    }
    if (!publishToken) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const importRefusal = await importGate(supabase, id, session.userId);
    if (importRefusal) return importRefusal;

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
    //
    // The rule itself lives in lib/professional-identity so the dashboard's
    // first-run prompt asks the SAME question. Same codes, same messages, same
    // behaviour as before — what changed is that there is now one copy of it,
    // and onboarding cannot tell a professional they are ready while this route
    // refuses them.
    if (!skipProfileCheck) {
      const gap = identityGap(contact);
      if (gap) {
        return NextResponse.json(
          { error: gap, message: IDENTITY_GAP_MESSAGE[gap] },
          { status: 422 }
        );
      }
    }

    // ---- Media ownership gate. RECOMPUTED, never read from a stored finding.
    //
    // This is the last check before publish_packet, and this route is the only
    // caller of publish_packet in server code — asserted by
    // ownership-route.test.mts, not assumed. It cannot live in the database: the
    // check needs detectSourceRecords and segmentHash, which are TypeScript. What
    // the database does instead is refuse to publish anything but the inputs this
    // check read, via the token read at the top of this handler.
    //
    // THREE OUTCOMES, AND THEY ARE NOT INTERCHANGEABLE:
    //
    //   declined    — the check RAN and could not establish ownership: no
    //                 provenance, a replaced source, prose, incomplete
    //                 correspondence. Nonblocking by design, because blocking
    //                 there traps every historical packet behind a check it can
    //                 never satisfy. Logged, so "checked and clean" stays
    //                 distinguishable from "could not be checked".
    //
    //   blocking    — the check ran and found photos the source puts elsewhere.
    //                 409, with the findings and a way to resolve them.
    //
    //   unavailable — the check DID NOT RUN. 503, retryable. This is the case
    //                 that must never be mistaken for a pass: publishing here
    //                 would be publishing on the strength of a check that never
    //                 happened, and blaming the professional would be accusing
    //                 them on the same absent evidence.
    let ownership;
    try {
      ownership = await loadPacketOwnership(id, supabase);
    } catch (e) {
      // A throw is a failure to CHECK, which is exactly the unavailable case.
      // It must not become a silent pass, and it must not become a blame.
      console.error("[publish] ownership check threw", { packetId: id, error: e });
      return NextResponse.json({
        error: "ownership_unavailable",
        retryable: true,
        message: "Photo checks are temporarily unavailable, so this packet wasn't published. Try again in a moment.",
      }, { status: 503 });
    }

    if (ownership.unavailable) {
      console.error("[publish] ownership verification unavailable", {
        packetId: id, source: ownership.unavailable.source, detail: ownership.unavailable.detail,
      });
      return NextResponse.json({
        error: "ownership_unavailable",
        retryable: true,
        message: "Photo checks are temporarily unavailable, so this packet wasn't published. Try again in a moment.",
      }, { status: 503 });
    }

    if (ownership.declines.length > 0) {
      console.warn("[publish] ownership not establishable", { packetId: id, declines: ownership.declines });
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

    // ---- The frozen copy, then the one atomic write.
    //
    // Built from the working rows through the same assembly the recipient page
    // uses, with the identity being frozen into professional_snapshot. A failed
    // read throws rather than freezing an absence.
    let snapshot;
    try {
      snapshot = await buildPublicationSnapshot(supabase, id, professionalSnapshot);
    } catch (e) {
      console.error("[publish] could not build the publication snapshot", { packetId: id, error: e });
      return NextResponse.json({ error: "publish_unavailable", message: "Couldn't prepare this Sendset for publishing. Try again in a moment." }, { status: 503 });
    }

    const { data: published, error: publishErr } = await supabase.rpc("publish_packet", {
      p_owner: session.userId,
      p_packet_id: id,
      p_expected_token: publishToken,
      p_format_version: PUBLICATION_FORMAT_VERSION,
      p_content: snapshot,
      p_professional_snapshot: professionalSnapshot,
    });

    if (publishErr) {
      // Every refusal leaves the existing publication exactly as it was. Map each
      // one deliberately; the database's own words never reach the professional.
      const detail = (publishErr as { details?: string | null }).details;
      if (publishErr.code === "PT409" && detail === "changed") {
        return NextResponse.json({ error: "changed_while_publishing", message: CHANGED_WHILE_PUBLISHING }, { status: 409 });
      }
      if (publishErr.code === "PT409" && detail === "import_blocks") {
        const refusal = await importGate(supabase, id, session.userId);
        return refusal ?? NextResponse.json({ error: "import_in_progress", message: "An import is still in progress. Finish or discard it before publishing." }, { status: 409 });
      }
      if (publishErr.code === "PT400" && detail === "title_required") {
        return NextResponse.json({ error: "Packet needs a title" }, { status: 400 });
      }
      if (publishErr.code === "PT404") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      // invalid_snapshot is our defect, not the professional's; anything else is
      // unexpected. Neither publishes, and both are logged in full.
      console.error("[publish] publish_packet refused", { packetId: id, code: publishErr.code, detail, message: publishErr.message });
      return NextResponse.json({ error: "publish_failed", message: "Couldn't publish this Sendset. Please try again." }, { status: 500 });
    }

    return NextResponse.json({ ok: true, slug: (published as { slug?: string } | null)?.slug });
  }

  if (action === "unpublish") {
    // The frozen copy goes with the status, under the Sendset's lock (0052).
    const { error: unpublishErr } = await supabase.rpc("unpublish_packet", {
      p_owner: session.userId,
      p_packet_id: id,
    });
    if (unpublishErr) {
      if (unpublishErr.code === "PT404") return NextResponse.json({ error: "Not found" }, { status: 404 });
      console.error("[unpublish] unpublish_packet failed", { packetId: id, code: unpublishErr.code, message: unpublishErr.message });
      return NextResponse.json({ error: "unpublish_failed", message: "Couldn't unpublish this Sendset. Please try again." }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
