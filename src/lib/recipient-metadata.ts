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
// THE PREVIEW SAYS WHO SENT IT, AND NOTHING ELSE ABOUT THE SENDSET. "A Sendset
// has been shared with you" is safe but anonymous: a client who gets a link
// from an advisor they already know has no reason to trust it more than any
// other link in a text message. The sender is the one fact that helps and
// costs nothing — the professional already signs the page, already chose to
// send it, and the recipient already knows who they are.
//
// A DISPLAY IDENTITY, NOT A VERIFIED ONE. The name is whatever the
// professional typed into their own profile. Nothing here may say or imply
// that it has been checked, because it has not been.
//
// THERE IS NO IMAGE, and that is the decision three rounds of real-device
// testing arrived at. The card used to be 1200x630 and it REPEATED THE
// MESSAGE, saying "A Sendset has been shared with you" in large type directly
// above metadata that said a better version of the same thing. Shrinking it
// did nothing: a square is tall whatever its pixel count. Declaring no image
// at all is what produced the small, quiet preview — iMessage and WhatsApp
// both fall back to the site icon, and NEITHER scraped the page for a
// photograph, which was the risk that kept an explicit image here for so long.
// In WhatsApp the explicit-image arm was actively worse: a slivered crop that
// recreated the intrusiveness the whole exercise was removing.
//
// `twitter:card` is `summary`, not `summary_large_image`: a large-image card
// with no image is self-contradictory, and `summary` is the compact form that
// matches what is actually declared.
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
// NO PER-SENDSET IMAGE ROUTE, still and separately. A generated card is a way
// to bake private content into a cache we cannot retract.
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

/** A person's name first, their business second, and an unsigned Sendset last.
 *
 *  The fallback is not decoration: 8 of the 33 Sendsets published before this
 *  was written chose "No sender" in the editor, so the anonymous title is a
 *  deliberate choice being honoured, not missing data being papered over. */
export function recipientTitle(sender: SenderIdentity | null | undefined): string {
  const who = sender?.name?.trim() || sender?.businessName?.trim() || "";
  return who ? `${who} shared a Sendset with you` : RECIPIENT_TITLE_ANONYMOUS;
}

export function recipientMetadata(sender: SenderIdentity | null | undefined): Metadata {
  const title = recipientTitle(sender);
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
    },
    twitter: {
      card: "summary",
      title,
      description: RECIPIENT_DESCRIPTION,
    },
  };
}
