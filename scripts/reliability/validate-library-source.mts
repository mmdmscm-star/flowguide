// FULL EXACT-SOURCE VALIDATION of the Library importer.
// Drives the real production import path under a DISPOSABLE user and stops at
// the proposals stage — nothing is ever saved into the real Library.
import { svc, errText } from "../ingestion-runtime/lib.mts";
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.FLOWGUIDE_BASE_URL || "https://flowguide-ruddy.vercel.app";
const SRC = readFileSync(process.argv[2], "utf8");
const OUT = process.argv[3];
// CONTROLLED PACING. Concurrency is 1 by construction — one chunk at a time,
// awaited. What defeated the last two attempts was OpenRouter's IN-FLIGHT
// BUDGET, not credit exhaustion: a single chunk still succeeded afterwards.
// FlowGuide maps every 402 to "out of credits", so the two cannot be told
// apart from the response alone; they are separated here by probing with one
// small request after a wait. Everything is bounded.
const RETRY_AFTER_MS = Number(process.env.FG_RETRY_AFTER_MS ?? 125_000);
const MAX_BUDGET_WAITS = Number(process.env.FG_MAX_BUDGET_WAITS ?? 6);
const INTER_CHUNK_MS = Number(process.env.FG_INTER_CHUNK_MS ?? 1200);

// Declared at module scope: it is read in the finally block, and declaring it
// inside the try meant the diagnostics capture threw "halted is not defined"
// and wrote nothing — the exact evidence loss this capture exists to prevent.
let halted = "";

