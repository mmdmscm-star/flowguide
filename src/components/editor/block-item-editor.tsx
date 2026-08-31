"use client";

import { useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { moveDetail, detailsPayload } from "@/lib/detail-order";
import type { Item } from "@/lib/types";
import type { ItemContentPayload } from "@/lib/item-content";
import type { MutationResult } from "@/lib/serial-mutation";

// ============================================================
// Focused item-CONTENT editor for the block editor (R2-B). Edits one item's
// title, description, address, notes, details, links, photos, and contact — the
// same fields the legacy editor supports — and nothing about block order,
// membership, or composition. It edits a local draft; Save persists the whole
// content payload through the block editor's single-flight runner (so it
// serializes with reorders and rolls back on failure). Cancel discards the draft.
// ============================================================

type Detail = { label: string; value: string };
// A row needs an identity that survives being moved. The list was keyed by
// array index, which is fine for a static list and wrong the moment rows can
// change places: the key would follow the position rather than the row, so a
// drag would carry the wrong input's focus and value with it. The id is local
// to this draft and never saved — detailsPayload sends {label, value} only.
type DraftDetail = Detail & { id: string };
const draftDetail = (d: Detail): DraftDetail => ({ ...d, id: crypto.randomUUID() });
type Link = { url: string; label: string };
type Photo = { url: string };
type Contact = { name: string; role: string; phone: string; email: string; website: string };
const emptyContact = (): Contact => ({ name: "", role: "", phone: "", email: "", website: "" });


// ============================================================
// One Detail row, reorderable.
//
// The same interaction as the FlowGuide item editor — same handle, same
// sensors, same shared moveDetail semantics — because this editor serves BOTH
// the Library and block-composition FlowGuides, and a professional should not
// have to learn two ways to move a row depending on which screen they are on.
//
// Order is durable without any schema change: library_items.details is a jsonb
// ARRAY, and jsonb preserves array order. The copy into a FlowGuide walks it
// with jsonb_array_elements and numbers item_details.sort_order as it goes, so
// an order arranged once in the Library is the order a new FlowGuide starts
// from — and the copy is independent from that moment on.
// ============================================================
function SortableDetailRow({
  detail,
  busy,
  field,
  onChange,
  onRemove,
}: {
  detail: DraftDetail;
  busy: boolean;
  field: string;
  onChange: (patch: Partial<Detail>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: detail.id,
    disabled: busy,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Names the row for anyone who cannot see it move; falls back to the value
  // when the label is still blank.
  const named = detail.label.trim() || detail.value.trim();

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2">
      <button
        type="button"
        {...attributes}
        {...listeners}
        disabled={busy}
        aria-label={named ? `Reorder detail: ${named}` : "Reorder detail"}
        className="text-gray-300 hover:text-gray-600 cursor-grab active:cursor-grabbing flex-shrink-0 touch-none p-1 -ml-1 disabled:cursor-not-allowed"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <circle cx="7" cy="4" r="1.5" />
          <circle cx="13" cy="4" r="1.5" />
          <circle cx="7" cy="10" r="1.5" />
          <circle cx="13" cy="10" r="1.5" />
          <circle cx="7" cy="16" r="1.5" />
          <circle cx="13" cy="16" r="1.5" />
        </svg>
      </button>
      <input
        value={detail.label}
        disabled={busy}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Label"
        className={field}
      />
      <input
        value={detail.value}
        disabled={busy}
        onChange={(e) => onChange({ value: e.target.value })}
        placeholder="Value"
        className={field}
      />
      <button
        className="text-red-400 hover:text-red-600 px-1"
        disabled={busy}
        onClick={onRemove}
        aria-label={named ? `Remove detail: ${named}` : "Remove detail"}
      >
        ×
      </button>
    </div>
  );
}

export interface LibraryOrganization {
  labels: string[];
  isFavorite: boolean;
}

export function BlockItemEditor({
  item,
  busy,
  onSave,
  onClose,
  organization,
  vocabulary,
  locationLabel,
}: {
  item: Item;
  busy: boolean;
  onSave: (payload: ItemContentPayload, updatedItem: Item, organization?: LibraryOrganization) => Promise<MutationResult>;
  onClose: () => void;
  /** Present only when editing a LIBRARY entry. A FlowGuide item has no labels
   *  and no place in a Section — organization belongs to the shelf, not to the
   *  copy taken from it — so the block simply does not exist there. */
  organization?: LibraryOrganization;
  vocabulary?: { labels: string[] };
  /** Where this entry currently lives, e.g. "Communities › Santa Rosa".
   *  Shown, not edited: moving something is a placement, made against a
   *  selection in Select items, not a text field that could disagree with it. */
  locationLabel?: string;
}) {
  const [title, setTitle] = useState(item.title || "");
  const [address, setAddress] = useState(item.address || "");
  const [description, setDescription] = useState(item.description || "");
  const [notes, setNotes] = useState(item.notes || "");
  const [highlight, setHighlight] = useState(item.highlight || "");
  const [details, setDetails] = useState<DraftDetail[]>(
    item.details ? item.details.map((d) => draftDetail({ label: d.label, value: d.value })) : []);
  const [links, setLinks] = useState<Link[]>(item.links ? item.links.map((l) => ({ url: l.url, label: l.label || "" })) : []);
  const [photos, setPhotos] = useState<Photo[]>(item.photos ? item.photos.map((u) => ({ url: u })) : []);
  const [contacts, setContacts] = useState<Contact[]>(
    item.contacts ? item.contacts.map((c) => ({ name: c.name || "", role: c.role || "", phone: c.phone || "", email: c.email || "", website: c.website || "" })) : []
  );
  const [error, setError] = useState("");
  const [labels, setLabels] = useState<string[]>(organization?.labels ?? []);
  const [isFavorite, setIsFavorite] = useState(organization?.isFavorite ?? false);
  const [labelDraft, setLabelDraft] = useState("");

  function addLabel() {
    const wanted = labelDraft.replace(/\s+/g, " ").trim();
    if (!wanted) return;
    // Case-insensitive, so one idea stays one chip. The server normalises again
    // against the whole Library; this is the same rule applied early enough for
    // the professional to SEE it happen.
    const known = (vocabulary?.labels ?? []).find((l) => l.toLowerCase() === wanted.toLowerCase());
    const value = known ?? wanted;
    setLabels((cur) => cur.some((l) => l.toLowerCase() === value.toLowerCase()) ? cur : [...cur, value]);
    setLabelDraft("");
  }

  // Same sensors as the FlowGuide editor: a pointer that ignores a 5px twitch,
  // and a keyboard sensor, because a reorder only a mouse can perform is not
  // available to everyone who has to use it.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const field = "w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300";
  const smallBtn = "text-xs font-medium text-accent hover:text-accent-hover";

  async function handleSave() {
    setError("");
    try {
      await doSave();
    } catch (e) {
      // A THROW HERE USED TO BE INVISIBLE. The click handler rejected, no
      // request was sent, and the professional saw a Save button that did
      // nothing. Whatever else is wrong, they must be told.
      console.error("[item-editor] save threw", e);
      setError("Save failed — your changes were not applied.");
    }
  }

  async function doSave() {
    // detailsPayload drops the draft id and keeps the sequence: position is
    // what carries order, here exactly as it does in the FlowGuide editor.
    const cleanDetails = detailsPayload(
      details.filter((d) => String(d?.label ?? "").trim() || String(d?.value ?? "").trim()));
    const cleanLinks = links.filter((l) => String(l?.url ?? "").trim());
    // Defensive: no stored shape may make this throw again.
    const cleanPhotos = photos.filter((p) => String(p?.url ?? "").trim());
    // Drop meaningless completely-blank contact rows; keep order.
    const cleanContacts = contacts.filter((c) => ["name","phone","email","website"]
      .some((k) => String((c as Record<string, unknown>)?.[k] ?? "").trim()));

    const payload: ItemContentPayload = {
      title, description, notes, highlight, address,
      details: cleanDetails, links: cleanLinks, photos: cleanPhotos, contacts: cleanContacts,
    };
    const updatedItem: Item = {
      id: item.id,
      title,
      address: address || undefined,
      description: description || undefined,
      notes: notes || undefined,
      highlight: highlight || undefined,
      photos: cleanPhotos.length ? cleanPhotos.map((p) => p.url) : undefined,
      details: cleanDetails.length ? cleanDetails : undefined,
      links: cleanLinks.length ? cleanLinks.map((l) => ({ url: l.url, label: l.label || undefined })) : undefined,
      contacts: cleanContacts.length
        ? cleanContacts.map((c) => ({ name: c.name || undefined, role: c.role || undefined, phone: c.phone || undefined, email: c.email || undefined, website: c.website || undefined }))
        : undefined,
    };

    // Organization travels beside the content payload, never inside it: the
    // content write bumps `revision` and the organization write must not, so
    // they stay two separate writes on the other side of this callback.
    const result = await onSave(payload, updatedItem,
      organization ? { labels, isFavorite } : undefined);
    if (result === "ok") onClose();
    else if (result === "failed") setError("Save failed — your changes were not applied.");
    else if (result === "rejected") setError("Another change is saving — try again in a moment.");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto p-4" role="dialog">
      <div className="w-full max-w-lg my-8 rounded-2xl bg-white shadow-xl">
        <div className="sticky top-0 flex items-center gap-3 px-5 py-3 border-b border-border bg-white rounded-t-2xl">
          <h2 className="text-sm font-semibold text-foreground">Edit item</h2>
          <button onClick={onClose} disabled={busy} className="ml-auto text-sm text-muted hover:text-foreground disabled:opacity-40">Cancel</button>
          <button onClick={handleSave} disabled={busy} className="text-sm font-medium text-white bg-accent hover:bg-accent-hover px-4 py-1.5 rounded-lg disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {error && <p className="text-xs text-red-600">{error}</p>}

          <label className="block">
            <span className="text-xs font-medium text-muted">Title</span>
            <input value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} placeholder="Item title" className={field} />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-muted">Address</span>
            <input value={address} disabled={busy} onChange={(e) => setAddress(e.target.value)} placeholder="Address (auto-links to Google Maps)" className={field} />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-muted">Description</span>
            <textarea value={description} disabled={busy} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Description" className={field} />
          </label>

          {/* Two audiences, said out loud in both labels — see the same pair
              in the legacy editor for why the wording is load-bearing. */}
          <label className="block">
            <span className="text-xs font-medium text-amber-800">
              Highlight for Client
              <span className="ml-1.5 font-normal text-amber-700/80">Shown to your client.</span>
            </span>
            <textarea value={highlight} disabled={busy} onChange={(e) => setHighlight(e.target.value)} rows={2}
              placeholder="Something you want your client to notice" className={field} />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-muted">
              Private Notes
              <span className="ml-1.5 font-normal text-muted/80">Only you see this.</span>
            </span>
            <textarea value={notes} disabled={busy} onChange={(e) => setNotes(e.target.value)} rows={2}
              placeholder="For your reference only" className={field} />
          </label>

          {/* LIBRARY ORGANIZATION — how the professional files this, kept
              visibly apart from what a client reads. Rendered only for a
              Library entry: none of it is copied into a FlowGuide, and none of
              it ever reaches a recipient. */}
          {organization && (
            <div className="rounded-lg border border-dashed border-border bg-gray-50/60 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">
                  Library organization
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setIsFavorite((f) => !f)}
                  aria-pressed={isFavorite}
                  className={`text-lg leading-none ${isFavorite ? "text-amber-500" : "text-gray-300 hover:text-amber-500"}`}
                  aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
                >
                  {isFavorite ? "★" : "☆"}
                </button>
              </div>
              <p className="mt-1 text-xs text-muted">
                Only you see this. It is how you find this again — it is never copied
                into a FlowGuide.
              </p>

              {/* WHERE IT LIVES, SHOWN RATHER THAN TYPED. A free-text field
                  here could name a section that does not exist, or disagree
                  with the one the item is actually in. Moving something is a
                  placement — dragged to where it goes, or chosen from what
                  exists — so it belongs to the Library, not to a text box in an
                  editor that is otherwise about content.
                  This used to say "use Organize", which now names a mode that
                  hides the drag handles. It points at the two things that
                  actually move an item instead. */}
              <p className="mt-3 text-xs text-muted">
                {locationLabel
                  ? <>In <span className="font-medium text-foreground">{locationLabel}</span>. Drag it in your Library to move it, or use Move… on its row.</>
                  : <>Not in a section. Drag it into one, or use Move… on its row.</>}
              </p>

              <label className="mt-3 block text-xs text-muted">Labels</label>
              {labels.length > 0 && (
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                  {labels.map((l) => (
                    <span key={l} className="inline-flex items-center gap-1 rounded-full border border-border
                                             bg-white px-2 py-0.5 text-xs text-foreground">
                      {l}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setLabels((cur) => cur.filter((x) => x !== l))}
                        aria-label={`Remove label ${l}`}
                        className="text-red-400 hover:text-red-600"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <input
                  list="item-editor-labels"
                  value={labelDraft}
                  disabled={busy}
                  onChange={(e) => setLabelDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLabel(); } }}
                  placeholder="Santa Rosa"
                  className={field}
                />
                <button type="button" className={smallBtn} disabled={busy || !labelDraft.trim()} onClick={addLabel}>
                  + Add
                </button>
              </div>
              <datalist id="item-editor-labels">
                {(vocabulary?.labels ?? []).map((l) => <option key={l} value={l} />)}
              </datalist>
            </div>
          )}

          {/* Details */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted">Details</span>
              <button className={smallBtn} disabled={busy} onClick={() => setDetails((d) => [...d, draftDetail({ label: "", value: "" })])}>+ Add detail</button>
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(e: DragEndEvent) => {
                const { active, over } = e;
                if (!over || active.id === over.id) return;
                setDetails((arr) => moveDetail(arr, String(active.id), String(over.id)));
              }}
            >
              <SortableContext items={details.map((d) => d.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {details.map((d) => (
                    <SortableDetailRow
                      key={d.id}
                      detail={d}
                      busy={busy}
                      field={field}
                      onChange={(patch) => setDetails((arr) => arr.map((x) => x.id === d.id ? { ...x, ...patch } : x))}
                      onRemove={() => setDetails((arr) => arr.filter((x) => x.id !== d.id))}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>

          {/* Links */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted">Links</span>
              <button className={smallBtn} disabled={busy} onClick={() => setLinks((l) => [...l, { url: "", label: "" }])}>+ Add link</button>
            </div>
            <div className="space-y-2">
              {links.map((l, i) => (
                <div key={i} className="flex gap-2">
                  <input value={l.label} disabled={busy} onChange={(e) => setLinks((arr) => arr.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} placeholder="Label" className={field} />
                  <input value={l.url} disabled={busy} onChange={(e) => setLinks((arr) => arr.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} placeholder="https://…" className={field} />
                  <button className="text-red-400 hover:text-red-600 px-1" disabled={busy} onClick={() => setLinks((arr) => arr.filter((_, j) => j !== i))} aria-label="Remove link">×</button>
                </div>
              ))}
            </div>
          </div>

          {/* Photos */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted">Photos (URLs)</span>
              <button className={smallBtn} disabled={busy} onClick={() => setPhotos((p) => [...p, { url: "" }])}>+ Add photo</button>
            </div>
            <div className="space-y-2">
              {photos.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <input value={p.url} disabled={busy} onChange={(e) => setPhotos((arr) => arr.map((x, j) => j === i ? { url: e.target.value } : x))} placeholder="https://… (image URL)" className={field} />
                  <button className="text-red-400 hover:text-red-600 px-1" disabled={busy} onClick={() => setPhotos((arr) => arr.filter((_, j) => j !== i))} aria-label="Remove photo">×</button>
                </div>
              ))}
            </div>
          </div>

          {/* Contacts — an ordered list; a community may legitimately have several people. */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted">Contacts (people)</span>
              <button className={smallBtn} disabled={busy} onClick={() => setContacts((cs) => [...cs, emptyContact()])}>+ Add contact</button>
            </div>
            <div className="space-y-2">
              {contacts.map((c, i) => {
                const up = (patch: Partial<Contact>) => setContacts((arr) => arr.map((x, j) => j === i ? { ...x, ...patch } : x));
                return (
                  <div key={i} className="rounded-lg border border-border p-2">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-medium text-muted">Contact {i + 1}</span>
                      <button className="text-[11px] font-medium text-red-400 hover:text-red-600" disabled={busy}
                        onClick={() => setContacts((arr) => arr.filter((_, j) => j !== i))}>Remove</button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input value={c.name} disabled={busy} onChange={(e) => up({ name: e.target.value })} placeholder="Name" className={field} />
                      <input value={c.role} disabled={busy} onChange={(e) => up({ role: e.target.value })} placeholder="Role (optional)" className={field} />
                      <input value={c.phone} disabled={busy} onChange={(e) => up({ phone: e.target.value })} placeholder="Phone" className={field} />
                      <input value={c.email} disabled={busy} onChange={(e) => up({ email: e.target.value })} placeholder="Email" className={field} />
                      <input value={c.website} disabled={busy} onChange={(e) => up({ website: e.target.value })} placeholder="Website (this person's own)" className={`${field} col-span-2`} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
