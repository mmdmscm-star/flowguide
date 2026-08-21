// Fact accounting for one ingested segment.
//
// WHY. Corpus v2 measured that a value written as a RANGE survives the model
// roughly one time in eight, and a prose-qualified value about four times in
// five — and when it does not survive it is not misplaced, it is gone. No error,
// no partial value, nothing a professional could notice.
//
// This detects what a segment contains, then checks the model's result for each
// one. It is the same shape as media-ledger.ts, whose comment states the case:
// counting is the only defense against a silent loss, because the failure is
// ABSENCE and no per-value validation can see it.
//
// OBSERVE ONLY. Nothing here repairs, surfaces, strips or reroutes. It produces
// a record; acting on that record is a later, separate decision.

import { presentInItem, probe } from "./fact-match.ts";

export type FactKind = "keyvalue" | "range" | "money" | "phone" | "email" | "url" | "percent";

export interface DetectedFact {
  /** chunk:offset:kind — stable and addressable within a run. */
  id: string;
  kind: FactKind;
  /** The distinctive value, as written. */
  text: string;
  /** The whole line it came from, for showing a human later. */
  line: string;
  /** For a keyvalue fact, the label the source itself gave. */
  label?: string;
  /**
   * TIER-1 ELIGIBILITY, and deliberately narrow.
   *
   * A key/value fact may be preserved verbatim as a detail ONLY when it has no
   * more specific source-backed destination. `Website: https://…` is a link,
   * `Phone: 707-555-0100` belongs to a contact — routing those into details
   * would make details a universal sink for anything the model happened to drop,
   * which is a worse failure than the one being fixed.
   */
  detailEligible: boolean;
}

export type FactStatus = "accounted" | "unaccounted";
export interface LedgerFact extends DetectedFact { status: FactStatus }
export interface FactLedger {
  facts: LedgerFact[];
  counts: { detected: number; accounted: number; unaccounted: number };
}

const RANGE_RE =
  /(?:ranges?\s+from\s+)?\$\s?[\d,]+(?:\.\d{2})?\s*(?:to|through|[–—-])\s*\$?\s?[\d,]+(?:\.\d{2})?|between\s+\$\s?[\d,]+\s+and\s+\$?\s?[\d,]+/gi;
const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d{2})?/g;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;
const PERCENT_RE = /\b\d{1,3}(?:\.\d+)?\s?%/g;
// A LABEL IS A SHORT NOUN PHRASE; A PROSE LEAD-IN IS A CLAUSE.
//
// "Notes from the tour on 4 March: the dining room was busy…" is literally
// `Label: value` shaped, and reading it as a fact produced nine false positives
// per corpus run. The first fix banned digits from labels — which was
// overfitting to this corpus, because `2nd Person Fee`, `Level 2 Care`,
// `24-Hour Support` and `Studio 1` are labels professionals genuinely type.
//
// Digits are not the signal. GRAMMAR is. A label is a short noun phrase; a
// lead-in is a clause, and clauses carry determiners and verbs that labels do
// not. Two independent cheap tests, either of which is enough to reject:
//
//   * more than five words — "Notes from the tour on 4 March" is seven
//   * a LOWERCASE determiner or auxiliary verb — "the", "was", "is"
//
// The lowercase requirement matters: `Care Level A` and `Building B` are real
// labels, and a case-blind stop-word test would throw them away.
const MAX_LABEL_WORDS = 5;
const CLAUSE_MARKERS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "there",
  "was", "were", "is", "are", "be", "been", "being",
  "has", "have", "had", "will", "would", "should", "could",
  // "to" marks an infinitive, which makes a lead-in, not a label: "One thing to
  // remember:" would otherwise become a claim and — under enforcement — a bogus
  // Detail reading "One thing to remember | the waitlist moves fast". No label
  // in any validated fixture or in the real source uses a lowercase "to".
  "to",
]);
function looksLikeLabel(label: string): boolean {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > MAX_LABEL_WORDS) return false;
  return !words.some((w) => {
    const bare = w.replace(/[^A-Za-z]/g, "");
    // Lowercase-only: "A" in `Studio A` is a label word, "a" in prose is not.
    return bare.length > 0 && bare === bare.toLowerCase() && CLAUSE_MARKERS.has(bare);
  });
}

