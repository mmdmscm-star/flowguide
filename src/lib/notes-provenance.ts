// A PRIVATE NOTE MUST TRACE TO SOURCE THAT SAYS IT IS PRIVATE.
//
// `notes` is invisible to the recipient. A fact routed there is hidden from the
// person the FlowGuide was made for, and looks fine to the professional, who
// still sees it. The prompt asks the model to reserve it for genuinely private
// source content; on a real 65-community import that took contamination from 35
// records to one — Cogir of Vallejo Hills, whose waitlist and "assessment
// required" became private though the source marks neither. "Usually obeys" is
// not a visibility guarantee, so this checks.
//
// THREE THINGS IT REFUSES TO ASSUME, each learned from being wrong:
//
//  1. THE CHUNK IS NOT THE RECORD. 15 of 49 chunks held several communities. A
//     directive belonging to one must never authorise its neighbour's notes, so
//     evidence is sought only in that record's own span.
//
//  2. "Private" IS USUALLY A ROOM. 29 of 65 communities contain the word — as
//     "Private Studio", "Private Room", "semi-private accommodations". A
//     keyword search would authorise 29 records on the strength of a floor
//     plan. Evidence must be a privacy DIRECTIVE, not a privacy adjective.
//
//  3. ONE DIRECTIVE DOES NOT AUTHORISE THE WHOLE FIELD. A source that says
//     "Private note: the director is retiring" authorises exactly that, not the
//     waitlist and the community fee the model may pile in beside it.
//
// NOTHING IS DELETED OR MOVED. The note is preserved and the professional is
// told what needs attention.

const ROOM_NOUN = /^(studio|room|suite|bedroom|apartment|bath|accommodation|residence|unit|cottage|villa|annex|\(|\d|\$)/i;

/** A privacy DIRECTIVE: a marker that introduces content, at the start of a
 *  line or sentence, and not naming a room. */
const DIRECTIVE = /(?:^|[\n.;])\s*((?:private\s+note|private|internal|confidential|not\s+for\s+(?:the\s+)?client|do\s+not\s+share|off\s+the\s+record|for\s+your\s+reference|fyi)\b[^\n]*)/gi;

const STOP = new Set(["the","a","an","and","or","but","of","to","in","on","for","with","at","by","from",
  "is","are","was","were","be","been","has","have","had","that","this","these","those","it","its",
  "will","would","can","could","may","might","not","no","as","if","than","then","there","their","they",
  "our","your","note","notes","please","also","currently","current"]);

/** Words and figures that carry meaning. Comparing these rather than exact
 *  strings keeps the check honest about light rephrasing while still noticing
 *  that a waitlist and a community fee were never in the private region. */
export function factTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(/\$?\d[\d,.]*|[A-Za-z][A-Za-z'-]{3,}/g)) {
    const t = m[0].toLowerCase().replace(/[.,]$/, "");
    if (/^\$?\d/.test(t)) { out.push(t.replace(/[^0-9.]/g, "")); continue; }
    if (!STOP.has(t)) out.push(t);
  }
  return [...new Set(out)];
}

/**
 * The slice of a chunk that belongs to ONE record: from its own title to the
 * next record's title. `siblingTitles` are the other records the same chunk
 * produced — the boundaries.
 *
 * Returns null when the title cannot be located, which fails the audit closed.
 */
export function recordSpan(chunkText: string, title: string, siblingTitles: string[]): string | null {
  const hay = String(chunkText ?? "");
  // Where does this record's own block BEGIN?
  //
  // A record header starts a line AND carries the whole title, city suffix and
  // all. A community named in prose has neither property; a stray line
  // describing a sibling has only the first. Both occur in real sources —
  // communities under one operator cite each other, and one community's
  // description gets typed into another's row, which is the St Michael's /
  // Greenwood entry error itself.
  //
  // Matching the bare community name anywhere, as this did, let either of
  // those pull a span start into the middle of another record's block,
  // truncating that record and handing its text to this one. Take the most
  // specific evidence available and fall back only where the source lacks it.
  //
  // Measured against the real 65-community source: spans are identical for all
  // 65, because every mention there happens to follow its own header. This
  // changes no current result; it stops depending on that ordering.
  const lineStartOf = (needle: string): number => {
    const k = needle.toLowerCase();
    let off = 0;
    for (const ln of hay.split("\n")) {
      if (ln.trimStart().toLowerCase().startsWith(k)) return off + (ln.length - ln.trimStart().length);
      off += ln.length + 1;
    }
    return -1;
  };

  // Lines that BEGIN with `needle` AND end the name there. "Acme" must not
  // identify "Acme North": a longer name continuing into another word is a
  // different community, so only a real title boundary — end of line, an
  // aside, a city separator, or a field/list punctuation mark — counts.
  const lineStartsWithBoundary = (needle: string): number[] => {
    const k = needle.toLowerCase();
    const out: number[] = [];
    let off = 0;
    for (const ln of hay.split("\n")) {
      const lead = ln.length - ln.trimStart().length;
      const body = ln.trimStart();
      if (body.toLowerCase().startsWith(k)) {
        const rest = body.slice(k.length);
        if (rest.trim() === "" || /^\s*[(—–\-,:|]/.test(rest)) out.push(off + lead);
      }
      off += ln.length + 1;
    }
    return out;
  };

  const find = (t: string): number => {
    const full = String(t).trim();
    const key = full.split(/\s[—–-]\s/)[0].trim();
    if (key.length < 4) return -1;

    const titled = full.length > key.length ? lineStartOf(full) : -1;
    if (titled >= 0) return titled;

    const anchored = lineStartOf(key);
    if (anchored >= 0) return anchored;

    const i = hay.toLowerCase().indexOf(key.toLowerCase());
    if (i >= 0) return i;
    // Fall back to a normalised scan so punctuation differences do not lose a
    // record — the alternative is failing closed on a cosmetic mismatch.
    const flat = hay.toLowerCase().replace(/[^a-z0-9]/g, "");
    const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!k) return -1;
    const j = flat.indexOf(k);
    if (j >= 0) {
      let count = 0;
      for (let p = 0; p < hay.length; p++) {
        if (/[a-z0-9]/i.test(hay[p])) { if (count === j) return p; count++; }
      }
    }

    // LAST RESORT: the model abbreviated a parenthetical aside.
    //
    // Observed: a source header reading "Napa Valley Senior Care (formerly
    // called Nazareth Classic Care of Napa)" came back as "Napa Valley Senior
    // Care (formerly Nazareth Classic Care)". Every route above fails on it,
    // and an unlocatable record does not merely fail closed for itself — its
    // neighbour's span then runs straight through its block.
    //
    // The parenthetical is dropped STRUCTURALLY, not by vocabulary, and the
    // remainder is accepted only when it identifies exactly one line in the
    // whole source. One match is identification; two is a guess, and a guess
    // here would hand one record's content to another.
    const bare = key.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
    if (bare && bare !== key && bare.length >= 4) {
      const hits = lineStartsWithBoundary(bare);
      if (hits.length === 1) return hits[0];
    }
    return -1;
  };
  const start = find(title);
  if (start < 0) return null;
  let end = hay.length;
  for (const s of siblingTitles) {
    const i = find(s);
    if (i > start && i < end) end = i;
  }
  return hay.slice(start, end);
}

/**
 * The regions a record's own source explicitly designates private.
 *
 * A directive governs its OWN line and the lines that follow it until a blank
 * line or a new "Label:" field — a bounded region, so one directive cannot
 * authorise a whole community's worth of facts.
 */
export function privateRegions(span: string): string[] {
  const text = String(span ?? "");
  const regions: string[] = [];
  for (const m of text.matchAll(DIRECTIVE)) {
    const line = m[1];
    // "Private Studio - $8,750" is a floor plan, not a directive.
    const after = line.replace(/^(?:private\s+note|private|internal|confidential|not\s+for\s+(?:the\s+)?client|do\s+not\s+share|off\s+the\s+record|for\s+your\s+reference|fyi)\b[\s:—–-]*/i, "");
    if (ROOM_NOUN.test(after.trim())) continue;

    const at = (m.index ?? 0) + m[0].indexOf(line);
    const rest = text.slice(at);
    const lines = rest.split("\n");
    const block: string[] = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) break;                       // blank line ends the region
      if (/^\s*[A-Z][A-Za-z ]{2,24}\s*:/.test(l)) break;  // a new labelled field ends it
      block.push(l);
    }
    regions.push(block.join("\n"));
  }
  return regions;
}

