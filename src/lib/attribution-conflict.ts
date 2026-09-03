import { recordSpan } from "./notes-provenance.ts";

// CONTENT FROM RECORD A MUST NOT QUIETLY BECOME RECORD B'S.
//
// The case: the source sheet put a 681-character description of "Greenwood
// Assisted Living" inside ST MICHAEL'S row — a data-entry error. The model read
// a chunk holding both communities, saw prose naming Greenwood, and emitted it
// on Greenwood. Structurally the source assigns that text to St Michael's.
//
// No FlowGuide logic moved it: materialisation inserts the model's item
// verbatim, the continuation merge only folds SAME-titled neighbours, and photo
// attribution never touches description. The model reassigned it, and nothing
// noticed. That is the gap this closes.
//
// OWNERSHIP IS NOT DECIDED HERE. The two communities share an operator, so one
// legitimately mentioning the other is expected and will grow more common with
// smaller RCFEs. A NAME is therefore never evidence. This asks only WHERE THE
// TEXT PHYSICALLY SITS, preserves the source's assignment, and hands the
// professional the decision. It has no move operation and no delete.
//
// VERBATIM ONLY, and deliberately quiet when it cannot prove anything. Measured
// on the real 65-community run: 26 descriptions are verbatim, 17 have a
// verbatim sentence, and 20 have none — the model paraphrases heavily. A rule
// that DEMANDED provenance would block a third of the Library. This one speaks
// only on verbatim evidence: 62 supported, 1 conflict (the real one), 2 no
// claim, 0 false positives.

/** Long enough to be distinctive. A short generic clause ("Pet friendly.")
 *  recurs across communities and would manufacture conflicts. */
const MIN_ANCHOR = 40;

/** Whitespace and Unicode form only — never wording. Copied text differs by
 *  curly quotes and line wrapping, which is why whole-string matching missed a
 *  description that was otherwise identical. */
export function normalizeForMatch(s: unknown): string {
  return String(s ?? "").normalize("NFKC").replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

export function anchorsOf(text: unknown): string[] {
  const t = normalizeForMatch(text);
  if (!t) return [];
  return t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= MIN_ANCHOR);
}

export type AnchorVerdict =
  /** Verbatim in this record's own span. */
  | { kind: "own"; anchor: string }
  /** Verbatim in exactly one OTHER record's span, and not in this one. */
  | { kind: "conflict"; anchor: string; owner: string }
  /** In several spans — boilerplate shared across communities. No claim. */
  | { kind: "ambiguous"; anchor: string }
  /** Nowhere verbatim — the model paraphrased. No claim. */
  | { kind: "unmatched"; anchor: string };

/**
 * Classify ONE anchor. Per anchor, never per description: a mixed description
 * whose first sentence is genuinely B's must not authorise the sentences copied
 * from A, which is exactly how a single-anchor rule would be escaped.
 */
export function classifyAnchor(
  anchor: string, ownSpan: string, otherSpans: ReadonlyArray<{ title: string; span: string }>,
): AnchorVerdict {
  if (ownSpan.includes(anchor)) return { kind: "own", anchor };
  const holders = otherSpans.filter((o) => o.span.includes(anchor));
  if (holders.length === 1) return { kind: "conflict", anchor, owner: holders[0].title };
  if (holders.length > 1) return { kind: "ambiguous", anchor };
  return { kind: "unmatched", anchor };
}

export interface AttributionAudit {
  /** False when a provable cross-record conflict exists, or provenance failed. */
  ok: boolean;
  /** True when this record's own source span could be located. */
  resolved: boolean;
  conflicts: Array<{ anchor: string; owner: string }>;
}

/**
 * Audit ONE proposal's description against the record spans of the full source.
 *
 * FAILS CLOSED on provenance: if this record's span cannot be located, no claim
 * can be checked, so the save is held rather than waved through.
 */
export function auditAttribution(
  proposal: { title?: unknown; description?: unknown },
  fullSource: string,
  allTitles: readonly string[],
): AttributionAudit {
  const title = String(proposal.title ?? "");
  const anchors = anchorsOf(proposal.description);
  if (!anchors.length) return { ok: true, resolved: true, conflicts: [] };

  const ownRaw = recordSpan(fullSource, title, allTitles.filter((t) => t !== title));
  if (ownRaw === null) return { ok: false, resolved: false, conflicts: [] };
  const ownSpan = normalizeForMatch(ownRaw);

  const otherSpans: Array<{ title: string; span: string }> = [];
  for (const t of allTitles) {
    if (t === title) continue;
    const sp = recordSpan(fullSource, t, allTitles.filter((x) => x !== t));
    if (sp !== null) otherSpans.push({ title: t, span: normalizeForMatch(sp) });
  }

  const conflicts: Array<{ anchor: string; owner: string }> = [];
  for (const a of anchors) {
    const v = classifyAnchor(a, ownSpan, otherSpans);
    // ONE conflicting anchor is enough, even when others are locally supported.
    if (v.kind === "conflict") conflicts.push({ anchor: v.anchor, owner: v.owner });
  }
  return { ok: conflicts.length === 0, resolved: true, conflicts };
}

/** What the professional reads. It states the conflict and refuses to resolve
 *  it: the source may be mistaken, the text may be a legitimate cross-reference
 *  between related communities, or it may belong elsewhere. Only they know. */
export function attributionWarningsFor(
  proposal: { title?: unknown; description?: unknown },
  fullSource: string,
  allTitles: readonly string[],
): string[] {
  const a = auditAttribution(proposal, fullSource, allTitles);
  if (!a.resolved) {
    return [`${String(proposal.title ?? "This record")}: Sendset could not locate this record in your source, so it cannot confirm the description belongs to it. Check it before saving.`];
  }
  return a.conflicts.map((c) =>
    `${String(proposal.title ?? "This record")}: part of this description appears in your source under “${c.owner}”, not under this community. Confirm where it belongs before saving — “${c.anchor.slice(0, 90)}${c.anchor.length > 90 ? "…" : ""}”`);
}
