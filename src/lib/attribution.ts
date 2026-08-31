// RECORD ATTRIBUTION — from source structure, not from model judgment.
//
// A claim cannot be allowed to disappear because nobody could decide which
// record it belonged to. Where the source structurally PROVES ownership, that
// proof is used, and it is available before the model runs.
//
// This does NOT invent a record parser. seg-v4 already scans the source with
// RFC4180 quote state and returns records that tile it in order
// (`detectSourceRecords`), which is the same envelope the chunk planner uses.
// Re-deriving boundaries here would create a second definition of "a record"
// that could disagree with the one ingestion actually chunked on.
import { detectSourceRecords, detectListRecords, detectDelimitedRecords } from "./segmentation.ts";
import type { Claim, Fragment, AmbiguousUnit } from "./claim-parser.ts";
import { looksLikeHostname } from "./claim-parser.ts";

export interface Envelope {
  index: number;
  start: number;
  end: number;
  /** First field of the row — for a spreadsheet paste this is the record's own
   *  name, which is what lets an envelope be matched to a proposal by identity
   *  rather than by position. */
  name: string;
}

export function recordEnvelopes(source: string, delimiterHint?: string): Envelope[] | null {
  const d = detectSourceRecords(source);
  if (!d) {
    // STRATEGY 2. A pasted directory is often not delimited at all; its
    // structure is a repeated top-level entry marker. Tried only after the
    // tabular strategy declines, so a real table is never reinterpreted.
    const list = detectListRecords(source);
    if (!list) {
      // STRATEGY 3, and only here. When the professional picked a .csv or .tsv
      // the delimiter is a FACT rather than an inference, so the guards that
      // protect prose from being read as a table — three fields, three rows, a
      // record spanning a newline — do not apply. Every ordinary CSV is one
      // line per row, which is exactly what those guards exclude.
      //
      // Consulted LAST on purpose. A hint may only ADD structure where none was
      // provable; it must never override a better answer. A bulleted list saved
      // as .csv is still a bulleted list, and the list strategy reads it more
      // faithfully than a comma scan would.
      const hinted = delimiterHint ? detectDelimitedRecords(source, delimiterHint) : null;
      if (!hinted) return null;              // ownership is not structurally provable
      return hinted.records.map((r, index) => {
        const row = source.slice(r.start, r.end);
        const first = row.split(hinted.delimiter)[0] ?? "";
        return { index, start: r.start, end: r.end, name: first.replace(/^"+|"+$/g, "").trim() };
      });
    }
    return list.records.map((r, index) => ({
      index, start: r.start, end: r.end, name: (list.labels[index] ?? "").slice(0, 120),
    }));
  }
  return d.records.map((r, index) => {
    const row = source.slice(r.start, r.end);
    const first = row.split(d.delimiter)[0] ?? "";
    return { index, start: r.start, end: r.end, name: first.replace(/^"+|"+$/g, "").trim() };
  });
}

export type Attributed<T> = { item: T; record: number | null };

/** Attach each claim/fragment to the envelope whose span contains it.
 *  `base` is the chunk's source_start, so segment offsets become absolute. */
export function attribute<T extends { offset: number }>(
  things: T[], envelopes: Envelope[] | null, base: number,
): Attributed<T>[] {
  return things.map((item) => {
    if (!envelopes) return { item, record: null };
    const abs = base + item.offset;
    const e = envelopes.find((x) => abs >= x.start && abs < x.end);
    return { item, record: e ? e.index : null };
  });
}

export interface AttributionResult {
  byRecord: Map<number, { claims: Claim[]; ambiguous: AmbiguousUnit[]; fragments: Fragment[] }>;
  /** Claims that could not be attributed to any record envelope. They are NOT
   *  dropped — they are counted and reported as ATTRIBUTION_UNRESOLVED. */
  unattributedClaims: Claim[];
  unattributedAmbiguous: AmbiguousUnit[];
  unattributedFragments: Fragment[];
}

