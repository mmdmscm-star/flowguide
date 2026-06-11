import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { createSession } from "@/lib/auth";

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

  // Mark magic link as used
  await supabase.from("magic_links").update({ used: true }).eq("id", magicLink.id);

  // Find or create user
  let { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("email", magicLink.email)
    .single();

  if (!user) {
    const { data: newUser, error } = await supabase
      .from("users")
      .insert({ email: magicLink.email })
      .select()
      .single();

    if (error || !newUser) {
      return NextResponse.redirect(`${appUrl}/login?error=create-failed`);
    }
    user = newUser;

    // Create empty professional profile for new users
    await supabase.from("professional_profiles").insert({
      user_id: newUser.id,
      email: magicLink.email,
    });
  }

  // Create session
  await createSession(user!.id);

  return NextResponse.redirect(`${appUrl}/dashboard`);
}
