import { auditNote, recordSpan, noteBlockMessage, type NoteVerdict } from "./notes-provenance.ts";
import { sourceOrdinalsOf } from "./library-price-gate.ts";

// Deriving ONE record's source span on the Library path, so the notes audit is
// asked about the right community. Shared by materialise, patch and save —
// save re-derives from the chunk text and never trusts a stored warning, for
// the same reason the price gate does not.

export interface ChunkText { ordinal: number; segment_text?: string | null }
export interface ProposalRow { ordinal: number; title?: unknown; [k: string]: unknown }

/**
 * The record's own slice of its chunk(s).
 *
 * A merged cross-chunk community spans both halves, so both are searched and
 * whichever yields a span wins; its siblings are the OTHER records produced by
 * the same chunk, which are the boundaries between communities.
 */
export function spanFor(
  proposal: Record<string, unknown>, all: ProposalRow[], chunks: ChunkText[],
): string | null {
  const ords = new Set(sourceOrdinalsOf(proposal));
  const title = String(proposal.title ?? "");
  const siblings = all
    .filter((q) => ords.has(Number(q.ordinal)) && String(q.title ?? "") !== title)
    .map((q) => String(q.title ?? ""));
  const parts: string[] = [];
  for (const c of chunks) {
    if (!ords.has(Number(c.ordinal))) continue;
    const s = recordSpan(String(c.segment_text ?? ""), title, siblings);
    if (s) parts.push(s);
  }
  return parts.length ? parts.join("\n") : null;
}

export function auditProposalNote(
  proposal: Record<string, unknown>, all: ProposalRow[], chunks: ChunkText[],
): NoteVerdict {
  return auditNote(proposal.notes, spanFor(proposal, all, chunks));
}

export function noteWarningsFor(
  proposal: Record<string, unknown>, all: ProposalRow[], chunks: ChunkText[],
): string[] {
  const v = auditProposalNote(proposal, all, chunks);
  return v.ok ? [] : [noteBlockMessage(String(proposal.title ?? ""), v)];
}

export { noteBlockMessage };
