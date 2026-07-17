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

const CHUNK_CLIENT_TIMEOUT_MS = 75000; // just past the 60s function limit
const MAX_STEPS = 800;

async function getJSON(url: string) { const r = await fetch(url); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function postJSON(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

// Process one chunk; on a client-side timeout / platform 504 subdivide & retry
// once. Pure (no hook state) so it can recurse safely.
async function processChunk(runId: string, ordinal: number, forceSplit = false): Promise<{ split?: boolean; completed?: boolean; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CHUNK_CLIENT_TIMEOUT_MS);
  try {
    const r = await fetch(`/api/ingest/${runId}/chunks/${ordinal}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ forceSplit }), signal: ctrl.signal,
    });
    clearTimeout(t);
    if (r.status === 504 || r.status === 502 || r.status === 500) {
      if (!forceSplit) return processChunk(runId, ordinal, true);
      return { error: "The AI took too long on a part. You can retry." };
    }
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      if (data.status === "split") return { split: true };
      return { completed: true };
    }
    return { error: data.message || data.error || "A part failed. You can retry." };
  } catch {
    clearTimeout(t);
    if (!forceSplit) return processChunk(runId, ordinal, true); // aborted -> subdivide then retry
    return { error: "A part timed out. You can retry." };
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
        setState((s) => ({ ...s, phase: "combining" }));
        const fin = await postJSON(`/api/ingest/${runId}/finalize`, {});
        if (fin.data?.ok) { setState((s) => ({ ...s, phase: "done", done: run.totalChunks, total: run.totalChunks })); opts?.onComplete?.(); return; }
        setState((s) => ({ ...s, phase: "error", error: fin.data?.message || fin.data?.error || "Could not combine the results." }));
        return;
      }
      const res = await processChunk(runId, next.ordinal);
      if (cancelled.current) return;
      if (res.split) { setState((s) => ({ ...s, subdividing: true })); continue; }
      if (res.completed) { setState((s) => ({ ...s, subdividing: false })); continue; }
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
