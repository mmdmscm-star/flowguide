"use client";
import { useState } from "react";
import { SaveBackDialog } from "@/components/library/save-back-dialog";

// The per-item Library actions inside a packet editor.
//
// Which action is offered is decided by LINEAGE, not by a menu that always shows
// everything:
//   no ancestor      -> "Save to Library"        (this becomes reusable)
//   live ancestor    -> "Update Library version" (the compounding step)
//
// An item whose ancestor was DELETED has null lineage, so it correctly falls
// back to "Save to Library" — a deleted entry is never silently resurrected.
//
// THE TWO BRANCHES ARE STYLED DIFFERENTLY ON PURPOSE, and the first version of
// this component got that wrong. Ancestry ("From your Library") is context: it
// describes what an item already is, so it stays muted and out of the way.
// Saving is an ACTION, and for a professional whose Library is still empty it is
// the only way to put anything in it — rendering it as the same muted underline
// made the one affordance that matters read like a caption.
export function ItemLibraryActions({
  packetItemId, itemTitle, libraryItemId, onChanged,
}: {
  packetItemId: string;
  itemTitle: string;
  libraryItemId: string | null;
  onChanged: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState("");

  async function saveToLibrary(force = false) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/library`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: packetItemId, ...(force ? { force: true } : {}) }),
      });
      const data = await res.json();

      if (res.status === 409 && data.error === "duplicate_candidate") {
        // Warn, never merge. Two genuinely different things can share a name.
        const again = confirm(
          `${data.message}\n\nSave this as a separate Library item anyway?`
        );
        if (again) await saveToLibrary(true);
        return;
      }
      if (!res.ok) { setError(data.message || data.error || "Could not save."); return; }
      onChanged("Saved to your Library.");
    } catch {
      setError("Could not save. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {libraryItemId ? (
        // CONTEXT. Quiet: an item inserted from the Library is an ordinary item
        // once it is here, and its ancestry should not compete with its content.
        <div className="flex items-center gap-2 text-xs text-muted">
          <span>From your Library</span>
          <span aria-hidden>·</span>
          <button onClick={() => setDialog(true)} disabled={busy}
            className="underline underline-offset-2 hover:text-foreground disabled:opacity-60">
            Update saved version
          </button>
        </div>
      ) : (
        // ACTION. Reads as a button, because it is one.
        <button onClick={() => saveToLibrary()} disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-2.5 py-1
                     text-xs font-medium text-foreground hover:border-accent hover:text-accent
                     disabled:opacity-60">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M6 4h12a1 1 0 011 1v15l-7-4-7 4V5a1 1 0 011-1z" />
          </svg>
          {busy ? "Saving…" : "Save to Library"}
        </button>
      )}
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}

      {dialog && libraryItemId && (
        <SaveBackDialog
          packetItemId={packetItemId}
          libraryItemId={libraryItemId}
          itemTitle={itemTitle}
          onCancel={() => setDialog(false)}
          onDone={(m) => { setDialog(false); onChanged(m); }}
        />
      )}
    </>
  );
}
