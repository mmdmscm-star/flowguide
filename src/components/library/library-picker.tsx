"use client";
import { useState } from "react";
import { LibraryList } from "@/components/library/library-list";
import { LibraryFilters, EMPTY_FILTERS, type LibraryFilterState } from "@/components/library/library-filters";
import { LibraryStructureView } from "@/components/library/library-structure-view";
import { LibrarySearch } from "@/components/library/library-search";
import { showStructure, type GroupRow, type SectionRow } from "@/lib/library-structure";
import type { LibraryVocabulary } from "@/lib/library-organization";

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
  // The SAME filters as the Library. Narrowing while assembling is where
  // filtering earns the most, and it should be the thing already learned
  // rather than a second system that resembles it.
  const [filters, setFilters] = useState<LibraryFilterState>(EMPTY_FILTERS);
  const [vocab, setVocab] = useState<LibraryVocabulary>({ labels: [], hasFavorites: false });
  // ORGANIZATION HELPS HERE TOO. Assembling a FlowGuide is where finding things
  // matters most, so the picker browses the same Section -> Group structure the
  // Library does. It offers no way to CHANGE any of it: choosing is not filing,
  // and a reorder control in a picker would edit the shelf while you shop.
  const [structure, setStructure] = useState<{ sections: SectionRow[]; groups: GroupRow[] }>(
    { sections: [], groups: [] });
  const [q, setQ] = useState("");
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
          Each one is added as a copy. Editing it here will not change your saved version.
        </p>

        {error && <p className="mb-2 text-sm text-red-700">{error}</p>}

        <LibrarySearch value={q} onChange={setQ} className="mb-3" />
        <LibraryFilters vocabulary={vocab} value={filters} onChange={setFilters} className="mb-3" />
        {showStructure(structure.sections.length > 0, { q, labels: filters.labels, favorite: filters.favorite }) ? (
          <LibraryStructureView
            selectable
            selected={selected}
            onToggle={(id) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id])}
            onVocabulary={setVocab}
            onEmpty={(empty) => { if (empty) setStructure({ sections: [], groups: [] }); }}
          />
        ) : (
        <LibraryList
          query={q}
          onStructure={setStructure}
          labels={filters.labels}
          favorite={filters.favorite}
          onVocabulary={setVocab}
          selectable
          selected={selected}
          onToggle={(id) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id])}
          emptyHint="Your Library is empty. Save something from a Sendset first, then you can reuse it here."
        />
        )}

        <div className="mt-4 flex items-center gap-2">
          <button onClick={insert} disabled={busy || selected.length === 0}
            className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium disabled:opacity-60">
            {busy ? "Adding…" : selected.length ? `Add ${selected.length}` : "Add"}
          </button>
          <button onClick={onClose} disabled={busy}
            className="ml-auto text-sm font-medium text-muted hover:text-foreground">Cancel</button>
        </div>
      </div>
    </div>
  );
}