export function attributeAll(
  claims: Claim[], ambiguous: AmbiguousUnit[], fragments: Fragment[],
  envelopes: Envelope[] | null, base: number,
): AttributionResult {
  const byRecord = new Map<number, { claims: Claim[]; ambiguous: AmbiguousUnit[]; fragments: Fragment[] }>();
  const unattributedClaims: Claim[] = [];
  const unattributedAmbiguous: AmbiguousUnit[] = [];
  const unattributedFragments: Fragment[] = [];
  const bucket = (i: number) => {
    if (!byRecord.has(i)) byRecord.set(i, { claims: [], ambiguous: [], fragments: [] });
    return byRecord.get(i)!;
  };
  for (const { item, record } of attribute(claims, envelopes, base))
    record === null ? unattributedClaims.push(item) : bucket(record).claims.push(item);
  for (const { item, record } of attribute(ambiguous, envelopes, base))
    record === null ? unattributedAmbiguous.push(item) : bucket(record).ambiguous.push(item);
  for (const { item, record } of attribute(fragments, envelopes, base))
    record === null ? unattributedFragments.push(item) : bucket(record).fragments.push(item);
  return { byRecord, unattributedClaims, unattributedAmbiguous, unattributedFragments };
}

/** Which record envelopes does this chunk's source range overlap, in order? */
export function envelopesInRange(envelopes: Envelope[], start: number, end: number): Envelope[] {
  return envelopes.filter((e) => e.start < end && e.end > start);
}

/** WHICH DELIMITED CELL EACH SOURCE CHARACTER BELONGS TO.
 *
 *  A quoted field may legitimately contain the delimiter and may legitimately
 *  run across several physical lines — "Wi-Fi, 2 wireless mics, display" is ONE
 *  value, and so is a two-line pricing block. So the boundary cannot be found
 *  by splitting on commas or newlines; it needs the quote state, which is what
 *  this single pass carries.
 *
 *  The counter advances at an unquoted delimiter AND at an unquoted newline, so
 *  one number distinguishes both "a different column" and "a different record".
 *  That is deliberate: the two spill shapes observed differ only in how far they
 *  ran, and neither is a valid field value. */
export interface SourceCells {
  source: string;
  /** cell ordinal per character offset */
  map: Int32Array;
}

export function sourceCells(source: string, delimiter: string): SourceCells {
  const s = String(source ?? "");
  const d = delimiter && delimiter.length === 1 ? delimiter : ",";
  const map = new Int32Array(s.length);
  let cell = 0, quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      // "" is an escaped quote INSIDE the field, not the end of it.
      if (ch === '"') {
        if (s[i + 1] === '"') { map[i] = cell; map[++i] = cell; continue; }
        quoted = false;
      }
      map[i] = cell;
      continue;
    }
    if (ch === '"') { quoted = true; map[i] = cell; continue; }
    if (ch === d || ch === "\n") { map[i] = cell; cell++; continue; }
    map[i] = cell;
  }
  return { source: s, map };
}

/** PROVEN TO HAVE CROSSED A CELL BOUNDARY — not merely suspected.
 *
 *  The model split a quoted multi-line pricing block on its first colon, landed
 *  inside the clock time "6:00", and then ran past the field's closing quote and
 *  kept consuming raw CSV — in two cases straight through the record boundary
 *  and into the next venue's columns. The result reached the recipient as a
 *  "detail" carrying another venue's address, contact and private notes.
 *
 *  The test is structural and needs no vocabulary, no title matching and no
 *  guess about which record the value came from: find the value in the source,
 *  and ask whether the text it matched lies inside ONE cell.
 *
 *  IT ONLY EVER SPEAKS FROM EVIDENCE. Three restraints keep it from accusing
 *  ordinary content:
 *
 *    * a value that cannot be located in the source at all is left alone. The
 *      model reformats legitimately ("18 seated"), and absence of a match is
 *      absence of proof, not proof of a defect.
 *    * if ANY occurrence fits inside a single cell, the value is fine. A phrase
 *      that reads naturally as one field somewhere is not condemned because it
 *      also happens to straddle a boundary elsewhere.
 *    * whitespace is compared loosely, because a source newline arrives in the
 *      proposal as a space. Everything else must match exactly.
 *
 *  Measured on the event-planner import: 78 details, 77 locatable, exactly the
 *  4 known spills flagged and no legitimate value touched. */
