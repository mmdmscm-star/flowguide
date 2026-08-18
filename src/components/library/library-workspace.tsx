"use client";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { BlockItemEditor } from "@/components/editor/block-item-editor";
import { LibraryList } from "@/components/library/library-list";
import { snapshotToItem, type LibrarySnapshot } from "@/lib/library-adapter";
import type { ItemContentPayload } from "@/lib/item-content";
import type { MutationResult } from "@/lib/serial-mutation";

// The Library workspace. Find → open → edit → save.
//
// EDITING REUSES BlockItemEditor. Not a copy of it, and not a second editor for
// the same eight fields — a Library item and a packet item are the same kind of
// thing, and editing them should feel identical because it IS identical.
//
// Saving carries the revision the editor was opened with. If the entry changed
// underneath (another tab, another device) the write is refused and the current
// version is shown, rather than one edit silently erasing the other.
export default function LibraryWorkspace() {
  const router = useRouter();
  const [editing, setEditing] = useState<LibrarySnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<LibrarySnapshot | null>(null);

  const save = useCallback(async (payload: ItemContentPayload): Promise<MutationResult> => {
    if (!editing) return "failed";
    setBusy(true);
    setNotice("");
    setConflict(null);
    try {
      const res = await fetch(`/api/library/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, expectedRevision: editing.revision }),
      });
      const data = await res.json();

      if (res.status === 409 && data.error === "revision_conflict") {
        // Not an error the professional caused. Show what it is NOW and let them
        // decide again, rather than discarding either version.
        setConflict(data.current as LibrarySnapshot);
        return "rejected";
      }
      if (!res.ok) { setNotice(data.message || data.error || "Could not save."); return "failed"; }

      setEditing(null);
      setRefreshKey((k) => k + 1);
      setNotice("Saved to your Library.");
      return "ok";
    } catch {
      setNotice("Could not save. Check your connection.");
      return "failed";
    } finally {
      setBusy(false);
    }
  }, [editing]);

  async function remove(s: LibrarySnapshot) {
    // Named consequence, not a generic "are you sure": what makes this safe is
    // precisely that packets are unaffected, and saying so is what lets the
    // professional delete without hesitating.
    if (!confirm(
      `Delete "${s.title || "Untitled"}" from your Library?\n\n` +
      `Packets that already use it are NOT affected — they hold their own copies.`
    )) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/library/${s.id}`, { method: "DELETE" });
      if (!res.ok) { setNotice("Could not delete."); return; }
      setEditing(null);
      setRefreshKey((k) => k + 1);
      setNotice("Removed from your Library.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-20 bg-white border-b border-border">
        <div className="max-w-lg mx-auto px-5 py-3 flex items-center gap-3">
          <button onClick={() => router.push("/dashboard")} className="text-sm text-muted hover:text-foreground">
            ← Dashboard
          </button>
          <span className="ml-auto text-xs font-medium text-muted">Library</span>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-5 pb-24">
        <header className="pt-6 pb-4">
          <h1 className="text-2xl font-bold text-foreground">Your Library</h1>
          <p className="mt-2 text-xs text-muted">
            Items you can reuse in any packet. Inserting one makes a copy — editing that
            copy never changes what is saved here, and editing here never changes packets
            you have already sent.
          </p>
        </header>

        {notice && <p className="mb-4 text-xs text-green-700">{notice}</p>}

        {conflict && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50/70 p-3">
            <p className="text-sm font-medium text-foreground">This item changed while you had it open</p>
            <p className="mt-1 text-xs text-amber-900">
              Someone — probably you, in another tab — saved “{conflict.title}” after you opened it.
              Your edits were not applied, so nothing was lost on either side.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => { setEditing(conflict); setConflict(null); }}
                className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium"
              >
                Open the current version
              </button>
              <button
                onClick={() => setConflict(null)}
                className="px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-muted"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {editing ? (
          <div className="rounded-xl border border-border bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-foreground">Editing a Library item</p>
              <button
                onClick={() => remove(editing)}
                disabled={busy}
                className="text-xs font-medium text-red-700 hover:text-red-800 disabled:opacity-60"
              >
                Delete
              </button>
            </div>
            <BlockItemEditor
              item={snapshotToItem(editing)}
              busy={busy}
              onSave={(payload) => save(payload)}
              onClose={() => setEditing(null)}
            />
          </div>
        ) : (
          <LibraryList refreshKey={refreshKey} onOpen={(s) => { setNotice(""); setEditing(s); }} />
        )}
      </div>
    </div>
  );
}
