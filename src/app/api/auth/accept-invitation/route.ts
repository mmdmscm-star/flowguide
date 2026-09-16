import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { createSession } from "@/lib/auth";

export const INVITATION_EXPIRED = "This invitation link has expired. Go to the sign-in page and use the same email address this invitation was sent to.";
export const NO_INVITATION = "There's no invitation waiting for this address.";

// POST /api/auth/accept-invitation — the click that accepts.
//
// Deliberately a POST: opening the emailed link is a GET that reads and shows,
// so a mail scanner fetching it cannot create an account, spend the magic link
// or consume the reserved invitation. This is where all three happen, in one
// transaction (redeem_bound_invite, 0056). The token is never logged.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) return NextResponse.json({ error: "invalid", message: INVITATION_EXPIRED }, { status: 400 });

  const { data, error } = await createServerClient().rpc("redeem_bound_invite", { p_magic_token: token });
  if (error) {
    const detail = (error as { details?: string | null }).details;
    if (detail === "link_invalid") return NextResponse.json({ error: "expired", message: INVITATION_EXPIRED }, { status: 401 });
    if (detail === "no_invitation") return NextResponse.json({ error: "no_invitation", message: NO_INVITATION }, { status: 403 });
    console.error("[accept-invitation] refused", { sqlstate: error.code, detail });
    return NextResponse.json({ error: "failed", message: "Something went wrong. Please try again." }, { status: 500 });
  }

  const result = data as { userId: string; created: boolean };
  await createSession(result.userId);
  return NextResponse.json({ ok: true, created: result.created });
}
