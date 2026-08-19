// Server-side ingestion pipeline helpers: build the persisted plan, process one
// chunk with a bounded model call, and compute adaptive-split children. One
// pipeline for all three entry points; a small source is simply a one-chunk run.
import { segment, splitRange, segmentHash, isContinuation, DEFAULT_BUDGET, SEGMENTER_VERSION } from "./segmentation";
import { callStructuringModel } from "./ai-structure";
import { organizeLeadPrompt, sectionsPrompt, itemsOnlyPrompt } from "./ai-prompts";
import { validateEntryPointResult } from "./ingest-validate";

export { SEGMENTER_VERSION };
// `library_import` reuses the ITEMS-ONLY contract that section_append already
// has: a bare list of items with the same eight fields as ItemContentPayload.
// A Library entry has no section to belong to, so there was never a second
// prompt or a second result shape to invent.
export type EntryPoint = "organize" | "append" | "section_append" | "library_import";

// A segment noticeably larger than the budget is pre-emptively split before we
// even spend a model call on it (defends genuinely huge blocks).
const PRESPLIT_CHARS = Math.floor(DEFAULT_BUDGET.maxChars * 1.6);

// NOTE: a `nearestHeading()` back-scan used to run here, computing each chunk's
// `section_hint` from `source.slice(0, sourceStart)` — text OUTSIDE the chunk,
// belonging to earlier chunks — which was then prepended to the model input as
// "Section heading context: …". On a real paste it walked 1,399 chars backwards
// into the middle of the PREVIOUS spreadsheet row and handed a content-free
// chunk the string "Community Fee: $15,000", which the model turned into a
// fabricated item's title and its only detail.
//
// A chunk is now shown exactly its own segment text and nothing else. Section
// identity comes from headings that appear INSIDE a chunk's own text, which is
// safe because segment()'s flush() peels a trailing heading forward so a heading
// always leads the chunk it introduces.
// See docs/investigations/mid-record-chunk-splits.md.

// Build the ordered chunk plan persisted by create_ingestion_run. is_continuation
// (from segmentation) is the deterministic flag finalize uses to recombine a
// heading group split across chunks — never by title.
export function buildRunChunks(source: string) {
  const segs = segment(source, DEFAULT_BUDGET);
  return segs.map((s) => ({
    ordinal: s.ordinal,
    source_start: s.sourceStart,
    source_end: s.sourceEnd,
    segment_text: s.text,
    segment_hash: s.hash,
    section_hint: "",
    is_continuation: isContinuation(s.sourceStart, s.text),
  }));
}

// Children for split_chunk: divide [start,end) at a natural boundary; carry exact
// slices + hashes + continuation flags so the persisted plan stays self-consistent.
export function buildSplitChildren(source: string, start: number, end: number) {
  return splitRange(source, start, end).map((r) => {
    const text = source.slice(r.start, r.end);
    return {
      source_start: r.start,
      source_end: r.end,
      segment_text: text,
      segment_hash: segmentHash(text),
      is_continuation: isContinuation(r.start, text),
    };
  });
}

export function shouldPresplit(segmentText: string): boolean {
  return segmentText.length > PRESPLIT_CHARS;
}

export type ProcessOutcome =
  | { kind: "ok"; result: Record<string, unknown>; title?: string; clientName?: string }
  | { kind: "split" } // too big / truncated — subdivide and retry the pieces
  | { kind: "error"; status: number; message: string };

// Process ONE segment through the model. Bounded: a ~10-item segment stays well
// under the route's 60s limit. Truncation (finish_reason=length) => split.
export async function processSegment(opts: {
  entryPoint: EntryPoint;
  packetType: string;
  isLead: boolean;
  segmentText: string;
  apiKey: string;
}): Promise<ProcessOutcome> {
  const { entryPoint, packetType, isLead, segmentText, apiKey } = opts;

  let systemPrompt: string;
  if (entryPoint === "section_append" || entryPoint === "library_import") systemPrompt = itemsOnlyPrompt();
  else if (entryPoint === "organize" && isLead) systemPrompt = organizeLeadPrompt(packetType);
  else systemPrompt = sectionsPrompt(packetType);

  // The model sees the chunk's own text and nothing else (see the note above).
  const userText = segmentText;

  const res = await callStructuringModel({ systemPrompt, rawText: userText, apiKey, tag: `ingest-${entryPoint}` });
  if (!res.ok) {
    if (res.error === "output_truncated") return { kind: "split" };
    return { kind: "error", status: res.status, message: res.message || res.error };
  }

  const data = res.data as Record<string, unknown>;
  // Entry-point-aware shape validation BEFORE staging. Without this, a wrong or
  // empty shape stages cleanly and finalizes to zero content — a "successful"
  // import that added nothing. See ingest-validate.ts.
  const valid = validateEntryPointResult(entryPoint, data);
  if (!valid.ok) return { kind: "error", status: 502, message: valid.message };

  if (entryPoint === "section_append" || entryPoint === "library_import") return { kind: "ok", result: valid.result };
  const out: ProcessOutcome = { kind: "ok", result: valid.result };
  if (entryPoint === "organize" && isLead) {
    out.title = typeof (data as { title?: unknown }).title === "string" ? (data as { title: string }).title : undefined;
    out.clientName = typeof (data as { clientName?: unknown }).clientName === "string" ? (data as { clientName: string }).clientName : undefined;
  }
  return out;
}
