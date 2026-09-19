// READING ORDER FOR ONE PDF PAGE — or a refusal.
//
// A PDF does not store text in reading order. It stores drawing instructions,
// in whatever order the producing application happened to write them, and
// pdf.js hands those back as runs of text with coordinates. For a table, that
// order is very often COLUMN BY COLUMN: every name, then every price. Read in
// that order, a price list becomes two unrelated lists, and whatever reads it
// next pairs them up by position. That is the failure this module exists to
// prevent: a value silently attached to the wrong thing.
//
// SO ORDER COMES FROM GEOMETRY, NEVER FROM THE STREAM. Runs are grouped into
// lines by their baseline, each line is read left to right, and a wide gap
// inside a line becomes a TAB — a cell boundary — so a table row comes out as
// one line with its cells in place, whatever order the file wrote them in.
//
// AND WHERE GEOMETRY CANNOT BE SURE, IT REFUSES. Two prose columns also have a
// wide gap down the middle; read row by row they would weld unrelated
// sentences into fake table rows, which is the same misattribution in reverse.
// This module reads column-major only when both sides are unmistakably prose,
// reads row-major only when every split line is unmistakably a table row, and
// otherwise returns `ambiguous`. The caller refuses the whole PDF. Source
// correctness matters more than acceptance rate: a PDF we decline costs the
// professional a copy-and-paste; a PDF we misread costs them a wrong price
// they had every reason to trust.
//
// NOTHING IS INTERPRETED. No de-hyphenation, no header or footer removal, no
// merging of wrapped lines, no Unicode normalization beyond expanding the
// ligature block (\uFB01 → fi). NFKC in particular is refused: it would turn \u00B2 into
// 2 and \u00BD into 1\u20442, silently changing values.
//
// PURE. No pdf.js here — the extractor turns pdf.js output into PdfTextRun and
// calls this. That is what lets the tests state exact geometry, including the
// adversarial stream orders real producers write.

/** One run of text as drawn, in the page's own display space: origin at the
 *  TOP-LEFT, y growing DOWNWARD, `y` at the text's BASELINE, `size` the font
 *  size. `rotated` is true for text not drawn horizontally. */
export interface PdfTextRun {
  str: string;
  x: number;
  y: number;
  width: number;
  size: number;
  rotated: boolean;
}

export type PageLayout =
  | { ok: true; text: string; mode: "empty" | "flow" | "table" | "columns" }
  | { ok: false; reason: "rotated" | "ambiguous" | "undecodable" };

/** Versioned, because the manifest records which rules produced a source. A
 *  change to any threshold below is a change to what a PDF reads as. */
export const LAYOUT_VERSION = "sendset-pdf-layout@1";

// ---------------------------------------------------------------------------
// THRESHOLDS, in units of the font size ("em"). Each is pinned by a test.
// ---------------------------------------------------------------------------

/** Two runs are on one line when their baselines are this close, measured in
 *  the LARGER of the two sizes. Tight enough that single-spaced lines (≈1.2em
 *  apart) never merge; loose enough for a raised superscript, whose offset is a
 *  fraction of the text it belongs to rather than of its own small size. */
const SAME_LINE = 0.5;
/** A gap this small is one word split into several runs (kerning). */
const NO_SPACE = 0.12;
/** A gap this wide is a CELL boundary, not a word space. Justified prose
 *  stretches word spaces to well under this; table columns sit well over it.
 *  A table whose columns are closer than this simply keeps its cells joined
 *  by a space — still on one line, still paired — which fails safe. */
const CELL_GAP = 2.0;
/** A PARAGRAPH BREAK is a baseline step that stands out from the page's own
 *  line spacing — not a fixed distance. A table drawn with generous rows, or a
 *  double-spaced letter, steps evenly and has no paragraph inside it; a fixed
 *  threshold turned every row of such a table into its own paragraph. A break
 *  is kept as a blank line: how every other input to Sendset marks one, and
 *  what the segmenter reads as a block boundary. */
const PARAGRAPH_RATIO = 1.4;
const PARAGRAPH_EXTRA = 0.5;
/** Two identical runs this close are one run drawn twice (fake bold, some
 *  producers' shadowing). Keeping both would duplicate the text. */
