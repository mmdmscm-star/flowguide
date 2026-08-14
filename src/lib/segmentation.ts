// ============================================================
// Deterministic natural-boundary segmentation for resilient AI ingestion.
//
// A large source is split into ordered, NON-OVERLAPPING segments whose [start,
// end) char ranges tile the original source EXACTLY (concatenating the slices
// reproduces the source). Splitting happens only at natural boundaries — blank-
// line groups (blocks) and headings — never mid-block, so a person stays with
// their phone/email and a heading stays with its block. Same input + same
// version always yields the same plan, so a run can be re-segmented identically
// and (per the design) is persisted once and never recomputed differently.
//
// The budget is conservative on purpose (see docs/investigations): ~10 ordinary
// items / ~6000 chars per chunk keeps each model call well under the measured
// 60s Vercel limit, rather than approaching it.
// ============================================================

// Bumped for seg-v3 record-atomic segmentation: a strongly-detected delimited
// table now plans one chunk boundary per RECORD instead of per blank-line block.
// Recorded per run, so in-flight runs keep their persisted plan.
export const SEGMENTER_VERSION = "seg-v4";

export interface SegmentBudget {
  maxItems: number;
  maxChars: number;
}

// seg-v2 budget, derived from measured acceptance timings rather than guessed.
//
// Under seg-v1 (maxItems 10 / maxChars 6000) chunks were ITEM-capped at the
// acceptance fixture's density (~405 chars/item, so ~4,000 chars per chunk), and
// the worst observed model call took 37.8s against a 60s function ceiling — only
// ~1.6x headroom, which a slow provider day would erase. Per-item cost at that
// worst case was ~3.8s.
//
// Targeting an ordinary chunk in the 20-30s band: 6 items x ~3.8s ~= 23s worst,
// ~11-19s typical. maxChars is scaled to keep prose-dense (char-capped) chunks
// doing comparable work to a 6-7 item chunk. The tradeoff is deliberately more
// chunks: each is independently claimed, retried and resumable, so extra chunks
// cost wall-clock and calls, while approaching the ceiling costs the whole run.
export const DEFAULT_BUDGET: SegmentBudget = { maxItems: 6, maxChars: 3800 };

export interface Segment {
  ordinal: number;
  sourceStart: number; // inclusive offset into the ORIGINAL source
  sourceEnd: number; // exclusive offset; ranges tile [0, source.length)
  text: string; // source.slice(sourceStart, sourceEnd)
  hash: string; // stable content hash (fnv-1a hex)
}

// Small, dependency-free, deterministic hash (FNV-1a, 32-bit, hex). Works in both
// Node and the browser; stable across runtime versions.
export function segmentHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + s.length.toString(16);
}

interface Block {
  lineStart: number; // offset of this block's first line in the source
  text: string; // the block's own text (no surrounding blank lines)
  isHeading: boolean;
  items: number; // estimated item count contributed by this block
}

// A heading is a short single line with no terminal sentence punctuation — e.g.
// "Recommended Communities". Headings never END a chunk; they lead the next one.
function looksLikeHeading(text: string): boolean {
  if (text.includes("\n")) return false;
  const t = text.trim();
  if (t.length === 0 || t.length > 60) return false;
  if (/[.!?,;:]$/.test(t)) return false;
  // Avoid treating a lone phone/URL/address line as a heading.
  if (/https?:\/\/|@|\d{3}[-.)]/.test(t)) return false;
  return true;
}

// Parse the source into blank-line-separated blocks, recording each block's
// first-line offset so chunk ranges can tile the source exactly.
function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const re = /\n[ \t]*\n/g; // one-or-more blank line(s) separate blocks
  let cursor = 0;
  let m: RegExpExecArray | null;
  const pushBlock = (start: number, end: number) => {
    const raw = source.slice(start, end);
    const text = raw.trim();
    if (text.length === 0) return;
    const heading = looksLikeHeading(text);
    blocks.push({ lineStart: start, text, isHeading: heading, items: heading ? 0 : 1 });
  };
  while ((m = re.exec(source)) !== null) {
    pushBlock(cursor, m.index);
    cursor = m.index + m[0].length;
  }
  pushBlock(cursor, source.length);
  return blocks;
}