// Digits are allowed anywhere in a label. looksLikeLabel decides, not the shape.
const KV_RE = /^([A-Za-z0-9][A-Za-z0-9 /&()'’.+-]{0,47}):\s*(\S.*)$/;

const PLAIN_RANGE_RE =
  /\b\d+\s*(?:to|through|[–—-])\s*\d+\s+(?:month|months|day|days|week|weeks|year|years|hour|hours)\b/gi;

/** A key/value whose VALUE is itself a specialised type belongs in that field. */
function specialisedValue(value: string): boolean {
  const p = probe(value.trim());
  return p.kind === "url" || p.kind === "email" || p.kind === "phone";
}

/**
 * Detect the facts a segment contains.
 *
 * Precision matters more than recall here: an unresolved list a professional
 * learns to ignore is worse than no list. Detection is therefore restricted to
 * shapes that are unambiguous on sight.
 */
export function detectFacts(segmentText: string, chunkOrdinal: number): DetectedFact[] {
  const out: DetectedFact[] = [];
  const seen = new Set<string>();
  const push = (kind: FactKind, text: string, offset: number, line: string,
                extra: { label?: string; detailEligible?: boolean } = {}) => {
    const t = text.trim();
    if (!t) return;
    const key = `${kind}:${t.toLowerCase()}`;
    if (seen.has(key)) return;         // the same fact twice in one segment is one fact
    seen.add(key);
    out.push({ id: `c${chunkOrdinal}:${offset}:${kind}`, kind, text: t, line: line.trim(),
               label: extra.label, detailEligible: extra.detailEligible ?? false });
  };

  let cursor = 0;
  for (const line of segmentText.split("\n")) {
    const lineStart = cursor;
    cursor += line.length + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;

    const kv = KV_RE.exec(trimmed);
    if (kv && looksLikeLabel(kv[1])) {
      const [, label, value] = kv;
      push("keyvalue", value, lineStart, line, {
        label: label.trim(),
        // Tier-1 eligible only when nothing more specific claims it.
        detailEligible: !specialisedValue(value),
      });
    }

    // Ranges are detected on every line, including inside a key/value value and
    // inside prose — they are the highest-loss shape and the reason for this file.
    for (const m of trimmed.matchAll(RANGE_RE)) push("range", m[0], lineStart + (m.index ?? 0), line);
    for (const m of trimmed.matchAll(PLAIN_RANGE_RE)) push("range", m[0], lineStart + (m.index ?? 0), line);
    for (const m of trimmed.matchAll(URL_RE)) push("url", m[0], lineStart + (m.index ?? 0), line);
    for (const m of trimmed.matchAll(EMAIL_RE)) push("email", m[0], lineStart + (m.index ?? 0), line);
    for (const m of trimmed.matchAll(PHONE_RE)) push("phone", m[0], lineStart + (m.index ?? 0), line);
    for (const m of trimmed.matchAll(PERCENT_RE)) push("percent", m[0], lineStart + (m.index ?? 0), line);
    // Money is only recorded on its own when the line is NOT a key/value pair —
    // otherwise every priced row would be counted twice, once as each kind.
    if (!kv) for (const m of trimmed.matchAll(MONEY_RE)) push("money", m[0], lineStart + (m.index ?? 0), line);
  }
  return out;
}

/**
 * Check each detected fact against the model's result.
 *
 * PRESENCE, NOT PLACEMENT. A fact found anywhere in any item counts as
 * accounted. Misplacement is a different failure class and is not judged here.
 */
export function reconcile(detected: DetectedFact[], items: Record<string, unknown>[]): FactLedger {
  const facts: LedgerFact[] = detected.map((f) => ({
    ...f,
    status: items.some((it) => presentInItem(it, f.text)) ? "accounted" : "unaccounted",
  }));
  return {
    facts,
    counts: {
      detected: facts.length,
      accounted: facts.filter((f) => f.status === "accounted").length,
      unaccounted: facts.filter((f) => f.status === "unaccounted").length,
    },
  };
}

// One chunk's ledger, from the segment the model saw and the result it returned.
//
// BOTH ENTRY-POINT SHAPES, because the ledger has to work wherever ingestion
// runs — `section_append` returns `{items}` and `organize` returns
// `{sections:[{items}]}`. Reading only one of them would leave half of the
// pipeline silently unmeasured, which is the exact failure mode 0024 was
// written to end.
//
// PURE. It reads, counts and returns; it does not repair, reroute, strip or
// surface anything. Steps 4-6 are not built.
export function buildChunkLedger(
  segmentText: string,
  chunkOrdinal: number,
  result: unknown,
): FactLedger {
  const r = (result ?? {}) as { items?: unknown; sections?: unknown };
  const fromSections = Array.isArray(r.sections)
    ? (r.sections as { items?: unknown }[]).flatMap((s) => (Array.isArray(s?.items) ? s.items : []))
    : [];
  const fromItems = Array.isArray(r.items) ? r.items : [];
  const items = [...fromItems, ...fromSections].filter(
    (i): i is Record<string, unknown> => Boolean(i) && typeof i === "object",
  );
  return reconcile(detectFacts(segmentText, chunkOrdinal), items);
}
