// POST /api/auth/password-login
//
// Email + password sign-in. The counterpart to /api/auth/send-magic-link
// for anyone on a device where getting into the account's inbox isn't
// easy or isn't the point: a shared laptop, a spouse taking over the
// sending of Sendsets, a tablet, a work computer.
//
// SAME SESSION MODEL AS THE MAGIC LINK. On success this route calls the
// same createSession helper the magic-link verify path calls — same cookie,
// same 30-day lifetime, same sessions table. From the server's point of
// view, how a professional proved their identity (link in an email vs.
// password they typed) does not change what a session is afterwards.
//
// RATE LIMIT. Five failed attempts per email in a 15-minute window locks
// that email out of this path until the window passes. The magic-link
// path stays open the whole time, so a locked-out professional (whether
// it was them trying the wrong password or someone else) can always
// recover by emailing themselves a sign-in link. The lock is per-email,
// not per-IP, because an attacker trying passwords against one email
// from many IPs is the attack this is written to defeat.
//
// SAME-MESSAGE FAILURES. Wrong password, unknown email, no password set
// on an existing account all produce the same "Incorrect email or
// password" response. That is the standard shape for a sign-in form —
// a different message for "no such account" leaks account existence to
// anyone who can type an email.

import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { createSession } from "@/lib/auth";
import {
  normaliseEmail,
  verifyPassword,
  PASSWORD_ATTEMPT_WINDOW_MS,
  PASSWORD_ATTEMPT_LIMIT,
} from "@/lib/password";

type Body = { email?: unknown; password?: unknown };

// A single string so every failure path says the same thing, including
// the handful of guard clauses before the hash check even runs.
const FAILED = "Incorrect email or password.";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const emailRaw = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";

  // Shape check first. Not a credential — no attempt is recorded.
  if (!emailRaw || !password) {
    return NextResponse.json({ error: FAILED }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
    return NextResponse.json({ error: FAILED }, { status: 400 });
  }

  const email = normaliseEmail(emailRaw);
  const supabase = createServerClient();

  // RATE LIMIT WINDOW. Count the recent FAILED attempts only — a success
  // elsewhere in the window doesn't mean this attempt deserves to be
  // throttled, and counting both would punish the account for having
  // ever signed in successfully.
  const windowStart = new Date(Date.now() - PASSWORD_ATTEMPT_WINDOW_MS).toISOString();
  const { count: failedRecently } = await supabase
    .from("password_login_attempts")
    .select("id", { count: "exact", head: true })
    .eq("email", email)
    .eq("ok", false)
    .gte("attempted_at", windowStart);

  if ((failedRecently ?? 0) >= PASSWORD_ATTEMPT_LIMIT) {
    // The magic link stays open — say so, so a locked-out professional
    // has a next step rather than a dead end.
    return NextResponse.json(
      {
        error: "locked",
        message:
          "Too many sign-in attempts for this address. Try again in a few minutes, or email yourself a sign-in link instead.",
      },
      { status: 429 },
    );
  }

  const { data: user } = await supabase
    .from("users")
    .select("id, password_hash")
    .eq("email", email)
    .maybeSingle();

  const storedHash = (user as { password_hash?: string | null } | null)?.password_hash ?? null;
  const ok = storedHash ? await verifyPassword(password, storedHash) : false;

  // Record the attempt (successful or not) so the rate limiter has
  // material to read next time. An IP hash would ride here too in a
  // future revision.
  await supabase.from("password_login_attempts").insert({ email, ok });

  if (!ok || !user) {
    return NextResponse.json({ error: FAILED }, { status: 401 });
  }

  await createSession((user as { id: string }).id);
  return NextResponse.json({ ok: true });
}
