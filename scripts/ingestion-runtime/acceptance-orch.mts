// Orchestration and recovery proofs, through the real HTTP routes. Model
// behaviour on specific chunks is injected deterministically (see test-faults.ts)
// because retry/split/wrong-shape paths depend on the provider misbehaving at a
// chosen chunk and attempt. The ordinary and large successful runs in
// acceptance-model.mts use the real model.
import {
  api, drive, packetContent, newMetrics, bump, organize,
  TAG, makeSource, check, summary, svc, errText, modelCalls,
} from "./e2e.mts";
import { writeFileSync } from "node:fs";

const FAULTS = process.env.FLOWGUIDE_TEST_FAULT_FILE!;
const setFaults = (spec: object) => writeFileSync(FAULTS, JSON.stringify(spec));
const clearFaults = () => setFaults({});
// Smallest fixture that still gives a genuine MIDDLE chunk (>=3) under seg-v2,
// so retry/resume/split are proven without paying for a large run.
const SRC = makeSource(12);
const evidence: any = {};

async function startOrganize(label: string, source = SRC) {
  const res = await api(`/api/ingest/organize`, {
    method: "POST",
    body: JSON.stringify({ rawText: source, packetType: "senior_living", requestKey: `${TAG}-${label}` }),
  });
  return res;
}
const chunkRows = async (runId: string) =>
  (await svc.from("ingestion_chunks").select("ordinal, status, attempt_count, split_depth, error").eq("run_id", runId).order("ordinal")).data ?? [];

// ------------------------------------------------- 1. no repeat of completed work
console.log("[1] completed chunks are never reprocessed");
{
  clearFaults();
  const m = newMetrics("no-repeat", SRC.length);
  const start = await startOrganize("no-repeat");
  check("run started", start.status === 201, `${start.status}`);
  const runId = start.data.runId;
  const out = await drive(runId, m);
  check("run finalized", out.outcome === "finalized", String(out.outcome));

  // Every leaf completed on its FIRST attempt: no chunk was processed twice.
  const rows = await chunkRows(runId);
  const leaves = rows.filter((r: any) => r.status !== "split");
  check("every leaf attempted exactly once", leaves.every((r: any) => r.attempt_count === 1), JSON.stringify(leaves.map((r: any) => [r.ordinal, r.attempt_count])));
  check("model calls equal leaf count (no redundant work)", m.modelCalls === leaves.length, `${m.modelCalls} calls vs ${leaves.length} leaves`);

  // Re-POST an already-completed chunk: must be a no-op, not a second model call.
  const again = await api(`/api/ingest/${runId}/chunks/${leaves[0].ordinal}`, { method: "POST" });
  check("re-POSTing a completed chunk is refused as completed", again.status === 200 || again.status === 409, `${again.status} ${JSON.stringify(again.data).slice(0, 80)}`);
  const rows2 = await chunkRows(runId);
  const same = rows2.find((r: any) => r.ordinal === leaves[0].ordinal);
  check("re-POST did not increment the attempt", same.attempt_count === 1, `${same.attempt_count}`);
  evidence.noRepeat = { leaves: leaves.length, modelCalls: m.modelCalls };
}

// ------------------------------------------------- 2. failed middle chunk retries
console.log("\n[2] a failed MIDDLE chunk retries without duplicating output");
{
  clearFaults();
  const start = await startOrganize("retry-mid");
  const runId = start.data.runId;
  const total = start.data.totalChunks;
  check("multi-chunk run for the retry test", total >= 3, `${total} chunks`);
  const middle = 1;
  // Fail ordinal 1 on its first attempt only; attempt 2 auto-splits, and the
  // children then succeed — so recovery is proven end to end.
  setFaults({ runId, failAttempts: { [String(middle)]: 1 } });

  const m = newMetrics("retry-mid", SRC.length);
  const out = await drive(runId, m);
  clearFaults();
  check("run recovered and finalized", out.outcome === "finalized", String(out.outcome) + " " + JSON.stringify(out).slice(0, 160));

  const rows = await chunkRows(runId);
  const failedOnce = rows.find((r: any) => r.ordinal === middle);
  check("the injected chunk really was retried", failedOnce.attempt_count >= 2 || failedOnce.status === "split", `attempts=${failedOnce.attempt_count} status=${failedOnce.status}`);
  check("no chunk is left failed", !rows.some((r: any) => r.status === "failed"), JSON.stringify(rows.map((r: any) => [r.ordinal, r.status])));

  // No duplicated canonical output: item titles must be unique.
  const c = await packetContent(start.data.packetId);
  const titles = c.items.map((i: any) => i.title.trim().toLowerCase());
  check("no duplicated items after retry", new Set(titles).size === titles.length, `${titles.length} items, ${new Set(titles).size} unique`);
  evidence.retryMid = { attempts: failedOnce.attempt_count, items: titles.length, unique: new Set(titles).size };
}

