// TAKING BACK EXACTLY WHAT WE PUT IN, OR NOTHING.
//
// A transcribed picture contributes a block of text to the editable box. If the
// professional then removes the picture, the run would carry image-derived
// facts with no image behind them — and no database rule can see it, because
// 0048 only checks that the evidence a run DOES claim is coherent. A row like
// that is internally consistent and externally incomplete, which is the exact
// failure this whole package exists to close.
//
// So removal is allowed only when it can be undone precisely. The block we
// appended is remembered verbatim; if it is still in the box, untouched and
// unique, it comes out with its separator and the picture goes with it. If the
// professional has edited it, deleted it, or duplicated it, removal is REFUSED
// and the text is left exactly as they wrote it.
//
// NOTHING HERE EDITS CREATOR PROSE. It removes a byte-identical copy of a block
// this application itself wrote, or it declines. There is no third behaviour,
// and no heuristic about how similar is similar enough.

export type BlockRemoval =
  | { ok: true; text: string }
  | { ok: false; reason: "missing" | "duplicated" | "shared"; message: string };

/**
 * `rawText` with one contributed block removed, or the reason it cannot be.
 *
 * THE SEPARATOR GOES WITH IT. Blocks are joined by a blank line, so removing a
 * middle block without its separator leaves three blank lines where there were
 * two — small, but it accumulates, and the box is what the professional reads.
 *
 * `siblings` IS EVERY OTHER LIVE PICTURE'S CONTRIBUTED BLOCK, and it closes an
 * ambiguity uniqueness-in-the-text alone cannot see. Two pictures of the same
 * page contribute identical text. If the professional then deletes one copy by
 * hand, that text now appears EXACTLY ONCE — and removing either picture would
 * splice out the survivor, which belongs to the other one just as much. Counting
 * occurrences answers "how many copies are there"; it cannot answer "whose is
 * this". So when another live picture claims the same block, the answer is no.
 */
export function removeContributedBlock(
  rawText: string, block: string, siblings: string[] = [],
): BlockRemoval {
  const text = String(rawText ?? "");
  const b = String(block ?? "");
  if (!b) return { ok: false, reason: "missing", message: MISSING };

  // CHECKED FIRST, because it is true regardless of how many copies survive.
  if ((siblings ?? []).some((other) => String(other ?? "") === b)) {
    return { ok: false, reason: "shared", message: SHARED };
  }

  const first = text.indexOf(b);
  if (first < 0) return { ok: false, reason: "missing", message: MISSING };
  if (text.indexOf(b, first + b.length) >= 0) {
    return { ok: false, reason: "duplicated", message: DUPLICATED };
  }

  // Take the blank line BEFORE the block where there is one, and otherwise the
  // one after — so the first block and a middle block both come out cleanly.
  let start = first, end = first + b.length;
  const before = text.slice(0, start);
  const sep = /\n\n$/.exec(before);
  if (sep) start -= 2;
  else if (text.slice(end, end + 2) === "\n\n") end += 2;

  return { ok: true, text: (text.slice(0, start) + text.slice(end)).replace(/^\n+/, "") };
}

const MISSING =
  "Its text isn’t in your transcription any more — you’ve changed or removed it. " +
  "Edit the text directly, or start over if you don’t want this picture in the source.";
const SHARED =
  "Another picture read exactly the same text, so Sendset can’t tell which one the remaining copy " +
  "came from. Remove that picture too, or edit the text directly.";
const DUPLICATED =
  "Its text appears more than once in your transcription, so Sendset can’t tell which copy came " +
  "from this picture. Remove the copy you don’t want first.";
