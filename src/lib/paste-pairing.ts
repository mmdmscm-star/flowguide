// WHEN A PAGE'S STRUCTURE DOES NOT SURVIVE BEING FLATTENED.
//
// A Taqueria menu reached a draft with every dish carrying the NEXT dish's
// price and the last dish gone. Nothing in this codebase shifted anything: the
// menu row is
//
//     <div class="media">
//       <span class="pull-right">$16.24</span>   <- FIRST in document order
//       <h4 class="media-heading">Super Burrito</h4>
//       <div class="text-sm">Your choice of meat…</div>
//     </div>
//
// The price is written before the name and floated right by CSS, so it LOOKS
// beside the name and SITS before it. A drag that begins on the visible dish
// title therefore starts after the first price, and every later price falls
// between one dish's description and the next dish's name. The clipboard's
// text/plain flavour is that flattening, verbatim; a <textarea> receives only
// that flavour, so the mis-pairing was already in the source Sendset stored.
//
// THE SAME COPY CARRIED text/html, AND IT WAS RIGHT. Every row that was inside
// the selection kept its own name and its own price together, because the row
// element IS the pairing. Flattening deletes the grouping and leaves adjacency,
// and here adjacency was wrong.
//
// WHAT THIS DOES, AND WHAT IT REFUSES TO DO.
//
// It reads both flavours and answers one question: do they disagree about which
// price belongs to which label? Nothing else. It does not parse HTML into
// content, does not repair or shift a value, does not store the HTML, and does
// not decide anything — a disagreement is reported to the professional, who
// re-copies or proceeds. The HTML is read once, in the browser, and discarded.
//
// IT MUST NOT CRY WOLF. A false alarm teaches people that ordinary pasting is
// unreliable, which costs more than this saves. So it reports only when a
// REPEATED structure exists, enough of it can be compared, and a MAJORITY of
// the comparable rows genuinely contradict — never on structure alone.

/** One row where the page and the flattened text disagree. */
export interface PairingConflict {
  /** The row's own label, as the page has it. */
  label: string;
  /** The value the PAGE binds to that label. */
  htmlValue: string;
  /** The value the flattened text puts next to it — the one that would be used. */
  plainValue: string;
}

export interface PairingVerdict {
  /** Rows carrying exactly one value that could be compared against the text. */
  compared: number;
  /** Of those, how many disagree. */
  conflicts: number;
  /** A concrete example, for saying what is wrong rather than that something is. */
  example: PairingConflict;
}

/** A currency amount. Deliberately narrow: this is the one value class where a
 *  silent mis-association is both likely and costly, and widening it is how a
 *  precise warning becomes a noisy one. */
const MONEY = /\$\s?\d[\d,]*(?:\.\d{1,2})?/;
const MONEY_G = new RegExp(MONEY.source, "g");

/** Clipboard text carries non-breaking spaces and stray runs; two readings of
 *  the same string must not differ over whitespace. */
const norm = (s: string) => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();

const moneyCount = (s: string) => (norm(s).match(MONEY_G) ?? []).length;

/** The tightest element holding exactly one amount AND something that is not
 *  that amount — i.e. a row: a label and its value, together. A bare price
 *  span holds an amount and nothing else, so it is not a row; the element
 *  around it is. */
function isRow(el: Element): boolean {
  const text = norm(el.textContent ?? "");
  if (moneyCount(text) !== 1) return false;
  if (!text.replace(MONEY_G, "").trim()) return false;          // amount only
  for (const child of Array.from(el.children)) if (isRow(child)) return false;
  return true;
}

/** The row's label and value in DOCUMENT order, which is the order the
 *  flattening will use. */
function readRow(el: Element): { label: string; value: string; valueFirst: boolean } | null {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) { const t = norm(n.textContent ?? ""); if (t) parts.push(t); return; }
    for (const c of Array.from(n.childNodes)) walk(c);
  };
  walk(el);
  const valueAt = parts.findIndex((p) => MONEY.test(p));
  if (valueAt < 0) return null;
  const value = (norm(parts[valueAt]).match(MONEY_G) ?? [])[0] ?? "";
  const labelPart = parts.find((p, i) => i !== valueAt && p.length > 1 && !MONEY.test(p));
  if (!labelPart) return null;
  return { label: labelPart, value, valueFirst: valueAt < parts.indexOf(labelPart) };
}

/**
 * Do the copied page and its flattened text disagree about which value belongs
 * to which label?
 *
 * `null` means no answer worth giving: no HTML flavour, no repeated rows, or
 * too little overlap between the two readings to compare. Silence is the
 * default and the common case.
 */
export function checkPastedPairing(html: string, plain: string): PairingVerdict | null {
  if (!html || !plain) return null;
  if (typeof DOMParser === "undefined") return null;

  let doc: Document;
  try { doc = new DOMParser().parseFromString(html, "text/html"); } catch { return null; }
  if (!doc?.body) return null;

  const rows = Array.from(doc.body.querySelectorAll("*"))
    .filter(isRow).map(readRow).filter((r): r is NonNullable<typeof r> => Boolean(r));

  // A REPEATED structure, not one stray priced line. Three is the smallest
  // number that can show a pattern rather than a coincidence.
  if (rows.length < 3) return null;

  // The flattening, as the textarea received it.
  const lines = plain.replace(/ /g, " ").split("\n").map((l) => l.trim()).filter(Boolean);

  const conflicts: PairingConflict[] = [];
  let compared = 0;

  for (const row of rows) {
    const at = lines.findIndex((l) => norm(l) === row.label);
    if (at < 0) continue;                       // this row is not in the text
    // The value the flattened text offers for this label: the next amount
    // before the next row's label. That is exactly the adjacency a reader —
    // human or model — has to rely on once the grouping is gone.
    const labels = new Set(rows.map((r) => r.label));
    let plainValue = "";
    for (let i = at + 1; i < lines.length; i++) {
      if (labels.has(norm(lines[i]))) break;
      const m = norm(lines[i]).match(MONEY_G);
      if (m) { plainValue = m[0]; break; }
    }
    if (!plainValue) continue;                  // nothing to disagree with
    compared++;
    if (plainValue !== row.value)
      conflicts.push({ label: row.label, htmlValue: row.value, plainValue });
  }

  // NARROW ON PURPOSE. Enough rows to be a pattern, more than one disagreement,
  // and a majority of what could be checked. A page whose structure survives
  // flattening produces zero conflicts and is never mentioned.
  if (compared < 3 || conflicts.length < 2 || conflicts.length * 2 <= compared) return null;
  return { compared, conflicts: conflicts.length, example: conflicts[0] };
}
