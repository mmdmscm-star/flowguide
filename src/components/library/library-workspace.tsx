"use client";
import { useCallback, useState } from "react";
import { BlockItemEditor, type LibraryOrganization } from "@/components/editor/block-item-editor";
import { LibraryList } from "@/components/library/library-list";
import { LibraryDetail } from "@/components/library/library-detail";
import { LibraryFilters, EMPTY_FILTERS, type LibraryFilterState } from "@/components/library/library-filters";
import type { LibraryVocabulary } from "@/lib/library-organization";
import { CreatorNav } from "@/components/nav/creator-nav";
import { ImportWithAI } from "@/components/library/import-with-ai";
import { createFromLibrary } from "@/lib/create-from-library";
import { useRouter } from "next/navigation";
import { snapshotToItem, type LibrarySnapshot } from "@/lib/library-adapter";
import type { Item } from "@/lib/types";
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
// A Library entry written here rather than promoted from a packet. Same eight
// fields, same editor, same row — populating the Library has never required a
// FlowGuide to exist, and the empty state should not imply that it does.
const BLANK: Item = {
  id: "new", title: "", address: "", description: "", notes: "",
  photos: [], details: [], links: [], contacts: [],
};

export default function LibraryWorkspace() {
  const [editing, setEditing] = useState<LibrarySnapshot | null>(null);
  // Reading is the default; editing is a deliberate second step from here.
  const [viewing, setViewing] = useState<LibrarySnapshot | null>(null);
  const [usedIn, setUsedIn] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<LibrarySnapshot | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  // Choosing saved material to start a FlowGuide with. Offered INLINE here
  // rather than in a dialog: the list is already on screen, and putting a second
  // copy of it in a modal would be a worse version of what is already there.
  // Whether anything is saved at all. Distinct from "the current search found
  // nothing": an action that needs saved material must not vanish because a
  // search came back empty.
  const [hasAny, setHasAny] = useState<boolean | null>(null);
  // ORGANIZATION FILTERS. Views of one Library, not separate collections: they
  // compose with the search box and with each other, and the chips are drawn
  // from the professional's own vocabulary rather than anything FlowGuide names.
  const [filters, setFilters] = useState<LibraryFilterState>(EMPTY_FILTERS);
  const [vocab, setVocab] = useState<LibraryVocabulary>({ categories: [], labels: [], hasFavorites: false });
  const [organizing, setOrganizing] = useState(false);
  const [orgCategory, setOrgCategory] = useState("");
  const [orgLabel, setOrgLabel] = useState("");

  /** One organizing write for the whole selection. Refreshes the list so the
   *  chips and stars reflect what just happened. */
  async function organize(patch: Record<string, unknown>) {
    if (!chosen.length) return;
    setBusy(true); setNotice("");
    try {
      const res = await fetch("/api/library/bulk", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: chosen, ...patch }),
      });
      const data = await res.json();
      if (!res.ok) { setNotice(data.message || "Could not organize those items."); return; }
      if (data.vocabulary) setVocab(data.vocabulary);
      setRefreshKey((k) => k + 1);
      setNotice(`Organized ${data.updated} item${data.updated === 1 ? "" : "s"}.`);
    } catch {
      setNotice("Could not organize those items.");
    } finally { setBusy(false); }
  }

  async function toggleFavorite(id: string, next: boolean) {
    // Starring the FIRST item has to reveal the Favorites filter straight away.
    // The vocabulary otherwise only arrives with a first page, so the affordance
    // would appear on some later reload — long after the moment it was earned.
    // Unstarring is not mirrored: whether that was the last one is a question
    // about the whole Library, and the next load answers it honestly.
    if (next) setVocab((v) => (v.hasFavorites ? v : { ...v, hasFavorites: true }));
    await fetch(`/api/library/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization: { isFavorite: next } }),
    }).catch(() => {});
  }

  const [selecting, setSelecting] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const router = useRouter();

  const save = useCallback(async (
    payload: ItemContentPayload, _updated?: unknown, organization?: LibraryOrganization,
  ): Promise<MutationResult> => {
    void _updated;
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

      // TWO WRITES, DELIBERATELY. The content save above bumps `revision`,
      // which is the save-back comparator; organization must not, so it goes
      // through its own path rather than riding along in the payload. It runs
      // after the content save so a rejected revision leaves both untouched.
      if (organization && editing) {
        await fetch(`/api/library/${editing.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organization }),
        }).catch(() => {});
      }

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

  const create = useCallback(async (payload: ItemContentPayload): Promise<MutationResult> => {
    // The retry lives in an INNER function so the duplicate path can call itself
    // without the callback depending on its own identity.
    async function attempt(force: boolean): Promise<MutationResult> {
      try {
        const res = await fetch("/api/library", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ item: payload, ...(force ? { force: true } : {}) }),
        });
        const data = await res.json();

        // Same rule as saving from a packet: warn, never merge. Two genuinely
        // different things can share a name.
        if (res.status === 409 && data.error === "duplicate_candidate") {
          if (confirm(`${data.message}\n\nSave this as a separate Library item anyway?`)) {
            return await attempt(true);
          }
          return "rejected";
        }
        if (!res.ok) { setNotice(data.message || data.error || "Could not save."); return "failed"; }

        setCreating(false);
        setRefreshKey((k) => k + 1);
        setNotice("Saved to your Library.");
        return "ok";
      } catch {
        setNotice("Could not save. Check your connection.");
        return "failed";
      }
    }

    setBusy(true);
    setNotice("");
    try {
      return await attempt(false);
    } finally {
      setBusy(false);
    }
  }, []);

  async function remove(s: LibrarySnapshot) {
    // Named consequence, not a generic "are you sure": what makes this safe is
    // precisely that packets are unaffected, and saying so is what lets the
    // professional delete without hesitating.
    if (!confirm(
      `Delete "${s.title || "Untitled"}" from your Library?\n\n` +
      `Any FlowGuide that already uses it is NOT affected — each holds its own copy.`
    )) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/library/${s.id}`, { method: "DELETE" });
      if (!res.ok) { setNotice("Could not delete."); return; }
      setEditing(null);
      setViewing(null);
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
          <CreatorNav current="library" />
        </div>
      </div>

      <div className="max-w-lg mx-auto px-5 pb-24">
        <header className="pt-6 pb-4">
          <h1 className="text-2xl font-bold text-foreground">Your Library</h1>
          {/* ONE SENTENCE. The independence rule — that inserting makes a copy —
              is explained where it is actually needed: at the moment of
              insertion, and again in the update and delete confirmations.
              Repeating it here made the Library open with a paragraph about
              semantics before saying what it is for. */}
          <p className="mt-2 text-sm text-muted">
            Save things you use often and add them to any FlowGuide.
          </p>
        </header>

        {/* Also here, not only in the empty state: writing an entry directly is a
            permanent way to use the Library, not a first-run bootstrap. */}
        {!editing && !creating && !viewing && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button
              onClick={() => { setNotice(""); setImporting(true); }}
              className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium"
            >
              Import with AI
            </button>
            <button
              onClick={() => { setNotice(""); setCreating(true); }}
              className="px-3 py-2 rounded-lg border border-border bg-white text-sm font-medium
                         text-foreground hover:border-accent hover:text-accent"
            >
              Add manually
            </button>
            {/* OFFERED ONLY WHEN THERE IS SOMETHING TO CHOOSE. On an empty
                Library this opened selection mode over an empty list — an
                action that looks live and leads nowhere. Hidden rather than
                disabled: a disabled control on a first-run screen is one more
                thing to wonder about, and Import with AI and Add manually are
                the useful actions in that state. Unknown (null) keeps it
                hidden, so a failed load never offers a dead end either. */}
            {hasAny === true && (
              <>
                <button
                  onClick={() => { setNotice(""); setChosen([]); setOrganizing(false); setSelecting(true); }}
                  className="px-3 py-2 rounded-lg border border-border bg-white text-sm font-medium
                             text-foreground hover:border-accent hover:text-accent"
                >
                  Create a FlowGuide
                </button>
                {/* THE OTHER DOOR, SAID OUT LOUD.
                    Selection has been neutral since Phase 2 — pick items, then
                    decide — but the only way IN was a button that named one of
                    the two destinations. So a professional looking for how to
                    organize their Library found Favorites, which is on every
                    row, and concluded that was the whole release. Everything
                    else was behind "Create a FlowGuide", which is the last
                    place anyone would look for it.
                    The mode is the same one; only the intent it opens with
                    differs, so nothing here is a second organizing system. */}
                <button
                  onClick={() => { setNotice(""); setChosen([]); setOrganizing(true); setSelecting(true); }}
                  className="px-3 py-2 rounded-lg border border-border bg-white text-sm font-medium
                             text-foreground hover:border-accent hover:text-accent"
                >
                  Organize
                </button>
              </>
            )}
          </div>
        )}

        {/* SELECTION IS NEUTRAL. Choosing items commits to nothing; what to do
            with them is the next decision, not the first. A separate
            "organizing mode" beside the existing "creating mode" would make the
            professional pick the right door before knowing which room they
            wanted, and get it wrong half the time. */}
        {selecting && (
          <div className="mb-4 rounded-xl border border-accent/40 bg-accent/5 p-3">
            <p className="text-sm font-medium text-foreground">
              {chosen.length
                ? `${chosen.length} selected`
                : organizing
                  ? "Select the items you want to organize"
                  : "Choose the items you want to work with"}
            </p>
            <p className="mt-1 text-sm text-muted">
              Start a FlowGuide with them, or file them for later. A copy in a
              FlowGuide never changes what is saved here.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={async () => {
                  setBusy(true); setNotice("");
                  const { packetId, message } = await createFromLibrary(chosen);
                  if (!packetId) { setNotice(message ?? "Could not create it."); setBusy(false); return; }
                  router.push(`/edit/${packetId}`);
                }}
                disabled={busy || chosen.length === 0}
                className="px-3 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium disabled:opacity-60"
              >
                {busy ? "Creating…" : chosen.length
                  ? `Create FlowGuide with ${chosen.length}`
                  : "Create FlowGuide"}
              </button>
              <button
                onClick={() => setOrganizing((o) => !o)}
                disabled={busy || chosen.length === 0}
                aria-expanded={organizing}
                className="px-3 py-2 rounded-lg border border-border bg-white text-sm font-medium
                           text-foreground hover:border-accent hover:text-accent disabled:opacity-60"
              >
                Organize
              </button>
              <button
                onClick={() => { setSelecting(false); setChosen([]); setOrganizing(false); }}
                disabled={busy}
                className="ml-auto text-sm font-medium text-muted hover:text-foreground"
              >
                Cancel
              </button>
            </div>

            {/* The actions appear with the MODE rather than with the first
                selection. Showing them only after something is ticked meant
                clicking Organize appeared to do nothing but add checkboxes —
                the controls it was named for were still hidden. They are
                visible and disabled instead, which says what this mode is for
                before anything is chosen. */}
            {organizing && (
              <div className="mt-3 space-y-2 border-t border-accent/30 pt-3">
                {chosen.length === 0 && (
                  <p className="text-xs text-muted">
                    Tick the items below, then set a category, add a label, or star them.
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    list="library-categories"
                    value={orgCategory}
                    onChange={(e) => setOrgCategory(e.target.value)}
                    placeholder="Category"
                    className="min-w-0 flex-1 px-2.5 py-1.5 rounded border border-border text-sm
                               focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
                  />
                  <SmallAction disabled={busy || !chosen.length || !orgCategory.trim()}
                    onClick={() => organize({ setCategory: orgCategory })}>Set</SmallAction>
                  <SmallAction disabled={busy || !chosen.length}
                    onClick={() => organize({ clearCategory: true })}>Clear</SmallAction>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    list="library-labels"
                    value={orgLabel}
                    onChange={(e) => setOrgLabel(e.target.value)}
                    placeholder="Label"
                    className="min-w-0 flex-1 px-2.5 py-1.5 rounded border border-border text-sm
                               focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
                  />
                  <SmallAction disabled={busy || !chosen.length || !orgLabel.trim()}
                    onClick={() => organize({ addLabels: [orgLabel] })}>Add</SmallAction>
                  <SmallAction disabled={busy || !chosen.length || !orgLabel.trim()}
                    onClick={() => organize({ removeLabels: [orgLabel] })}>Remove</SmallAction>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <SmallAction disabled={busy || !chosen.length} onClick={() => organize({ favorite: true })}>★ Favorite</SmallAction>
                  <SmallAction disabled={busy || !chosen.length} onClick={() => organize({ favorite: false })}>☆ Unfavorite</SmallAction>
                </div>
              </div>
            )}
          </div>
        )}

        {importing && (
          <ImportWithAI
            onClose={() => setImporting(false)}
            onSaved={() => setRefreshKey((k) => k + 1)}
          />
        )}

        {notice && <p className="mb-4 text-sm text-green-700">{notice}</p>}

        {conflict && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50/70 p-3">
            <p className="text-sm font-medium text-foreground">This item changed while you had it open</p>
            <p className="mt-1 text-sm text-amber-900">
              Someone — probably you, in another tab — saved “{conflict.title}” after you opened it.
              Your edits were not applied, so nothing was lost on either side.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => { setEditing(conflict); setConflict(null); }}
                className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium"
              >
                Open the current version
              </button>
              <button
                onClick={() => setConflict(null)}
                className="px-3 py-1.5 rounded-lg border border-border text-sm font-medium text-muted"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {viewing ? (
          <LibraryDetail
            item={viewing}
            usedIn={usedIn}
            busy={busy}
            onEdit={() => { setEditing(viewing); setViewing(null); }}
            onDelete={() => remove(viewing)}
            onClose={() => setViewing(null)}
          />
        ) : creating ? (
          <div className="rounded-xl border border-border bg-white p-4">
            <p className="mb-3 text-base font-semibold text-foreground">Add to Library</p>
            <BlockItemEditor
              item={BLANK}
              busy={busy}
              onSave={(payload) => create(payload)}
              onClose={() => setCreating(false)}
            />
          </div>
        ) : editing ? (
          <div className="rounded-xl border border-border bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-base font-semibold text-foreground">Editing</p>
              <button
                onClick={() => remove(editing)}
                disabled={busy}
                className="text-sm font-medium text-red-700 hover:text-red-800 disabled:opacity-60"
              >
                Delete
              </button>
            </div>
            <BlockItemEditor
              item={snapshotToItem(editing)}
              busy={busy}
              onSave={(payload, updated, organization) => save(payload, updated, organization)}
              organization={{
                category: editing.category ?? "",
                labels: editing.labels ?? [],
                isFavorite: editing.isFavorite ?? false,
              }}
              vocabulary={vocab}
              onClose={() => setEditing(null)}
            />
          </div>
        ) : (
          <>
          <LibraryFilters vocabulary={vocab} value={filters} onChange={setFilters} className="mb-3" />
          {/* Suggestions for the bulk inputs, from the professional's own words. */}
          <datalist id="library-categories">
            {vocab.categories.map((c) => <option key={c} value={c} />)}
          </datalist>
          <datalist id="library-labels">
            {vocab.labels.map((l) => <option key={l} value={l} />)}
          </datalist>
          <LibraryList
            refreshKey={refreshKey}
            category={filters.category}
            labels={filters.labels}
            favorite={filters.favorite}
            onVocabulary={setVocab}
            onToggleFavorite={selecting ? undefined : toggleFavorite}
            onLoaded={({ count, filtered }) => { if (!filtered) setHasAny(count > 0); }}
            selectable={selecting}
            selected={chosen}
            onToggle={(id) => setChosen((c) => c.includes(id) ? c.filter((x) => x !== id) : [...c, id])}
            onOpen={selecting ? undefined : (s) => {
              setNotice("");
              setViewing(s);
              // How many FlowGuides hold a copy — context for deleting. Fetched
              // here rather than shipped with every row in the list.
              setUsedIn(null);
              fetch(`/api/library/${s.id}`)
                .then((r) => r.json())
                .then((d) => setUsedIn(typeof d.usedIn === "number" ? d.usedIn : null))
                .catch(() => setUsedIn(null));
            }}
            emptyHint={
              // SAY IT ONCE. The previous version explained the same idea three
              // times — the page description, a paragraph on what a Library
              // holds, and a list of ways to fill it. A professional opening an
              // empty Library needs to know what goes in it and how to start,
              // not a short manual.
              <div className="rounded-xl border border-border bg-white p-4">
                <p className="text-base font-semibold text-foreground">Nothing saved yet</p>
                <p className="mt-1 text-sm text-muted">
                  Import information you already have, add something manually, or save
                  things while building a FlowGuide.
                </p>
              </div>
            }
          />
          </>
        )}
      </div>
    </div>
  );
}

/** A compact control for one bulk action. */
function SmallAction({
  disabled, onClick, children,
}: { disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-xs font-medium
                 text-foreground hover:border-accent hover:text-accent disabled:opacity-50"
    >
      {children}
    </button>
  );
}
