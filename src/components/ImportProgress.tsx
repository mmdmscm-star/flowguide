"use client";
import { useEffect, useRef } from "react";
import { useIngestion } from "@/lib/useIngestion";

// Drives (resumes) a persisted ingestion run and shows real progress. Rendered
// whenever a packet has an active run — from a fresh Organize, an Add-with-AI, or
// a page reload mid-import. Progress reflects completed persisted chunks.
export default function ImportProgress({
  packetId,
  runId,
  onDone,
  onDiscarded,
}: {
  packetId: string;
  runId: string;
  onDone: () => void;
  onDiscarded: () => void;
}) {
  const { state, resume, retry, discard } = useIngestion(packetId, { onComplete: onDone });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    resume(runId);
  }, [runId, resume]);

  const { phase, done, total, subdividing, error } = state;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const heading =
    phase === "preparing" ? "Preparing your information…"
    : phase === "combining" ? "Combining and checking the result…"
    : phase === "done" ? "Done."
    : phase === "error" ? "Import paused"
    : total > 0 ? `Processing part ${Math.min(done + 1, total)} of ${total}…`
    : "Reading your notes…";

  return (
    <div className="rounded-xl border border-border bg-blue-50/60 p-4 mb-5">
      <div className="flex items-center gap-3">
        {phase !== "error" && phase !== "done" && (
          <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        )}
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">{heading}</p>
          {phase !== "error" && (
            <div className="mt-2 h-1.5 w-full rounded-full bg-blue-100 overflow-hidden">
              <div className="h-full bg-accent transition-all" style={{ width: `${phase === "combining" ? 100 : pct}%` }} />
            </div>
          )}
          {subdividing && phase === "processing" && (
            <p className="mt-1 text-xs text-muted">A large part is being divided further so it stays reliable…</p>
          )}
          {phase === "error" && <p className="mt-1 text-sm text-red-700">{error} Your completed parts are saved.</p>}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        {phase === "error" && (
          <button onClick={() => retry()} className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium">
            Resume import
          </button>
        )}
        {phase !== "done" && (
          <button
            onClick={async () => { await discard(); onDiscarded(); }}
            className="px-3 py-1.5 rounded-lg text-sm font-medium text-muted hover:text-foreground border border-border"
          >
            Discard import
          </button>
        )}
      </div>
    </div>
  );
}
