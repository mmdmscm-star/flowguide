"use client";
import { useCallback, useRef, useState } from "react";
import { classifyChunkResponse, CHUNK_NETWORK_FAILURE, type ChunkOutcome } from "./chunk-outcome.ts";
import type { ReviewFailure } from "./review-units.ts";

// Client orchestrator for a persisted, resumable ingestion run. Drives chunks
// sequentially against the persisted plan, shows real progress (completed
// persisted chunks / total), auto-subdivides a chunk that times out or truncates,
// and finalizes when every leaf chunk is done. Safe to stop and reconnect: the
// server holds the truth, so resume() re-drives from the persisted cursor.

export type IngestPhase = "idle" | "preparing" | "processing" | "combining" | "done" | "needs_review" | "error";

export interface IngestState {
  phase: IngestPhase;
  runId: string | null;
  done: number;
  total: number;
  subdividing: boolean;
  error: string;
  /** Why the run needs review, in the professional's language. Set with
   *  phase "needs_review" — the run applied, but publishing is blocked. */
  reviewSummary: string;
  /** The way out, computed server-side: discard removes an EMPTY packet but
   *  preserves one with content, so the honest sentence differs per case. */
  reviewExit: string;
  /** The individual blockers. Each resolvable one carries the verbatim source
   *  excerpt - a professional cannot decide about content they cannot read. */
  reviewFailures: ReviewFailure[];
  /** The unit currently being decided, so its buttons can show they are working
   *  and cannot be pressed twice. "" when idle. */
  resolving: string;
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
async function processChunk(runId: string, ordinal: number): Promise<ChunkOutcome> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CHUNK_CLIENT_TIMEOUT_MS);
  try {
    const r = await fetch(`/api/ingest/${runId}/chunks/${ordinal}`, { method: "POST", signal: ctrl.signal });
    clearTimeout(t);
    const data = await r.json().catch(() => ({}));
    // ONE shared rule, so the packet driver and the Library driver cannot
    // disagree about what is retryable. The previous inline version treated a
    // transient provider failure as terminal even though the server had marked
    // it retryable — see chunk-outcome.ts.
    return classifyChunkResponse(r.status, r.ok, data as Record<string, unknown>);
  } catch {
    clearTimeout(t);
    return CHUNK_NETWORK_FAILURE;   // client-side timeout -> reclaim after lease
  }
}

