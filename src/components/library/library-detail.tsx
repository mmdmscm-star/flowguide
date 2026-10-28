"use client";
import { useState } from "react";
import { photoUrls, type LibrarySnapshot } from "@/lib/library-adapter";

// Per-Sendset usage of this library item. Shape matches the API response —
// one entry per Sendset item that was created from this library entry,
// with enough state to tell "in sync" from "out of date" and to open or
// update each independently.
interface Usage {
  itemId: string;
  itemTitle: string;
  packetId: string;
  packetTitle: string;
  packetStatus: string;
  itemRevision: number;
  outOfDate: boolean;
}

// Looking at something saved, without being put in an editor.
//
// CONTENT, NOT DISABLED CONTROLS. The obvious shortcut would be to render the
// existing editor with everything greyed out, and it would be wrong: a form full
// of disabled inputs reads as broken rather than as read-only, and it shows a
// field for everything an entry COULD have instead of what it actually has.
// Empty sections are omitted entirely here.
//
// Editing is a deliberate second step, so opening a saved thing to check what is
// in it can never be the first move in accidentally changing it.

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <p className="text-xs font-medium uppercase tracking-widest text-muted">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export function LibraryDetail({
  item, usedIn, busy, onEdit, onDelete, onClose,
}: {
  item: LibrarySnapshot;
  /** How many FlowGuides hold a copy. Context for deleting, not a live link. */
  usedIn?: number | null;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  // USAGES. Not fetched on mount — a professional opening a library item
  // mostly wants to see what the item IS. The "In N Sendsets" line opens
  // into the per-Sendset list on demand, and only then do we read the API.
  const [usagesOpen, setUsagesOpen] = useState(false);
  const [usages, setUsages] = useState<Usage[] | null>(null);
  const [usagesError, setUsagesError] = useState("");
  const [loadingUsages, setLoadingUsages] = useState(false);
  const [applyingItemId, setApplyingItemId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState("");

  async function loadUsages() {
    setLoadingUsages(true); setUsagesError("");
    try {
      const res = await fetch(`/api/library/${item.id}/usages`);
      const d = await res.json();
      if (!res.ok) { setUsagesError(d.message || "Could not read usages."); return; }
      setUsages(d.usages ?? []);
    } catch { setUsagesError("Could not read usages."); }
    finally { setLoadingUsages(false); }
  }

  function toggleUsages() {
    const next = !usagesOpen;
    setUsagesOpen(next);
    if (next && usages === null) void loadUsages();
  }

  async function applyToSendset(usage: Usage) {
    setApplyingItemId(usage.itemId); setApplyError("");
    try {
      const res = await fetch(`/api/library/${item.id}/apply-to-item`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: usage.itemId }),
      });
      const d = await res.json();
      if (!res.ok) { setApplyError(d.message || "Could not update that Sendset."); return; }
      // Mark locally in sync so the row updates without a full refetch.
      setUsages((cur) => cur ? cur.map((u) =>
        u.itemId === usage.itemId ? { ...u, outOfDate: false, itemRevision: d.revision ?? u.itemRevision } : u
      ) : cur);
    } catch { setApplyError("Could not update that Sendset."); }
    finally { setApplyingItemId(null); }
  }
  const photos = photoUrls(item);
  const details = (item.details ?? []).filter((d) => d.label?.trim() || d.value?.trim());
  const links = (item.links ?? []).filter((l) => l.url?.trim());
  const contacts = (item.contacts ?? []).filter(
    (c) => c.name?.trim() || c.role?.trim() || c.phone?.trim() || c.email?.trim() || c.website?.trim());

  return (
    <div className="rounded-xl border border-border bg-white p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-foreground break-words">
            {item.title?.trim() || "Untitled"}
          </h2>
          {item.address?.trim() && (
            <p className="mt-1 flex items-start gap-1.5 text-sm text-muted">
              <span aria-hidden className="mt-0.5">📍</span>
              <span className="break-words">{item.address}</span>
            </p>
          )}
        </div>
        <button onClick={onClose} disabled={busy}
          className="flex-none text-sm font-medium text-muted hover:text-foreground disabled:opacity-60">
          Close
        </button>
      </div>

      {item.description?.trim() && (
        <p className="mt-3 text-sm text-foreground whitespace-pre-wrap break-words">{item.description}</p>
      )}

      {details.length > 0 && (
        <Row label="Details">
          <dl className="divide-y divide-border rounded-lg border border-border">
            {details.map((d, i) => (
              <div key={i} className="flex gap-3 px-3 py-2">
                <dt className="w-2/5 flex-none text-sm text-muted break-words">{d.label}</dt>
                <dd className="text-sm text-foreground break-words">{d.value}</dd>
              </div>
            ))}
          </dl>
        </Row>
      )}

      {links.length > 0 && (
        <Row label="Links">
          <ul className="space-y-1">
            {links.map((l, i) => (
              <li key={i}>
                <a href={l.url} target="_blank" rel="noopener noreferrer"
                   className="text-sm text-accent hover:text-accent-hover underline underline-offset-2 break-all">
                  {l.label?.trim() || l.url}
                </a>
              </li>
            ))}
          </ul>
        </Row>
      )}

      {photos.length > 0 && (
        <Row label={photos.length === 1 ? "Photo" : "Photos"}>
          <div className="flex flex-wrap gap-2">
            {photos.map((u, i) => (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img key={i} src={u} alt="" className="h-20 w-20 rounded object-cover bg-gray-100" />
            ))}
          </div>
        </Row>
      )}

      {contacts.length > 0 && (
        <Row label={contacts.length === 1 ? "Contact" : "Contacts"}>
          <ul className="space-y-2">
            {contacts.map((c, i) => (
              <li key={i} className="rounded-lg border border-border px-3 py-2">
                <p className="text-sm font-medium text-foreground break-words">
                  {c.name?.trim() || "—"}
                  {c.role?.trim() && <span className="font-normal text-muted"> · {c.role}</span>}
                </p>
                {[c.phone, c.email, c.website].filter((x) => x?.trim()).map((x, j) => (
                  <p key={j} className="text-sm text-muted break-all">{x}</p>
                ))}
              </li>
            ))}
          </ul>
        </Row>
      )}

      {item.notes?.trim() && (
        <Row label="Private note">
          {/* Never leaves the Library unless it is copied into a FlowGuide, and
              even then it is the professional's own note. Saying so costs one
              line and removes the question. */}
          <p className="text-sm text-foreground whitespace-pre-wrap break-words">{item.notes}</p>
          <p className="mt-1 text-xs text-muted">Only you see this.</p>
        </Row>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button onClick={onEdit} disabled={busy}
          className="px-3 py-2 rounded-lg border border-border bg-white text-sm font-medium
                     text-foreground hover:border-accent hover:text-accent disabled:opacity-60">
          Edit
        </button>
        {typeof usedIn === "number" && usedIn > 0 && (
          <button type="button" onClick={toggleUsages} disabled={busy}
            aria-expanded={usagesOpen}
            className="text-sm font-medium text-muted underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60">
            In {usedIn} Sendset{usedIn === 1 ? "" : "s"} {usagesOpen ? "▴" : "▾"}
          </button>
        )}
        <button onClick={onDelete} disabled={busy}
          className="ml-auto text-sm font-medium text-red-700 hover:text-red-800 disabled:opacity-60">
          Delete
        </button>
      </div>

      {/* PER-SENDSET USAGES. Only visible on demand. Out-of-date rows come
          first (that's the group the professional is here to act on), each
          with an Open link to visit the Sendset and an Update button to
          push the library's current content into that one Sendset. Neither
          action touches another Sendset — the whole point is that this is
          a per-Sendset choice, not a batch. */}
      {usagesOpen && typeof usedIn === "number" && usedIn > 0 && (
        <div className="mt-3 rounded-lg border border-border bg-ground-2 p-3">
          {loadingUsages && <p className="text-xs text-muted">Loading…</p>}
          {usagesError && <p className="text-xs text-red-700">{usagesError}</p>}
          {applyError && <p className="mb-2 text-xs text-red-700">{applyError}</p>}
          {!loadingUsages && usages && usages.length === 0 && (
            <p className="text-xs text-muted">
              No Sendset currently holds a live copy of this item. The count above may be stale — try reopening it.
            </p>
          )}
          {!loadingUsages && usages && usages.length > 0 && (
            <ul className="space-y-2">
              {usages.map((u) => (
                <li key={u.itemId} className="flex flex-wrap items-center gap-2 rounded-md bg-white p-2.5 shadow-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{u.packetTitle}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs">
                      {u.outOfDate
                        ? <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-900">Out of date</span>
                        : <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-900">In sync</span>}
                      {u.packetStatus === "published"
                        ? <span className="text-muted">· Published (update affects draft only)</span>
                        : <span className="text-muted">· Draft</span>}
                    </span>
                  </span>
                  <div className="flex flex-none items-center gap-2">
                    <a href={`/edit/${u.packetId}`} target="_blank" rel="noopener noreferrer"
                      className="text-xs font-medium text-muted hover:text-foreground">
                      Open ↗
                    </a>
                    {u.outOfDate && (
                      <button type="button" onClick={() => applyToSendset(u)}
                        disabled={busy || applyingItemId === u.itemId}
                        className="rounded-md border border-accent bg-white px-2.5 py-1 text-xs font-semibold text-accent hover:bg-accent/5 disabled:opacity-60">
                        {applyingItemId === u.itemId ? "Updating…" : "Update"}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {!loadingUsages && usages && usages.length > 0 && (
            <p className="mt-2 text-xs text-muted">
              Updating a Sendset writes the library&apos;s current content into that one Sendset only — no other Sendset is touched. For a published Sendset, the update lands on the draft; the sent version is unchanged until you republish.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
