// Server-side ingestion pipeline helpers: build the persisted plan, process one
// chunk with a bounded model call, and compute adaptive-split children. One
// pipeline for all three entry points; a small source is simply a one-chunk run.
import { segment, splitRange, segmentHash, DEFAULT_BUDGET, SEGMENTER_VERSION } from "./segmentation";
import { callStructuringModel } from "./ai-structure";
import { organizeLeadPrompt, sectionsPrompt, itemsOnlyPrompt } from "./ai-prompts";

export { SEGMENTER_VERSION };
export type EntryPoint = "organize" | "append" | "section_append";

// A segment noticeably larger than the budget is pre-emptively split before we
// even spend a model call on it (defends genuinely huge blocks).
const PRESPLIT_CHARS = Math.floor(DEFAULT_BUDGET.maxChars * 1.6);

function isHeadingLine(t: string): boolean {
  const s = t.trim();
  if (!s || s.length > 60) return false;
  if (/[.!?,;:]$/.test(s)) return false;
  if (/https?:\/\/|@|\d{3}[-.)]/.test(s)) return false;
  return true;
}

// Nearest heading line at or before `offset` — used so appended sections group
// under the source's heading rather than fragmenting across chunks.
function nearestHeading(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l && isHeadingLine(l)) return l;
  }
  return "";
}

// Build the ordered chunk plan persisted by create_ingestion_run.
export function buildRunChunks(source: string) {
  const segs = segment(source, DEFAULT_BUDGET);
  return segs.map((s) => ({
    ordinal: s.ordinal,
    source_start: s.sourceStart,
    source_end: s.sourceEnd,
    segment_text: s.text,
    segment_hash: s.hash,
    section_hint: nearestHeading(source, s.sourceStart),
  }));
}

// Children for split_chunk: divide [start,end) at a natural boundary; carry exact
// slices + hashes so the persisted plan stays self-consistent.
export function buildSplitChildren(source: string, start: number, end: number) {
  return splitRange(source, start, end).map((r) => ({
    source_start: r.start,
    source_end: r.end,
    segment_text: source.slice(r.start, r.end),
    segment_hash: segmentHash(source.slice(r.start, r.end)),
  }));
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
  sectionHint: string;
  apiKey: string;
}): Promise<ProcessOutcome> {
  const { entryPoint, packetType, isLead, segmentText, sectionHint, apiKey } = opts;

  let systemPrompt: string;
  if (entryPoint === "section_append") systemPrompt = itemsOnlyPrompt();
  else if (entryPoint === "organize" && isLead) systemPrompt = organizeLeadPrompt(packetType);
  else systemPrompt = sectionsPrompt(packetType);

  const userText = sectionHint && entryPoint !== "section_append"
    ? `Section heading context: ${sectionHint}\n\n${segmentText}`
    : segmentText;

  const res = await callStructuringModel({ systemPrompt, rawText: userText, apiKey, tag: `ingest-${entryPoint}` });
  if (!res.ok) {
    if (res.error === "output_truncated") return { kind: "split" };
    return { kind: "error", status: res.status, message: res.message || res.error };
  }

  const data = res.data as Record<string, unknown>;
  if (entryPoint === "section_append") {
    if (!Array.isArray((data as { items?: unknown }).items)) return { kind: "error", status: 502, message: "AI returned no items." };
    return { kind: "ok", result: { items: (data as { items: unknown[] }).items } };
  }
  if (!Array.isArray((data as { sections?: unknown }).sections)) return { kind: "error", status: 502, message: "AI returned no sections." };
  const out: ProcessOutcome = { kind: "ok", result: { sections: (data as { sections: unknown[] }).sections } };
  if (entryPoint === "organize" && isLead) {
    out.title = typeof (data as { title?: unknown }).title === "string" ? (data as { title: string }).title : undefined;
    out.clientName = typeof (data as { clientName?: unknown }).clientName === "string" ? (data as { clientName: string }).clientName : undefined;
  }
  return out;
}