const DUPLICATE = 0.2;

/** Words in a first cell short enough to be a LABEL. A table row is a label and
 *  its values; a prose column's line is a clause. */
const LABEL_WORDS = 5;
/** The median words-per-line a side needs to count as prose. */
const PROSE_WORDS = 5;

const LIGATURES: Record<string, string> = {
  "\uFB00": "ff", "\uFB01": "fi", "\uFB02": "fl", "\uFB03": "ffi", "\uFB04": "ffl",
  "\uFB05": "st", "\uFB06": "st",
};

/** Text a decoder could not map back to characters: the replacement
 *  character, the private-use area (a font with no Unicode map) and control
 *  characters. Such a page did not really "read", whatever it printed. */
const UNDECODABLE = /[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

interface Segment { text: string; left: number; right: number; words: number }
interface Line { y: number; size: number; left: number; right: number; segments: Segment[] }

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const wordsIn = (s: string) => s.split(/\s+/).filter(Boolean).length;
const valueLike = (s: string) => /[\d$\u20AC\u00A3¥%]/.test(s);

export function layoutPage(input: PdfTextRun[]): PageLayout {
  // Runs with nothing to read carry no information; the geometry below decides
  // every space and every line break.
  const runs = input
    .filter((r) => r && typeof r.str === "string" && r.str.trim().length > 0)
    .map((r) => ({ ...r, str: expandLigatures(r.str), size: r.size > 0 ? r.size : 10 }));

  if (!runs.length) return { ok: true, text: "", mode: "empty" };
  if (runs.some((r) => UNDECODABLE.test(r.str))) return { ok: false, reason: "undecodable" };
  // Vertical or angled text has no reading order this module can vouch for.
  if (runs.some((r) => r.rotated)) return { ok: false, reason: "rotated" };

  const lines = buildLines(dedupe(runs));
  const multi = lines.filter((l) => l.segments.length >= 2);
  // Text side by side that did NOT share baselines — columns set a little
  // lower or higher than their neighbour. Read line by line it would come out
  // interleaved, so neither a flow nor a table reading is allowed for it.
  const beside = staggered(lines);

  // ONE FLOW: nothing on the page is split by a cell-sized gap.
  if (!multi.length && !beside) return { ok: true, text: render(lines), mode: "flow" };

  // A TABLE: every split line is a label followed by its values. Row-major
  // keeps each label with its own values, whatever order they were drawn in.
  const tableLike = (l: Line) =>
    l.segments[0].words <= LABEL_WORDS || l.segments.slice(1).some((s) => valueLike(s.text));
  if (!beside && multi.every(tableLike)) {
    // …unless the "table" is really two blocks side by side. Reading those row
    // by row interleaves two separate lists, so it is refused, not guessed.
    if (sideBySide(multi)) return { ok: false, reason: "ambiguous" };
    return { ok: true, text: render(lines), mode: "table" };
  }

  // TWO PROSE COLUMNS: read the left column, then the right.
  const columns = proseColumns(lines);
  if (columns) return { ok: true, text: columns, mode: "columns" };

  return { ok: false, reason: "ambiguous" };
}

function expandLigatures(s: string): string {
  return s.replace(/[\uFB00-\uFB06]/g, (c) => LIGATURES[c] ?? c);
}

/** One run drawn twice at the same place is one run. */
function dedupe<T extends PdfTextRun>(runs: T[]): T[] {
  const out: T[] = [];
  for (const r of runs) {
    const twin = out.find((o) => o.str === r.str
      && Math.abs(o.x - r.x) <= DUPLICATE * r.size && Math.abs(o.y - r.y) <= DUPLICATE * r.size);
    if (!twin) out.push(r);
  }
  return out;
}

/** Group runs into lines by baseline, top to bottom; read each left to right;
 *  split it into segments wherever a gap is cell-sized. */
function buildLines(runs: PdfTextRun[]): Line[] {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: PdfTextRun[][] = [];
  for (const r of sorted) {
    const current = groups[groups.length - 1];
    if (current) {
      const baseline = median(current.map((c) => c.y));
      const size = Math.max(median(current.map((c) => c.size)), r.size);
      if (Math.abs(r.y - baseline) <= SAME_LINE * size) { current.push(r); continue; }
    }
    groups.push([r]);
  }

  return groups.map((group) => {
    const row = [...group].sort((a, b) => a.x - b.x);
    const size = median(row.map((r) => r.size));
    const segments: Segment[] = [];
    let text = row[0].str, left = row[0].x, right = row[0].x + row[0].width;
    for (let i = 1; i < row.length; i++) {
      const r = row[i];
      const gap = r.x - right;
      if (gap > CELL_GAP * size) {
        segments.push(segment(text, left, right));
        text = r.str; left = r.x;
      } else if (gap <= NO_SPACE * size || /\s$/.test(text) || /^\s/.test(r.str)) {
        text += r.str;
      } else {
        text += " " + r.str;
      }
      right = Math.max(right, r.x + r.width);
    }
    segments.push(segment(text, left, right));
    return {
      y: median(row.map((r) => r.y)),
      size,
      left: segments[0].left,
      right: segments[segments.length - 1].right,
      segments,
    };
  });
}

function segment(text: string, left: number, right: number): Segment {
  const t = text.trim();
  return { text: t, left, right, words: wordsIn(t) };
}

/** Lines, in order, one per row, cells joined by a TAB; a blank line where the
 *  vertical step says a paragraph ended. */
function render(lines: Line[]): string {
  // THE PAGE'S OWN LINE SPACING is its tighter steps, not the median: in
  // short paragraphs half the steps ARE paragraph breaks, and a median taken
  // over them hides every one. A table with even rows has one step throughout
  // and still gets no breaks.
  const steps = lines.slice(1).map((l, i) => l.y - lines[i].y).sort((a, b) => a - b);
  const usual = steps.length ? steps[Math.floor((steps.length - 1) / 4)] : 0;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      const step = lines[i].y - lines[i - 1].y;
      const size = Math.max(lines[i].size, lines[i - 1].size);
      if (step > Math.max(PARAGRAPH_RATIO * usual, usual + PARAGRAPH_EXTRA * size)) out.push("");
    }
    out.push(lines[i].segments.map((s) => s.text).join("\t"));
  }
  return out.join("\n");
}

