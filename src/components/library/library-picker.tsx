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
//
// AUTO-UNPUBLISH ON ADD. The server's from-library endpoint refuses a non-draft
// packet (the item INSERTs are gated by status in route.ts, and photo-ownership
// resolution runs during Preview, which is a draft-only screen). The picker
// used to surface that refusal as a small red line and leave the professional
// to figure out the workflow — unpublish, re-open the picker, re-select the
// same N rows, click Add again, then hunt for Republish. Now: if the packet is
// published and the professional clicks Add, the picker calls `onUnpublish`
// first and continues. The Sendset lands in draft, the items are added in one
// turn, and the parent surfaces a notice that names Republish as the next step.
// The already-published share link stays stable through the whole thing — it
// is live while they're picking, takes about a second of unpublished state
// while the auto-unpublish runs, and is live again as soon as they Republish.
export function LibraryPicker({
  packetId, sectionId, onInserted, onClose, isPublished = false, onUnpublish,
}: {
  packetId: string;
  sectionId?: string;
  /** Called with the number of items added. The parent is responsible for
   *  the "we auto-unpublished" notice, which is centralised there so every
   *  add path (blank item, blank section, picture, AI append, Library picker)
   *  surfaces the same one message in the same one place. */
  onInserted: (count: number) => void;
  onClose: () => void;
  /** True when the parent's packet is in `published` state. When true,
   *  `onUnpublish` must be supplied — the picker will call it before the
   *  add. If false or missing, the picker behaves as it always has. */
  isPublished?: boolean;
  /** The parent's existing unpublish action. Returns true on success,
   *  false when the server refused — in which case the add is NOT
   *  attempted and the picker keeps its selection so the professional
   *  can try again or close. */
  onUnpublish?: () => Promise<boolean>;
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
      // AUTO-UNPUBLISH FIRST on a published Sendset. The server refuses the
      // add-from-library on anything but draft, and the previous UX was to
      // show that refusal as a red line and leave the professional to do the
      // unpublish/add/republish dance by hand. Now the picker runs the
      // unpublish itself so the add can proceed in the same click. The
      // parent's `ensureDraftBeforeAdd` sets a persistent amber notice at
      // the top of the editor that names Republish — one message, one place,
      // one framework that is shared by every other add path (blank item,
      // blank section, picture upload, AI append).
      if (isPublished && onUnpublish) {
        const ok = await onUnpublish();
        if (!ok) {
          // The parent's unpublish already surfaced its own error (scrolled
          // to it, even). Don't close the picker — keep the selection so the
          // professional can try again once they've seen what refused.
          setError("Couldn't unpublish — see the message above the editor.");
          return;
        }
      }
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

        {/* PUBLISHED-SENDSET NOTICE. Surfaced BEFORE the professional picks
            anything, so they know the shape of what Add will do in one
            click — rather than finding out after they've selected rows and
            hit the button. The notice names Republish explicitly because
            that is the one next step the Sendset needs after this flow:
            the share link stays stable, the content is just briefly behind
            the editor until they Republish. */}
        {isPublished && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            This Sendset is published. Adding will put it back into Draft so the new cards can land —
            when you're done, use <strong>Republish</strong> in the editor header to update your client's link.
            The share link itself stays the same.
          </div>
        )}

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
            {busy
              ? (isPublished ? "Unpublishing, then adding…" : "Adding…")
              : selected.length
                ? (isPublished ? `Unpublish and add ${selected.length}` : `Add ${selected.length}`)
                : "Add"}
          </button>
          <button onClick={onClose} disabled={busy}
            className="ml-auto text-sm font-medium text-muted hover:text-foreground">Cancel</button>
        </div>
      </div>
    </div>
  );
}
