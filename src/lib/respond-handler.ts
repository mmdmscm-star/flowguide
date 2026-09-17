import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getSession } from "@/lib/auth";
import { isPublicDemo } from "@/lib/public-demos";
import { parseResponseBody, RESPONSE_OUTCOME } from "@/lib/responses";
import { notifyOwnerOfResponse } from "@/lib/response-notify";

// SENDING THE PROFESSIONAL A MESSAGE — one implementation, two paths.
//
// The canonical path is POST /p/:slug/respond. /api/p/:slug/responses is the
// path bundles rendered before the move still call, and it delegates HERE
// rather than holding a second copy, so the two cannot drift apart while the
// old one is being retired.
//
// A MESSAGE IS CORRESPONDENCE. It is immutable once sent, it mints no
// capability, and it NEVER reads the capability cookie the browser may be
// carrying for this Sendset — even though the path scope means the browser
// sends it here too.
//
// IN THIS ORDER, and the order is the contract:
//   1. same-origin check                   — turns away a casual cross-site post
//   2. the body's shape, before any lookup — identical answer for every slug
//   3. the honeypot                        — answered as success, stored nowhere
//   4. a demo, or the owner themself       — refused before anything is written
//   5. record_sendset_response             — atomic: accepts, limits, stores
//   6. the owner's email, if due           — AFTER the response is stored
//
// PERSIST FIRST. The row is the durable copy; the email is a best-effort
// pointer to it. A send that fails, times out or throws changes nothing about
// the answer the responder gets, because their message is already safe.
//
// THE MARKER goes to the database exactly as the browser sent it. See
// MARKER_SHAPE in lib/responses.ts for why it is never touched on the way.
//
// NOTHING ABOUT THE REQUESTER IS READ OR KEPT — no IP, no capability, no
// identifier. Limits are counts, in the database.

const answer = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status });
const notAccepting = () => answer(404, { error: "not_accepting", message: RESPONSE_OUTCOME.notAccepting });

export async function handleRespond(request: Request, slug: string): Promise<NextResponse> {
  // 1. Not a security boundary; a filter for the ordinary cross-site case.
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return answer(403, { error: "cross_site", message: RESPONSE_OUTCOME.failed });
  const origin = request.headers.get("origin");
  if (!site && origin) {
    let sameHost = false;
    try { sameHost = new URL(origin).host === request.headers.get("host"); } catch { /* not a URL */ }
    if (!sameHost) return answer(403, { error: "cross_site", message: RESPONSE_OUTCOME.failed });
  }

  // 2. Shape first. Nothing below this line runs for a malformed request.
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const parsed = parseResponseBody(body);
  if (!parsed.ok) return answer(400, { error: "invalid", field: parsed.field, message: parsed.message });

  // 3. Indistinguishable from a real send, from the outside.
  if (parsed.honeypot) return answer(200, { ok: true, message: RESPONSE_OUTCOME.sent });

  // 4. A demo belongs to nobody, so there is nobody to send to.
  if (isPublicDemo(slug)) return notAccepting();

  const supabase = createServerClient();

  // The owner's own message is not a response. Only a signed-in visitor costs a
  // query; everyone else skips this.
  const session = await getSession();
  if (session) {
    const { data: owned } = await supabase
      .from("packets").select("id").eq("slug", slug).eq("user_id", session.userId).maybeSingle();
    if (owned) return answer(403, { error: "owner", message: RESPONSE_OUTCOME.owner });
  }

  // 5. The only write.
  const { data, error } = await supabase.rpc("record_sendset_response", {
    p_slug: slug,
    p_rendered_published_at: parsed.marker,
    p_responder_name: parsed.name,
    p_responder_contact: parsed.contact,
    p_note: parsed.message,
  });

  if (error) {
    if (error.code === "PT404") return notAccepting();
    if (error.code === "PT429") return answer(429, { error: "rate_limited", message: RESPONSE_OUTCOME.rateLimited });
    if (error.code === "PT400") {
      return error.details === "note_required"
        ? answer(400, { error: "invalid", field: "message", message: "Write a message." })
        : answer(400, { error: "invalid", field: "form", message: "This page is out of date. Reload it and send your message again." });
    }
    console.error("[responses] could not record a response", { code: error.code });
    return answer(500, { error: "failed", message: RESPONSE_OUTCOME.failed });
  }

  const stored = data as { responseId: string; ownerUserId: string; notificationDue: boolean };

  // 6. Stored. Now, and only now, the email.
  if (stored.notificationDue) {
    await notifyOwnerOfResponse(supabase, {
      responseId: stored.responseId,
      ownerUserId: stored.ownerUserId,
      name: parsed.name,
      contact: parsed.contact,
      message: parsed.message,
    });
  }

  return answer(200, { ok: true, message: RESPONSE_OUTCOME.sent });
}
