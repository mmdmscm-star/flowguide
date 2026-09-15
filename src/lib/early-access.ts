// THE EARLY-ACCESS REQUEST FORM: one row, reviewed by hand.
//
// Name, email and what they would use Sendset for. No account, no token, no
// follow-up machinery — and deliberately no email back to the person who
// submitted it, so the form cannot be used to send mail to anyone else. The
// only mail it sends is one best-effort note to the owner; saving the request
// never depends on that note being delivered.
//
// Requests are deleted after 90 days by the database's own purge job (0055).

export type EarlyAccessInput = { name?: unknown; email?: unknown; useCase?: unknown; website?: unknown };
export type EarlyAccessRequest = { name: string; email: string; useCase: string };
export type EarlyAccessOutcome =
  | { status: 200; stored: boolean }
  | { status: 400; error: "invalid"; message: string }
  | { status: 429; error: "rate_limited"; message: string }
  | { status: 503; error: "unavailable"; message: string };

export const MAX_PER_EMAIL_PER_DAY = 3;
export const MAX_PER_HOUR = 30;
export const THANKS = "Thank you — your request is in. I read these myself and will be in touch.";

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The same limits the table's own CHECKs enforce, said in the person's words. */
export function validateEarlyAccess(input: EarlyAccessInput): { ok: true; value: EarlyAccessRequest } | { ok: false; message: string } {
  const name = text(input.name), email = text(input.email).toLowerCase(), useCase = text(input.useCase);
  if (!name || name.length > 200) return { ok: false, message: "Please add your name." };
  if (!email || email.length > 320 || !EMAIL.test(email)) return { ok: false, message: "Please enter a valid email address." };
  if (!useCase) return { ok: false, message: "Please say what you'd like to use Sendset for." };
  if (useCase.length > 2000) return { ok: false, message: "Please keep it under 2000 characters." };
  return { ok: true, value: { name, email, useCase } };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** The note to the owner. Plain, and never shown to the requester. */
export function notificationEmail(r: EarlyAccessRequest): { subject: string; html: string } {
  return {
    subject: `Sendset early access: ${r.name}`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px">`
      + `<p><strong>${escapeHtml(r.name)}</strong> &lt;${escapeHtml(r.email)}&gt; asked for early access.</p>`
      + `<p style="white-space:pre-wrap">${escapeHtml(r.useCase)}</p></div>`,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/**
 * Store one request. A honeypot hit is answered exactly like a real submission
 * and stored nowhere. Limits are per email per day and overall per hour — small
 * enough to be a speed bump, not an anti-abuse system.
 */
export async function storeEarlyAccessRequest(db: Db, input: EarlyAccessInput): Promise<EarlyAccessOutcome> {
  if (text(input.website)) return { status: 200, stored: false };   // a person never sees this field
  const valid = validateEarlyAccess(input);
  if (!valid.ok) return { status: 400, error: "invalid", message: valid.message };
  const { value } = valid;

  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  const mine = await db.from("early_access_requests").select("id", { count: "exact", head: true })
    .eq("email", value.email).gte("created_at", since(24 * 60 * 60 * 1000));
  if (mine.error) return { status: 503, error: "unavailable", message: "Something went wrong. Please try again in a moment." };
  if ((mine.count ?? 0) >= MAX_PER_EMAIL_PER_DAY) {
    return { status: 429, error: "rate_limited", message: "You've already sent a request — I have it, and I'll be in touch." };
  }
  const all = await db.from("early_access_requests").select("id", { count: "exact", head: true })
    .gte("created_at", since(60 * 60 * 1000));
  if (all.error) return { status: 503, error: "unavailable", message: "Something went wrong. Please try again in a moment." };
  if ((all.count ?? 0) >= MAX_PER_HOUR) {
    return { status: 429, error: "rate_limited", message: "Too many requests just now. Please try again a little later." };
  }

  const { error } = await db.from("early_access_requests").insert({ name: value.name, email: value.email, use_case: value.useCase });
  if (error) return { status: 503, error: "unavailable", message: "Something went wrong. Please try again in a moment." };
  return { status: 200, stored: true };
}