// ============================================================
// Record-atomic pre-pass (seg-v3)
//
// A blank line is a fine record separator for prose and a WRONG one for
// delimited data: a spreadsheet cell may legally contain blank lines, so a
// blank-line cut can land in the middle of one row. When the source is
// convincingly a delimited table, records — not blank-line blocks — become the
// unit that must never be split.
//
// This SCANS and never rewrites. The persistence contract depends on
// `segment.text === source.slice(start, end)` and on ranges tiling [0, len)
// exactly; masking quoted newlines would create a second representation of the
// same input. A quote-state scan yields the same information as offsets, with
// no mutation and no offset drift.
// ============================================================

interface ScannedRecord {
  start: number;
  /** Top-level field count with TRAILING EMPTY fields ignored — see below. */
  fields: number;
}

// One left-to-right pass carrying RFC4180 quote state. Inside a quoted field a
// newline and the delimiter are field-internal; a doubled "" is a literal quote.
// Returns null if quoting is still open at EOF — a torn paste is not a table.
//
// Trailing empty fields are excluded from the count on purpose. Selecting a
// range in Excel/Sheets pads rows out to the selection width, and it commonly
// pads some rows and not the last one — the real reported paste scanned as
// 26/26/6 tab fields for three otherwise identical rows. Counting to the last
// NON-EMPTY field makes that 6/6/6. Without this, the detector would decline on
// exactly the input it exists to handle.
function scanRecords(source: string, delim: string): ScannedRecord[] | null {
  const out: ScannedRecord[] = [];
  let inQuotes = false;
  let recStart = 0;
  let fieldIndex = 0;
  let lastNonEmptyField = -1;
  let fieldHasContent = false;
  let i = 0;

  const endField = () => {
    if (fieldHasContent) lastNonEmptyField = fieldIndex;
    fieldHasContent = false;
  };
  const endRecord = () => {
    endField();
    out.push({ start: recStart, fields: lastNonEmptyField + 1 });
    fieldIndex = 0;
    lastNonEmptyField = -1;
  };

  while (i < source.length) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') { fieldHasContent = true; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      if (!/\s/.test(ch)) fieldHasContent = true;
      i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === delim) { endField(); fieldIndex++; i++; continue; }
    if (ch === "\n") { endRecord(); i++; recStart = i; continue; }
    if (!/\s/.test(ch)) fieldHasContent = true;
    i++;
  }
  if (inQuotes) return null;
  if (recStart < source.length) endRecord();
  return out;
}

// Accept a delimiter only on strong STRUCTURAL evidence — never on vocabulary.
// The delimiter is discovered by trial, not configured.
// A row that carries no data of its own and must not be judged as a record.
// Two shapes only, both deliberately narrow:
//
//   1. a cosmetic separator — "----", "====", "***", "___";
//   2. FlowGuide's OWN generated append marker, matched on the exact shapes we
//      emit rather than on "text between dashes". `--- Added ---` comes from
//      finalize_ingestion_run; the timestamped form comes from the append
//      routes via en-US toLocaleString. User text such as
//      "--- Added photos from tour ---" is NOT a separator and is preserved.
//
// Noise never becomes its own block; it attaches to the preceding record.
const SEPARATOR_ROW = /^[\s\-_=*~.·—–]*$/;
const APPEND_MARKER = /^--- Added(?: [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} (?:AM|PM))? ---$/;

function isNoiseRow(fields: number, text: string): boolean {
  if (fields > 1) return false;
  const t = text.trim();
  return SEPARATOR_ROW.test(text) || APPEND_MARKER.test(t);
}

export interface SourceRecord {
  start: number;
  /** exclusive; records tile the source in order */
  end: number;
}