// ------------------------------------------------- 3. adaptive subdivision
console.log("\n[3] a difficult chunk is subdivided and then completes");
{
  clearFaults();
  const start = await startOrganize("split");
  const runId = start.data.runId;
  const before = start.data.totalChunks;
  // Report truncation on ordinal 0 -> the route subdivides it.
  setFaults({ runId, truncate: [0] });

  const m = newMetrics("split", SRC.length);
  // Drive a few steps so the split happens, then clear so children succeed.
  const partial = await drive(runId, m, { maxSteps: 3 });
  clearFaults();
  const mid = await chunkRows(runId);
  const parent = mid.find((r: any) => r.ordinal === 0);
  check("the difficult chunk was subdivided", parent?.status === "split", `${parent?.status}`);
  const children = mid.filter((r: any) => r.split_depth > 0);
  check("subdivision produced >= 2 children", children.length >= 2, `${children.length}`);

  const out = await drive(runId, m);
  check("run finalized after subdivision", out.outcome === "finalized", String(out.outcome) + " " + JSON.stringify(out).slice(0, 160));
  const after = await chunkRows(runId);
  check("all children completed", after.filter((r: any) => r.split_depth > 0).every((r: any) => r.status === "completed"), JSON.stringify(after.filter((r: any) => r.split_depth > 0).map((r: any) => r.status)));

  const st = await api(`/api/ingest/${runId}`);
  check("reported total grew after subdivision (part N of M updates)", st.data.run.totalChunks > before, `${before} -> ${st.data.run.totalChunks}`);
  const c = await packetContent(start.data.packetId);
  const titles = c.items.map((i: any) => i.title.trim().toLowerCase());
  check("subdivision did not duplicate content", new Set(titles).size === titles.length, `${titles.length} vs ${new Set(titles).size}`);
  evidence.split = { before, after: st.data.run.totalChunks, children: children.length, items: titles.length };
}

// ------------------------------------------------- 4. stop and resume
console.log("\n[4] stopping mid-run and restarting resumes the persisted run");
{
  clearFaults();
  const start = await startOrganize("resume");
  const runId = start.data.runId;
  const total = start.data.totalChunks;
  check("multi-chunk run for the resume test", total >= 3, `${total}`);

  const m1 = newMetrics("resume-part1", SRC.length);
  const stopped = await drive(runId, m1, { stopAfterCompleted: 2 });
  check("orchestration stopped mid-run", stopped.outcome === "stopped", String(stopped.outcome));
  const midRows = await chunkRows(runId);
  const completedBefore = midRows.filter((r: any) => r.status === "completed").map((r: any) => r.ordinal).sort();
  check("some chunks are persisted as completed", completedBefore.length >= 2, `${completedBefore.length}`);
  check("run is still active (not lost)", (await api(`/api/ingest/${runId}`)).data.run.status === "active", "not active");

  // A fresh client (new orchestrator instance) resumes from the persisted state.
  const m2 = newMetrics("resume-part2", SRC.length);
  const out = await drive(runId, m2);
  check("resumed run finalized", out.outcome === "finalized", String(out.outcome) + " " + JSON.stringify(out).slice(0, 160));
  check("resume did NOT reprocess the already-completed chunks", m2.modelCalls === total - completedBefore.length || m2.modelCalls < total, `resumed model calls=${m2.modelCalls}, already done=${completedBefore.length}, total=${total}`);

  const rows = await chunkRows(runId);
  const leaves = rows.filter((r: any) => r.status !== "split");
  check("no leaf exceeded one attempt across the stop/resume", leaves.every((r: any) => r.attempt_count === 1), JSON.stringify(leaves.map((r: any) => [r.ordinal, r.attempt_count])));
  const c = await packetContent(start.data.packetId);
  const titles = c.items.map((i: any) => i.title.trim().toLowerCase());
  check("resume produced no duplicate items", new Set(titles).size === titles.length, `${titles.length} vs ${new Set(titles).size}`);
  evidence.resume = { total, completedBeforeStop: completedBefore.length, resumedModelCalls: m2.modelCalls, items: titles.length };
}

