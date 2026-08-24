// CREATOR-SUPPLIED MEDIA — one rule, stated once, consulted by both provenance
// systems.
//
// FlowGuide has two independent checks that ask where a photo came from:
//
//   media-ledger.ts     — does every photo the SOURCE lists appear in the
//                         packet, and is anything stored that the source never
//                         mentioned? (`media_not_in_source` blocks publishing.)
//   media-ownership.ts  — for a photo the source DOES list, is it attached to
//                         the record the source puts it under?
//
// Both were built when every photo arrived by AI import, so "no source
// provenance" and "unauthorized" were the same thing. A file the authenticated
// creator uploads through FlowGuide breaks that equivalence: it is their own
// content, it will never appear in any source text, and it needs no provenance
// to be authorized. Without this rule the next finalize of ANY run on that
// packet would report it as `media_not_in_source` and park the packet in
// review — a blocking failure caused by using the product correctly.
//
// THE DISCRIMINATOR IS THE URL, and deliberately not `item_photos.storage_path`.
//
// storage_path looks like the natural home for this, but it is written by
// `update_item_content` (0011) — the single atomic writer shared by both
// editors — which hardcodes '' and takes photos as a plain array of URLs.
// Teaching it to carry a path means re-issuing that RPC and changing the editor
// payload, which is a large change to a mature write path for a small feature.
//
// The URL proves the same thing on its own. This path exists in exactly one
// bucket, that bucket grants no insert to anon or authenticated, and every
// object in it was written by a server route that had already checked the
// session owns the packet. A URL under it is therefore something this
// application stored on a creator's behalf.
//
// This is a RULE, not a bypass. Both call sites consult it by name.

/** The public object path for the packet-photos bucket. Matched as a path
 *  rather than a full origin so it survives a project-URL change and needs no
 *  environment access, which keeps this module pure and testable. */
export const CREATOR_UPLOAD_PATH = "/storage/v1/object/public/packet-photos/";

export function isCreatorUploaded(url: string | null | undefined): boolean {
  const u = String(url ?? "").trim();
  if (!/^https:\/\//i.test(u)) return false;
  const at = u.indexOf(CREATOR_UPLOAD_PATH);
  // Must be a real path segment with an object name after it - not a query
  // parameter that merely contains the string.
  return at > 0 && u.length > at + CREATOR_UPLOAD_PATH.length && !u.slice(0, at).includes("?");
}
