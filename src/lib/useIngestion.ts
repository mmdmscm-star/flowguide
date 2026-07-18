"use client";
import { useCallback, useRef, useState } from "react";

// Client orchestrator for a persisted, resumable ingestion run. Drives chunks
// sequentially against the persisted plan, shows real progress (completed
// persisted chunks / total), auto-subdivides a chunk that times out or truncates,
// and finalizes when every leaf chunk is done. Safe to stop and reconnect: the
// server holds the truth, so resume() re-drives from the persisted cursor.

export type IngestPhase = "idle" | "preparing" | "processing" | "combining" | "done" | "error";

export interface IngestState {
  phase: IngestPhase;
  runId: string | null;
  done: number;
  total: number;
  subdividing: boolean;
  error: string;
}

interface StartArgs { entryPoint: "organize" | "append" | "section_append"; rawText: string; targetSectionId?: string | null; packetType?: string }

const CHUNK_CLIENT_TIMEOUT_MS = 70000; // backstop past the 60s function limit
const RETRY_BACKOFF_MS = 6000;         // wait before reclaiming a stuck/processing chunk
const MAX_STEPS = 800;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function getJSON(url: string) { const r = await fetch(url); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function postJSON(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

// Process one chunk. The server claims it atomically and, on a retry of a
// timed-out/oversized segment, subdivides it automatically. A platform 504 or a
// client-side timeout is transient: we back off and let the drive loop retry,
// which reclaims after the lease and (on the 2nd attempt) triggers the split.
async function processChunk(runId: string, ordinal: number): Promise<{ split?: boolean; completed?: boolean; retry?: boolean; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CHUNK_CLIENT_TIMEOUT_MS);
  try {
    const r = await fetch(`/api/ingest/${runId}/chunks/${ordinal}`, { method: "POST", signal: ctrl.signal });
    clearTimeout(t);
    if (r.status === 504 || r.status === 502 || r.status === 500) return { retry: true };
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      if (data.status === "split") return { split: true };
      if (data.status === "processing") return { retry: true }; // another attempt holds it
      if (data.status === "completed") return { completed: true };
      return { retry: true };
    }
    return { error: data.message || data.error || "A part failed. You can retry." };
  } catch {
    clearTimeout(t);
    return { retry: true }; // client-side timeout -> reclaim after lease
  }
}

export function useIngestion(packetId: string, opts?: { onComplete?: () => void }) {
  const [state, setState] = useState<IngestState>({ phase: "idle", runId: null, done: 0, total: 0, subdividing: false, error: "" });
  const cancelled = useRef(false);
  const runIdRef = useRef<string | null>(null);

  const drive = useCallback(async (runId: string) => {
    runIdRef.current = runId;
    setState((s) => ({ ...s, runId, phase: "processing", error: "" }));
    for (let step = 0; step < MAX_STEPS; step++) {
      if (cancelled.current) return;
      const { data: st } = await getJSON(`/api/ingest/${runId}`);
      if (!st?.run) { setState((s) => ({ ...s, phase: "error", error: "Lost track of the import." })); return; }
      const run = st.run as { status: string; totalChunks: number };
      const leaves = (st.chunks || []) as Array<{ ordinal: number; status: string }>;
      if (run.status === "finalized") { setState((s) => ({ ...s, phase: "done", done: run.totalChunks, total: run.totalChunks })); opts?.onComplete?.(); return; }
      if (run.status === "discarded" || run.status === "error") { setState((s) => ({ ...s, phase: "error", error: "Import was stopped." })); return; }
      const done = leaves.filter((c) => c.status === "completed").length;
      setState((s) => ({ ...s, phase: "processing", done, total: run.totalChunks }));

      const next = leaves.find((c) => c.status === "pending" || c.status === "failed");
      if (!next) {
        // A chunk claimed by a still-in-flight request is 'processing', not
        // pending. Finalizing now would fail with "chunk N not completed". This
        // happens on reconnect (refresh mid-import): the pre-refresh worker is
        // still running server-side. Wait for it — the lease guarantees the
        // chunk becomes reclaimable if that worker never returns.
        if (leaves.some((c) => c.status === "processing")) {
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        setState((s) => ({ ...s, phase: "combining" }));
        const fin = await postJSON(`/api/ingest/${runId}/finalize`, {});
        if (fin.data?.ok) { setState((s) => ({ ...s, phase: "done", done: run.totalChunks, total: run.totalChunks })); opts?.onComplete?.(); return; }
        // 409 means "not every part is done yet" — recoverable, so keep driving
        // instead of surfacing it as a failure.
        if (fin.status === 409) { await sleep(RETRY_BACKOFF_MS); continue; }
        setState((s) => ({ ...s, phase: "error", error: fin.data?.message || fin.data?.error || "Could not combine the results." }));
        return;
      }
      const res = await processChunk(runId, next.ordinal);
      if (cancelled.current) return;
      if (res.split) { setState((s) => ({ ...s, subdividing: true })); continue; }
      if (res.completed) { setState((s) => ({ ...s, subdividing: false })); continue; }
      if (res.retry) { await sleep(RETRY_BACKOFF_MS); continue; } // reclaim after lease; server auto-splits on the 2nd attempt
      if (res.error) { const msg = res.error; setState((s) => ({ ...s, phase: "error", error: msg })); return; }
    }
    setState((s) => ({ ...s, phase: "error", error: "Import did not converge." }));
  }, [opts]);

  const start = useCallback(async (args: StartArgs) => {
    cancelled.current = false;
    setState({ phase: "preparing", runId: null, done: 0, total: 0, subdividing: false, error: "" });
    const res = await postJSON(`/api/packets/${packetId}/ingest`, args);
    if (res.status === 409 && res.data?.runId) { await drive(res.data.runId); return; }
    if (!res.data?.runId) { setState((s) => ({ ...s, phase: "error", error: res.data?.message || res.data?.error || "Could not start the import." })); return; }
    await drive(res.data.runId);
  }, [packetId, drive]);

  const resume = useCallback(async (runId: string) => { cancelled.current = false; await drive(runId); }, [drive]);
  const retry = useCallback(async () => { if (runIdRef.current) { cancelled.current = false; await drive(runIdRef.current); } }, [drive]);
  const discard = useCallback(async () => {
    const runId = runIdRef.current; if (!runId) return;
    cancelled.current = true;
    await postJSON(`/api/ingest/${runId}/discard`, {});
    setState({ phase: "idle", runId: null, done: 0, total: 0, subdividing: false, error: "" });
  }, []);
  const cancel = useCallback(() => { cancelled.current = true; }, []);

  return { state, start, resume, retry, discard, cancel };
}