export interface RecordDetection {
  delimiter: string;
  /** modal top-level field count of the data rows */
  fields: number;
  records: SourceRecord[];
  separatorRows: number;
}

/**
 * Structural record detection. Accepts only on evidence, never on vocabulary.
 *
 * seg-v3 required EVERY record to share one field count, so four cosmetic
 * "----" rows in a real spreadsheet paste made it decline, fall back to
 * blank-line blocks, and cut every record — the 2026-08-14 incident. seg-v4
 * excludes noise rows from the shape test and compares the rest against the
 * MODAL count. Genuinely ragged data still declines: that is real ambiguity.
 */
export function detectSourceRecords(source: string): RecordDetection | null {
  for (const delim of ["\t", ",", ";", "|"]) {
    const scanned = scanRecords(source, delim);
    if (!scanned) continue;

    const spans = scanned.map((r, k) => ({
      start: r.start,
      end: k + 1 < scanned.length ? scanned[k + 1].start : source.length,
      fields: r.fields,
    }));
    const nonBlank = spans.filter((r) => source.slice(r.start, r.end).trim().length > 0);
    const data = nonBlank.filter((r) => !isNoiseRow(r.fields, source.slice(r.start, r.end)));
    // A source that is ONE record is trivially aligned: any split falls inside
    // that record, so media ownership cannot be ambiguous.
    if (data.length < 1) continue;

    const tally = new Map<number, number>();
    for (const r of data) tally.set(r.fields, (tally.get(r.fields) ?? 0) + 1);
    const mode = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (mode < 2) continue;
    if (!data.every((r) => r.fields === mode)) continue;

    // A tab is essentially absent from prose; a comma is not.
    if (delim !== "\t") {
      if (mode < 3 || data.length < 3) continue;
      if (!data.some((r) => source.slice(r.start, r.end).trim().includes("\n"))) continue;
    }

    // Noise attaches to the preceding record so ranges keep tiling exactly.
    const records: SourceRecord[] = data.map((r, i) => ({
      start: r.start,
      end: i + 1 < data.length ? data[i + 1].start : source.length,
    }));
    records[0].start = 0;
    return { delimiter: delim, fields: mode, records, separatorRows: nonBlank.length - data.length };
  }
  return null;
}

/** Records as segmenter Blocks, or null when the source is not a table. */
function detectRecords(source: string): Block[] | null {
  const found = detectSourceRecords(source);
  if (!found) return null;
  return found.records.map((r) => ({
    lineStart: r.start,
    text: source.slice(r.start, r.end).trim(),
    isHeading: false,
    items: 1,
  }));
}

// Group blocks greedily under the budget. Boundaries fall between blocks (never
// inside one). A chunk never ends on a trailing heading — those carry to the next
// chunk so a heading stays with the block it introduces.
export function segment(source: string, budget: SegmentBudget = DEFAULT_BUDGET): Segment[] {
  const src = source;
  if (src.trim().length === 0) return [];
  // Records when the source is convincingly a delimited table; blank-line blocks
  // otherwise. Everything downstream — packing, budget, boundaries, tiling — is
  // identical either way, because detectRecords returns the same Block shape.
  const blocks = detectRecords(src) ?? parseBlocks(src);
  if (blocks.length === 0) return [];

  // Build chunk groups as arrays of block indices.
  const groups: number[][] = [];
  let cur: number[] = [];
  let curItems = 0;
  let curChars = 0;

  const blockLen = (b: Block) => b.text.length;

  const flush = () => {
    if (cur.length === 0) return;
    // Peel trailing heading blocks so a chunk never ends on a heading.
    const trailing: number[] = [];
    while (cur.length > 0 && blocks[cur[cur.length - 1]].isHeading) {
      trailing.unshift(cur.pop() as number);
    }
    if (cur.length === 0) {
      // Group was heading(s) only — cannot flush; keep accumulating.
      cur = trailing;
      curItems = cur.reduce((a, i) => a + blocks[i].items, 0);
      curChars = cur.reduce((a, i) => a + blockLen(blocks[i]), 0);
      return;
    }
    groups.push(cur);
    cur = trailing;
    curItems = cur.reduce((a, i) => a + blocks[i].items, 0);
    curChars = cur.reduce((a, i) => a + blockLen(blocks[i]), 0);
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const wouldItems = curItems + b.items;
    const wouldChars = curChars + blockLen(b);
    if (cur.length > 0 && (wouldItems > budget.maxItems || wouldChars > budget.maxChars)) {
      flush();
    }
    cur.push(i);
    curItems += b.items;
    curChars += blockLen(b);
  }
  if (cur.length > 0) groups.push(cur);

  // Convert groups into segments whose ranges tile [0, len) exactly.
  const boundaries: number[] = groups.map((g) => blocks[g[0]].lineStart);
  boundaries[0] = 0; // first chunk absorbs any leading whitespace
  const segments: Segment[] = groups.map((g, gi) => {
    const start = boundaries[gi];
    const end = gi + 1 < boundaries.length ? boundaries[gi + 1] : src.length;
    const text = src.slice(start, end);
    return { ordinal: gi, sourceStart: start, sourceEnd: end, text, hash: segmentHash(text) };
  });
  return segments;
}

