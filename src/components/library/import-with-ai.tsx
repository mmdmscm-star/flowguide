"use client";
import { Button } from "@/components/ui/button";
import { INPUT_SHELL } from "@/components/ui/field";
import { MODAL_SCRIM, MODAL_PANEL, MODAL_TITLE, MODAL_LEDE, MODAL_FOOT }
  from "@/components/ui/modal";
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
    <div className={MODAL_SCRIM}>
      <div className={`${MODAL_PANEL} max-w-xl p-5`}>
        {phase === "idle" && (
          <>
            <p className={MODAL_TITLE}>Import with AI</p>
            <p className={`${MODAL_LEDE} mb-4`}>
              Paste anything you already have — a list of communities, services, contacts. AI
              organizes it into reusable items, you review them, and only what you choose is
              saved. No Sendset is created.
            </p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste your information here…"
              className={`${INPUT_SHELL} h-56 resize-none`}
            />
            {error && <p className="mt-2 text-meta text-red-700">{error}</p>}
            <div className={MODAL_FOOT}>
              <Button variant="primary" size="md" onClick={start}
                disabled={busy || text.trim().length < 10}>
                {busy ? "Starting…" : "Organize with AI"}
              </Button>
              <Button variant="ghost" size="md" className="ml-auto"
                onClick={onClose} disabled={busy}>Cancel</Button>
            </div>
          </>
        )}

        {phase === "extracting" && (
          <>
            <p className={MODAL_TITLE}>Organizing…</p>
            <p className={MODAL_LEDE}>
              {done} of {total} parts done. This keeps going if you close the tab — reopen your
              Library and it picks up where it left off.
            </p>
            <div className="mt-4 h-1.5 w-full rounded-full bg-ground-3">
              <div className="h-1.5 rounded-full bg-ink transition-all"
                   style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
            </div>
            {error && <p className="mt-2 text-meta text-red-700">{error}</p>}
            <div className={MODAL_FOOT}>
              <Button variant="secondary" size="md" onClick={onClose}>
                Close — this keeps running
              </Button>
              <Button variant="danger" size="md" className="ml-auto"
                onClick={abandon} disabled={busy}>Abandon</Button>
            </div>
          </>
        )}

        {phase === "review" && (editing ? (
          <div>
            <p className={`${MODAL_TITLE} mb-4`}>Editing a proposed item</p>
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
            <p className={MODAL_TITLE}>Review what AI found</p>
            <p className={`${MODAL_LEDE} mb-4`}>
              Nothing is saved until you choose it. Edits and selections are kept — you can close
              this and come back.
            </p>
            {notice && <p className="mb-2 text-meta text-emerald-700">{notice}</p>}
            {error && <p className="mb-2 text-meta text-red-700">{error}</p>}

            {proposals.length === 0 ? (
              <p className="py-6 text-center text-body text-ink-2">Nothing left to review.</p>
            ) : (
              <ul className="divide-y divide-line rounded-[var(--radius-control)] border border-line">
                {proposals.map((p) => (
                  <li key={p.id} className="flex items-center gap-2.5 px-3 py-2.5">
                    <input type="checkbox" checked={p.selected}
                           onChange={() => patch(p, { selected: !p.selected })} />
                    <span className="min-w-0 flex-1 truncate text-body text-ink">
                      {p.title?.trim() || <span className="text-red-700">Needs a title</span>}
                      {p.address ? <span className="text-ink-2"> · {p.address}</span> : null}
                    </span>
                    <button onClick={() => setEditing(p)}
                            className="flex-none text-meta font-medium text-mark hover:text-mark/80">
                      Edit
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className={MODAL_FOOT}>
              <Button variant="primary" size="md" onClick={saveSelected}
                disabled={busy || selected === 0}>
                {busy ? "Saving…" : selected ? `Save ${selected} to Library` : "Save to Library"}
              </Button>
              <Button variant="secondary" size="md" onClick={() => finish()} disabled={busy}>
                Finish
              </Button>
              <Button variant="danger" size="md" className="ml-auto"
                onClick={abandon} disabled={busy}>Abandon</Button>
            </div>
          </>
        ))}

        {phase === "closed" && (
          <>
            <p className={MODAL_TITLE}>This import is closed</p>
            <p className={MODAL_LEDE}>Anything you saved is in your Library.</p>
            <div className={MODAL_FOOT}>
              <Button variant="primary" size="md" onClick={onClose}>Done</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
