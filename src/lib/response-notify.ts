// The owner's notification for one stored response. Server only.
import { PUBLIC_ORIGIN } from "./public-url.ts";
import { responseEmail } from "./responses.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** Where the owner reads a Sendset's responses. */
export function responsesPageUrl(packetId: string): string {
  return `${PUBLIC_ORIGIN}/responses/${packetId}`;
}

/**
 * Email the owner about a response that is ALREADY STORED, then record that it
 * was sent. Best-effort: every failure is logged and swallowed, because the
 * response exists either way and the owner's list shows whether an email went.
 *
 * TO THE OWNER'S ACCOUNT ADDRESS (users.email) — never a profile email, a
 * custom organisation's email, or anything the responder typed. NO Reply-To.
 *
 * `notified_at` is set only after the mail provider accepted the message, so a
 * failed send stays visible as not sent.
 */
export async function notifyOwnerOfResponse(
  db: Db,
  r: { responseId: string; ownerUserId: string; name: string; contact: string | null; message: string },
): Promise<{ sent: boolean }> {
  try {
    // What was stored, read back — not what the request claimed.
    const { data: stored } = await db
      .from("sendset_responses")
      .select("packet_id, rendered_publication_was_current, packets(title)")
      .eq("id", r.responseId)
      .maybeSingle();
    const row = stored as { packet_id: string; rendered_publication_was_current: boolean; packets: { title?: string } | null } | null;
    if (!row) {
      console.error("[responses] stored response not found for notification", { responseId: r.responseId });
      return { sent: false };
    }
    const { data: owner } = await db.from("users").select("email").eq("id", r.ownerUserId).maybeSingle();
    const to = (owner as { email?: string } | null)?.email;
    if (!to) {
      console.error("[responses] owner has no account email", { responseId: r.responseId });
      return { sent: false };
    }

    const mail = responseEmail({
      sendsetTitle: String(row.packets?.title ?? ""),
      name: r.name,
      contact: r.contact,
      message: r.message,
      stale: !row.rendered_publication_was_current,
      responsesUrl: responsesPageUrl(row.packet_id),
    });

    const key = process.env.RESEND_API_KEY;
    if (!key) {
      // Development: say that a notification would have gone, without the message.
      console.log(`\n✉️  Response notification for ${to} (not sent: no mailer)\n`);
      return { sent: false };
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || "Sendset <onboarding@resend.dev>",
        to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      console.error("[responses] notification not sent", { status: res.status });
      return { sent: false };
    }

    const { error } = await db.rpc("mark_sendset_response_notified", { p_response_id: r.responseId });
    if (error) console.error("[responses] sent but not recorded", { code: error.code });
    return { sent: true };
  } catch (e) {
    console.error("[responses] notification threw", { error: (e as Error).name });
    return { sent: false };
  }
}