/** Does this cell BEGIN with a value — a price, a size, a percentage? */
const startsAsValue = (s: string) => /^[-+(]?[$€£¥]?\s?\d/.test(s);

/** Two blocks of cells side by side: some x position falls in a gap on EVERY
 *  split line, there are at least two cells either side of it on most lines,
 *  and what begins after it is a new LABEL, not a value. (A four-column table
 *  has such a gap too, but after it come the row's own values: $2,400, $500.
 *  After the gap between two price lists comes the next list's first name.) */
function sideBySide(multi: Line[]): boolean {
  const candidates = new Set<number>();
  for (const l of multi) {
    for (let k = 1; k < l.segments.length; k++) candidates.add((l.segments[k - 1].right + l.segments[k].left) / 2);
  }
  for (const g of candidates) {
    const splits = multi.map((l) => {
      const k = l.segments.findIndex((s, i) => i > 0 && l.segments[i - 1].right < g && s.left > g);
      if (k < 0) return null;
      return { left: k, right: l.segments.length - k, label: !startsAsValue(l.segments[k].text) };
    });
    if (splits.some((s) => s === null)) continue;
    const both = splits.filter((s) => s!.left >= 2 && s!.right >= 2);
    if (both.length * 2 < multi.length) continue;
    if (both.filter((s) => s!.label).length * 2 >= both.length) return true;
  }
  return false;
}

/** Horizontally apart: nothing of one is above or below anything of the other. */
const apart = (a: Line, b: Line) => a.right < b.left || b.right < a.left;

/** TEXT SIDE BY SIDE ON SEPARATE BASELINES. Two consecutive lines that do not
 *  overlap horizontally, and either overlap vertically (the lower one starts
 *  before the upper one's baseline) or keep alternating for four lines. That
 *  is two columns set slightly out of step, not one flow — reading it line by
 *  line would interleave them. A lone right-aligned line (a date under a
 *  letterhead) does neither, and stays one flow. */
function staggered(lines: Line[]): boolean {
  let run = 0;
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i];
    if (!apart(a, b)) { run = 0; continue; }
    if (b.y - a.y < b.size) return true;
    if (++run >= 3) return true;
  }
  return false;
}

