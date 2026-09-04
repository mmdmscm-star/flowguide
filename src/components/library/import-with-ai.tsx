"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { uploadCreatorImage } from "@/lib/image-upload-client";
import { BlockItemEditor } from "@/components/editor/block-item-editor";
import { snapshotToItem } from "@/lib/library-adapter";
import type { ItemContentPayload } from "@/lib/item-content";
import type { Proposal } from "@/lib/library-import";
import { classifyChunkResponse, CHUNK_NETWORK_FAILURE } from "@/lib/chunk-outcome";

// Library → Import with AI.
//
// The lifecycle, and every part of it is durable:
//   paste -> chunked extraction -> materialise proposals -> review/edit/select
//         -> save selected -> finish (or abandon)
//
// The claim/lease/split protocol is entirely server-side and shared with packet
// ingestion; what lives here is orchestration — which chunk to ask for next, and
// what to show. That loop is deliberately NOT extracted from useIngestion:
// useIngestion's remaining bulk is packet finalize, review-exit and discard
// logic that a Library import does not have, and refactoring the proven packet
// driver to share thirty lines would put it at risk for no functional gain.

type Phase = "idle" | "extracting" | "review" | "closed";

export function ImportWithAI({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [editing, setEditing] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const stop = useRef(false);

  const json = async (url: string, init?: RequestInit) => {
    const res = await fetch(url, {
      ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
    return { status: res.status, ok: res.ok, data: await res.json().catch(() => ({})) };
  };

  // ---- restore ------------------------------------------------------------
  // An import survives a closed tab. On mount, reconnect to whatever is open —
  // mid-extraction it resumes the loop, mid-review it restores every edit and
  // selection exactly as they were left.
  const load = useCallback(async (id: string) => {
    const { ok, data } = await json(`/api/library/import/${id}/proposals`);
    if (!ok) { setError(data.message || "Could not load this import."); return null; }
    setProposals(data.proposals ?? []);
    setDone(data.run?.completedChunks ?? 0);
    setTotal(data.run?.totalChunks ?? 0);
    setPhase(data.phase);
    return data.phase as Phase;
  }, []);

  useEffect(() => {
    (async () => {
      const { data } = await json("/api/library/import");
      if (data?.run?.id) { setRunId(data.run.id); await load(data.run.id); }
    })();
    return () => { stop.current = true; };
  }, [load]);

  // ---- extraction ---------------------------------------------------------
  const drive = useCallback(async (id: string) => {
    setPhase("extracting");
    for (;;) {
      if (stop.current) return;
      const { data: st } = await json(`/api/ingest/${id}`);
      const chunks = (st.chunks ?? []) as { ordinal: number; status: string }[];
      setTotal(st.run?.totalChunks ?? chunks.length);
      setDone(chunks.filter((c) => c.status === "completed").length);

      if (st.run?.status && st.run.status !== "active") { setPhase("closed"); return; }

      const next = chunks.find((c) => c.status === "pending" || c.status === "failed");
      if (!next) {
        const busyChunk = chunks.find((c) => c.status === "processing");
        if (busyChunk) { await new Promise((r) => setTimeout(r, 2500)); continue; }
        // Everything is in. Materialising is idempotent, so calling it on every
        // reconnect is safe and never disturbs a reviewed edit.
        const { ok, data } = await json(`/api/library/import/${id}/proposals`, { method: "POST" });
        if (!ok) { setError(data.message || "Could not prepare the results."); return; }
        setProposals(data.proposals ?? []);
        setPhase("review");
        return;
      }
      // The SAME rule the packet driver uses. Treating every non-ok response as
      // terminal stranded an import on a transient provider hiccup the server
      // had already marked retryable — see chunk-outcome.ts.
      let outcome;
      try {
        const r = await json(`/api/ingest/${id}/chunks/${next.ordinal}`, { method: "POST" });
        outcome = classifyChunkResponse(r.status, r.ok, r.data as Record<string, unknown>);
      } catch {
        outcome = CHUNK_NETWORK_FAILURE;
      }
      if (outcome.kind === "fatal") { setError(outcome.message); return; }
      if (outcome.kind === "retry") await new Promise((r) => setTimeout(r, 6000));
    }
  }, []);

  async function start() {
    setBusy(true); setError(""); setNotice("");
    const { ok, status, data } = await json("/api/library/import", {
      method: "POST", body: JSON.stringify({ rawText: text }),
    });
    setBusy(false);
    if (!ok) {
      if (status === 409 && data.runId) {
        setRunId(data.runId); setError(data.message);
        const p = await load(data.runId);
        if (p === "extracting") drive(data.runId);
        return;
      }
      setError(data.message || "Could not start."); return;
    }
    setRunId(data.runId); setTotal(data.totalChunks ?? 0);
    drive(data.runId);
  }

  // ---- review -------------------------------------------------------------
  async function patch(p: Proposal, body: Record<string, unknown>) {
    const { ok, data } = await json(`/api/library/import/${runId}/proposals/${p.id}`, {
      method: "PATCH", body: JSON.stringify(body),
    });
    if (!ok) { setError(data.message || "Could not save that change."); return; }
    setProposals((list) => list.map((x) => (x.id === p.id ? { ...x, ...data.proposal } : x)));
  }

  async function saveSelected() {
    setBusy(true); setError(""); setNotice("");
    const { ok, data } = await json(`/api/library/import/${runId}/save`, { method: "POST", body: "{}" });
    setBusy(false);
    if (!ok) { setError(data.message || "Could not save."); return; }
    const needTitle = (data.results ?? []).filter((r: { outcome: string }) => r.outcome === "needs_title").length;
    setNotice(`${data.saved} saved to your Library.` + (needTitle ? ` ${needTitle} still ${needTitle === 1 ? "needs" : "need"} a title.` : ""));
    await load(runId!);
    onSaved();
  }

  async function finish(discardUnsaved = false) {
    setBusy(true); setError("");
    const { ok, status, data } = await json(`/api/library/import/${runId}/finish`, {
      method: "POST", body: JSON.stringify({ discardUnsaved }),
    });
    setBusy(false);
    if (!ok) {
      if (status === 409 && data.error === "unsaved_proposals") {
        if (confirm(`${data.message}\n\nFinish anyway and discard them?`)) return finish(true);
        return;
      }
      setError(data.message || "Could not finish."); return;
    }
    onSaved(); onClose();
  }

  async function abandon() {
    setBusy(true); setError("");
    const first = await json(`/api/library/import/${runId}/abandon`, { method: "POST", body: "{}" });
    if (first.status === 409 && first.data.error === "confirm_required") {
      if (!confirm(`${first.data.message}\n\nAbandon this import?`)) { setBusy(false); return; }
      const { ok, data } = await json(`/api/library/import/${runId}/abandon`, {
        method: "POST", body: JSON.stringify({ confirm: true }),
      });
      setBusy(false);
      if (!ok) { setError(data.message || "Could not abandon."); return; }
      onClose(); return;
    }
    setBusy(false);
    onClose();
  }

  const selected = proposals.filter((p) => p.selected).length;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl border border-border bg-white p-4">
        {phase === "idle" && (
          <>
            <p className="text-sm font-medium text-foreground">Import with AI</p>
            <p className="mt-1 mb-3 text-xs text-muted">
              Paste anything you already have — a list of communities, services, contacts. AI
              organizes it into reusable items, you review them, and only what you choose is
              saved. No Sendset is created.
            </p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste your information here…"
              className="w-full h-56 px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
            />
            {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
            <div className="mt-3 flex items-center gap-2">
              <button onClick={start} disabled={busy || text.trim().length < 10}
                className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium disabled:opacity-60">
                {busy ? "Starting…" : "Organize with AI"}
              </button>
              <button onClick={onClose} disabled={busy}
                className="ml-auto text-sm font-medium text-muted hover:text-foreground">Cancel</button>
            </div>
          </>
        )}

        {phase === "extracting" && (
          <>
            <p className="text-sm font-medium text-foreground">Organizing…</p>
            <p className="mt-1 text-xs text-muted">
              {done} of {total} parts done. This keeps going if you close the tab — reopen your
              Library and it picks up where it left off.
            </p>
            <div className="mt-3 h-1.5 w-full rounded-full bg-gray-100">
              <div className="h-1.5 rounded-full bg-accent transition-all"
                   style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
            </div>
            {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
            <div className="mt-3 flex items-center gap-2">
              <button onClick={onClose} className="text-sm font-medium text-muted hover:text-foreground">
                Close — this keeps running
              </button>
              <button onClick={abandon} disabled={busy}
                className="ml-auto text-sm font-medium text-red-700 hover:text-red-800">Abandon</button>
            </div>
          </>
        )}

        {phase === "review" && (editing ? (
          <div>
            <p className="mb-3 text-sm font-medium text-foreground">Editing a proposed item</p>
            <BlockItemEditor
              uploadImage={(f) => uploadCreatorImage("/api/library/images", f)}
              item={snapshotToItem({ ...editing, id: editing.id, revision: 1, updatedAt: "" })}
              busy={busy}
              onSave={async (payload: ItemContentPayload) => {
                await patch(editing, { item: payload });
                setEditing(null);
                return "ok" as const;
              }}
              onClose={() => setEditing(null)}
            />
          </div>
        ) : (
          <>
            <p className="text-sm font-medium text-foreground">Review what AI found</p>
            <p className="mt-1 mb-3 text-xs text-muted">
              Nothing is saved until you choose it. Edits and selections are kept — you can close
              this and come back.
            </p>
            {notice && <p className="mb-2 text-sm text-green-700">{notice}</p>}
            {error && <p className="mb-2 text-sm text-red-700">{error}</p>}

            {proposals.length === 0 ? (
              <p className="text-sm text-muted">Nothing left to review.</p>
            ) : (
              <ul className="space-y-1">
                {proposals.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 rounded-lg border border-border p-2">
                    <input type="checkbox" checked={p.selected}
                           onChange={() => patch(p, { selected: !p.selected })} />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {p.title?.trim() || <span className="text-red-700">Needs a title</span>}
                      {p.address ? <span className="text-muted"> · {p.address}</span> : null}
                    </span>
                    <button onClick={() => setEditing(p)}
                            className="flex-none text-sm font-medium text-accent hover:text-accent-hover">
                      Edit
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button onClick={saveSelected} disabled={busy || selected === 0}
                className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium disabled:opacity-60">
                {busy ? "Saving…" : selected ? `Save ${selected} to Library` : "Save to Library"}
              </button>
              <button onClick={() => finish()} disabled={busy}
                className="px-3 py-1.5 rounded-lg border border-border text-sm font-medium text-foreground hover:border-accent">
                Finish
              </button>
              <button onClick={abandon} disabled={busy}
                className="ml-auto text-sm font-medium text-red-700 hover:text-red-800">Abandon</button>
            </div>
          </>
        ))}

        {phase === "closed" && (
          <>
            <p className="text-sm font-medium text-foreground">This import is closed</p>
            <p className="mt-1 text-xs text-muted">Anything you saved is in your Library.</p>
            <button onClick={onClose} className="mt-3 px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium">
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}