export interface NoteVerdict {
  ok: boolean;
  /** Why it failed, in the professional's terms. */
  reason: "empty" | "supported" | "no_private_source" | "unsupported_content" | "no_provenance";
  /** Fact-bearing tokens in the note that the private region does not support. */
  unsupported: string[];
}

/** Is this note traceable to source that says it is private? */
export function auditNote(note: unknown, span: string | null): NoteVerdict {
  const text = String(note ?? "").trim();
  if (!text) return { ok: true, reason: "empty", unsupported: [] };
  if (span === null) return { ok: false, reason: "no_provenance", unsupported: [] };

  const regions = privateRegions(span);
  if (!regions.length) return { ok: false, reason: "no_private_source", unsupported: factTokens(text) };

  const supported = new Set(regions.flatMap((r) => factTokens(r)));
  const unsupported = factTokens(text).filter((t) => !supported.has(t));
  return unsupported.length
    ? { ok: false, reason: "unsupported_content", unsupported }
    : { ok: true, reason: "supported", unsupported: [] };
}

/** The sentence shown to the professional. */
export function noteBlockMessage(title: string, v: NoteVerdict): string {
  const name = String(title ?? "").trim() || "This community";
  if (v.reason === "no_provenance")
    return `${name}: FlowGuide couldn't match this record to its source, so it can't confirm the private note is private. Move the text into the description or clear it before saving.`;
  if (v.reason === "no_private_source")
    return `${name}: the private note holds information the source never marks as private, so your client would never see it. Move it into the description or details, or clear it.`;
  return `${name}: the private note mixes private source content with ordinary information (${v.unsupported.slice(0, 6).join(", ")}). Move the client-facing parts into the description or details.`;
}