interface Piece { seg: Segment; y: number; size: number }
const asLine = (p: Piece): Line => ({ y: p.y, size: p.size, left: p.seg.left, right: p.seg.right, segments: [p.seg] });

/**
 * Two prose columns, read left then right — or null if the page is not
 * UNMISTAKABLY that.
 *
 * Found by printing real pages, not by reasoning: real columns rarely share
 * baselines, and rarely end on the same line. So a column is found by WHERE
 * ITS TEXT SITS — every piece of text wholly left of one gutter, or wholly
 * right of it — not by lines that happen to be split.
 *
 *   * Nothing may cross the gutter between the columns' top and bottom: a line
 *     across the middle means the page is not two columns at all. Lines that
 *     cross it above or below are a heading and a footer, and keep their place.
 *   * Both sides must read as prose.
 *   * Where one column starts higher or ends lower than the other, those extra
 *     lines must CONTINUE their column at its own line spacing. A short line
 *     set apart under the columns could be the longer column's last line or a
 *     footer, and geometry cannot tell which — reading the wrong one puts a
 *     footer in the middle of the text. So it is refused.
 */
function proseColumns(lines: Line[]): string | null {
  if (lines.some((l) => l.segments.length > 2)) return null;
  const pieces: Piece[] = lines.flatMap((l) => l.segments.map((seg) => ({ seg, y: l.y, size: l.size })));

  const candidates = new Set<number>();
  for (const l of lines) if (l.segments.length === 2) candidates.add((l.segments[0].right + l.segments[1].left) / 2);
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i];
    if (apart(a, b)) candidates.add(a.right < b.left ? (a.right + b.left) / 2 : (b.right + a.left) / 2);
  }

  for (const g of candidates) {
    // A split line must split AT this gutter.
    if (lines.some((l) => l.segments.length === 2 && !(l.segments[0].right < g && l.segments[1].left > g))) continue;
    const left = pieces.filter((p) => p.seg.right < g);
    const right = pieces.filter((p) => p.seg.left > g);
    const across = pieces.filter((p) => p.seg.left <= g && p.seg.right >= g);
    if (left.length < 2 || right.length < 2) continue;
    if (median(left.map((p) => p.seg.words)) < PROSE_WORDS) continue;
    if (median(right.map((p) => p.seg.words)) < PROSE_WORDS) continue;

    const top = Math.min(left[0].y, right[0].y);
    const bottom = Math.max(left[left.length - 1].y, right[right.length - 1].y);
    if (across.some((p) => p.y >= top && p.y <= bottom)) return null;
    if (!overhangContinues(left, right) || !overhangContinues(right, left)) return null;

    const header = across.filter((p) => p.y < top).map(asLine);
    const footer = across.filter((p) => p.y > bottom).map(asLine);
    return [header, left.map(asLine), right.map(asLine), footer]
      .filter((part) => part.length)
      .map(render)
      .join("\n\n");
  }
  return null;
}

/** The lines of `column` above the top of `other`, and below its bottom, step
 *  from one to the next — and into the rest of the column — at the column's
 *  own line spacing: no paragraph gap anywhere in them. */
function overhangContinues(column: Piece[], other: Piece[]): boolean {
  const steps = column.slice(1).map((p, i) => p.y - column[i].y).sort((a, b) => a - b);
  if (!steps.length) return true;
  const pitch = steps[Math.floor((steps.length - 1) / 4)];
  const limit = pitch * 1.15;
  const otherTop = other[0].y, otherBottom = other[other.length - 1].y;
  for (let i = 1; i < column.length; i++) {
    const step = column[i].y - column[i - 1].y;
    const inHead = column[i - 1].y < otherTop;      // the step leaves the head overhang
    const inTail = column[i].y > otherBottom;       // the step enters the tail overhang
    if ((inHead || inTail) && step > limit) return false;
  }
  return true;
}
