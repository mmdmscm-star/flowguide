import type { Metadata } from "next";

// THE METADATA BOUNDARY BETWEEN MARKETING AND A CLIENT.
//
// A recipient link is professional correspondence. It is pasted into a text
// message or an email to somebody who is often dealing with something
// difficult, and whatever the unfurl shows arrives as part of that message.
//
// The root layout carries the MARKETING card — headline, promotional
// description, /og.png. Next.js merges metadata SHALLOWLY: a route that sets
// `title` and `description` but not `openGraph` still inherits the parent's
// entire OpenGraph block. Both recipient routes did exactly that, so a private
// FlowGuide sent by iMessage unfurled as "Everything you found, in one thing
// your client can actually use." — a sales pitch stapled to a family's private
// situation. It also inherited og:url, pointing the preview at the marketing
// homepage rather than the packet.
//
// So `openGraph` and `twitter` are declared here IN FULL. Declaring them
// partially would re-inherit the rest.
//
// NEUTRAL BY CONSTRUCTION, and that is the load-bearing property: this object
// is a constant. It takes no packet, no slug and no arguments, so there is no
// code path by which a packet title, a client name, a personal note or a
// subject matter could reach a preview card. One image is served for every
// recipient link. Per-packet OG images are deliberately not built — a
// generated card is a way to leak private content into an unfurl cache that
// FlowGuide does not control and cannot retract.
//
// `og:url` is deliberately absent. Emitting the packet URL would be redundant
// (it is the link being shared) and emitting anything else would be wrong —
// which is what inheriting the homepage URL was.
export const RECIPIENT_TITLE = "Sendset";
export const RECIPIENT_DESCRIPTION = "A Sendset has been shared with you.";
const RECIPIENT_OG_IMAGE = "/og-recipient.png";

export const recipientMetadata: Metadata = {
  title: RECIPIENT_TITLE,
  description: RECIPIENT_DESCRIPTION,
  // A private-by-link page. Any crawler that reaches the URL is told not to
  // index it or follow onward from it.
  robots: { index: false, follow: false },
  openGraph: {
    title: RECIPIENT_TITLE,
    description: RECIPIENT_DESCRIPTION,
    siteName: "Sendset",
    type: "website",
    images: [{ url: RECIPIENT_OG_IMAGE, width: 1200, height: 630, alt: "Sendset" }],
  },
  twitter: {
    card: "summary_large_image",
    title: RECIPIENT_TITLE,
    description: RECIPIENT_DESCRIPTION,
    images: [RECIPIENT_OG_IMAGE],
  },
};
