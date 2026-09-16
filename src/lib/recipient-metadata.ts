import type { Metadata } from "next";

// THE METADATA BOUNDARY BETWEEN MARKETING AND A CLIENT.
//
// A recipient link is professional correspondence. It is pasted into a text
// message or an email to somebody who is often dealing with something
// difficult, and whatever the unfurl shows arrives as part of that message.
//
// The root layout carries the MARKETING card — headline, promotional
// description, /og.jpg. Next.js merges metadata SHALLOWLY: a route that sets
// `title` and `description` but not `openGraph` still inherits the parent's
// entire OpenGraph block. Both recipient routes did exactly that, so a private
// Sendset sent by iMessage unfurled as "Everything you found, in one thing
// your client can actually use." — a sales pitch stapled to a family's private
// situation. It also inherited og:url, pointing the preview at the marketing
// homepage rather than the Sendset.
//
// So `openGraph` and `twitter` are declared here IN FULL. Declaring them
// partially would re-inherit the rest.
//
// WHAT THE PREVIEW SAYS IS NOW THE SENDER'S NAME, AND NOTHING ELSE ABOUT THE
// SENDSET. "A Sendset has been shared with you" is safe but anonymous: a
// client who gets a link from an advisor they already know has no reason to
// trust it more than any other link in a text message. The sender is the one
// fact that helps and costs nothing — the professional already signs the page,
// already chose to send it, and the recipient already knows who they are.
//
// WHAT MAY NEVER REACH A PREVIEW, and the reason it is a TYPE and not a habit:
// this module accepts `SenderIdentity` and nothing else. A client title, a
// client name, a personal note, an item, a section — none of them can be
// passed to these functions, so no future caller can leak one by accident.
// That matters because an unfurl leaves our control completely: iMessage,
// Slack and WhatsApp fetch the URL, cache what they find, and keep it in the
// thread after the Sendset is unpublished. `robots: noindex` does not govern
// unfurl bots.
//
// THE IMAGE IS STILL ONE STATIC NEUTRAL ASSET. Per-Sendset cards are
// deliberately not built — a generated image is a way to bake private content
// into a cache we cannot retract. Removing the image entirely was considered
// and refused: several platforms fall back to scraping the page for a picture
// when og:image is absent, and the candidates on a recipient page are the
// professional's headshot, their logo and the client's own item photographs.
// An explicit neutral card is the only answer that stays OURS.
//
// `og:url` is deliberately absent. Emitting the Sendset URL would be redundant
// (it is the link being shared) and emitting anything else would be wrong —
// which is what inheriting the homepage URL was.

/** The ONLY thing a preview may know about a Sendset: who sent it.
 *
 *  Both fields are already public to the recipient — they are printed in the
 *  footer of the page the link opens. */
export type SenderIdentity = { name?: string; businessName?: string };

export const RECIPIENT_DESCRIPTION = "View on Sendset.";
export const RECIPIENT_TITLE_ANONYMOUS = "A Sendset has been shared with you";

export type PreviewImage = { url: string; width: number; height: number };
const RECIPIENT_OG_IMAGE: PreviewImage = { url: "/og-recipient.png", width: 1200, height: 630 };

// ---------------------------------------------------------------------------
// TEMPORARY — A DEMO-ONLY IMAGE EXPERIMENT. DELETE THIS WHOLE BLOCK when the
// recipient card is decided.
//
// ROUND 2 — ASPECT RATIO, not artwork size. Round 1 answered its question and
// was replaced: A (1200x630) felt best because a LANDSCAPE card makes the whole
// iMessage preview shorter, C's icon-only artwork was the quietest, and D
// proved that shrinking the pixels alone does nothing — a 300x300 card is still
// rendered as a square, and a square is tall.
//
// So these four hold the artwork roughly still and vary the SHAPE:
//
//   E  1200x630  icon only              the best shape from round 1, quietest art
//   F  1200x400  icon only              shorter still
//   G  1200x300  icon + wordmark        a band; the shortest that can be branded
//   H  no og:image at all               the control
//
// H IS SAFE ONLY BECAUSE IT IS A DEMO. With no og:image some platforms fall
// back to scraping the page for a picture, and on a real Sendset those
// candidates are the professional's headshot, their logo and the client's own
// item photographs. On a demo the page's images are the demo's own invented
// interiors, so the fallback can be WATCHED rather than feared — which is the
// point of running it as a control. It must never reach a real link.
//
// twitter:card is still NOT varied, for the same reason as round 1: it is the
// other lever. Note that summary_large_image with no image is self-
// contradictory for X, which is a known cost of H and irrelevant to iMessage,
// the surface being measured.
//
// DEMOS ONLY. Every real Sendset stays on /og-recipient.png: nobody's client
// link is an experiment, and a preview already cached by a messaging app
// cannot be withdrawn.
export const DEMO_EXPERIMENT: Record<string, PreviewImage | null> = {
  "demo":          { url: "/og-exp-e-1200x630-icon.png", width: 1200, height: 630 },
  "harbor-house":  { url: "/og-exp-f-1200x400-icon.png", width: 1200, height: 400 },
  "month-one":     { url: "/og-exp-g-1200x300-lockup.png", width: 1200, height: 300 },
  "red-awning":    null,
};

/** The card for a slug: a demo's experimental one, or the neutral default.
 *  `null` means the demo deliberately declares no image at all.
 *
 *  Returns the default for every slug that is not in the experiment, so a real
 *  Sendset can reach neither an experimental image nor the no-image control by
 *  any path.
 *
 *  `Object.hasOwn`, not a plain lookup: a slug of "constructor" or "toString"
 *  finds Object.prototype's member, which is truthy, and a function would then
 *  be spread into og:image. Slugs are attacker-supplied path segments. */
export function previewImageFor(slug?: string): PreviewImage | null {
  return slug && Object.hasOwn(DEMO_EXPERIMENT, slug) ? DEMO_EXPERIMENT[slug] : RECIPIENT_OG_IMAGE;
}

/** A person's name first, their business second, and an unsigned Sendset last.
 *
 *  The fallback is not decoration: 8 of the 33 Sendsets published before this
 *  was written carry neither name nor business name, so the anonymous title is
 *  a live path, not a defensive one. */
export function recipientTitle(sender: SenderIdentity | null | undefined): string {
  const who = sender?.name?.trim() || sender?.businessName?.trim() || "";
  return who ? `${who} shared this with you` : RECIPIENT_TITLE_ANONYMOUS;
}

export function recipientMetadata(
  sender: SenderIdentity | null | undefined,
  /** The slug, used ONLY to pick the card — never to say anything about the
   *  Sendset. It selects from a fixed map of demo slugs and falls back to the
   *  neutral image, so it cannot put a slug into a tag. */
  slug?: string,
): Metadata {
  const title = recipientTitle(sender);
  const image = previewImageFor(slug);
  return {
    title,
    description: RECIPIENT_DESCRIPTION,
    // A private-by-link page. Any crawler that reaches the URL is told not to
    // index it or follow onward from it.
    robots: { index: false, follow: false },
    openGraph: {
      title,
      description: RECIPIENT_DESCRIPTION,
      siteName: "Sendset",
      type: "website",
      // OMITTED, not empty, when a demo declares no image: `images: []` still
      // emits nothing but reads as an oversight rather than the control it is.
      ...(image ? { images: [{ url: image.url, width: image.width, height: image.height, alt: "Sendset" }] } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: RECIPIENT_DESCRIPTION,
      ...(image ? { images: [image.url] } : {}),
    },
  };
}
