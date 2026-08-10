// Stage 1 acceptance: the FAILURE path.
//
// A clean run proves nothing about a safety mechanism. This deliberately
// reproduces the 2026-08-05 shape — a chunk that returns nothing, so a whole
// record's media never lands — and walks the entire lifecycle:
//
//   needs_review persisted -> packet still editable -> publishing BLOCKED
//   -> held content resolved -> run finalized -> publishing available
//
// The failure is injected through src/lib/test-faults.ts (inert unless
// FLOWGUIDE_TEST_FAULT_FILE is set outside production), so the chunk travels the
// real route and the real validation path.
//
//   FLOWGUIDE_RT_CONFIRM=1 npx tsx scripts/ingestion-runtime/verify-needs-review.mts
//
// Requires migration 0013. Consumes real model credits for the non-faulted chunks.
import { writeFileSync } from "node:fs";
import { api, drive, newMetrics, svc, check, summary } from "./e2e.mts";
import { buildMediaLedger } from "../../src/lib/media-ledger.ts";

const FAULT_FILE = process.env.FLOWGUIDE_TEST_FAULT_FILE;
if (!FAULT_FILE) { console.error("FLOWGUIDE_TEST_FAULT_FILE must be set (and the dev server must see it)"); process.exit(1); }

const EVIDENCE_PACKET = "1d1e9f41-6821-4dc7-8e65-35ce53859a14";
const { data: ev } = await svc.from("packets").select("raw_input").eq("id", EVIDENCE_PACKET).maybeSingle();
const SOURCE: string = (ev as { raw_input?: string } | null)?.raw_input ?? "";
if (!SOURCE) { console.error("could not read the preserved source"); process.exit(1); }

// Chunk 2 is the Drake Terrace record and carries 9 of the 19 photos. Forcing it
// to return nothing is exactly what the model did on 2026-08-05.
const setFaults = (spec: object) => writeFileSync(FAULT_FILE, JSON.stringify(spec, null, 1));
setFaults({ flowguideFaultInjection: true, emptyResult: [2] });
console.log("fault armed: chunk 2 returns an empty result\n");

const m = newMetrics("needs-review", SOURCE.length);
const res = await api("/api/ingest/organize", {
  method: "POST",
  body: JSON.stringify({ rawText: SOURCE, packetType: "general", requestKey: `nr-${process.pid}` }),
});
check("[setup] organize accepted", res.status === 201, `${res.status}`);
if (res.status !== 201) { summary(); process.exit(1); }
const packetId = res.data.packetId as string;
const runId = res.data.runId as string;

const out = await drive(runId, m);
console.log(`drive outcome: ${out.outcome}`);

// ---- 1. the run must persist as needs_review
const runRow = async () => (await svc.from("ingestion_runs").select("status, review").eq("id", runId).maybeSingle()).data as any;
let run = await runRow();
check("[1] run persisted as needs_review", run?.status === "needs_review", `status=${run?.status}`);
const failures = (run?.review?.failures ?? []) as Array<{ code: string; url: string }>;
check("[1] review payload records the missing media", failures.length === 9 && failures.every((f) => f.code === "media_missing"),
  `${failures.length} failures: ${JSON.stringify(failures.slice(0, 2))}`);
console.log(`   review summary: ${JSON.stringify(run?.review?.summary)}`);

// ---- 2. the packet must remain fully editable
const { data: secs } = await svc.from("sections").select("id").eq("packet_id", packetId);
const sectionIds = (secs ?? []).map((s: any) => s.id);
const { data: items } = await svc.from("items").select("id, title").in("section_id", sectionIds);
const list = (items ?? []) as Array<{ id: string; title: string }>;
check("[2] the two good records still landed", list.length === 2, `${list.length}: ${JSON.stringify(list.map((i) => i.title))}`);
// The LEGACY editor's own endpoint — /api/packets/:id/items/:itemId is the
// blocks-mode path and rejects a legacy packet regardless of review state.
const edit = await api(`/api/items`, {
  method: "PATCH", body: JSON.stringify({ id: list[0].id, title: `${list[0].title} (edited)` }),
});
check("[2] packet remains editable while under review", edit.status >= 200 && edit.status < 300, `${edit.status} ${JSON.stringify(edit.data).slice(0, 120)}`);

// ---- 3. publishing must be blocked
const pub = await api(`/api/packets/${packetId}/publish`, {
  method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }),
});
const pubMsg = JSON.stringify(pub.data);
check("[3] publishing BLOCKED while the run needs review", pub.status >= 400, `${pub.status} ${pubMsg.slice(0, 140)}`);
check("[3] refusal cites the import, not a malformed request",
  /import|review/i.test(pubMsg) && !/invalid action/i.test(pubMsg), `${pub.status} ${pubMsg.slice(0, 160)}`);

// ---- 4. resolve the held content, then re-account
// The professional's "discard remaining, with a reason" route: the media is
// deliberately rejected, which is a valid disposition, not a silent drop.
const rejected = failures.map((f) => f.url);
const stored: Array<{ url: string; itemId: string }> = [];
for (const it of list) {
  const { data: ph } = await svc.from("item_photos").select("url").eq("item_id", it.id);
  for (const p of (ph ?? []) as any[]) stored.push({ url: p.url, itemId: it.id });
}
const after = buildMediaLedger({ source: SOURCE, stored, rejected });
check("[4] ledger clears once the held media is deliberately rejected", after.ok,
  `${after.failures.length} remaining`);

const { error: resolveErr } = await svc.from("ingestion_runs")
  .update({ status: "finalized", review: { ok: true, summary: "", failures: [], resolution: "discarded_with_reason" } })
  .eq("id", runId);
check("[5] run can transition out of needs_review", !resolveErr, resolveErr?.message ?? "");
run = await runRow();
check("[5] run is finalized", run?.status === "finalized", `status=${run?.status}`);

// ---- 6. publishing must now be available
const pub2 = await api(`/api/packets/${packetId}/publish`, {
  method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }),
});
check("[6] publishing available once resolved", pub2.status >= 200 && pub2.status < 300,
  `${pub2.status} ${JSON.stringify(pub2.data).slice(0, 160)}`);

setFaults({ flowguideFaultInjection: false });
console.log(`\ndisposable packet ${packetId} — removed by cleanup.mts`);
summary();
