// ONE PLACE AN ADDRESS BECOMES A MAP LINK.
//
// It was two. `item-card.tsx` built `…/maps/search/<address>` and
// `email-render.ts` built `…/maps/search/?api=1&query=<address>` — the same
// fact, handed to the same provider, in two different shapes, with nothing
// holding them together. Neither was tested, so they could drift further
// without anything failing.
//
// WHAT THIS IS NOT. It is not geocoding, and it never becomes one. Nothing here
// resolves an address to a place, a coordinate or an identifier; it hands the
// professional's own text to the recipient's map application and lets that
// application do the interpreting, in the recipient's browser, at view time.
// No account, no key, no request from this codebase, and nothing derived is
// ever written back. The address remains the fact.
//
// A renderer may show what this returns. It must never store it, and must never
// present it as more precise than the text it came from.

/** The documented Google Maps URLs form. Chosen over the bare
 *  `/maps/search/<query>` path because it is the one Google specifies and
 *  supports — the path form works today by convention, not by contract. */
const SEARCH = "https://www.google.com/maps/search/?api=1&query=";

/**
 * A map link for an address, or null when there is no address to link.
 *
 * Null rather than an empty string, so every caller has to decide what to do
 * with "no address" instead of rendering a link to a search for nothing.
 */
export function addressMapUrl(address: unknown): string | null {
  const text = String(address ?? "").trim();
  if (!text) return null;
  // encodeURIComponent, not a hand-rolled escape: an address legitimately
  // contains "&", "#" and "+" (as in "Smith & Sons", "Apt #3", "A+B Court"),
  // and each of those silently truncates or corrupts an unescaped query.
  return `${SEARCH}${encodeURIComponent(text)}`;
}

/**
 * The packet's own map link, if it is one a recipient can follow.
 *
 * WHY THIS IS SHARED RATHER THAN CHECKED FIVE TIMES. `packets.map_url` is
 * free text on the write path and reaches five renderers, and each of them had
 * — or would have grown — its own idea of what counted. Web and Preview put the
 * raw string in an href; email and print applied their own local http(s) rule.
 * Five renderers disagreeing about whether a value is renderable is the same
 * defect as three of them dropping it: ONE packet, presented inconsistently.
 *
 * The rule is absolute http(s) and nothing else. It is parsed rather than
 * pattern-matched, so "https://" with no host is refused rather than emitted as
 * a link to nowhere.
 *
 * NOT PROVIDER VALIDATION. Any host is allowed — Google, Apple, OSM, a council
 * planning map, a PDF of a site plan. This asks whether a recipient's browser
 * can follow the link, never who is on the other end of it.
 *
 * THE STORED VALUE IS RETURNED UNCHANGED. Deliberately not `parsed.href`, which
 * appends a trailing slash, lowercases the host and re-encodes the query — the
 * professional's link is the fact, and a renderer does not get to tidy it. The
 * surrounding whitespace is dropped for rendering only; nothing is written back.
 */
export function packetMapUrl(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return text;
}
