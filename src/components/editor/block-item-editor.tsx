"use client";

import { useState } from "react";
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
type Link = { url: string; label: string };
type Photo = { url: string };
type Contact = { name: string; role: string; phone: string; email: string; website: string };
const emptyContact = (): Contact => ({ name: "", role: "", phone: "", email: "", website: "" });

export function BlockItemEditor({
  item,
  busy,
  onSave,
  onClose,
}: {
  item: Item;
  busy: boolean;
  onSave: (payload: ItemContentPayload, updatedItem: Item) => Promise<MutationResult>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(item.title || "");
  const [address, setAddress] = useState(item.address || "");
  const [description, setDescription] = useState(item.description || "");
  const [notes, setNotes] = useState(item.notes || "");
  const [details, setDetails] = useState<Detail[]>(item.details ? item.details.map((d) => ({ label: d.label, value: d.value })) : []);
  const [links, setLinks] = useState<Link[]>(item.links ? item.links.map((l) => ({ url: l.url, label: l.label || "" })) : []);
  const [photos, setPhotos] = useState<Photo[]>(item.photos ? item.photos.map((u) => ({ url: u })) : []);
  const [contacts, setContacts] = useState<Contact[]>(
    item.contacts ? item.contacts.map((c) => ({ name: c.name || "", role: c.role || "", phone: c.phone || "", email: c.email || "", website: c.website || "" })) : []
  );
  const [error, setError] = useState("");

  const field = "w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300";
  const smallBtn = "text-xs font-medium text-accent hover:text-accent-hover";

  async function handleSave() {
    setError("");
    const cleanDetails = details.filter((d) => d.label.trim() || d.value.trim());
    const cleanLinks = links.filter((l) => l.url.trim());
    const cleanPhotos = photos.filter((p) => p.url.trim());
    // Drop meaningless completely-blank contact rows; keep order.
    const cleanContacts = contacts.filter((c) => c.name.trim() || c.phone.trim() || c.email.trim() || c.website.trim());

    const payload: ItemContentPayload = {
      title, description, notes, address,
      details: cleanDetails, links: cleanLinks, photos: cleanPhotos, contacts: cleanContacts,
    };
    const updatedItem: Item = {
      id: item.id,
      title,
      address: address || undefined,
      description: description || undefined,
      notes: notes || undefined,
      photos: cleanPhotos.length ? cleanPhotos.map((p) => p.url) : undefined,
      details: cleanDetails.length ? cleanDetails : undefined,
      links: cleanLinks.length ? cleanLinks.map((l) => ({ url: l.url, label: l.label || undefined })) : undefined,
      contacts: cleanContacts.length
        ? cleanContacts.map((c) => ({ name: c.name || undefined, role: c.role || undefined, phone: c.phone || undefined, email: c.email || undefined, website: c.website || undefined }))
        : undefined,
    };

    const result = await onSave(payload, updatedItem);
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

          <label className="block">
            <span className="text-xs font-medium text-muted">Notes</span>
            <textarea value={notes} disabled={busy} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Private notes" className={field} />
          </label>

          {/* Details */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted">Details</span>
              <button className={smallBtn} disabled={busy} onClick={() => setDetails((d) => [...d, { label: "", value: "" }])}>+ Add detail</button>
            </div>
            <div className="space-y-2">
              {details.map((d, i) => (
                <div key={i} className="flex gap-2">
                  <input value={d.label} disabled={busy} onChange={(e) => setDetails((arr) => arr.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} placeholder="Label" className={field} />
                  <input value={d.value} disabled={busy} onChange={(e) => setDetails((arr) => arr.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} placeholder="Value" className={field} />
                  <button className="text-red-400 hover:text-red-600 px-1" disabled={busy} onClick={() => setDetails((arr) => arr.filter((_, j) => j !== i))} aria-label="Remove detail">×</button>
                </div>
              ))}
            </div>
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