// Whether a segment's FIRST block is a heading (a single heading line, not a
// content block). Used to decide continuation below.
export function firstBlockIsHeading(segmentText: string): boolean {
  const firstBlock = segmentText.split(/\n[ \t]*\n/)[0]?.trim() || "";
  return looksLikeHeading(firstBlock);
}

// A chunk that neither begins at source offset 0 nor begins with a heading is a
// CONTINUATION — the spillover of the previous chunk's heading group. finalize
// uses this DETERMINISTIC flag to recombine a heading group split across chunks,
// never by matching the AI's displayed section titles (which could combine two
// genuinely separate sections).
export function isContinuation(sourceStart: number, segmentText: string): boolean {
  return sourceStart > 0 && !firstBlockIsHeading(segmentText);
}

// Adaptive re-split: divide a single [start,end) range into 2+ non-overlapping
// child ranges at the best natural boundary near the midpoint. Used when a chunk
// still times out / truncates. Prefers a blank line, then a line break, then a
// sentence end, then a hard char cut. Returns child ranges that tile [start,end).
export function splitRange(source: string, start: number, end: number): Array<{ start: number; end: number }> {
  if (end - start <= 1) return [{ start, end }];
  const mid = Math.floor((start + end) / 2);
  const region = source.slice(start, end);

  // candidate boundary offsets (absolute) with preference order
  const candidates: Array<{ off: number; pref: number }> = [];
  const pushAll = (re: RegExp, pref: number, advance: number) => {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, "g");
    while ((m = r.exec(region)) !== null) {
      const off = start + m.index + advance;
      if (off > start && off < end) candidates.push({ off, pref });
    }
  };
  // Record starts outrank every text boundary: if the source is a detected
  // table, cutting anywhere else lands inside a row. Detection runs on the WHOLE
  // source (not the slice) so quote state is read from the true start — a slice
  // can begin inside a quoted cell and would scan as unbalanced.
  const records = detectRecords(source);
  if (records) {
    for (const r of records) {
      if (r.lineStart > start && r.lineStart < end) candidates.push({ off: r.lineStart, pref: 4 });
    }
  }
  pushAll(/\n[ \t]*\n/, 3, 1); // blank line
  pushAll(/\n/, 2, 1); // any newline
  pushAll(/[.!?]\s/, 1, 1); // sentence end

  let best: { off: number; pref: number } | null = null;
  for (const c of candidates) {
    if (
      best === null ||
      c.pref > best.pref ||
      (c.pref === best.pref && Math.abs(c.off - mid) < Math.abs(best.off - mid))
    ) {
      best = c;
    }
  }
  const cut = best ? best.off : mid; // hard char cut only if no boundary at all
  return [
    { start, end: cut },
    { start: cut, end },
  ];
}
