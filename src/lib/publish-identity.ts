// WHICH IDENTITY A PUBLISH FREEZES INTO THE SENDSET.
//
// One rule, used by the publish route (what it stores) and by the publication
// state check (what a republish WOULD store). Two copies would let the editor
// say "Published" about a card a republish would change, or the reverse.
//
//   'none'    -> {} : no professional at all
//   'custom'  -> the Sendset's own identity
//   'default' -> the account profile, or {} when the professional chose to
//                publish without contact details ("publish anyway")
import { identityGap, type IdentityContact } from "./professional-identity.ts";

/** The profile columns an identity is built from. */
export const PUBLISH_PROFILE_COLUMNS =
  "name, email, phone, business_name, logo_url, headshot_url, footer_label, website_url, links";

export type PublishIdentity = {
  professionalSnapshot: Record<string, unknown>;
  /** What the readiness rule checks; null when the Sendset deliberately has no identity. */
  contact: IdentityContact | null;
};

export function resolvePublishIdentity(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  packet: { identity_mode?: string | null; custom_identity?: any },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile: any,
  skipProfileCheck: boolean,
): PublishIdentity {
  const mode: string = packet.identity_mode || "default";

  if (mode === "none") {
    return { professionalSnapshot: {}, contact: null };
  }
  if (mode === "custom") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (packet.custom_identity || {}) as Record<string, any>;
    return {
      professionalSnapshot: {
        name: c.name || "",
        email: c.email || "",
        phone: c.phone || "",
        businessName: c.businessName || "",
        logoUrl: c.logoUrl || "",
        headshotUrl: c.headshotUrl || "",
        footerLabel: c.footerLabel || "",
        websiteUrl: c.websiteUrl || "",
        links: Array.isArray(c.links) ? c.links : [],
      },
      contact: { name: c.name, email: c.email, phone: c.phone },
    };
  }
  // Preserve existing behavior: skipping the check publishes with no branding.
  return {
    professionalSnapshot: skipProfileCheck ? {} : {
      name: profile?.name || "",
      email: profile?.email || "",
      phone: profile?.phone || "",
      businessName: profile?.business_name || "",
      logoUrl: profile?.logo_url || "",
      headshotUrl: profile?.headshot_url || "",
      footerLabel: profile?.footer_label ?? "Your Advisor",
      websiteUrl: profile?.website_url || "",
      links: profile?.links || [],
    },
    contact: { name: profile?.name, email: profile?.email, phone: profile?.phone },
  };
}

/**
 * The identity a Republish pressed now would freeze. An identity the readiness
 * rule refuses can only be published by choosing "publish anyway", so that is
 * the choice assumed — the same one that produced any stored `{}`.
 */
export function republishIdentity(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  packet: { identity_mode?: string | null; custom_identity?: any },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile: any,
): Record<string, unknown> {
  const checked = resolvePublishIdentity(packet, profile, false);
  return identityGap(checked.contact) ? resolvePublishIdentity(packet, profile, true).professionalSnapshot : checked.professionalSnapshot;
}
