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

export const SEGMENTER_VERSION = "seg-v1";

export interface SegmentBudget {
  maxItems: number;
  maxChars: number;
}

export const DEFAULT_BUDGET: SegmentBudget = { maxItems: 10, maxChars: 6000 };

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

// Group blocks greedily under the budget. Boundaries fall between blocks (never
// inside one). A chunk never ends on a trailing heading — those carry to the next
// chunk so a heading stays with the block it introduces.
export function segment(source: string, budget: SegmentBudget = DEFAULT_BUDGET): Segment[] {
  const src = source;
  if (src.trim().length === 0) return [];
  const blocks = parseBlocks(src);
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
  pushAll(/\n[ \t]*\n/, 3, 1); // blank line (highest)
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
