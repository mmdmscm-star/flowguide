// EVERY PRICE FLOWGUIDE SHOWS A CLIENT MUST EXIST IN THE SOURCE.
//
// The failure this exists for: one community's source carried TWO pricing
// tables — an original and an "Additional PDF entry / possible updated
// pricing" — and the model produced ranges built from one number of each:
//
//   source  Shared Studio  $5,595-$6,250      (original)
//   source  Shared Studio  $5,200/month       (updated)
//   output  Shared Studio  $5,200-$6,250      <- attested NOWHERE
//
// Nothing was fabricated from thin air; two real tables were blended into a
// range that does not exist. A client could be quoted a floor price no
// document supports. Routing a fact to the wrong field is recoverable; showing
// a price the source never stated is not.
//
// So this is a CHECK, not a prompt. A prompt asks; this verifies, and a value
// that cannot be traced back to the community's own source text is reported
// rather than shown as fact.

/** Every money token in a piece of text, as written. */
const MONEY = /\$\s?\d[\d,]*(?:\.\d{1,2})?/g;

/** Compare by VALUE, not by spelling: "$4500" and "$4,500" are one number, and
 *  a check that treats them as two reports a loss that did not happen. */
export function priceKey(token: string): string {
  const n = String(token).replace(/[^\d.]/g, "");
  if (!n) return "";
  const f = Number(n);
  return Number.isFinite(f) ? String(f) : n;
}

export function pricesIn(text: unknown): string[] {
  return [...String(text ?? "").matchAll(MONEY)].map((m) => m[0]);
}

/** A range as written: "$5,595-$6,250". The PAIR is the claim, so the pair is
 *  what has to be attested — checking the two numbers separately passes a blend
 *  assembled from two different tables, which is exactly how Windsong slipped
 *  through. */
const RANGE = /\$\s?\d[\d,]*(?:\.\d{1,2})?\s*(?:-|–|—|\bto\b)\s*\$?\s?\d[\d,]*(?:\.\d{1,2})?/g;

export function rangesIn(text: unknown): string[] {
  return [...String(text ?? "").matchAll(RANGE)].map((m) => m[0]);
}

/** A range reduced to its two values, so spelling and dash style do not matter. */
export function rangeKey(token: string): string {
  const nums = [...String(token).matchAll(/\d[\d,]*(?:\.\d{1,2})?/g)].map((m) => priceKey(m[0]));
  return nums.join("-");
}

export interface PriceAudit {
  /** Distinct prices the record shows a client. */
  shown: string[];
  /** Those with no counterpart in this community's source. */
  unsupported: string[];
  /** Ranges the record states that the source never states as a range. Each
   *  endpoint may be real while the PAIRING is invented. */
  unsupportedRanges: string[];
  ok: boolean;
}

/**
 * Audit one record's client-facing prices against its own source text.
 *
 * SCOPED TO ONE COMMUNITY on purpose. An earlier version of this check searched
 * every proposal's prices against the WHOLE source and reported almost nothing
 * wrong — a value invented for one community was "found" because a different
 * community happened to list it. The comparison is only meaningful record by
 * record.
 */
export function auditPrices(record: unknown, communitySource: string): PriceAudit {
  const supported = new Set(pricesIn(communitySource).map(priceKey));
  const shown: string[] = [];
  const seen = new Set<string>();
  for (const tok of pricesIn(JSON.stringify(record ?? {}))) {
    const k = priceKey(tok);
    if (!k || seen.has(k)) continue;
    seen.add(k); shown.push(tok);
  }
  const unsupported = shown.filter((t) => !supported.has(priceKey(t)));

  // A range is a claim about a PAIR. "$5,200-$6,250" is unsupported when the
  // source says "$5,595-$6,250" in one table and "$5,200/month" in another,
  // even though both numbers are real.
  const srcRanges = new Set(rangesIn(communitySource).map(rangeKey));
  const unsupportedRanges: string[] = [];
  const seenR = new Set<string>();
  for (const tok of rangesIn(JSON.stringify(record ?? {}))) {
    const k = rangeKey(tok);
    if (!k || seenR.has(k)) continue;
    seenR.add(k);
    if (!srcRanges.has(k)) unsupportedRanges.push(tok);
  }
  return { shown, unsupported, unsupportedRanges,
           ok: unsupported.length === 0 && unsupportedRanges.length === 0 };
}
