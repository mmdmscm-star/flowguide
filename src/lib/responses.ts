// SENDSET RESPONSES — the rules shared by the page, the endpoint, the owner's
// list and the notification email. No I/O here; see 0058 for the database half.
//
// WHAT A RESPONSE IS: somebody, once, sending the professional a message about a
// published Sendset, signed however they chose. The same link may reach one
// person, several, or the public, and Sendset cannot know which — so nothing
// here names an audience, and nothing treats what they typed as verified.

/** Limits, identical to the database CHECKs (0058). Counted in code points, as
 *  Postgres char_length counts them. */
export const NAME_MAX = 120;
export const CONTACT_MAX = 200;
export const MESSAGE_MAX = 4000;

/** THE PUBLICATION MARKER'S SHAPE — the same pattern record_sendset_response
 *  checks before it casts or looks anything up.
 *
 *  THE MARKER IS AN OPAQUE STRING. It is packet_publications.published_at exactly
 *  as PostgREST rendered it into the page, and it goes back to Postgres exactly
 *  as the browser returned it. It is never parsed, formatted or compared here:
 *  a JavaScript date keeps milliseconds and the database keeps microseconds, so
 *  a round trip through one would quietly turn every current page into a stale
 *  one. Postgres does the comparison, by equality. */
export const MARKER_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** Trim exactly what the database trims — space, tab, CR, LF — and no more, so
 *  a value this accepts is a value the CHECK accepts. */
const trimLikeDb = (s: string) => s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
const codePoints = (s: string) => [...s].length;

export type ResponseField = "name" | "contact" | "message" | "form";

export type ParsedResponse =
  | { ok: true; marker: string; name: string; contact: string | null; message: string; honeypot: boolean }
  | { ok: false; field: ResponseField; message: string };

/**
 * The body of POST /api/p/[slug]/responses, checked BEFORE anything is looked
 * up — so a validation answer is identical for every slug, real or not.
 *
 * v1 POLICY, not database policy: a name is required and contact is optional.
 * The database allows an unsigned response, for the day a creator can choose
 * to accept one.
 */
export function parseResponseBody(body: unknown): ParsedResponse {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);

  const marker = str(b.marker);
  if (marker === null || !MARKER_SHAPE.test(marker)) {
    return { ok: false, field: "form", message: "This page is out of date. Reload it and send your message again." };
  }

  // The honeypot: a field a person never sees. Anything in it is answered as a
  // success and stored nowhere, so the answer teaches a script nothing.
  const website = str(b.website);
  const honeypot = website !== null && website !== "";

  const name = trimLikeDb(str(b.name) ?? "");
  if (!name) return { ok: false, field: "name", message: "Add your name." };
  if (codePoints(name) > NAME_MAX) return { ok: false, field: "name", message: `Keep your name under ${NAME_MAX} characters.` };

  const contactRaw = trimLikeDb(str(b.contact) ?? "");
  if (codePoints(contactRaw) > CONTACT_MAX) {
    return { ok: false, field: "contact", message: `Keep this under ${CONTACT_MAX} characters.` };
  }

  const message = trimLikeDb(str(b.message) ?? "");
  if (!message) return { ok: false, field: "message", message: "Write a message." };
  if (codePoints(message) > MESSAGE_MAX) {
    return { ok: false, field: "message", message: "Keep your message under 4,000 characters." };
  }

  return { ok: true, marker, name, contact: contactRaw || null, message, honeypot };
}

/** What the recipient reads for each outcome. None of them says whether the
 *  Sendset exists, and none promises a reply. */
export const RESPONSE_OUTCOME = {
  sent: "Sent.",
  notAccepting: "This Sendset isn’t accepting responses right now.",
  rateLimited: "Too many responses just now. Please try again a little later.",
  failed: "Your message couldn’t be sent. Please try again.",
  owner: "This is your own Sendset. People you share it with can send you a message here.",
} as const;

/** The heading on the recipient's panel. The sender's own published name — the
 *  person or organisation the page already shows — or nothing at all for a
 *  Sendset that shows no sender. Routing is to the owner's account either way. */
