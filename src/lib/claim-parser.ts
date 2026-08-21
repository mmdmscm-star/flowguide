// THE CLAIM PARSER — the trust boundary.
//
// Reconciliation can only guarantee what this file detects. A fact it misses is
// counted nowhere, repaired nowhere and surfaced nowhere, which is the exact
// silent loss the whole layer exists to end. So this parser is deliberately
// conservative about what it CLAIMS and deliberately loud about what it does
// not: everything it declines becomes a FRAGMENT with a stated reason, and
// fragments are reported, never dropped.
//
// It is written against the real source, not tidy fixtures — wrapped values,
// orphaned continuations, repeated labels, digit-bearing labels, and prose
// glued onto the end of a labelled line.
import { probe } from "./fact-match.ts";

export type ClaimKind = "labelled" | "url" | "email" | "phone";
export interface Claim {
  id: string;
  kind: ClaimKind;
  label?: string;
  value: string;
  line: number;
  /** Offset of this claim's block within the segment. Added to the chunk's
   *  source_start it gives an absolute source offset, which is what lets a
   *  claim be attributed to a record envelope BEFORE the model runs. */
  offset: number;
  raw: string;
}
export interface Fragment { line: number; offset: number; text: string; reason: string }

/** RECOGNIZED, BUT NOT RESOLVABLE.
 *
 *  A priced line the parser can see carries a fact, but whose amount cannot be
 *  confidently paired with a descriptor. It must not be turned into a claim —
 *  that would be guessing — and it must not fall outside the accounting
 *  universe either, which would recreate the silent-loss hole one level down.
 *  So it is its own kind of source unit: recognized, spanned, attributed, and
 *  always resolved as SOURCE_UNRESOLVED. */
export interface AmbiguousUnit {
  id: string;
  line: number;
  offset: number;
  text: string;
  reason: string;
  /** What the parser could read, without asserting how the parts pair up. */
  amounts: string[];
}
export interface ParseResult { claims: Claim[]; ambiguous: AmbiguousUnit[]; fragments: Fragment[] }

// A LABEL IS A SHORT NOUN PHRASE, not a clause. Same rule as the fact ledger:
// grammar, never digits — `2nd Person Fee` and `Level 2 Care` are labels.
const MAX_LABEL_WORDS = 5;
const CLAUSE_MARKERS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "there",
  "was", "were", "is", "are", "be", "been", "being",
  "has", "have", "had", "will", "would", "should", "could",

]);
// A LEAD-IN OPENS LIKE A SENTENCE; A LABEL OPENS LIKE A NAME.
//
// "One thing to remember:", "A quick reminder before you call:", "What the
// family said afterwards:" all begin with a determiner or a wh-word and then
// run on. Labels do not: "Community Fee", "Time to Completion", "Distance to
// Airport", "Steps to Apply".
//
// An earlier version banned a lowercase "to" outright. That was derived from one
// corpus and it rejected every legitimate label above — a recall failure
// invented to fix a precision failure. The opener test is structural: it looks
// at how the phrase STARTS, not at which words it happens to contain.
//
// The length guard matters because "One Bedroom" is a real label in senior
// living and in rentals. A determiner opener alone is not enough to reject; it
// has to open like a determiner AND keep going like a clause.
const LEAD_IN_OPENERS = new Set([
  "a", "an", "the", "this", "that", "these", "those",
  "what", "which", "who", "when", "where", "why", "how",
  "one", "some", "any", "thing", "things", "here", "there",
]);
const LEAD_IN_MIN_WORDS = 4;
function opensLikeAClause(words: string[]): boolean {
  const first = (words[0] ?? "").replace(/[^A-Za-z]/g, "").toLowerCase();
  return LEAD_IN_OPENERS.has(first) && words.length >= LEAD_IN_MIN_WORDS;
}
function looksLikeLabel(label: string): boolean {
  // A PARENTHETICAL QUALIFIER IS PART OF THE LABEL, NOT A CLAUSE.
  // "Memory Care Private Studio (shared bath)" is six words and a perfectly
  // ordinary label; "A quick reminder before you call" is six words and prose.
  // Raising the cap would admit both, so the qualifier is excluded from the
  // count instead — which is what it is: an identity, not a sentence.
  const counted = label.replace(/\([^)]*\)/g, " ").trim();
  const words = counted.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > MAX_LABEL_WORDS) return false;
  if (opensLikeAClause(words)) return false;
  return !label.trim().split(/\s+/).some((w) => {
    const bare = w.replace(/[^A-Za-z]/g, "");
    return bare.length > 0 && bare === bare.toLowerCase() && CLAUSE_MARKERS.has(bare);
  });
}

