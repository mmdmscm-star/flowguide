// WHEN IS A PROFESSIONAL IDENTITY READY TO SEND?
//
// Stated once, because two places now ask it and they must never disagree.
// The publish route has always enforced this rule; the dashboard's first-run
// prompt now asks the same question. A separate "has a name" heuristic for
// onboarding would have been easy and wrong — a professional could be told they
// were set up, then be refused at publish, or be nagged after publishing
// perfectly good packets.
//
// The rule is the publish route's, unchanged: A NAME, AND AT LEAST ONE WAY TO
// REPLY. Everything else — logo, headshot, business, website, footer label,
// links — improves the packet and is never required, which is why the gap is a
// two-value answer rather than a score.

export type IdentityContact = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

/** The two ways an identity can be unready. The strings ARE the publish route's
 *  error codes; the API contract and this rule are the same thing. */
export type IdentityGap = "no_profile" | "no_contact";

/** The message each gap has always returned from publish. */
export const IDENTITY_GAP_MESSAGE: Record<IdentityGap, string> = {
  no_profile: "No professional contact information",
  no_contact: "No email or phone in professional contact",
};

/** What a professional would still be asked for, phrased for them rather than
 *  for the API. Used by the dashboard prompt. */
export const IDENTITY_GAP_PROMPT: Record<IdentityGap, string> = {
  no_profile: "Add your name so your Sendsets say who they are from.",
  no_contact: "Add a phone number or email so clients can reach you.",
};

const filled = (v: unknown) => String(v ?? "").trim().length > 0;

/**
 * `null` when the identity is ready to publish.
 *
 * A `null` CONTACT is also ready: that is a packet whose identity mode is
 * "none", which deliberately carries no professional at all. Absence of a
 * contact and an incomplete contact are not the same answer.
 */
export function identityGap(contact: IdentityContact | null | undefined): IdentityGap | null {
  if (!contact) return null;
  if (!filled(contact.name)) return "no_profile";
  if (!filled(contact.email) && !filled(contact.phone)) return "no_contact";
  return null;
}

export function isIdentityReady(contact: IdentityContact | null | undefined): boolean {
  return identityGap(contact) === null;
}
