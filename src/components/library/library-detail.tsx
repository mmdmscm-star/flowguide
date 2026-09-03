"use client";
import { photoUrls, type LibrarySnapshot } from "@/lib/library-adapter";

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
          <span className="text-sm text-muted">
            In {usedIn} Sendset{usedIn === 1 ? "" : "s"}
          </span>
        )}
        <button onClick={onDelete} disabled={busy}
          className="ml-auto text-sm font-medium text-red-700 hover:text-red-800 disabled:opacity-60">
          Delete
        </button>
      </div>
    </div>
  );
}
