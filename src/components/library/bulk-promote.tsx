"use client";
import { useEffect, useState } from "react";

// Bulk promotion — "Save items to Library" for a whole packet.
//
// EXPLICITLY USER-INITIATED, and it reads the packet's CURRENT items rather than
// an import's output. If the professional corrected an address after importing,
// the Library gets the corrected one.
//
// NOTHING IS SELECTED BY DEFAULT. That is what "user-initiated" has to mean if
// it means anything: the professional opts in per item, and a packet is never
// swept into the Library because an import happened to finish.
//
// The best moment is after review settles and BEFORE the packet is tailored for
// one recipient — that is when it holds the comprehensive reusable base. The
// action stays available afterwards regardless; a published, tailored packet is
// simply not assumed to be the master.
type Candidate = { id: string; title: string; libraryItemId: string | null };

export function BulkPromote({
  packetId, onDone, onClose,
}: {
  packetId: string;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);   // deliberately empty
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/packets/${packetId}/library-candidates`);
        const data = await res.json();
        if (!live) return;
        if (!res.ok) { setError(data.message || data.error || "Could not load this Sendset."); return; }
        setItems(data.items ?? []);
      } catch {
        if (live) setError("Could not load this Sendset.");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [packetId]);

  async function save() {
    if (selected.length === 0) return;
    setBusy(true);
    setError("");
    let added = 0, skipped = 0;
    try {
      // One request per item so a single duplicate does not fail the batch —
      // reporting "3 added, 1 already there" is more useful than an error.
      for (const itemId of selected) {
        const res = await fetch(`/api/library`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemId }),
        });
        if (res.ok) added++;
        else if (res.status === 409) skipped++;
      }
      onDone(
        skipped
          ? `${added} added to your Library. ${skipped} already there.`
          : `${added} added to your Library.`
      );
    } finally {
      setBusy(false);
    }
  }

  const available = items.filter((i) => !i.libraryItemId);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md max-h-[80vh] overflow-y-auto rounded-xl border border-border bg-white p-4"
           onClick={(e) => e.stopPropagation()}>
        <p className="text-base font-semibold text-foreground">Save to Library</p>
        <p className="mt-1 mb-3 text-xs text-muted">
          Choose what you would use again. Each one is saved as a copy, so this Sendset
          is not changed.
        </p>

        {error && <p className="mb-2 text-sm text-red-700">{error}</p>}
        {loading && <p className="text-xs text-muted">Loading…</p>}

        {!loading && available.length === 0 && (
          <p className="text-sm text-muted">
            {items.length === 0 ? "There is nothing here yet." : "Everything here is already in your Library."}
          </p>
        )}

        {available.length > 0 && (
          <>
            <button
              onClick={() => setSelected(selected.length === available.length ? [] : available.map((i) => i.id))}
              className="mb-2 text-sm font-medium text-accent hover:text-accent-hover"
            >
              {selected.length === available.length ? "Clear all" : "Select all"}
            </button>
            <ul className="space-y-1">
              {available.map((i) => (
                <li key={i.id}>
                  <label className="flex items-center gap-2 rounded-lg border border-border bg-white p-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selected.includes(i.id)}
                      onChange={() => setSelected((s) => s.includes(i.id) ? s.filter((x) => x !== i.id) : [...s, i.id])}
                    />
                    <span className="text-sm text-foreground truncate">{i.title || "Untitled"}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="mt-4 flex items-center gap-2">
          <button onClick={save} disabled={busy || selected.length === 0}
            className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium disabled:opacity-60">
            {busy ? "Saving…" : selected.length ? `Save ${selected.length} to Library` : "Save to Library"}
          </button>
          <button onClick={onClose} disabled={busy}
            className="ml-auto text-sm font-medium text-muted hover:text-foreground">Cancel</button>
        </div>
      </div>
    </div>
  );
}