export function spansCells(cells: SourceCells, value: string): boolean {
  const t = String(value ?? "").trim();
  // Too short to distinguish a spill from a coincidence. The observed spills
  // ran 400-800 characters; nothing near this floor can be shown to have
  // crossed a boundary rather than to have landed on one by chance.
  if (t.length < 24) return false;
  const pattern = t.split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  if (!pattern) return false;
  let re: RegExp;
  try { re = new RegExp(pattern, "g"); } catch { return false; }
  let m: RegExpExecArray | null, found = false;
  while ((m = re.exec(cells.source))) {
    if (!m[0].length) break;
    found = true;
    if (cells.map[m.index] === cells.map[m.index + m[0].length - 1]) return false;
  }
  return found;
}

/** BIND PROPOSALS TO SOURCE RECORDS BY SOURCE-BACKED ANCHORS.
 *
 *  POSITIONAL BINDING WAS UNSAFE and is gone. Adversarial testing showed it
 *  misbinding in four of five cases — reorder, omission, duplication and split
 *  all shifted the i-th item away from the i-th record, and it attached one
 *  record's governed claims to a different record with full confidence. Under
 *  enforcement that writes a community's phone number onto its neighbour.
 *
 *  Identity comes from the DATA instead: emails, URLs and phone numbers appear
 *  in the source, are carried into the proposal, and cannot be invented by the
 *  model. An anchor only identifies if it is UNIQUE to one record — a shared
 *  head-office number identifies nobody.
 *
 *  Binding requires agreement in both directions: exactly one record's anchors
 *  appear in the item, and exactly one item carries that record's anchors.
 *  Merge, split and duplication all violate that and end UNBOUND, which is a
 *  named state (ATTRIBUTION_UNRESOLVED), not a guess. The model is never asked
 *  to reproduce an identity token.
 */
