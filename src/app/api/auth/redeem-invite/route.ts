import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@/lib/supabase";
import { createSession, SIGNUP_COOKIE } from "@/lib/auth";
import { inviteCodeHash, isPlausibleInviteCode, normalizeInviteCode } from "@/lib/invite-code";

export const INVITE_INVALID = "That invite code isn't valid.";
export const SIGNUP_EXPIRED = "Your sign-in link expired. Enter your email again to get a new one.";

// POST /api/auth/redeem-invite — the ONLY way the app creates an account.
//
// The code arrives in the body (never a URL, never a log), is normalised and
// hashed here, and is checked by redeem_invite (0055), which creates the
// account and consumes the invite in one transaction.
export async function POST(request: Request) {
  const token = (await cookies()).get(SIGNUP_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "signup_expired", message: SIGNUP_EXPIRED }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const normalized = normalizeInviteCode(typeof body.code === "string" ? body.code : "");
  if (!isPlausibleInviteCode(normalized)) {
    return NextResponse.json({ error: "invite_invalid", message: INVITE_INVALID }, { status: 403 });
  }

  const supabase = createServerClient();
  const { data, error } = await supabase.rpc("redeem_invite", {
    p_magic_token: token,
    p_code_hash: inviteCodeHash(normalized),
  });

  if (error) {
    const detail = (error as { details?: string | null }).details;
    if (detail === "invite_invalid") {
      return NextResponse.json({ error: "invite_invalid", message: INVITE_INVALID }, { status: 403 });
    }
    const response = detail === "link_invalid"
      ? NextResponse.json({ error: "signup_expired", message: SIGNUP_EXPIRED }, { status: 401 })
      // Never the database's words, and never the code.
      : NextResponse.json({ error: "signup_failed", message: "Something went wrong. Please try again." }, { status: 500 });
    if (detail === "link_invalid") response.cookies.delete(SIGNUP_COOKIE);
    if (detail !== "link_invalid") console.error("[redeem-invite] refused", { sqlstate: error.code, detail });
    return response;
  }

  const result = data as { userId: string; created: boolean };
  await createSession(result.userId);
  const response = NextResponse.json({ ok: true, created: result.created });
  response.cookies.delete(SIGNUP_COOKIE);
  return response;
}
