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
      <div className="flex items-center gap-2">
        {libraryItemId ? (
          <button onClick={() => setDialog(true)} disabled={busy}
            className="text-xs font-medium text-accent hover:text-accent-hover disabled:opacity-60">
            Update Library version
          </button>
        ) : (
          <button onClick={() => saveToLibrary()} disabled={busy}
            className="text-xs font-medium text-accent hover:text-accent-hover disabled:opacity-60">
            {busy ? "Saving…" : "Save to Library"}
          </button>
        )}
      </div>
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
