import { NextResponse } from "next/server";
import { TREATMENT_NAMES } from "@/lib/style/treatment";
import { packetMapUrl } from "@/lib/maps-url";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { parseResponseActions } from "@/lib/response-actions";

type Context = { params: Promise<{ id: string }> };

// GET /api/packets/:id — get full packet data for editor
export async function GET(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const supabase = createServerClient();

  const { data: packet, error } = await supabase
    .from("packets")
    .select("*")
    .eq("id", id)
    .eq("user_id", session.userId)
    .single();

  if (error || !packet) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Fetch professional profile
  const { data: profile } = await supabase
    .from("professional_profiles")
    .select("*")
    .eq("user_id", session.userId)
    .single();

  // Fetch sections
  const { data: sections } = await supabase
    .from("sections")
    .select("*")
    .eq("packet_id", id)
    .order("sort_order");

  const sectionIds = (sections || []).map((s) => s.id);

  // Fetch items
  const { data: items } = sectionIds.length > 0
    ? await supabase.from("items").select("*").in("section_id", sectionIds).order("sort_order")
    : { data: [] };

  const itemIds = (items || []).map((i) => i.id);

  // Fetch sub-fields
  const [photosRes, linksRes, detailsRes, contactsRes] = itemIds.length > 0
    ? await Promise.all([
        supabase.from("item_photos").select("*").in("item_id", itemIds).order("sort_order"),
        supabase.from("item_links").select("*").in("item_id", itemIds).order("sort_order"),
        supabase.from("item_details").select("*").in("item_id", itemIds).order("sort_order"),
        supabase.from("item_contacts").select("*").in("item_id", itemIds),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];

  return NextResponse.json({
    packet,
    profile: profile || null,
    sections: sections || [],
    items: items || [],
    photos: photosRes.data || [],
    links: linksRes.data || [],
    details: detailsRes.data || [],
    contacts: contactsRes.data || [],
  });
}

// PATCH /api/packets/:id — update packet fields
export async function PATCH(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const body = await request.json();
  const supabase = createServerClient();

  // Only allow updating specific fields
  const allowed: Record<string, string> = {
    // The internal name. Required to publish, never shown to a recipient.
    title: "title",
    // The optional heading a recipient sees; blank omits it. Deliberately NOT
    // in ingest_bump_packet_self's tuple, so editing it cannot abort an import.
    clientTitle: "client_title",
    clientName: "client_name",
    personalNote: "personal_note",
    mapUrl: "map_url",
    identityMode: "identity_mode",
    // Presentation only (0030). Deliberately not part of the content_rev list.
    showQuickNav: "show_quick_nav",
    // Presentation only (0049), same contract: live after publish, no republish,
    // outside content_rev, never frozen into professional_snapshot.
    styleTreatment: "style_treatment",
  };

  const updates: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(allowed)) {
    if (key in body) updates[col] = body[key];
  }

  // Packet-level identity override (jsonb). null clears it.
  if ("customIdentity" in body) {
    updates["custom_identity"] = body.customIdentity;
  }

  if ("identityMode" in body && !["default", "none", "custom"].includes(body.identityMode)) {
    return NextResponse.json({ error: "Invalid identity_mode" }, { status: 400 });
  }

  // THE SAME RULE THE RENDERERS APPLY, so a link that saves is a link that
  // shows. Before this, any string was stored and the professional found out
  // it was not a usable link only by looking at five renderers disagreeing
  // about it — or, on paper, by not looking at all.
  //
  // "" is allowed and CLEARS the field: removing a map link is a legitimate
  // edit, and both editors send the empty box verbatim to do it.
  //
  // NOT provider validation. Any absolute http(s) URL is accepted whatever the
  // host; this only refuses values a recipient's browser could not follow.
  //
  // Existing rows are untouched. This governs writes from today onward — a row
  // already holding something odd keeps it, and simply renders nothing.
  if ("mapUrl" in body) {
    const raw = body.mapUrl;
    const blank = typeof raw === "string" && raw.trim() === "";
    if (!blank && (typeof raw !== "string" || !packetMapUrl(raw))) {
      return NextResponse.json({
        error: "invalid_map_url",
        message: "A map link must be a full web address starting with http:// or https:// — or empty to remove it.",
      }, { status: 400 });
    }
  }

  // The column is NOT NULL, so a non-boolean here would fail at the database
  // with a message no professional could act on.
  if ("showQuickNav" in body && typeof body.showQuickNav !== "boolean") {
    return NextResponse.json({ error: "Invalid show_quick_nav" }, { status: 400 });
  }

  // THE ALLOWED VALUES COME FROM THE TREATMENT REGISTRY, not from a list typed
  // out again here. A list written twice is a list that will disagree, and the
  // database's CHECK constraint (0049) is the third copy this must never drift
  // from. Rejected here rather than at the constraint, so the message says
  // something a professional could act on instead of a Postgres error code.
  if ("styleTreatment" in body) {
    if (typeof body.styleTreatment !== "string"
        || !TREATMENT_NAMES.includes(body.styleTreatment)) {
      return NextResponse.json({
        error: "invalid_style_treatment",
        message: `Unknown treatment. Choose one of: ${TREATMENT_NAMES.join(", ")}.`,
      }, { status: 400 });
    }
  }

  // RECIPIENT RESPONSES (0058). Validated against the one shared list, which the
  // database's CHECK mirrors, so a bad value gets a sentence rather than a
  // Postgres error. Written straight to the Sendset: it is not part of the
  // frozen publication, so the change is live on the next request.
  if ("responseActions" in body) {
    const parsed = parseResponseActions(body.responseActions);
    if (parsed === null) {
      return NextResponse.json({
        error: "invalid_response_actions",
        message: "Responses can only be turned on or off.",
      }, { status: 400 });
    }
    updates["response_actions"] = parsed;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  const { error } = await supabase
    .from("packets")
    .update(updates)
    .eq("id", id)
    .eq("user_id", session.userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

// DELETE /api/packets/:id?acknowledgedResponses=N — delete a packet
//
// THROUGH delete_sendset (0058), NEVER A PLAIN DELETE. A Sendset's responses are
// other people's words, and the database refuses to drop them as a side effect:
// both foreign keys into sendset_responses are ON DELETE RESTRICT. delete_sendset
// is the one path that can remove them, and only when the caller acknowledges
// EXACTLY the number that exists — checked under a row lock that also holds off
// any response still arriving. So a creator who was shown "2 responses" cannot
// destroy a third that landed after the confirmation was drawn.
//
// `acknowledgedResponses` is the count the creator was shown. Absent means none
// were shown, which is right for a Sendset without responses and refused (409)
// for one with them.
export async function DELETE(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;

  const raw = new URL(request.url).searchParams.get("acknowledgedResponses");
  let acknowledged: number | null = null;
  if (raw !== null) {
    if (!/^\d{1,9}$/.test(raw)) {
      return NextResponse.json({
        error: "invalid_acknowledgement",
        message: "Could not delete this Sendset. Reload the page and try again.",
      }, { status: 400 });
    }
    acknowledged = Number(raw);
  }

  const supabase = createServerClient();
  const { error } = await supabase.rpc("delete_sendset", {
    p_owner: session.userId,
    p_packet_id: id,
    p_acknowledged_responses: acknowledged,
  });

  if (error) {
    // ONE ANSWER FOR TWO CASES, deliberately. A packet that does not exist and
    // a packet belonging to someone else are indistinguishable here, because
    // delete_sendset finds neither with the same owner-scoped lookup. Telling
    // them apart would leak whether a stranger's packet id is real.
    //
    // A malformed id is the same case: it names no Sendset of yours.
    if (error.code === "PT404" || error.code === "22P02") {
      return NextResponse.json({
        error: "not_found",
        message: "This Sendset no longer exists, or you no longer have access to it.",
      }, { status: 404 });
    }
    // The count moved between the confirmation and the click. Nothing was
    // deleted. `responses` is the true count, so the caller can ask again with
    // the right number — after the creator has seen it.
    if (error.code === "PT409" && error.details === "responses_changed") {
      const responses = Number(error.hint);
      return NextResponse.json({
        error: "responses_changed",
        message: "A response arrived since you confirmed. Nothing was deleted.",
        responses: Number.isInteger(responses) ? responses : null,
      }, { status: 409 });
    }
    console.error("[delete] delete_sendset failed", { code: error.code });
    return NextResponse.json({ error: "delete_failed", message: "Could not delete this Sendset. Try again." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
