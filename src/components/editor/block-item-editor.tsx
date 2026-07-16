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
type Contact = { name: string; phone: string; email: string; website: string };

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
  const [contact, setContact] = useState<Contact | null>(
    item.contact ? { name: item.contact.name || "", phone: item.contact.phone || "", email: item.contact.email || "", website: item.contact.website || "" } : null
  );
  const [error, setError] = useState("");

  const field = "w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300";
  const smallBtn = "text-xs font-medium text-accent hover:text-accent-hover";

  async function handleSave() {
    setError("");
    const cleanDetails = details.filter((d) => d.label.trim() || d.value.trim());
    const cleanLinks = links.filter((l) => l.url.trim());
    const cleanPhotos = photos.filter((p) => p.url.trim());
    const cleanContact = contact && (contact.name || contact.phone || contact.email || contact.website) ? contact : null;

    const payload: ItemContentPayload = {
      title, description, notes, address,
      details: cleanDetails, links: cleanLinks, photos: cleanPhotos, contact: cleanContact,
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
      contact: cleanContact
        ? { name: cleanContact.name || undefined, phone: cleanContact.phone || undefined, email: cleanContact.email || undefined, website: cleanContact.website || undefined }
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

          {/* Contact */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted">Contact</span>
              {contact === null ? (
                <button className={smallBtn} disabled={busy} onClick={() => setContact({ name: "", phone: "", email: "", website: "" })}>+ Add contact</button>
              ) : (
                <button className="text-xs font-medium text-red-400 hover:text-red-600" disabled={busy} onClick={() => setContact(null)}>Remove contact</button>
              )}
            </div>
            {contact !== null && (
              <div className="grid grid-cols-2 gap-2">
                <input value={contact.name} disabled={busy} onChange={(e) => setContact((c) => c && { ...c, name: e.target.value })} placeholder="Name" className={field} />
                <input value={contact.phone} disabled={busy} onChange={(e) => setContact((c) => c && { ...c, phone: e.target.value })} placeholder="Phone" className={field} />
                <input value={contact.email} disabled={busy} onChange={(e) => setContact((c) => c && { ...c, email: e.target.value })} placeholder="Email" className={field} />
                <input value={contact.website} disabled={busy} onChange={(e) => setContact((c) => c && { ...c, website: e.target.value })} placeholder="Website" className={field} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
