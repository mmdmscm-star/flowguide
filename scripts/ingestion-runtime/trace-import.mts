// TRACE ONE IMPORT: source slice -> raw model result -> saved proposal.
//
//   FLOWGUIDE_RT_CONFIRM=1 RUN=<uuid> npx tsx scripts/ingestion-runtime/trace-import.mts
//   ... [--json out.json]
//
// READ ONLY. This is the artefact 0024 and 0025 were built to make possible: for
// a finalized import, the exact segment the model saw, the exact JSON it
// returned, and the proposal that came out — side by side, per record.
//
// It does NOT score. Scoring needs ground truth authored against the real
// source; this produces the evidence a human or a scorer reads. Keeping the two
// apart matters: a trace that also judged would let a scoring bug quietly edit
// the evidence it was meant to expose.
import { svc, errText } from "./lib.mts";
import { writeFileSync } from "node:fs";

const RUN = process.env.RUN;
const OUT = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;

async function rows0<T>(label: string, q: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new Error(`${label}: ${errText(error)}`);
  return data ?? [];
}
const rows = rows0;

// No RUN given: say what CAN be traced, rather than failing with a usage line.
// Whether an import is traceable at all is the first question this tool answers.
if (!RUN) {
  const all = await rows<Record<string, unknown>>("runs", svc.from("ingestion_runs")
    .select("id, destination, status, total_chunks, source_len, source_text, created_at")
    .order("created_at", { ascending: false }).limit(40));
  console.log(`\nRuns, newest first — "traceable" means the source survived:\n`);
  for (const r of all)
    console.log(`  ${r.id}  ${String(r.created_at).slice(0,16)}  ${String(r.destination).padEnd(7)} ${String(r.status).padEnd(10)}` +
      ` chunks=${String(r.total_chunks).padStart(3)} src_len=${String(r.source_len).padStart(6)}  ` +
      (r.source_text === null ? "NOT TRACEABLE (evidence cleared)" : "traceable"));
  console.log(`\n  Re-run with RUN=<id>.\n`);
  process.exit(0);
}

const runs = await rows<Record<string, unknown>>("run", svc.from("ingestion_runs")
  .select("id, destination, entry_point, status, source_text, source_len, total_chunks, evidence_purge_after, created_at")
  .eq("id", RUN));
if (!runs.length) { console.error(`run ${RUN} not found`); process.exit(1); }
const run = runs[0];

const chunks = await rows<{ ordinal: number; status: string; source_start: number; source_end: number;
  segment_text: string | null; result: unknown; fact_ledger: unknown }>(
  "chunks", svc.from("ingestion_chunks")
    .select("ordinal, status, source_start, source_end, segment_text, result, fact_ledger")
    .eq("run_id", RUN).order("ordinal"));
const proposals = await rows<{ id: string; ordinal: number; idx: number; payload: Record<string, unknown>; selected: boolean }>(
  "proposals", svc.from("library_import_proposals").select("id, ordinal, idx, payload, selected").eq("run_id", RUN));

console.log(`\nIMPORT TRACE — ${RUN}`);
console.log(`  ${run.destination} / ${run.entry_point} / ${run.status}   ${run.total_chunks} chunks, source_len ${run.source_len}`);
console.log(`  source_text: ${run.source_text === null ? "CLEARED — this import cannot be traced" : String(run.source_text).length + " chars"}`);
console.log(`  segments retained: ${chunks.filter((c) => c.segment_text !== null).length}/${chunks.length}`);
console.log(`  ledgers present:   ${chunks.filter((c) => c.fact_ledger !== null).length}/${chunks.length}`);
console.log(`  proposals:         ${proposals.length}`);
if (run.source_text === null) {
  console.log(`\n  Nothing further to show. Evidence for this run was destroyed before 0024.\n`);
  process.exit(0);
}

const items = (r: unknown): Record<string, unknown>[] => {
  const o = (r ?? {}) as { items?: unknown; sections?: { items?: unknown }[] };
  const flat = Array.isArray(o.items) ? o.items : [];
  const nested = Array.isArray(o.sections) ? o.sections.flatMap((s) => (Array.isArray(s?.items) ? s.items : [])) : [];
  return [...flat, ...nested].filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object");
};

const traces = [];
for (const c of chunks.filter((c) => c.status === "completed")) {
  const raw = items(c.result);
  const occupancy = raw.length;
  raw.forEach((modelItem, idx) => {
    const p = proposals.find((x) => x.ordinal === c.ordinal && x.idx === idx);
    traces.push({
      chunk: c.ordinal, idx, occupancy,
      sourceSlice: [c.source_start, c.source_end],
      segmentChars: (c.segment_text ?? "").length,
      segment: c.segment_text,
      modelItem,
      proposal: p ? p.payload : null,
      saved: p ? p.selected : null,
      ledger: c.fact_ledger,
    });
  });
}

for (const t of traces) {
  const title = String((t.modelItem as { title?: string }).title ?? "(untitled)");
  const m = t.modelItem as Record<string, unknown>;
  const dest = (k: string) => {
    const v = m[k];
    if (v == null || v === "") return null;
    if (Array.isArray(v)) return v.length ? `${k}[${v.length}]` : null;
    return `${k}(${String(v).length}ch)`;
  };
  const shape = ["address", "description", "notes", "details", "links", "photos", "contacts"].map(dest).filter(Boolean);
  console.log(`\n  chunk ${t.chunk} idx ${t.idx}  (${t.occupancy} item(s) in this chunk, segment ${t.segmentChars}ch)`);
  console.log(`    ${title}`);
  console.log(`    model filled: ${shape.join(" ") || "(title only)"}`);
  const labels = Array.isArray(m.details) ? (m.details as { label?: string }[]).map((d) => d?.label).filter(Boolean) : [];
  if (labels.length) console.log(`    detail labels: ${labels.join(" | ")}`);
  if (m.notes) console.log(`    notes: ${String(m.notes).slice(0, 160)}${String(m.notes).length > 160 ? "…" : ""}`);
  console.log(`    proposal: ${t.proposal ? (t.saved ? "saved" : "present, not saved") : "NONE"}`);
}

if (OUT) { writeFileSync(OUT, JSON.stringify({ run, traces }, null, 1)); console.log(`\n  full trace written to ${OUT}`); }
console.log("");
