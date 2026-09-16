import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getSession } from "@/lib/auth";
import { isPublicDemo } from "@/lib/public-demos";

// POST /api/p/:slug/view — one browser opened a published Sendset.
//
// WHAT IS RECORDED: one, added to an integer on the Sendset. Not who, not when,
// not from where. There is no per-view row to hold anything else, and no
// identifier of any kind is read or written — no cookie, no visitor id, no
// fingerprint. `record_packet_view` can only add one to a published Sendset's
// count, and only service_role may execute it (0057).
//
// WHY THE BROWSER ASKS FOR THIS rather than the page counting itself: the
// recipient page is fetched by things that are not a reader. A messaging app
// building a link preview requests the URL server-side, and a GET that counted
// would count that. Moving the count behind a request the loaded page makes
// means THE ORDINARY UNFURL FETCH INCREMENTS NOTHING. That is the whole claim —
// not that automated clients cannot reach this endpoint.
//
// BEST-EFFORT, AND ONLY THAT. This counts page opens, not verified humans.
// Anyone who wants a larger number can send this request; the same-origin check
// below turns away a casual cross-site POST and is not a defence against
// someone deliberately inflating their own count. Nothing here is fraud-proof.
//
// ALWAYS 204. The response is identical for a real Sendset, a draft, a demo, a
// slug that never existed, and the owner's own visit — an endpoint that
// answered differently would be a way to test whether a slug exists.
const noContent = () => new NextResponse(null, { status: 204 });

type Context = { params: Promise<{ slug: string }> };

export async function POST(request: Request, context: Context) {
  const { slug } = await context.params;

  // A cheap same-origin check. `Sec-Fetch-Site` is sent by current browsers;
  // where it is absent, fall back to Origin. Neither is a security boundary.
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return noContent();
  const origin = request.headers.get("origin");
  if (!site && origin) {
    try {
      if (new URL(origin).host !== request.headers.get("host")) return noContent();
    } catch { return noContent(); }
  }

  // A demo is nobody's Sendset: no owner to report to, and no view to record.
  // Checked here as well as in the page, because this endpoint is reachable
  // without it.
  if (isPublicDemo(slug)) return noContent();

  const supabase = createServerClient();

  // THE OWNER'S OWN VISIT IS NOT A VIEW, refused twice: the page does not mount
  // the beacon for them, and this refuses it if one arrives anyway. The count
  // answers "has my client opened this", and a professional checking their own
  // link is exactly what made the old boolean untrustworthy.
  const session = await getSession();
  if (session) {
    const { data: owned } = await supabase
      .from("packets")
      .select("id")
      .eq("slug", slug)
      .eq("user_id", session.userId)
      .maybeSingle();
    if (owned) return noContent();
  }

  // Published-only, atomic, and silent about whether the slug exists — all
  // three inside the function. A failure is logged and swallowed: a lost count
  // is not worth telling a recipient's browser about.
  const { error } = await supabase.rpc("record_packet_view", { p_slug: slug });
  if (error) console.error("[view] could not record a page open", { error: error.message });

  return noContent();
}