export function useIngestion(packetId: string, opts?: { onComplete?: () => void; onNeedsReview?: () => void }) {
  const [state, setState] = useState<IngestState>({ phase: "idle", runId: null, done: 0, total: 0, subdividing: false, error: "", reviewSummary: "", reviewExit: "", reviewFailures: [], resolving: "" });
  const cancelled = useRef(false);
  const runIdRef = useRef<string | null>(null);

  const drive = useCallback(async (runId: string) => {
    runIdRef.current = runId;
    setState((s) => ({ ...s, runId, phase: "processing", error: "" }));
    for (let step = 0; step < MAX_STEPS; step++) {
      if (cancelled.current) return;
      const { data: st } = await getJSON(`/api/ingest/${runId}`);
      if (!st?.run) { setState((s) => ({ ...s, phase: "error", error: "Lost track of the import." })); return; }
      const run = st.run as { status: string; totalChunks: number; review?: { ok?: boolean; summary?: string; exit?: string; failures?: ReviewFailure[] } };
      const leaves = (st.chunks || []) as Array<{ ordinal: number; status: string }>;
      if (run.status === "finalized") { setState((s) => ({ ...s, phase: "done", done: run.totalChunks, total: run.totalChunks })); opts?.onComplete?.(); return; }
      // needs_review is non-terminal and BLOCKS PUBLISHING. Treating it as
      // "finalized" here (or letting it fall through to the processing path)
      // is what left a professional with a blocked packet and no way out.
      if (run.status === "needs_review") {
        setState((s) => ({ ...s, phase: "needs_review", done: run.totalChunks, total: run.totalChunks, reviewSummary: run.review?.summary || "", reviewExit: run.review?.exit || "", reviewFailures: run.review?.failures || [] }));
        opts?.onNeedsReview?.();
        return;
      }
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
        if (fin.data?.ok) {
          // `ok` only means the RPC applied. The accounting verdict is
          // review.ok — reading the wrong one reported a blocked run as "Done."
          const review = fin.data?.review as { ok?: boolean; summary?: string; exit?: string; failures?: ReviewFailure[] } | undefined;
          if (review && review.ok === false) {
            setState((s) => ({ ...s, phase: "needs_review", done: run.totalChunks, total: run.totalChunks, reviewSummary: review.summary || "", reviewExit: review.exit || "", reviewFailures: review.failures || [] }));
            opts?.onNeedsReview?.();
            return;
          }
          setState((s) => ({ ...s, phase: "done", done: run.totalChunks, total: run.totalChunks })); opts?.onComplete?.(); return;
        }
        // 409 means "not every part is done yet" — recoverable, so keep driving
        // instead of surfacing it as a failure.
        if (fin.status === 409) { await sleep(RETRY_BACKOFF_MS); continue; }
        setState((s) => ({ ...s, phase: "error", error: fin.data?.message || fin.data?.error || "Could not combine the results." }));
        return;
      }
      const res = await processChunk(runId, next.ordinal);
      if (cancelled.current) return;
      if (res.kind === "split") { setState((s) => ({ ...s, subdividing: true })); continue; }
      if (res.kind === "completed") { setState((s) => ({ ...s, subdividing: false })); continue; }
      if (res.kind === "retry") { await sleep(RETRY_BACKOFF_MS); continue; } // reclaim after lease; server auto-splits on the 2nd attempt
      { const msg = res.message; setState((s) => ({ ...s, phase: "error", error: msg })); return; }
    }
    setState((s) => ({ ...s, phase: "error", error: "Import did not converge." }));
  }, [opts]);

  const start = useCallback(async (args: StartArgs) => {
    cancelled.current = false;
    setState({ phase: "preparing", runId: null, done: 0, total: 0, subdividing: false, error: "", reviewSummary: "", reviewExit: "", reviewFailures: [], resolving: "" });
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
    setState({ phase: "idle", runId: null, done: 0, total: 0, subdividing: false, error: "", reviewSummary: "", reviewExit: "", reviewFailures: [], resolving: "" });
  }, []);
  /** Record one decision about one held unit.
   *
   *  The server is re-read afterwards rather than the local array being patched:
   *  whether this was the LAST unit is a question only the database can answer,
   *  and answering it optimistically here is how a client comes to believe
   *  publishing is unblocked while the run still blocks it. */
  const resolveUnit = useCallback(async (unitId: string, status: "resolved" | "ignored") => {
    const runId = runIdRef.current; if (!runId) return;
    setState((s) => ({ ...s, resolving: unitId, error: "" }));
    const res = await postJSON(`/api/ingest/${runId}/review/${encodeURIComponent(unitId)}`, { status });
    if (!res.data?.ok) {
      setState((s) => ({ ...s, resolving: "", error: res.data?.message || "Could not update this item." }));
      return;
    }
    const { data: st } = await getJSON(`/api/ingest/${runId}`);
    const run = st?.run as { status?: string; totalChunks?: number;
      review?: { summary?: string; exit?: string; failures?: ReviewFailure[] } } | undefined;
    if (!run) { setState((s) => ({ ...s, resolving: "" })); return; }
    if (run.status === "finalized") {
      setState((s) => ({ ...s, phase: "done", reviewFailures: [], reviewSummary: "", error: "", resolving: "" }));
      opts?.onComplete?.();
      return;
    }
    setState((s) => ({ ...s, phase: "needs_review", error: "", resolving: "",
      reviewSummary: run.review?.summary || "", reviewExit: run.review?.exit || "",
      reviewFailures: run.review?.failures || [] }));
  }, [opts]);

  const cancel = useCallback(() => { cancelled.current = true; }, []);

  return { state, start, resume, retry, discard, cancel, resolveUnit };
}