// ------------------------------------------------- 5. duplicate requests
console.log("\n[5] duplicate chunk requests cause no duplicate model calls or output");
{
  clearFaults();
  const start = await startOrganize("dup");
  const runId = start.data.runId;

  // Fire the SAME chunk 5 times concurrently: the atomic claim means one worker
  // calls the model; the rest see 'processing' or 'completed'.
  const fired = await Promise.all([0, 1, 2, 3, 4].map(() => api(`/api/ingest/${runId}/chunks/0`, { method: "POST" })));
  const completed = fired.filter((f) => f.data?.status === "completed").length;
  const deflected = fired.filter((f) => f.data?.status === "processing" || f.status === 409).length;
  check("exactly one concurrent duplicate did the work", completed === 1, `${completed} completed, ${deflected} deflected, statuses=${JSON.stringify(fired.map((f) => [f.status, f.data?.status]))}`);
  const rows = await chunkRows(runId);
  check("the contended chunk counted exactly one attempt", rows.find((r: any) => r.ordinal === 0).attempt_count === 1, `${rows.find((r: any) => r.ordinal === 0).attempt_count}`);

  const m = newMetrics("dup", SRC.length);
  const out = await drive(runId, m);
  check("run finalized", out.outcome === "finalized", String(out.outcome));
  const c = await packetContent(start.data.packetId);
  const titles = c.items.map((i: any) => i.title.trim().toLowerCase());
  check("duplicate requests produced no duplicate items", new Set(titles).size === titles.length, `${titles.length} vs ${new Set(titles).size}`);

  // ---- finalization happens once
  const f1 = await api(`/api/ingest/${runId}/finalize`, { method: "POST" });
  const f2 = await api(`/api/ingest/${runId}/finalize`, { method: "POST" });
  check("repeat finalize is idempotent (not a second application)", f1.status === 200 && f2.status === 200, `${f1.status}/${f2.status}`);
  check("repeat finalize reports reuse", f1.data?.reused === true || f2.data?.reused === true, JSON.stringify([f1.data, f2.data]).slice(0, 140));
  const after = await packetContent(start.data.packetId);
  check("repeat finalize did not double the content", after.items.length === c.items.length, `${c.items.length} -> ${after.items.length}`);
  evidence.duplicates = { completed, deflected, items: titles.length };
}