export function respondHeading(senderName: string | null | undefined): string {
  const name = String(senderName ?? "").trim();
  return name ? `Send a message to ${name}` : "Send a message";
}

// ---------------------------------------------------------------------------
// THE OWNER'S VIEW
// ---------------------------------------------------------------------------

/** "1 response", "3 responses". A count of submissions — not people. */
export function responseCountLabel(count: number): string {
  return `${count} ${count === 1 ? "response" : "responses"}`;
}

/** Shown once, above every list of responses. */
export const IDENTITY_NOTE =
  "Names and contact details are what the person typed. Sendset doesn’t verify who sent a response.";

/**
 * The one staleness line a response may carry, or null.
 *
 * BEST-EFFORT, NOT PROOF. `wasCurrent` says the page it was sent from returned
 * the marker of the publication live at receipt. That is a property of the
 * ordinary response flow, not evidence of what anybody read. `republishedSince`
 * is decided by Postgres equality between the stored marker and the current
 * publication's (never by ordering: published_at is not monotonic), and is null
 * when the Sendset is not published now, so no comparison is made.
 *
 * Neither line offers to show the earlier version. It is not kept.
 */
export function stalenessLabel(wasCurrent: boolean, republishedSince: boolean | null): string | null {
  if (!wasCurrent) return "Sent from an earlier version of this Sendset";
  if (republishedSince === true) return "Sent before your latest update";
  return null;
}

/** Whether the owner was emailed — stated plainly, because a failed or skipped
 *  notification must be visible rather than silent. */
export function notificationLabel(due: boolean, notifiedAt: string | null): string {
  if (notifiedAt) return "Emailed to you";
  return due ? "Email not sent" : "Not emailed — too many responses in an hour";
}

// ---------------------------------------------------------------------------
// THE NOTIFICATION EMAIL
// ---------------------------------------------------------------------------

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/**
 * The email to the Sendset's OWNER, at their account address.
 *
 * NEVER TO THE RESPONDER, and no Reply-To: the contact field is whatever a
 * stranger typed, so Sendset does not send mail to it and does not make it one
 * click away from a reply that looks like it came from us. It appears in the
 * body, labelled as unverified.
 *
 * The SUBJECT carries only the owner's own private name for the Sendset — never
 * the responder's words, which could say anything and would sit in an inbox
 * list looking like a message from Sendset.
 */
export function responseEmail(r: {
  sendsetTitle: string;
  name: string;
  contact: string | null;
  message: string;
  stale: boolean;
  responsesUrl: string;
}): { subject: string; html: string; text: string } {
  const title = r.sendsetTitle.trim() || "an untitled Sendset";
  const subject = `New response on ${r.sendsetTitle.trim() ? `“${title}”` : title}`;
  const signed = `Signed “${r.name}”`;
  const contact = r.contact ? `Contact, as entered (not verified): ${r.contact}` : null;
  const stale = r.stale ? "Sent from an earlier version of this Sendset." : null;

  const text = [
    `New response on ${title}`,
    "",
    r.message,
    "",
    signed,
    ...(contact ? [contact] : []),
    ...(stale ? [stale] : []),
    "",
    IDENTITY_NOTE,
    "",
    `See all responses: ${r.responsesUrl}`,
  ].join("\n");

  const p = (s: string, style = "") => `<p style="margin:0 0 12px;${style}">${s}</p>`;
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.5;color:#1f2328;max-width:560px">`
    + p(`New response on <strong>${escapeHtml(title)}</strong>`)
    + p(escapeHtml(r.message), "white-space:pre-wrap;padding:12px 14px;background:#f6f7f8;border-radius:8px")
    + p(escapeHtml(signed))
    + (contact ? p(escapeHtml(contact)) : "")
    + (stale ? p(escapeHtml(stale), "color:#57606a") : "")
    + p(escapeHtml(IDENTITY_NOTE), "color:#57606a;font-size:13px")
    + p(`<a href="${escapeHtml(r.responsesUrl)}">See all responses</a>`)
    + `</div>`;

  return { subject, html, text };
}
