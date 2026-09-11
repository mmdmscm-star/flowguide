import type { Packet } from "./types.ts";
import { samplePacket } from "./sample-data.ts";

// EVERY PUBLIC DEMO, IN ONE LIST.
//
// There used to be exactly one, and five places in the app knew its slug by
// heart: two route resolvers, the owner-bar lookup, the view counter, and the
// fixture itself. Adding a second demo meant finding all five and hoping.
//
// THE REASON THIS IS A LIST RATHER THAN A CONSTANT is the guard, not the
// routing. `public-surface.test.mts` audits a demo for things that cannot be
// seen by reading a diff: that every business, person, price, phone number,
// address and domain in it is invented; that phones sit in the 555-01xx block
// reserved for fiction and domains in .example.com; that no `notes` field
// exists to leak into the RSC payload; that no word appears which must never
// be on a public surface. It audited ONE object. A second fixture would have
// rendered on a live URL with none of that applied, and the suite would have
// stayed green — the check would have been passing about the wrong packet.
//
// So the guard iterates THIS, and a demo that is not in here is not served.
// Adding a fixture to the array is what puts it under the rules.
export const PUBLIC_DEMOS: readonly Packet[] = [
  samplePacket,
];

const BY_SLUG: ReadonlyMap<string, Packet> =
  new Map(PUBLIC_DEMOS.map((p) => [p.slug, p]));

/** The demo at this slug, or null. Works with no database configured — which
 *  is the point of a demo: the landing page's primary call to action must not
 *  depend on anything that can be down. */
export function publicDemo(slug: string): Packet | null {
  return BY_SLUG.get(slug) ?? null;
}

/** Is this slug a demo rather than somebody's Sendset?
 *
 *  Used where the answer changes behaviour rather than content: a demo has no
 *  owner to look up and no view to record. `viewed` means "the client has seen
 *  this", and counting demo traffic would put a number nobody sent anywhere. */
export function isPublicDemo(slug: string): boolean {
  return BY_SLUG.has(slug);
}
