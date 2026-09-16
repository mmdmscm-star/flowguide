// THE INVITATION EMAIL IS THE SIGN-IN LINK.
//
// Approving a request reserves an invite for that address (0056) and sends this
// email. Its button carries a magic link — the same mechanism as an ordinary
// sign-in, with one difference: an invitation may sit unopened for days, so the
// link lives for a week instead of fifteen minutes.
//
// The link opens a PAGE, which does nothing until the person presses Get
// started. A mail scanner that fetches the URL therefore cannot spend the
// invitation, and the human's click is what creates the account.
export const INVITATION_LINK_DAYS = 7;
export const INVITATION_SUBJECT = "You're invited to Sendset";
export const INVITATION_LINE = "Sendset is currently in early access, and your invitation is ready.";
export const INVITATION_FALLBACK =
  "If the button doesn't work, go to sendset.io/login and use the same email address this invitation was sent to.";

export function invitationExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITATION_LINK_DAYS * 24 * 60 * 60 * 1000);
}

/** The invitation, as it is sent. `url` is the /invited landing page. */
export function invitationEmail({ url }: { url: string }): { subject: string; html: string; text: string } {
  return {
    subject: INVITATION_SUBJECT,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:440px;margin:0 auto;padding:40px 20px">
  <h1 style="font-size:24px;font-weight:700;margin:0 0 8px">Sendset</h1>
  <p style="color:#374151;margin:0 0 24px">${INVITATION_LINE}</p>
  <a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:500">Get started</a>
  <p style="color:#9ca3af;font-size:14px;margin:24px 0 0">${INVITATION_FALLBACK}</p>
</div>`,
    text: `Sendset\n\n${INVITATION_LINE}\n\nGet started: ${url}\n\n${INVITATION_FALLBACK}\n`,
  };
}
