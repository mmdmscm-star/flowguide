import { looksLikeHostname, isLikelyFilename } from "./claim-parser.ts";

// CANONICAL PRESENTATION of a governed source claim.
//
// The source owns the MEANING. FlowGuide owns the RENDERING. The model owns
// neither for a governed claim, so its paraphrase never becomes canonical — that
// is what makes ACCEPTED and REPAIRED produce the same fact instead of two.
//
// THE DEFAULT IS THE SOURCE TEXT. Normalization is a narrow allowlist of
// transforms that can be shown not to change meaning; everything else is
// preserved verbatim. The burden is on the transform, not on the value.
//
// What must NEVER be normalized away, because each one changes what was
// promised: `starting at`, `up to`, `approximately`, ranges, units and
// frequency (`/month`, `/person`), `included`, negation, and conditional
// language. These are not decoration around a number — for a professional
// quoting a price they are the difference between a fact and a misquote.

/** Qualifiers and conditions. Their presence forbids any transform beyond
 *  whitespace, and they are preserved verbatim regardless. */
const SEMANTIC_QUALIFIER =
  /\b(starting at|start(?:s|ing)? from|from|up to|as low as|as much as|approximately|approx\.?|about|around|estimated|est\.?|varies|varying|depends?|depending|included|includes|inclusive|excluded|excluding|not included|no charge|waived|free|per|each|minimum|maximum|min\.?|max\.?|if|when|unless|subject to|based on|required|optional|negotiable|plus|additional)\b|[–—-]|\/|\bto\b|\$\s?[\d,]+\s*(?:-|–|—|to)\s*\$?/i;

export function hasSemanticQualifier(value: string): boolean {
  return SEMANTIC_QUALIFIER.test(String(value ?? ""));
}

/** Always safe: collapse runs of whitespace, trim the ends. Changes no meaning
 *  in any of the value shapes this layer handles. */
const tidy = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Harmless label cleanup: whitespace, a stray trailing colon or dash, and
 *  surrounding bullet punctuation. The wording itself is left alone. */
export function canonicalLabel(label: string): string {
  return tidy(label).replace(/^[-•*]\s*/, "").replace(/[:\-–—\s]+$/, "").trim();
}

/**
 * A link URL as it should be STORED, or null if it is not one.
 *
 * `finalize_ingestion_run` persists a link only when its url is `LIKE 'http%'`,
 * so a bare hostname the model placed correctly at `links[].url` was written
 * nowhere and reported nowhere — the demonstrated silent loss. The writer is
 * right to be strict; what was missing is that nothing supplied the scheme the
 * professional did not type.
 *
 * NARROW BY CONSTRUCTION, in this order:
 *   * an http(s) URL is returned BYTE-IDENTICAL. It is already storable, and
 *     re-rendering it through URL() would add a trailing slash to something
 *     that was already correct.
 *   * any OTHER scheme is refused outright — javascript:, data:, mailto: are
 *     not links to a page, and prefixing them would be worse than dropping.
 *   * a bare hostname is qualified with https://, the same transform
 *     canonicalUrl already documents, and only for a real ICANN registrable
 *     domain. An address containing "@" fails the hostname shape, and a
 *     filename is excluded explicitly.
 *   * everything else returns null and is left to the writer to reject, exactly
 *     as it does today.
 */
export function normalizeLinkUrl(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  // Whitespace anywhere means this is prose that happens to contain a domain,
  // not a url field. Claim extraction, not normalization, is where that belongs.
  if (/\s/.test(s)) return null;

  // A url field routinely carries a path — "example.com/tours". Split it off
  // and validate the HOST, which is what `looksLikeHostname` is strict about;
  // the remainder is reattached exactly as written, because path case and
  // encoding are the server's business and not ours to rewrite.
  const cut = s.search(/[/?#]/);
  const host = cut === -1 ? s : s.slice(0, cut);
  const rest = cut === -1 ? "" : s.slice(cut);
  if (!looksLikeHostname(host) || isLikelyFilename(host)) return null;
  // A bare host written "example.com/" and one written "example.com" are the
  // same site; storing both would be two links to one place.
  return `https://${host}${rest === "/" ? "" : rest}`;
}

/** A canonical URL: scheme and host lowercased, default port dropped. The path
 *  is left exactly as written — path case can be significant, and a server that
 *  distinguishes /A from /a is not ours to second-guess. */
export function canonicalUrl(raw: string): string {
  let s = tidy(raw);
  // A bare hostname is a URL that has not been written out. FlowGuide supplies
  // the scheme deterministically; the model is never asked to add one, and the
  // source is not altered — only its rendering.
  if (s && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && /^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
    return u.toString();
  } catch { return s; }
}

/** NANP formatting when the shape is unambiguous; otherwise untouched. */
export function canonicalPhone(raw: string): string {
  const s = tidy(raw);
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return s;   // extensions, international, anything unproven: leave it
}

/** The domain is case-insensitive; the local part is not, so it is left alone. */
export function canonicalEmail(raw: string): string {
  const s = tidy(raw);
  const at = s.lastIndexOf("@");
  return at < 0 ? s : s.slice(0, at) + "@" + s.slice(at + 1).toLowerCase();
}

export type ValueKind = "url" | "email" | "phone" | "text";

/** The canonical rendering of a claim's value. */
export function canonicalValue(raw: string, kind: ValueKind = "text"): string {
  if (kind === "url") return canonicalUrl(raw);
  if (kind === "email") return canonicalEmail(raw);
  if (kind === "phone") return canonicalPhone(raw);
  // TEXT. Whitespace only — deliberately. Every qualifier, unit, range, negation
  // and condition survives because nothing else is attempted.
  return tidy(raw);
}

/** Did canonicalization change what the value MEANS? Used as an assertion, not
 *  as control flow: if this is ever true the transform is wrong, not the value. */
export function meaningPreserved(before: string, after: string): boolean {
  const strip = (s: string) => String(s ?? "").toLowerCase().replace(/\s+/g, "");
  if (strip(before) === strip(after)) return true;
  // A transform is only allowed to have run for these kinds, and each keeps
  // every digit and letter that carries meaning.
  const digits = (s: string) => (String(s).match(/\d/g) ?? []).join("");
  return digits(before) === digits(after) && !hasSemanticQualifier(before);
}
