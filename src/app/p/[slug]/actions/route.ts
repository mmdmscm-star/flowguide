import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getSession } from "@/lib/auth";
import { isPublicDemo } from "@/lib/public-demos";
import { ACTION_HEADER, ACTION_OUTCOME, NO_ACTIONS, parseActionRequest, type MyActions } from "@/lib/item-actions";
import {
  capabilityFromRequest, clearCapabilityCookie, mintCapability, setCapabilityCookie,
} from "@/lib/capability";

// /p/:slug/actions — one browser's own hearts on one Sendset.
//
//   GET   what this capability itself hearted. Its own lines and nothing else:
//         no counts, no other submissions, no sign that anybody else responded.
//   POST  set / clear ONE heart, or forget the capability entirely.
//
// UNDER THE SENDSET'S OWN PATH so the capability cookie — scoped to
// /p/:slug — reaches it and reaches nothing else.
//
// ONE TARGET PER CALL. There is no shape in this route that could express
// "these are all my hearts", so a client that cannot render a heart it holds
// cannot delete it by leaving it out.
//
// THE CAPABILITY IS NEVER IN A RESPONSE. The raw token exists in exactly one
// place — the Set-Cookie header of the request that minted it. It is never in a
// body, never in a log, never in a URL, and the database only ever sees its
// SHA-256.
//
// NOTHING IDENTIFYING IS READ: no IP, no user agent, no fingerprint. The only
// thing consulted about the requester is the capability they present, and the
// only thing stored about the request is a counter that is overwritten in place.

type Context = { params: Promise<{ slug: string }> };

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status });
const notAccepting = () => json(404, { error: "not_accepting", message: ACTION_OUTCOME.notAccepting });

/** Not a security boundary; a filter for the ordinary cross-site case. The
 *  custom header below is what actually closes forgery. */
function crossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return true;
  const origin = request.headers.get("origin");
  if (!site && origin) {
    try { return new URL(origin).host !== request.headers.get("host"); } catch { return true; }
  }
  return false;
}

export async function GET(request: Request, context: Context) {
  const { slug } = await context.params;
  const empty = () => NextResponse.json(NO_ACTIONS, { status: 200, headers: { "Cache-Control": "no-store" } });

  // A demo belongs to nobody; there is nothing to have hearted.
  if (isPublicDemo(slug)) return empty();
  const hash = capabilityFromRequest(request);
  if (!hash) return empty();

  const supabase = createServerClient();
  const { data, error } = await supabase.rpc("read_sendset_session_actions", {
    p_slug: slug,
    p_session_hash: hash,
  });
  if (error) {
    console.error("[actions] could not read a capability's own actions", { code: error.code });
    return empty();
  }
  // DELIBERATELY NOT GATED ON THE CREATOR'S SWITCH (0059): what somebody
  // already said stays visible to them, and they can still withdraw it.
  return NextResponse.json((data as MyActions) ?? NO_ACTIONS, { status: 200, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, context: Context) {
  const { slug } = await context.params;

  if (crossSite(request)) return json(403, { error: "cross_site", message: ACTION_OUTCOME.failed });
  // A cross-site page cannot send this without a CORS preflight this app never
  // grants, so a forged mutation cannot reach the capability the browser holds.
  if (request.headers.get(ACTION_HEADER) !== "1") {
    return json(403, { error: "missing_header", message: ACTION_OUTCOME.failed });
  }

  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const parsed = parseActionRequest(body);
  if (!parsed.ok) return json(400, { error: "invalid", field: parsed.field, message: parsed.message });

  // NOT YOU? The browser's handle is dropped and NO STORED ROW CHANGES: the
  // submission it held stays exactly as it is, under its own signature. The
  // next heart mints a new capability and a new submission.
  if (parsed.op === "forget") {
    const res = json(200, { ok: true, forgotten: true, ...NO_ACTIONS });
    clearCapabilityCookie(res, slug);
    return res;
  }

  if (isPublicDemo(slug)) return notAccepting();

  const supabase = createServerClient();

  // The owner's own hearts are not responses, consistent with the view counter
  // and the message endpoint. Only a signed-in visitor costs a query.
  const session = await getSession();
  if (session) {
    const { data: owned } = await supabase
      .from("packets").select("id").eq("slug", slug).eq("user_id", session.userId).maybeSingle();
    if (owned) return json(403, { error: "owner", message: ACTION_OUTCOME.notAccepting });
  }

  const existing = capabilityFromRequest(request);

  if (parsed.op === "clear") {
    // Nothing to withdraw without a capability, and saying so reveals nothing.
    if (!existing) return json(200, { ok: true, removed: false });
    const { data, error } = await supabase.rpc("clear_sendset_item_action", {
      p_slug: slug,
      p_session_hash: existing,
      p_item_id: parsed.itemId,
      p_action: parsed.action,
    });
    if (error) return refusal(error);
    return json(200, { ok: true, removed: Boolean((data as { removed?: boolean })?.removed) });
  }

  // SET. A capability is minted only here, and only when this call succeeds: the
  // submission, its first line and the cookie all arrive together or not at all.
  const minted = existing ? null : mintCapability();
  const hash = existing ?? minted!.hash;

  const { data, error } = await supabase.rpc("set_sendset_item_action", {
    p_slug: slug,
    p_rendered_published_at: parsed.marker,
    p_session_hash: hash,
    p_responder_name: parsed.name,
    p_responder_contact: parsed.contact,
    p_item_id: parsed.itemId,
    p_action: parsed.action,
  });
  if (error) return refusal(error);

  const stored = data as { created: boolean; label: string | null; wasCurrent: boolean };
  const res = json(200, {
    ok: true,
    action: { itemId: parsed.itemId, action: parsed.action, label: stored.label, inCurrent: true, wasCurrent: stored.wasCurrent },
    signature: { name: parsed.name },
  });
  // The one place the raw capability is ever written, and it is written to a
  // header rather than to the body the page can read.
  if (minted) setCapabilityCookie(res, slug, minted.raw);
  return res;
}

/** The database's refusals, in the recipient's words. */
function refusal(error: { code?: string; details?: string | null }): NextResponse {
  if (error.code === "PT404") return notAccepting();
  if (error.code === "PT429") return json(429, { error: "rate_limited", message: ACTION_OUTCOME.rateLimited });
  if (error.code === "PT409" && error.details === "target_absent") {
    return json(409, { error: "target_absent", message: ACTION_OUTCOME.targetAbsent });
  }
  if (error.code === "PT400") return json(400, { error: "invalid", field: "form", message: ACTION_OUTCOME.failed });
  console.error("[actions] could not record an item action", { code: error.code });
  return json(500, { error: "failed", message: ACTION_OUTCOME.failed });
}
