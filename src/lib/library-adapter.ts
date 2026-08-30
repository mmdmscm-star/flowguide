// Adapting a Library snapshot to the shape the existing item editor speaks.
//
// BlockItemEditor already takes an `Item` and emits an `ItemContentPayload`.
// That is the whole reason the Library reuses it instead of growing a second
// editor: two editors for the same eight fields would drift the first time
// either changed, and the professional would learn that "editing an item" means
// something slightly different depending on where they are.
//
// This file is the entire adapter. If it ever needs to grow past a few lines,
// that is the signal the two models have diverged — not a reason to fork the UI.

import type { Item } from "./types.ts";
import type { ItemContentPayload } from "./item-content.ts";

/** A Library row, as the API returns it. */
export interface LibrarySnapshot extends ItemContentPayload {
  id: string;
  revision: number;
  updatedAt: string;
  /** Library ORGANIZATION — how the professional files this, not what it is.
   *  snapshotToItem deliberately does not carry these across: an item copied
   *  into a FlowGuide is content, and how it was filed is not part of it. */
  category?: string;
  labels?: string[];
  isFavorite?: boolean;
  /** The item's one structural home. null/null is the unorganized remainder. */
  sectionId?: string | null;
  groupId?: string | null;
  sortOrder?: number;
}

/** Library snapshot -> the editor's Item shape. */
export function snapshotToItem(s: LibrarySnapshot): Item {
  return {
    id: s.id,
    title: s.title ?? "",
    address: s.address ?? "",
    description: s.description ?? "",
    notes: s.notes ?? "",
    // Item carries photos as bare urls; the payload carries {url}. An entry
    // written before the import normaliser existed may still hold bare strings,
    // so both are read — a row that has not been re-saved must not break the
    // editor that would fix it.
    photos: photoUrls(s),
    details: (s.details ?? []).map((d) => ({ label: d.label, value: d.value })),
    links: (s.links ?? []).map((l) => ({ url: l.url, label: l.label ?? "" })),
    contacts: (s.contacts ?? []).map((c) => ({
      name: c.name ?? "", role: c.role ?? "", phone: c.phone ?? "",
      email: c.email ?? "", website: c.website ?? "",
    })),
  };
}

/** The one identifying line under a title in a list. Address where there is one,
 *  otherwise the opening of the description — enough to tell two entries apart
 *  without making the row a paragraph. */
export function subtitleFor(s: LibrarySnapshot): string {
  if (s.address?.trim()) return s.address.trim();
  const d = (s.description ?? "").trim();
  return d.length > 80 ? `${d.slice(0, 80)}…` : d;
}

/** Photo urls, tolerating both the canonical {url} shape and the bare strings an
 *  AI import used to store. */
export function photoUrls(s: { photos?: unknown }): string[] {
  return (Array.isArray(s.photos) ? s.photos : [])
    .map((p) => (typeof p === "string" ? p : (p as { url?: unknown })?.url))
    .filter((u): u is string => typeof u === "string" && u.trim().length > 0);
}

/** First photo, which is also the hero photo wherever this is rendered. */
export const heroPhoto = (s: LibrarySnapshot): string | null => photoUrls(s)[0] ?? null;
