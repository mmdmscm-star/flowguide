// Server-side halves of the invitation: who is asking, and sending the email.
import { getSession } from "./auth.ts";
import { createServerClient } from "./supabase.ts";
import { isFounder } from "./founder.ts";
import { invitationEmail, invitationExpiry } from "./invitation.ts";
import { publicSendsetUrl } from "./public-url.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** The signed-in founder, or null. Every founder surface starts here. */
export async function founderSession(db: Db = createServerClient()): Promise<{ userId: string; email: string } | null> {
  const session = await getSession();
  if (!session) return null;
  const { data } = await db.from("users").select("email").eq("id", session.userId).maybeSingle();
  const email = (data as { email?: string } | null)?.email ?? null;
  return isFounder(email) ? { userId: session.userId, email: email! } : null;
}

/** Where an invitation link points. The canonical host, like every shared link. */
export function invitationUrl(token: string): string {
  return `${publicSendsetUrl("").replace(/\/p\/$/, "")}/invited?token=${encodeURIComponent(token)}`;
}

/**
 * A fresh 7-day magic link for an invited address, and the invitation email
 * carrying it. Returns whether the mail actually went out — the caller records
 * that, and may send again without reserving anything new.
 */
export async function sendInvitation(db: Db, email: string): Promise<{ sent: boolean; reason?: string }> {
  const token = crypto.randomUUID();
  const { error } = await db.from("magic_links").insert({
    email,
    token,
    expires_at: invitationExpiry().toISOString(),
  });
  if (error) return { sent: false, reason: "link_not_created" };

  const key = process.env.RESEND_API_KEY;
  const message = invitationEmail({ url: invitationUrl(token) });
  if (!key) {
    // Same as the sign-in route in development: the link is printed, not sent.
    console.log(`\n✉️  Invitation link for ${email}:\n${invitationUrl(token)}\n`);
    return { sent: false, reason: "no_mailer" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || "Sendset <onboarding@resend.dev>",
        to: email,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error("[invitation] not sent", { status: res.status });
      return { sent: false, reason: "send_failed" };
    }
    return { sent: true };
  } catch (e) {
    console.error("[invitation] send threw", { error: (e as Error).name });
    return { sent: false, reason: "send_failed" };
  }
}
