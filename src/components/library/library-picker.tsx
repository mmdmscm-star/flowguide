"use client";
import { useState } from "react";
import { LibraryList } from "@/components/library/library-list";

// Insert from Library. Produces ORDINARY packet items — after this, the packet
// owns its copies outright and nothing stays connected.
export function LibraryPicker({
  packetId, sectionId, onInserted, onClose,
}: {
  packetId: string;
  sectionId?: string;
  onInserted: (count: number) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function insert() {
    if (selected.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/packets/${packetId}/items/from-library`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraryItemIds: selected, ...(sectionId ? { sectionId } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || data.error || "Could not insert."); return; }
      onInserted((data.itemIds ?? []).length);
    } catch {
      setError("Could not insert. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md max-h-[80vh] overflow-y-auto rounded-xl border border-border bg-white p-4"
           onClick={(e) => e.stopPropagation()}>
        <p className="text-sm font-medium text-foreground">Add from your Library</p>
        <p className="mt-1 mb-3 text-xs text-muted">
          Each one is added as a copy. Editing it here will not change your Library version.
        </p>

        {error && <p className="mb-2 text-xs text-red-700">{error}</p>}

        <LibraryList
          selectable
          selected={selected}
          onToggle={(id) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id])}
          emptyHint="Your Library is empty. Save an item from a packet first, then you can reuse it here."
        />

        <div className="mt-4 flex items-center gap-2">
          <button onClick={insert} disabled={busy || selected.length === 0}
            className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-medium disabled:opacity-60">
            {busy ? "Adding…" : selected.length ? `Add ${selected.length}` : "Add"}
          </button>
          <button onClick={onClose} disabled={busy}
            className="ml-auto text-xs font-medium text-muted hover:text-foreground">Cancel</button>
        </div>
      </div>
    </div>
  );
}
