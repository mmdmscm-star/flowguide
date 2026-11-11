// POST /api/auth/password
//
// The logged-in professional sets (or changes) their password. Setting a
// password is OPT-IN — until this route is called on an account, that
// account can only be reached through the magic link. Once set, both paths
// work: magic link for recovery, email + password for everyday sign-in on
// shared devices, phones, a spouse's computer, and so on.
//
// SESSION-GATED. The caller must already be signed in via a session cookie —
// the magic-link path remains the one way to prove ownership of an email
// for the FIRST password set. For a change of password, being signed in
// also proves the old session is still intact; this route does not require
// the OLD password because an attacker who already has a session can do
// much worse than change a password, and the magic-link reset path means
// anyone locked out can recover without knowing the old one.
//
// NOT HERE: delete-password. A professional can change the password to
// something new, but there is no "turn off password sign-in" — once the
// account has a password, keeping it is strictly safer than removing it
// (removing it would leave the account reachable only via the magic link
// again, which is the pre-password state and does not need an on-switch).

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { hashPassword, validatePassword } from "@/lib/password";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const password = (body as { password?: unknown }).password;

  const supabase = createServerClient();
  const { data: user } = await supabase
    .from("users")
    .select("id, email")
    .eq("id", session.userId)
    .maybeSingle();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const check = validatePassword(password, String((user as { email?: string }).email ?? ""));
  if (!check.ok) {
    return NextResponse.json({ error: "weak_password", message: check.reason }, { status: 400 });
  }

  const hash = await hashPassword(password as string);
  const { error } = await supabase
    .from("users")
    .update({ password_hash: hash, password_updated_at: new Date().toISOString() })
    .eq("id", session.userId);

  if (error) {
    console.error("[auth/password] update failed", { userId: session.userId, message: error.message });
    return NextResponse.json({ error: "save_failed", message: "Couldn't save your password. Please try again." }, { status: 500 });
  }

  // Current session stays live — a password change is not a sign-out event.
  // Other sessions this account already has (another device signed in via
  // magic link, say) also stay live; invalidating them on password change
  // would be a separate decision, and the current behaviour matches what
  // most consumer products do — change the password, then explicitly sign
  // out any other sessions if you want them gone.
  return NextResponse.json({ ok: true });
}