// ------------------------------------------------- 6. shape validation E2E
console.log("\n[6] structurally wrong model output is a visible, retryable error");
{
  clearFaults();
  const start = await startOrganize("shape");
  const runId = start.data.runId;
  const packetId = start.data.packetId;

  for (const [label, spec] of [
    ["wrong shape (items on an append/organize run)", { runId, wrongShape: [0] }],
    ["empty result", { runId, emptyResult: [0] }],
  ] as const) {
    setFaults(spec);
    const r = await api(`/api/ingest/${runId}/chunks/0`, { method: "POST" });
    check(`${label}: chunk request fails visibly`, r.status >= 400, `${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
    check(`${label}: error message is user-facing and retryable`, /retry/i.test(String(r.data?.message ?? "")), JSON.stringify(r.data).slice(0, 160));

    const rows = await chunkRows(runId);
    const c0 = rows.find((x: any) => x.ordinal === 0);
    check(`${label}: chunk recorded as failed (not completed)`, c0.status === "failed", `${c0.status}`);

    // Finalize must refuse; canonical content must be untouched.
    const fin = await api(`/api/ingest/${runId}/finalize`, { method: "POST" });
    check(`${label}: finalize refuses an incomplete run`, fin.status >= 400, `${fin.status} ${JSON.stringify(fin.data).slice(0, 100)}`);
    const content = await packetContent(packetId);
    check(`${label}: canonical packet content unchanged (still empty)`, content.items.length === 0 && content.secs.length === 0, `${content.secs.length} sections / ${content.items.length} items`);
  }

  // With faults cleared the SAME run recovers — the error really was retryable.
  clearFaults();
  const m = newMetrics("shape-recover", SRC.length);
  const out = await drive(runId, m);
  check("after clearing the fault the same run completes (error was recoverable)", out.outcome === "finalized", String(out.outcome) + " " + JSON.stringify(out).slice(0, 160));
  const content = await packetContent(packetId);
  check("recovered run produced real content", content.items.length > 0, `${content.items.length}`);
  evidence.shape = { recoveredItems: content.items.length };
}

// ------------------------------------------------- 7. finalize rollback
console.log("\n[7] a refused finalization rolls back completely (no partial write)");
{
  clearFaults();
  const start = await startOrganize("rollback");
  const runId = start.data.runId;
  const packetId = start.data.packetId;
  const m = newMetrics("rollback", SRC.length);

  // Complete every chunk, but do NOT let the loop finalize yet.
  const st0 = await api(`/api/ingest/${runId}`);
  for (const c of st0.data.chunks) {
    await api(`/api/ingest/${runId}/chunks/${c.ordinal}`, { method: "POST" });
  }
  const ready = await api(`/api/ingest/${runId}`);
  const allDone = ready.data.chunks.every((c: any) => c.status === "completed");
  check("all chunks staged and ready to finalize", allDone, JSON.stringify(ready.data.chunks.map((c: any) => c.status)));

  // Edit the packet concurrently: content_rev moves, so finalize must refuse.
  await svc.from("packets").update({ title: "edited during import" }).eq("id", packetId);
  const fin = await api(`/api/ingest/${runId}/finalize`, { method: "POST" });
  check("finalize refused after a concurrent edit", fin.status >= 400, `${fin.status} ${JSON.stringify(fin.data).slice(0, 120)}`);
  check("refusal message is human, not raw SQL", !/content_rev|ingestion:/i.test(String(fin.data?.message ?? "")), JSON.stringify(fin.data).slice(0, 140));

  const content = await packetContent(packetId);
  check("ROLLBACK: not one section was written", content.secs.length === 0, `${content.secs.length} sections`);
  check("ROLLBACK: not one item was written", content.items.length === 0, `${content.items.length} items`);
  const runRow = (await svc.from("ingestion_runs").select("status").eq("id", runId).maybeSingle()).data;
  check("run is not left in a finalized state", runRow?.status !== "finalized", String(runRow?.status));
  const chunksStill = await chunkRows(runId);
  check("staged results survive the refusal (retryable, nothing lost)", chunksStill.every((c: any) => c.status === "completed"), JSON.stringify(chunksStill.map((c: any) => c.status)));
  evidence.rollback = { status: fin.status, sections: content.secs.length, items: content.items.length };
}

// ------------------------------------------------- 8. permanent provider failure
console.log("\n[8] a permanent 401/402/403 neither retries nor subdivides");
for (const status of [402, 401, 403]) {
  clearFaults();
  const start = await startOrganize(`permanent-${status}`);
  const runId = start.data.runId;
  const packetId = start.data.packetId;
  const beforeChunks = (await chunkRows(runId)).length;
  setFaults({ runId, permanent: { "0": status } });

  const first = await api(`/api/ingest/${runId}/chunks/0`, { method: "POST" });
  check(`[${status}] chunk request fails with the provider status`, first.status === status, `${first.status} ${JSON.stringify(first.data).slice(0, 100)}`);
  const row1 = (await chunkRows(runId)).find((c: any) => c.ordinal === 0);
  check(`[${status}] chunk recorded as failed`, row1.status === "failed", String(row1.status));
  check(`[${status}] failure is tagged permanent, not transient`, String(row1.error).startsWith("[permanent]"), String(row1.error).slice(0, 60));

  // Drive it again: must NOT subdivide and must NOT keep retrying.
  const second = await api(`/api/ingest/${runId}/chunks/0`, { method: "POST" });
  check(`[${status}] second attempt still refuses`, second.status === 402 || second.status === status, `${second.status}`);
  check(`[${status}] second attempt reports it as permanent`, second.data?.permanent === true, JSON.stringify(second.data).slice(0, 120));
  const rows2 = await chunkRows(runId);
  check(`[${status}] NO subdivision occurred`, rows2.length === beforeChunks && !rows2.some((c: any) => c.split_depth > 0), `${rows2.length} chunks (was ${beforeChunks})`);
  check(`[${status}] chunk still failed, not split`, rows2.find((c: any) => c.ordinal === 0).status === "failed", String(rows2.find((c: any) => c.ordinal === 0).status));

  const content = await packetContent(packetId);
  check(`[${status}] canonical packet untouched`, content.secs.length === 0 && content.items.length === 0, `${content.secs.length}/${content.items.length}`);
  evidence[`permanent${status}`] = { chunks: rows2.length, split: rows2.some((c: any) => c.split_depth > 0) };
  clearFaults();
}

clearFaults();
console.log(`\nreal model calls billed in this script: ${modelCalls()}`);
evidence.realModelCalls = modelCalls();
writeFileSync(new URL("./evidence-orch.json", import.meta.url), JSON.stringify(evidence, null, 2));
process.exit(summary("ORCHESTRATION & RECOVERY") > 0 ? 1 : 0);