const EMAIL_A = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const URL_A = /https?:\/\/[^\s"'<>)]+/gi;
const PHONE_A = /\+?1?[-.\s(]*\d{3}[-.\s)]*\d{3}[-.\s]*\d{4}/g;

function anchorsOf(text: string): Set<string> {
  const out = new Set<string>();
  const t = String(text ?? "");
  for (const m of t.match(EMAIL_A) ?? []) out.add(`e:${m.toLowerCase()}`);
  // HOSTNAME, NOT THE WRITTEN FORM. The source may say "alpha.example.com" while
  // the proposal carries "https://alpha.example.com/" — the same identity in two
  // spellings. Keying on the raw string meant a source whose only identifier was
  // a bare domain produced NO anchors and could never be bound, which is exactly
  // the shape of a pasted directory.
  //
  // AND THE DELIMITER IS NOT PART OF THE HOST. A URL at the end of a CSV field
  // is followed immediately by the delimiter, and the match class above stops
  // only at whitespace, quotes and brackets — so the SOURCE side produced
  // `harborhouseloft.example,` while the proposal, carrying the same URL in a
  // JSON field, produced `harborhouseloft.example`. The two could never match.
  //
  // That stays invisible until a website is a record's LAST surviving anchor,
  // which is exactly what happens when two records share a contact person: the
  // shared email and phone are correctly discarded as non-unique and the
  // corrupted host is all that is left. Six of the twelve venues in the
  // event-planner import were unbindable by any proposal content for this
  // reason alone — three pairs, each sharing one coordinator.
  //
  // Trimming trailing punctuation is not enough, because the run-on does not
  // always END at the delimiter: `…example,First` swallows the next field whole.
  // What is true regardless is that a HOSTNAME cannot contain a comma, a quote
  // or a space, so the host is cut at the first character that cannot appear in
  // one. Everything past the first `/`, `?` or `#` is already discarded, so this
  // narrows nothing that identity depended on.
  //
  // This is not fuzzy matching: no host is rewritten, nothing is compared
  // approximately, and two hosts differing by a real character still differ.
  // The bare-hostname branch below has always trimmed; the URL branch did not,
  // and that asymmetry was the defect.
  for (const m of t.match(URL_A) ?? []) {
    const host = (m.toLowerCase().replace(/^https?:\/\//, "").split(/[/?#]/)[0]
      .match(/^[a-z0-9.-]*/)?.[0] ?? "")
      .replace(/[.-]+$/, "");
    if (host) out.add(`u:${host}`);
  }
  for (const tok of t.split(/[\s"'<>(),;]+/)) {
    const bare = tok.trim().replace(/[.,;:]+$/, "");
    if (bare && !bare.includes("@") && !/^https?:/i.test(bare) && looksLikeHostname(bare))
      out.add(`u:${bare.toLowerCase().replace(/\.$/, "")}`);
  }
  for (const m of String(text ?? "").match(PHONE_A) ?? []) {
    const d = m.replace(/\D/g, "");
    if (d.length >= 10) out.add(`p:${d.slice(-10)}`);
  }
  return out;
}

export interface Binding<T> {
  bound: Map<number, T>;
  unboundRecords: number[];
  unboundItems: number;
  reasons: string[];
}

export function bindByProvenance<T>(
  envelopes: Envelope[], source: string, items: T[],
): Binding<T> {
  // An anchor shared by two records identifies neither.
  const perRecord = envelopes.map((e) => anchorsOf(source.slice(e.start, e.end)));
  const seen = new Map<string, number>();
  for (const set of perRecord) for (const a of set) seen.set(a, (seen.get(a) ?? 0) + 1);
  const unique = perRecord.map((set) => new Set([...set].filter((a) => seen.get(a) === 1)));

  const itemAnchors = items.map((it) => anchorsOf(JSON.stringify(it)));
  const claims = new Map<number, number[]>();          // record -> item indices
  const itemHits = new Map<number, number[]>();        // item -> record indices
  for (let i = 0; i < items.length; i++) {
    for (let r = 0; r < envelopes.length; r++) {
      if ([...unique[r]].some((a) => itemAnchors[i].has(a))) {
        claims.set(r, [...(claims.get(r) ?? []), i]);
        itemHits.set(i, [...(itemHits.get(i) ?? []), r]);
      }
    }
  }

  const bound = new Map<number, T>();
  const reasons: string[] = [];
  for (let r = 0; r < envelopes.length; r++) {
    const its = claims.get(r) ?? [];
    if (its.length === 0) { reasons.push(`${envelopes[r].name}: no proposal carries its anchors`); continue; }
    if (its.length > 1) { reasons.push(`${envelopes[r].name}: ${its.length} proposals carry its anchors (split or duplicate)`); continue; }
    const i = its[0];
    const recs = itemHits.get(i) ?? [];
    if (recs.length !== 1) { reasons.push(`${envelopes[r].name}: its proposal also carries another record's anchors (merge)`); continue; }
    bound.set(envelopes[r].index, items[i]);
  }
  const boundItems = new Set([...claims.values()].filter((v) => v.length === 1).flat());
  return {
    bound,
    unboundRecords: envelopes.filter((e, r) => !bound.has(e.index) && (claims.get(r) ?? []).length !== 1 || !bound.has(e.index)).map((e) => e.index),
    unboundItems: items.length - boundItems.size,
    reasons,
  };
}

/** @deprecated positional binding — unsafe under reorder/omit/duplicate/split.
 *  Retained only so the adversarial test can keep demonstrating why. */
/** BIND PROPOSALS TO SOURCE RECORDS BY PROVENANCE, NEVER BY TITLE.
 *
 *  The model authors the title and is entitled to vary it: "Enso Village" and
 *  "Ensō Village" are the same community, and a diacritic broke reconciliation
 *  when binding went through the title. Matching on model-authored text makes
 *  the layer's correctness depend on the model's word choice, which is the thing
 *  the whole contract exists to stop relying on.
 *
 *  Structure decides instead: the records a chunk covers are ordered by source
 *  offset, the items the model returned for that chunk are ordered as emitted,
 *  and the i-th item is the i-th record. Where the counts disagree the surplus
 *  on either side is left UNBOUND rather than guessed — an unbound record's
 *  claims become ATTRIBUTION_UNRESOLVED, which is a named state, not a loss. */
export function bindItemsToRecords<T>(
  envelopes: Envelope[], chunkStart: number, chunkEnd: number, items: T[],
): { bound: Map<number, T>; unboundRecords: number[]; unboundItems: number } {
  const covered = envelopesInRange(envelopes, chunkStart, chunkEnd);
  const bound = new Map<number, T>();
  const n = Math.min(covered.length, items.length);
  for (let i = 0; i < n; i++) bound.set(covered[i].index, items[i]);
  return {
    bound,
    unboundRecords: covered.slice(n).map((e) => e.index),
    unboundItems: Math.max(0, items.length - covered.length),
  };
}
