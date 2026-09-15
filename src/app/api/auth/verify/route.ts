import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { createSession, SIGNUP_COOKIE, SIGNUP_WINDOW_MINUTES } from "@/lib/auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  if (!token) {
    return NextResponse.redirect(`${appUrl}/login?error=missing-token`);
  }

  const supabase = createServerClient();

  // Find and validate the magic link
  const { data: magicLink } = await supabase
    .from("magic_links")
    .select("*")
    .eq("token", token)
    .eq("used", false)
    .single();

  if (!magicLink) {
    return NextResponse.redirect(`${appUrl}/login?error=invalid-link`);
  }

  if (new Date(magicLink.expires_at) < new Date()) {
    // Mark as used so it can't be retried
    await supabase.from("magic_links").update({ used: true }).eq("id", magicLink.id);
    return NextResponse.redirect(`${appUrl}/login?error=expired`);
  }

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("email", magicLink.email)
    .single();

  // NO ACCOUNT YET: THIS ROUTE NO LONGER CREATES ONE.
  //
  // Sendset is in early access, so an account costs an invite code (0055). The
  // link is left UNUSED and its token travels in an httpOnly cookie to /join,
  // which asks for the code; redeem_invite then creates the account and
  // consumes the invite in one transaction. Anyone who never enters a code
  // simply has no account, and the link expires on its own.
  if (!user) {
    const response = NextResponse.redirect(`${appUrl}/join`);
    // Enough time to fetch the code from another window, never longer than an
    // hour after the link was sent.
    const cap = new Date(new Date(magicLink.created_at).getTime() + 60 * 60 * 1000);
    const wanted = new Date(Date.now() + SIGNUP_WINDOW_MINUTES * 60 * 1000);
    const until = new Date(Math.min(cap.getTime(), wanted.getTime()));
    if (until > new Date(magicLink.expires_at)) {
      await supabase.from("magic_links").update({ expires_at: until.toISOString() }).eq("id", magicLink.id);
    }
    response.cookies.set(SIGNUP_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: until,
    });
    return response;
  }

  // Existing account: unchanged. The link is spent here.
  await supabase.from("magic_links").update({ used: true }).eq("id", magicLink.id);

  await createSession(user.id);

  return NextResponse.redirect(`${appUrl}/dashboard`);
}