const LABEL_RE = /^\s*[-•*]?\s*([A-Za-z0-9][A-Za-z0-9 /&()'’.+-]{0,47}):\s*(.*)$/;
const URL_RE = /https?:\/\/[^\s"'<>)]+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const PHONE_RE = /\+?1?[-.\s(]*\d{3}[-.\s)]*\d{3}[-.\s]*\d{4}/g;

// A value that trails off mid-clause continues on the next line. Vine Ridge:
//   "Care Costs: Additional monthly fee based on level of care. Maximum care
//    level fee for"  /  "Assisted Living $3,700."
const CONTINUES = /[,;:]$|\b(for|of|to|and|or|with|the|a|an|from|per|than|based on|including)$/i;

/** Join wrapped continuation lines onto the value they belong to. */
function joinWrapped(lines: { text: string; offset: number }[]): { text: string; line: number; offset: number }[] {
  const out: { text: string; line: number; offset: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i].text.trim();
    if (!cur) continue;
    let text = cur, n = i;
    while (n + 1 < lines.length) {
      const next = (lines[n + 1]?.text ?? "").trim();
      if (!next) break;
      const carriesOn = CONTINUES.test(text);
      const nextStartsSomethingNew = LABEL_RE.test(next) || /^[-•*]/.test(next) || /^https?:/i.test(next);
      if (!carriesOn || nextStartsSomethingNew) break;
      text = `${text} ${next}`;
      n++;
    }
    out.push({ text, line: i, offset: lines[i].offset });
    i = n;
  }
  return out;
}

// PROSE GLUED ONTO A LABELLED LINE. Atria:
//   "- Second Person Fee: $2,095 (2BR) Pricing for apartments at Atria … are
//    listed on their website when units are available."
// The claim is `$2,095 (2BR)`; the sentence after it is not a claim and must
// not be silently absorbed into a detail value.
//
// Split only where an independent clause plainly begins — a capitalised word
// followed closely by a finite verb — AND only when a real value already
// precedes it. That guard is what keeps `Care Costs: Prices are all-inclusive…`
// intact: its clause starts at position zero, so there is nothing to split off.
const FINITE = /^(is|are|was|were|vary|varies|will|can|may|reflects|reflect|listed|depends|depend|include|includes|start|starts|range|ranges)$/i;
function splitTrailingProse(value: string): { value: string; trailing?: string } {
  const toks = value.split(/\s+/);
  for (let i = 1; i < toks.length; i++) {
    if (!/^[A-Z][a-z]/.test(toks[i])) continue;
    const window = toks.slice(i + 1, i + 11);
    if (!window.some((t) => FINITE.test(t.replace(/[^A-Za-z]/g, "")))) continue;
    const head = toks.slice(0, i).join(" ").trim();
    const tail = toks.slice(i).join(" ").trim();
    if (!head || tail.split(/\s+/).length < 8) continue;   // need a real value AND a real sentence
    return { value: head, trailing: tail };
  }
  return { value };
}

// THE SOURCE IS TAB-SEPARATED. A spreadsheet paste puts every column of a
// record on ONE physical line, with multiline cells quoted. So the first line of
// a record reads:
//
//   Vine Ridge Senior Living⇥Cloverdale⇥"Type: AL, MC
//
// A line-oriented parser sees no label there and silently loses `Type: AL, MC`.
// That is precisely the trust-boundary failure this layer exists to prevent, so
// cells are separated before anything else happens. Quote state is not tracked
// across chunk boundaries — a chunk can begin mid-cell — so stray delimiters are
// trimmed per block rather than parsed as a document.
function cells(segment: string): { text: string; offset: number }[] {
  const src = String(segment ?? "");
  const out: { text: string; offset: number }[] = [];
  let at = 0;
  for (const raw of src.split(/[\n\t]/)) {
    out.push({ text: raw.trim().replace(/^"+/, "").replace(/"+$/, "").replace(/""/g, '"').trim(), offset: at });
    at += raw.length + 1;
  }
  return out;
}

export function parseClaims(segment: string, chunkOrdinal = 0): ParseResult {
  const claims: Claim[] = [];
  const ambiguous: AmbiguousUnit[] = [];
  const fragments: Fragment[] = [];
  let seq = 0;
  const id = (line: number) => `${chunkOrdinal}:${line}:${seq++}`;

  const blocks = joinWrapped(cells(segment));
  for (let bi = 0; bi < blocks.length; bi++) {
    const { text, line, offset } = blocks[bi];
    const prev = bi > 0 ? blocks[bi - 1].text : "";
    // A URL is not a labelled line. "https://x/a.jpg" otherwise parses as the
    // label "https" with the value "//x/a.jpg".
    const isUrlLine = /^\s*[-•*]?\s*https?:\/\//i.test(text);
    const m = isUrlLine ? null : LABEL_RE.exec(text);
    if (m && looksLikeLabel(m[1])) {
      const label = m[1].trim();
      const rest = m[2].trim();
      if (!rest) { fragments.push({ line, offset, text, reason: "label with no value" }); continue; }
      const { value, trailing } = splitTrailingProse(rest);
      claims.push({ id: id(line), kind: "labelled", label, value, line, offset, raw: text });
      if (trailing) fragments.push({ line, offset, text: trailing, reason: "prose appended to a labelled line" });
      continue;
    }
    // Unlabelled lines: still claim anything with an unambiguous identity.
    let claimedHere = false;
    for (const [re, kind] of [[URL_RE, "url"], [EMAIL_RE, "email"], [PHONE_RE, "phone"]] as const) {
      re.lastIndex = 0;
      for (const hit of text.match(re) ?? []) {
        claims.push({ id: id(line), kind, value: hit, line, offset, raw: text });
        claimedHere = true;
      }
    }
    if (!claimedHere) {
      // NOT A CLAIM. Room lists like "- $4,090/month One Bedroom" carry real
      // pricing but no label, so their structure is the model's judgement to
      // make. Declining them here is the honest position: the layer cannot
      // guarantee what it cannot identify, and pretending otherwise would be
      // the more dangerous error.
      const money = containsMoney(text);
      if (money.length)
        ambiguous.push({ id: id(line), line, offset, text,
          reason: "unlabelled monetary fragment — ownership not structurally provable",
          amounts: money });
      else
        fragments.push({ line, offset, text, reason: /\d/.test(text) ? "unlabelled content carrying numbers" : "unlabelled prose" });
    }
  }
  return { claims, ambiguous, fragments };
}

/** Claims whose value is itself a specialized identity (Email Address: x@y.com). */
export function specializedValueKind(c: Claim): ClaimKind | null {
  if (c.kind !== "labelled") return c.kind;
  const k = probe(c.value).kind;
  return k === "url" || k === "email" || k === "phone" ? k : null;
}

// ---------------------------------------------------------------------------
// UNLABELLED MONEY — RECOGNIZED, NEVER ASSOCIATED.
//
// The previous version claimed a descriptor/amount pair when it recognised the
// descriptor's words. That word list was senior-living vocabulary, and the
// cross-vertical audit showed two failures: recall collapsed in other
// industries, and worse, the SAFETY GUARD inverted — "Plated Dinner" was not a
// recognised descriptor, so a shifted pairing in a catering menu was accepted as
// confident where the identical shape in senior living was correctly refused.
//
// A safety mechanism whose failure mode depends on the vertical is worse than
// none, so the lexical class is gone and is NOT replaced with words from the new
// corpus. What remains is deterministic and horizontal:
//
//   * a monetary fragment is RECOGNIZED to exist,
//   * its source span and record provenance are preserved,
//   * ownership between amount and descriptor is never inferred,
//   * it is classified SOURCE_UNRESOLVED.
//
// Money detection may surface possible unresolved source material. It may never
// drive a repair on its own. A positional/run-shape approach is a separate
// experiment and must prove itself across verticals before entering enforcement.
const MONEY = /(?:[$£€]|\bUSD\b|\bEUR\b|\bGBP\b)\s?\d[\d,]*(?:\.\d{2})?/gi;

/** Does this unlabelled block contain money? Recognition only — no pairing. */
export function containsMoney(text: string): string[] {
  MONEY.lastIndex = 0;
  return (text.match(MONEY) ?? []).map((a) => a.replace(/[^\d]/g, ""));
}
