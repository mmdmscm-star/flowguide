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

export type ClaimKind = "labelled" | "url" | "email" | "phone" | "pricing";
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
  /** Pricing claims carry their parsed anchors so matching can be tolerant of
   *  reordering without becoming fuzzy. */
  anchors?: { amounts: string[]; unit?: string; descriptor: string };
}
export interface Fragment { line: number; offset: number; text: string; reason: string }
export interface ParseResult { claims: Claim[]; fragments: Fragment[] }

// A LABEL IS A SHORT NOUN PHRASE, not a clause. Same rule as the fact ledger:
// grammar, never digits — `2nd Person Fee` and `Level 2 Care` are labels.
const MAX_LABEL_WORDS = 5;
const CLAUSE_MARKERS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "there",
  "was", "were", "is", "are", "be", "been", "being",
  "has", "have", "had", "will", "would", "should", "could",
]);
function looksLikeLabel(label: string): boolean {
  // A PARENTHETICAL QUALIFIER IS PART OF THE LABEL, NOT A CLAUSE.
  // "Memory Care Private Studio (shared bath)" is six words and a perfectly
  // ordinary label; "A quick reminder before you call" is six words and prose.
  // Raising the cap would admit both, so the qualifier is excluded from the
  // count instead — which is what it is: an identity, not a sentence.
  const counted = label.replace(/\([^)]*\)/g, " ").trim();
  const words = counted.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > MAX_LABEL_WORDS) return false;
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
  const fragments: Fragment[] = [];
  let seq = 0;
  const id = (line: number) => `${chunkOrdinal}:${line}:${seq++}`;

  const blocks = joinWrapped(cells(segment));
  let prevAmbiguous = false;
  for (let bi = 0; bi < blocks.length; bi++) {
    const { text, line, offset } = blocks[bi];
    const prev = bi > 0 ? blocks[bi - 1].text : "";
    // A URL is not a labelled line. "https://x/a.jpg" otherwise parses as the
    // label "https" with the value "//x/a.jpg".
    const isUrlLine = /^\s*[-•*]?\s*https?:\/\//i.test(text);
    const m = isUrlLine ? null : LABEL_RE.exec(text);
    if (m && looksLikeLabel(m[1])) {
      prevAmbiguous = false;
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
      const priced = pricingClaim(text, prev, prevAmbiguous);
      prevAmbiguous = priced === "ambiguous";
      if (priced === "ambiguous")
        fragments.push({ line, offset, text, reason: "priced line whose descriptor cannot be resolved" });
      else if (priced)
        claims.push({ id: id(line), kind: "pricing", value: text, line, offset, raw: text, anchors: priced });
      else
        fragments.push({ line, offset, text, reason: /\$|\d/.test(text) ? "unlabelled content carrying numbers" : "unlabelled prose" });
    }
  }
  return { claims, fragments };
}

/** Claims whose value is itself a specialized identity (Email Address: x@y.com). */
export function specializedValueKind(c: Claim): ClaimKind | null {
  if (c.kind !== "labelled") return c.kind;
  const k = probe(c.value).kind;
  return k === "url" || k === "email" || k === "phone" ? k : null;
}

// ---------------------------------------------------------------------------
// UNLABELLED PRICING — a bounded claim class, not a "$ means fact" heuristic.
//
// Most real pricing in the diagnostic source carries no label at all:
//
//   One Bedroom $4,090/month          descriptor then amount
//   - $5,710/month Two Bedroom        amount then descriptor
//   Studio (Suite) - from $4,695/month
//   Respite (if available) $450/day
//   $10,000-$15,000/month             a range
//
// Leaving these to the model means they carry no guarantee, and they are the
// bulk of what a professional is actually selling. So they are claimed — but
// only when the pairing is unambiguous.
//
// THE DECEPTIVE CASE, from Vine Ridge, is why confidence has to look backwards:
//
//   Assisted Living/Memory Care Studio      <- dangling descriptor
//   - $4,090/month One Bedroom              <- reads confident, IS NOT
//   - $4,825/month Large One Bedroom
//
// Taken alone, line 2 looks like "amount then descriptor" and would pair
// $4,090 with "One Bedroom". It is wrong: $4,090 belongs to the Studio above,
// and "One Bedroom" belongs to the $4,825 below. A parser that scores this
// confident would silently mis-price a community. When the preceding block is a
// bare descriptor, the association is genuinely ambiguous and says so.
const MONEY = /\$\s?\d[\d,]*(?:\.\d{2})?/g;
const RANGE = /\$\s?\d[\d,]*(?:\.\d{2})?\s*(?:-|–|—|to)\s*\$?\s?\d[\d,]*(?:\.\d{2})?/;
const UNIT = /\/\s*(month|mo|day|night|year|week|hour)\b|\bper\s+(month|day|night|year|week|hour)\b/i;
const DESCRIPTOR_WORD = /\b(studio|bedroom|suite|room|apartment|cottage|villa|shared|private|companion|respite|memory|assisted|independent|skilled|nursing|care|deluxe|alcove|courtyard|occupancy|entrance|second|person|pet|community|fee|level|tier|unit)\b/i;

