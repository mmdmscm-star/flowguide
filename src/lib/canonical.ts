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

/** A canonical URL: scheme and host lowercased, default port dropped. The path
 *  is left exactly as written — path case can be significant, and a server that
 *  distinguishes /A from /a is not ours to second-guess. */
export function canonicalUrl(raw: string): string {
  const s = tidy(raw);
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
