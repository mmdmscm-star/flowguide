// THE ADDRESS A SENDSET IS SHARED AT.
//
// Every public URL a creator hands out — Copy link, the client message, the
// email version, the printed page — is built here, from one fixed origin.
//
// It is deliberately NOT the browser's or the request's host. Production answers
// on several aliases (older brand domains, vercel.app hosts), and a link copied
// while signed in on one of them would carry that alias forever: in a text, in
// an inbox, on paper. A shared link has to outlive whichever host it was copied
// from, so it names the canonical one.
//
// Consequence, accepted: a link copied on localhost or a preview deployment
// points at production too.
export const PUBLIC_ORIGIN = "https://sendset.io";

export function publicSendsetUrl(slug: string): string {
  return `${PUBLIC_ORIGIN}/p/${slug}`;
}