/** A block that is only a descriptor — no money, not a label, not a URL. */
function isBareDescriptor(text: string): boolean {
  if (!text || MONEY.test(text)) { MONEY.lastIndex = 0; return false; }
  MONEY.lastIndex = 0;
  if (/^\s*https?:/i.test(text) || /:\s*\S/.test(text)) return false;
  return DESCRIPTOR_WORD.test(text) && text.trim().split(/\s+/).length <= 8;
}

export type PricingAnchors = { amounts: string[]; unit?: string; descriptor: string };

/** Returns anchors when the amount/descriptor pairing is unambiguous,
 *  "ambiguous" when a priced line's descriptor cannot be resolved, or null. */
export function pricingClaim(text: string, prevBlock = "", prevWasAmbiguous = false): PricingAnchors | "ambiguous" | null {
  MONEY.lastIndex = 0;
  const amounts = text.match(MONEY) ?? [];
  if (!amounts.length) return null;
  const stripped = text.replace(/^\s*[-•*]\s*/, "").trim();
  if (/:\s*\S/.test(stripped)) return null;              // labelled lines are rung 2, not here

  const isRange = RANGE.test(stripped);
  const distinct = new Set(amounts.map((a) => a.replace(/\D/g, "")));
  // More than one independent amount on a line, and no range, means more than
  // one fact sharing one descriptor. Do not guess which is which.
  if (!isRange && distinct.size > 1) return "ambiguous";

  const first = amounts[0] ?? "", last = amounts[amounts.length - 1] ?? "";
  const before = stripped.slice(0, stripped.indexOf(first)).replace(/[-–—:]\s*$/, "").trim();
  const after = stripped.slice(stripped.indexOf(last) + last.length)
    .replace(UNIT, " ").replace(/^\s*[-–—]\s*/, "").trim();

  const beforeIsDesc = DESCRIPTOR_WORD.test(before);
  const afterIsDesc = DESCRIPTOR_WORD.test(after);

  // The Vine Ridge trap: a dangling descriptor above means the amount's real
  // partner is behind it, and the words after it belong to the NEXT amount.
  // AMBIGUITY PROPAGATES THROUGH A RUN OF PRICED LINES. In Vine Ridge the
  // descriptor shift is systemic: once one amount is orphaned from its
  // descriptor, every following line in the run inherits the same misalignment
  // while looking perfectly confident on its own.
  if (prevWasAmbiguous && !beforeIsDesc) return "ambiguous";
  if (isBareDescriptor(prevBlock) && !beforeIsDesc) {
    // TWO DIFFERENT SHAPES, and the difference is whether the amount line
    // carries a descriptor of its own.
    //
    //   Creekwood — clean alternation, confidently pairable:
    //     - Private Room
    //     - $10,000-$15,000/month        <- no descriptor of its own
    //
    //   Vine Ridge — shifted, genuinely ambiguous:
    //     Assisted Living/Memory Care Studio
    //     - $4,090/month One Bedroom     <- carries a descriptor, which belongs
    //                                       to the NEXT amount, not this one
    if (afterIsDesc) return "ambiguous";
    return {
      amounts: amounts.map((a) => a.replace(/\D/g, "")),
      unit: ((): string | undefined => { const u = UNIT.exec(text); return (u?.[1] ?? u?.[2])?.toLowerCase(); })(),
      descriptor: prevBlock.replace(/^\s*[-•*]\s*/, "").trim(),
    };
  }
  if (beforeIsDesc && afterIsDesc) return "ambiguous";     // descriptors on both sides
  const descriptor = beforeIsDesc ? before : afterIsDesc ? after : "";
  if (!descriptor) return "ambiguous";                     // priced, but nothing to call it

  return {
    amounts: amounts.map((a) => a.replace(/\D/g, "")),
    unit: ((): string | undefined => { const u = UNIT.exec(text); return (u?.[1] ?? u?.[2])?.toLowerCase(); })(),
    descriptor,
  };
}