const TAG = "flowguide-rt-" + process.pid;
const { data: u, error: ue } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (ue) { console.error(errText(ue)); process.exit(1); }
const UID = (u as any).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now()+864e5).toISOString() });
const api = (p: string, i: RequestInit = {}) => fetch(`${BASE}${p}`, { ...i,
  headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${token}`, ...(i.headers||{}) } });

try {
  console.log(`source: ${SRC.length} chars`);
  const start = await api("/api/library/import", { method: "POST", body: JSON.stringify({ rawText: SRC }) });
  const sd = await start.json();
  if (start.status !== 201) { console.error(`start ${start.status}: ${JSON.stringify(sd).slice(0,200)}`); process.exit(1); }
  const runId = sd.runId;
  console.log(`run ${String(runId).slice(0,8)}  chunks=${sd.totalChunks}`);

  let done = 0, failed = 0, waits = 0, budgetWaits = 0, capacityWaits = 0;
  for (let step = 0; step < 400; step++) {
    const st = await (await api(`/api/ingest/${runId}`)).json();
    const run = st?.run; if (!run) { console.log("run lost"); break; }
    const chunks = (st.chunks ?? []) as any[];
    done = chunks.filter(c => c.status === "completed").length;
    if (["finalized","discarded","needs_review"].includes(String(run.status))) break;
    const next = chunks.find(c => c.status === "pending" || c.status === "failed");
    if (!next) {
      // A chunk claimed by an in-flight request is 'processing', not pending.
      // The real client sleeps and retries here; exiting instead ends the run
      // early and the proposals POST then answers 409 "still being organized".
      const busy = chunks.filter(c => c.status === "processing").length;
      if (busy && waits < 40) { waits++; await new Promise(r => setTimeout(r, 4000)); continue; }
      break;
    }
    const r = await api(`/api/ingest/${runId}/chunks/${next.ordinal}`, { method: "POST" });
    if (r.status >= 500) failed++;
    if (r.status === 429) {
      // The server now recognises temporary provider capacity and keeps the
      // chunk retryable. Honour its Retry-After and come back to it.
      const b = await r.json().catch(() => ({}));
      const wait = Math.min(Number(b?.retryAfterSeconds ?? 120), 180) * 1000;
      capacityWaits++;
      console.log(`\n  capacity 429 on chunk ${next.ordinal} (${capacityWaits}) — waiting ${wait/1000}s`);
      if (capacityWaits > 12) { console.log("  capacity waits exhausted"); halted = "capacity_exhausted"; break; }
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    if (r.status === 402) {
      // Either the in-flight budget or a genuinely empty account. Wait for the
      // Retry-After window, then probe once with a tiny request: if that
      // succeeds the ceiling was concurrency and the run continues; if it does
      // not, the account is out of credits and there is nothing to wait for.
      budgetWaits++;
      const body = await r.json().catch(() => ({}));
      console.log(`\n  402 on chunk ${next.ordinal} (wait ${budgetWaits}/${MAX_BUDGET_WAITS}): ${String(body?.message ?? "").slice(0, 90)}`);
      if (budgetWaits > MAX_BUDGET_WAITS) { console.log("  BUDGET WAITS EXHAUSTED — stopping"); halted = "budget_waits_exhausted"; break; }
      await new Promise((res) => setTimeout(res, RETRY_AFTER_MS));
      // The probe needs its OWN user: only one library import may be active per
      // user, so probing as this one always answered 409 and the discriminator
      // silently never ran.
      const pTag = `flowguide-rt-probe-${process.pid}-${budgetWaits}`;
      const { data: pu } = await svc.from("users").insert({ email: `${pTag}@disposable.invalid` }).select("id").single();
      const pUid = (pu as { id: string } | null)?.id;
      let probeOk = false;
      if (pUid) {
        const pTok = crypto.randomUUID();
        await svc.from("sessions").insert({ user_id: pUid, token: pTok, expires_at: new Date(Date.now()+864e5).toISOString() });
        const pApi = (pp: string, ii: RequestInit = {}) => fetch(`${BASE}${pp}`, { ...ii,
          headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${pTok}`, ...(ii.headers||{}) } });
        const probe = await pApi("/api/library/import", { method: "POST",
          body: JSON.stringify({ rawText: "Probe Community\nType: AL\nCapacity: 10\nStudio: $1,000/month\n" }) });
        const pd = await probe.json().catch(() => ({}));
        if (probe.status === 201 && pd?.runId) {
          const pr = await pApi(`/api/ingest/${pd.runId}/chunks/0`, { method: "POST" });
          probeOk = pr.status === 200;
        }
        await svc.from("users").delete().eq("id", pUid);
      }
      if (!probeOk) { console.log("  PROBE ALSO FAILED — the account is credit-limited, not concurrency-limited"); halted = "credits_exhausted"; break; }
      // A fresh call succeeds, so capacity exists. If THIS chunk still refuses,
      // it is not the account: FlowGuide records a 402 as PERMANENT and replays
      // it without calling the provider again, so the chunk can never recover.
      console.log("  probe succeeded — capacity exists; this chunk is poisoned, not the account");
      halted = "chunk_marked_permanent";
      break;
    }
    if (INTER_CHUNK_MS) await new Promise((res) => setTimeout(res, INTER_CHUNK_MS));
    if (step % 10 === 0) process.stdout.write(`\r  chunks completed: ${done}/${chunks.length}   `);
  }
  console.log(`\n  chunks completed: ${done}  (server errors: ${failed})`);

  const pr = await api(`/api/library/import/${runId}/proposals`, { method: "POST" });
  console.log(`proposals POST: ${pr.status}`);
  const listed = await (await api(`/api/library/import/${runId}/proposals`)).json();
  const props = (listed?.proposals ?? listed?.data ?? []) as any[];
  console.log(`proposals produced: ${props.length}   continuation merges applied: ${(await pr.clone?.().json?.().catch(() => ({})))?.merged ?? "n/a"}`);
  writeFileSync(OUT, JSON.stringify({ runId, proposals: props }, null, 2));
  console.log(`raw proposals -> ${OUT}`);
} finally {
  // EVIDENCE BEFORE CLEANUP. Deleting the disposable user cascades the run and
  // its chunks away; the last failed benchmark erased exactly what was needed
  // to diagnose it, and the answer had to be recovered from server logs.
  try {
    const { data: runs } = await svc.from("ingestion_runs").select("*").eq("user_id", UID);
    const ids = (runs ?? []).map((r: { id: string }) => r.id);
    const { data: chs } = ids.length
      ? await svc.from("ingestion_chunks").select("run_id, ordinal, status, attempt_count, error, split_depth").in("run_id", ids)
      : { data: [] };
    const { data: props } = ids.length
      ? await svc.from("library_import_proposals").select("run_id, ordinal, idx, payload").in("run_id", ids)
      : { data: [] };
    writeFileSync(OUT.replace(/\.json$/, "") + "-diagnostics.json",
      JSON.stringify({ halted, runs, chunks: chs, proposals: props }, null, 2));
    console.log(`diagnostics -> ${OUT.replace(/\.json$/, "")}-diagnostics.json`);
  } catch (e) { console.log(`diagnostics capture failed: ${(e as Error).message}`); }

  await svc.from("library_items").delete().eq("user_id", UID);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count } = await svc.from("library_items").select("id", { count: "exact", head: true }).eq("user_id", UID);
  console.log(`cleanup: ${count ?? 0} library rows for the disposable user — ${count ? "NOT CLEAN" : "clean"}`);
}
