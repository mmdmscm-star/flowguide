import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { getPublishedPacket } from "@/lib/queries";
import { renderPacketEmail, renderPacketEmailText } from "@/lib/email-render";

type Context = { params: Promise<{ id: string }> };

// GET /api/packets/:id/email — the email-ready rendering of this packet.
//
// It loads through getPublishedPacket, the SAME function the live recipient
// page uses, so the email cannot drift from what a client sees online: one
// query, one packet, two renderings. Nothing is stored - the HTML is built on
// demand and thrown away, because a persisted copy is a second source of truth
// that goes stale the moment the packet changes.
export async function GET(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const supabase = createServerClient();

  const { data: packetRow } = await supabase
    .from("packets")
    .select("slug, status, composition_mode")
    .eq("id", id)
    .eq("user_id", session.userId)
    .maybeSingle();
  if (!packetRow) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const row = packetRow as { slug: string; status: string; composition_mode: string | null };
  if (row.status !== "published") {
    // The email carries the live link, and an unpublished packet has nothing to
    // link to. Publishing first is the honest order.
    return NextResponse.json({
      error: "not_published",
      message: "Publish this FlowGuide first — the email includes a link to the live version.",
    }, { status: 409 });
  }
  // Block-mode packets render through a different component tree entirely and
  // are not covered by this renderer. One prototype packet uses it; emitting
  // something half-right would be worse than saying no.
  if (row.composition_mode === "blocks") {
    return NextResponse.json({
      error: "unsupported_composition",
      message: "An email version isn't available for block-composed FlowGuides yet.",
    }, { status: 409 });
  }

  const packet = await getPublishedPacket(row.slug);
  if (!packet) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const origin = new URL(_request.url).origin;
  const liveUrl = `${origin}/p/${row.slug}`;

  return NextResponse.json({
    ok: true,
    html: renderPacketEmail(packet, { liveUrl }),
    text: renderPacketEmailText(packet, { liveUrl }),
  });
}
